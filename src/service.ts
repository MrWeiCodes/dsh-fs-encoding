/**
 * The `ctx.fsEncoding` service: this plugin's decoding rules, exposed to other
 * plugins.
 *
 * The tools this plugin shadows solve encoding for the MODEL. They do nothing
 * for the other half of the harness — a plugin that reads a file to render it
 * for a human (an approval preview, a diff card, a file viewer) goes through
 * `ctx.fs`, whose contract is UTF-8-only by design: it decodes with a strict
 * `TextDecoder`, so a GBK file is simply `FS_NOT_TEXT`. Such a plugin then
 * either shows an error where the file has perfectly readable content, or —
 * worse — reimplements the guess itself, which is how two parts of one
 * deployment end up disagreeing about what a file says.
 *
 * This service is the answer to that: ONE implementation of "what text is in
 * these bytes", owned by the plugin that already owns the question, and
 * callable by anyone.
 *
 * ## What it deliberately does NOT do
 *
 * It does not read files. The caller owns the IO, the sandbox and the path
 * resolution, because those are the caller's context to know — a preview has a
 * session, a cwd and a sandbox fence; this service has none of them. Taking
 * bytes keeps the seam at the narrowest possible point and means a consumer
 * needs no privileges it did not already have.
 *
 * It does not record anything either. A decode here is a QUESTION, not an
 * observation: it must not arm the read-before-write gate, and it must not
 * become the session's recorded encoding, or a preview would silently authorize
 * a later save. Recording stays on the tool path, where the model's read is.
 *
 * READING a record is a different act from MAKING one, and only the second is
 * forbidden here. {@link FsEncodingService.recordedEncoding} reports what a
 * session has already recorded, because a consumer that has to agree with a tool
 * (`edit` takes no `encoding` argument; its encoding is this plugin's own
 * record) cannot recover that answer from the bytes. It derives nothing, writes
 * nothing and gates nothing — see the class doc for the guarantee both halves
 * keep.
 *
 * ## The contract consumers actually need
 *
 * {@link FsEncodingService.decode} answers with the text AND how it was decided
 * ({@link DecodeProvenance}). That distinction is not decoration: a consumer
 * that renders the text has to be able to say "this was guessed" instead of
 * presenting a guess as the file's real encoding. A service that returned only
 * a string would push every consumer into either lying or re-deriving the
 * provenance itself.
 *
 * Refusal is a value, not a throw: {@link FsEncodingService.tryDecode} answers
 * with a discriminated result carrying the refusal and its candidate list.
 * Consumers rendering for a human want to offer those candidates as a chooser,
 * and a thrown `Error` whose message they must parse is a worse seam than a
 * returned one. {@link FsEncodingService.decode} still throws, for a caller that
 * wants the model-facing sentence verbatim.
 *
 * @module dsh-fs-encoding/service
 */

import type { Context } from "@deepseek-ai/cordis";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { loadConfig } from "./config.js";
import {
  decodeForOpen,
  DecodeError,
  getEncodingState,
  isStale,
  provenanceOf,
  sessionKeyOf,
  type DecodeForOpenResult,
  type DecodeProvenance,
} from "./encoding-state.js";
import { keyOf } from "./io.js";
import { CANONICAL_ENCODINGS, isValidUtf8, SUPPORTED_ENCODINGS_TEXT } from "./encoding.js";
import type { CandidatePreview } from "./encoding.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /**
     * This plugin's decoding rules, when it is installed.
     *
     * Declared optional on purpose: the plugin is a choice, and a consumer that
     * reads `ctx.fsEncoding` must handle its absence rather than assume it.
     * Reading it through `ctx.get("fsEncoding")` is equivalent and needs no
     * `inject` declaration.
     */
    fsEncoding?: FsEncodingService;
  }
}

/** The service name, as it appears in `ctx.get(name)` and in `inject`. */
export const FS_ENCODING_SERVICE = "fsEncoding";

/**
 * What one decode found, in the shape a rendering consumer needs.
 *
 * Deliberately a flat, serializable record rather than the internal admission
 * result: a consumer should not be able to depend on the plugin's internals,
 * and every field here answers a question a preview actually has.
 */
export interface FsDecodeResult {
  /** The decoded text, BOM removed, the file's own line endings intact. */
  text: string;
  /** Canonical encoding identifier that produced {@link text}. */
  encoding: string;
  /**
   * How {@link encoding} was decided.
   *
   * `"guessed"` is the one a consumer must surface: the text is probably right,
   * but it is a probabilistic pick and a human should be told so. The other
   * three are determined, and a consumer may present them as fact.
   */
  decided: DecodeProvenance;
  /** Whether the bytes carried a BOM. */
  hasBOM: boolean;
  /** The dominant line terminator in the decoded text. */
  lineEnding: "\r\n" | "\n" | "\r";
}

/** Why a decode was refused, with everything a consumer needs to explain it. */
export interface FsDecodeRefusal {
  /** A model-facing sentence describing the refusal, ready to display. */
  message: string;
  /**
   * Stable code: `E_NOT_TEXT` for "not decodable text", `E_TOO_LARGE` when the
   * bytes exceed the decode cap, `E_BAD_ENCODING` for a bad argument (an unknown
   * encoding name, or a value of the wrong type). Only `E_NOT_TEXT` carries
   * candidates; the others have nothing to choose between.
   */
  code: string;
  /**
   * The candidate encodings that could decode these bytes, best first.
   *
   * Present on `E_NOT_TEXT`. Empty when nothing decoded cleanly, which normally
   * means binary content — a consumer should say so rather than offer a list.
   */
  candidates: CandidatePreview[];
  /**
   * Whether the candidates are ordered by evidence.
   *
   * `false` means no candidate outranked the others, so the order carries no
   * recommendation and a consumer must not label the head "most likely".
   */
  ranked: boolean;
  /**
   * Whether the head candidate is credible enough to adopt.
   *
   * `false` with `ranked: true` is the dangerous middle case: there IS an order,
   * but the head is a page this plugin has specifically decided is not credible
   * for these bytes. Offering it as a default would reproduce the silent
   * mis-decode the refusal exists to prevent.
   */
  adoptable: boolean;
  /**
   * Whether the effective configuration permits guessing at all.
   *
   * This is what makes the refusal actionable: with guessing off the remedy is
   * to enable it or re-read with an explicit encoding, while with guessing on it
   * is to pick from the candidates. The two are indistinguishable otherwise.
   */
  autoGuessEnabled: boolean;
}

