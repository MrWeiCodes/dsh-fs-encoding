/**
 * Read/write orchestration: the one path every tool goes through.
 *
 * Reads go through `ctx.fs.readBytes` (the public byte seam) and admission in
 * `encoding-state`; writes go through the fence in `sandbox` and the byte
 * publisher in `byte-writer`. Keeping both directions in one module is what
 * makes the round-trip auditable: there is exactly one place that decides an
 * encoding and exactly one place that turns text back into bytes.
 *
 * @module dsh-fs-encoding/io
 */

import type { Context } from "@deepseek-ai/cordis";
import { FsError, type FileSystem, type FsTarget, type FsVersion } from "@deepseek-ai/dsh-fs";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { writeBytesAtomic } from "./byte-writer.js";
import { loadConfig } from "./config.js";
import {
  decodeForOpen,
  encodeForSave,
  getEncodingState,
  invalidateIfStale,
  openStateFor,
  recordOpenState,
  sessionKeyOf,
  type FileEncodingState,
} from "./encoding-state.js";
import type { EncodingSandbox } from "./sandbox.js";

/** A decoded file plus everything a caller needs to report on it. */
export interface ReadOutcome {
  /** The text, with any BOM already removed and the file's own line endings intact. */
  text: string;
  /** The resolved target the text came from. */
  target: FsTarget;
  /** The encoding recorded for this read. */
  state: FileEncodingState;
  /** An out-of-band note for the model (auto-guess provenance), never file content. */
  footer?: string;
}

/** The canonical key a target's encoding state is memoized under. */
function keyOf(target: FsTarget): string {
  const key = (target as unknown as { targetKey?: unknown }).targetKey;
  return typeof key === "string" ? key : target.displayPath;
}

/**
 * The session bucket a call's encoding state belongs to.
 *
 * Derived from the calling execution so two sessions never share a record: one
 * session's encoding choice must not silently decide how another session
 * decodes, and an agentless caller gets its own bucket rather than a global one.
 *
 * @param exec - the calling execution, when there is one.
 * @returns the bucket key.
 */
export function sessionKeyFor(exec: ToolExecution | undefined): string {
  return sessionKeyOf(exec?.agent?.session.id);
}

/**
 * Map a thrown `ctx.fs` error onto the model-facing vocabulary.
 *
 * The built-ins leak raw `FsError`s for the read path; these tools keep the
 * same codes so a model that learned them from the built-ins is not surprised.
 *
 * @param error - the thrown error.
 * @param displayPath - the path as the model wrote it.
 * @throws always — the mapped error.
 */
export function mapReadError(error: unknown, displayPath: string): never {
  if (error instanceof FsError) {
    switch (error.code) {
      case "FS_NOT_FOUND":
        throw new Error(`cannot read "${displayPath}": no such file`);
      case "FS_PERMISSION_DENIED":
        throw new Error(`cannot read "${displayPath}": permission denied`);
      case "FS_NOT_REGULAR_FILE":
        throw new Error(`cannot read "${displayPath}": not a regular file`);
      case "FS_TOO_LARGE":
        throw new Error(
          `cannot read "${displayPath}": file exceeds the plugin's maxFileBytes cap. Raise maxFileBytes in the plugin config to read it.`,
        );
      case "FS_ABORTED":
        throw new Error("Operation aborted");
      default:
        throw error;
    }
  }
  throw error;
}

/**
 * Read a file's bytes, decode them under the plugin's admission rules, record
 * the encoding for the coming save, and record the observation.
 *
 * The version is captured BEFORE the bytes so a concurrent change between the
 * two shows up as a version mismatch on the next save rather than as a memo
 * that authorizes a write against content the model never saw. For the same
 * reason the observation is emitted at that pre-read version: recording a
 * newer version than the content actually served would let a write pass the
 * guard while overwriting content the model never saw. Recording the older one
 * fails closed — the write is refused and the model re-reads.
 *
 * @param ctx - the plugin's context (for `ctx.fs`).
 * @param path - the path as the model wrote it, resolved against `cwd`.
 * @param cwd - the session workspace root.
 * @param opts - the calling execution, an optional explicit encoding, and
 *   whether this read counts as the model observing the file.
 * @returns the decoded text, its target, and the recorded state.
 */
