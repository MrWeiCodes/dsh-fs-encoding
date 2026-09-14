/**
 * The file-encoding state round-trip: decode-at-open, invert-at-save.
 *
 * One module owns the whole invariant. A file's encoding is decided exactly
 * once, when it is first read in a session, and recorded against the target's
 * canonical key together with the version it was read at. Every later save
 * inverts that record instead of re-deriving it, so a file cannot drift to a
 * different encoding just because a heuristic scored differently on the edited
 * content.
 *
 * The record is invalidated by version: if the file changed on disk since it
 * was read, the memo is dropped and the next read re-runs deterministic
 * admission. A stale record can therefore never authorize a write.
 *
 * @module dsh-fs-encoding/encoding-state
 */

import {
  chardetTop3Candidates,
  decodeBytes,
  detectBom,
  encodeText,
  isValidUtf8,
  normalizeEncoding,
  REPLACEMENT_CHAR,
  top3Candidates,
  type CandidatePreview,
} from "./encoding.js";
import {
  detectEnding,
  restoreEndings,
  toLF,
  UTF8_BOM_BYTES,
  type LineEnding,
} from "./line-endings.js";

/** What was learned about one file the first time it was read this session. */
export interface FileEncodingState {
  /** Canonical encoding identifier, e.g. `utf8`, `utf8bom`, `gbk`, `utf16le`. */
  encoding: string;
  /** Whether the file carried a byte-order mark. */
  hasBOM: boolean;
  /** The line terminator style to restore on save. */
  lineEnding: LineEnding;
  /**
   * The `ctx.fs` version observed when this state was recorded, or `undefined`
   * when the backend reports none. A mismatch invalidates the entry.
   */
  version: string | undefined;
  /**
   * The provenance note shown with this file's reads ("auto-guessed GBK …"),
   * carried so a later read in the same session can repeat it. A guess must
   * stay visible on every read, not only the one that made it.
   */
  footer?: string | undefined;
}

/**
 * Session key used for a caller with no session (tests, previews).
 *
 * A distinct bucket rather than a shared "global" one: an agentless read must
 * not be able to satisfy a real session's read-before-write gate, nor inherit
 * an encoding another caller chose.
 */
export const ANONYMOUS_SESSION = "\u0000anonymous";

/**
 * One session's records, plus the order keys were last touched in.
 *
 * A `Map` preserves insertion order, so re-inserting on write moves a key to
 * the end and the first key is the least recently used one — enough for
 * eviction without a separate structure.
 */
interface SessionRecords {
  states: Map<string, FileEncodingState>;
}

/**
 * Upper bound on sessions tracked at once. A long-lived process sees many
 * sessions; without a bound the map would grow forever.
 */
const MAX_SESSIONS = 64;

/** Upper bound on files tracked per session. */
const MAX_FILES_PER_SESSION = 4096;

const sessions = new Map<string, SessionRecords>();

/**
 * Resolve the bucket for a session id.
 *
 * @param sessionId - the calling session's id, or `undefined` for an agentless caller.
 * @returns the bucket key.
 */
export function sessionKeyOf(sessionId: string | undefined): string {
  return sessionId === undefined || sessionId.length === 0 ? ANONYMOUS_SESSION : sessionId;
}

function bucketFor(sessionKey: string, create: boolean): SessionRecords | undefined {
  let bucket = sessions.get(sessionKey);
  if (bucket === undefined) {
    if (!create) return undefined;
    bucket = { states: new Map() };
  } else {
    // Re-insert so this session counts as most recently used.
    sessions.delete(sessionKey);
  }
  sessions.set(sessionKey, bucket);
  evictSessions();
  return bucket;
}

/** Drop the least recently used sessions once the bound is exceeded. */
function evictSessions(): void {
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next();
    if (oldest.done === true) return;
    sessions.delete(oldest.value);
  }
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_FILES_PER_SESSION) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}

/**
 * Read the state one session recorded for a file.
 *
 * @param sessionKey - the bucket key from {@link sessionKeyOf}.
 * @param targetKey - the canonical target key.
 * @returns the recorded state, or `undefined`.
 */
export function getEncodingState(
  sessionKey: string,
  targetKey: string,
): FileEncodingState | undefined {
  return sessions.get(sessionKey)?.states.get(targetKey);
}

/** Record a state for one session and file. */
export function setEncodingState(
  sessionKey: string,
  targetKey: string,
  state: FileEncodingState,
): void {
  const bucket = bucketFor(sessionKey, true);
  if (bucket !== undefined) remember(bucket.states, targetKey, state);
}