/** Per-call options for {@link FsEncodingService.decode}. */
export interface FsDecodeOptions {
  /**
   * An explicit encoding ("Reopen with Encoding"), which bypasses guessing.
   *
   * This is the same escape hatch the `read` tool offers, so a consumer that
   * shows a candidate list can let a human pick one and pass it straight back.
   */
  encoding?: string | undefined;
  /** Path as the caller knows it, used in refusal messages. */
  displayPath?: string | undefined;
  /**
   * Inclusive byte cap for this decode, defaulting to the plugin's
   * `maxFileBytes`.
   *
   * Exists because this service takes bytes the CALLER read: the tool path gets
   * its cap for free from `fs.readBytes`, while a caller that omitted the cap
   * (the README example did) can hand over an arbitrarily large buffer. The
   * failure path then ranks every allowlisted encoding across the whole buffer,
   * synchronously, which stalls the host event loop for every session — so the
   * bound has to live here too, not only at the read seam.
   */
  maxBytes?: number | undefined;
}

/**
 * What a session has recorded about one file's encoding.
 *
 * The other half of the seam. {@link FsEncodingService.decode} answers "what do
 * these bytes say?", which is enough for a viewer but NOT enough for a consumer
 * that has to agree with a TOOL: `edit`, `insert` and `str_replace_editor` take
 * no `encoding` argument, so their encoding comes from this plugin's own record
 * (`io.ts` reuses it as the hint on every read). A consumer that guessed from
 * the bytes instead can pick a different page and then render a diff against
 * text the tool will never see — measured: a record of `big5` against bytes
 * whose best-scoring candidate is `gbk` decodes to two different documents.
 *
 * Deliberately its own shape rather than the internal `FileEncodingState`:
 *
 * - `decided` and `footer` are optional there because a state may be built by
 *   hand (tests, a caller that only knows the encoding name). That is an
 *   internal construction path, and a consumer should not have to handle a
 *   missing field for a reason that is not about consumers.
 * - `footer` is model-facing prose ("Auto-guessed GBK …"), documented as
 *   "never file content". Putting it in a service contract invites a renderer to
 *   show it as UI text, which is not what it is for.
 * - `version` is internal bookkeeping (an opaque freshness token that
 *   `dsh-fs` says consumers MUST NOT parse). It is deliberately absent: the
 *   staleness QUESTION is answered by the method instead, so a consumer never
 *   reimplements the comparison — see
 *   {@link FsEncodingService.recordedEncoding}.
 */
export interface RecordedEncoding {
  /** Canonical encoding identifier, e.g. `utf8`, `utf8bom`, `gbk`, `utf16le`. */
  encoding: string;
  /**
   * How {@link encoding} was arrived at.
   *
   * Carried because it CANNOT be recovered from the encoding name, and the
   * difference decides how the text may be presented: `hint`/`bom`/`utf8` are
   * determined, `guessed` is a probabilistic pick a human must be told about.
   *
   * A consumer that instead re-decodes with this encoding gets `"hint"` back
   * (the service reports "the CALLER specified this" whenever an explicit
   * encoding is passed), which would present a guess as a determination — the
   * exact failure this plugin exists to prevent.
   */
  decided: DecodeProvenance;
  /** Whether the file carried a byte-order mark when this was recorded. */
  hasBOM: boolean;
  /** The line terminator style a save will restore. */
  lineEnding: "\r\n" | "\n" | "\r";
}

/**
 * The decoding rules of this plugin, as a service.
 *
 * **No method here can change this plugin's state.** `decode` a thousand times
 * is indistinguishable from calling it once, no call writes a record or emits an
 * observation, and nothing here can arm the read-before-write gate.
 *
 * {@link FsEncodingService.recordedEncoding} is the one method that READS
 * session state — it reports what a session has already recorded for a file. It
 * derives nothing and writes nothing; reading a record is not the same act as
 * making one, and only the tool path (where the model's own read is) makes one.
 */
