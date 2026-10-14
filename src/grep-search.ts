/**
 * Encoding-aware search core for the shadowed `grep` tool.
 *
 * The built-in `grep` runs the packaged ripgrep binary once and trusts its
 * `--json` output. That is enough for a UTF-8 repository and wrong for every
 * other one, in two distinct ways:
 *
 * 1. **Placeholders.** ripgrep emits `lines.text` only when a matched line is
 *    valid UTF-8 and falls back to base64 `lines.bytes` otherwise. The built-in
 *    parser replaces that with the literal string `(line is not valid UTF-8)`,
 *    so a GBK file's matching lines are reported as unreadable rather than
 *    shown.
 * 2. **Silent misses.** A non-ASCII pattern is matched against the file's RAW
 *    BYTES. The pattern's UTF-8 byte sequence cannot occur in a GBK file, so a
 *    search for a Chinese word in a GBK file returns nothing at all — no error,
 *    no placeholder, just a smaller result. This is the more dangerous half:
 *    the model cannot tell "not present" from "not searched".
 *
 * ## Why this is not a re-implementation of the search
 *
 * The obvious fix — decode every candidate file in JavaScript and match with a
 * `RegExp` — was measured and rejected. On 200 files / 15.4 MB it costs
 * ~1200 ms against ripgrep's 45 ms, and 96% of that is the per-file encoding
 * detection, not the matching (regex: 32 ms, file IO: 19 ms). Worse, it would
 * silently change the pattern language: `(?i)` and `(?s)` are ripgrep syntax
 * that throws in JavaScript, `\p{Greek}` needs a `u` flag, and `\w` does not
 * mean the same set.
 *
 * So ripgrep stays the search engine and this module adds the two things it
 * cannot do by itself:
 *
 * - A **per-file** encoding decision, because `--encoding` is a whole-invocation
 *   flag. Measured: telling ripgrep `--encoding=gbk` over a mixed directory
 *   makes it MISS the UTF-8 files and mojibake them when it does match
 *   (`alpha 閰嶇疆椤� port=8080`), so the flag cannot simply be passed through.
 * - A **byte-preserving** parse, because the built-in one discards
 *   `lines.bytes` and the raw bytes are unrecoverable afterwards.
 *
 * ## The two-pass shape
 *
 * Pass 1 runs ripgrep once with no `--encoding`, exactly as the built-in does.
 * Every line it already decoded is adopted as-is — that is most lines in most
 * repositories, and costs nothing extra. Only the files that produced at least
 * one `lines.bytes` row are carried into pass 2.
 *
 * Pass 2 decides one encoding per such file and re-runs ripgrep for that file
 * alone with `--encoding=<label>`, which makes ripgrep transcode the whole file
 * and emit `lines.text` for every row. Measured: the cost is bounded by the
 * number of files that actually contained a non-UTF-8 matched line, which is
 * zero for an ASCII search over a UTF-8 repository.
 *
 * ## Why the non-ASCII case needs no detection at all
 *
 * A non-ASCII pattern is self-validating. The pattern's UTF-8 bytes only match
 * after ripgrep has transcoded the file with the CORRECT encoding, so running
 * the pattern under each candidate and keeping the ones that match identifies
 * the file's encoding exactly. Measured over five encodings holding the same
 * text, each `(path, lineNumber)` was claimed by exactly one encoding — no
 * duplicates, no false positives.
 *
 * @module dsh-fs-encoding/grep-search
 */

import { Worker } from "node:worker_threads";
import type { Context } from "@deepseek-ai/cordis";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { PluginConfig } from "./config.js";
import { decodeBytes, encodeText } from "./encoding.js";
import {
  decodeForOpen,
  DecodeError,
  getEncodingState,
  isStale,
} from "./encoding-state.js";
import { keyOf, sessionKeyFor } from "./io.js";

/**
 * One matched line as ripgrep reported it, before any decoding.
 *
 * Exactly one of {@link text} / {@link bytes} is present, and which one is a
 * PER-LINE fact rather than a per-file one: ripgrep emits `text` for a line that
 * happens to be valid UTF-8 and `bytes` for one that is not. Measured on a
 * single GBK file: `PORT=8080` arrives as text while
 * `PORT=9090  # 配置项 端口` arrives as bytes.
 */
export interface RawMatch {
  /** Path exactly as ripgrep printed it (absolute or relative to the spawn cwd). */
  path: string;
  /** 1-based line number. */
  lineNumber: number;
  /** The line as UTF-8 text, when ripgrep could represent it. */
  text?: string;
  /** The line's raw bytes, when ripgrep could not. */
  bytes?: Uint8Array;
}

/**
 * A match that has been decoded, or one that could not be.
 *
 * The undecodable case is deliberately a VALUE rather than an omission. The
 * built-in tool drops the bytes and prints a placeholder that says nothing about
 * what to do next; here the placeholder carries the candidate encodings, so the
 * model can re-read the file and learn the answer.
 */