/**
 * Drop one session's record for a file, all of one session's records, or
 * everything.
 *
 * @param sessionKey - the session to clear; omit to clear every session.
 * @param targetKey - the file to clear; omit to clear the whole session.
 */
export function clearEncodingState(sessionKey?: string, targetKey?: string): void {
  if (sessionKey === undefined) {
    sessions.clear();
    return;
  }
  if (targetKey === undefined) {
    sessions.delete(sessionKey);
    return;
  }
  sessions.get(sessionKey)?.states.delete(targetKey);
}

/**
 * Release every record a session owns.
 *
 * Called when a session ends. Without it a long-lived process accumulates one
 * bucket per session that ever ran.
 *
 * @param sessionId - the session that ended.
 */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionKeyOf(sessionId));
}

/**
 * Drop a recorded state when the file's version no longer matches.
 *
 * This is the guard that keeps a stale encoding from authorizing a write: the
 * caller stats the file, passes the current version, and any record taken at a
 * different version is discarded before it can be inverted.
 *
 * @param sessionKey - the bucket key from {@link sessionKeyOf}.
 * @param targetKey - canonical target key.
 * @param currentVersion - the version just observed, or `undefined` when absent.
 */
export function invalidateIfStale(
  sessionKey: string,
  targetKey: string,
  currentVersion: string | undefined,
): void {
  const states = sessions.get(sessionKey)?.states;
  if (states === undefined) return;
  const state = states.get(targetKey);
  if (state !== undefined && state.version !== currentVersion) states.delete(targetKey);
}

/** Number of sessions currently tracked. Test seam. */
export function sessionCount(): number {
  return sessions.size;
}

/** Total number of recorded file states across every session. Test seam. */
export function encodingStateCount(): number {
  let total = 0;
  for (const bucket of sessions.values()) total += bucket.states.size;
  return total;
}

/** The outcome of admitting a byte buffer for reading. */
export interface DecodeForOpenResult {
  /** The decoded text, with any BOM already removed. */
  text: string;
  /** Canonical encoding identifier that produced {@link text}. */
  encoding: string;
  /** Whether the bytes carried a BOM. */
  hasBOM: boolean;
  /** Line terminator style detected in the decoded text. */
  lineEnding: LineEnding;
  /** An out-of-band note for the model (auto-guess provenance), never file content. */
  footer?: string;
  /** Scored candidates, populated on the guessing paths. */
  candidates: CandidatePreview[];
}

/** Inputs that decide how permissive admission may be. */
export interface DecodeAdmissionConfig {
  /** Whether a non-UTF-8 file may be decoded by guessing. */
  autoGuessEncoding: boolean;
  /** Encodings considered when guessing. */
  supportedEncodings: readonly string[];
}

/** Per-call admission options. */
export interface DecodeForOpenOptions {
  /** An explicit encoding ("Reopen with Encoding"); bypasses guessing entirely. */
  encodingHint?: string;
  /** Path as the model wrote it, used in error messages. */
  displayPath?: string;
}

/** A decode failure the caller must surface verbatim. */
export class DecodeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DecodeError";
  }
}

function bomBytesFor(encoding: string): Uint8Array | undefined {
  if (encoding === "utf8bom") return UTF8_BOM_BYTES;
  if (encoding === "utf16le") return Uint8Array.from([0xff, 0xfe]);
  if (encoding === "utf16be") return Uint8Array.from([0xfe, 0xff]);
  if (encoding === "utf32le") return Uint8Array.from([0xff, 0xfe, 0x00, 0x00]);
  if (encoding === "utf32be") return Uint8Array.from([0x00, 0x00, 0xfe, 0xff]);
  return undefined;
}

function buildTop3Message(displayPath: string, candidates: readonly CandidatePreview[]): string {
  const list = candidates
    .map((c) => `${c.encoding}("${c.sample.slice(0, 20).replace(/"/g, "'")}")`)
    .join(", ");
  const first = candidates[0];
  const actionable =
    first === undefined
      ? "No candidate encoding decoded cleanly. This may be a binary file."
      : `Most likely ${first.encoding}. Re-read with read({ encoding: "${first.encoding}" }) to decode it, or set autoGuessEncoding: true in the plugin config to decode automatically.`;
  return `[E_NOT_TEXT] ${displayPath} is not valid UTF-8. ${actionable} Candidates: ${list}`;
}

