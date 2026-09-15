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

/**
 * Encodings `autoGuessEncoding` may consider when the config does not say otherwise.
 *
 * `windows-1252` belongs here even though the other Windows ANSI pages do not:
 * it is what Windows writes for Western text, and it used to be reachable by
 * accident because `cp1252` was aliased onto `iso-8859-1`. Splitting the two
 * apart without listing it would have taken cp1252 files from "decoded as the
 * right family, lossily" to "guessed as Cyrillic". The remaining pages stay
 * opt-in through `supportedEncodings`, keeping the guess set small and the
 * false-positive rate low.
 */
export const DEFAULT_SUPPORTED_ENCODINGS = [
  "gbk",
  "big5",
  "shift_jis",
  "euc-kr",
  "windows-1251",
  "windows-1252",
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
  // cp1252 is NOT iso-8859-1: they differ across 0x80-0x9F, where cp1252 holds
  // the curly quotes, dashes, ellipsis and euro sign that Windows text uses
  // constantly and iso-8859-1 maps to C1 control characters. Treating them as
  // aliases silently dropped every such character.
  windows1252: "windows-1252",
  cp1252: "windows-1252",
  // The rest of the Windows ANSI family, one code page per script. Each was
  // verified to round-trip its own language's full character set through
  // iconv-lite; see the note on windows-1258 below for the one that did not.
  windows1250: "windows-1250",
  cp1250: "windows-1250",
  windows1253: "windows-1253",
  cp1253: "windows-1253",
  windows1254: "windows-1254",
  cp1254: "windows-1254",
  windows1255: "windows-1255",
  cp1255: "windows-1255",
  windows1256: "windows-1256",
  cp1256: "windows-1256",
  windows1257: "windows-1257",
  cp1257: "windows-1257",
  // windows-1258 (Vietnamese) is deliberately absent. Vietnamese needs
  // combining sequences — U+1EBF "ế" is one code point but two bytes in this
  // code page — and iconv-lite's single-byte table cannot split them, so 52 of
  // 67 common Vietnamese characters encode to "?" instead. Adding it would let
  // a file be read but almost never saved, which reads as a bug rather than a
  // limitation.
};

/**
 * Every canonical encoding this plugin can read and write.
 *
 * Derived from {@link ALIASES} rather than written out by hand: the two error
 * messages that advertise the supported set used to repeat a literal list, so
 * adding an encoding here and forgetting them made the plugin contradict
 * itself — it would refuse a name that its own help text recommended.
 *
 * Order is the six Unicode names above, then `ALIASES` insertion order (which
 * groups the East Asian pages, then the Windows ANSI family). It is a
 * presentation order for the error message only — nothing depends on it, and
 * no always-sent help text mirrors it.
 */
export const CANONICAL_ENCODINGS: readonly string[] = [
  ...new Set(["utf8", "utf8bom", "utf16le", "utf16be", "utf32le", "utf32be", ...Object.values(ALIASES)]),
];

/** The canonical encodings as one comma-separated string for error messages. */
export const SUPPORTED_ENCODINGS_TEXT = CANONICAL_ENCODINGS.join(", ");

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

/**
 * The script each encoding exists to carry, and how strongly its presence
 * argues for that encoding.
 *
 * One table rather than a chain of `if (enc === …)` lines, so that a new page
 * has one obvious place to be considered instead of an absent branch somewhere
 * in a condition. Encodings that carry a script NOT listed here (the Latin-1 and
 * Latin-2 pages) get no bonus and are separated from each other by the
 * printable-ratio rule alone — that is the intended treatment for a Latin page,
 * whose "script" is Latin letters and therefore indistinguishable from ordinary
 * Western text.
 *
 * Missing an entry is NOT self-announcing: a page left out simply scores lower
 * than its rivals and can lose to an unrelated page. `test/encoding.test.ts`
 * therefore asserts that every non-Latin canonical encoding has an entry, so the
 * omission fails a test rather than degrading silently.
 *
 * Weights are per-character and roughly proportional to how distinctive the
 * script is: kana is far more diagnostic than Han characters, which GBK and
 * Big5 share.
 */
const SCRIPT_FAMILIES: Record<string, { pattern: RegExp; weight: number }> = {
  gbk: { pattern: /[\u4e00-\u9fff]/g, weight: 5 },
  big5: { pattern: /[\u4e00-\u9fff]/g, weight: 5 },
  shift_jis: { pattern: /[\u3040-\u309f\u30a0-\u30ff]/g, weight: 8 },
  "euc-kr": { pattern: /[\uac00-\ud7af]/g, weight: 4 },
  "windows-1251": { pattern: /[\u0400-\u04ff]/g, weight: 2 },
  "windows-1253": { pattern: /[\u0370-\u03ff]/g, weight: 4 },
  "windows-1255": { pattern: /[\u0590-\u05ff]/g, weight: 4 },
  "windows-1256": { pattern: /[\u0600-\u06ff]/g, weight: 4 },
};

