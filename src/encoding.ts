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
 * One `chardet` verdict that the allowlist and the U+FFFD-free decode both
 * accepted.
 *
 * Structurally a {@link CandidatePreview} plus the verdict's name, which is what
 * lets {@link isFloorVerdict} name the page instead of trusting the
 * confidence number alone — see {@link CHARDET_FLOOR_FAMILIES}.
 *
 * Not exported: it is the return shape of {@link chardetTop3Candidates} for
 * callers inside this module, and nothing outside needs to name it.
 */
interface ChardetVerdict {
  /** Canonical encoding identifier, e.g. `gbk`. */
  encoding: string;
  /** The encoding name `chardet` itself reported, e.g. `GB18030`. */
  chardetName: string;
  /** `chardet`'s confidence in this page. */
  confidence: number;
  /** Up to 50 characters around the first non-ASCII byte, whitespace-collapsed. */
  sample: string;
}

/**
 * What one `chardet` analysis yielded: the verdicts this deployment can use, and
 * the names it reported that the allowlist does not cover.
 *
 * The rejected names are not dead weight. A verdict whose page is outside the
 * allowlist is unusable as an ENCODING, but its name still says which script
 * chardet believed the bytes were, and that survives the filter. Throwing it
 * away is what made {@link rankCandidates}'s `heuristic-only` branch dangerous:
 * measured over 330 samples, chardet was present and analysed successfully in
 * all 40 cases that reached that branch — never once absent — and in 19 of them
 * it had named a Latin page while the heuristic picked `windows-1251` instead.
 * All 19 were Latin files, and the Latin candidate was correct in every one.
 * See {@link CHARDET_LATIN_PAGES}.
 */