export class FsEncodingService {
  /**
   * Decode bytes, or refuse with the reason.
   *
   * The non-throwing form, and the one a rendering consumer should use: a
   * refusal is an expected outcome for a binary file or a legacy file with
   * guessing off, not an exception.
   *
   * "Never throws" is a promise about ANY input, not just well-typed input: a
   * consumer is usually another plugin, often plain JavaScript, and it is
   * documented to skip its own `try`. A bad argument is therefore a refusal like
   * any other, never a `TypeError` escaping into the caller. A bad argument is
   * also NOT quietly reinterpreted as "no argument": a mistyped `opts` is
   * refused rather than ignored, so a caller that meant to name an encoding
   * learns that it did not.
   *
   * @param bytes - the file's raw bytes.
   * @param opts - an optional explicit encoding, display path and byte cap.
   *   Omit it for the defaults; passing `null` or a non-object is refused.
   * @returns the decode result, or the refusal.
   */
  async tryDecode(bytes: Uint8Array, opts: FsDecodeOptions | null = {}): Promise<
    { ok: true; result: FsDecodeResult } | { ok: false; refusal: FsDecodeRefusal }
  > {
    try {
      return { ok: true, result: this.#present(await this.#admit(bytes, opts)) };
    } catch (error) {
      if (error instanceof DecodeError) return { ok: false, refusal: refusalOf(error) };
      throw error;
    }
  }

  /**
   * Decode bytes, or throw the model-facing refusal.
   *
   * For a caller that wants the plugin's own wording — the same sentence the
   * `read` tool would produce, candidate list and suggested re-read included.
   *
   * @param bytes - the file's raw bytes.
   * @param opts - an optional explicit encoding and display path. Omit it for
   *   the defaults; passing `null` or a non-object is refused.
   * @returns the decode result.
   * @throws {DecodeError} when the bytes cannot be admitted.
   */
  async decode(bytes: Uint8Array, opts: FsDecodeOptions | null = {}): Promise<FsDecodeResult> {
    return this.#present(await this.#admit(bytes, opts));
  }

  /**
   * Whether these bytes are valid UTF-8 — NOT whether `ctx.fs.readText` will
   * accept them.
   *
   * The two questions differ, and the difference is reachable: `readText`
   * rejects a NUL byte in the leading sample as binary, while a NUL byte is
   * perfectly valid UTF-8 (it is the ASCII NUL). Measured: UTF-16LE bytes
   * without a BOM (`61 00 62 00`) are valid UTF-8 and are refused by `readText`
   * with `FS_NOT_TEXT`. A caller that uses this as a "will readText work" probe
   * must therefore still handle that refusal.
   *
   * Exposed because the common case deserves to stay cheap: a consumer that
   * only needs to know whether the bytes are UTF-8 should not have to run
   * admission (and a possible chardet pass) to find out.
   *
   * @param bytes - the bytes to test.
   * @returns whether a strict UTF-8 decode succeeds.
   */
  isUtf8(bytes: Uint8Array): boolean {
    return isValidUtf8(bytes);
  }

  /**
   * The encodings this deployment will consider when guessing.
   *
   * The EFFECTIVE set: the shipped default, minus the config's exclusions, or
   * the explicit list the operator wrote. A consumer that wants to offer a
   * chooser should use this rather than its own list, or it will offer pages
   * this deployment has deliberately excluded.
   *
   * @returns canonical encoding names.
   */
  supportedEncodings(): string[] {
    return [...loadConfig().supportedEncodings];
  }

  /**
   * Every encoding name this plugin can decode, regardless of configuration.
   *
   * Distinct from {@link supportedEncodings}: this is the vocabulary (what a
   * name may be), that is the policy (what this deployment will try). An
   * explicit `encoding` may name anything in here.
   *
   * @returns canonical encoding names.
   */
  knownEncodings(): string[] {
    return [...CANONICAL_ENCODINGS];
  }

  /**
   * Whether this deployment decodes a non-UTF-8 file by guessing.
   *
   * Exposed so a consumer can explain a refusal correctly without parsing the
   * message: `false` means "no attempt was made", not "the attempt failed".
   *
   * @returns the effective `autoGuessEncoding`.
   */
  autoGuessEnabled(): boolean {
    return loadConfig().autoGuessEncoding;
  }

  /**
   * What one session has recorded for one file, or `undefined` when there is no
   * usable record.
   *
   * The method a consumer needs when it must agree with a TOOL rather than
   * merely display bytes. `edit`, `insert` and `str_replace_editor` take no
   * `encoding` argument; their encoding is whatever this plugin recorded when
   * the file was read in that session, reused as the hint on every later read.
   * Decoding the same bytes by guessing can land on a different page, and the
   * resulting diff would then describe text the tool never touches.
   *
   * **This is a question, not an observation.** It writes no record, emits no
   * event, arms no gate, and cannot make a write possible that was not possible
   * before — the guarantee {@link FsEncodingService} states for every method it
   * offers. A consumer that renders a preview can call it freely.
   *
   * **Staleness is answered here, not left to the caller.** Pass the version
   * just observed from `ctx.fs.stat` and a record taken at a different version
   * is reported as `undefined`, using the same comparison the write path uses to
   * discard one.
   *
   * Omitting the argument is NOT "skip the check": it is read exactly as the
   * write path reads an absent version (`invalidateIfStale(sessionKey, key,
   * version)`), so a record that carries a version but is asked about without
   * one is reported as `undefined`. That is the fail-closed direction, and it is
   * deliberate — `undefined` is what a caller gets when it could not observe the
   * file (a `stat` that returned nothing), and answering "here is the record"
   * there is how a consumer ends up describing a file the tool will refuse to
   * write. A caller that genuinely wants the record as it stands, fresh or not
   * (to show history, say), says so explicitly with `null`.
   *
   * `undefined` therefore means "no usable record" and collapses two causes: the
   * session never recorded this file, or the record no longer matches the file.
   * They are reported alike because the ACTION is the same — fall back to
   * decoding the bytes and presenting the result as a guess — and telling them
   * apart would require exposing the version token, which is exactly the
   * internal detail this method exists to keep out of the contract.
   *
   * Cross-session reads are allowed, and safe: this reports what a session
   * recorded, while the encoding a WRITE uses is derived from the calling
   * session alone (`sessionKeyFor(exec)`). Reading another session's record can
   * therefore inform a display, but never change what gets written. Pass
   * `undefined` for an agentless caller; it reads the anonymous bucket, which is
   * distinct from every real session's.
   *
   * Never throws: an unusable `target` or `sessionId` answers `undefined`, the
   * same promise {@link FsEncodingService.tryDecode} makes for its arguments.
   *
   * @param sessionId - the session whose record is wanted, or `undefined` for
   *   the agentless bucket.
   * @param target - the resolved target; a target, not a path, because resolving
   *   a path may perform I/O and this service does none.
   * @param currentVersion - the version just observed for the file; omit it when
   *   you could not observe one (fail-closed, as the write path reads it), or
   *   pass `null` to skip the staleness check deliberately.
   * @returns the record, or `undefined` when there is none to trust.
   */
  recordedEncoding(
    sessionId: string | undefined,
    target: FsTarget,
    currentVersion?: FsVersion | null,
  ): RecordedEncoding | undefined {
    try {
      // Read through the internal-slot-free guards below rather than trusting
      // the arguments: this method promises it never throws, and a consumer is
      // usually another plugin, often plain JavaScript, documented to skip its
      // own `try`. A Proxy whose `get` trap throws must not turn a lookup into
      // an exception escaping into the caller.
      if (typeof target !== "object" || target === null) return undefined;
      if (sessionId !== undefined && typeof sessionId !== "string") return undefined;
      // `keyOf` is the SAME function the tool path keys its records with. A
      // second key derivation here could disagree with the first, and a record
      // written under one key and looked up under another silently never
      // matches — the failure this plugin's `keyOf` doc comment calls out.
      const state = getEncodingState(sessionKeyOf(sessionId), keyOf(target as FsTarget));
      if (state === undefined) return undefined;
      // A version the caller supplied is a claim about the file NOW; a record
      // taken at a different one describes a file that no longer exists. The
      // comparison is `isStale`, shared with the write path, so a preview and
      // the tool that follows it cannot disagree about whether the record holds.
      //
      // An OMITTED version goes through the same comparison rather than skipping
      // it, because that is what the write path does with an absent version:
      // `invalidateIfStale(sessionKey, key, version)` is handed `undefined` by a
      // read that could not stat the file, and it deletes a record that carries
      // one. Skipping here would hand a consumer a record the very next write
      // discards — the disagreement this method exists to remove. `null` is the
      // explicit "do not check", kept separate so that a caller which could not
      // observe a version cannot get that answer by accident.
      if (currentVersion !== null && isStale(state, currentVersion)) return undefined;
      return {
        encoding: state.encoding,
        // The real provenance, which is the whole reason this method exists
        // beside `decode`: re-decoding with `state.encoding` would answer
        // `"hint"` and relabel a guess as a determination.
        //
        // Read through `provenanceOf` — the SAME function the read path uses —
        // rather than restating its footer rule here. The two must agree about
        // whether a record describes a guess, and one shared definition is what
        // makes that structural instead of a comment claiming it. The `"hint"`
        // fallback is this method's own: it is the one answer that must never be
        // absent from the service's shape, and it is what the read path's
        // admission already supplies on its side.
        decided: provenanceOf(state) ?? "hint",
        hasBOM: state.hasBOM,
        lineEnding: state.lineEnding,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Validate the arguments, then run admission.
   *
   * Validation lives here rather than in the two public methods so both get it
   * from one place. It reports through `DecodeError` — the type the refusal path
   * already understands — because the caller is documented to receive a value,
   * not an exception, and a `TypeError` from `input.trim()` on a non-string
   * `encoding` would otherwise escape `tryDecode` entirely.
   */
  async #admit(bytes: Uint8Array, opts: FsDecodeOptions | null): Promise<DecodeForOpenResult> {
    const config = loadConfig();
    // `opts` itself is checked before anything reads its fields, because reading
    // a field off a non-object does NOT throw — it yields `undefined`, which is
    // indistinguishable from "not supplied". So `tryDecode(bytes, "gbk")` — the
    // easy slip of forgetting the braces — would silently drop the encoding the
    // caller named and fall through to guessing, handing back a different
    // decoding than the one that was asked for, with nothing to signal it.
    // `null` is refused too, deliberately: it is what a missing value looks like
    // in JSON and database rows, so accepting it would hide exactly the caller
    // bug this check exists to surface. Only an omitted argument means "use the
    // defaults", and that arrives as `undefined` (see the default parameters).
    if (typeof opts !== "object" || opts === null) {
      throw new DecodeError(
        `[E_BAD_ENCODING] opts must be an object, got ${opts === null ? "null" : typeof opts}. Pass { encoding, displayPath, maxBytes } or omit the argument entirely.`,
        "E_BAD_ENCODING",
      );
    }
    // The OPTION half of "a read may throw". Every field below is read through
    // `readOption`, never as `opts.field`: a getter (or a Proxy's `get` trap) may
    // throw, and a bare read would let that throw escape `tryDecode`, which
    // documents that it never throws — the same promise the type checks below
    // exist to keep. A plain data property cannot throw, so this costs nothing
    // on the path every real caller takes. The `bytes` argument needs the same
    // guard and gets it further down, where the view is normalized.
    const encoding = readOption(opts, "encoding");
    const displayPath = readOption(opts, "displayPath");
    const maxBytes = readOption(opts, "maxBytes");
    if (encoding === THREW) {
      throw new DecodeError(
        `[E_BAD_ENCODING] opts.encoding could not be read: its getter threw. Pass a plain { encoding: "..." } object.`,
        "E_BAD_ENCODING",
      );
    }
    if (displayPath === THREW) {
      throw new DecodeError(
        `[E_BAD_ENCODING] opts.displayPath could not be read: its getter threw. Pass a plain { displayPath: "..." } object.`,
        "E_BAD_ENCODING",
      );
    }
    if (maxBytes === THREW) {
      throw new DecodeError(
        `[E_BAD_ENCODING] opts.maxBytes could not be read: its getter threw. Pass a plain { maxBytes: <number> } object.`,
        "E_BAD_ENCODING",
      );
    }
    if (encoding !== undefined && typeof encoding !== "string") {
      throw new DecodeError(
        `[E_BAD_ENCODING] encoding must be a string, got ${typeof encoding}. Supported: ${SUPPORTED_ENCODINGS_TEXT}`,
        "E_BAD_ENCODING",
      );
    }
    if (displayPath !== undefined && typeof displayPath !== "string") {
      throw new DecodeError(
        `[E_BAD_ENCODING] displayPath must be a string, got ${typeof displayPath}.`,
        "E_BAD_ENCODING",
      );
    }
    // The effective cap, resolved FIRST because normalization below may copy the
    // buffer: an unusable `maxBytes` must be rejected before any work is done on
    // the bytes, and the limit must be enforceable before the copy happens (a
    // copy of an arbitrarily large buffer is the memory amplification the cap
    // exists to prevent).
    //
    // An ABSENT cap and an INVALID one are different answers, and collapsing
    // them would mislead: `Infinity` is the obvious way to write "no cap", and
    // silently turning it into the plugin's limit makes the call fail with a
    // message telling the caller to raise the very argument just ignored. An
    // unusable value is therefore refused, not reinterpreted.
    let cap = config.maxFileBytes;
    if (maxBytes !== undefined) {
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0) {
        // `String(value)` is NOT safe here: the value failed the integer check
        // precisely because it may be a Symbol (String() is fine) or an object
        // whose `toString` throws — and that throw would escape `tryDecode`,
        // breaking the one promise this validation exists to keep. Numbers are
        // reported by value (the useful case); everything else by type.
        const shown = typeof maxBytes === "number" ? String(maxBytes) : typeof maxBytes;
        throw new DecodeError(
          `[E_BAD_ENCODING] maxBytes must be a positive safe integer, got ${shown}. Omit it to use this deployment's maxFileBytes (${config.maxFileBytes}); there is no "unlimited" value.`,
          "E_BAD_ENCODING",
        );
      }
      cap = maxBytes as number;
    }
    // Normalized rather than merely checked, so everything below operates on a
    // genuine `Uint8Array` and the type is not a claim the value fails to keep.
    //
    // The cap is enforced BEFORE normalization, because normalization copies a
    // cross-realm or signed view: checking afterwards would duplicate an
    // arbitrarily large buffer first — the memory amplification the cap exists
    // to prevent. The length is therefore read from the caller's value.
    //
    // The `bytes` half of the same threat the option reads above defend against,
    // and it needs the same guard. `ArrayBuffer.isView` proves the internal slot
    // is present, but says nothing about who owns the PROPERTIES: a `Uint8Array`
    // subclass — or `Object.defineProperty` on a plain instance — may carry its
    // own `BYTES_PER_ELEMENT`, `buffer`, `byteOffset` or `byteLength` accessor,
    // and such a getter may throw. A bare read would let that throw escape
    // `tryDecode`, which documents that it never throws for ANY input — and
    // `bytes` is the argument a caller passes most often. The reads are wrapped
    // together rather than one at a time, because they are one failure and
    // scattering the guard is how one of them gets forgotten.
    //
    // The guard alone would not be enough, and a `try` is not even the point:
    // `toByteArray` deliberately returns a same-realm `Uint8Array` UNTOUCHED, so
    // `raw` could still be the caller's own object — one whose `length` or
    // `subarray` a subclass may have shadowed, which admission below reads. It is
    // re-viewed once, here, into a PLAIN `Uint8Array` over the same bytes, so
    // nothing downstream consults the caller's object at all.
    //
    // The re-view is built from the INTERNAL SLOTS, never from `normalized`'s own
    // properties. Reading them would be the very mistake this guard exists to
    // prevent, one level down: a shadowed `buffer`/`byteOffset`/`byteLength` that
    // RETURNS (rather than throws) would decide which bytes get decoded, turning
    // a hostile view into a silent mis-decode of a different range — and an
    // under-reported `byteLength` would walk an oversized view past the cap. The
    // slots cannot be shadowed and cannot lie. It costs NO data copy: the view
    // aliases the same bytes.
    let declared: number | undefined;
    let raw: Uint8Array | undefined;
    let rawLength = 0;
    try {
      declared = viewByteLength(bytes);
      // Inside the same `try`, and BEFORE normalization: the cap has to hold
      // before the copy that normalization may perform, or an over-limit view is
      // duplicated first — the memory amplification the cap exists to prevent.
      // Re-thrown as-is by the `catch` below, which only converts the failures
      // that are not already refusals.
      if (declared !== undefined && declared > cap) {
        throw new DecodeError(
          `[E_TOO_LARGE] ${displayPath ?? "(unknown path)"} is ${declared} bytes, over the ${cap}-byte cap for a decode. Raise maxBytes (or the plugin's maxFileBytes) to decode it.`,
          "E_TOO_LARGE",
        );
      }
      const normalized = toByteArray(bytes);
      if (normalized !== undefined) {
        raw = new Uint8Array(
          SLOT_BUFFER.call(normalized),
          SLOT_BYTE_OFFSET.call(normalized),
          SLOT_BYTE_LENGTH.call(normalized),
        );
        rawLength = SLOT_BYTE_LENGTH.call(raw);
      }
    } catch (error) {
      if (error instanceof DecodeError) throw error;
      // The only read that can still reach a caller's code is the element-size
      // declaration (`BYTES_PER_ELEMENT` has no internal slot, so it has to be
      // read off the value), and a Proxy reporting an endless prototype chain
      // makes even the native lookup throw. Everything about the byte LAYOUT is
      // read through the prototype accessors above, which never touch the
      // caller's accessors at all — so this message names the declaration rather
      // than claiming a layout property threw.
      throw new DecodeError(
        `[E_BAD_ENCODING] bytes could not be read: reading this view's BYTES_PER_ELEMENT threw. Pass a plain Uint8Array.`,
        "E_BAD_ENCODING",
      );
    }
    if (raw === undefined) {
      throw new DecodeError(
        `[E_BAD_ENCODING] bytes must be a Uint8Array (or another one-byte view), got ${typeof bytes}.`,
        "E_BAD_ENCODING",
      );
    }
    if (rawLength > cap) {
      throw new DecodeError(
        `[E_TOO_LARGE] ${displayPath ?? "(unknown path)"} is ${rawLength} bytes, over the ${cap}-byte cap for a decode. Raise maxBytes (or the plugin's maxFileBytes) to decode it.`,
        "E_TOO_LARGE",
      );
    }
    return decodeForOpen(raw, config, {
      ...(encoding === undefined ? {} : { encodingHint: encoding as string }),
      ...(displayPath === undefined ? {} : { displayPath: displayPath as string }),
    });
  }

  /** Narrow the internal result to the public, consumer-facing shape. */
  #present(decoded: DecodeForOpenResult): FsDecodeResult {
    return {
      text: decoded.text,
      encoding: decoded.encoding,
      decided: decoded.decided,
      hasBOM: decoded.hasBOM,
      lineEnding: decoded.lineEnding,
    };
  }
}

/**
 * Turn a thrown admission error into the public refusal shape.
 *
 * The argument-level failures (an unknown encoding name, a wrong explicit
 * encoding) carry no candidate detail, so they are reported with empty
 * candidates and `ranked: false` — a consumer showing a chooser then shows
 * nothing, which is correct: there is nothing to choose between, and the
 * message says what to fix.
 *
 * @param error - the thrown `DecodeError`.
 * @returns the refusal.
 */
function refusalOf(error: DecodeError): FsDecodeRefusal {
  const detail = error.detail;
  return {
    message: error.message,
    code: error.code,
    candidates: detail === undefined ? [] : [...detail.candidates],
    ranked: detail?.ranked ?? false,
    adoptable: detail?.adoptable ?? false,
    // Without structured detail the configuration is still readable, and
    // reporting it is more useful than reporting `false` by default: a consumer
    // uses this field to explain the refusal, and "guessing is on, so this file
    // defeated it" is a different, more accurate statement than "guessing is
    // off". Only the candidate-detail path can carry the value that was in
    // force at admission time, so it is read again here for the rest.
    autoGuessEnabled: detail?.autoGuessEnabled ?? loadConfig().autoGuessEncoding,
  };
}

/**
 * Sentinel for "reading this option threw", distinct from every real value.
 *
 * A module-private symbol cannot be produced by a caller, so it cannot be
 * confused with a legitimate `undefined` (not supplied) or with any value a
 * getter might return.
 */
const THREW: unique symbol = Symbol("dsh-fs-encoding.option-threw");

/**
 * Read one option field without letting a getter's throw escape.
 *
 * `opts.field` is not a safe read: a getter — or a Proxy's `get` trap — may
 * throw, and that throw would leave `tryDecode` as an exception even though it
 * documents that it never throws for any input. Reading through here turns that
 * into a value the caller can refuse on. A plain data property never throws, so
 * the `try` costs nothing on the path every real caller takes.
 *
 * @param opts - the validated options object.
 * @param key - the field to read.
 * @returns the value, `undefined` when absent, or {@link THREW}.
 */
function readOption(
  opts: FsDecodeOptions,
  key: keyof FsDecodeOptions,
): unknown | typeof THREW {
  try {
    return (opts as Record<string, unknown>)[key];
  } catch {
    return THREW;
  }
}

/**
 * The TypedArray internal-slot accessors, captured once at module load.
 *
 * A view's own properties are NOT a safe read even when they do not throw: a
 * subclass field or a `defineProperty` accessor SHADOWS the prototype getter and
 * can answer with a LIE, and a lie about which buffer, or where inside it, is a
 * silent mis-decode — the exact failure this plugin exists to prevent. A lie
 * about the length is worse: an under-reported `byteLength` walks an oversized
 * view straight past the cap.
 *
 * The prototype's own getter reads the internal slot, so it cannot be shadowed,
 * cannot be lied to, and never invokes the caller's accessor at all. That is why
 * every byte-layout read below goes through here rather than through the view.
 */
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;

/**
 * Capture one internal-slot accessor off the TypedArray prototype.
 *
 * @param key - the accessor to capture.
 * @returns the prototype's own getter.
 * @throws when the prototype does not carry that accessor. Unreachable unless
 *   the language itself changed, and failing loud at load is better than
 *   silently falling back to the shadowable instance read.
 */
function slotAccessor<T>(key: string): (this: unknown) => T {
  const descriptor = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, key);
  if (descriptor?.get === undefined) {
    throw new Error(`dsh-fs-encoding: TypedArray.prototype.${key} is not an accessor`);
  }
  return descriptor.get as (this: unknown) => T;
}

