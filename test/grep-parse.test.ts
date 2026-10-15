/**
 * Unit tests for the encoding-aware search core.
 *
 * These cover the pure functions — the NDJSON parser, the encoding-label map,
 * the merge, and the placeholder wording. They are the half of `grep` that can
 * be tested without a subprocess, a filesystem or a ripgrep binary, so they run
 * fast and pin the behaviour that the integration suite then exercises
 * end-to-end.
 *
 * The parser gets the most attention because it is the reason this module
 * exists: the built-in's parser collapses a `lines.bytes` row into a placeholder
 * string, and the raw bytes are unrecoverable afterwards.
 */

import { describe, expect, it } from "vitest";
import {
  filesNeedingDecoding,
  looksBinary,
  mergeMatches,
  parseRgJson,
  placeholderFor,
  provedFiles,
  rgLabelFor,
  searchDecodedText,
  type DecodedMatch,
  type RawMatch,
} from "../src/grep-search.js";

/**
 * One `RawMatch` for the pure-function tests.
 *
 * The interface carries the one bit a caller asks of a submatch — whether it
 * holds a non-ASCII character — rather than the texts, so that the parse sites
 * which ignore it pay nothing. The helper takes the texts and derives that bit,
 * which keeps the test bodies about the RULE under test.
 *
 * @param fields - the row's fields, with `submatches` given as plain texts.
 */
function row(fields: {
  path: string;
  lineNumber: number;
  text?: string;
  bytes?: Uint8Array;
  submatches?: readonly string[];
}): RawMatch {
  const { submatches = [], ...rest } = fields;
  return { ...rest, submatchEvidence: hasEvidence(submatches) };
}

/** Whether any of these submatch texts is evidence, by the production rule. */
function hasEvidence(submatches: readonly string[]): boolean {
  return submatches.some((sub) => [...sub].some((ch) => ch !== "\uFFFD" && ch.codePointAt(0)! > 0x7f));
}

/** One `rg --json` match record carrying UTF-8 text. */
function textRecord(
  path: string,
  lineNumber: number,
  text: string,
  submatches: readonly string[] = [],
): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      line_number: lineNumber,
      lines: { text },
      submatches: submatches.map((m) => ({ match: { text: m } })),
    },
  });
}

/** One `rg --json` match record carrying base64 bytes. */
function bytesRecord(path: string, lineNumber: number, bytes: Buffer): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      line_number: lineNumber,
      lines: { bytes: bytes.toString("base64") },
    },
  });
}

