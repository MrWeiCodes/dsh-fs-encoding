/**
 * Line-ending helpers and the UTF-8 BOM marker.
 *
 * The harness's own `fs-local.editText` already round-trips line endings for
 * UTF-8 files. This plugin must do the same thing itself because it writes
 * bytes directly, so the logic lives here as pure functions shared by the read
 * and save paths.
 *
 * @module dsh-fs-encoding/line-endings
 */

/** The three line terminators this plugin preserves. */
export type LineEnding = "\r\n" | "\n" | "\r";

/** U+FEFF as a string — the character form of the UTF-8 BOM. */
export const UTF8_BOM = "\uFEFF";

/** The UTF-8 BOM's three bytes. */
export const UTF8_BOM_BYTES = Uint8Array.from([0xef, 0xbb, 0xbf]);

/**
 * Classify a text's dominant line ending.
 *
 * The FIRST terminator wins, matching the harness's own detection: a file whose
 * first break is CRLF is treated as CRLF throughout, so a stray lone LF later
 * in the file does not flip the whole file's style.
 *
 * @param content - the decoded text.
 * @returns the dominant line ending; LF for empty or break-free content.
 */
export function detectEnding(content: string): LineEnding {
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return content.includes("\r") ? "\r" : "\n";
  const crlfIdx = content.indexOf("\r\n");
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/**
 * Normalize every terminator to LF.
 *
 * @param text - the text to normalize.
 * @returns the text with no CR characters left.
 */
export function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Rewrite LF terminators back to the recorded style.
 *
 * @param text - LF-normalized text.
 * @param ending - the style to restore.
 * @returns the text with the requested terminators.
 */
export function restoreEndings(text: string, ending: LineEnding): string {
  if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
  if (ending === "\r") return text.replace(/\n/g, "\r");
  return text;
}

/**
 * Split a leading U+FEFF off a decoded string.
 *
 * @param content - the decoded text.
 * @returns the BOM (or `""`) and the remaining text.
 */
export function stripBOM(content: string): { bom: string; text: string } {
  return content.startsWith(UTF8_BOM)
    ? { bom: UTF8_BOM, text: content.slice(1) }
    : { bom: "", text: content };
}

/**
 * Count lines the way the model-facing tools report them: a trailing newline
 * does not open a new line.
 *
 * @param text - the text to split.
 * @returns one entry per visible line.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [""];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}