const SLOT_BUFFER = slotAccessor<ArrayBufferLike>("buffer");
const SLOT_BYTE_OFFSET = slotAccessor<number>("byteOffset");
const SLOT_BYTE_LENGTH = slotAccessor<number>("byteLength");
const SLOT_LENGTH = slotAccessor<number>("length");

/**
 * Whether this view is one BYTE per element, decided without trusting the view.
 *
 * `BYTES_PER_ELEMENT` is a DATA property of each concrete prototype
 * (`Uint8Array.prototype`, `Int16Array.prototype`, …), not an internal slot, so
 * it has no accessor to capture — but reading it off the value would consult the
 * INSTANCE first and honour a shadowing field or accessor, which either throws or
 * answers `1` for a `Uint16Array` and lets a wider view be decoded as bytes.
 *
 * The declared value is therefore only a cheap first gate; the decision is made
 * by the internal slots: a one-byte view has exactly as many bytes as elements.
 * `length` and `byteLength` are read through the prototype accessors, so they
 * cannot be shadowed and cannot lie, and a view whose declaration disagrees with
 * its own slots is refused rather than believed.
 *
 * The prototype chain is deliberately NOT walked. A `Proxy` can report an
 * endless chain of prototypes (its `getPrototypeOf` trap may return a fresh proxy
 * each time), which would spin this function forever and block the host event
 * loop for every session — the native lookup below is guarded by the engine and
 * terminates.
 *
 * @param value - a value that already passed `ArrayBuffer.isView`.
 * @returns whether the view is byte-sized.
 */