describe("parseRgJson", () => {
  it("reads a text row and strips its trailing newline", () => {
    const out = parseRgJson(textRecord("a.txt", 3, "hello world\r\n"));
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("a.txt");
    expect(out[0]?.lineNumber).toBe(3);
    expect(out[0]?.text).toBe("hello world");
    expect(out[0]?.submatchEvidence).toBe(false);
  });

  it("records submatch evidence for a non-ASCII match", () => {
    // The one bit a page's claim is checked against. The texts themselves are not
    // kept, because no caller wants them and they cost heap at the stdout cap.
    const out = parseRgJson(textRecord("a.txt", 1, "x 配置 y\n", ["配置", "x"]));
    expect(out[0]?.submatchEvidence).toBe(true);
  });

  it("reads submatch evidence from an undecodable row too", () => {
    // A `bytes` row can carry submatches; the flag is recorded even though such a
    // row cannot itself prove anything (see `provedFiles`).
    const stdout = JSON.stringify({
      type: "match",
      data: {
        path: { text: "a.txt" },
        line_number: 1,
        lines: { bytes: Buffer.from("c5e4d6c3", "hex").toString("base64") },
        submatches: [{ match: { text: "配置" } }],
      },
    });
    const out = parseRgJson(stdout);
    expect(out[0]?.text).toBeUndefined();
    expect(out[0]?.submatchEvidence).toBe(true);
  });

  it("does not treat an ASCII submatch or a replacement character as evidence", () => {
    // `read` is the same bytes under every page, and U+FFFD is what a decoder
    // synthesises for a byte it could not map — neither distinguishes a page.
    expect(parseRgJson(textRecord("a.txt", 1, "read\n", ["read"]))[0]?.submatchEvidence).toBe(false);
    expect(parseRgJson(textRecord("a.txt", 1, "\uFFFD\n", ["\uFFFD"]))[0]?.submatchEvidence).toBe(false);
  });

  it("tolerates malformed submatch entries rather than failing the row", () => {
    const stdout = JSON.stringify({
      type: "match",
      data: {
        path: { text: "a.txt" },
        line_number: 1,
        lines: { text: "x 配置\n" },
        submatches: [{ match: {} }, { nope: 1 }, null, { match: { text: "配置" } }],
      },
    });
    expect(parseRgJson(stdout)[0]?.submatchEvidence).toBe(true);
  });

  it("keeps the RAW BYTES of an undecodable row instead of a placeholder", () => {
    // The GBK encoding of "配置项" — not valid UTF-8, which is exactly why
    // ripgrep emits `bytes` rather than `text`.
    const gbk = Buffer.from("c5e4d6c3cfee", "hex");
    const out = parseRgJson(bytesRecord("a.txt", 1, gbk));
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBeUndefined();
    expect(Buffer.from(out[0]?.bytes ?? []).toString("hex")).toBe("c5e4d6c3cfee");
  });

  it("preserves both representations within one file", () => {
    // A per-LINE distinction, not a per-file one: the ASCII line is `text` and
    // the line holding non-ASCII bytes is `bytes`, in the same file.
    const stdout = [
      textRecord("a.txt", 1, "PORT=8080\r\n"),
      bytesRecord("a.txt", 2, Buffer.from("504f5254c5e4d6c3", "hex")),
    ].join("\n");
    const out = parseRgJson(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toBe("PORT=8080");
    expect(out[1]?.text).toBeUndefined();
    expect(out[1]?.bytes).toBeDefined();
  });

  it("ignores the non-match record types ripgrep emits", () => {
    const stdout = [
      JSON.stringify({ type: "begin", data: { path: { text: "a.txt" } } }),
      textRecord("a.txt", 1, "x\n"),
      JSON.stringify({ type: "end", data: { path: { text: "a.txt" } } }),
      JSON.stringify({ type: "summary", data: {} }),
    ].join("\n");
    expect(parseRgJson(stdout)).toHaveLength(1);
  });

  it("skips malformed lines rather than failing the whole search", () => {
    // A truncated read is a partial result, not a caller error: failing here
    // would turn "some matches" into "no matches".
    const stdout = ["not json at all", textRecord("a.txt", 1, "ok\n"), "{\"broken\":"].join("\n");
    const out = parseRgJson(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("a.txt");
    expect(out[0]?.lineNumber).toBe(1);
    expect(out[0]?.text).toBe("ok");
  });

  it("skips records missing the fields a match needs", () => {
    const stdout = [
      JSON.stringify({ type: "match", data: { line_number: 1, lines: { text: "x" } } }),
      JSON.stringify({ type: "match", data: { path: { text: "a" }, lines: { text: "x" } } }),
      JSON.stringify({ type: "match", data: { path: { text: "a" }, line_number: 1 } }),
      JSON.stringify({ type: "match", data: { path: { text: "a" }, line_number: 1, lines: {} } }),
    ].join("\n");
    expect(parseRgJson(stdout)).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(parseRgJson("")).toEqual([]);
  });
});

describe("filesNeedingDecoding", () => {
  it("names each file with an undecodable row exactly once, in first-seen order", () => {
    const out = filesNeedingDecoding([
      row({ path: "b.txt", lineNumber: 1, bytes: new Uint8Array([1]) }),
      row({ path: "a.txt", lineNumber: 1, bytes: new Uint8Array([2]) }),
      row({ path: "b.txt", lineNumber: 2, bytes: new Uint8Array([3]) }),
    ]);
    expect(out).toEqual(["b.txt", "a.txt"]);
  });

  it("excludes files whose rows all decoded", () => {
    expect(filesNeedingDecoding([row({ path: "a.txt", lineNumber: 1, text: "ok" })])).toEqual([]);
  });
});

describe("provedFiles", () => {
  it("proves a file only through a submatch holding a non-ASCII character", () => {
    // The distinction the whole fix rests on: a MATCH is not a proof. This row
    // matched, but its submatch is the ASCII alternative, which every page
    // produces — so nothing here says the page decoded the file.
    const rows = [
      row({ path: "a.txt", lineNumber: 1, text: "x read y", submatches: ["read"] }),
      row({ path: "b.txt", lineNumber: 1, text: "x 配置 y", submatches: ["配置"] }),
    ];
    expect(provedFiles(rows)).toEqual(["b.txt"]);
  });

  it("claims nothing for an ASCII-only submatch", () => {
    // `read` is the same bytes under every page, so it distinguishes none of
    // them and proves nothing — which is what rules out `配置|read`'s ASCII half.
    expect(provedFiles([row({ path: "a.txt", lineNumber: 1, text: "read", submatches: ["read"] })])).toEqual(
      [],
    );
  });

  it("proves the whole FILE, so an ASCII-only row of a proved file comes along", () => {
    // The file-level granularity is what carries `配置|read`'s ASCII half: one
    // proving row vouches for every row of the same file, because `--encoding`
    // transcoded all of it in the same pass.
    const rows = [
      row({ path: "a.txt", lineNumber: 1, text: "# 端口配置", submatches: ["配置"] }),
      row({ path: "a.txt", lineNumber: 2, text: "PORT=8080 read this", submatches: ["read"] }),
    ];
    expect(provedFiles(rows)).toEqual(["a.txt"]);
  });

  it("proves each file once, in first-seen order", () => {
    const rows = [
      row({ path: "b.txt", lineNumber: 1, text: "配置", submatches: ["配置"] }),
      row({ path: "a.txt", lineNumber: 1, text: "配置", submatches: ["配置"] }),
      row({ path: "b.txt", lineNumber: 2, text: "配置", submatches: ["配置"] }),
    ];
    expect(provedFiles(rows)).toEqual(["b.txt", "a.txt"]);
  });

  it("does NOT require the submatch to spell a character the pattern holds", () => {
    // The regression this replaced: `[一-龥]` matches Chinese without ever
    // spelling `一` or `龥`, and `(?i)привет` matches `ПРИВЕТ`, whose characters
    // the pattern does not hold. Measured, requiring a pattern character left a
    // GBK file unreported — a silent `Found 0 matches`.
    const charClass = [row({ path: "a.txt", lineNumber: 1, text: "// 端口配置", submatches: ["端口配置"] })];
    expect(provedFiles(charClass)).toEqual(["a.txt"]);
    const folded = [row({ path: "b.txt", lineNumber: 1, text: "// ПРИВЕТ", submatches: ["ПРИВЕТ"] })];
    expect(provedFiles(folded)).toEqual(["b.txt"]);
  });

  it("treats U+FFFD as no evidence, because a decoder synthesises it", () => {
    // A page that cannot map a byte emits U+FFFD for it, so its presence says the
    // decode FAILED rather than that it mapped anything. Measured, ripgrep's
    // UTF-16 decoder synthesises it for a lone surrogate, which was enough to let
    // a `utf-16le` page "prove" a plain UTF-8 file and overwrite its text.
    expect(
      provedFiles([row({ path: "a.txt", lineNumber: 1, text: "뿯䆽胘\uFFFD", submatches: ["\uFFFD"] })]),
    ).toEqual([]);
  });

  it("ignores rows this page could not decode", () => {
    // A `bytes` row means the page did not decode the file, so it cannot speak
    // for that page however its submatches read.
    const rows = [
      row({
        path: "a.txt",
        lineNumber: 1,
        bytes: new Uint8Array([1]),
        submatches: ["配置"],
      }),
    ];
    expect(provedFiles(rows)).toEqual([]);
  });
});

describe("rgLabelFor", () => {
  it("maps the canonical names ripgrep accepts", () => {
    expect(rgLabelFor("gbk")).toBe("gbk");
    expect(rgLabelFor("big5")).toBe("big5");
    expect(rgLabelFor("utf8")).toBe("utf-8");
    expect(rgLabelFor("utf16le")).toBe("utf-16le");
    // Punctuation differs between the plugin's vocabulary and ripgrep's labels.
    expect(rgLabelFor("shift_jis")).toBe("shift-jis");
  });

  it("maps a BOM-carrying UTF-8 file onto plain utf-8", () => {
    // The mark is the decoder's business, not the search's: both names read the
    // same bytes the same way.
    expect(rgLabelFor("utf8bom")).toBe("utf-8");
  });

  it("reports UTF-32 as unsupported, because ripgrep has no such encoding", () => {
    // Measured: `--encoding=utf-32le` exits 2 with "unknown encoding", and
    // without the flag ripgrep does not find the text either.
    expect(rgLabelFor("utf32le")).toBeUndefined();
    expect(rgLabelFor("utf32be")).toBeUndefined();
  });
});

describe("mergeMatches", () => {
  it("lets a later pass replace an earlier placeholder for the same line", () => {
    const pass1: DecodedMatch[] = [
      { path: "a.txt", lineNumber: 1, line: placeholderFor([]) },
    ];
    const pass2: DecodedMatch[] = [{ path: "a.txt", lineNumber: 1, line: "配置项" }];
    expect(mergeMatches([pass1, pass2])).toEqual([{ path: "a.txt", lineNumber: 1, line: "配置项" }]);
  });

  it("does not duplicate a line seen by both passes", () => {
    const pass1: DecodedMatch[] = [
      { path: "a.txt", lineNumber: 1, line: "x" },
      { path: "a.txt", lineNumber: 2, line: placeholderFor([]) },
    ];
    const pass2: DecodedMatch[] = [{ path: "a.txt", lineNumber: 2, line: "y" }];
    expect(mergeMatches([pass1, pass2])).toHaveLength(2);
  });

  it("orders files by first appearance and lines ascending within a file", () => {
    const out = mergeMatches([
      [
        { path: "b.txt", lineNumber: 9, line: "x" },
        { path: "a.txt", lineNumber: 5, line: "y" },
        { path: "b.txt", lineNumber: 2, line: "z" },
      ],
    ]);
    expect(out.map((m) => `${m.path}:${m.lineNumber}`)).toEqual(["b.txt:2", "b.txt:9", "a.txt:5"]);
  });

  it("keeps a pass-2-only file in a stable position", () => {
    const out = mergeMatches([
      [{ path: "a.txt", lineNumber: 1, line: placeholderFor([]) }],
      [
        { path: "a.txt", lineNumber: 1, line: "decoded" },
        { path: "b.txt", lineNumber: 1, line: "only in pass 2" },
      ],
    ]);
    expect(out.map((m) => m.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("returns nothing for no passes", () => {
    expect(mergeMatches([])).toEqual([]);
  });
});

describe("placeholderFor", () => {
  it("matches the built-in wording when there is nothing to suggest", () => {
    expect(placeholderFor([])).toBe("(line is not valid UTF-8)");
  });

  it("names the candidates when there are any, because that is the remedy", () => {
    expect(placeholderFor(["gbk", "big5"])).toBe(
      "(line is not valid UTF-8 — candidates: gbk, big5)",
    );
  });
});

describe("looksBinary", () => {
  it("treats a NUL byte as binary, the signal ripgrep itself uses", () => {
    expect(looksBinary(new Uint8Array([0x41, 0x00, 0x42]))).toBe(true);
  });

  it("does not call ordinary legacy text binary", () => {
    // GBK "配置项" — high bytes but no NUL.
    expect(looksBinary(new Uint8Array([0xc5, 0xe4, 0xd6, 0xc3, 0xcf, 0xee]))).toBe(false);
  });
});

describe("searchDecodedText", () => {
  it("reports 1-based line numbers of matching lines", () => {
    const out = searchDecodedText("alpha\n配置项\nbeta\n配置项\n", "配置项", "a.txt");
    expect(out).toEqual([
      { path: "a.txt", lineNumber: 2, line: "配置项" },
      { path: "a.txt", lineNumber: 4, line: "配置项" },
    ]);
  });

  it("handles CRLF input without leaving the carriage return in the line", () => {
    const out = searchDecodedText("a\r\nb\r\n", "^b$", "a.txt");
    expect(out).toEqual([{ path: "a.txt", lineNumber: 2, line: "b" }]);
  });

  it("throws for a pattern JavaScript cannot compile", () => {
    // `(?i)` is ripgrep syntax; the fallback path is JavaScript, so the caller
    // has to be able to report the difference rather than swallow it.
    expect(() => searchDecodedText("x", "(?i)hello", "a.txt")).toThrow(SyntaxError);
  });
});
