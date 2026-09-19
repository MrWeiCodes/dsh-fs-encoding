/**
 * The line- and match-level edits the `insert` and `str_replace_editor` tools
 * perform, as pure functions over decoded text.
 *
 * Kept apart from the tools for the same reason `diff-hunks` is: the arithmetic
 * is where the bugs live and it is testable without a filesystem, a sandbox or a
 * session. The tools own the IO and the encoding; this owns "which lines".
 *
 * Every function here takes and returns LF-normalized text. Callers normalize on
 * the way in and let `writeFile` restore the file's own terminators, which is the
 * same contract `tool-edit` works under.
 *
 * @module dsh-fs-encoding/line-edit
 */

/**
 * Split text into lines for line-addressed editing.
 *
 * A trailing newline does not open a line, so `"a\nb\n"` is two lines and
 * `insert_line: 2` appends after `b`. This matches how the `read` tool numbers
 * the same file, which is what a model reads the line number off.
 *
 * @param text - LF-normalized text.
 * @returns the text's lines; `[]` for empty text.
 */
export function splitForEdit(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Whether the text ends with a newline, so a save can put it back. */
export function hadTrailingNewline(text: string): boolean {
  return text.endsWith("\n");
}

/**
 * Whether the text uses a lone CR (classic Mac) as a line terminator.
 *
 * Line-numbered editing cannot serve such a file consistently, and the two
 * readings are not interchangeable: `read` splits on `\n` alone, so a lone-CR
 * file is ONE line to the model, while the edit path normalizes to LF first and
 * would count several. A line number valid in one reading is silently wrong in
 * the other, so callers refuse rather than guess.
 *
 * The cheap `includes` runs first: a file with no CR at all — the overwhelmingly
 * common case — cannot contain a lone one, and the scan is roughly an order of
 * magnitude cheaper than the regex engine, which the callers run on every insert.
 *
 * @param text - the file's text, before any normalization.
 * @returns whether a CR appears that is not part of a CRLF pair.
 */
export function hasLoneCarriageReturn(text: string): boolean {
  return text.includes("\r") && /\r(?!\n)/.test(text);
}

/**
 * Count lines the way the model-facing tools report them, without allocating.
 *
 * A trailing newline does not open a line, and only `""` and a lone `"\n"` are
 * ZERO lines — that is the reading `read` publishes as `totalLines` and
 * `diff-hunks.countLines` repeats, so it is the only count a tool may report. A
 * longer run of terminators is one line per terminator (`"\n\n"` is 2). Computed
 * with `indexOf` rather than `split` because `view` needs the total of a file it
 * is about to show only a window of, and materializing every line to learn a
 * number was that call's dominant cost.
 *
 * This and `line-endings.splitLines` describe ONE rule — the visible lines of a
 * text — from two directions, and `read` uses both in a single reply: it renders
 * `splitLines`' window and reports this count as `totalLines`. The counts agree on
 * every input; what differs is the empty texts, where `splitLines("")` and
 * `splitLines("\n")` yield one empty ENTRY while this count is 0 — which is why
 * `read` can render a blank line and still report 0 lines, a deliberate pairing
 * rather than a contradiction. The two must move together: changing either alone
 * makes the rendered window and the reported total describe different files.
 *
 * @param text - the text to count.
 * @returns the number of visible lines.
 */
export function countVisibleLines(text: string): number {
  // `""` and `"\n"` are the two inputs that split to `[""]` under the tools' rule,
  // so both are zero lines. Every other text is its `\n` count, plus one when the
  // last line has no terminator of its own.
  if (text === "" || text === "\n") return 0;
  let breaks = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf("\n", from);
    if (at === -1) break;
    breaks += 1;
    from = at + 1;
  }
  return text.endsWith("\n") ? breaks : breaks + 1;
}

