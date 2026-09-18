/**
 * The encoding-governed `edit` tool.
 *
 * Contract-compatible with the built-in `edit` (same `file_path` /
 * `old_string` / `new_string` / `replace_all` arguments, same
 * `path`/`before`/`after` result shape and diff card). The difference is
 * entirely in the storage path: the file is decoded under its recorded
 * encoding, matched against LF-normalized text, and re-encoded back into that
 * same encoding, so editing a GBK file leaves it a GBK file.
 *
 * @module dsh-fs-encoding/tool-edit
 */

import type { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { DecodeError, UnmappableError } from "./encoding-state.js";
import { diffForResult, formatLineChangeSummary } from "./diff-hunks.js";
import { readFile, writeFile } from "./io.js";
import { toLF } from "./line-endings.js";
import { EDIT_DESCRIPTION } from "./prompts.js";
import type { EncodingSandbox, FsEscalationArgs } from "./sandbox.js";
import { execCwd } from "./workspace-context.js";

function formatEditOutput(displayPath: string, replaceAll: boolean): string {
  return replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`;
}

/** Parse and validate the edit arguments. */
function parseArgs(args: Record<string, unknown>): {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
} {
  const path = args["file_path"] ?? args["path"];
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('[E_BAD_PAYLOAD] edit: "file_path" must be a non-empty string.');
  }
  const oldString = args["old_string"];
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new Error('[E_BAD_PAYLOAD] edit: "old_string" must be a non-empty string.');
  }
  const newString = args["new_string"];
  if (typeof newString !== "string") {
    throw new Error('[E_BAD_PAYLOAD] edit: "new_string" must be a string.');
  }
  const rawReplaceAll = args["replace_all"];
  if (rawReplaceAll !== undefined && typeof rawReplaceAll !== "boolean") {
    throw new Error('[E_BAD_PAYLOAD] edit: "replace_all" must be a boolean.');
  }
  return { path, oldString, newString, replaceAll: rawReplaceAll === true };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Build the encoding-governed `edit` tool.
 *
 * @param ctx - the plugin's host context.
 * @param sandbox - the fence and `fs/*` event gate.
 */
export function buildEditTool(ctx: Context, sandbox: EncodingSandbox) {
  return defineTool({
    name: "edit",
    description: EDIT_DESCRIPTION,
    parameters: {
      file_path: {
        type: "string",
        required: true,
        description: "Path to edit, resolved by the filesystem backend.",
      },
      old_string: {
        type: "string",
        required: true,
        description: "Literal text to replace. Must match exactly.",
      },
      new_string: {
        type: "string",
        required: true,
        description: "Literal replacement text. Use an empty string to delete the match.",
      },
      replace_all: {
        type: "boolean",
        description:
          "Replace all matches. Defaults to false; when false, old_string must appear exactly once.",
      },
      ...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          before: { type: "string", required: true },
          after: { type: "string", required: true },
        },
      },
      render: (args, value) => {
        const v = value as { path: string; before: string; after: string };
        const a = args as { replace_all?: boolean };
        // The built-in message plus the size of the change, so the model can see
        // how much it actually edited without re-reading the file. The counts are
        // the REAL changed lines — context excluded — which is why they come from
        // the shared analysis and not from the diff regions the UI renders.
        //
        // `diffForResult` is shared with `presentationMeta` below: the harness
        // calls both for one result, and each would otherwise diff the whole file.
        const summary = formatLineChangeSummary(
          diffForResult(v, v.path, v.before, v.after).count,
        );
        return [
          { type: "text" as const, text: `${formatEditOutput(v.path, a.replace_all ?? false)}${summary}` },
        ];
      },
      presentationMeta: (args, value) => {
        const v = value as { path: string; before: string; after: string };
        // Report the CHANGED REGIONS, not the whole file. The card counts every
        // line of `oldText` as removed and every line of `newText` as added, so
        // handing it the full texts made a one-line edit read as "changed 2,400
        // lines" — which reads as the plugin having rewritten the file. See
        // `computeHunkDiffs`.
        //
        // The path comes from the RESULT, not from `args.file_path`: the result
        // is the path the edit actually ran against (it resolves the `path`
        // alias too), and it is what `render` above stamps, so the card and the
        // message cannot disagree.
        return {
          diffs: diffForResult(v, v.path, v.before, v.after).diffs,
        };
      },
    },
    async execute(args, exec: ToolExecution) {
      const input = parseArgs((args ?? {}) as Record<string, unknown>);
      const cwd = execCwd(exec);
      const policy = await sandbox.resolvePolicy("edit", (args ?? {}) as FsEscalationArgs, exec);

      let target;
      let current: string;
      try {
        target = await ctx.fs.resolve(input.path, {
          cwd,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        });
        // Read through the plugin's own path so the encoding memo is populated
        // and the file is decoded under its real encoding. `exec` is required:
        // it is what scopes the memo to this session.
        const outcome = await readFile(ctx, input.path, cwd, { signal: exec.signal, exec });
        current = toLF(outcome.text);
      } catch (error) {
        if (error instanceof DecodeError) throw new Error(error.message);
        throw sandbox.mapError(error, policy);
      }

      // Match against LF-normalized text on both sides, exactly like the
      // built-in: a model that wrote CRLF inside old_string still matches.
      const oldNorm = toLF(input.oldString);
      const newNorm = toLF(input.newString);
      const matches = countOccurrences(current, oldNorm);

      if (matches === 0) {
        throw new FsError(
          `old_string was not found in "${input.path}"`,
          "FS_EDIT_NOT_FOUND",
        );
      }
      if (!input.replaceAll && matches > 1) {
        throw new FsError(
          `old_string matched ${matches} times in "${input.path}"; provide a more specific old_string or set replace_all to true`,
          "FS_AMBIGUOUS_EDIT",
        );
      }

      const next = current.split(oldNorm).join(newNorm);

      try {
        await writeFile(
          ctx,
          sandbox,
          { target, content: next, exec, policy },
          "edit",
        );
      } catch (error) {
        if (error instanceof UnmappableError || error instanceof DecodeError) {
          throw new Error(error.message);
        }
        if (error instanceof FsError) throw error;
        throw sandbox.mapError(error, policy);
      }

      return { path: input.path, before: current, after: next };
    },
  });
}