export interface DecodedMatch {
  /** Display path, workdir-relative where possible. */
  path: string;
  /** 1-based line number. */
  lineNumber: number;
  /** The decoded line, trailing newline removed. */
  line: string;
}

/** Canonical plugin encoding name → the label ripgrep's `--encoding` accepts. */
const RG_ENCODING_LABELS: Record<string, string> = {
  utf8: "utf-8",
  // A BOM-carrying UTF-8 file is plain UTF-8 to ripgrep: the mark is consumed by
  // the decoder, so the two names share one label. The distinction matters for
  // SAVING, not for searching.
  utf8bom: "utf-8",
  utf16le: "utf-16le",
  utf16be: "utf-16be",
  gbk: "gbk",
  big5: "big5",
  "shift_jis": "shift-jis",
  "euc-kr": "euc-kr",
  // The Windows ANSI family, one code page per script, all of which ripgrep
  // accepts and decodes. Listing only 1251 and 1252 here was not a limitation
  // of ripgrep but a gap in this table, and an expensive one: a canonical name
  // missing from it is indistinguishable from UTF-32 below, so the file was
  // routed to the JavaScript fallback and its pattern language changed with it.
  "windows-1250": "windows-1250",
  "windows-1251": "windows-1251",
  "windows-1252": "windows-1252",
  "windows-1253": "windows-1253",
  "windows-1254": "windows-1254",
  "windows-1255": "windows-1255",
  "windows-1256": "windows-1256",
  "windows-1257": "windows-1257",
  "iso-8859-1": "iso-8859-1",
};

/**
 * Canonical names ripgrep cannot be asked for at all.
 *
 * UTF-32 is the whole list, and it is a real gap rather than a detail: measured,
 * `--encoding=utf-32le` exits 2 with `unknown encoding`, and without the flag
 * ripgrep does not find the text either (UTF-32LE `// 配置项 port=8080` yields
 * zero matches). Such a file therefore cannot go through the ripgrep path in
 * either direction and is handled by {@link searchDecodedFile} instead.
 */
const RG_UNSUPPORTED = new Set(["utf32le", "utf32be"]);

/**
 * The `--encoding` label for a canonical encoding name.
 *
 * @param encoding - canonical identifier, e.g. `shift_jis`.
 * @returns the ripgrep label, or `undefined` when ripgrep cannot search it.
 */
export function rgLabelFor(encoding: string): string | undefined {
  if (RG_UNSUPPORTED.has(encoding)) return undefined;
  return RG_ENCODING_LABELS[encoding];
}

/**
 * Whether a pattern can only match after ripgrep has transcoded a file.
 *
 * This is the switch between the tool's two search strategies, and it exists
 * because of a measured property of ripgrep: it matches the pattern against the
 * file's bytes and only then decides how to report the line. A pattern that is
 * pure ASCII is byte-identical in every encoding this plugin supports, so the
 * default call finds it everywhere — in a GBK file just as in a UTF-8 one. A
 * pattern with ANY non-ASCII character is a UTF-8 byte sequence that cannot
 * occur in a file in another encoding, so the default call misses such files
 * ENTIRELY: measured, `--regexp=配置项` over a GBK file returns zero matches,
 * with no error and no placeholder.
 *
 * That asymmetry is what makes the tool's two passes necessary rather than
 * merely an optimisation, and it is the reason this predicate — not a
 * performance heuristic — decides which strategy runs.
 *
 * @param pattern - the model-supplied regular expression.
 * @returns whether the pattern holds a character outside the ASCII range.
 */
export function needsTranscodedSearch(pattern: string): boolean {
  // Tested by code POINT rather than by a regex on the string: a lone surrogate
  // is a legitimate thing for a pattern to contain, and a `/[\x80-\uFFFF]/`
  // test would answer for its code unit rather than its character.
  for (const ch of pattern) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
}

/**
 * The encodings that could possibly spell this pattern.
 *
 * A cheap and exact narrowing of the sweep, from the same property that makes
 * the sweep work: ripgrep transcodes the file to UTF-8 and THEN matches, so a
 * pattern character the candidate encoding cannot represent can never appear in
 * its output. Measured over the seven legacy pages: `配置项` is representable
 * only by `gbk` (so six of the seven runs are skipped), while `Привет` is
 * representable by all seven and the full sweep runs.
 *
 * The comparison is a round trip rather than an `encodingExists` check, because
 * the question is not whether the codec knows the page but whether the page can
 * hold these particular characters — `iconv-lite` silently substitutes `?` for
 * a character a page lacks.
 *
 * @param pattern - the model-supplied regular expression.
 * @param encodings - the canonical names to filter.
 * @returns the subset that can represent the pattern, in the input order.
 */
export function encodingsForPattern(
  pattern: string,
  encodings: readonly string[],
): string[] {
  return encodings.filter((encoding) => {
    const bytes = encodeText(pattern, encoding);
    if (bytes === undefined) return false;
    const back = decodeBytes(bytes, encoding);
    return back === pattern;
  });
}