export async function readFile(
  ctx: Context,
  path: string,
  cwd: string,
  opts: {
    signal?: AbortSignal | undefined;
    encodingHint?: string | undefined;
    exec?: ToolExecution | undefined;
    /**
     * Whether to record this read as the session's observation of the file.
     * Defaults to `true`: a model-facing read must arm the read-before-write
     * gate. Internal reads that exist only to build a diff pass `false`, so
     * they cannot silently satisfy a gate the model never did.
     */
    observe?: boolean | undefined;
    /**
     * Whether to store the encoding this read derived as the session's record
     * for the file. Defaults to `true`.
     *
     * Separate from {@link observe} because the two answer different questions
     * and the dangerous case is the one where they disagree. A presentation-only
     * read (a diff baseline) passes `observe: false` so it cannot arm the gate —
     * but if it still WROTE the encoding record, it would replace the session's
     * knowledge with whatever this read guessed, and that guess would then
     * authorize the coming save. After an eviction that is precisely the silent
     * re-encode the write guard refuses; the guard sees a record and stands
     * down. A read that is not allowed to speak for the session must not leave
     * a record behind either.
     */
    recordState?: boolean | undefined;
  } = {},
): Promise<ReadOutcome> {
  const fs: FileSystem = ctx.fs;
  const config = loadConfig();

  let target: FsTarget;
  let info: Awaited<ReturnType<FileSystem["stat"]>>;
  let bytes: Uint8Array;
  try {
    target = await fs.resolve(path, {
      cwd,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    info = await fs.stat(target, opts.signal);
    if (info === undefined) {
      // Report the absence to the observation gate before failing, exactly as the
      // built-in `read` does. Without this the policy keeps whatever it last knew
      // — normally `present@old-version` — and every later write to this path
      // fails `FS_STALE_VERSION` ("file no longer exists") for the rest of the
      // session, with nothing able to clear it: a file the model deleted can
      // never be recreated, and the refusal names a cause the caller cannot act
      // on. A read is the one moment the plugin learns a file is gone, so it is
      // the moment to say so. Suppressed for a presentation-only read, which must
      // not move the gate in either direction.
      if (opts.observe !== false) {
        try {
          ctx.emit("fs/observed", target, { kind: "absent" }, opts.exec);
        } catch (error) {
          ctx.logger.warn(
            `dsh-fs-encoding: fs/observed (absent) emission failed for ${path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      throw new FsError(`cannot read "${path}": no such file`, "FS_NOT_FOUND");
    }
    if (info.type !== "file") {
      throw new FsError(`cannot read "${path}": not a regular file`, "FS_NOT_REGULAR_FILE");
    }
    const cap = info.size === undefined ? config.maxFileBytes : Math.min(info.size, config.maxFileBytes);
    bytes = await fs.readBytes(target, opts.signal, cap);
  } catch (error) {
    return mapReadError(error, path);
  }

  const key = keyOf(target);
  const version = info.version;
  const sessionKey = sessionKeyFor(opts.exec);

  // A file that changed on disk since this session read it must be re-admitted,
  // never served from the stale memo.
  invalidateIfStale(sessionKey, key, version);

  // An explicit hint wins. Failing that, a memo recorded at this exact version
  // is reused: the session already established what this file's encoding is, so
  // re-deriving it would either fail (a legacy file with no BOM cannot be
  // admitted without a hint) or, worse, guess differently from the state the
  // coming save will invert.
  const memo = getEncodingState(sessionKey, key);
  const hint = opts.encodingHint ?? memo?.encoding;

  const decoded = await decodeForOpen(bytes, config, {
    displayPath: path,
    ...(hint === undefined ? {} : { encodingHint: hint }),
  });
  // A read that may not speak for the session still needs a state to RETURN (the
  // caller reports on it), but it must not store one. `openStateFor` builds it
  // without recording, so the memo keeps whatever the session actually decided —
  // or stays empty, which is what makes the write guard refuse an evicted file
  // instead of inverting a guess made for a diff card.
  const state =
    opts.recordState === false
      ? openStateFor(decoded, version)
      : recordOpenState(sessionKey, key, decoded, version);

  // Reuse the recorded guess provenance when this read went through the memo
  // rather than through admission. The hint path produces no footer of its own,
  // so without this the model sees "auto-guessed GBK" on the first read and a
  // bare, authoritative-looking decode on every read after it — exactly
  // backwards, since a guess is least trustworthy the longer it goes
  // unmentioned.
  const footer =
    decoded.footer ?? (opts.encodingHint === undefined ? memo?.footer : undefined);

  if (opts.observe !== false) {
    try {
      ctx.emit("fs/observed", target, { kind: "present", version }, opts.exec);
    } catch (error) {
      // The read succeeded; a failed observation only means a later built-in
      // tool re-reads. Never fail the read for it.
      ctx.logger.warn(
        `dsh-fs-encoding: fs/observed emission failed for ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    text: decoded.text,
    target,
    state,
    ...(footer === undefined ? {} : { footer }),
  };
}

/** Everything a governed write needs from the calling tool. */
export interface WriteRequest {
  /** The resolved target to replace. */
  target: FsTarget;
  /** The complete new text, BOM-free and with the caller's line endings. */
  content: string;
  /** The calling execution. */
  exec: ToolExecution;
  /** The policy resolved for this call, or `undefined` on an unsandboxed backend. */
  policy: SandboxExecutionPolicy | undefined;
  /**
   * The encoding to CREATE the file in, when the caller named one.
   *
   * Only consulted for a file that does not exist. An existing file's recorded
   * encoding always wins, and the calling tool refuses the argument outright in
   * that case, so the two rules cannot disagree — see `tool-write`.
   */
  newFileEncoding?: string | undefined;
}

/** What a governed write produced. */
export interface WriteOutcome {
  /** The version the write published, when the backend reports one. */
  version: FsVersion | undefined;
  /** The bytes actually written, for diagnostics and tests. */
  bytes: Uint8Array;
}

/**
 * Publish text to a file under the plugin's full guard sequence.
 *
 * The order is load-bearing and mirrors the built-ins exactly:
 *
 * 1. **Fence** — the per-call policy decides whether this target is writable,
 *    and returns the freshly canonicalized target to write.
 * 2. **Guard** — `fs/write-intent` (or `fs/edit-intent`) supplies the version
 *    the write must match, which is what makes a stale write fail instead of
 *    clobbering someone else's change.
 * 3. **Encode** — the recorded encoding is inverted, and an unmappable
 *    character fails the save before anything is published.
 * 4. **Publish** — bytes replace the file atomically.
 * 5. **Observe** — the new version is recorded so the next built-in tool sees a
 *    fresh observation rather than a stale one.
 *
 * Steps 1–3 all happen before step 4, so every failure mode leaves the file
 * untouched.
 *
 * @param ctx - the plugin's context.
 * @param sandbox - the fence and event gate.
 * @param req - the write request.
 * @param mode - which guard to take: `"write"` for a whole-file replace,
 *   `"edit"` for an in-place edit that additionally requires a prior read.
 * @returns what was written.
 */
export async function writeFile(
  ctx: Context,
  sandbox: EncodingSandbox,
  req: WriteRequest,
  mode: "write" | "edit",
): Promise<WriteOutcome> {
  const { target, content, exec, policy } = req;
  const config = loadConfig();

  let checked: FsTarget;
  try {
    // 1) Fence.
    checked = await sandbox.checkedTarget(target, policy);

    // 2) Guard. The edit guard also refuses a file this session never read.
    //
    // The two guards answer different questions and carry different shapes:
    // `fs/write-intent` returns a write intent (`createIfAbsent` /
    // `replaceIfVersion`), while `fs/edit-intent` returns only the version the
    // edit must match. Normalizing them here keeps one check below.
    const key = keyOf(checked);
    const sessionKey = sessionKeyFor(exec);
    const current = await ctx.fs.stat(checked, exec.signal);

    let guardKind: "createIfAbsent" | "replaceIfVersion" | "versionOnly" | "none" = "none";
    let guardVersion: FsVersion | undefined;

    if (mode === "edit") {
      const intent = await sandbox.takeEditIntent(checked, exec);
      if (intent !== undefined) {
        guardKind = "versionOnly";
        guardVersion = intent.version;
      }
    } else {
      const intent = await sandbox.takeWriteIntent(checked, exec);
      if (intent?.kind === "replaceIfVersion") {
        guardKind = "replaceIfVersion";
        guardVersion = intent.version;
      } else if (intent?.kind === "createIfAbsent") {
        guardKind = "createIfAbsent";
      }
    }

    invalidateIfStale(sessionKey, key, guardVersion ?? current?.version);

    // Both guard semantics must be reproduced here, because this plugin
    // publishes bytes itself and therefore never reaches the backend's own
    // check. Missing either one silently downgrades a guarded write to an
    // unconditional overwrite:
    //
    //   replaceIfVersion — the session has seen this file; the version it saw
    //                      must still be current, or someone else's change is
    //                      about to be clobbered.
    //   createIfAbsent   — the session has NOT seen this file; an existing file
    //                      must be refused rather than overwritten blind.
    //   versionOnly      — the edit guard's answer; same freshness rule, and
    //                      its presence already proves the file was read.
    if (guardKind === "replaceIfVersion" || guardKind === "versionOnly") {
      if (current === undefined) {
        throw new FsError(
          `cannot write "${checked.displayPath}": file no longer exists`,
          "FS_STALE_VERSION",
        );
      }
      if (guardVersion !== undefined && current.version !== guardVersion) {
        throw new FsError(
          `cannot write "${checked.displayPath}": file changed since it was read`,
          "FS_STALE_VERSION",
        );
      }
    } else if (guardKind === "createIfAbsent" && current !== undefined) {
      throw new FsError(
        `cannot overwrite existing "${checked.displayPath}" without reading it first`,
        "FS_NOT_OBSERVED",
      );
    }

    // 3) Encode (fails before anything is published).
    //
    // `newFileEncoding` is passed through unconditionally; `encodeForSave` decides
    // whether it applies, and it only does so when there is no recorded state —
    // i.e. the file is being created. An existing file's encoding wins, which the
    // calling tool has already enforced by refusing the argument outright.
    const state = getEncodingState(sessionKey, key);

    // A file that EXISTS but has no recorded encoding must not be written. The
    // record is bounded (see `MAX_SESSIONS` / `MAX_FILES_PER_SESSION`), so it can
    // be evicted while the file itself stays on disk — and `encodeForSave` reads a
    // missing record as "new file", which means UTF-8. For a GBK or Big5 file
    // that silently replaces every non-ASCII byte, and the reply shows nothing:
    // measured, the whole-file diff comes back as `before: null`.
    //
    // The observation policy cannot catch this. It records "was this read?" in an
    // unbounded WeakMap, so after an eviction the two records disagree in the
    // dangerous direction: the policy still says `replaceIfVersion` (the write is
    // allowed) while the plugin has forgotten the encoding. Refusing here is the
    // only place the two can be reconciled, and `current` — the stat already taken
    // in step 2 — is exactly the fact needed to tell an evicted record from a
    // genuinely new file.
    //
    // Deliberately NOT exempting a caller-named encoding here. `tool-write`
    // refuses `encoding` on an existing file before it ever calls this function,
    // so by the time `newFileEncoding` is set the target is known to be absent —
    // and if it appeared in the meantime, the `createIfAbsent` guard above
    // rejects it. Measured: both paths (a file deleted after being read, and a
    // file appearing between the tool's stat and this call) are refused by an
    // earlier guard, so an exemption here would never change an outcome.
    //
    // This fires in two reachable situations, and the reply must not pretend they
    // are one. (a) The record was evicted, or (b) the policy learned of the file
    // from a tool this plugin does not own — `read_image` emits `fs/observed` for
    // the bytes it attached, so a PNG the session "read" leaves the policy saying
    // `replaceIfVersion` while the plugin holds nothing.
    //
    // The code stays `FS_NOT_OBSERVED`, the closest term in `dsh-fs`'s closed
    // vocabulary (that set is the harness's, not this plugin's, so inventing a
    // code here would put a name in a model-facing error that no other component
    // understands). What the message must not do is repeat the old wording's two
    // errors: it claimed the session had never read the file — untrue in case (b),
    // where it read the bytes through another tool — and it advised "read the file
    // again", which cannot be done for a binary file because this plugin's `read`
    // refuses it with `E_NOT_TEXT`. The message therefore names what is actually
    // missing (the ENCODING record) and states the condition under which the
    // advice works.
    if (state === undefined && current !== undefined) {
      throw new FsError(
        `cannot write "${checked.displayPath}": this session has no encoding record for it, ` +
          `so the write would re-encode the whole file as UTF-8 and silently replace its ` +
          `bytes. If it is a text file, read it first so the plugin learns its encoding, ` +
          `then write. If it is not text, this plugin cannot rewrite it — use the tool that ` +
          `handles its type.`,
        "FS_NOT_OBSERVED",
      );
    }

    const encoded = encodeForSave(content, state, {
      normalizeToUtf8: config.normalizeToUtf8,
      ...(req.newFileEncoding === undefined ? {} : { newFileEncoding: req.newFileEncoding }),
    });

    // 4) Publish.
    await writeBytesAtomic(ctx.fs.processPath(checked), encoded.bytes);

    // 5) Observe.
    const after = await ctx.fs.stat(checked, exec.signal).catch(() => undefined);
    sandbox.emitObserved(checked, after?.version, exec);

    // 6) Re-record with the encoding the bytes were ACTUALLY written in, which
    //    differs from the recorded one when migration converted a legacy file
    //    to UTF-8. Recording the pre-migration encoding here would make the
    //    session's next read decode UTF-8 bytes as the old code page.
    if (after?.version !== undefined) {
      recordOpenState(
        sessionKey,
        key,
        {
          text: content,
          encoding: encoded.encoding,
          hasBOM: encoded.hasBOM,
          lineEnding: state?.lineEnding ?? "\n",
          candidates: [],
          // A write does not re-derive the encoding, so it must not erase the
          // provenance the read established: the file was decoded from a GUESS,
          // and that stays true after an edit.
          ...(state?.footer === undefined ? {} : { footer: state.footer }),
        },
        after.version,
      );
    }

    return { version: after?.version, bytes: encoded.bytes };
  } catch (error) {
    throw sandbox.mapError(error, policy);
  }
}
