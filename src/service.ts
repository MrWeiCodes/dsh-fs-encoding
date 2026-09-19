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
import { loadConfig } from "./config.js";
import {
  decodeForOpen,
  DecodeError,
  type DecodeForOpenResult,
  type DecodeProvenance,
} from "./encoding-state.js";
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
 * The decoding rules of this plugin, as a service.
 *
 * Every method is pure with respect to the plugin's state: no memo reads, no
 * memo writes, no observation events. Calling `decode` a thousand times is
 * indistinguishable from calling it once.
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
    if (opts.encoding !== undefined && typeof opts.encoding !== "string") {
      throw new DecodeError(
        `[E_BAD_ENCODING] encoding must be a string, got ${typeof opts.encoding}. Supported: ${SUPPORTED_ENCODINGS_TEXT}`,
        "E_BAD_ENCODING",
      );
    }
    if (opts.displayPath !== undefined && typeof opts.displayPath !== "string") {
      throw new DecodeError(
        `[E_BAD_ENCODING] displayPath must be a string, got ${typeof opts.displayPath}.`,
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
    if (opts.maxBytes !== undefined) {
      if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes <= 0) {
        // `String(value)` is NOT safe here: the value failed the integer check
        // precisely because it may be a Symbol (String() is fine) or an object
        // whose `toString` throws — and that throw would escape `tryDecode`,
        // breaking the one promise this validation exists to keep. Numbers are
        // reported by value (the useful case); everything else by type.
        const shown =
          typeof opts.maxBytes === "number" ? String(opts.maxBytes) : typeof opts.maxBytes;
        throw new DecodeError(
          `[E_BAD_ENCODING] maxBytes must be a positive safe integer, got ${shown}. Omit it to use this deployment's maxFileBytes (${config.maxFileBytes}); there is no "unlimited" value.`,
          "E_BAD_ENCODING",
        );
      }
      cap = opts.maxBytes;
    }
    // Normalized rather than merely checked, so everything below operates on a
    // genuine `Uint8Array` and the type is not a claim the value fails to keep.
    //
    // The cap is enforced BEFORE normalization, because normalization copies a
    // cross-realm or signed view: checking afterwards would duplicate an
    // arbitrarily large buffer first — the memory amplification the cap exists
    // to prevent. The length is therefore read from the caller's value, which is
    // safe for every type that reaches here (all of them are ArrayBuffer views,
    // and their `byteLength` is a plain data property).
    const declared = viewByteLength(bytes);
    if (declared !== undefined && declared > cap) {
      throw new DecodeError(
        `[E_TOO_LARGE] ${opts.displayPath ?? "(unknown path)"} is ${declared} bytes, over the ${cap}-byte cap for a decode. Raise maxBytes (or the plugin's maxFileBytes) to decode it.`,
        "E_TOO_LARGE",
      );
    }
    const raw = toByteArray(bytes);
    if (raw === undefined) {
      throw new DecodeError(
        `[E_BAD_ENCODING] bytes must be a Uint8Array (or another one-byte view), got ${typeof bytes}.`,
        "E_BAD_ENCODING",
      );
    }
    if (raw.length > cap) {
      throw new DecodeError(
        `[E_TOO_LARGE] ${opts.displayPath ?? "(unknown path)"} is ${raw.length} bytes, over the ${cap}-byte cap for a decode. Raise maxBytes (or the plugin's maxFileBytes) to decode it.`,
        "E_TOO_LARGE",
      );
    }
    return decodeForOpen(raw, config, {
      ...(opts.encoding === undefined ? {} : { encodingHint: opts.encoding }),
      ...(opts.displayPath === undefined ? {} : { displayPath: opts.displayPath }),
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
  if ((value as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT !== 1) return undefined;
  if ((value as { buffer?: { detached?: unknown } }).buffer?.detached === true) return undefined;
  return (value as ArrayBufferView).byteLength;
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
  if ((value as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT !== 1) return undefined;
  // A detached buffer must be refused, and the check has to come before either
  // branch below. Its view still passes `isView` and reports `byteLength === 0`,
  // so without this it takes one of two wrong paths: a `Uint8Array` is returned
  // as a zero-length array and the caller decodes it as an EMPTY FILE (a silent
  // misread of a buffer whose bytes are gone), while a signed or clamped view
  // reaches `slice` and throws "Cannot perform ... on a detached ArrayBuffer" —
  // a TypeError escaping `tryDecode`, which documents that it never throws.
  // `SharedArrayBuffer` has no `detached` property, so it reads `undefined` here
  // and is unaffected.
  if ((value as { buffer?: { detached?: unknown } }).buffer?.detached === true) return undefined;
  // A genuine same-realm Uint8Array is returned as-is (no copy on the common
  // path). Everything else that reached this point is a signed, clamped or
  // cross-realm one-byte view, which shares the byte layout but not the element
  // semantics, so it is copied into a real Uint8Array rather than cast.
  if (value instanceof Uint8Array) return value;
  const view = value as ArrayBufferView;
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
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
 * The predicate is deliberately typed as the two methods it actually verifies,
 * NOT as the whole class. Claiming the full type would let a consumer call
 * `supportedEncodings()` (or any other member) with no compile error and fail at
 * runtime — the type must not promise more than the check proves.
 *
 * @param value - whatever `ctx.get("fsEncoding")` returned.
 * @returns whether the value offers this service's decode entry points.
 */
export function isFsEncodingService(
  value: unknown,
): value is Pick<FsEncodingService, "tryDecode" | "decode"> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { tryDecode?: unknown }).tryDecode === "function" &&
    typeof (value as { decode?: unknown }).decode === "function"
  );
}

/**
 * Register the service on the plugin's own context.
 *
 * Host-plane, like `ctx.fs` itself: the decoding rules do not vary per agent or
 * per session — what varies (the recorded encoding) is deliberately NOT part of
 * this service — so one registration at load time is the whole install. Cordis
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
