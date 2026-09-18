/**
 * `computeHunkDiffs` — the diff cards' line counts.
 *
 * The UI counts every line of a hunk's `oldText` as removed and every line of its
 * `newText` as added, so what this module returns IS the number the user sees. The
 * regression these tests lock down is that the tools used to hand the card the
 * full file texts, which made a one-line edit read as "changed 2,400 lines".
 *
 * The counts asserted here were measured against the harness's own
 * `structuredPatch`-based implementation (`dsh-tool-fs`) for the same inputs.
 */

import { describe, expect, it } from "vitest";
import {
  computeHunkDiffs,
  countLineChanges,
  countLines,
  DIFF_CONTEXT,
  MAX_EDIT_DISTANCE,
} from "../src/diff-hunks.js";
import { mk, uiCount } from "./diff-card-helpers.js";

describe("computeHunkDiffs", () => {
  it("reports a one-line edit as a few lines, not the whole file", () => {
    // The original bug: a 2400-line file with one line changed showed as
    // "+2400 -2400" because the whole text was passed through as one hunk.
    const before = mk(2400);
    const after = before.replace("line 1200", "LINE 1200");
    const diffs = computeHunkDiffs("f.txt", before, after);

    expect(diffs).toHaveLength(1);
    const { added, removed } = uiCount(diffs);
    // The changed line plus DIFF_CONTEXT on each side.
    expect(removed).toBe(1 + 2 * DIFF_CONTEXT);
    expect(added).toBe(1 + 2 * DIFF_CONTEXT);
  });

  it("returns nothing when the texts are identical", () => {
    expect(computeHunkDiffs("f.txt", mk(10), mk(10))).toEqual([]);
  });

  it("splits changes far apart into separate hunks", () => {
    // The case a prefix/suffix trim cannot handle: the unchanged span between
    // the two edits must NOT be counted. An earlier revision reported +40/-40
    // here where the harness reports +12/-12.
    const before = mk(40);
    const after = before.replace("line 3", "LINE 3").replace("line 38", "LINE 38");
    const diffs = computeHunkDiffs("f.txt", before, after);

    expect(diffs).toHaveLength(2);
    const { added, removed } = uiCount(diffs);
    expect(removed).toBe(12);
    expect(added).toBe(12);
  });

  it("keeps changes close together in one hunk", () => {
    const before = mk(40);
    const after = before.replace("line 10", "LINE 10").replace("line 12", "LINE 12");
    const diffs = computeHunkDiffs("f.txt", before, after);

    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 9, removed: 9 });
  });

  it("splits three scattered edits into three hunks", () => {
    const before = mk(100);
    const after = before.replace("line 5", "A").replace("line 50", "B").replace("line 95", "C");
    const diffs = computeHunkDiffs("f.txt", before, after);

    expect(diffs).toHaveLength(3);
    // Measured against the harness for this input.
    expect(uiCount(diffs)).toEqual({ added: 21, removed: 21 });
  });

  it("marks a pure insertion with oldText null", () => {
    // `null` and `""` are different answers: the UI reads null as "nothing was
    // removed", and "" would count as one removed line.
    const diffs = computeHunkDiffs("f.txt", "", "hello\nworld");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.oldText).toBeNull();
    expect(diffs[0]!.newText).toBe("hello\nworld");
  });

  it("counts an emptied file as removals only", () => {
    const diffs = computeHunkDiffs("f.txt", "hello\nworld", "");
    expect(uiCount(diffs)).toEqual({ added: 0, removed: 2 });
  });

  it("handles an edit at the very first and very last line", () => {
    const first = computeHunkDiffs("f.txt", mk(10), mk(10).replace("line 1", "LINE 1"));
    expect(uiCount(first)).toEqual({ added: 4, removed: 4 });

    const last = computeHunkDiffs("f.txt", mk(10), mk(10).replace("line 10", "LINE 10"));
    expect(uiCount(last)).toEqual({ added: 4, removed: 4 });
  });

  it("does not open a new line for a trailing newline", () => {
    // "a\n" is one line, not two — otherwise every save of a normal file would
    // count one extra line on both sides.
    const diffs = computeHunkDiffs("f.txt", "a\n", "b\n");
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
  });

  it("treats CRLF content as whole lines", () => {
    const before = mk(20).split("\n").join("\r\n");
    const after = before.replace("line 10", "LINE 10");
    const diffs = computeHunkDiffs("f.txt", before, after);
    expect(uiCount(diffs)).toEqual({ added: 7, removed: 7 });
  });

  it("stamps the given path on every hunk", () => {
    const before = mk(40);
    const after = before.replace("line 3", "LINE 3").replace("line 38", "LINE 38");
    for (const d of computeHunkDiffs("some/dir/file.txt", before, after)) {
      expect(d.path).toBe("some/dir/file.txt");
    }
  });

  it("handles a whole-file replacement", () => {
    const diffs = computeHunkDiffs("f.txt", mk(5), "completely\ndifferent\ncontent");
    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 3, removed: 5 });
  });

  it("handles duplicate lines without mis-aligning them", () => {
    // Repeated lines are where a naive LCS tie-break can produce a wildly
    // inflated edit script; the count must stay proportional to the real change
    // rather than growing with the file.
    //
    // Two hunks, not one: the file also gained a final newline (the input has
    // none, the output does), so its last line genuinely differs and Myers puts
    // the second edit at the far end of the run. Exact numbers, not an upper
    // bound — the output is deterministic, so a loose assertion would only hide
    // a regression.
    const before = Array.from({ length: 50 }, () => "same").join("\n");
    const after = before.replace("same", "CHANGED");
    const diffs = computeHunkDiffs("f.txt", before, after);
    expect(diffs).toHaveLength(2);
    expect(uiCount(diffs)).toEqual({ added: 8, removed: 8 });
  });

  it("keeps the count proportional when duplicate lines surround the change", () => {
    // The same edit on a file that ends with a newline on both sides: the final
    // line matches, so the second hunk is one line shorter.
    const before = Array.from({ length: 50 }, () => "same").join("\n") + "\n";
    const after = before.replace("same", "CHANGED");
    const diffs = computeHunkDiffs("f.txt", before, after);
    expect(diffs).toHaveLength(2);
    expect(uiCount(diffs)).toEqual({ added: 7, removed: 7 });
  });

  it("keeps an unambiguous change to one hunk", () => {
    // Distinct lines around the change remove the tie-break ambiguity, so the
    // card shows exactly the changed line plus its context.
    const before = mk(50) + "\n";
    const after = before.replace("line 25", "CHANGED");
    const diffs = computeHunkDiffs("f.txt", before, after);
    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 1 + 2 * DIFF_CONTEXT, removed: 1 + 2 * DIFF_CONTEXT });
  });

  it("reports a change that only adds the final newline", () => {
    // The file's bytes changed, so this is a change. Comparing line ARRAYS made
    // it invisible — and on `write`, an empty diff list makes the UI fall back to
    // the whole-file diff this module exists to remove.
    const diffs = computeHunkDiffs("f.txt", "a\nb", "a\nb\n");
    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 2, removed: 2 });
  });

  it("reports a change that only removes the final newline", () => {
    const diffs = computeHunkDiffs("f.txt", "a\nb\n", "a\nb");
    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 2, removed: 2 });
  });

  it("reports a single-line file gaining a newline", () => {
    const diffs = computeHunkDiffs("f.txt", "x", "x\n");
    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
  });

  it("does not leak the end-of-file marker into reported text", () => {
    // The marker that distinguishes `"a\nb"` from `"a\nb\n"` is internal: it must
    // never reach the card.
    const diffs = computeHunkDiffs("f.txt", "a\nb", "a\nB");
    expect(diffs[0]!.oldText).toBe("a\nb");
    expect(diffs[0]!.newText).toBe("a\nB");
    expect(JSON.stringify(diffs)).not.toContain("\u0000");
  });

  it("still reports both sides in full when one side has no newline", () => {
    // Appending to an unterminated file: both sides keep their own final-newline
    // state, so the last line differs and is reported.
    const diffs = computeHunkDiffs("f.txt", "a\nb", "a\nb\nc");
    expect(uiCount(diffs)).toEqual({ added: 3, removed: 2 });
  });
});