interface ChardetAnalysis {
  /** Verdicts the allowlist and the U+FFFD-free decode both accepted. */
  accepted: ChardetVerdict[];
  /** Names `chardet` reported that the allowlist does not cover, verbatim. */
  outsideAllowlist: ReadonlySet<string>;
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
 * @returns the accepted verdicts plus the names the allowlist rejected.
 */
async function chardetAnalysis(
  bytes: Uint8Array,
  allowlist: readonly string[],
): Promise<ChardetAnalysis> {
  const none: ChardetAnalysis = { accepted: [], outsideAllowlist: new Set() };
  try {
    const mod: unknown = await import("chardet");
    const like = (mod as Record<string, unknown>)["default"] ?? mod;
    const analyse = (
      like as { analyse?: (b: Uint8Array | Buffer) => Array<{ name: string; confidence: number }> }
    ).analyse;
    if (typeof analyse !== "function") return none;

    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const results = analyse(buf) as Array<{ name: string; confidence: number }>;
    if (!Array.isArray(results) || results.length === 0) return none;

    const allowed = new Set(allowlist.map((a) => normalizeEncoding(a) ?? a.toLowerCase()));
    const accepted: ChardetVerdict[] = [];
    const outsideAllowlist = new Set<string>();
    for (const r of results) {
      if (typeof r.name !== "string" || typeof r.confidence !== "number") continue;
      const norm = normalizeEncoding(r.name);
      if (!norm || !allowed.has(norm)) {
        // Recorded before the filter, deliberately. `r.name` is kept verbatim
        // because the name is what identifies the script; normalizing it would
        // lose the distinction between chardet's pages and this module's.
        outsideAllowlist.add(r.name);
        continue;
      }
      if (!iconv.encodingExists(norm) && !iconv.encodingExists(r.name)) continue;
      const text = decodeBytes(bytes, norm);
      if (text === undefined || !isAcceptableDecode(text)) continue;
      accepted.push({
        encoding: norm,
        chardetName: r.name,
        confidence: r.confidence,
        sample: smartSlice(text),
      });
      if (accepted.length >= 3) break;
    }
    // chardet's own ordering is kept *among verdicts that carry evidence*.
    //
    // Two attempts to override the order outright were measured and both made
    // things worse. The first promoted the heuristic whenever any multi-byte
    // candidate existed, but chardet emits a floor-confidence (10) entry for
    // every page it considers, so that fired on files it had already identified
    // correctly: 9/14 correct before, 5/14 after. The second promoted a
    // script-bearing candidate over a single-byte page that produced no script
    // characters — which fixed the long cp1252 case but handed short katakana
    // files to gbk instead of shift_jis and broke plain Latin-1 text: 14/18
    // before, 11/18 after.
    //
    // Both failures came from overriding chardet when it HAD identified the
    // file. Neither says anything about the case where it has not, which is
    // what `getTop3Candidates` now separates out via the floor test: an
    // all-floor list is not a ranking to defer to, and deferring to it lost
    // the correct encoding entirely on short GBK input. The two rules are
    // complementary — defer above the floor, score below it.
    //
    // The remaining weakness is documented rather than patched: a short katakana
    // file can lose to windows-1252 because that page renders the bytes as
    // printable filler and chardet rates it highly. Fixing it needs a real
    // language model of the byte ranges, not another reordering rule.
    return { accepted, outsideAllowlist };
  } catch {
    return none;
  }
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
): Promise<ChardetVerdict[]> {
  return (await chardetAnalysis(bytes, allowlist)).accepted;
}

/**
 * Whether `chardet` ranked any page above its multi-byte floor.
 *
 * A page above the floor is evidence: chardet matched common characters and
 * separated that page from the others, so its order is worth deferring to. When
 * every verdict sits on the floor chardet is saying it could not separate them.
 *
 * That distinction is load-bearing, and the reason is measured. The heuristic's
 * `scoreText` cannot tell the East Asian pages apart on short input: the
 * GB18030 decoder is the most permissive of the set, so it produces printable
 * text with a full script bonus whatever the true page is. Measured winner
 * scores per true encoding:
 *
 * | true page  | heuristic winner | winner score | correct page's score |
 * |------------|------------------|--------------|----------------------|
 * | gbk        | gbk              | 110–115      | 110–115 (rank 0)     |
 * | shift_jis  | gbk              | 108          | 100 (rank 2)         |
 * | big5       | gbk              | 110          | 110 (rank 1)         |
 * | euc-kr     | gbk              | 115          | 112 (rank 1)         |
 *
 * The winner sits in the same band whether it is correct or not, and the correct
 * page is sometimes BELOW it — so no margin over the runner-up can identify the
 * right page. Measured on `日本語の` (Shift_JIS, 8 bytes) the margin is 6.0 and
 * the winner is the wrong page; promoting it recorded `gbk` and the model saw
 * `擔杮岅偺`. The damage is silent: that mojibake re-encodes to the original bytes
 * under `gbk`, so a write-back reproduces the file byte for byte and nothing
 * downstream ever notices.
 *
 * Hence a page chardet actually ranked is never overruled BY THE HEURISTIC, and
 * the heuristic is not even consulted — see {@link rankCandidates}. That is a
 * claim about reordering, not about credibility: a ranked head can still be
 * refused outright when its own decode contradicts it
 * (see `isImplausibleSingleByteHead`), which drops it without consulting the
 * heuristic either.
 *
 * @param verdicts - `chardet`'s allowlist-filtered verdicts.
 * @returns whether any verdict was ranked above the floor.
 */
function chardetRankedAnyPage(verdicts: readonly ChardetVerdict[]): boolean {
  return verdicts.some((c) => !isFloorVerdict(c));
}

/**
 * Whether one `chardet` verdict is the multi-byte no-evidence step.
 *
 * @param verdict - a single verdict.
 * @returns whether it carries no ranking information.
 */
function isFloorVerdict(verdict: ChardetVerdict): boolean {
  return (
    verdict.confidence === CHARDET_FLOOR_CONFIDENCE &&
    CHARDET_FLOOR_FAMILIES.has(verdict.chardetName)
  );
}

/**
 * How many candidates a list carries when its order IS evidence-backed.
 *
 * This is the historical "Top-3" the error hint and the config docs refer to.
 */
const CANDIDATE_SLOTS = 3;

/**
 * How many candidates a list may carry when nothing could rank them.
 *
 * One slot wider than {@link CANDIDATE_SLOTS}. An abstention has to serve two
 * purposes at once — show what chardet named AND what the heuristic found — and
 * three slots cannot hold both: chardet fills all three with pages it could not
 * separate, so the heuristic's contribution needs a fourth. Measured over 52
 * abstention samples, the wider list keeps the correct page on 49 (94%) against
 * 44 (85%) for the three-slot merge, and it is the only width that keeps both
 * the short-GBK case (`gbk`, 15/15) and the Korean case (`euc-kr`, 13/13) — at
 * three slots one of the two is always evicted.
 */
const UNRANKED_CANDIDATE_SLOTS = 4;

/**
 * The confidence `chardet` gives a multi-byte page that matched no common
 * character at all.
 *
 * Not a tunable threshold — it is a hard-coded branch in chardet's own
 * `mbcs.match`, which every East Asian page here shares (Shift_JIS, Big5,
 * EUC-JP, EUC-KR, GB18030):
 *
 * ```js
 * if (doubleByteCharCount <= 10 && badCharCount == 0) {
 *   confidence = 10;                       // "too few double-byte chars to judge"
 * } else {
 *   confidence = Math.floor(Math.log(commonCharCount + 1) * scaleFactor + 10);
 * }
 * ```
 *
 * `commonCharCount == 0` makes the second formula `log(1) = 0`, so it also
 * yields exactly 10 — and any hit jumps it clear. Measured on GBK input, the
 * value goes 10, 10, … 10, then 100 at the eleventh hanzi, with nothing in
 * between. 10 is therefore a step, not the bottom of a continuum, which is
 * what makes it safe to test for equality.
 *
 * The other chardet families do NOT share it, and must not be swept in:
 * `sbcs` computes `Math.floor(rawPercent * 300)`, a genuinely continuous score
 * that really does land on 11…33 — but those are single-byte pages ranking
 * themselves, and treating them as "no opinion" was measured to make things
 * WORSE: four ISO-8859-1 samples that chardet had right got handed to the
 * heuristic, which guessed windows-1251. Hence {@link isFloorVerdict} also
 * requires the page to be one of {@link CHARDET_FLOOR_FAMILIES}.
 */
const CHARDET_FLOOR_CONFIDENCE = 10;

/**
 * The multi-byte recognisers that share {@link CHARDET_FLOOR_CONFIDENCE}.
 *
 * The step is a NUMBER, and `chardet`'s other families emit the same value from
 * unrelated branches, so the number alone is not enough to identify it — the
 * page has to be named too. `Utf8.match` returns 10 for a buffer with no
 * multi-byte sequence at all, and `ISO_2022`/`sbcs` can reach it as well, none
 * of which means "I found double-byte text but not a character I know".
 *
 * These names are the ones `chardet` itself emits, which is a DIFFERENT
 * namespace from this module's `ALIASES`: the alias keys are lowercased and
 * punctuation-stripped (`shiftjis`, `euckr`), so `normalizeEncoding` can never
 * produce these spellings and the two tables cannot be derived from one
 * another. They are matched against the raw `r.name` for exactly that reason,
 * and each was verified against `mbcs.js`'s `name()` return.
 *
 * Only pages this plugin can actually reach are listed. `EUC-JP` is deliberately
 * absent: `chardetTop3Candidates` drops any verdict whose name `normalizeEncoding`
 * does not recognize, and there is no `euc-jp` alias, so an EUC-JP verdict can
 * never survive to be tested here. Adding the name without the alias would be
 * dead weight that reads like a supported page; adding both is a separate change
 * with its own round-trip evidence to gather.
 */
const CHARDET_FLOOR_FAMILIES: ReadonlySet<string> = new Set([
  "Shift_JIS",
  "Big5",
  "EUC-KR",
  "GB18030",
]);

/**
 * The `chardet` names that denote a single-byte Latin page.
 *
 * Used for one purpose only: when `chardet` names a Latin page that the
 * allowlist does not cover, its script is still evidence — see
 * {@link RankedCandidates} and the `heuristic-only` branch of
 * {@link rankCandidates}. Every name below was read out of chardet's own
 * `name()` returns (`sbcs.js`), not guessed from a registry: `ISO_8859_1` and
 * `ISO_8859_2`/`7`/`8`/`9` pick between two spellings at runtime via
 * `det.c1Bytes`, so both spellings of each appear here. `windows-874` (Thai) and
 * the Cyrillic/Greek/Hebrew/Arabic pages are deliberately absent — they are not
 * Latin, and treating them as such would misattribute their script.
 */
const CHARDET_LATIN_PAGES: ReadonlySet<string> = new Set([
  "ISO-8859-1",
  "windows-1252",
  "ISO-8859-2",
  "windows-1250",
  "ISO-8859-3",
  "ISO-8859-4",
  "ISO-8859-9",
  "windows-1254",
  "ISO-8859-10",
  "ISO-8859-13",
  "ISO-8859-14",
  "ISO-8859-15",
  "ISO-8859-16",
  "windows-1257",
  "windows-1258",
  "IBM852",
  "IBM855",
  "x-mac-roman",
  "x-mac-ce",
]);

/**
 * Candidate list for an error message: `chardet` when it has an opinion,
 * otherwise the heuristic scoring.
 *
 * The two are COMBINED rather than chosen between — see {@link rankCandidates},
 * which owns the ordering rules. This wrapper exists for callers that only need
 * the list and not the evidence flag.
 *
 * @param bytes - the raw content.
 * @param allowlist - candidate encodings the deployment permits.
 * @returns up to {@link CANDIDATE_SLOTS} candidates, best first — or one more
 *   when the list is unranked, see {@link UNRANKED_CANDIDATE_SLOTS}.
 */
export async function getTop3Candidates(
  bytes: Uint8Array,
  allowlist: readonly string[],
): Promise<CandidatePreview[]> {
  return (await rankCandidates(bytes, allowlist)).candidates;
}

/**
 * The ranked candidates, whether their ORDER carries evidence, and whether the
 * head may be acted on.
 *
 * `ranked` and `basis` travel with the list because the ordering evidence is not
 * recoverable from the list itself: `score` is always one scale (see
 * `unionByScore`), so a caller cannot tell a page that chardet ranked from one
 * the heuristic merely scored.
 *
 * `ranked` and `adoptable` answer DIFFERENT questions and must not be conflated.
 * `ranked` asks "does the order mean anything?" and drives the wording and the
 * guess caveat. `adoptable` asks "may I decode with the head without asking?"
 * and is the only flag a caller may act on. Every combination except
 * `ranked: false, adoptable: true` is reachable — see each field.
 *
 * `basis` is diagnostic: it records which of the three situations produced the
 * list, so a future caller can tell "the heuristic was the only opinion
 * available" (a chardet-less install, still adopted) from "chardet looked and
 * declined".
 */
export interface RankedCandidates {
  /**
   * The candidates. When `ranked` is true they are best-first by the producer
   * that ranked them. When it is false the order is chardet's own verdict order
   * followed by the heuristic's — deterministic, and deliberately NOT the score
   * order, because `scoreText` cannot separate the East Asian pages and sorting
   * by it would put `gbk` first for every one of them (see `rankCandidates`).
   * Such a list must be shown with its samples and read as "pick one", never as
   * a ranking — which is exactly what `ranked: false` tells the caller.
   *
   * A caller must NOT infer from `ranked` that the head is safe to decode with;
   * that is {@link adoptable}. The two come apart in both directions: an
   * abstention the producers agreed on is adoptable but unranked, and a chardet
   * ranking whose head is a single-byte page the bytes contradict is ranked but
   * NOT adoptable.
   */
  candidates: CandidatePreview[];
  /**
   * Whether the order is evidence-backed. False means the head is an arbitrary
   * pick among pages nobody could rank, so it may be shown but must be
   * presented as a guess rather than a decision.
   *
   * True does not imply the head may be used — see {@link adoptable}.
   */
  ranked: boolean;
  /**
   * Whether the caller may DECODE with the head without asking first. This is
   * the flag to act on; `ranked` only governs presentation.
   *
   * Deliberately separate from `ranked`, and the two disagree in both
   * directions:
   *
   * - `ranked: true, adoptable: true` — a genuine chardet ranking, or a
   *   chardet-less install where the heuristic is the only opinion there is.
   * - `ranked: true, adoptable: false` — chardet ranked these pages, but its
   *   head is a single-byte page whose own decode contradicts it
   *   (see `isImplausibleSingleByteHead`). The order is still meaningful, so the
   *   list is shown in order; the head is just not credible enough to use.
   * - `ranked: false, adoptable: true` — an abstention where both producers
   *   happened to name the same page. Agreement is strong evidence (83%
   *   measured) and still not proof, so the caller adopts it while keeping the
   *   "this is a guess" caveat in front of the model.
   * - `ranked: false, adoptable: false` — an abstention where they disagree.
   *   Refusing it is what keeps a page nobody could justify from being recorded
   *   and written back.
   */
  adoptable: boolean;
  /** Which ranking produced `candidates`. Diagnostic, not a control input. */
  basis: "chardet-ranked" | "chardet-abstained" | "heuristic-only";
}

/**
 * Rank the candidates and report whether the ordering means anything.
 *
 * This is where the ranking rules live; {@link getTop3Candidates} is a thin
 * wrapper for callers that need only the list. The split exists so the evidence
 * flag can be computed where the floor test is available, and so it travels with
 * the list it describes — see {@link RankedCandidates}.
 *
 * @param bytes - the raw content.
 * @param allowlist - candidate encodings the deployment permits.
 * @returns the candidates and whether their order is evidence-backed.
 */
export async function rankCandidates(
  bytes: Uint8Array,
  allowlist: readonly string[],
): Promise<RankedCandidates> {
  const analysis = await chardetAnalysis(bytes, allowlist);
  const viaChardet = analysis.accepted;

  // chardet ranked a page above its floor: its order is evidence and is kept
  // verbatim. The heuristic is never consulted — `scoreText` cannot separate
  // these pages (see `chardetRankedAnyPage`), so running it would only cost a
  // full decode pass per allowlisted encoding without changing the head.
  //
  // EXCEPT when the page it ranked is a single-byte one whose own decode
  // contradicts it — the shape of chardet's known "single-byte pages score
  // themselves highly" weakness, where adopting the head silently mangles the
  // file. See {@link isImplausibleSingleByteHead}.
  //
  // Note what that exception does and does not change. `ranked` stays TRUE: the
  // order really is chardet's ranking, and the heuristic is still not consulted,
  // so the list is meaningful as an ORDER. Only `adoptable` flips, because the
  // head specifically is not credible. Reporting `ranked: false` here would be
  // the wrong fix — it would claim the pages could not be separated (they were)
  // and would swap the message to "this list is unordered", which is false.
  if (chardetRankedAnyPage(viaChardet)) {
    const head = viaChardet[0];
    const previews = viaChardet.map(toPreview);
    if (head !== undefined && isImplausibleSingleByteHead(bytes, head)) {
      return {
        candidates: capAndDedupe(previews),
        ranked: true,
        adoptable: false,
        basis: "chardet-ranked",
      };
    }
    return {
      candidates: previews,
      ranked: true,
      adoptable: true,
      basis: "chardet-ranked",
    };
  }

  const previews = viaChardet.map(toPreview);
  const heuristic = top3Candidates(bytes, allowlist);

  // No verdict survived the filter. TWO different situations land here and they
  // used to be treated as one, which is what made this branch the single largest
  // source of silent mis-encodings in the plugin.
  //
  //   (a) `chardet` is genuinely absent, or its import/analysis threw. Then the
  //       heuristic really is the only opinion available and adopting its head is
  //       the long-standing behaviour; refusing would break every non-UTF-8 read
  //       in a chardet-less install.
  //
  //   (b) `chardet` ran fine and named pages the ALLOWLIST does not cover. Its
  //       verdicts are unusable as encodings, but the SCRIPT it named is still
  //       evidence, and discarding it is a mistake with a measured cost.
  //
  // Measured over 330 samples, case (b) was ALL 40 of the samples that reached
  // this branch and case (a) was ZERO — `chardet` ships in the published
  // tarball's optional set and was present in every run. The dangerous shape is
  // `ISO-8859-2:16 ISO-8859-9:16` on a windows-1252 file: chardet says "Latin",
  // the allowlist has no Latin-2 page, so both verdicts vanish — and the
  // heuristic then picks `windows-1251`, because Cyrillic has a
  // {@link scriptBonus} entry and plain Latin has none, so a Cyrillic reading
  // scores strictly higher than the correct Latin one. That happened on all 19
  // samples where the branch fired with a Cyrillic heuristic head, and the Latin
  // candidate was correct in every one of them.
  //
  // The fix uses the surviving NAME, never the discarded encoding: when chardet
  // named a Latin page (see {@link CHARDET_LATIN_PAGES}) and the heuristic's head
  // is NOT a Latin page, a Latin candidate is preferred. Re-measured on 1682
  // Latin/Cyrillic samples, this repaired 18 windows-1252 files, broke 0, and
  // never fired on a true Cyrillic file — the case that would be silent
  // corruption.
  if (previews.length === 0) {
    return {
      candidates: capAndDedupe(preferChardetLatinPage(heuristic, analysis.outsideAllowlist)),
      ranked: true,
      adoptable: true,
      basis: "heuristic-only",
    };
  }

  // chardet spoke and every verdict sits on its multi-byte floor: it could not
  // separate these pages. Neither producer can rank them, so the two lists are
  // UNIONED for coverage and put on ONE score scale — see `unionByScore`.
  //
  // Whether the head may be ADOPTED is decided by AGREEMENT. Measured over 1915
  // native samples (552 abstained), neither producer's head is usable alone:
  // chardet's is right 21% of the time, the heuristic's 36%. Every attempt to
  // pick a better head made things worse — ordering the union by score
  // degenerates to "always gbk" (see below), and preferring the heuristic's head
  // whenever chardet's is absent from its list re-recorded 13 Shift_JIS files as
  // `gbk`. What IS evidence is the two producers independently naming the SAME
  // page: 62 of the 75 such cases are correct. So agreement is adopted, and
  // disagreement is refused — the plugin's standing "fail rather than guess
  // wrong" trade, applied to the one case where nothing else distinguishes the
  // pages. That costs explicit re-reads (477 of those 552) and removes 423
  // silent mis-encodings (436 → 13).
  //
  // `ranked` stays FALSE even when the producers agree, and the two facts are
  // deliberately separate: `ranked` is what the caller prints and caveats ("this
  // pick is a guess"), while `adoptable` is what it acts on. Agreement is good
  // evidence but not proof — 13 of those 75 are still wrong — so the footer must
  // keep saying the pick is a guess rather than presenting it as a decision.
  //
  // Ordering by score would be wrong even though the scores are now comparable:
  // `scoreText` cannot tell the East Asian pages apart — the GB18030 decoder is
  // the most permissive of the set, so it scores 105-115 whatever the true page
  // is — which makes "sort by score" degenerate into "always pick gbk". Measured
  // on `日本語` (Shift_JIS) that recorded `gbk` and showed the model `擔杮岅`; the
  // mojibake re-encodes to the original bytes, so a write-back reproduced the
  // file and nothing downstream noticed. `unionByScore` therefore harmonises the
  // score field but leaves the order alone.
  //
  // Plain concatenation, not a lockstep interleave: an interleave lets the
  // heuristic's filler evict chardet's own verdicts one-for-one, which loses
  // pages chardet actually named. Measured on Korean input, `interleave` dropped
  // the correct `euc-kr` page on 4 of 9 samples where concatenation kept it.
  //
  // The cap is one wider here because three slots cannot hold both sides: see
  // `UNRANKED_CANDIDATE_SLOTS`.
  const agreed =
    previews[0] !== undefined &&
    heuristic[0] !== undefined &&
    previews[0].encoding === heuristic[0].encoding;
  return {
    candidates: capAndDedupe(
      unionByScore(bytes, previews, heuristic),
      UNRANKED_CANDIDATE_SLOTS,
    ),
    ranked: false,
    adoptable: agreed,
    basis: "chardet-abstained",
  };
}

/**
 * Move a Latin candidate to the front when `chardet` named a Latin page the
 * allowlist does not cover.
 *
 * This is the one place a page `chardet` named but the deployment cannot USE
 * still changes the outcome — see the `heuristic-only` branch of
 * {@link rankCandidates} for the measurements and the failure it repairs.
 *
 * The rule is deliberately narrow, and each restriction is load-bearing:
 *
 * - Only fires when chardet's surviving name is a LATIN page. A refuted
 *   Cyrillic, Greek or Thai name says nothing about which allowlisted page is
 *   right, and acting on one would be guessing from a script the allowlist
 *   cannot even represent.
 * - Only reorders candidates the heuristic already produced, and only to prefer
 *   one that is itself Latin. It never invents a candidate and never touches a
 *   non-Latin head, so the East Asian and Cyrillic cases — where the heuristic's
 *   scriptBonus is real evidence — are left exactly as they were. The
 *   `latinIndex <= 0` guard carries both of those: index 0 means the head is
 *   already Latin, and -1 means there is no Latin candidate to prefer.
 *
 * An earlier revision of this branch also tried refusing outright whenever
 * chardet's refuted family disagreed with the head. That was measured and
 * rejected: it refused 33 files that HEAD read correctly to repair 83 that it
 * read wrongly, which is a worse trade than the preference above, and it turned
 * recoverable guesses into hard errors on files whose head was already right.
 *
 * Two WIDENINGS were also measured and both are rejected — do not reinstate them
 * without new evidence, because each looks obviously right and is not:
 *
 * - "chardet named no NON-Latin page" (i.e. treat silence as permission). It
 *   repairs 20 Latin files but corrupts 6 Cyrillic ones, because chardet
 *   reporting only `ASCII:0` or `UTF-8:10` is silence, and silence is exactly
 *   what a 1-2 letter Cyrillic word produces too.
 * - A score-margin gate (`cyrillic score - latin score <= 2`). On a realistic
 *   corpus this repaired all 8 Latin files it targeted and broke 0 Cyrillic
 *   ones, which is why it is tempting. It is still wrong: `delta` is just the
 *   count of Cyrillic letters the windows-1251 reading yields, so the threshold
 *   selects exactly the SHORTEST Cyrillic text, and every short Cyrillic word
 *   (`я`, `в`, `и`, `а`, `у`, `о`, `с`, `к`) has delta 1. The rule corrupted all
 *   8 of them. A margin cannot separate the two families because the Latin
 *   candidate is always a valid decode of the same bytes; only chardet naming
 *   the script distinguishes them, which is what this gate requires.
 *
 * @param heuristic - the heuristic ranking, best first.
 * @param outsideAllowlist - the names `chardet` reported that the allowlist rejected.
 * @returns the same candidates, with a Latin page moved to the front if warranted.
 */
function preferChardetLatinPage(
  heuristic: readonly CandidatePreview[],
  outsideAllowlist: ReadonlySet<string>,
): CandidatePreview[] {
  let chardetSawLatin = false;
  for (const name of outsideAllowlist) {
    if (CHARDET_LATIN_PAGES.has(name)) {
      chardetSawLatin = true;
      break;
    }
  }
  if (!chardetSawLatin) return [...heuristic];

  const latinIndex = heuristic.findIndex((c) => LATIN_ENCODINGS.has(c.encoding));
  if (latinIndex <= 0) return [...heuristic];

  const promoted = heuristic[latinIndex];
  if (promoted === undefined) return [...heuristic];
  return [promoted, ...heuristic.filter((_, i) => i !== latinIndex)];
}

/**
 * The allowlisted encodings whose script is Latin.
 *
 * The complement of {@link SCRIPT_FAMILIES}: a Latin page carries Latin letters,
 * which is what ordinary Western text looks like, so it earns no script bonus
 * and is separated from its rivals by the printable-ratio rule alone. That
 * asymmetry is exactly why a Cyrillic reading can outscore a correct Latin one,
 * and why {@link preferChardetLatinPage} has to name these pages explicitly.
 */
const LATIN_ENCODINGS: ReadonlySet<string> = new Set(["windows-1252", "iso-8859-1"]);

/**
 * The single-byte pages whose high scores on short input are the plugin's
 * best-documented weakness.
 *
 * Both are reached by chardet's `sbcs` recogniser, which computes
 * `Math.floor(rawPercent * 300)` — a score any single-byte page can earn by
 * matching Latin n-grams in ASCII text, with no notion of whether the bytes are
 * really that page. See {@link isImplausibleSingleByteHead}.
 */
const SINGLE_BYTE_HEAD_PAGES: ReadonlySet<string> = new Set(["iso-8859-1", "windows-1252"]);

/**
 * Share of non-ASCII characters above which a single-byte decode stops looking
 * like the Western text those pages exist to carry.
 *
 * The measurement behind the value: on a 485-sample corpus the files this rule
 * rescues (CJK text misread as a single-byte page) had a non-ASCII share of
 * 0.50–1.00, while every file it would have cost (correctly-decoded Western
 * text, including accented prose and ASCII source files with Latin comments) sat
 * at 0.00–0.25. The two ranges do not overlap, and the rule stayed clean at
 * every threshold from 0.30 to 0.70 — 0 files broken, 0 correct reads refused at
 * each — so the exact value is not load-bearing. 0.4 sits in the middle of the
 * gap rather than at its edge.
 */
const IMPLAUSIBLE_SINGLE_BYTE_NON_ASCII_SHARE = 0.4;

/**
 * Whether a `chardet`-ranked single-byte head should be distrusted rather than
 * adopted.
 *
 * The failure this catches: chardet ranks `iso-8859-1` or `windows-1252` above
 * the page that is actually right, and adopting it silently mangles the file.
 * The single-byte page wins because its `sbcs` n-gram score counts ASCII letters
 * and spaces, which the mis-read bytes do not contain but which the PAGE's own
 * decode manufactures — every 2-byte character becomes TWO Latin-1 characters,
 * so the wrong reading is almost entirely non-ASCII while the right one is
 * mostly ASCII.
 *
 * Measured over 385 samples, the rule fired 24 times: every one was a file whose
 * head reading was mojibake, and it refused none that previously read correctly.
 * The files it rescues are 7 Big5, 4 Shift-JIS, 3 EUC-KR and 10 windows-1251 —
 * Cyrillic is included because `windows-1251` bytes read as Latin-1 are equally
 * non-ASCII (`"Проверка входа"` becomes `"Ïðîâåðêà âõîäà"`), and in 8 of those 10
 * the refusal's candidate list names `windows-1251`, so the model can re-read.
 *
 * That asymmetry is the whole rule, and it is why the test is on the head's own
 * DECODE rather than on a score. Real Western text — including accented prose
 * and an ASCII source file whose only non-ASCII is a Latin-1 comment — decodes
 * to mostly letters and spaces, so its share stays low and it is left alone.
 *
 * Two alternatives were measured and rejected:
 *
 * - A `scoreText` margin between the multi-byte page and the head. On these
 *   samples the multi-byte page's heuristic score beat the head's on 4 correct
 *   Western files as well as on the mis-read ones, so a margin refuses both.
 * - Gating on "a multi-byte page is also on chardet's list". That reads as an
 *   obvious safeguard but is unreachable: across 4559 probes (random high-byte
 *   input, Latin-1 runs, every single-byte Windows page, and the full CJK
 *   lead-byte range) chardet named a floor-family page in EVERY case where a
 *   single-byte page scored above the share threshold, so the condition never
 *   changed a decision. It was removed rather than kept as dead weight.
 *
 * @param bytes - the raw content, needed to decode the head's own reading.
 * @param head - chardet's top verdict.
 * @returns whether the head must not be adopted.
 */
function isImplausibleSingleByteHead(bytes: Uint8Array, head: ChardetVerdict): boolean {
  if (!SINGLE_BYTE_HEAD_PAGES.has(head.encoding)) return false;
  const decoded = decodeBytes(bytes, head.encoding);
  if (decoded === undefined || decoded.length === 0) return false;
  let nonAscii = 0;
  for (const ch of decoded) {
    if ((ch.codePointAt(0) ?? 0) > 127) nonAscii += 1;
  }
  return nonAscii / decoded.length > IMPLAUSIBLE_SINGLE_BYTE_NON_ASCII_SHARE;
}

/**
 * Union two candidate lists onto a single, comparable score scale.
 *
 * The two producers score on different scales — chardet emits its own confidence
 * (its floor, 10, for every page here) while {@link top3Candidates} emits
 * `scoreText` values up to ~115 — so concatenating them verbatim produces a list
 * whose `score` field is not comparable and often not even monotone. Measured on
 * 552 abstained samples, the concatenated list was non-monotone in 475 of them,
 * and in 100% of cases a candidate's shown score was LOWER than the same page's
 * heuristic score, because dedupe kept chardet's 10. Any consumer sorting by
 * `score` — an exported field — would get the order backwards.
 *
 * Every entry is re-scored with `scoreText`, so the field means one thing and
 * cannot contradict itself. The ORDER is left as the input order, chardet first;
 * see `rankCandidates` for why ordering this branch by score silently
 * mis-records East Asian pages. Only the score is harmonised.
 *
 * @param bytes - the raw content, needed to re-score each page.
 * @param previews - chardet's verdicts as candidates, in chardet's order.
 * @param heuristic - the heuristic ranking, appended after chardet's.
 * @returns the deduplicated, re-scored list in the given order.
 */
function unionByScore(
  bytes: Uint8Array,
  previews: readonly CandidatePreview[],
  heuristic: readonly CandidatePreview[],
): CandidatePreview[] {
  const seen = new Set<string>();
  const out: CandidatePreview[] = [];
  for (const candidate of [...previews, ...heuristic]) {
    if (seen.has(candidate.encoding)) continue;
    seen.add(candidate.encoding);
    const text = decodeBytes(bytes, candidate.encoding);
    out.push({
      encoding: candidate.encoding,
      sample: candidate.sample,
      score: text === undefined ? -1000 : scoreText(text, candidate.encoding),
    });
  }
  return out;
}

/**
 * Deduplicate by encoding and keep the first `limit`.
 *
 * @param candidates - the merged list, best first as far as anyone knows.
 * @param limit - how many distinct candidates to keep.
 * @returns up to `limit` distinct candidates.
 */
function capAndDedupe(
  candidates: readonly CandidatePreview[],
  limit: number = CANDIDATE_SLOTS,
): CandidatePreview[] {
  const seen = new Set<string>();
  const out: CandidatePreview[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.encoding)) continue;
    seen.add(candidate.encoding);
    out.push(candidate);
    if (out.length === limit) break;
  }
  return out;
}

/** Present one `chardet` verdict as a candidate, its confidence as the score. */
function toPreview(c: ChardetVerdict): CandidatePreview {
  return { encoding: c.encoding, sample: c.sample, score: c.confidence };
}