/**
 * Parse ripgrep's `--json` NDJSON output, preserving BOTH line representations.
 *
 * This is the function the built-in package does not export, and its absence is
 * why this module exists at all: the built-in `parseGrepMatches` collapses a
 * `lines.bytes` row into the literal string `(line is not valid UTF-8)` at parse
 * time, and the raw bytes are gone by the time any post-processing hook could
 * see them.
 *
 * Malformed input is skipped rather than fatal. ripgrep's stdout is a transport
 * this module drives itself, so a line that is not JSON means a truncated read
 * (the output cap) rather than a caller error — failing the whole search there
 * would turn a partial result into no result, and the caller has the match count
 * to notice the difference.
 *
 * @param stdout - the complete raw stdout of one ripgrep run.
 * @returns every `match` record, in output order; non-match records are ignored.
 */
export function parseRgJson(stdout: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const rec = record as { type?: unknown; data?: unknown };
    if (rec.type !== "match") continue;
    const data = rec.data as {
      path?: { text?: unknown };
      line_number?: unknown;
      lines?: { text?: unknown; bytes?: unknown };
    } | null;
    if (typeof data !== "object" || data === null) continue;
    const path = data.path?.text;
    const lineNumber = data.line_number;
    if (typeof path !== "string" || typeof lineNumber !== "number") continue;
    const lines = data.lines;
    if (typeof lines !== "object" || lines === null) continue;

    if (typeof lines.text === "string") {
      matches.push({ path, lineNumber, text: lines.text.replace(/\r?\n$/, "") });
    } else if (typeof lines.bytes === "string") {
      matches.push({
        path,
        lineNumber,
        bytes: new Uint8Array(Buffer.from(lines.bytes, "base64")),
      });
    }
  }
  return matches;
}

/** Which files produced at least one undecodable row, in first-seen order. */
export function filesNeedingDecoding(matches: readonly RawMatch[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of matches) {
    if (match.bytes === undefined) continue;
    if (seen.has(match.path)) continue;
    seen.add(match.path);
    out.push(match.path);
  }
  return out;
}

/**
 * The encoding this session has already recorded for a file, if any.
 *
 * The seam that makes grep agree with `read` instead of guessing independently.
 * `read` records what it established — including an explicit
 * `read({ encoding: "gbk" })`, which is the documented remedy for a legacy file
 * — and `io.ts` reuses that record as the hint on every later read. A search
 * that ignored it would report a placeholder for a file the session has already
 * decoded, and the model would have no way to tell that the answer was sitting
 * right there.
 *
 * Read-only, like everything on the search path: `getEncodingState` looks a
 * record up and writes nothing, so consulting it cannot arm the write gate.
 *
 * Staleness is checked with the same `isStale` comparison the write path uses,
 * so a record describing a file that has since changed on disk is discarded
 * rather than applied to different bytes.
 *
 * @param exec - the calling execution, which owns the session bucket.
 * @param target - the resolved target.
 * @param version - the version just observed for the file.
 * @returns the recorded encoding, or `undefined`.
 */
export function recordedEncodingHint(
  exec: ToolExecution,
  target: FsTarget,
  version: FsVersion | undefined,
): string | undefined {
  try {
    const state = getEncodingState(sessionKeyFor(exec), keyOf(target));
    if (state === undefined) return undefined;
    if (isStale(state, version)) return undefined;
    return state.encoding;
  } catch {
    return undefined;
  }
}

/** The candidate encoding names from a refusal, best first. */
export function candidatesOf(error: unknown): string[] {
  if (!(error instanceof DecodeError)) return [];
  const detail = error.detail;
  if (detail === undefined) return [];
  return detail.candidates.map((candidate) => candidate.encoding);
}

/**
 * Merge pass-1 and pass-2 results into one ordered, deduplicated list.
 *
 * Deduplication is by `(path, lineNumber)` and pass 2 wins, because pass 2 read
 * the file later and under an encoding that actually decodes it. Without this a
 * file searched in both passes would report every matching line twice — pass 1
 * from its undecodable rows and pass 2 from its decoded ones.
 *
 * Ordering follows the built-in tool's: files in first-seen order, lines
 * ascending within a file. The first-seen order of a file is taken from whichever
 * pass saw it first, so a pass-2-only file (one that never matched in pass 1)
 * keeps a stable position rather than being appended arbitrarily.
 *
 * @param passes - the per-pass match lists, earliest pass first.
 * @returns the merged matches.
 */
export function mergeMatches(passes: readonly (readonly DecodedMatch[])[]): DecodedMatch[] {
  const byKey = new Map<string, DecodedMatch>();
  const fileOrder = new Map<string, number>();
  let order = 0;
  for (const pass of passes) {
    for (const match of pass) {
      if (!fileOrder.has(match.path)) fileOrder.set(match.path, order++);
      // Later passes overwrite earlier ones for the same line, which is the
      // point: pass 2 holds the decoded text where pass 1 held a placeholder.
      byKey.set(`${match.path}\u0000${match.lineNumber}`, match);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const fileA = fileOrder.get(a.path) ?? 0;
    const fileB = fileOrder.get(b.path) ?? 0;
    if (fileA !== fileB) return fileA - fileB;
    return a.lineNumber - b.lineNumber;
  });
}

