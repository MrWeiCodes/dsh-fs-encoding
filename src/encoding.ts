/**
 * Encoding primitives — the pure, IO-free half of the VS Code encoding model.
 *
 * Deterministic-first: BOM sniff, then strict UTF-8, then (only when the config
 * opts in) probabilistic scoring over an allowlist. Nothing here touches the
 * filesystem or the harness; callers own admission order and side effects.
 *
 * @module dsh-fs-encoding/encoding
 */

import iconv from "iconv-lite";

/** Encodings `autoGuessEncoding` may consider when the config does not say otherwise. */
export const DEFAULT_SUPPORTED_ENCODINGS = [
  "gbk",
  "big5",
  "shift_jis",
  "euc-kr",
  "windows-1251",
  "iso-8859-1",
] as const;

/**
 * Alias table — every spelling a model or a human might plausibly write, mapped
 * onto one canonical identifier. Keys are normalized (lowercased, `-`/`_`
 * stripped) by {@link normalizeEncoding}, so only that form is listed here.
 */
const ALIASES: Record<string, string> = {
  utf8: "utf8",
  utf8bom: "utf8bom",
  utf16: "utf16le",
  utf16le: "utf16le",
  utf16be: "utf16be",
  utf32: "utf32le",
  utf32le: "utf32le",
  utf32be: "utf32be",
  gbk: "gbk",
  gb18030: "gbk",
  gb2312: "gbk",
  cp936: "gbk",
  big5: "big5",
  cp950: "big5",
  shiftjis: "shift_jis",
  sjis: "shift_jis",
  cp932: "shift_jis",
  euckr: "euc-kr",
  cp949: "euc-kr",
  windows1251: "windows-1251",
  cp1251: "windows-1251",
  iso88591: "iso-8859-1",
  latin1: "iso-8859-1",
  cp1252: "iso-8859-1",
};

/**
 * Canonicalize a user/model supplied encoding name.
 *
 * Case-insensitive and punctuation-insensitive: `Shift-JIS`, `shift_jis` and
 * `SJIS` all resolve to `shift_jis`.
 *
 * @param input - the raw encoding name.
 * @returns the canonical identifier, or `undefined` when unrecognized.
 */
export function normalizeEncoding(input: string): string | undefined {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  const key = trimmed.replace(/[-_\s]/g, "");
  return ALIASES[key];
}

/** Whether {@link normalizeEncoding} recognizes this name. */
export function isSupportedEncoding(enc: string): boolean {
  return normalizeEncoding(enc) !== undefined;
}

/** A BOM signature and the encoding it implies. */
export interface BomInfo {
  /** Canonical encoding the BOM declares. */
  encoding: string;
  /** BOM length in bytes. */
  bomLen: number;
}

/**
 * Sniff a leading byte-order mark.
 *
 * Order matters: the UTF-32LE BOM starts with the UTF-16LE BOM, and UTF-32BE
 * with a prefix that no shorter BOM matches, so the 4-byte checks must run
 * before the 2-byte ones.
 *
 * @param bytes - the file's leading bytes (the whole file is fine).
 * @returns the BOM, or `undefined` when the content starts with no BOM.
 */
export function detectBom(bytes: Uint8Array): BomInfo | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf8bom", bomLen: 3 };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return { encoding: "utf32le", bomLen: 4 };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0xfe &&
    bytes[3] === 0xff
  ) {
    return { encoding: "utf32be", bomLen: 4 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf16le", bomLen: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: "utf16be", bomLen: 2 };
  }
  return undefined;
}

/**
 * Strict UTF-8 validity — a `fatal` decoder, so malformed sequences are
 * rejected rather than replaced with U+FFFD.
 *
 * @param bytes - candidate bytes.
 * @returns whether the bytes are exactly one valid UTF-8 sequence.
 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** U+FFFD, the replacement character a permissive decode leaves behind. */
export const REPLACEMENT_CHAR = "\uFFFD";

/** One scored encoding guess with a short human-readable sample. */
export interface CandidatePreview {
  /** Canonical encoding identifier. */
  encoding: string;
  /** Up to 50 characters around the first non-ASCII byte, whitespace-collapsed. */
  sample: string;
  /** Higher is more plausible; `-1000` marks a decode that produced U+FFFD. */
  score: number;
}

function printableRatio(text: string): number {
  if (text.length === 0) return 1;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10 || code === 13 || code === 9) printable += 1;
    else if (code >= 32 && code !== 127) printable += 1;
    else if (code > 127) printable += 1;
  }
  return printable / text.length;
}

/**
 * Reward a decode that produced characters the candidate encoding's language
 * actually uses. This is what separates GBK from Big5 on Chinese text, and
 * Shift-JIS from EUC-KR on kana/hangul.
 */
function scriptBonus(text: string, enc: string): number {
  let bonus = 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const cyrillic = (text.match(/[\u0400-\u04ff]/g) ?? []).length;
  const kana = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) ?? []).length;
  if (enc === "gbk" || enc === "big5") bonus += cjk * 5;
  if (enc === "windows-1251") bonus += cyrillic * 2;
  if (enc === "shift_jis") bonus += kana * 8;
  if (enc === "euc-kr") bonus += hangul * 4;
  return bonus;
}

/** Take a 50-char window around the first non-ASCII character for previews. */
function smartSlice(text: string): string {
  let idx = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 127) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return text.slice(0, 50);
  const start = Math.max(0, idx - 32);
  return text
    .slice(start, start + 64)
    .slice(0, 50)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Score one decoded text under the encoding that produced it.
 *
 * @param text - the decode result.
 * @param enc - the encoding that produced it.
 * @returns a comparable score; U+FFFD anywhere is disqualifying.
 */