/**
 * The lines in `[startLine, startLine + count)` (1-based), without splitting the
 * whole text.
 *
 * The counterpart to {@link countVisibleLines} for the same reason: only the
 * requested window is ever allocated, so a `view` of the first 100 lines of a
 * 10 MiB file costs 100 strings rather than two million.
 *
 * @param text - LF-normalized text.
 * @param startLine - the 1-based first line to return.
 * @param count - how many lines to return at most.
 * @returns the requested lines; fewer than `count` near the end of the text.
 */
export function sliceLines(text: string, startLine: number, count: number): string[] {
  const out: string[] = [];
  if (count <= 0 || startLine < 1 || text === "") return out;

  let line = 1;
  let from = 0;
  while (line < startLine) {
    const at = text.indexOf("\n", from);
    if (at === -1) return out;
    from = at + 1;
    line += 1;
  }

  while (out.length < count) {
    const at = text.indexOf("\n", from);
    if (at === -1) {
      // The final line counts only when it has content: a trailing newline does
      // not open a line, which is the rule `splitForEdit` follows too.
      if (from < text.length) out.push(text.slice(from));
      break;
    }
    out.push(text.slice(from, at));
    from = at + 1;
    if (from >= text.length) break;
  }
  return out;
}

/**
 * The entries an insert splices into the file's line array.
 *
 * The single definition of "what an insert contributes", used by
 * {@link insertAfterLine} to build the result AND by {@link countInsertedLines} to
 * report its size — so the message and the splice cannot disagree, whatever either
 * is changed to.
 *
 * An empty `newText` contributes ONE BLANK LINE, not nothing: the source tool
 * builds the insertion with `newText.split("\n")`, and `"".split("\n")` is `[""]`.
 * Treating it as a no-op would make a blank-line insertion silently do nothing
 * while still reporting success. A trailing newline opens one more line, which is
 * why an empty entry is appended.
 *
 * @param newText - the text being inserted.
 * @returns the line entries to splice in.
 */
export function insertedLines(newText: string): string[] {
  const added = newText === "" ? [""] : splitForEdit(newText);
  return newText.endsWith("\n") ? [...added, ""] : added;
}

/**
 * Insert lines AFTER a given line number, the semantics Anthropic's text-editor
 * tool defines and the harness copies: `insert_line: 0` inserts at the very top,
 * `insert_line: N` after line N, and `insert_line: lines.length` appends.
 *
 * The AFTER rule is not a coin flip — it is what the model was trained on. Both
 * the official tool description ("Inserts a string after a specified line") and
 * the schema field ("The line number after which to insert the new string") say
 * so, and the harness's own parameter text repeats it. An implementation that
 * inserts BEFORE the named line would silently misplace every such call, because
 * a number that is valid in both readings cannot be told apart.
 *
 * @param text - LF-normalized file text.
 * @param insertLine - the line to insert after, 0-based-at-the-top (`[0, lines]`).
 * @param newText - the text to insert; may span lines.
 * @returns the new text, with the trailing-newline state of `text` preserved.
 * @throws {RangeError} when `insertLine` is outside `[0, lines.length]`.
 */
export function insertAfterLine(text: string, insertLine: number, newText: string): string {
  const lines = splitForEdit(text);
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    throw new RangeError(
      `insert_line ${insertLine} is outside the file's range: [0, ${lines.length}]`,
    );
  }

  const inserted = insertedLines(newText);

  const next = [
    ...lines.slice(0, insertLine),
    ...inserted,
    ...lines.slice(insertLine),
  ];

  const trailing = hadTrailingNewline(text);
  // An insertion into an empty file decides the file's newline state on its own:
  // there is no existing terminator to inherit. `inserted` is never empty here —
  // an empty `newText` contributes one blank line — so the result always ends in
  // a newline, which is what the source tool produces for the same call.
  if (lines.length === 0) return `${next.join("\n")}\n`;
  return trailing ? `${next.join("\n")}\n` : next.join("\n");
}