/**
 * The placeholder for a line that could not be decoded.
 *
 * Names the candidates when there are any, because that is the whole remedy: the
 * model can re-read the file with one of them and then search again. With no
 * candidates the honest statement is that the bytes are not text, so it says
 * that instead of offering an empty list.
 *
 * @param candidates - candidate encoding names, best first.
 */
export function placeholderFor(candidates: readonly string[]): string {
  if (candidates.length === 0) return "(line is not valid UTF-8)";
  return `(line is not valid UTF-8 — candidates: ${candidates.join(", ")})`;
}

/**
 * Whether a byte buffer looks like binary rather than text in any encoding.
 *
 * Used only by the JavaScript fallback path, which — unlike ripgrep — has no
 * binary detection of its own. A NUL byte is the signal ripgrep itself uses.
 *
 * The check is deliberately NOT applied to UTF-32. Measured: a UTF-32LE file
 * begins `ff fe 00 00 63 00 00 00`, so a NUL test calls every UTF-32 file binary
 * — and UTF-32 is the one encoding this fallback exists to serve. The caller
 * therefore asks only for the encodings where a NUL really does mean binary,
 * which is all of them except the UTF-32 pair.
 *
 * @param bytes - the bytes to test.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/**
 * Whether a NUL byte in these bytes means the content is not text.
 *
 * @param bytes - the bytes to test.
 * @param encoding - the encoding they are claimed to be in.
 */
export function binaryInEncoding(bytes: Uint8Array, encoding: string): boolean {
  // UTF-32 stores every character in four bytes, so three of them are NUL for
  // the whole ASCII range: a NUL test would reject every such file.
  if (encoding === "utf32le" || encoding === "utf32be") return false;
  return looksBinary(bytes);
}

/**
 * The byte order a file's own LINE BREAKS name, if any.
 *
 * A NUL byte means two entirely different things depending on what the bytes
 * are, and this is the one fact that separates them from the bytes alone. UTF-16
 * stores U+000A as the pair `0a 00` (LE) or `00 0a` (BE) on a two-byte
 * character boundary, because every character occupies exactly one such pair; a
 * legacy code page stores it as the single byte `0a`, wherever it falls. So a
 * file whose line break sits on a character boundary is UTF-16, and a file whose
 * line break merely happens to be followed by a stray NUL is not.
 *
 * That distinction is what {@link readAndDecode} needs at its binary refusal,
 * and the reason it cannot use the NUL PARITY counts that answer the same
 * question elsewhere: measured over every offset a single stray NUL can occupy
 * in five legacy source files (995–999 placements each), the parity counts name
 * an order in 100% of them — one NUL is enough to make one parity win — while
 * the line-break alignment fires in 4.0%, on exactly the placements where the
 * NUL lands immediately after an even-offset break. The alignment is structural
 * rather than statistical: a genuine UTF-16 text file has every line break on a
 * character boundary, so it is named here in 100% of the measured cases.
 *
 * `undefined` means "not UTF-16 by this evidence", which is the answer that
 * keeps a legacy page's decode of a stray-NUL file. It is deliberately NOT
 * "this file is text": a UTF-16 file with no line break at all is undecidable
 * here, and the caller treats that the same way the search passes already do —
 * see `utf16ByteOrder`, which owns the full verdict and calls this for its
 * newline half so the two cannot drift apart.
 *
 * @param bytes - the file's bytes, or as much of them as were read.
 */
export function utf16NewlineOrder(bytes: Uint8Array): string | undefined {
  let le = 0;
  let be = 0;
  // Stepped in pairs, so a match requires the break to sit on a character
  // boundary rather than anywhere in the stream.
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x00) le++;
    else if (bytes[i] === 0x00 && bytes[i + 1] === 0x0a) be++;
  }
  // Both orders present means the file is not consistently either one, which is
  // no evidence at all rather than evidence for the larger count.
  if (le > 0 && be === 0) return "utf16le";
  if (be > 0 && le === 0) return "utf16be";
  return undefined;
}

