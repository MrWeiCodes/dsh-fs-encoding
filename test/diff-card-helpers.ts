/**
 * Shared diff-card helpers for the tests.
 *
 * These exist because the counting rule is not obvious and was got wrong twice:
 *
 * 1. The UI does NOT count lines with `split("\n").length`. Its `diffTotals`
 *    drops one trailing newline before splitting, because a hunk's last line is
 *    still newline-terminated (`oldRegion.join("\n")`). Counting naively reports
 *    one extra line per hunk whose deleted region ends in a blank line — so a
 *    test that asserts the naive number is asserting a number no user sees.
 * 2. Two copies of that helper had drifted into two test files. They are now one
 *    function, so fixing the formula fixes every assertion that uses it.
 *
 * The implementation mirrors `diffTotals` / its line splitter from
 * `@deepseek-ai/dsh-client-ui-primitives` (as bundled into `dsh-web-frontend`):
 *
 * ```js
 * const lines = (t) => (t === "" ? [] : (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n"));
 * for (const d of diffs) {
 *   if (d.oldText !== null) removed += lines(d.oldText).length;
 *   added += lines(d.newText).length;
 * }
 * ```
 *
 * @module dsh-fs-encoding/test/diff-card-helpers
 */

import type { JsonValue } from "@deepseek-ai/dsh-util-values";

/** One file diff as the tools report it. */
export interface Diff {
  path: string;
  oldText: string | null;
  newText: string;
}

/** The file's text as an array of lines, the way the UI splits a diff region. */
export function uiLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** The `+added / -removed` totals the UI shows for a diff list. */
export function uiCount(diffs: Diff[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diffs) {
    if (d.oldText !== null) removed += uiLines(d.oldText).length;
    added += uiLines(d.newText).length;
  }
  return { added, removed };
}

/** `n` lines named `line 1` … `line n`, joined without a trailing newline. */
export function mk(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

/** Re-exported so a test can name the opaque parameter type without importing the package. */
export type { JsonValue };