function isByteSizedView(value: object): boolean {
  // Native lookup, so a Proxy reporting an infinite prototype chain cannot hang
  // this. A getter that throws is not caught here: the caller wraps this read,
  // so the throw becomes a refusal rather than an escape.
  if ((value as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT !== 1) return false;
  const bytes = SLOT_BYTE_LENGTH.call(value);
  const elements = SLOT_LENGTH.call(value);
  // `0 === 0` for an empty view of any element size, so the declared `1` above is
  // what decides that case; for a non-empty view the two must agree exactly.
  return elements === 0 ? bytes === 0 : bytes === elements;
}

/**
 * The byte length of a candidate buffer, when it is one at all.
 *
 * Read before normalization so an over-limit buffer can be refused without first
 * being copied. Deliberately narrow: it reports a length only for a value that
 * `toByteArray` would accept, so a rejection never depends on this reading a
 * property off something that is not a view.
 *
 * @param value - the candidate.
 * @returns the byte length, or `undefined` when the value is not a usable view.
 */
function viewByteLength(value: unknown): number | undefined {
  if (!ArrayBuffer.isView(value)) return undefined;
  if (!isByteSizedView(value)) return undefined;
  // The internal slot, never the instance property: a shadowing accessor could
  // otherwise report a small length and walk an oversized view past the cap.
  const buffer = SLOT_BUFFER.call(value);
  // `SharedArrayBuffer` has no `detached` property, so it reads `undefined` here
  // and is unaffected.
  if ((buffer as { detached?: unknown }).detached === true) return undefined;
  return SLOT_BYTE_LENGTH.call(value);
}

/**
 * Coerce a byte-oriented view into a genuine `Uint8Array`, or reject it.
 *
 * Deliberately NOT a bare `instanceof Uint8Array`: a `Uint8Array` built inside
 * another realm (a `node:vm` context, which DSH uses to evaluate dynamic
 * packages) has that realm's `Uint8Array` as its prototype, so `instanceof` is
 * false even though every byte operation works — and the refusal would then
 * claim the value "is not a Uint8Array" while it demonstrably is.
 *
 * The returned value is a REAL `Uint8Array` in every case, which is what makes
 * the signature honest. A same-realm `Uint8Array` is passed through untouched
 * (no copy, no cost on the common path); anything else that is a one-byte view
 * (`Int8Array`, `Uint8ClampedArray`, or a cross-realm array) is copied into one.
 * Copying rather than casting matters: those types share the byte layout but not
 * the element semantics — `new Int8Array([0xff]).subarray(0)[0]` is `-1`, not
 * `255` — so handing one to code typed as `Uint8Array` would be a promise the
 * value does not keep.
 *
 * The `cap` is NOT enforced here: the caller checks the length first (see
 * {@link viewByteLength}) and rejects an over-limit buffer before this copy can
 * happen, then checks again on the normalized result.
 *
 * `DataView` is a view but has no `BYTES_PER_ELEMENT`, so it is excluded.
 * `Uint16Array` and wider views are excluded on purpose: this service decodes
 * BYTES, and a wider view would silently reinterpret the same buffer.
 *
 * @param value - the candidate.
 * @returns a `Uint8Array` over the same bytes, or `undefined` when unusable.
 */
function toByteArray(value: unknown): Uint8Array | undefined {
  // `ArrayBuffer.isView` FIRST, and as the only gate. It checks for the internal
  // slot a real view carries, which is exactly the property that makes the byte
  // operations below safe — and it is false for a Proxy wrapping a view, which
  // `instanceof` accepts (the proxy forwards `[[GetPrototypeOf]]`) even though
  // every TypedArray accessor on it then throws "incompatible receiver".
  // Testing it first is what keeps the refusal a value instead of a TypeError
  // escaping into the caller.
  if (!ArrayBuffer.isView(value)) return undefined;
  if (!isByteSizedView(value)) return undefined;
  // A detached buffer must be refused, and the check has to come before either
  // branch below. Its view still passes `isView` and reports `byteLength === 0`,
  // so without this it takes one of two wrong paths: a `Uint8Array` is returned
  // as a zero-length array and the caller decodes it as an EMPTY FILE (a silent
  // misread of a buffer whose bytes are gone), while a signed or clamped view
  // reaches `slice` and throws "Cannot perform ... on a detached ArrayBuffer" —
  // a TypeError escaping `tryDecode`, which documents that it never throws.
  // The internal slot is read rather than the instance property, so a shadowing
  // accessor cannot claim a healthy buffer for a detached one (or the reverse).
  // `SharedArrayBuffer` has no `detached` property, so it reads `undefined` here
  // and is unaffected.
  const buffer = SLOT_BUFFER.call(value);
  if ((buffer as { detached?: unknown }).detached === true) return undefined;
  // A genuine same-realm Uint8Array is returned as-is (no copy on the common
  // path). Everything else that reached this point is a signed, clamped or
  // cross-realm one-byte view, which shares the byte layout but not the element
  // semantics, so it is copied into a real Uint8Array rather than cast.
  if (value instanceof Uint8Array) return value;
  // Copied from the internal slots, not from the instance properties: the
  // offsets below decide WHICH bytes are copied, so a shadowed `byteOffset` or
  // `byteLength` would silently copy a different range than the view denotes.
  const offset = SLOT_BYTE_OFFSET.call(value);
  return new Uint8Array(buffer.slice(offset, offset + SLOT_BYTE_LENGTH.call(value)));
}

/**
 * Whether a value can be used as this plugin's decoding service.
 *
 * A consumer should use this rather than `=== undefined`. When another plugin has
 * already registered the name `fsEncoding`, cordis keeps the FIRST provider's
 * object in its store and the later `provide` throws — so `ctx.get` answers with
 * a foreign object, not `undefined`, and calling `tryDecode` on it throws
 * `TypeError` inside the consumer. Checking the capability is what makes the
 * lookup safe in that deployment.
 *
 * The predicate is deliberately typed as the methods it actually verifies, NOT
 * as the whole class. Claiming the full type would let a consumer call
 * `supportedEncodings()` (or any other member) with no compile error and fail at
 * runtime — the type must not promise more than the check proves.
 *
 * Name the methods you need to ask the precise question:
 *
 * ```js
 * isFsEncodingService(svc)                        // tryDecode + decode
 * isFsEncodingService(svc, "recordedEncoding")    // just that one
 * ```
 *
 * The names matter because a service instance may be OLDER than the consumer's
 * idea of it: the first registration of the name wins, so a mount can be handed
 * an earlier build of this plugin, and a method added since then is simply
 * absent. Checking a fixed list cannot express that — verifying less than the
 * consumer calls lets the call throw, and verifying more rejects an instance
 * whose decode entry points work perfectly. Asking for exactly what will be
 * called is the only form that is right in both directions, and it is why
 * {@link FsEncodingService.recordedEncoding} is NOT in the default set: a build
 * that predates it still answers the decode question correctly.
 *
 * Omitting the names keeps the historical answer (`tryDecode` + `decode`), which
 * is what `index.ts` grades its duplicate-provider diagnosis on: widening the
 * default would make it report a service that HAS the decode entry points as one
 * that does not.
 *
 * The no-names form is also a PLAIN one-argument predicate, and that is
 * load-bearing rather than incidental: the historical signature was unary, so
 * consumers pass this function itself as a callback —
 * `candidates.filter(isFsEncodingService)`. A variadic signature breaks every
 * one of those, because `filter` passes the ELEMENT INDEX as the second
 * argument: `required` becomes `[0]`, the predicate then asks whether the object
 * has a method named `"0"`, and a perfectly good service answers `false`.
 * Measured: `filter` drops 2 matches to 0 and `every` flips from `true` to
 * `false`, with no error anywhere — the callback position turns a variadic
 * signature into a silently wrong answer rather than a compile failure. Both
 * halves below exist for that reason: the unary overload keeps the usage typed,
 * and the runtime drops non-string names so the plain-JavaScript callback (which
 * no overload can reach) still answers correctly.
 *
 * @param value - whatever `ctx.get("fsEncoding")` returned.
 * @param required - the members the caller is about to use; omit for the decode
 *   entry points (`tryDecode`, `decode`).
 * @returns whether the value offers every named member.
 */
export function isFsEncodingService(
  value: unknown,
): value is Pick<FsEncodingService, "tryDecode" | "decode">;
export function isFsEncodingService<K extends keyof FsEncodingService>(
  value: unknown,
  ...required: readonly [K, ...K[]]
): value is Pick<FsEncodingService, K>;
export function isFsEncodingService(
  value: unknown,
  ...required: readonly unknown[]
): boolean {
  if (typeof value !== "object" || value === null) return false;
  // Non-string entries are DROPPED rather than used as a property name. Two
  // callers produce them, and both are the historical usage this predicate must
  // keep working:
  //
  //   - `filter`/`find`/`every` pass `(element, index, array)`, so a consumer
  //     that hands this function straight to one of them delivers the index
  //     here. Reading it as a name asks for a method called `"0"`.
  //   - A name held in an optional variable (`isFsEncodingService(svc, maybe)`)
  //     arrives as `undefined` when unset, which must mean "not asked for"
  //     rather than "a member named undefined".
  //
  // Dropping them cannot silently weaken the check: a name the caller MEANT to
  // pass is a string, and a string that is not a real member is already a
  // compile error under the overloads.
  const names = required.filter((name): name is keyof FsEncodingService =>
    typeof name === "string",
  );
  // A non-empty tuple is required by the second overload, so an EMPTY spread
  // cannot reach here through the types: `g(v, ...maybeEmpty)` is a compile
  // error rather than a call that quietly falls back to the default pair while
  // the type claims every member was verified. This branch is the backstop for
  // plain JavaScript, which has no overloads to consult.
  const methods: readonly (keyof FsEncodingService)[] =
    names.length === 0 ? (["tryDecode", "decode"] as const) : names;
  const candidate = value as Record<string, unknown>;
  // `every`, so the check is on the same footing for one name and for many.
  return methods.every((method) => typeof candidate[method] === "function");
}

/**
 * Register the service on the plugin's own context.
 *
 * Host-plane, like `ctx.fs` itself: the decoding RULES do not vary per agent or
 * per session, so one registration at load time is the whole install. The
 * per-session half — the recorded encodings — is reached through
 * {@link FsEncodingService.recordedEncoding}, which takes the session as an
 * argument rather than requiring one registration per session: the records are
 * keyed by session inside this plugin, so a single host-plane instance can
 * answer for any of them, and a consumer that has no agent in hand (a preview
 * rendering before a session exists) is served by the same object. Cordis
 * removes it when the plugin's fiber unloads.
 *
 * @param rootCtx - the host-plane plugin context.
 * @returns the service instance, for diagnostics and tests.
 * @throws when the name is already provided on this scope; the caller decides
 *   whether that is fatal. It is NOT swallowed here, because a silent failure
 *   would leave consumers reading a foreign object while the operator believes
 *   the service was published.
 */
export function provideFsEncoding(rootCtx: Context): FsEncodingService {
  const service = new FsEncodingService();
  rootCtx.provide(FS_ENCODING_SERVICE, service);
  return service;
}