/**
 * The byte order a file's line breaks name on the ODD alignment, if any.
 *
 * {@link utf16NewlineOrder} reads the pairs a UTF-16 file is made of, and a file
 * whose first byte is missing has every one of those pairs one byte further
 * along: its breaks are `0a 00` at odd offsets, so the even scan sees no evidence
 * at all and answers `undefined`. That is the one case where `undefined` there
 * means "the evidence is one byte to the left" rather than "there is none", and
 * {@link readAndDecode} is the caller that has to tell the two apart — see the
 * binary refusal there, where taking the second for the first kept ripgrep's
 * NUL-free byte artifacts. Measured on `41` + UTF-16LE(`佐呒\n配佐\n`) searched for
 * `P`, the first row came back as the artifact `APORT`.
 *
 * Deliberately separate from {@link utf16NewlineOrder} rather than folded into
 * it, because that function is ALSO the newline half of `utf16ByteOrder` in
 * `tool-grep`, which decides which UTF-16 search pass may report a file. Widening
 * the shared answer moved that gate's verdict on files it used to leave alone:
 * measured over 42 files of legacy text each carrying three stray NULs, 37
 * changed output, and the sampled ones include a correct row replaced by UTF-16
 * mojibake and a placeholder replaced by it. The question this answers — "are
 * ripgrep's clean rows byte artifacts?" — is the binary refusal's own, and it is
 * not the pass gate's.
 *
 * A verdict needs EVERY break in the file on this alignment, and at least two of
 * them. One break paired by coincidence is exactly how a stray NUL imitates a
 * character boundary — the coincidence behind the even scan's own 4.0%
 * false-positive rate — so a single break is not accepted. Measured: this names
 * both shifted fixtures and adds no firing over every offset a single stray NUL
 * can occupy in five legacy source files (0 of 4991). Over 3 256 979 placements
 * of one to three NULs in ten legacy and ASCII bases that the even scan leaves
 * alone, it fires on 1126 (0.035%); 938 of those are placements the version
 * before it did not fire on, every one holding a NUL-free row, and a scan of a
 * real working tree (8554 files, 1608 holding a NUL) turns up one file — a
 * binary `hyph-*.hyb` with no NUL-free row at all. The note here used to claim
 * every firing needed all three NULs, which is false: zeroing the last byte of
 * `项` and of `口` in `// 配置项\n// 端口\n` was already named `utf16be`.
 *
 * TWO of the three shapes a partnerless break can take are skipped rather than
 * counted, and they are the two that would veto a shifted LE file: an odd-offset
 * `0a` whose next byte is not NUL is a character's own low byte, and an `0a` at
 * offset 0 has no room before it for the `00` that would make it a BE break.
 * Skipping them is what keeps the 82 characters of U+4E00–U+9FFF whose low byte
 * is 0x0a — `上` among the common ones — from counting against the verdict, which
 * is how `41` + UTF-16LE(`上海\n配置\n`) used to answer `undefined` and let
 * ripgrep's NUL-free `A` and `Nwm` rows survive as artifacts. Counting a bare
 * `0a` as LE evidence instead closes that hole but leaves the two truncated
 * shapes leaking — a file missing its first or last byte — so the last byte
 * counts as LE evidence too and a leading `0a` is ignored. The BE side keeps its
 * backward partner: the two directions are not symmetric, and dropping it would
 * lose the BE shifted shape outright.
 *
 * The THIRD shape a partnerless break can take is NOT skipped, and that is the
 * one place this rule is narrower than "a break with no partner is not evidence":
 * an EVEN-offset `0a` at offset > 0 with a non-NUL byte before it increments
 * `breaks` while being attributed to NEITHER order, so `le + be` falls short of
 * `breaks` and the answer is `undefined`. The two exceptions above did not change
 * that — they only ADD skips, so a break they do not skip was counted before them
 * too — and it is what keeps a legacy page's decode of a real text file whose one
 * stray NUL sits immediately after a newline. Skipping it as well is not free:
 * measured over 836 874 placements of one to three NULs in real source files under
 * gbk, big5 and shift_jis, it flips 1374 placements to a named order and 1077 of
 * those hold NUL-free rows — 110 798 correctly decoded rows replaced by
 * placeholders; end to end, one GBK source file carrying a single stray NUL goes
 * from 119 rows of real text to none. The leak it would close is
 * real but asymmetric: the BE shape needs a character whose LOW byte is 0x0a —
 * `上` is one of the 248 BMP code points that have one, 82 of them in
 * U+4E00–U+9FFF — while the LE shape needs one whose HIGH byte is 0x0a, which is
 * the 256 characters of U+0A00–U+0AFF.
 *
 * @param bytes - the file's bytes, or as much of them as were read.
 */
function utf16ShiftedOrder(bytes: Uint8Array): string | undefined {
  let breaks = 0;
  let le = 0;
  let be = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    // The pair is read in the direction the order implies, so what is counted is
    // a U+000A under that order rather than a byte with a NUL beside it. Two of
    // the three shapes a break with no partner on its own side can take are
    // skipped rather than counted, because both would veto a shifted LE file: in
    // one that is a character whose low byte is 0x0a, and at offset 0 it is a `0a`
    // with no room before it for the `00` that would make it a BE break. The
    // third — an even offset past 0 with a non-NUL byte before it — still counts
    // toward `breaks` and is attributed to neither order, which is deliberate;
    // see the note above for what skipping it costs. Two exceptions keep the
    // damage's own signatures: the LAST byte still counts as LE evidence, because
    // a missing partner there is what truncating one byte off the end leaves, and
    // the BE side keeps its backward partner — the two directions are not
    // symmetric.
    const last = i + 1 === bytes.length;
    const lePair = i % 2 === 1 && (last || bytes[i + 1] === 0x00);
    const bePair = i % 2 === 0 && i > 0 && bytes[i - 1] === 0x00;
    const leBare = i % 2 === 1 && !last && bytes[i + 1] !== 0x00;
    const beBare = i % 2 === 0 && i === 0;
    if (leBare || beBare) continue;
    breaks++;
    if (lePair) le++;
    else if (bePair) be++;
  }
  if (breaks < 2) return undefined;
  if (le === breaks && be === 0) return "utf16le";
  if (be === breaks && le === 0) return "utf16be";
  return undefined;
}

