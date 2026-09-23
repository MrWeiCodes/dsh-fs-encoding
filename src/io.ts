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
  provenanceOf,
  recordOpenState,
  sessionKeyOf,
  setEncodingState,
  type DecodeProvenance,
  type FileEncodingState,
} from "./encoding-state.js";
import type { EncodingSandbox } from "./sandbox.js";
import { detectEnding, toLF } from "./line-endings.js";
import { clearUndoFor, recordUndo } from "./undo-state.js";

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

/**
 * The canonical key a target's encoding state is memoized under.
 *
 * Exported because the undo history is keyed by the same identity: a record
 * written under one key and looked up under another would silently never match,
 * and the undo would report "no history" for a file it just edited.
 *
 * @param target - the resolved target.
 * @returns its canonical key.
 */
export function keyOf(target: FsTarget): string {
  const key = (target as unknown as { targetKey?: unknown }).targetKey;
  return typeof key === "string" ? key : target.displayPath;
}

/**
 * The provenance of a file this session CREATED, from the bytes just written.
 *
 * A created file has no read to inherit a provenance from, and leaving the field
 * blank is not neutral: the next read reuses the memo as an explicit hint, and
 * the hint path reports `"hint"` — documented as "the CALLER specified this" —
 * for an encoding the plugin may have chosen on its own. Deriving the label from
 * what actually determined the bytes avoids that.
 *
 * @param encoded - what `encodeForSave` published.
 * @returns the provenance to record.
 */
