/**
 * Minimal line diff for the tool result cards.
 *
 * The UI counts changed lines from the hunks a tool reports: every line of a
 * hunk's `oldText` counts as removed and every line of its `newText` as added.
 * Reporting the whole file — which is what passing `before`/`after` straight
 * through does — makes a one-line edit read as "changed 2,400 lines", and the
 * user reasonably concludes the plugin rewrote their file. It did not; only the
 * card was wrong. This module produces one hunk per changed region, so the count
 * matches what actually changed.
 *
 * The harness uses the `diff` package's `structuredPatch`. This is a
 * self-contained equivalent for the one thing the cards need. Deliberately not
 * that dependency: it is ~600 kB unpacked across 136 files, larger than this
 * plugin's two runtime dependencies combined, and it is not importable from here
 * anyway — it is an internal dependency of `@deepseek-ai/dsh-tool-fs`, not a
 * declared peer, so a plugin that wants it must ship its own copy.
 *
 * ## Why a real diff and not a prefix/suffix trim
 *
 * Trimming the common prefix and suffix is enough for a SINGLE changed region,
 * and that is what an earlier revision of this module did. It is not enough for
 * the common case of two changes far apart: the whole span between them counts
 * as changed. Measured on a 100-line file with three scattered edits, the trim
 * reported +97/-97 where the harness reports +21/-21 — the original complaint,
 * unfixed. Separating changes requires the actual LCS, so this computes one with
 * the Myers algorithm over lines.
 *
 * ## No context lines, unlike the harness — see {@link DIFF_CONTEXT}
 *
 * The harness emits 3 context lines per hunk. Copying that made every unchanged
 * line render as BOTH a deletion and an addition, because `FileDiff` cannot mark
 * a line as context. This module emits the changed lines only.
 *
 * ## The trailing newline belongs to the last line
 *
 * A save that only adds or removes a file's final newline changes its bytes, so it
 * has to produce a hunk. Comparing line ARRAYS cannot see that — `"a\nb"` and
 * `"a\nb\n"` split into the same two lines — which reported such a save as "nothing
 * changed" and, on `write`, made the UI fall back to the whole-file diff this
 * module exists to remove. The final line is therefore compared together with its
 * newline, the same fact `structuredPatch` encodes with its
 * `\ No newline at end of file` marker. When both sides end the same way — every
 * file that ends with a newline, which is nearly all of them — this reduces to
 * plain line equality.
 *
 * ## Bounded work
 *
 * The trace is one diagonal window per round and the search stops at
 * {@link MAX_EDIT_DISTANCE}, so a call cannot allocate without limit; see that
 * constant for what the bound costs and why it is the safe answer.
 *
 * @module dsh-fs-encoding/diff-hunks
 */

/**
 * Context lines kept on each side of a change. Deliberately ZERO.
 *
 * The harness's own `DIFF_CONTEXT` is 3, and copying that number is what this
 * module did first. It is wrong HERE, because the harness's context lines are
 * never rendered as context: `FileDiff` carries only `oldText` and `newText`, and
 * the UI's `diffRows` pushes every line of `oldText` as a `del` row and every
 * line of `newText` as an `add` row, with no per-line alignment and no notion of
 * an unchanged line. So each context line is shown TWICE — once as removed, once
 * as added — and a one-line edit renders as "deleted 7, added 7".
 *
 * Measured on the real card: editing one line of a 9,441-line file with
 * `DIFF_CONTEXT = 3` displayed six unchanged lines under `-` and the same six
 * again under `+`, with the card totalling `+7 -7` while the message said
 * `Added 1 line(s), removed 1 line(s)`.
 *
 * Zero is also what the harness's own CALL-time presenter does: `presentCall`
 * puts `old_string`/`new_string` straight into `oldText`/`newText` — pure changed
 * lines, no context — which is the semantics this structure actually has. The
 * harness's `computeHunkDiffs` added context for the result card without the UI
 * ever learning to render it, so the two disagree; this module follows the
 * structure rather than the mismatch.
 *
 * The cost is real and accepted: the card no longer shows the neighbourhood of a
 * change. The counts are now honest and match the message, which is what a reader
 * checks first, and the surrounding lines are one `read` away.
 */