/**
 * Search one already-decoded file with a JavaScript `RegExp`.
 *
 * The fallback for encodings ripgrep cannot be told about — UTF-32 is the only
 * one. Kept deliberately narrow: it changes the pattern language from ripgrep's
 * to JavaScript's (`(?i)` and `(?s)` throw here, `\p{Greek}` needs a `u` flag,
 * `\w` differs), so routing ordinary files through it would silently change
 * results. Measured cost is ~25x a ripgrep run, dominated by decoding.
 *
 * An invalid pattern is reported rather than swallowed, because the caller's
 * next move differs: a bad regex is the model's to fix, not a file to re-read.
 *
 * NOT called directly by the tool: a model-supplied pattern can backtrack
 * catastrophically, and this function cannot be interrupted once it starts, so
 * the tool runs it through {@link searchDecodedTextIsolated}. This stays the
 * single definition of the matching semantics — the worker executes THIS
 * function, transferred by its own source — which also means it must remain
 * self-contained. See {@link SEARCH_WORKER_SOURCE}.
 *
 * @param text - the decoded file content.
 * @param pattern - the model-supplied regular expression.
 * @param displayPath - the path to report on each match.
 * @returns the matching lines, or a thrown `SyntaxError` for a bad pattern.
 */
export function searchDecodedText(
  text: string,
  pattern: string,
  displayPath: string,
): DecodedMatch[] {
  const re = new RegExp(pattern);
  const out: DecodedMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (re.test(line)) out.push({ path: displayPath, lineNumber: i + 1, line });
  }
  return out;
}

/**
 * How long the isolated search may run before its thread is killed.
 *
 * Measured on a 10 MB UTF-32 file — the largest this path can admit, since
 * `maxFileBytes` caps the read — the decoded text is 2.5 M characters and the
 * slowest realistic pattern (`.*`, which matches every one of 96 154 lines)
 * finishes in 87 ms. Two seconds is therefore ~20x the honest worst case, while
 * a catastrophic pattern exceeds it on the first line: measured, `(a+)+b` on 40
 * characters of `a` runs until the budget kills it.
 *
 * The shape has to be one that FAILS after exhausting the search space. A
 * trailing `$` does not qualify: it matches before a final newline in
 * non-multiline mode, so `(a+)+$` against a run of `a` succeeds on the first
 * path it tries — measured at 0 ms regardless of length. Appending a character
 * the pattern cannot match is what forces the backtracking: `(a+)+$` against
 * `a`×26 + `b` took 520 ms and against `a`×30 + `b` took 8.3 s.
 *
 * The budget is deliberately far below the tool's own 30 s `timeoutMs`, because
 * that deadline is cooperative and cannot preempt the regex — a budget at that
 * scale would let one file consume the whole call and leave no room to report
 * the failure. Hitting this budget is reported, never swallowed: a silently
 * short result is the exact confusion this module exists to remove.
 */
const FALLBACK_SEARCH_BUDGET_MS = 2000;

/**
 * The worker body, built from the search function's OWN source.
 *
 * `searchDecodedText.toString()` rather than a re-written copy, so there is one
 * definition of the matching semantics and the worker runs the very function the
 * unit tests exercise. That is the whole point: a second copy would be free to
 * drift, and the drift would be invisible — the two paths agree on every input
 * until the day they do not.
 *
 * The consequence is a real constraint on {@link searchDecodedText}: it must
 * stay self-contained. A reference to anything at module scope (a helper, a
 * constant) would not survive the transfer and would surface as a worker
 * `ReferenceError` at the first search. That failure is loud rather than silent,
 * which is why this trade is acceptable.
 */
