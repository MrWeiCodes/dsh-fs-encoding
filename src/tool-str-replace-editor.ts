/**
 * The `str_replace_editor` compatibility tool.
 *
 * Registers under the name Anthropic's text-editor tool uses and the harness
 * shadows, so a model whose habits were formed around that tool — or a prompt
 * written for it — keeps working. Every command is routed through this plugin's
 * own IO, which is the whole point: the harness's version reads and writes UTF-8
 * text, so `str_replace` and `insert` corrupt any legacy-encoded file. Here they
 * decode under the file's recorded encoding and re-encode on save.
 *
 * Command semantics follow the harness (which follows Anthropic), deliberately:
 *
 * - `insert_line` inserts AFTER the named line, `0` being the top. See
 *   `insertAfterLine` for why the direction is not a free choice.
 * - `str_replace` requires a unique match and refuses otherwise. `replace_all` is
 *   accepted as an OPT-IN extension — omitting it reproduces the harness exactly.
 * - `create` refuses an existing file rather than overwriting it.
 * - `view` lists a directory (2 levels, hidden entries skipped) or shows a file
 *   with line numbers.
 * - `undo_edit` is NOT supported. It is listed so a caller that sends it gets a
 *   sentence saying so, rather than a schema error that names no command; the
 *   harness dropped it too (Anthropic exposes it only on Claude 3.5 and earlier).
 *
 * @module dsh-fs-encoding/tool-str-replace-editor
 */