export const DIFF_CONTEXT = 0;

/**
 * Largest edit distance this module will search for.
 *
 * The trace keeps one packed diagonal window per round, so an unbounded search
 * costs `O(D²)` memory and `O(D²)` time. The bound is what keeps a whole-file
 * rewrite of a large file — the case where `D` approaches `n + m` — from
 * allocating gigabytes inside a tool result renderer: measured on the unbounded
 * version, 30,000 lines rewritten as one line reached 3.8 GB and 8,000 lines of
 * entirely different text reached 1.5 GB, and `Int32Array` storage is off-heap,
 * so it is not stopped by `--max-old-space-size` and instead consumes physical
 * memory until the process dies. The plugin's own read cap (`maxFileBytes`,
 * 10 MiB by default) is far above what this algorithm can survive, so the cap
 * cannot stand in for a bound here.
 *
 * The value is a deliberate compromise, because reaching the bound is not free:
 * past it the card collapses to a single whole-file region and the reported
 * counts become the two file sizes rather than the real edit, so a file with
 * 1,001 changed lines would be described as if all 3,000 had changed. The bound
 * therefore has to sit above any edit a real tool call produces, and it does:
 * the counts only stop being exact past `MAX_EDIT_DISTANCE / 2` changed lines,
 * which is 3,000 lines here.
 *
 * A fixed bound rather than one scaled to the input, because the memory has to
 * stay predictable: the packed trace is `2 × (D+1) × (D+2)` bytes, ~69 MB at the
 * bound, whatever the file size. Scaling it would let a 200,000-line file raise
 * the ceiling to hundreds of MB per call, which is the failure this constant
 * exists to prevent.
 *
 * The bound also caps TIME, not just memory, and that is not a side effect worth
 * losing: the harness's own unbounded `structuredPatch` needs 37 seconds to
 * produce the single whole-file hunk that this returns in 0.24 seconds for the
 * same 20,000-line rewrite, because its cost is `O((n+m)·D)` with `D` at its
 * worst. Past the bound this module stops searching and reports the answer it
 * already knows.
 */
export const MAX_EDIT_DISTANCE = 6000;

/**
 * One changed region, in the shape the UI's diff card expects.
 *
 * The index signature is what lets these objects travel through the tool result
 * metadata, which is typed as `JsonValue` — a plain interface is not assignable
 * to that without one.
 */
export interface FileDiff {
  [key: string]: string | null;
  /** The model-facing path, stamped on the diff. */
  path: string;
  /** Lines before the change, or `null` for a pure insertion. */
  oldText: string | null;
  /** Lines after the change. */
  newText: string;
}

/**
 * A line as it appears in a diff card: without the newline that follows it.
 *
 * The card renders one row per line, so the newline {@link toLines} carries for
 * comparison is stripped here. Only the FINAL row can lack it, and that is
 * exactly the difference the caller wants to see.
 *
 * @param line - a line from {@link toLines}.
 * @returns the line without its trailing newline.
 */