/**
 * Whether a script family is registered for this encoding.
 *
 * Exposed so a test can assert that every non-Latin canonical encoding has an
 * entry — a missing one scores lower than its rivals and loses silently, which
 * no round-trip test would catch.
 *
 * @param encoding - canonical encoding identifier.
 */
export function hasScriptFamily(encoding: string): boolean {
  return SCRIPT_FAMILIES[encoding] !== undefined;
}

/** One scored encoding guess with a short human-readable sample. */
export interface CandidatePreview {
  /** Canonical encoding identifier. */
  encoding: string;
  /** Up to 50 characters around the first non-ASCII byte, whitespace-collapsed. */
  sample: string;
  /** Higher is more plausible; `-1000` marks a decode that produced U+FFFD. */
  score: number;
}

/**
 * Share of characters that could plausibly appear in text.
 *
 * C1 controls (U+0080–U+009F) deliberately do NOT count as printable. They are
 * what `iso-8859-1` and `windows-1251` produce for the bytes 0x80–0x9F, where
 * `windows-1252` produces the curly quotes, dashes, ellipsis and euro sign that
 * Western text actually uses. Counting them as printable made every mis-decode
 * score as well as the correct one, so a cp1252 file was never recognised.
 */
function printableRatio(text: string): number {
  if (text.length === 0) return 1;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10 || code === 13 || code === 9) printable += 1;
    else if (code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f)) printable += 1;
  }
  return printable / text.length;
}

/**
 * Reward a decode that produced characters the candidate encoding's language
 * actually uses. This is what separates GBK from Big5 on Chinese text, and
 * Shift-JIS from EUC-KR on kana/hangul.
 *
 * The bonus is proportional to the COUNT of characters from the candidate's own
 * script, deliberately not to their share of the text. A share-based rule was
 * tried and reverted: it punishes exactly the files this plugin exists for — a
 * source file that is mostly ASCII with a few localized comments has its own
 * script as a small minority, so a share rule strips the correct candidate's
 * bonus and lets a wrong single-byte page (which decodes any bytes to printable
 * Latin) win. Count-based scoring keeps "a few characters of my script are here"
 * as positive evidence, which is the right signal for code with localized text.
 *
 * A trace of a script is deliberately NOT treated as evidence against a
 * candidate. Discounting a mixed decode was tried and also reverted: it fixed
 * nothing for Western text (where the real problem is that `windows-1251` maps
 * the same bytes to Cyrillic) while breaking Chinese files that carry only a
 * couple of localized lines.
 *
 * KNOWN LIMITATION: that asymmetric case is therefore NOT mitigated anywhere. A
 * single-byte page that turns a few accented Latin letters into its own script
 * collects this bonus and can outrank the correct page; {@link chardetTop3Candidates}
 * keeps chardet's ordering and applies no such guard. Fixing it needs a better
 * Cyrillic-vs-Latin discriminator than a character count — attempts based on
 * share and on Latin-coexistence were both measured and both made more files
 * wrong than right.
 */
function scriptBonus(text: string, enc: string): number {
  const family = SCRIPT_FAMILIES[enc];
  if (family === undefined) return 0;
  return (text.match(family.pattern) ?? []).length * family.weight;
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

/** Every byte value, used to probe an encoding's whole input space. */
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, b) => b);

/** Memo for {@link unassignedBytes}; the probe decodes 256 bytes per call. */
const UNASSIGNED_CACHE = new Map<string, readonly number[]>();

/**
 * The byte values a single-byte page leaves unassigned, empty for anything else.
 *
 * A single-byte code page decodes each byte independently and maps exactly 256
 * inputs to 256 outputs, so probing all of them yields 256 characters; a
 * multi-byte or Unicode encoding yields fewer. That is how the pages are told
 * apart here, without a hand-written list.
 *
 * This exists to EXPLAIN a decode failure, never to permit one. `windows-1252`
 * leaves five bytes unassigned (0x81, 0x8D, 0x8F, 0x90, 0x9D), so a real
 * windows-1252 file carrying one produces U+FFFD through no fault of the file —
 * and the generic "the encoding is probably wrong" sends the user to a candidate
 * that mangles the rest of the text. Naming the byte is the useful part.
 *
 * Using the same knowledge to ACCEPT such a decode is what an earlier revision
 * tried, and it corrupted files: a wrong page can hit an unassigned byte too,
 * and the decoded text cannot tell the two cases apart. See
 * {@link isAcceptableDecode}.
 *
 * @param enc - canonical encoding identifier.
 * @returns the unassigned byte values, ascending; empty when none apply.
 */