function createdProvenance(encoded: { encoding: string; hasBOM: boolean }): DecodeProvenance {
  // A BOM was either asked for by name (`utf8bom`, `utf16le`, …) or came from
  // the caller's `newFileEncoding`; either way the bytes declare it themselves,
  // which is what `"bom"` means.
  if (encoded.hasBOM) return "bom";
  // UTF-8 with no BOM is the plugin's own default when the caller named nothing.
  // When the caller DID name an encoding it is recorded as `"hint"` below, but
  // the two are indistinguishable here, and `"utf8"` is the honest label for
  // bytes that a strict UTF-8 validation would confirm on the next read anyway.
  if (encoded.encoding === "utf8") return "utf8";
  return "hint";
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
  // The provenance to record when this read went through the memo rather than
  // through admission, and the reason it must be carried explicitly: the hint
  // path reports `"hint"` because a hint is what it was given, but a hint THIS
  // plugin supplied from its own memo is not a caller's decision. Recording it
  // would relabel a guess as a determination on the very second read — the
  // opposite of what `decided` is for, and a contradiction with the `footer`
  // below, which deliberately keeps saying "Auto-guessed".
  //
  // Only when the caller passed no `encoding` of its own: an explicit hint IS a
  // decision, and must win over the recorded one.
  //
  // The `footer` fallback covers a memo that predates this field: the footer is
  // written ONLY by the guess path, so its presence proves the encoding was
  // guessed. Without it that record would fall through to `decoded.decided`
  // ("hint") and reproduce the very contradiction this line exists to prevent.
  //
  // Read through `provenanceOf` rather than repeating the rule: the service
  // reports the same field to consumers, and two copies of the footer rule would
  // eventually disagree about whether a record describes a guess.
  const provenance =
    opts.encodingHint === undefined && hint !== undefined ? provenanceOf(memo) : undefined;
  // A read that may not speak for the session still needs a state to RETURN (the
  // caller reports on it), but it must not store one. `openStateFor` builds it
  // without recording, so the memo keeps whatever the session actually decided —
  // or stays empty, which is what makes the write guard refuse an evicted file
  // instead of inverting a guess made for a diff card.
  const state =
    opts.recordState === false
      ? openStateFor(decoded, version, provenance)
      : recordOpenState(sessionKey, key, decoded, version, provenance);

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
  /**
   * The text this write REPLACES, LF-normalized and BOM-free, when the caller
   * already has it. Providing it is what makes the write undoable.
   *
   * Optional because two callers legitimately lack it: a file being created has
   * no previous content, and a caller that could not read the old bytes (a
   * binary file, a permission failure) must not fabricate them. Absent means
   * "no undo point", which is the honest answer rather than a guess.
   */
  previousText?: string | undefined;
  /**
   * The encoding state to RESTORE, when this write is an undo.
   *
   * Used instead of the session's recorded state, and it disables
   * `normalizeToUtf8` for this call. Both halves matter:
   *
   * - The record may describe the bytes this write is replacing rather than the
   *   ones it must restore. With `normalizeToUtf8` on, the edit being undone
   *   migrated a legacy file to UTF-8, so the session's record says `utf8` while
   *   the file must go back to `gbk`. Encoding the undo from that record would
   *   leave the file as UTF-8 — the content reverted, the encoding not.
   * - Re-applying the migration would do the same thing by a different route:
   *   the migration is part of the edit being undone, so running it again would
   *   immediately re-convert what the undo just restored.
   */
  restoreState?: FileEncodingState | undefined;
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
    const state = req.restoreState ?? getEncodingState(sessionKey, key);

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
      // An undo supplies the exact state to restore, so the migration toggle does
      // not apply: the migration being undone is part of the edit, and running it
      // again would re-convert what this write just put back. See `restoreState`.
      normalizeToUtf8: req.restoreState === undefined && config.normalizeToUtf8,
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
    //
    //    The line ending follows the same rule, and for the same reason: an
    //    existing file's recorded ending is what the caller's text was normalized
    //    from, so it must be kept. A file being CREATED has no record, and the
    //    content is published verbatim — so the record must describe the endings
    //    that text actually carries. Defaulting to LF there made the record
    //    disagree with the bytes on disk, and the next edit inverted the wrong
    //    ending: a file created with CRLF was silently converted to LF by its
    //    first subsequent edit.
    //
    //    `detectEnding` reports the DOMINANT terminator, so a file created with
    //    mixed endings is recorded as its first one and a later edit normalizes the
    //    file to it. That is the same rule an existing mixed-ending file already
    //    followed on its first read, so the create path is consistent with the rest
    //    of the plugin rather than a special case.
    if (after?.version !== undefined) {
      // Written straight into the memo rather than through `recordOpenState`:
      // that function takes a `DecodeForOpenResult`, and this path did not
      // decode anything — it INVERTED a record. Building a fake admission result
      // to satisfy the type would mean inventing the very fields (`decided`,
      // `candidates`) whose honesty is the point, so the record is composed
      // directly from what is actually known.
      //
      // Migration is the one case where the OLD provenance must NOT be carried
      // over: `normalizeToUtf8` rewrites a legacy file as UTF-8, so the recorded
      // encoding and the bytes on disk are both UTF-8 now. Keeping the old
      // `"guessed"`/`"hint"` would pair `encoding: "utf8"` with a provenance that
      // only made sense for the retired page — and a strict UTF-8 validation is
      // a determination, never a guess, so the next read would report a settled
      // fact as a probabilistic pick. The footer is dropped for the same reason:
      // it names a page ("Auto-guessed: gbk …") that no longer describes the
      // file, and leaving it would contradict the encoding beside it.
      const migrated = state !== undefined && state.encoding !== encoded.encoding;
      setEncodingState(sessionKey, key, {
        encoding: encoded.encoding,
        hasBOM: encoded.hasBOM,
        lineEnding: state?.lineEnding ?? detectEnding(content),
        version: after.version,
        // The provenance of the bytes now on disk.
        //
        // A file this session READ keeps the provenance that read established:
        // a file decoded from a GUESS is still a guess after an edit, and
        // re-labelling it here would make the next read present that guess as a
        // decision. Migration is the exception (see above): the encoding was
        // re-derived, so the old label no longer applies.
        //
        // A file being CREATED has no read to inherit from, and must not be left
        // blank: a blank falls through to the hint path on the next read, which
        // reports `"hint"` — the documented meaning of "the CALLER specified
        // this" — for an encoding the plugin chose by itself. The provenance is
        // therefore derived from what actually determined it.
        ...(migrated
          ? { decided: "utf8" satisfies DecodeProvenance }
          : state?.decided !== undefined
            ? { decided: state.decided }
            : { decided: createdProvenance(encoded) }),
        // Same rule for the provenance note the read showed the model — except
        // after a migration, where the note is about the retired encoding.
        ...(!migrated && state?.footer !== undefined ? { footer: state.footer } : {}),
      });
    }

    // 7) Record what this write replaced, so the NEXT write on this file can be
    //    undone — or, when this write IS an undo, so the spent history is gone.
    //
    //    Here rather than in each tool for the reason `service.ts` gives about
    //    its own single funnel: one recording point means a new tool cannot
    //    forget to add one. And it is AFTER the publish, so a write that failed
    //    leaves no undo point claiming an edit that never happened.
    //
    //    `previousText` is normalized here, not by the callers. They do not
    //    agree on the form — `edit` / `insert` pass LF-normalized text while
    //    `write` passes the caller's content verbatim (CRLF intact) — and the
    //    undo compares this text against a freshly normalized read, so the two
    //    sides must be in the same form or every CRLF file would look modified.
    if (req.restoreState !== undefined) {
      // This write consumed the history: undoing an undo is a redo, which the
      // tool does not offer.
      clearUndoFor(sessionKey, key);
    } else if (req.previousText !== undefined && state !== undefined) {
      recordUndo(sessionKey, key, {
        previousText: toLF(req.previousText),
        nextText: toLF(content),
        // The state as it was BEFORE this write. `state` is exactly that: the
        // record this call read to encode with, which `restoreState` may have
        // overridden for an undo (handled above). A created file has no prior
        // state and is not undoable, which the `state !== undefined` guard
        // enforces.
        previousState: state,
        // The version this write produced, which the undo compares against the
        // file's version before reverting. Without it a change the text cannot
        // show — converted line endings, an added or removed BOM, a re-encoded
        // file — would compare equal and be silently overwritten.
        nextVersion: after?.version,
        // The encoding these bytes were ACTUALLY written in, which is what the
        // undo must decode them as. `encoded.encoding` rather than
        // `state.encoding`: a migration makes the two differ, and the undo's
        // read needs the one describing what is on disk.
        nextEncoding: encoded.encoding,
        mode,
      });
    }

    return { version: after?.version, bytes: encoded.bytes };
  } catch (error) {
    throw sandbox.mapError(error, policy);
  }
}