function toCardLine(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

/**
 * Join a region's lines into the text the card carries.
 *
 * `join("\n")` alone is not reversible by the UI's splitter, which reads a
 * trailing newline as the terminator of the line before it rather than as a line
 * of its own: `(t.endsWith("\n") ? t.slice(0, -1) : t).split("\n")`. A region
 * that ENDS in a blank line therefore comes back one line short, and a region
 * that is nothing BUT a blank line comes back as zero lines — `""` splits into no
 * lines at all.
 *
 * This used to be rare rather than impossible: a region carried context lines, so
 * it usually held a non-blank line, but an edit that only removed blank lines
 * could already come back one row short. With {@link DIFF_CONTEXT} at 0 a region
 * is exactly the changed lines, so a blank line is an ordinary region — and an edit
 * that only inserts one reached the card as `{ oldText: null, newText: "" }`: a card
 * with no body reading `+0 -0` while the message said `Added 1 line(s)`. Writing the
 * trailing newline out explicitly makes the round trip exact, so the card counts the
 * same lines the message reports.
 *
 * @param lines - the region's lines, without their newlines.
 * @returns the region's text; `""` only for an empty region.
 */
function joinRegion(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  const text = lines.join("\n");
  // A blank last line is invisible in `text` itself: `["a", ""]` joins to `"a\n"`,
  // which the card splits back into one line. The extra newline is what makes that
  // blank line a line again.
  return lines[lines.length - 1] === "" ? `${text}\n` : text;
}

/**
 * A whole-file region for the degraded path, measured the way {@link countLines}
 * measures the same text.
 *
 * The counts on this path ARE `countLines`, so the region has to render exactly
 * that many rows or the card and the message disagree. `joinRegion` already makes a
 * region round-trip through the card's splitter, which leaves one gap: text that is
 * nothing but a single newline. `countLines("\n")` is 0 — the same rule that makes
 * `read` report `totalLines: 0` — while the splitter sees one blank row in it.
 * Reporting the region as `null` for that case keeps the card at `+0/-0`, matching
 * the message; every other text (`"\n\n"` is 2 lines to both) passes through as it
 * is. `null` is the shape that already means "no lines on this side", which is what
 * a pure insertion uses and what the UI reads as "nothing was removed".
 *
 * @param lines - the side's lines as {@link toLines} produced them.
 * @returns the region's text, or `null` when `countLines` sees no lines in it.
 */
function countedRegion(lines: readonly string[]): string | null {
  const text = joinRegion(lines.map(toCardLine));
  return countLines(text) > 0 ? text : null;
}

/**
 * Split text into lines, each carrying the newline that FOLLOWS it.
 *
 * A trailing newline does not open a new line: `"a\n"` is one line, not two.
 * An empty string is zero lines.
 *
 * The newline is part of the line's identity, which is what makes a save that
 * only adds or removes a file's final newline visible: `"a\nb"` yields
 * `["a\n", "b"]` and `"a\nb\n"` yields `["a\n", "b\n"]`, so the last line
 * differs. Comparing bare text instead made such a save read as "nothing
 * changed" — and on `write`, an empty diff list makes the UI fall back to the
 * whole-file diff this module exists to remove.
 *
 * Only the FINAL line can differ this way, so the interior lines of two texts
 * that share them still compare equal and the diff is not fragmented.
 *
 * @param text - the text to split.
 * @returns one entry per visible line, each including its trailing newline when
 *   it has one.
 */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline does not open a line: it belongs to the line before it.
  const terminated = lines[lines.length - 1] === "";
  if (terminated) lines.pop();
  // Every line but the last is followed by the newline `split` consumed; the last
  // carries one only when the text ended with it.
  for (let i = 0; i < lines.length - 1; i += 1) lines[i] += "\n";
  if (terminated) lines[lines.length - 1] += "\n";
  return lines;
}

/** One element of an edit script, in file order. */
type Edit =
  | { kind: "equal"; oldIndex: number; newIndex: number }
  | { kind: "remove"; oldIndex: number }
  | { kind: "insert"; newIndex: number };