/**
 * How many lines an insert added, counted the way the message reports it.
 *
 * The size of {@link insertedLines}, which is exactly what `insertAfterLine`
 * splices in — the message and the file agree by construction, and an empty
 * `newText` reports the one blank line it really inserts rather than 0.
 *
 * Deriving this from the two file texts instead (a visible-line delta) looks more
 * principled and is worse: appending to a file with no trailing newline makes
 * `insertAfterLine` supply that terminator, so the delta reports 0 lines while the
 * line-change summary appended to the SAME sentence reports the line the model
 * added. Measured over the insert shapes the tests cover, the delta contradicted
 * that summary several times as often as this count does.
 *
 * @param newText - the text that was inserted.
 * @returns the number of lines the message reports.
 */
export function countInsertedLines(newText: string): number {
  return insertedLines(newText).length;
}

/**
 * Count occurrences of `oldText` in `text`, without building a per-hit array.
 *
 * Separate from {@link occurrenceLines} because the common path only needs the
 * NUMBER: a one-character needle in a multi-megabyte file matches millions of
 * times, and materializing a line number for each hit costs hundreds of
 * megabytes for an array whose length is the only thing read.
 *
 * @param text - LF-normalized file text.
 * @param oldText - the text to find; must be non-empty.
 * @returns how many non-overlapping occurrences exist.
 */
export function countOccurrences(text: string, oldText: string): number {
  if (oldText === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(oldText, from);
    if (at === -1) return count;
    count += 1;
    from = at + oldText.length;
  }
}

/**
 * Replace occurrences of `oldText` in `text`.
 *
 * `replaceAll` is the one addition this plugin makes to the harness contract: the
 * harness's `str_replace` refuses a non-unique match outright and offers no way
 * to mean "all of them". Omitting the flag keeps that exact behaviour, so a call
 * written against the harness tool behaves identically here; passing `true` is an
 * explicit opt-in that cannot be confused with the default.
 *
 * @param text - LF-normalized file text.
 * @param oldText - the text to find; must be non-empty.
 * @param newText - the replacement.
 * @param replaceAll - replace every occurrence instead of requiring uniqueness.
 * @returns the new text and how many occurrences were replaced.
 * @throws {RangeError} when `oldText` is empty, which would match everywhere.
 */
export function replaceMatches(
  text: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): { text: string; replaced: number } {
  if (oldText === "") {
    throw new RangeError("old_str must not be empty — an empty string matches everywhere");
  }

  // Count every occurrence even when only one may be replaced: the CALLER decides
  // between "replace the unique match" and "refuse as ambiguous" from this number,
  // so stopping at the first hit would report a duplicate as unique and silently
  // replace one of several. Counting is cheap next to the write it guards, and the
  // count alone is enough — the caller re-derives line numbers only for the
  // ambiguity message, which is the rare path.
  const replaced = countOccurrences(text, oldText);
  if (replaced === 0) return { text, replaced: 0 };
  if (!replaceAll && replaced > 1) return { text, replaced };
  return { text: text.split(oldText).join(newText), replaced };
}

/**
 * The 1-based line numbers where `oldText` occurs, for the ambiguity message.
 *
 * Naming the lines is what lets the model narrow `old_str` on the next attempt
 * instead of guessing; the harness does the same for the same reason.
 *
 * `limit` caps how many are collected. A needle that matches millions of times
 * would otherwise build a line-number array as large as the file's match count
 * and splice all of them into a model-facing error message. The caller reports
 * the total separately, so truncating the list loses no information the model
 * needs to narrow the match.
 *
 * @param text - LF-normalized file text.
 * @param oldText - the text that was found more than once.
 * @param limit - the maximum number of line numbers to collect.
 * @returns one line number per occurrence, in file order, at most `limit` of them.
 */
export function occurrenceLines(text: string, oldText: string, limit = 20): number[] {
  if (oldText === "") return [];
  const lines: number[] = [];
  let cursor = 0;
  let line = 1;
  let from = 0;
  for (;;) {
    if (lines.length >= limit) break;
    const at = text.indexOf(oldText, from);
    if (at === -1) break;
    while (cursor < at) {
      if (text[cursor] === "\n") line += 1;
      cursor += 1;
    }
    lines.push(line);
    from = at + oldText.length;
  }
  return lines;
}
