/**
 * The encoding-governed `insert` tool: add lines at a line number.
 *
 * The one capability the plugin's `read` / `write` / `edit` set was missing. A
 * literal-match edit can only insert where it can quote surrounding text, which is
 * awkward for the common "add a line at the top" or "append after the imports" —
 * the model has to read the file first and reproduce a line exactly. Addressing by
 * line number removes that.
 *
 * `insert_line` follows Anthropic's text-editor semantics, which is also what the
 * harness's `str_replace_editor` uses: the text goes AFTER the named line, `0`
 * means the very top, and `lines.length` appends. See `insertAfterLine`.
 *
 * The file is decoded under its recorded encoding and re-encoded on save, so
 * inserting into a GBK file leaves it a GBK file — the harness's `insert` command
 * cannot do that, because it reads and writes UTF-8 text.
 *
 * @module dsh-fs-encoding/tool-insert
 */

import type { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { DecodeError, UnmappableError } from "./encoding-state.js";
import {
  countInsertedLines,
  hasLoneCarriageReturn,
  insertAfterLine,
  splitForEdit,
} from "./line-edit.js";
import { diffForResult, formatLineChangeSummary } from "./diff-hunks.js";
import { readFile, writeFile } from "./io.js";
import { toLF } from "./line-endings.js";
import { INSERT_DESCRIPTION } from "./prompts.js";
import type { EncodingSandbox, FsEscalationArgs } from "./sandbox.js";
import { execCwd } from "./workspace-context.js";

/** Parse and validate the insert arguments. */
function parseArgs(args: Record<string, unknown>): {
  path: string;
  insertLine: number;
  newString: string;
} {
  const path = args["file_path"] ?? args["path"];
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('[E_BAD_PAYLOAD] insert: "file_path" must be a non-empty string.');
  }
  const rawLine = args["insert_line"];
  if (!Number.isInteger(rawLine) || (rawLine as number) < 0) {
    throw new Error('[E_BAD_PAYLOAD] insert: "insert_line" must be a non-negative integer.');
  }
  const newString = args["new_string"];
  if (typeof newString !== "string") {
    throw new Error('[E_BAD_PAYLOAD] insert: "new_string" must be a string.');
  }
  return { path, insertLine: rawLine as number, newString };
}

/**
 * Build the encoding-governed `insert` tool.
 *
 * @param ctx - the plugin's host context.
 * @param sandbox - the fence and `fs/*` event gate.
 */
export function buildInsertTool(ctx: Context, sandbox: EncodingSandbox) {
  return defineTool({
    name: "insert",
    description: INSERT_DESCRIPTION,
    parameters: {
      file_path: {
        type: "string",
        required: true,
        description: "Path to edit, resolved by the filesystem backend.",
      },
      insert_line: {
        type: "number",
        required: true,
        description:
          "Line number to insert AFTER. 0 inserts at the very top; the number of " +
          "lines in the file appends. Line numbers match what `read` shows.",
      },
      new_string: {
        type: "string",
        required: true,
        description: "Line or lines to insert. May span multiple lines.",
      },
      ...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          insertLine: { type: "number", required: true },
          insertedLines: { type: "number", required: true },
          before: { type: "string", required: true },
          after: { type: "string", required: true },
        },
      },
      render: (_args, value) => {
        const v = value as {
          path: string;
          insertLine: number;
          insertedLines: number;
          before: string;
          after: string;
        };
        // Same shape as `edit`: the built-in sentence, then the size of the change
        // so the model can confirm what it did without re-reading the file.
        const summary = formatLineChangeSummary(
          diffForResult(v, v.path, v.before, v.after).count,
        );
        const where = v.insertLine === 0 ? "at the top" : `after line ${v.insertLine}`;
        return [
          {
            type: "text" as const,
            text: `Inserted ${v.insertedLines} line(s) into ${v.path} ${where}.${summary}`,
          },
        ];
      },
      presentationMeta: (_args, value) => {
        const v = value as { path: string; before: string; after: string };
        return { diffs: diffForResult(v, v.path, v.before, v.after).diffs };
      },
    },
    async execute(args, exec: ToolExecution) {
      const input = parseArgs((args ?? {}) as Record<string, unknown>);
      const cwd = execCwd(exec);
      const policy = await sandbox.resolvePolicy("insert", (args ?? {}) as FsEscalationArgs, exec);

      let target;
      let raw: string;
      let current: string;
      try {
        target = await ctx.fs.resolve(input.path, {
          cwd,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        });
        // Read through the plugin's own path: that is what populates the encoding
        // memo the save will invert, and what applies the read-before-write gate.
        const outcome = await readFile(ctx, input.path, cwd, { signal: exec.signal, exec });
        raw = outcome.text;
        current = toLF(outcome.text);
      } catch (error) {
        if (error instanceof DecodeError) throw new Error(error.message);
        throw sandbox.mapError(error, policy);
      }

      // A lone-CR file has TWO valid line counts and they disagree: `read` splits
      // on `\n` alone (so the file is one line to the model), while this tool
      // normalizes to LF first and would count every CR as a break. A line number
      // is valid in both readings and cannot be told apart, so the call is refused
      // rather than silently inserting in the wrong place.
      if (hasLoneCarriageReturn(raw)) {
        throw new Error(
          `[E_BAD_PAYLOAD] insert: "${input.path}" uses lone CR line endings, which have ` +
            `no single line numbering. Convert it to LF or CRLF first, then insert. ` +
            `Nothing was written.`,
        );
      }

      // A plain Error, not an FsError: `dsh-fs`'s `FsErrorCode` is a closed set
      // that has no code for a bad argument, and inventing one would put a name in
      // a model-facing error that no other component understands. `E_BAD_PAYLOAD`
      // is this plugin's own vocabulary for exactly this case.
      const insertText = toLF(input.newString);
      let next: string;
      try {
        next = insertAfterLine(current, input.insertLine, insertText);
      } catch (error) {
        if (error instanceof RangeError) {
          // Computed here, not before the call: the happy path does not need the
          // count, and walking a multi-megabyte file to format an error that is
          // usually not raised would be wasted work on every insert.
          const lineCount = splitForEdit(current).length;
          throw new Error(
            `[E_BAD_PAYLOAD] insert: insert_line ${input.insertLine} is outside the file's ` +
              `range: [0, ${lineCount}]. Nothing was written.`,
          );
        }
        throw error;
      }

      try {
        await writeFile(
          ctx,
          sandbox,
          { target, content: next, exec, policy, previousText: current },
          "edit",
        );
      } catch (error) {
        if (error instanceof UnmappableError || error instanceof DecodeError) {
          throw new Error(error.message);
        }
        if (error instanceof FsError) throw error;
        throw sandbox.mapError(error, policy);
      }

      return {
        path: input.path,
        insertLine: input.insertLine,
        insertedLines: countInsertedLines(insertText),
        before: current,
        after: next,
      };
    },
  });
}