/**
 * Myers diff over two line arrays, returned as an ordered edit script.
 *
 * This is the O(ND) greedy form from "An O(ND) Difference Algorithm and its
 * Variations" (Myers, 1986): walk the edit graph diagonal by diagonal, keeping
 * the furthest-reaching path per diagonal, and record the trace so the path can
 * be walked back into an edit script.
 *
 * Two properties keep the work bounded, both of them load-bearing:
 *
 * - The trace stores only the diagonals that round `d` actually visits
 *   (`-d..d` step 2, so `d + 1` of them), packed into a window of that size,
 *   instead of a copy of the whole `2(n+m)+1` state array. Snapshotting the full
 *   array made a 50,000-line file with 100 changed lines allocate 153 MB where
 *   the packed window needs 3 KB.
 * - The search stops at {@link MAX_EDIT_DISTANCE}. A larger `d` cannot be reached
 *   without exceeding the bound, so this is a real limit and not the `n + m`
 *   bound of the loop: past it the caller is told the two sides differ
 *   everywhere, rather than being handed a partial script from an unfinished
 *   trace.
 *
 * @param oldLines - lines before the change.
 * @param newLines - lines after the change.
 * @returns the edit script in file order, or `null` when the edit distance
 *   exceeds {@link MAX_EDIT_DISTANCE}.
 */