function buildGuessFooter(candidates: readonly CandidatePreview[]): string | undefined {
  const top = candidates[0];
  if (top === undefined) return undefined;
  const list = candidates.map((c) => `${c.encoding} ${c.score.toFixed(0)}`).join(", ");
  return `\n\n[Auto-guessed: ${top.encoding} ${top.score.toFixed(0)} — candidates: ${list}. Re-read with read({ encoding }) if the text looks garbled.]`;
}

/**
 * Admit a raw byte buffer and decide how to decode it.
 *
 * The order is fixed and must not be reordered: an explicit hint always wins
 * (the caller has already chosen), then a BOM is authoritative, then strict
 * UTF-8, and only then — gated by config — probabilistic guessing.
 *
 * Pure: no IO and no memo writes. The caller records the result via
 * {@link recordOpenState} once it knows the target key and version.
 *
 * @param bytes - the whole file's bytes.
 * @param config - how permissive admission may be.
 * @param opts - per-call options (explicit hint, display path).
 * @returns the decoded text and the state to remember.
 * @throws {DecodeError} when nothing decodes the bytes.
 */
export async function decodeForOpen(
  bytes: Uint8Array,
  config: DecodeAdmissionConfig,
  opts: DecodeForOpenOptions = {},
): Promise<DecodeForOpenResult> {
  const display = opts.displayPath ?? "(unknown path)";

  // 1) Explicit hint — the caller already chose, so nothing is guessed.
  if (opts.encodingHint !== undefined) {
    const hint = normalizeEncoding(opts.encodingHint);
    if (hint === undefined) {
      throw new DecodeError(
        `[E_BAD_ENCODING] Unknown encoding: ${opts.encodingHint}. Supported: utf8, utf8bom, utf16le, utf16be, utf32le, utf32be, gbk, big5, shift_jis, euc-kr, windows-1251, iso-8859-1`,
        "E_BAD_ENCODING",
      );
    }
    const bom = detectBom(bytes);
    // The BOM (when present) is stripped for the text, but its presence is kept
    // in the state so a save can put it back.
    const body = bom === undefined ? bytes : bytes.subarray(bom.bomLen);
    const decoded = decodeBytes(body, hint);
    if (decoded === undefined) {
      throw new DecodeError(
        `[E_DECODE_FAILED] ${display} cannot be decoded as ${hint}. Check the encoding name, or read without an encoding to see candidates.`,
        "E_DECODE_FAILED",
      );
    }
    if (decoded.includes(REPLACEMENT_CHAR)) {
      throw new DecodeError(
        `[E_DECODE_FAILED] ${display} decoded as ${hint} contains replacement characters — the encoding is probably wrong. Re-read without an encoding to see candidates.`,
        "E_DECODE_FAILED",
      );
    }
    return {
      text: decoded,
      encoding: hint,
      hasBOM: bom !== undefined,
      lineEnding: detectEnding(decoded),
      candidates: [],
    };
  }

  // 2) BOM — authoritative, and it precedes the UTF-8 check because a UTF-8 BOM
  //    is itself valid UTF-8 and must be recorded rather than silently dropped.
  const bom = detectBom(bytes);
  if (bom !== undefined) {
    const decoded = decodeBytes(bytes.subarray(bom.bomLen), bom.encoding);
    if (decoded !== undefined) {
      return {
        text: decoded,
        encoding: bom.encoding,
        hasBOM: true,
        lineEnding: detectEnding(decoded),
        candidates: [],
      };
    }
  }

  // 3) Strict UTF-8 — deterministic, and by far the common case.
  if (isValidUtf8(bytes)) {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      text: decoded,
      encoding: "utf8",
      hasBOM: false,
      lineEnding: detectEnding(decoded),
      candidates: [],
    };
  }

  // 4) Guessing — probabilistic, and therefore opt-in.
  if (config.autoGuessEncoding) {
    const viaChardet = await chardetTop3Candidates(bytes, config.supportedEncodings).catch(
      () => [],
    );
    const candidates: CandidatePreview[] =
      viaChardet.length > 0
        ? viaChardet.map((c) => ({ encoding: c.encoding, sample: c.sample, score: c.confidence }))
        : top3Candidates(bytes, config.supportedEncodings);
    const best = candidates[0];
    if (best !== undefined) {
      const decoded = decodeBytes(bytes, best.encoding);
      if (decoded !== undefined && !decoded.includes(REPLACEMENT_CHAR)) {
        const footer = buildGuessFooter(candidates);
        return {
          text: decoded,
          encoding: best.encoding,
          hasBOM: false,
          lineEnding: detectEnding(decoded),
          ...(footer === undefined ? {} : { footer }),
          candidates,
        };
      }
    }
    // No candidate decoded cleanly — fall through to the loud failure below.
  }

  // 5) Nothing worked: fail loud with candidates, always, even when guessing is off.
  let candidates: CandidatePreview[] = [];
  try {
    const viaChardet = await chardetTop3Candidates(bytes, config.supportedEncodings);
    candidates =
      viaChardet.length > 0
        ? viaChardet.map((c) => ({ encoding: c.encoding, sample: c.sample, score: c.confidence }))
        : top3Candidates(bytes, config.supportedEncodings);
  } catch {
    candidates = top3Candidates(bytes, config.supportedEncodings);
  }
  throw new DecodeError(buildTop3Message(display, candidates), "E_NOT_TEXT");
}

