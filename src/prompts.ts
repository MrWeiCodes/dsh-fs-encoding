/**
 * System-prompt guidance for the three encoding-governed tools.
 *
 * These sections shadow the built-ins' own `tool:read` / `tool:write` /
 * `tool:edit` sections by name on the agent's layer, so the model is taught the
 * encoding-aware contract instead of the UTF-8-only one. The order values sit
 * above the built-in band (100–116) so a same-order tie with a built-in cannot
 * occur out of the box.
 *
 * @module dsh-fs-encoding/prompts
 */

/** Prompt section names shared with the built-ins — same name, nearer layer wins. */
export const SECTION_READ = "tool:read";
export const SECTION_WRITE = "tool:write";
export const SECTION_EDIT = "tool:edit";

/** Order values, above the built-in tool band to avoid registration-order ties. */
export const ORDER_READ = 130;
export const ORDER_WRITE = 131;
export const ORDER_EDIT = 132;

/**
 * The `read` call that re-opens a file under an explicit encoding.
 *
 * The single source for a hint that appears in four places: the `E_NOT_TEXT`
 * message, the auto-guess footer, this module's read section, and the generated
 * config template. They used to be four independent literals, so adding
 * `file_path` to the call meant editing all four — and a site that was missed
 * would hand the model a call the tool's own payload validation rejects, which
 * reads as a second, unrelated error.
 *
 * @param encoding - the encoding to name, or a placeholder when none applies.
 * @param filePath - the path to name, or a placeholder when none applies.
 */
export function reReadCall(encoding = "<name>", filePath = "<path>"): string {
  return `read({ file_path: ${JSON.stringify(filePath)}, encoding: ${JSON.stringify(encoding)} })`;
}

export const READ_DESCRIPTION =
  "Read a text file and return line-numbered content. Handles any text encoding: " +
  "UTF-8 (with or without BOM), UTF-16, UTF-32, and legacy code pages such as GBK, " +
  "Big5, Shift-JIS and the Windows ANSI pages. A non-UTF-8 file without a BOM fails " +
  "with candidate encodings listed; pass `encoding` to decode it explicitly.";

export const WRITE_DESCRIPTION =
  "Create or fully replace a text file. The file's existing encoding is preserved " +
  "byte-exactly (UTF-8 BOM, GBK, UTF-16 and so on); a new file is UTF-8 without a BOM. " +
  "Content that the file's encoding cannot represent is refused rather than written. " +
  "For a NEW file, pass `encoding` to create it in that encoding instead (gbk, big5, " +
  "utf16le, ...); on an existing file the argument is refused, because the file keeps " +
  "its own encoding.";

export const EDIT_DESCRIPTION =
  "Edit an existing text file by replacing literal text, preserving the file's " +
  "encoding and line endings exactly. By default `old_string` must appear exactly " +
  "once; set `replace_all` to replace every occurrence.";

export const INSERT_DESCRIPTION =
  "Insert line(s) into an existing text file at a line number, preserving the " +
  "file's encoding and line endings exactly. `insert_line` names the line to insert " +
  "AFTER: 0 inserts at the very top, and the file's line count appends. Line numbers " +
  "match what `read` shows.";

export const STR_REPLACE_EDITOR_DESCRIPTION =
  "View, create and edit text files by exact string match, preserving each file's " +
  "encoding and line endings. Commands: `view` {path, view_range?} shows numbered " +
  "lines, or lists a directory two levels deep; `str_replace` {path, old_str, " +
  "new_str} replaces the unique occurrence of old_str (set `replace_all` to allow " +
  "several); `insert` {path, insert_line, new_str} inserts AFTER insert_line (0 is " +
  "the top, the line count appends); `create` {path, file_text} creates a new file " +
  "and fails if it exists; `undo_edit` {path} reverts the last edit, exactly like " +
  "`undo_last_edit`.";

export const UNDO_DESCRIPTION =
  "Revert a file to the content and the encoding it had before its most recent " +
  "edit. Use when an edit produced the wrong result. Only the LAST edit can be " +
  "reverted, and only while the file still matches what that edit wrote — if the " +
  "file changed since, the undo is refused rather than overwriting those changes. " +
  "The history is held in memory, so it does not survive a restart.";

/**
 * The read result envelope, shared by `read` and by `str_replace_editor`'s `view`.
 *
 * Both tools show the same files to the same model, so they must agree on the
 * output shape AND on the line numbering — a model that read a file with one tool
 * and edits it with the other must not be working from two numbering schemes.
 * The window caps live here too, for the same reason: a file too large for one
 * entry point must not be unbounded through the other.
 */

/** Default line cap, matching the built-in read tool. */
export const DEFAULT_LIMIT = 2000;

/** Per-line character cap, matching the built-in read tool. */
const MAX_LINE_LENGTH = 2000;

/** Clip one over-long line the way the built-in read does. */
export function clipLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}

/**
 * Render a read window as the harness's `<path>/<type>/<content>` envelope.
 *
 * @param displayPath - the path as the model wrote it.
 * @param lines - the window's lines, each keeping its file line number.
 * @param offset - the 1-based first line of the window.
 * @param totalLines - the file's total line count.
 */
export function formatReadOutput(
  displayPath: string,
  lines: ReadonlyArray<{ number: number; text: string }>,
  offset: number,
  totalLines: number,
): string {
  const endLine = lines.at(-1)?.number ?? Math.max(0, offset - 1);
  const footer =
    endLine < totalLines
      ? `(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`
      : `(End of file - total ${totalLines} lines)`;
  const body =
    lines.length > 0
      ? `${lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`
      : footer;
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`;
}

export function readSectionText(): string {
  return (
    "Use the read tool to view a file's contents. It decodes UTF-8, UTF-16, UTF-32 and " +
    "legacy code pages automatically. A file that is not valid UTF-8 and has no BOM " +
    "fails with candidate encodings listed — re-read it with " +
    `${reReadCall()} to decode it. Reads are required ` +
    'before edit or "write" on an existing file.'
  );
}

export function writeSectionText(): string {
  return (
    "Use the write tool to create files or completely replace file contents. The file's " +
    "existing encoding and line endings are preserved, so editing a GBK or UTF-16 file " +
    "does not silently convert it to UTF-8. Existing files are overwritten, so read an " +
    "existing file first and prefer edit for targeted changes. When creating a new file, " +
    "pass encoding to write it in something other than UTF-8."
  );
}

export function editSectionText(): string {
  return (
    "Use the edit tool for targeted changes to existing text files. It replaces literal " +
    "old_string with new_string and preserves the file's encoding and line endings. By " +
    "default old_string must appear exactly once; if it appears multiple times, provide a " +
    "more specific old_string or set replace_all to true. Read the file first."
  );
}