function myersDiff(oldLines: readonly string[], newLines: readonly string[]): Edit[] | null {
  const n = oldLines.length;
  const m = newLines.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);

  // `v[k]` = furthest x reached on diagonal k (k = x - y), offset by `max` so a
  // negative k is a valid index.
  const size = 2 * max + 1;
  let v = new Int32Array(size);
  /**
   * Round `d`'s diagonals, packed as `[k + d) / 2]` — round `d` visits only the
   * `d + 1` diagonals `-d, -d+2, …, d`, so half of a `2d + 1` window would be
   * unused slots.
   */
  const trace: Int32Array[] = [];

  const idx = (k: number) => k + max;
  const at = (arr: Int32Array, k: number): number => arr[idx(k)] ?? 0;
  /** Slot of diagonal `k` in round `d`'s packed window. */
  const slot = (k: number, d: number) => (k + d) / 2;

  let found = false;
  for (let d = 0; d <= max; d += 1) {
    const window = new Int32Array(d + 1);
    for (let k = -d; k <= d; k += 2) {
      // Choose down (insert) or right (remove): down when it reaches further.
      let x: number;
      if (k === -d || (k !== d && at(v, k - 1) < at(v, k + 1))) {
        x = at(v, k + 1);
      } else {
        x = at(v, k - 1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }
      v[idx(k)] = x;
      window[slot(k, d)] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    trace.push(window);
    if (found) break;
  }

  // The bound was hit before the two sides met: report them as entirely
  // different rather than walking back a trace that never reached the end.
  if (!found) return null;

  // Walk the trace back into an edit script. Round `d`'s window is packed by
  // `slot`, so an off-window diagonal reads as 0 — the same value `at` gives for
  // a diagonal the round never reached.
  const script: Edit[] = [];
  const atWindow = (window: Int32Array, d: number, k: number): number => {
    if (k < -d || k > d) return 0;
    return window[slot(k, d)] ?? 0;
  };
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const prev = trace[d - 1]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && atWindow(prev, d - 1, k - 1) < atWindow(prev, d - 1, k + 1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = atWindow(prev, d - 1, prevK);
    const prevY = prevX - prevK;

    // Diagonal moves after the edit are matches.
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      script.push({ kind: "equal", oldIndex: x, newIndex: y });
    }
    if (x > prevX) {
      x -= 1;
      script.push({ kind: "remove", oldIndex: x });
    } else if (y > prevY) {
      y -= 1;
      script.push({ kind: "insert", newIndex: y });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    script.push({ kind: "equal", oldIndex: x, newIndex: y });
  }
  while (x > 0) {
    x -= 1;
    script.push({ kind: "remove", oldIndex: x });
  }
  while (y > 0) {
    y -= 1;
    script.push({ kind: "insert", newIndex: y });
  }

  script.reverse();
  return script;
}

/**
 * Run the diff once and derive both the counts and the rendered regions.
 *
 * This is the single place a diff is computed. {@link computeHunkDiffs} and
 * {@link countLineChanges} are thin wrappers over it for callers that need only
 * one of the two answers, and {@link diffForResult} uses it directly so a tool's
 * `render` and `presentationMeta` share one computation.
 *
 * @param path - the path stamped on every produced diff.
 * @param before - the file text before the change.
 * @param after - the file text after the change.
 * @returns the counts and the changed regions; both empty when identical.
 */
function analyze(path: string, before: string, after: string): DiffResult {
  if (before === after) return { count: { added: 0, removed: 0 }, diffs: [] };

  const oldLines = toLines(before);
  const newLines = toLines(after);
  const script = myersDiff(oldLines, newLines);

  // Over the edit-distance bound: the file was rewritten, so report it as one
  // whole-file region. Both answers must agree here, or the card and the message
  // would describe different changes.
  if (script === null) {
    return {
      // Counted with `countLines`, not `toLines().length`: the two differ for text
      // that is nothing but a newline (`"\n"` is zero lines to `read` and to the
      // `write` result block, but `toLines` sees one line carrying that newline).
      // Reporting the raw array length here would make a rewrite of such a file
      // claim one removed line where every other path says zero.
      //
      // The regions follow the same rule — see {@link countedRegion} — so the card
      // and the message agree on this text too.
      count: { added: countLines(after), removed: countLines(before) },
      diffs: [
        {
          path,
          oldText: countedRegion(oldLines),
          newText: countedRegion(newLines) ?? "",
        },
      ],
    };
  }

  let added = 0;
  let removed = 0;

  // Group the script into runs of changes separated by unchanged lines. With
  // {@link DIFF_CONTEXT} at 0 that is simply "one region per changed run", but the
  // grouping stays written in terms of the constant so the rule is visible rather
  // than implied; see the constant for why it is 0 and what restoring context
  // would mean.
  const diffs: FileDiff[] = [];
  let i = 0;
  while (i < script.length) {
    if (script[i]!.kind === "equal") {
      i += 1;
      continue;
    }

    // Start of a changed region. Take CONTEXT lines of leading context — none of
    // the expressions below move while `DIFF_CONTEXT` is 0, which is the intended
    // behaviour and not an oversight: `regionStart` is `i`, `leading` is empty and
    // the trailing slice takes nothing. They are kept as written so the constant
    // remains the one place the policy lives.
    const regionStart = Math.max(0, i - DIFF_CONTEXT);
    const leading = script.slice(regionStart, i);

    const oldRegion: string[] = leading.map((e) =>
      toCardLine(oldLines[(e as { oldIndex: number }).oldIndex]!),
    );
    const newRegion: string[] = leading.map((e) =>
      toCardLine(newLines[(e as { newIndex: number }).newIndex]!),
    );

    // Consume changes and the unchanged runs between them; a run longer than
    // 2*CONTEXT ends the region (CONTEXT lines stay, the rest are skipped).
    let j = i;
    while (j < script.length) {
      const step = script[j]!;
      if (step.kind === "remove") {
        removed += 1;
        oldRegion.push(toCardLine(oldLines[step.oldIndex]!));
        j += 1;
      } else if (step.kind === "insert") {
        added += 1;
        newRegion.push(toCardLine(newLines[step.newIndex]!));
        j += 1;
      } else {
        // Count the run of unchanged lines starting here.
        let run = j;
        while (run < script.length && script[run]!.kind === "equal") run += 1;
        const runLength = run - j;
        const isLast = run >= script.length;
        if (isLast || runLength > 2 * DIFF_CONTEXT) {
          // Trailing context, then end the region.
          const trailing = script.slice(j, j + DIFF_CONTEXT);
          for (const e of trailing) {
            oldRegion.push(toCardLine(oldLines[(e as { oldIndex: number }).oldIndex]!));
            newRegion.push(toCardLine(newLines[(e as { newIndex: number }).newIndex]!));
          }
          j = isLast ? run : j + DIFF_CONTEXT;
          break;
        }
        for (let k = j; k < run; k += 1) {
          const e = script[k]!;
          oldRegion.push(toCardLine(oldLines[(e as { oldIndex: number }).oldIndex]!));
          newRegion.push(toCardLine(newLines[(e as { newIndex: number }).newIndex]!));
        }
        j = run;
      }
    }

    diffs.push({
      path,
      // `joinRegion`, not `countedRegion`: these lines ARE the change, so an edit
      // that only inserts a blank line has to reach the card as that blank line.
      // Dropping it would leave the card at `+0 -0` beside a message saying
      // `Added 1 line(s)`. The degraded path above filters instead because its counts
      // are `countLines`, which reports no lines at all for text that is a single
      // newline — a rule this path's edit-script counts do not share.
      oldText: oldRegion.length > 0 ? joinRegion(oldRegion) : null,
      newText: joinRegion(newRegion),
    });
    i = j;
  }

  return { count: { added, removed }, diffs };
}

/**
 * Compute one {@link FileDiff} per changed region between `before` and `after`.
 *
 * With {@link DIFF_CONTEXT} at 0 that is one region per run of changed lines —
 * deliberately NOT the built-ins' shape, which keeps 3 context lines per hunk and
 * which the card cannot render as context (see the constant). Regions carry the
 * changed lines only, so the card counts exactly the lines the message reports.
 *
 * A change whose edit distance exceeds {@link MAX_EDIT_DISTANCE} is reported as a
 * single whole-file diff. That is the honest answer — the file really was
 * rewritten — and it is the bounded one: computing the fine-grained regions would
 * require the trace this module refuses to grow without limit.
 *
 * @param path - the path stamped on every produced diff.
 * @param before - the file text before the change.
 * @param after - the file text after the change.
 * @returns one diff per changed region, in file order; empty when identical.
 */
export function computeHunkDiffs(path: string, before: string, after: string): FileDiff[] {
  return analyze(path, before, after).diffs;
}

/** How many lines a change added and removed, context excluded. */
export interface LineChangeCount {
  /** Lines present after the change that were not there before. */
  added: number;
  /** Lines present before the change that are gone. */
  removed: number;
}

/**
 * Count the lines a change actually added and removed.
 *
 * Kept separate from {@link computeHunkDiffs} because the two answer different
 * questions — this one counts the edit script's inserts and removes, that one
 * returns the regions to render — and not because the numbers differ: with
 * {@link DIFF_CONTEXT} at 0 a region holds exactly the changed lines, so both
 * surfaces report the same totals. Counting the regions would have inflated a
 * one-line edit to "added 7, removed 7" back when they carried context lines, the
 * same class of inflation as the whole-file diff bug, just smaller.
 *
 * A line that changed in place counts once on each side, which is what a reader
 * expects from "added 1, removed 1" for a one-line edit.
 *
 * Over {@link MAX_EDIT_DISTANCE} the whole of both sides is reported as changed,
 * matching the single whole-file diff {@link computeHunkDiffs} produces for the
 * same input — the two must agree, or the card and the message would describe
 * different changes.
 *
 * @param before - the file text before the change.
 * @param after - the file text after the change.
 * @returns the added and removed line counts.
 */
export function countLineChanges(before: string, after: string): LineChangeCount {
  return analyze("", before, after).count;
}

/**
 * The summary appended to a tool's message so the model can see the size of what
 * it just did, in the shape `dsh-better-edit` uses.
 *
 * @param count - the added/removed counts.
 * @returns the sentence fragment, or `""` when nothing changed.
 */
export function formatLineChangeSummary(count: LineChangeCount): string {
  if (count.added === 0 && count.removed === 0) return "";
  return ` Added ${count.added} line(s), removed ${count.removed} line(s).`;
}

/**
 * The same counts as a parenthetical, for the `write` result block.
 *
 * `write` answers in an XML-shaped block whose `<content>` element already ends
 * with a verb phrase ("Created file"), so a second sentence there would read as
 * two statements. A parenthetical attaches to the phrase instead.
 *
 * @param count - the added/removed counts.
 * @returns the parenthetical, or `""` when nothing changed.
 */
export function formatChangeParenthetical(count: LineChangeCount): string {
  if (count.added === 0 && count.removed === 0) return "";
  return ` (added ${count.added}, removed ${count.removed} line(s))`;
}

/**
 * How many lines a text has, counted the way the tools report it.
 *
 * A trailing newline does not open a new line, so a file whose content ends with
 * one is not reported as one line longer than it looks. Text that is nothing but
 * newlines counts as zero lines, matching `read`'s `totalLines` (see
 * `line-endings.splitLines` and `tool-read`): the two are the same model-facing
 * vocabulary, and a model that creates a file reported as "1 line" must not then
 * read it back as "0 lines".
 *
 * @param text - the text to measure.
 * @returns the line count; zero for empty text.
 */
export function countLines(text: string): number {
  // Counted from the raw split, not from `toLines`: that one carries each line's
  // newline for comparison purposes, which does not change how many lines there
  // are but does mean `"\n"` yields `["\n"]` rather than the blank line this
  // needs to recognise.
  if (text === "") return 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length === 1 && lines[0] === "" ? 0 : lines.length;
}

/** One diff computation, as both of a tool's output callbacks need it. */
export interface DiffResult {
  /** The real added/removed counts, context excluded. */
  count: LineChangeCount;
  /** The changed regions the card renders — the changed lines only, no context. */
  diffs: FileDiff[];
}

/**
 * Memo of the diff for one tool result, keyed by the result value itself.
 *
 * The harness renders a result and then projects its metadata from the SAME
 * frozen value object (`dsh-tools`'s `createSuccessResult`), so a tool whose
 * `render` and `presentationMeta` both need the diff would otherwise walk the
 * whole file twice — for a large rewrite that is the dominant cost of the call,
 * paid twice, synchronously, on the event loop.
 *
 * A `WeakMap` is what makes this safe to keep at module scope: the key is the
 * result object, so an entry dies with the result it belongs to and nothing
 * accumulates across calls or sessions.
 */
const diffMemo = new WeakMap<object, DiffResult>();

/**
 * The diff for one tool result, computed once per result.
 *
 * Both callbacks of a tool must go through this rather than calling
 * {@link countLineChanges} and {@link computeHunkDiffs} separately: those two
 * would each run their own diff over the same texts, and the card and the message
 * would then be derived from two independent computations of the same thing.
 *
 * The three content arguments must describe `value` and must be the same on every
 * call for it — they are not part of the memo key, so a second call with different
 * texts or a different path silently returns the first call's answer. Every caller
 * passes the fields straight off the result (`v.path`, `v.before`, `v.after`),
 * which is what makes that safe; a caller that wants a different path must not
 * route it through here.
 *
 * The returned object is the cached one, shared by every call for this `value`, so
 * callers must treat it as read-only: mutating `count` or `diffs` here would be
 * visible to the other callback of the same result. Both callers read one field
 * each and neither writes, which is why this returns the cached object rather than
 * a copy. (The harness itself is not a concern — it deep-copies whatever a
 * projection returns before storing it.)
 *
 * @param value - the tool result value, used as the memo key.
 * @param path - the model-facing path stamped on every diff.
 * @param before - the file text before the change.
 * @param after - the file text after the change.
 * @returns the counts and the changed regions, sharing one diff. Read-only.
 */
export function diffForResult(
  value: object,
  path: string,
  before: string,
  after: string,
): DiffResult {
  const memoized = diffMemo.get(value);
  if (memoized !== undefined) return memoized;

  const computed = analyze(path, before, after);
  diffMemo.set(value, computed);
  return computed;
}