describe("computeHunkDiffs stays bounded on large rewrites", () => {
  it("falls back to one whole-file diff past the edit-distance bound", () => {
    // A rewrite is the case that used to allocate without limit: the trace grew
    // with the edit distance, and `Int32Array` storage is off-heap, so the
    // process consumed physical memory until it died. Past the bound the answer
    // is one region covering the file — bounded work, and what a reader wants.
    //
    // Every line differs, so the real edit distance is 2n and this crosses the
    // bound by construction; the assertion is that crossing it yields ONE region
    // rather than a partial or fragmented one.
    const n = MAX_EDIT_DISTANCE / 2 + 500;
    expect(2 * n).toBeGreaterThan(MAX_EDIT_DISTANCE);
    const before = Array.from({ length: n }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: n }, (_, i) => `new ${i}`).join("\n");

    const diffs = computeHunkDiffs("f.txt", before, after);

    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: n, removed: n });
    // The counts must agree with the same computation the message uses.
    expect(countLineChanges(before, after)).toEqual({ added: n, removed: n });
  });

  it("does not blow up on a large file rewritten as one line", () => {
    // Measured on the unbounded version: 30,000 lines truncated to one line
    // (311 KB of input) reached 3.8 GB and 9 seconds.
    const before = Array.from({ length: 30000 }, (_, i) => `line ${i}`).join("\n");
    const diffs = computeHunkDiffs("f.txt", before, "single line");

    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 30000 });
    expect(countLineChanges(before, "single line")).toEqual({ added: 1, removed: 30000 });
  });

  it("stays exact for a scattered edit far larger than a normal one", () => {
    // The bound has to sit above any edit a real call produces, or the counts
    // would silently become the two file sizes. 2,000 changed lines is well past
    // what a tool call does and must still be reported exactly.
    const before = mk(20000);
    const lines = before.split("\n");
    for (let i = 0; i < 2000; i += 1) lines[i * 10] = `CHANGED ${i}`;
    const after = lines.join("\n");

    const diffs = computeHunkDiffs("f.txt", before, after);

    // Every changed line is 10 apart, so each is its own hunk. The FIRST hunk sits
    // at the start of the file, where the changed line has no leading context —
    // it holds the changed line plus DIFF_CONTEXT trailing lines instead of
    // 1 + 2*DIFF_CONTEXT.
    expect(diffs).toHaveLength(2000);
    const perHunk = 1 + 2 * DIFF_CONTEXT;
    const atFileStart = 1 + DIFF_CONTEXT;
    expect(uiCount(diffs)).toEqual({
      added: 1999 * perHunk + atFileStart,
      removed: 1999 * perHunk + atFileStart,
    });
  });

  it("counts a degraded rewrite with the same line rule as `read`", () => {
    // The degraded path reports the two file sizes, and it must measure them the
    // way every other path does. `toLines` carries each line's newline, so text
    // that is only a newline is ONE line to it — but `read` reports `totalLines:
    // 0` for that content and `countLines` agrees. Reporting the raw array length
    // would claim a removed line where the model was told there are none.
    const huge = Array.from({ length: 7000 }, (_, i) => `x${i}`).join("\n");

    for (const onlyNewlines of ["\n", "\n\n", "\n\n\n"]) {
      const count = countLineChanges(onlyNewlines, huge);
      const diffs = computeHunkDiffs("f.txt", onlyNewlines, huge);

      expect(diffs).toHaveLength(1);
      // The message's numbers follow `countLines`, the same rule `read` uses.
      expect(count.removed).toBe(countLines(onlyNewlines));
      expect(count.added).toBe(countLines(huge));
      // The card is a separate rendering and may differ for all-blank content
      // (a hunk's text is rebuilt by joining lines, which cannot preserve a
      // leading blank line); what matters is that it never exceeds the truth.
      expect(uiCount(diffs).removed).toBeLessThanOrEqual(count.removed);
    }
  });
});