/**
 * Record what a read learned about a file, for one session.
 *
 * @param sessionKey - the bucket key from {@link sessionKeyOf}.
 * @param targetKey - the resolved target's canonical key.
 * @param decoded - the admission result.
 * @param version - the version observed at read time, used for later invalidation.
 * @returns the recorded state.
 */
export function recordOpenState(
  sessionKey: string,
  targetKey: string,
  decoded: DecodeForOpenResult,
  version: string | undefined,
): FileEncodingState {
  const state: FileEncodingState = {
    encoding: decoded.encoding,
    hasBOM: decoded.hasBOM,
    lineEnding: decoded.lineEnding,
    version,
    ...(decoded.footer === undefined ? {} : { footer: decoded.footer }),
  };
  setEncodingState(sessionKey, targetKey, state);
  return state;
}

/** A character that the target encoding cannot represent. */
export interface UnmappableChar {
  /** The offending character. */
  char: string;
  /** Its Unicode code point. */
  codePoint: number;
  /** Character offset in the text being saved. */
  index: number;
}

/**
 * Locate the first character that did not survive the encode/decode round-trip.
 *
 * Comparing code UNIT by code unit would misreport an astral character: an
 * emoji is a surrogate pair in UTF-16 and collapses to a single `?` under a
 * legacy codec, so the scan would stop on a lone high surrogate. Iterating by
 * code POINT keeps the reported character the one the user actually typed.
 */
function findFirstUnmappable(text: string, roundTripped: string): UnmappableChar | undefined {
  const original = [...text];
  const result = [...roundTripped];
  const limit = Math.min(original.length, result.length);
  for (let i = 0; i < limit; i += 1) {
    if (original[i] !== result[i]) {
      const char = original[i] ?? "";
      return { char, codePoint: char.codePointAt(0) ?? 0, index: i };
    }
  }
  if (original.length > limit) {
    const char = original[limit] ?? "";
    return { char, codePoint: char.codePointAt(0) ?? 0, index: limit };
  }
  return undefined;
}

/** A save that cannot proceed without corrupting content. */
export class UnmappableError extends Error {
  constructor(
    message: string,
    readonly detail: UnmappableChar,
    readonly encoding: string,
  ) {
    super(message);
    this.name = "UnmappableError";
  }
}

/** How a save should treat the recorded encoding. */
export interface EncodeForSaveOptions {
  /** Rewrite a legacy file as UTF-8 instead of preserving its encoding. */
  normalizeToUtf8?: boolean;
}

/**
 * Turn edited text back into the bytes that should be written.
 *
 * This is the inverse of {@link decodeForOpen} and the one place where an
 * encoding round-trip can silently corrupt a file. Three rules keep it honest:
 *
 * - **Preserve by default.** With a recorded legacy encoding and
 *   `normalizeToUtf8: false`, the text is re-encoded in that encoding, so an
 *   edit changes only the edited characters.
 * - **Verify the round-trip.** `iconv-lite` substitutes `?` for characters the
 *   target encoding cannot represent. That substitution is detected by decoding
 *   the result and comparing, and it fails the save rather than writing a file
 *   whose content no longer matches what the model asked for.
 * - **Only add a BOM, never invent one.** A BOM is restored exactly when the
 *   file had one; a new file never gains one.
 *
 * @param content - the edited text, as returned by the tools (BOM-free).
 * @param state - the recorded state, or `undefined` for a file never read.
 * @param opts - save policy (migration toggle).
 * @returns the bytes to publish, plus the encoding they were actually written
 *   in — which differs from the recorded one when migration converted a legacy
 *   file to UTF-8. The caller must record THIS encoding, or the session's next
 *   read would decode the migrated bytes under the old one.
 * @throws {UnmappableError} when the target encoding cannot represent the content.
 */