import type { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { listDirectory } from "./directory-list.js";
import { DecodeError, UnmappableError } from "./encoding-state.js";
import { diffForResult, formatLineChangeSummary } from "./diff-hunks.js";
import { readFile, writeFile } from "./io.js";
import {
  countInsertedLines,
  countVisibleLines,
  hasLoneCarriageReturn,
  insertAfterLine,
  occurrenceLines,
  replaceMatches,
  sliceLines,
  splitForEdit,
} from "./line-edit.js";
import { toLF } from "./line-endings.js";
import { STR_REPLACE_EDITOR_DESCRIPTION, DEFAULT_LIMIT, clipLine, formatReadOutput } from "./prompts.js";
import type { EncodingSandbox, FsEscalationArgs } from "./sandbox.js";
import { execCwd } from "./workspace-context.js";

/**
 * The commands this tool answers to.
 *
 * The names match the harness exactly, except that `undo_edit` is listed only so
 * a caller that sends it reaches the sentence explaining it is unsupported.
 */
const COMMANDS = ["view", "create", "str_replace", "insert", "undo_edit"] as const;

/** How many occurrence line numbers the ambiguity message lists. */
const AMBIGUITY_LINES_SHOWN = 20;

/**
 * Read a non-empty string argument, or fail with this plugin's payload code.
 *
 * `null` is rejected explicitly rather than treated as absent: the harness's
 * parameter schema accepts `null` as an omitted placeholder, so by the time a
 * value reaches here a `null` is a malformed call, not an omission.
 */
function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[E_BAD_PAYLOAD] str_replace_editor: "${name}" must be a non-empty string.`);
  }
  return value;
}

/**
 * Read an optional string argument.
 *
 * `undefined` and `null` both mean "not supplied", which is what the harness's
 * schema documents: it declares these parameters as `oneOf: [string, null]` and
 * calls the null form "a null placeholder treated as omitted by commands that do
 * not use this parameter". A model that learned the tool from that schema sends
 * `null`, so rejecting it here would break exactly the calls this tool exists to
 * keep working.
 *
 * @param args - the call's arguments.
 * @param name - the parameter name.
 * @returns the string, or `undefined` when absent.
 * @throws when a non-string, non-null value was supplied.
 */
function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`[E_BAD_PAYLOAD] str_replace_editor: "${name}" must be a string.`);
  }
  return value;
}

/**
 * Read an optional integer argument, treating `null` as omitted.
 *
 * @param args - the call's arguments.
 * @param name - the parameter name.
 * @returns the integer, or `undefined` when absent.
 * @throws when a non-integer, non-null value was supplied.
 */
function optionalInteger(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value)) {
    throw new Error(`[E_BAD_PAYLOAD] str_replace_editor: "${name}" must be an integer.`);
  }
  return value as number;
}

/** Parse `view_range`, when given. */
function parseViewRange(args: Record<string, unknown>): [number, number] | undefined {
  const value = args["view_range"];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isInteger(value[0]) ||
    !Number.isInteger(value[1])
  ) {
    throw new Error(
      '[E_BAD_PAYLOAD] str_replace_editor: "view_range" must be [start, end] integers.',
    );
  }
  return [value[0] as number, value[1] as number];
}

/**
 * Build the `str_replace_editor` tool.
 *
 * @param ctx - the plugin's host context.
 * @param sandbox - the fence and `fs/*` event gate.
 */
export function buildStrReplaceEditorTool(ctx: Context, sandbox: EncodingSandbox) {
  return defineTool({
    name: "str_replace_editor",
    description: STR_REPLACE_EDITOR_DESCRIPTION,
    parameters: {
      command: {
        type: "string",
        required: true,
        description: `The command to run. One of: ${COMMANDS.join(", ")}.`,
      },
      path: {
        type: "string",
        required: true,
        description: "Path to the file or directory.",
      },
      file_text: {
        oneOf: [{ type: "string" }, { type: "null" }],
        description:
          "Content for the `create` command. May be empty, which creates an empty " +
          "file. A null placeholder is treated as omitted by commands that do not use it.",
      },
      insert_line: {
        oneOf: [{ type: "integer" }, { type: "null" }],
        description:
          "For `insert`: the line number to insert AFTER. 0 inserts at the very top; " +
          "the file's line count appends. A null placeholder is treated as omitted by " +
          "commands that do not use it.",
      },
      new_str: {
        oneOf: [{ type: "string" }, { type: "null" }],
        description:
          "New text for `str_replace` or `insert`. For `str_replace`, omit it (or pass " +
          "an empty string) to delete the match — an explicit null is refused, because " +
          "only an omission means \"delete\". A null placeholder is accepted only by " +
          "commands that do not use this parameter.",
      },
      old_str: {
        oneOf: [{ type: "string" }, { type: "null" }],
        description:
          "Text to replace for `str_replace`. Must match exactly once. A null placeholder " +
          "is treated as omitted by commands that do not use it.",
      },
      replace_all: {
        type: "boolean",
        description:
          "Extension: replace every occurrence instead of requiring a unique match. " +
          "Omit to keep the standard behaviour.",
      },
      view_range: {
        type: "json",
        description:
          "For `view`: [start, end] 1-based inclusive line range. `[start, -1]` shows " +
          "from `start` to the end of the file.",
      },
      ...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          command: { type: "string", required: true },
          text: { type: "string", required: true },
          /** Present for the mutating commands, so the card can show a diff. */
          before: { type: "string" },
          after: { type: "string" },
        },
      },
      render: (_args, value) => {
        const v = value as { path: string; command: string; text: string; before?: string; after?: string };
        // The mutating commands append the change size, same as `edit`/`insert`;
        // `view` has no change to report.
        if (v.before === undefined || v.after === undefined) {
          return [{ type: "text" as const, text: v.text }];
        }
        const summary = formatLineChangeSummary(
          diffForResult(v, v.path, v.before, v.after).count,
        );
        return [{ type: "text" as const, text: `${v.text}${summary}` }];
      },
      presentationMeta: (_args, value) => {
        const v = value as { path: string; before?: string; after?: string };
        if (v.before === undefined || v.after === undefined) return { diffs: [] };
        return { diffs: diffForResult(v, v.path, v.before, v.after).diffs };
      },
    },
    async execute(args, exec: ToolExecution) {
      const rec = (args ?? {}) as Record<string, unknown>;
      const cwd = execCwd(exec);

      const command = rec["command"];
      if (typeof command !== "string" || !(COMMANDS as readonly string[]).includes(command)) {
        throw new Error(
          `[E_BAD_PAYLOAD] str_replace_editor: unknown command ${JSON.stringify(command)} — ` +
            `expected one of ${COMMANDS.join(", ")}.`,
        );
      }

      if (command === "undo_edit") {
        // Listed in the enum so this sentence is reachable. The harness has no
        // undo_edit either; Anthropic exposes it only on Claude 3.5 and earlier.
        throw new Error(
          "[E_UNSUPPORTED] str_replace_editor: undo_edit is not supported — this plugin keeps " +
            "no edit history. Re-apply the previous content with `str_replace` or `write` instead.",
        );
      }

      const path = requireString(rec, "path");
      const policy = await sandbox.resolvePolicy(
        "str_replace_editor",
        rec as FsEscalationArgs,
        exec,
      );

      let target;
      try {
        target = await ctx.fs.resolve(path, {
          cwd,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        });
      } catch (error) {
        throw sandbox.mapError(error, policy);
      }

      if (command === "view") {
        // Only a genuine "not there" counts as absent, so a stat that THROWS
        // (permission denied, not-a-directory, an I/O fault) is mapped and
        // rethrown rather than folded into `undefined`. Folding it in would
        // report a file that exists as missing AND record it as confirmed absent,
        // which flips the write guard for that path from fail-closed
        // (`replaceIfVersion`) to fail-open (`createIfAbsent`).
        let info: Awaited<ReturnType<typeof ctx.fs.stat>>;
        try {
          info = await ctx.fs.stat(target, exec.signal);
        } catch (error) {
          throw sandbox.mapError(error, policy);
        }
        if (info === undefined) {
          // Report the absence to the observation gate before failing, exactly as
          // the built-in `read` and this plugin's `readFile` do. Without it the
          // policy keeps whatever it last knew — normally `present@old-version` —
          // and every later write to this path fails `FS_STALE_VERSION` for the
          // rest of the session, with nothing able to clear it.
          try {
            ctx.emit("fs/observed", target, { kind: "absent" }, exec);
          } catch (error) {
            ctx.logger.warn(
              `dsh-fs-encoding: fs/observed (absent) emission failed for ${path}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          throw new FsError(`cannot view "${path}": no such file or directory`, "FS_NOT_FOUND");
        }
        if (info.type === "directory") {
          if (parseViewRange(rec) !== undefined) {
            throw new Error(
              '[E_BAD_PAYLOAD] str_replace_editor: "view_range" is not allowed for a directory.',
            );
          }
          return {
            path,
            command,
            text: await listDirectory(ctx.fs, target, exec.signal),
          };
        }
        if (info.type !== "file") {
          throw new FsError(
            `cannot view "${path}": not a regular file or directory`,
            "FS_NOT_REGULAR_FILE",
          );
        }

        let outcome: Awaited<ReturnType<typeof readFile>>;
        try {
          outcome = await readFile(ctx, path, cwd, { signal: exec.signal, exec });
        } catch (error) {
          if (error instanceof DecodeError) throw new Error(error.message);
          throw sandbox.mapError(error, policy);
        }

        // Counted without splitting: `total` is only needed for the range checks
        // and the footer, and materializing every line of a multi-megabyte file
        // to learn a number was this call's dominant cost. It is `read`'s own
        // count, so the two tools cannot report different totals for one file.
        const total = countVisibleLines(outcome.text);
        const range = parseViewRange(rec);
        // One ceiling for both bounds AND for the window. An empty file reports 0
        // lines, yet `read` still addresses line 1 there (its window floor is
        // `Math.max(totalLines, 1)`) and renders one blank line. Bounding the
        // window by the raw total made `view` render NO lines for a file holding a
        // single newline while `read` rendered one.
        const lineCeiling = Math.max(total, 1);
        let offset = 1;
        let requested = lineCeiling;
        if (range !== undefined) {
          const [start, end] = range;
          if (start < 1) {
            // A sentence, not a throw: the model can read a range hint and retry,
            // where a bare error only tells it that something was wrong. The two
            // out-of-range directions get different sentences because the fixes
            // are different, and one message for both would send the model the
            // wrong way.
            return {
              path,
              command,
              text: `View range [${start}, ${end}] is invalid for ${path}: the first line must be 1 or greater.`,
            };
          }
          if (start > lineCeiling) {
            return {
              path,
              command,
              text: `View range [${start}, ${end}] is beyond the end of ${path} (${total} line(s) total).`,
            };
          }
          // The harness rejects an inverted range outright; returning an empty
          // window instead would hand `formatReadOutput` a start above its end and
          // produce a footer that asks the model to retry the same offset forever.
          if (end !== -1 && end < start) {
            return {
              path,
              command,
              text: `View range [${start}, ${end}] is invalid for ${path}: the last line must be -1 (to the end) or not smaller than the first (${start}).`,
            };
          }
          // The harness also rejects an end past the last line rather than
          // silently clamping it, so a typo in the range is reported instead of
          // reading as a complete window.
          if (end !== -1 && end > lineCeiling) {
            return {
              path,
              command,
              text: `View range [${start}, ${end}] is invalid for ${path}: the last line must be -1 (to the end) or within the file's ${total} line(s).`,
            };
          }
          offset = start;
          requested = end === -1 ? lineCeiling - start + 1 : end - start + 1;
        }
        // The range checks above guarantee `1 <= offset <= lineCeiling` and
        // `requested <= lineCeiling - offset + 1` (and the no-range path starts from
        // `offset = 1, requested = lineCeiling`), so a request can never reach past
        // the file: `requested` is already the window size and needs no clamping.

        // Only the window is ever materialized, and only up to the same cap `read`
        // applies: `view` reaches the same files with the same model, so a file
        // too big for one entry point must not be unbounded through the other.
        const sliced = sliceLines(outcome.text, offset, Math.min(requested, DEFAULT_LIMIT));
        // `sliceLines` follows the line-ARRAY rule, where empty text has no lines at
        // all; `read` renders one blank line for it. The range checks above leave
        // empty text as the only input that can reach here with no lines, so that one
        // case is the whole of the difference — adding the line here keeps the bodies
        // identical without giving `sliceLines` a second meaning.
        const lines = sliced.length === 0 ? [""] : sliced;
        const clipped = requested > DEFAULT_LIMIT;
        const body = formatReadOutput(
          path,
          lines.map((text, i) => ({ number: offset + i, text: clipLine(text) })),
          offset,
          total,
        );
        // The shared footer is written for `read`, whose continuation argument is
        // `offset`; this tool has no such parameter and continues with
        // `view_range`. Whenever the window stops short of the end — whether the
        // cap bit or the caller's own range did — the footer's hint would send the
        // model to an argument this tool ignores, so the correction is appended.
        // `lines` is never empty (the patch above guarantees at least one entry), so
        // the last shown line is simply the offset plus the window's length.
        const lastShown = offset + lines.length - 1;
        const notice =
          lastShown < total
            ? `\n(The "offset" hint above is for the read tool; to continue here, call view ` +
              `again with view_range=[${lastShown + 1}, -1].)` +
              (clipped ? `\n(Truncated to ${lines.length} lines by this tool's limit.)` : "")
            : "";
        // The auto-guess provenance must reach the model through this tool too:
        // `read` reports it as a warning, and a decode that is only a guess must
        // not look authoritative just because it arrived through `view`.
        const footer = outcome.footer === undefined ? "" : `\n${outcome.footer.trim()}`;
        return { path, command, text: `${body}${notice}${footer}` };
      }

      if (command === "create") {
        const fileText = optionalString(rec, "file_text");
        if (fileText === undefined) {
          throw new Error(
            '[E_BAD_PAYLOAD] str_replace_editor: "file_text" is required for create ' +
              "(pass an empty string to create an empty file).",
          );
        }
        // Only a genuine "not there" counts as absent. Swallowing every stat error
        // would read a permission failure as "no file", and `writeFile` would then
        // take the write guard for a file that does exist.
        let existing: Awaited<ReturnType<typeof ctx.fs.stat>>;
        try {
          existing = await ctx.fs.stat(target, exec.signal);
        } catch (error) {
          throw sandbox.mapError(error, policy);
        }
        if (existing !== undefined) {
          throw new Error(
            `[E_FILE_EXISTS] str_replace_editor: cannot create ${path} — the file already ` +
              `exists. Use str_replace or insert to change it.`,
          );
        }
        try {
          // NOT normalized to LF: a file being created has no recorded line ending
          // for `encodeForSave` to restore, so `toLF` here would silently rewrite
          // the CRLF the caller explicitly asked for. `write` does not normalize a
          // new file either, and the two must agree.
          await writeFile(ctx, sandbox, { target, content: fileText, exec, policy }, "write");
        } catch (error) {
          if (error instanceof UnmappableError || error instanceof DecodeError) {
            throw new Error(error.message);
          }
          if (error instanceof FsError) throw error;
          throw sandbox.mapError(error, policy);
        }
        return { path, command, text: `Created ${path}.` };
      }

      // str_replace / insert: both start from the file's current text.
      let raw: string;
      let current: string;
      try {
        const outcome = await readFile(ctx, path, cwd, { signal: exec.signal, exec });
        raw = outcome.text;
        current = toLF(outcome.text);
      } catch (error) {
        if (error instanceof DecodeError) throw new Error(error.message);
        throw sandbox.mapError(error, policy);
      }

      let next: string;
      let text: string;

      if (command === "str_replace") {
        const oldStr = requireString(rec, "old_str");
        // The harness distinguishes the two forms here and they must not be
        // conflated: an OMITTED `new_str` means "delete the match" (`newStr ?? ""`),
        // while an EXPLICIT `null` is a malformed call it refuses outright
        // (`if (newStr === null) throw`). The schema accepts `null` as a
        // placeholder for parameters a command does not use, and `str_replace`
        // does use this one — so a `null` here is a mistake, and silently deleting
        // the match would destroy content the caller meant to leave alone.
        if (rec["new_str"] === null) {
          throw new Error(
            '[E_BAD_PAYLOAD] str_replace_editor: "new_str" must be omitted (not null) to ' +
              "delete the match, or contain the replacement text.",
          );
        }
        const newStr = optionalString(rec, "new_str") ?? "";
        const replaceAll = rec["replace_all"] === true;
        const oldNorm = toLF(oldStr);
        const result = replaceMatches(current, oldNorm, toLF(newStr), replaceAll);

        if (result.replaced === 0) {
          throw new FsError(
            `old_str was not found in "${path}". Nothing was written.`,
            "FS_EDIT_NOT_FOUND",
          );
        }
        if (result.replaced > 1 && !replaceAll) {
          // Name the first few lines and the total. A one-character `old_str` can
          // match millions of times, and splicing every line number into the
          // message would build a model-facing string as large as the file.
          const shown = occurrenceLines(current, oldNorm, AMBIGUITY_LINES_SHOWN);
          const more =
            result.replaced > shown.length ? `, … (${result.replaced} total)` : "";
          throw new FsError(
            `old_str matched ${result.replaced} times in "${path}" ` +
              `(lines ${shown.join(", ")}${more}); ` +
              `include more context to make it unique, or set replace_all to true. ` +
              `Nothing was written.`,
            "FS_AMBIGUOUS_EDIT",
          );
        }
        next = result.text;
        text = `Replaced ${result.replaced} occurrence(s) in ${path}.`;
      } else {
        const rawLine = optionalInteger(rec, "insert_line");
        if (rawLine === undefined || rawLine < 0) {
          throw new Error(
            '[E_BAD_PAYLOAD] str_replace_editor: "insert_line" must be a non-negative integer ' +
              "for insert (0 inserts at the top).",
          );
        }
        const rawNewStr = optionalString(rec, "new_str");
        if (rawNewStr === undefined) {
          throw new Error('[E_BAD_PAYLOAD] str_replace_editor: "new_str" is required for insert.');
        }
        // A lone-CR file has two disagreeing line counts — `read` sees one line,
        // the LF-normalized text sees many — so a line number cannot be honoured
        // unambiguously. Refuse rather than insert in the wrong place.
        if (hasLoneCarriageReturn(raw)) {
          throw new Error(
            `[E_BAD_PAYLOAD] str_replace_editor: "${path}" uses lone CR line endings, which ` +
              `have no single line numbering. Convert it to LF or CRLF first, then insert. ` +
              `Nothing was written.`,
          );
        }
        const insertText = toLF(rawNewStr);
        let inserted: string;
        try {
          inserted = insertAfterLine(current, rawLine, insertText);
        } catch (error) {
          if (error instanceof RangeError) {
            // Computed here, not before the call: the happy path does not need the
            // count, and walking a multi-megabyte file to format an error that is
            // usually not raised would be wasted work on every insert.
            const lineCount = splitForEdit(current).length;
            throw new Error(
              `[E_BAD_PAYLOAD] str_replace_editor: insert_line ${rawLine} is outside the ` +
                `file's range: [0, ${lineCount}]. Nothing was written.`,
            );
          }
          throw error;
        }
        next = inserted;
        const where = rawLine === 0 ? "at the top" : `after line ${rawLine}`;
        text = `Inserted ${countInsertedLines(insertText)} line(s) ${where} in ${path}.`;
      }

      try {
        await writeFile(ctx, sandbox, { target, content: next, exec, policy }, "edit");
      } catch (error) {
        if (error instanceof UnmappableError || error instanceof DecodeError) {
          throw new Error(error.message);
        }
        if (error instanceof FsError) throw error;
        throw sandbox.mapError(error, policy);
      }

      return { path, command, text, before: current, after: next };
    },
  });
}
