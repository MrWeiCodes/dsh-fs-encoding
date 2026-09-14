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

export const READ_DESCRIPTION =
  "Read a text file and return line-numbered content. Handles any text encoding: " +
  "UTF-8 (with or without BOM), UTF-16, UTF-32, and legacy code pages such as GBK, " +
  "Big5, Shift-JIS, EUC-KR, Windows-1251 and ISO-8859-1. A non-UTF-8 file without a " +
  "BOM fails with candidate encodings listed; pass `encoding` to decode it explicitly.";

export const WRITE_DESCRIPTION =
  "Create or fully replace a text file. The file's existing encoding is preserved " +
  "byte-exactly (UTF-8 BOM, GBK, UTF-16 and so on); a new file is UTF-8 without a BOM. " +
  "Content that the file's encoding cannot represent is refused rather than written.";

export const EDIT_DESCRIPTION =
  "Edit an existing text file by replacing literal text, preserving the file's " +
  "encoding and line endings exactly. By default `old_string` must appear exactly " +
  "once; set `replace_all` to replace every occurrence.";

export function readSectionText(): string {
  return (
    "Use the read tool to view a file's contents. It decodes UTF-8, UTF-16, and legacy " +
    "code pages such as GBK, Big5, Shift-JIS, EUC-KR and Windows-1251. A non-UTF-8 file " +
    "without a BOM fails with candidate encodings listed — re-read it with " +
    'read({ encoding: "<name>" }) to decode it. Reads are required before edit or "write" ' +
    "on an existing file."
  );
}

export function writeSectionText(): string {
  return (
    "Use the write tool to create files or completely replace file contents. The file's " +
    "existing encoding and line endings are preserved, so editing a GBK or UTF-16 file " +
    "does not silently convert it to UTF-8. Existing files are overwritten, so read an " +
    "existing file first and prefer edit for targeted changes."
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