export function encodeForSave(
  content: string,
  state: FileEncodingState | undefined,
  opts: EncodeForSaveOptions = {},
): { bytes: Uint8Array; encoding: string; hasBOM: boolean } {
  const encoding = state?.encoding ?? "utf8";

  // Line endings are restored first: they are pure ASCII and cannot introduce
  // an unmappable character, so doing it here keeps the verification below
  // focused on the user's actual edit.
  const withEndings =
    state?.lineEnding === undefined ? content : restoreEndings(toLF(content), state.lineEnding);

  // Migration: a legacy file becomes UTF-8, and a BOM is preserved only if it
  // was a UTF-8 BOM to begin with (a UTF-16 BOM makes no sense on UTF-8 bytes).
  const migrated = opts.normalizeToUtf8 === true && isLegacy(encoding);
  const effective = migrated ? "utf8" : encoding;

  // A UTF-8 BOM is a *character* (U+FEFF) that the UTF-8 codec encodes into the
  // EF BB BF prefix, so it is handled by prepending it to the text. The UTF-16
  // and UTF-32 codecs do NOT emit their BOM from the text form, so their BOM is
  // prepended as bytes below. A migrated file carries no BOM: it was not UTF-8
  // before, so there is no UTF-8 BOM to preserve.
  const target = effective === "utf8bom" ? "utf8" : effective;
  const keepsBom = state?.hasBOM === true && !migrated;
  const textWithBom = keepsBom && effective === "utf8bom" ? `\uFEFF${withEndings}` : withEndings;

  const encoded = encodeText(textWithBom, target);
  if (encoded === undefined) {
    throw new DecodeError(
      `[E_BAD_ENCODING] Cannot encode as ${effective}. The recorded encoding is unsupported.`,
      "E_BAD_ENCODING",
    );
  }

  // Verify only for genuinely lossy codecs. UTF-8/UTF-16/UTF-32 represent every
  // code point, so the comparison would always pass and only costs time.
  if (isLossy(target)) {
    const roundTripped = decodeBytes(encoded, target);
    if (roundTripped !== undefined && roundTripped !== textWithBom) {
      const detail = findFirstUnmappable(textWithBom, roundTripped);
      if (detail !== undefined) {
        const hex = detail.codePoint.toString(16).toUpperCase().padStart(4, "0");
        throw new UnmappableError(
          `[E_UNMAPPABLE] ${describeChar(detail.char)} (U+${hex}) cannot be represented in ${target}. ` +
            `The write was refused and the file is unchanged. ` +
            `Either remove that character, or set normalizeToUtf8: true in the plugin config to migrate this file to UTF-8.`,
          detail,
          target,
        );
      }
    }
  }

  // UTF-16/UTF-32 BOMs are byte prefixes the codecs do not produce themselves.
  const byteBom = keepsBom && effective !== "utf8bom" ? bomBytesFor(effective) : undefined;
  const bytes =
    byteBom === undefined
      ? encoded
      : (() => {
          const out = new Uint8Array(byteBom.length + encoded.length);
          out.set(byteBom, 0);
          out.set(encoded, byteBom.length);
          return out;
        })();

  return { bytes, encoding: effective, hasBOM: keepsBom && bomBytesFor(effective) !== undefined };
}

/** Encodings that cannot represent every Unicode code point. */
function isLossy(encoding: string): boolean {
  return !(
    encoding === "utf8" ||
    encoding === "utf16le" ||
    encoding === "utf16be" ||
    encoding === "utf32le" ||
    encoding === "utf32be"
  );
}

/** Whether this is a non-Unicode legacy encoding subject to migration. */
function isLegacy(encoding: string): boolean {
  return !(
    encoding === "utf8" ||
    encoding === "utf8bom" ||
    encoding === "utf16le" ||
    encoding === "utf16be" ||
    encoding === "utf32le" ||
    encoding === "utf32be"
  );
}

function describeChar(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20) return `control character 0x${code.toString(16).padStart(2, "0")}`;
  return `"${char}"`;
}

/** Test seam: drop every session's recorded state. */
export function resetEncodingState(): void {
  sessions.clear();
}
