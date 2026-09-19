/**
 * `line-edit` — the arithmetic behind `insert` and `str_replace_editor`.
 *
 * The insert direction is the part worth pinning down: `insert_line` names the
 * line to insert AFTER, which is Anthropic's definition and the harness's, and a
 * number that is valid under both readings cannot be told apart at runtime. An
 * implementation that got it backwards would silently misplace every call, so the
 * tests below fix the direction explicitly rather than describing it.
 */

import { describe, expect, it } from "vitest";
import {
  countInsertedLines,
  countVisibleLines,
  hasLoneCarriageReturn,
  insertAfterLine,
  insertedLines,
  occurrenceLines,
  replaceMatches,
  sliceLines,
  splitForEdit,
} from "../src/line-edit.js";
import { splitLines } from "../src/line-endings.js";

describe("splitForEdit", () => {
  it("does not open a line for a trailing newline", () => {
    expect(splitForEdit("a\nb\n")).toEqual(["a", "b"]);
    expect(splitForEdit("a\nb")).toEqual(["a", "b"]);
  });

  it("returns no lines for empty text", () => {
    expect(splitForEdit("")).toEqual([]);
  });

  it("keeps blank lines inside the text", () => {
    expect(splitForEdit("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("agrees with the line count `read` reports", () => {
    // `read` numbers lines the same way, so `insert_line` values a model read off
    // the file are valid here.
    expect(splitForEdit("x\ny\nz\n")).toHaveLength(3);
  });
});

describe("insertAfterLine — the AFTER direction", () => {
  it("inserts after the named line, not before it", () => {
    // The decisive assertion: line 1 stays first and the new text lands between
    // line 1 and line 2.
    expect(insertAfterLine("l1\nl2\nl3\n", 1, "NEW")).toBe("l1\nNEW\nl2\nl3\n");
  });

  it("treats 0 as the very top", () => {
    expect(insertAfterLine("l1\nl2\n", 0, "NEW")).toBe("NEW\nl1\nl2\n");
  });

  it("appends when the line number equals the line count", () => {
    expect(insertAfterLine("l1\nl2\n", 2, "NEW")).toBe("l1\nl2\nNEW\n");
  });

  it("inserts into an empty file", () => {
    expect(insertAfterLine("", 0, "first")).toBe("first\n");
  });

  it("keeps a file's missing trailing newline", () => {
    // The file had none, so the save must not invent one.
    expect(insertAfterLine("l1\nl2", 1, "NEW")).toBe("l1\nNEW\nl2");
  });

  it("keeps a file's trailing newline", () => {
    expect(insertAfterLine("l1\nl2\n", 1, "NEW")).toBe("l1\nNEW\nl2\n");
  });

  it("inserts multi-line text", () => {
    expect(insertAfterLine("l1\nl2\n", 1, "a\nb")).toBe("l1\na\nb\nl2\n");
  });

  it("keeps a trailing newline on the inserted text", () => {
    // `new_string: "a\n"` means a blank line follows; dropping it would lose a
    // line the model asked for.
    expect(insertAfterLine("l1\nl2\n", 1, "a\n")).toBe("l1\na\n\nl2\n");
  });

  it("rejects a line number past the end", () => {
    expect(() => insertAfterLine("l1\nl2\n", 3, "NEW")).toThrow(RangeError);
  });

  it("rejects a negative line number", () => {
    expect(() => insertAfterLine("l1\n", -1, "NEW")).toThrow(RangeError);
  });

  it("rejects a non-integer line number", () => {
    expect(() => insertAfterLine("l1\n", 1.5, "NEW")).toThrow(RangeError);
  });

  it("accepts the whole documented range", () => {
    for (const line of [0, 1, 2, 3]) {
      expect(() => insertAfterLine("a\nb\nc\n", line, "x")).not.toThrow();
    }
  });
});

describe("countInsertedLines", () => {
  it("counts what the splice actually inserts", () => {
    expect(countInsertedLines("x")).toBe(1);
    expect(countInsertedLines("a\nb\nc")).toBe(3);
    // "a\n" opens a line AND a blank line after it — the splice appends an entry.
    expect(countInsertedLines("a\n")).toBe(2);
    // An empty insert is one blank line, not nothing: reporting 0 would tell the
    // model its blank-line insertion did nothing while the file gained a line.
    expect(countInsertedLines("")).toBe(1);
  });

  it("follows one rule for every text, not a table of special cases", () => {
    // The shared-formula assertions below compare `insertedLines` with itself, so
    // they cannot see a wrong RULE — only a wrong placement. The rule is therefore
    // restated here, independently of the implementation, and checked across the
    // shapes it has to cover: every terminator opens a line, and a trailing
    // terminator opens one more (the blank line after it). Enumerating a few inputs
    // instead would leave `"\n\n\n\n"` and long texts free to drift.
    const rule = (text: string): number => {
      if (text === "") return 1;
      const terminators = (text.match(/\n/g) ?? []).length;
      return terminators + 1;
    };
    const shapes = [
      "", "\n", "\n\n", "\n\n\n", "\n\n\n\n", "\n\n\n\n\n",
      "x", "x\n", "x\n\n", "\n \n", " \n", "x\n".repeat(200),
    ];
    for (const text of shapes) {
      expect(countInsertedLines(text), `text=${JSON.stringify(text).slice(0, 30)}`).toBe(rule(text));
    }
    // And the values a reader would check by hand, pinned so the rule cannot drift
    // together with its restatement.
    expect(countInsertedLines("\n")).toBe(2);
    expect(countInsertedLines("\n\n")).toBe(3);
    expect(countInsertedLines("\n\n\n")).toBe(4);
    expect(countInsertedLines("\n\n\n\n")).toBe(5);
    expect(countInsertedLines("x\n".repeat(200))).toBe(201);
  });

  it("places a newline-only insert as blank lines, not as a single terminator", () => {
    // `new_string: "\n"` must add a blank line after the named one, not merely
    // terminate it — the mutation this pins changed the file by one whole line.
    expect(insertAfterLine("l1\nl2\n", 1, "\n")).toBe("l1\n\n\nl2\n");
    expect(insertAfterLine("l1\nl2\n", 0, "\n\n")).toBe("\n\n\nl1\nl2\n");
    expect(insertAfterLine("a\nb\n", 2, "\n\n\n\n")).toBe("a\nb\n\n\n\n\n\n");
  });

  it("places exactly the reported entries between the untouched halves", () => {
    // The expected text is rebuilt from `insertedLines` and compared byte-for-byte
    // with `insertAfterLine`'s output, so a splice that drops, duplicates or
    // misplaces an entry fails here. It does NOT pin `insertedLines`' own rule —
    // that is what the hard-coded counts in the case above are for; this one covers
    // the placement and the agreement between the splice and the reported size.
    const files = ["", "a", "a\n", "a\nb", "a\nb\n", "\n", "\n\n", "l1\nl2\nl3\n"];
    const texts = ["", "\n", "X", "X\n", "a\nb", "a\nb\n", "\n\n"];
    let checked = 0;

    for (const before of files) {
      const beforeLines = splitForEdit(before);
      for (const at of [0, Math.floor(beforeLines.length / 2), beforeLines.length]) {
        for (const nt of texts) {
          const after = insertAfterLine(before, at, nt);
          const added = insertedLines(nt);
          const spliced = [
            ...beforeLines.slice(0, at),
            ...added,
            ...beforeLines.slice(at),
          ].join("\n");
          // An insert into an empty file always ends terminated; otherwise the file's
          // own trailing-newline state is preserved.
          const expected = before === "" || before.endsWith("\n") ? `${spliced}\n` : spliced;

          expect(
            after,
            `before=${JSON.stringify(before)} at=${at} newText=${JSON.stringify(nt)}`,
          ).toBe(expected);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(files.length * 3 * texts.length);
  });
});

describe("countVisibleLines / sliceLines", () => {
  it("counts the way splitLines does, without allocating", () => {
    for (const text of ["", "\n", "a", "a\n", "a\nb", "a\nb\n", "\n\n", "a\n\nb\n", "\n\na\n"]) {
      const viaSplit = (() => {
        const all = splitLines(text);
        return all.length === 1 && all[0] === "" ? 0 : all.length;
      })();
      expect(countVisibleLines(text), JSON.stringify(text)).toBe(viaSplit);
    }
  });

  it("treats a lone newline as zero lines, like read's totalLines", () => {
    // `read` reports 0 here and `diff-hunks.countLines` agrees; `view` must not
    // publish a different total for the same file.
    expect(countVisibleLines("\n")).toBe(0);
    expect(countVisibleLines("")).toBe(0);
    expect(countVisibleLines("\n\n")).toBe(2);
  });

  it("slices exactly the lines splitForEdit would", () => {
    const text = "l1\nl2\nl3\nl4\nl5\n";
    for (let start = 1; start <= 6; start += 1) {
      for (let count = 0; count <= 4; count += 1) {
        expect(sliceLines(text, start, count), `start=${start} count=${count}`).toEqual(
          splitForEdit(text).slice(start - 1, start - 1 + count),
        );
      }
    }
  });

  it("does not open a line for a trailing newline", () => {
    expect(sliceLines("a\n", 2, 5)).toEqual([]);
    expect(sliceLines("a\nb", 2, 5)).toEqual(["b"]);
    expect(countVisibleLines("a\n")).toBe(1);
    expect(countVisibleLines("a\nb")).toBe(2);
  });
});

describe("hasLoneCarriageReturn", () => {
  it("detects a classic-Mac terminator", () => {
    expect(hasLoneCarriageReturn("a\rb")).toBe(true);
  });

  it("accepts CRLF and LF files", () => {
    expect(hasLoneCarriageReturn("a\r\nb\r\n")).toBe(false);
    expect(hasLoneCarriageReturn("a\nb\n")).toBe(false);
    expect(hasLoneCarriageReturn("")).toBe(false);
  });

  it("detects a lone CR mixed into a CRLF file", () => {
    expect(hasLoneCarriageReturn("a\r\nb\rc")).toBe(true);
  });
});

describe("replaceMatches", () => {
  it("replaces a unique match", () => {
    expect(replaceMatches("a\nb\nc\n", "b", "B", false)).toEqual({
      text: "a\nB\nc\n",
      replaced: 1,
    });
  });

  it("reports zero without changing anything when there is no match", () => {
    expect(replaceMatches("a\n", "zzz", "X", false)).toEqual({ text: "a\n", replaced: 0 });
  });

  it("reports the count and refuses when the match is ambiguous", () => {
    // The caller turns `replaced > 1` with `replaceAll: false` into
    // FS_AMBIGUOUS_EDIT; the text must come back untouched so nothing is written.
    const result = replaceMatches("x\nx\n", "x", "Y", false);
    expect(result.replaced).toBe(2);
    expect(result.text).toBe("x\nx\n");
  });

  it("replaces every occurrence when replaceAll is set", () => {
    expect(replaceMatches("x\nx\n", "x", "Y", true)).toEqual({
      text: "Y\nY\n",
      replaced: 2,
    });
  });

  it("supports deleting a match with an empty replacement", () => {
    expect(replaceMatches("a\nb\n", "b\n", "", false)).toEqual({ text: "a\n", replaced: 1 });
  });

  it("refuses an empty old_str", () => {
    // An empty needle matches at every position; `split`/`join` would then
    // interleave the replacement between every character.
    expect(() => replaceMatches("abc", "", "X", false)).toThrow(RangeError);
  });

  it("does not treat the replacement as a pattern", () => {
    // `$&` and friends are literal text here, not `String.replace` syntax.
    expect(replaceMatches("a\n", "a", "$&$1", false).text).toBe("$&$1\n");
  });

  it("counts non-overlapping occurrences", () => {
    expect(replaceMatches("aaaa", "aa", "b", true)).toEqual({ text: "bb", replaced: 2 });
  });
});

describe("occurrenceLines", () => {
  it("reports the 1-based line of each occurrence", () => {
    expect(occurrenceLines("x\ny\nx\n", "x")).toEqual([1, 3]);
  });

  it("reports both occurrences on the same line", () => {
    expect(occurrenceLines("x x\n", "x")).toEqual([1, 1]);
  });

  it("returns nothing when there is no match", () => {
    expect(occurrenceLines("a\n", "zzz")).toEqual([]);
  });

  it("returns nothing for an empty needle", () => {
    expect(occurrenceLines("a\n", "")).toEqual([]);
  });
});