export function scoreText(text: string, enc: string): number {
  if (text.includes(REPLACEMENT_CHAR)) return -1000;
  const ratio = printableRatio(text);
  if (ratio < 0.85) return -500 + ratio * 10;
  return ratio * 10 + scriptBonus(text, enc) * 0.5;
}

/**
 * Decode bytes under one canonical encoding.
 *
 * @param bytes - the raw content, BOM already stripped when the caller handled it.
 * @param enc - canonical encoding identifier.
 * @returns the decoded text, or `undefined` when the bytes do not decode.
 */
export function decodeBytes(bytes: Uint8Array, enc: string): string | undefined {
  try {
    if (enc === "utf8" || enc === "utf8bom") {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (enc === "utf16le") return new TextDecoder("utf-16le").decode(bytes);
    if (enc === "utf16be") return new TextDecoder("utf-16be").decode(bytes);
    // Node's TextDecoder has no UTF-32 at all ("The utf-32le encoding is not
    // supported"), so the UTF-32 pair must go through iconv-lite like the
    // legacy code pages. Routing them to TextDecoder would make every UTF-32
    // file unreadable.
    if (!iconv.encodingExists(enc)) return undefined;
    return iconv.decode(Buffer.from(bytes), enc);
  } catch {
    return undefined;
  }
}

/**
 * Encode text under one canonical encoding.
 *
 * Unmappable characters become `?` here; callers that must not silently corrupt
 * content verify the round-trip (see `encodeForSave` in `encoding-state`).
 *
 * @param text - the text to encode.
 * @param enc - canonical encoding identifier.
 * @returns the encoded bytes, or `undefined` when the encoding is unknown.
 */
export function encodeText(text: string, enc: string): Uint8Array | undefined {
  try {
    if (enc === "utf8" || enc === "utf8bom") return new TextEncoder().encode(text);
    if (enc === "utf16le") return new Uint8Array(Buffer.from(text, "utf16le"));
    if (enc === "utf16be") return new Uint8Array(iconv.encode(text, "utf16be"));
    if (enc === "utf32le") return new Uint8Array(iconv.encode(text, "utf32le"));
    if (enc === "utf32be") return new Uint8Array(iconv.encode(text, "utf32be"));
    if (!iconv.encodingExists(enc)) return undefined;
    return new Uint8Array(iconv.encode(text, enc));
  } catch {
    return undefined;
  }
}

/**
 * Score every allowlisted encoding and return the best three.
 *
 * @param bytes - the raw content.
 * @param allowlist - candidate encodings, normalized here.
 * @returns up to three candidates, best first.
 */
export function top3Candidates(bytes: Uint8Array, allowlist: readonly string[]): CandidatePreview[] {
  const candidates: CandidatePreview[] = [];
  for (const raw of allowlist) {
    const enc = normalizeEncoding(raw) ?? raw;
    const text = decodeBytes(bytes, enc);
    if (text === undefined) continue;
    candidates.push({ encoding: enc, sample: smartSlice(text), score: scoreText(text, enc) });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3);
}

/**
 * Ask the optional `chardet` dependency for candidates, filtered by the
 * allowlist and re-verified by a U+FFFD-free decode.
 *
 * A missing or failing `chardet` is not an error — the caller falls back to
 * {@link top3Candidates}.
 *
 * @param bytes - the raw content.
 * @param allowlist - candidate encodings the deployment permits.
 * @returns candidates with `chardet` confidences, or an empty array.
 */
export async function chardetTop3Candidates(
  bytes: Uint8Array,
  allowlist: readonly string[],
): Promise<Array<{ encoding: string; confidence: number; sample: string }>> {
  try {
    const mod: unknown = await import("chardet");
    const like = (mod as Record<string, unknown>)["default"] ?? mod;
    const analyse = (
      like as { analyse?: (b: Uint8Array | Buffer) => Array<{ name: string; confidence: number }> }
    ).analyse;
    if (typeof analyse !== "function") return [];

    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const results = analyse(buf) as Array<{ name: string; confidence: number }>;
    if (!Array.isArray(results) || results.length === 0) return [];

    const allowed = new Set(allowlist.map((a) => normalizeEncoding(a) ?? a.toLowerCase()));
    const out: Array<{ encoding: string; confidence: number; sample: string }> = [];
    for (const r of results) {
      if (typeof r.name !== "string" || typeof r.confidence !== "number") continue;
      const norm = normalizeEncoding(r.name);
      if (!norm || !allowed.has(norm)) continue;
      if (!iconv.encodingExists(norm) && !iconv.encodingExists(r.name)) continue;
      const text = decodeBytes(bytes, norm);
      if (text === undefined || text.includes(REPLACEMENT_CHAR)) continue;
      out.push({ encoding: norm, confidence: r.confidence, sample: smartSlice(text) });
      if (out.length >= 3) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Candidate list for an error message: `chardet` when it has an opinion,
 * otherwise the heuristic scoring.
 *
 * @param bytes - the raw content.
 * @param allowlist - candidate encodings the deployment permits.
 * @returns up to three candidates, best first.
 */
export async function getTop3Candidates(
  bytes: Uint8Array,
  allowlist: readonly string[],
): Promise<CandidatePreview[]> {
  const viaChardet = await chardetTop3Candidates(bytes, allowlist);
  if (viaChardet.length > 0) {
    return viaChardet.map((c) => ({ encoding: c.encoding, sample: c.sample, score: c.confidence }));
  }
  return top3Candidates(bytes, allowlist);
}
