/**
 * `computeHunkDiffs` — the diff cards' line counts.
 *
 * The UI counts every line of a hunk's `oldText` as removed and every line of its
 * `newText` as added, so what this module returns IS the number the user sees. Two
 * regressions are locked down here:
 *
 * 1. The tools used to hand the card the full file texts, which made a one-line
 *    edit read as "changed 2,400 lines".
 * 2. With `DIFF_CONTEXT = 3` the card carried context lines, and the UI renders
 *    every line of `oldText` as a deletion and every line of `newText` as an
 *    addition — so each context line appeared TWICE, as removed and as added, and
 *    a one-line edit still read as "deleted 7, added 7". The counts below are now
 *    the real changed lines, matching what the message reports.
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
  it("ships no context lines, so the card cannot show an unchanged line", () => {
    // The property everything below depends on: `FileDiff` has no way to mark a
    // line as context, so any context line is rendered as a deletion AND an
    // addition. Zero is the only value that keeps the card honest.
    expect(DIFF_CONTEXT).toBe(0);
  });

  it("reports a one-line edit as exactly one line", () => {
    // The original bug: a 2400-line file with one line changed showed as
    // "+2400 -2400" because the whole text was passed through as one hunk. The
    // card must now agree with `countLineChanges`, which is what the message says.
    const before = mk(2400);
    const after = before.replace("line 1200", "LINE 1200");
    const diffs = computeHunkDiffs("f.txt", before, after);

    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
    expect(uiCount(diffs)).toEqual(countLineChanges(before, after));
  });

  it("returns nothing when the texts are identical", () => {
    expect(computeHunkDiffs("f.txt", mk(10), mk(10))).toEqual([]);
  });

  it("splits changes far apart into separate hunks", () => {
    // The case a prefix/suffix trim cannot handle: the unchanged span between
    // the two edits must NOT be counted. An earlier revision reported +40/-40
    // here.
    const before = mk(40);
    const after = before.replace("line 3", "LINE 3").replace("line 38", "LINE 38");
    const diffs = computeHunkDiffs("f.txt", before, after);

    expect(diffs).toHaveLength(2);
    expect(uiCount(diffs)).toEqual({ added: 2, removed: 2 });
  });

  it("splits two edits that are not adjacent, now that there is no context", () => {
    // With context, `line 11` between the two edits fell inside the window and
    // they merged. Without context there is nothing to bridge them, so each edit
    // is its own hunk — which is what makes the card show exactly the changed
    // lines and nothing else.
    const before = mk(40);
    const after = before.replace("line 10", "LINE 10").replace("line 12", "LINE 12");
    const diffs = computeHunkDiffs("f.txt", before, after);

    expect(diffs).toHaveLength(2);
    expect(uiCount(diffs)).toEqual({ added: 2, removed: 2 });
  });

  it("splits three scattered edits into three hunks", () => {
    const before = mk(100);
    const after = before.replace("line 5", "A").replace("line 50", "B").replace("line 95", "C");
    const diffs = computeHunkDiffs("f.txt", before, after);

    expect(diffs).toHaveLength(3);
    expect(uiCount(diffs)).toEqual({ added: 3, removed: 3 });
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
    expect(uiCount(first)).toEqual({ added: 1, removed: 1 });

    const last = computeHunkDiffs("f.txt", mk(10), mk(10).replace("line 10", "LINE 10"));
    expect(uiCount(last)).toEqual({ added: 1, removed: 1 });
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
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
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
    // The COUNTS are what this guards: +1/-1 for a one-line change, regardless of
    // which copy of the repeated line Myers picks. Which copy it picks is not
    // recoverable from the bytes — fifty identical lines make "changed the first"
    // and "added at the top, removed at the bottom" the same file — so only the
    // reported POSITION may differ, never the totals. (The harness's own
    // `structuredPatch` agrees that there are two hunks for this input; its card
    // totals are +8/-8, not +1/-1, because it keeps 3 context lines per hunk.)
    const before = Array.from({ length: 50 }, () => "same").join("\n");
    const after = before.replace("same", "CHANGED");
    const diffs = computeHunkDiffs("f.txt", before, after);
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
    expect(uiCount(diffs)).toEqual(countLineChanges(before, after));
  });

  it("keeps the count proportional when duplicate lines surround the change", () => {
    // The same edit on a file that ends with a newline on both sides: the final
    // line matches, so the second hunk is one line shorter.
    const before = Array.from({ length: 50 }, () => "same").join("\n") + "\n";
    const after = before.replace("same", "CHANGED");
    const diffs = computeHunkDiffs("f.txt", before, after);
    expect(diffs).toHaveLength(2);
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
  });

  it("keeps an unambiguous change to one hunk", () => {
    // Distinct lines around the change remove the tie-break ambiguity, so the
    // card shows exactly the changed line. Written as a literal rather than in
    // terms of `DIFF_CONTEXT`: with the constant at 0 the parameterized form
    // (`1 + 2 * DIFF_CONTEXT`) collapses to the same number and would pass even if
    // context lines came back, which is the regression this guards.
    const before = mk(50) + "\n";
    const after = before.replace("line 25", "CHANGED");
    const diffs = computeHunkDiffs("f.txt", before, after);
    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
  });

  it("reports a change that only adds the final newline", () => {
    // The file's bytes changed, so this is a change. Comparing line ARRAYS made
    // it invisible — and on `write`, an empty diff list makes the UI fall back to
    // the whole-file diff this module exists to remove.
    const diffs = computeHunkDiffs("f.txt", "a\nb", "a\nb\n");
    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
  });

  it("reports a change that only removes the final newline", () => {
    const diffs = computeHunkDiffs("f.txt", "a\nb\n", "a\nb");
    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
  });

  it("reports a single-line file gaining a newline", () => {
    const diffs = computeHunkDiffs("f.txt", "x", "x\n");
    expect(diffs).toHaveLength(1);
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
  });

  it("does not leak the end-of-file marker into reported text", () => {
    // The marker that distinguishes `"a\nb"` from `"a\nb\n"` is internal: it must
    // never reach the card. Only the changed line is reported, so `a` — unchanged
    // — is absent from both sides.
    const diffs = computeHunkDiffs("f.txt", "a\nb", "a\nB");
    expect(diffs[0]!.oldText).toBe("b");
    expect(diffs[0]!.newText).toBe("B");
    expect(JSON.stringify(diffs)).not.toContain("\u0000");
  });

  it("still reports both sides in full when one side has no newline", () => {
    // Appending to an unterminated file: both sides keep their own final-newline
    // state, so the last line differs and is reported.
    const diffs = computeHunkDiffs("f.txt", "a\nb", "a\nb\nc");
    expect(uiCount(diffs)).toEqual({ added: 2, removed: 1 });
  });

  it("counts an edit that only adds or removes a blank line", () => {
    // A region can be a blank line and nothing else — with zero context that is the
    // ordinary case, since a region is exactly the changed lines. (It was reachable
    // before too, but only for a file made entirely of blank lines.) The card's
    // splitter drops a trailing newline and reads `""` as no lines at all, so the
    // region text has to write that blank line out; otherwise the card reads `+0 -0`
    // while the message says `Added 1 line(s)` — the very disagreement this module
    // exists to remove.
    const cases: Array<[string, string]> = [
      ["para one\npara two\n", "para one\n\npara two\n"],
      ["para one\n\npara two\n", "para one\npara two\n"],
      ["a\nb\n", "a\nb\n\n"],
      ["a\nb\n\n\n", "a\nb\n"],
    ];

    for (const [before, after] of cases) {
      const diffs = computeHunkDiffs("f.txt", before, after);
      expect(uiCount(diffs)).toEqual(countLineChanges(before, after));
    }

    // Spelled out for the insertion, so the shape is pinned and not just the totals.
    const inserted = computeHunkDiffs("f.txt", "a\nb\n", "a\n\nb\n");
    expect(inserted).toEqual([{ path: "f.txt", oldText: null, newText: "\n" }]);

    const removed = computeHunkDiffs("f.txt", "a\n\nb\n", "a\nb\n");
    expect(removed).toEqual([{ path: "f.txt", oldText: "\n", newText: "" }]);
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

    // Every changed line is 10 apart, so each is its own hunk and each holds
    // exactly its one changed line. Literals, not `1 + 2 * DIFF_CONTEXT`: with the
    // constant at 0 that expression is 1 and the assertion would hold even if
    // context lines returned.
    expect(diffs).toHaveLength(2000);
    expect(uiCount(diffs)).toEqual({ added: 2000, removed: 2000 });
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
      // And the card agrees exactly, for every one of them: the region is built on
      // the same rule, so a side `countLines` sees no lines in reports `null`
      // instead of a blank row the card would count as one.
      expect(uiCount(diffs)).toEqual(count);
    }

    // The one text where those two rules differ: `countLines("\n")` is 0, while the
    // card's splitter would show one blank row for it.
    const single = computeHunkDiffs("f.txt", "\n", huge);
    expect(single[0]!.oldText).toBeNull();
    expect(uiCount(single)).toEqual(countLineChanges("\n", huge));
  });
});
