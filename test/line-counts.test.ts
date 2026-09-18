/**
 * `countLineChanges` / `formatLineChangeSummary` / `countLines` — the numbers
 * reported to the MODEL.
 *
 * These are deliberately separate from the numbers the UI renders. A diff region
 * carries up to `DIFF_CONTEXT` unchanged lines on each side so a human can read
 * it; counting those would report a one-line edit as "added 7, removed 7". The
 * model's summary has to be the real edit, so it is counted from the edit script
 * with the context excluded. The tests below pin that distinction: the same input
 * produces 7 lines in the UI card and 1 added / 1 removed in the message.
 */

import { describe, expect, it } from "vitest";
import {
  computeHunkDiffs,
  countLineChanges,
  countLines,
  formatChangeParenthetical,
  formatLineChangeSummary,
} from "../src/diff-hunks.js";

const mk = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("countLineChanges", () => {
  it("counts a one-line replacement as one added and one removed", () => {
    // The distinction that matters: the UI card shows 7 lines for this input
    // (the change plus context), the message must say 1 and 1.
    const before = mk(2400);
    const after = before.replace("line 1200", "LINE 1200");

    expect(countLineChanges(before, after)).toEqual({ added: 1, removed: 1 });

    const cardLines = computeHunkDiffs("f.txt", before, after)[0]!;
    expect(cardLines.oldText!.split("\n")).toHaveLength(7);
  });

  it("reports nothing for identical texts", () => {
    expect(countLineChanges(mk(10), mk(10))).toEqual({ added: 0, removed: 0 });
  });

  it("counts a pure insertion as added only", () => {
    expect(countLineChanges("a\nb\n", "a\nb\nc\n")).toEqual({ added: 1, removed: 0 });
  });

  it("counts a pure deletion as removed only", () => {
    expect(countLineChanges("a\nb\nc\n", "a\nc\n")).toEqual({ added: 0, removed: 1 });
  });

  it("counts every line of a multi-line replacement", () => {
    expect(countLineChanges("a\nb\nc\nd\n", "a\nX\nY\nZ\nd\n")).toEqual({
      added: 3,
      removed: 2,
    });
  });

  it("does not count the unchanged lines between two distant edits", () => {
    // The whole point of a real diff: the span between the edits is untouched and
    // must not be counted.
    const before = mk(100);
    const after = before.replace("line 5", "A").replace("line 95", "C");
    expect(countLineChanges(before, after)).toEqual({ added: 2, removed: 2 });
  });

  it("counts a whole-file replacement fully", () => {
    expect(countLineChanges("a\nb\n", "x\ny\nz\n")).toEqual({ added: 3, removed: 2 });
  });

  it("handles creation and emptying", () => {
    expect(countLineChanges("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
    expect(countLineChanges("a\nb\n", "")).toEqual({ added: 0, removed: 2 });
  });
});

describe("formatLineChangeSummary", () => {
  it("formats the counts in the shape dsh-better-edit uses", () => {
    expect(formatLineChangeSummary({ added: 3, removed: 2 })).toBe(
      " Added 3 line(s), removed 2 line(s).",
    );
  });

  it("renders an empty string when nothing changed", () => {
    // So the caller can concatenate unconditionally without leaving a stray
    // "Added 0 line(s), removed 0 line(s)." on a no-op.
    expect(formatLineChangeSummary({ added: 0, removed: 0 })).toBe("");
  });

  it("still reports a one-sided change", () => {
    expect(formatLineChangeSummary({ added: 5, removed: 0 })).toBe(
      " Added 5 line(s), removed 0 line(s).",
    );
  });
});

describe("formatChangeParenthetical", () => {
  it("formats the counts for the write result block", () => {
    expect(formatChangeParenthetical({ added: 3, removed: 2 })).toBe(
      " (added 3, removed 2 line(s))",
    );
  });

  it("renders an empty string when nothing changed", () => {
    expect(formatChangeParenthetical({ added: 0, removed: 0 })).toBe("");
  });
});

describe("countLines", () => {
  it("does not count a trailing newline as opening a line", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
  });

  it("returns zero for empty text", () => {
    expect(countLines("")).toBe(0);
  });

  it("counts a single unterminated line as one", () => {
    expect(countLines("only")).toBe(1);
  });

  it("counts blank lines inside the text", () => {
    expect(countLines("a\n\nb\n")).toBe(3);
  });

  it("agrees with `read`'s totalLines on whitespace-only text", () => {
    // `read` reports `totalLines: 0` for text that is nothing but newlines (see
    // `line-endings.splitLines` + `tool-read`). The two are the same model-facing
    // vocabulary: a model told "Created file (1 line(s))" must not read it back
    // as "0 lines".
    expect(countLines("\n")).toBe(0);
    expect(countLines("\n\n")).toBe(2);
  });
});