const SEARCH_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const search = ${searchDecodedText.toString()};
parentPort.on("message", (request) => {
  try {
    parentPort.postMessage({ ok: true, matches: search(request.text, request.pattern, request.displayPath) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      name: (error && error.name) || "Error",
      message: (error && error.message) || String(error),
    });
  }
});
`;

/**
 * The error a pattern that outran {@link FALLBACK_SEARCH_BUDGET_MS} produces.
 *
 * A distinct type rather than a bare `Error` so the caller can tell a runaway
 * pattern from a broken search, and so the model-facing wording can say what to
 * do about it.
 */
export class PatternTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(
      `[E_SEARCH_PATTERN_TIMEOUT] the pattern was still matching after ${budgetMs}ms and ` +
        `was stopped. This is almost always a backtracking blow-up: a nested quantifier ` +
        `such as (a+)+ or (a|a)* matched against a long run of one character. Rewrite it ` +
        `with a non-backtracking form (e.g. a+ instead of (a+)+).`,
    );
    this.name = "PatternTimeoutError";
  }
}

/**
 * {@link searchDecodedText} behind a hard-killable execution boundary.
 *
 * ## Why the boundary exists
 *
 * `RegExp` is synchronous and V8 will not interrupt it, so a model-supplied
 * pattern with nested quantifiers blocks the event loop for as long as the
 * backtracking takes. Measured on this exact code path: 26 characters of `a`
 * against `(a+)+b` blocked for 2.9 seconds and 40 characters exceeds the 2 s
 * budget outright — the cost doubles per character. The trailing character
 * matters: `(a+)+$` against a bare run of `a` finishes in 0 ms at any length,
 * because `$` matches before a final newline and the engine never backtracks.
 * Nothing cooperative helps once it does run, because nothing else gets to run:
 * `timeoutMs` and `exec.signal` are both promises to stop, and a blocked loop
 * cannot keep them.
 *
 * That is a defect of the HARNESS, not just of this call: the plugin shares the
 * process with the agent, so a stuck search freezes every other session in it.
 *
 * A worker thread is the one boundary Node offers that can actually be revoked.
 * Measured, `terminate()` on a thread deep in catastrophic backtracking settles
 * in 1 ms and leaves 0.000 CPU-seconds of residual burn, while the main thread
 * keeps servicing its timers (9 of 10 ticks during a full second of stuck
 * search). So this is elimination, not mitigation: the pattern can still be
 * catastrophic, it just cannot hold the loop.
 *
 * ## What it does NOT change
 *
 * Matching semantics are untouched — the worker runs {@link searchDecodedText}
 * itself, and the differential over the fallback path's whole shape space (CRLF,
 * `^`/`$` at EOF, empty lines, lone CR, NUL, 50 KB lines, non-ASCII patterns,
 * `\w`/`\d`/classes) is identical line for line. An uncompilable pattern still
 * arrives as a real `SyntaxError`, so the caller's `patternError` mapping is
 * unchanged.
 *
 * The cost is one worker per file, measured at ~15 ms including startup. That is
 * paid only for UTF-32 files, which is what this path exists for.
 *
 * @param text - the decoded file content.
 * @param pattern - the model-supplied regular expression.
 * @param displayPath - the path to report on each match.
 * @param options - the abort signal, and the budget override.
 * @returns the matching lines.
 * @throws `SyntaxError` when the pattern does not compile, matching
 *   {@link searchDecodedText}'s own contract.
 * @throws {@link PatternTimeoutError} when the budget is exhausted.
 * @throws when the caller aborts.
 */
export async function searchDecodedTextIsolated(
  text: string,
  pattern: string,
  displayPath: string,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
): Promise<DecodedMatch[]> {
  const budgetMs = options.timeoutMs ?? FALLBACK_SEARCH_BUDGET_MS;
  const signal = options.signal;
  // Checked before the thread is created, so an already-cancelled search costs
  // nothing rather than a worker start plus a kill.
  if (signal?.aborted === true) throw new Error("Operation aborted");

  const worker = new Worker(SEARCH_WORKER_SOURCE, { eval: true });
  try {
    return await new Promise<DecodedMatch[]>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      // First answer wins, and the loser is disarmed here rather than after the
      // fact: a late `message` from a killed worker must not settle the promise
      // twice, and a settled call must not leave its abort listener attached.
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        settle();
      };
      const onAbort = (): void => finish(() => reject(new Error("Operation aborted")));
      const timer = setTimeout(
        () => finish(() => reject(new PatternTimeoutError(budgetMs))),
        budgetMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });

      worker.on(
        "message",
        (message: { ok: boolean; matches?: DecodedMatch[]; name?: string; message?: string }) => {
          if (message.ok) {
            finish(() => resolve(message.matches ?? []));
            return;
          }
          // Rebuilt as a REAL `SyntaxError` in this realm, because the worker's
          // own one is a different realm's constructor: `instanceof SyntaxError`
          // is false for it, and the caller routes on exactly that check.
          finish(() =>
            reject(
              message.name === "SyntaxError"
                ? new SyntaxError(message.message ?? "")
                : new Error(message.message ?? "the search worker failed"),
            ),
          );
        },
      );
      // A worker that cannot even start (a syntax error in the generated source,
      // an out-of-memory) reports here rather than as a message.
      worker.on("error", (error) => finish(() => reject(error)));
      // An exit without a message is a failure, not an empty result: reporting it
      // as "no matches" would be the silent miss this module exists to prevent.
      worker.on("exit", (code) =>
        finish(() => reject(new Error(`the search worker exited with code ${code}`))),
      );

      worker.postMessage({ text, pattern, displayPath });
    });
  } finally {
    // Unconditional, so a completed search does not leak a thread and a killed
    // one does not keep burning CPU. Measured: `terminate()` on a running worker
    // stops it outright.
    await worker.terminate();
  }
}

/**
 * What {@link readAndDecode} found for one file.
 *
 * A refusal is a VALUE that carries its reason rather than an omission, because
 * the reason is the whole remedy: an admission error holds the candidate
 * encodings the caller's placeholder names. Dropping it there meant reading the
 * file a second time and admitting it again to get the list back — a whole-file
 * read plus a whole-file admission, measured at ~96% of the cost of a decode
 * pass, spent to reproduce an answer the first call already had.
 *
 * `error` is `undefined` for the refusals that have nothing to offer — bytes
 * that are not text, a directory, an unreadable path — which is exactly what
 * {@link candidatesOf} answers for them.
 *
 * `decoded` separates the two refusals that are otherwise identical: admission
 * DID decode the file, and only the binary check then refused it. The caller's
 * placeholder loop needs that, because a file admission decoded has real `text`
 * rows that must be kept, while a file it could not read has none.
 */
export type ReadAttempt =
  | { text: string; encoding: string }
  | { error: unknown; decoded?: boolean };

/**
 * Read one file's bytes through the plugin's own admission, for the fallback
 * path.
 *
 * The session's recorded encoding is consulted first, so a file the model has
 * already opened with `read({ encoding: "gbk" })` — the documented remedy for a
 * legacy file — is searched under that same encoding rather than reported as
 * undecodable.
 *
 * Never throws: an unreadable file is one unresolved file, not a failed search,
 * so every failure — an aborted read included — comes back as a
 * {@link ReadAttempt} with its reason attached.
 *
 * @param ctx - the plugin context, for `fs`.
 * @param exec - the calling execution, for the sandbox, session cwd and records.
 * @param path - the path as ripgrep printed it.
 * @param config - the deployment's admission config.
 * @returns the decoded text and encoding, or the reason there is none.
 */
export async function readAndDecode(
  ctx: Context,
  exec: ToolExecution,
  path: string,
  config: PluginConfig,
): Promise<ReadAttempt> {
  let bytes: Uint8Array | undefined;
  try {
    const fs = ctx.fs;
    const target = await fs.resolve(path, { cwd: workdirOf(exec) });
    const info = await fs.stat(target, exec.signal);
    if (info === undefined || info.type !== "file") return { error: undefined };
    const cap = info.size === undefined ? config.maxFileBytes : Math.min(info.size, config.maxFileBytes);
    bytes = await fs.readBytes(target, exec.signal, cap);
    const hint = recordedEncodingHint(exec, target, info.version);
    // Admission runs FIRST, and the binary check follows it, because whether a
    // NUL byte means "binary" depends on the encoding: a UTF-32 file is mostly
    // NUL bytes by construction. Checking before admission would reject every
    // UTF-32 file — the one case this fallback path exists for.
    const decoded = await decodeForOpen(bytes, config, {
      displayPath: path,
      ...(hint === undefined ? {} : { encodingHint: hint }),
    });
    if (binaryInEncoding(bytes, decoded.encoding)) {
      // The refusal is about what RIPGREP would do with these bytes, not about
      // whether they are text: admission has already decoded the whole file and
      // the text is in hand. Which of the two it is decides whether ripgrep's
      // clean `text` rows are real lines, and only the bytes can say — see
      // {@link utf16NewlineOrder}. A file whose own line breaks sit on UTF-16
      // character boundaries is a UTF-16 file read as a legacy page, so those
      // rows are byte artifacts and the caller must replace them; anything else
      // decoded to real lines, and rewriting them would throw away text that was
      // decoded correctly.
      //
      // The odd alignment is asked as well, because a shifted UTF-16 file has no
      // evidence at all on the even one — see {@link utf16ShiftedOrder}, which is
      // where the measurement and the reason it is not folded into the function
      // above both live.
      return utf16NewlineOrder(bytes) === undefined && utf16ShiftedOrder(bytes) === undefined
        ? { error: undefined, decoded: true }
        : { error: undefined };
    }
    return { text: decoded.text, encoding: decoded.encoding };
  } catch (error) {
    // A NUL byte is the signal ripgrep itself uses to call a file binary, and
    // admission would name candidates for such bytes that mean nothing — so a
    // binary file keeps the bare placeholder and no candidates are reported. The
    // test belongs here rather than in the caller because the bytes are already
    // in hand: the caller used to re-read the file to ask this one question.
    // (Plain `looksBinary`, not `binaryInEncoding`: nothing decoded these bytes,
    // so there is no encoding whose NUL convention could excuse them.)
    if (bytes !== undefined && looksBinary(bytes)) return { error: undefined };
    return { error };
  }
}

/**
 * The session workspace root a search runs in.
 *
 * Mirrors `runRipgrep`'s own rule in the built-in package: the calling agent's
 * session cwd, never `process.cwd()`, which is the harness's launch directory
 * and would resolve a relative search root against the wrong place.
 *
 * @param exec - the calling tool execution.
 */
export function workdirOf(exec: ToolExecution): string {
  return exec.agent?.session.header.cwd ?? process.cwd();
}