export function unassignedBytes(enc: string): readonly number[] {
  const memo = UNASSIGNED_CACHE.get(enc);
  if (memo !== undefined) return memo;
  const all = decodeBytes(ALL_BYTES, enc);
  // Spread, not index: a code point outside the BMP is one entry here but two
  // UTF-16 units in the string, so indexing would drift out of step with `b`.
  const chars = all === undefined ? [] : [...all];
  const out: number[] = [];
  if (chars.length === 256) {
    for (let b = 0; b < 256; b++) {
      if (chars[b] === REPLACEMENT_CHAR) out.push(b);
    }
  }
  const frozen = Object.freeze(out);
  UNASSIGNED_CACHE.set(enc, frozen);
  return frozen;
}

/**
 * Whether a decode may be used as the file's encoding.
 *
 * U+FFFD is disqualifying, full stop — deliberately stricter than it may look,
 * and the strictness is load-bearing.
 *
 * An earlier revision relaxed this to "accept when the page leaves some byte
 * unassigned", reasoning that such a page cannot avoid producing U+FFFD for its
 * own gaps. That reasoning is sound about the page and wrong about the file: a
 * WRONG page can hit an unassigned byte too. A short Shift-JIS file
 * (`83 52 83 81 83 93 83 67`) contains 0x81, which windows-1252 leaves
 * unassigned — so the relaxed rule accepted windows-1252, `chardet`'s top
 * verdict, and a save then rewrote 0x81 as 0x9D.
 *
 * The round-trip guard did not catch it because the guard compares TEXT, and the
 * text is exactly what stays stable here: 0x81 decodes to U+FFFD, and U+FFFD
 * re-encodes to 0x9D — another byte windows-1252 leaves unassigned — which
 * decodes back to U+FFFD. So the decoded string is a fixed point while the bytes
 * underneath it are not, and a file the user never edited came back changed.
 *
 * The decoded text alone cannot separate "right page, unassigned byte" from
 * "wrong page, unassigned byte", so no counting or per-byte attribution rule can
 * rescue the relaxed form. The unassigned-byte knowledge is still used — to
 * explain the failure (see `firstUnassignedByte`), never to permit it.
 *
 * The rule therefore takes no encoding argument. It once did, and the parameter
 * was what made the relaxed form look principled: a call site reading
 * `isAcceptableDecode(text, enc)` invites the belief that acceptability is a
 * property of the pairing, when it is a property of the text alone. A future
 * rule that genuinely needs the encoding should add the parameter back — the
 * compiler then flags every call site, which is safer than a silently ignored
 * argument.
 *
 * @param text - the decode result.
 * @returns whether the decode may become the file's recorded encoding.
 */
export function isAcceptableDecode(text: string): boolean {
  return !text.includes(REPLACEMENT_CHAR);
}

/**
 * Score one decoded text under the encoding that produced it.
 *
 * Two terms: how much of the text is printable, and how much of the candidate's
 * own script it contains. The ratio is scaled by 100 and the script bonus by 0.5,
 * so a full page of the right script (bonus in the hundreds) outweighs a couple
 * of percent of printability, while printability still separates a clean decode
 * from one that left C1 control characters behind.
 *
 * The 100 was once 10. That change was measured to be behaviour-neutral — over a
 * 55-sample corpus spanning every supported script plus random binary, both
 * scalings produced identical rankings — so it is kept only as the current
 * calibration, NOT because it fixed a tie: `scoreText` returns a float and the
 * sort compares floats, so 95% and 100% never actually collided. Treat the
 * constants as a pair to re-measure together, not as independently meaningful.
 *
 * The `-500` floor stays far below any surviving decode, so a mostly-binary
 * result still loses outright.
 *
 * @param text - the decode result.
 * @param enc - the encoding that produced it.
 * @returns a comparable score; U+FFFD is disqualifying, with no exception.
 */
export function scoreText(text: string, enc: string): number {
  if (!isAcceptableDecode(text)) return -1000;
  const ratio = printableRatio(text);
  if (ratio < 0.85) return -500 + ratio * 100;
  return ratio * 100 + scriptBonus(text, enc) * 0.5;
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
      if (text === undefined || !isAcceptableDecode(text)) continue;
      out.push({ encoding: norm, confidence: r.confidence, sample: smartSlice(text) });
      if (out.length >= 3) break;
    }
    // chardet's own ordering is kept.
    //
    // Two attempts to override it were measured and both made things worse. The
    // first promoted the heuristic whenever any multi-byte candidate existed, but
    // chardet emits a floor-confidence (10) entry for every page it considers, so
    // that fired on files it had already identified correctly: 9/14 correct
    // before, 5/14 after. The second promoted a script-bearing candidate over a
    // single-byte page that produced no script characters — which fixed the long
    // cp1252 case but handed short katakana files to gbk instead of shift_jis and
    // broke plain Latin-1 text: 14/18 before, 11/18 after.
    //
    // The remaining weakness is documented rather than patched: a short katakana
    // file can lose to windows-1252 because that page renders the bytes as
    // printable filler and chardet rates it highly. Fixing it needs a real
    // language model of the byte ranges, not another reordering rule.
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
