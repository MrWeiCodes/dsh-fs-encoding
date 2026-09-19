/**
 * The encoding-governed `read` tool.
 *
 * Contract-compatible with the built-in `read` (same `file_path` / `offset` /
 * `limit` arguments, same line-numbered output shape) plus one addition: an
 * `encoding` argument that decodes a file explicitly, mirroring VS Code's
 * "Reopen with Encoding". That argument is what makes a legacy file reachable —
 * without it a GBK file would only ever be a list of candidates.
 *
 * @module dsh-fs-encoding/tool-read
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { normalizeEncoding, SUPPORTED_ENCODINGS_TEXT } from "./encoding.js";
import { DecodeError } from "./encoding-state.js";
import { readFile } from "./io.js";
import { READ_DESCRIPTION, DEFAULT_LIMIT, clipLine, formatReadOutput } from "./prompts.js";
import { countVisibleLines } from "./line-edit.js";
import { splitLines } from "./line-endings.js";
import { execCwd } from "./workspace-context.js";

/** Parse and validate the read arguments, returning a stable shape. */
function parseArgs(args: Record<string, unknown>): {
  path: string;
  offset: number;
  limit: number;
  encoding?: string;
} {
  const path = args["file_path"] ?? args["path"];
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('[E_BAD_PAYLOAD] read: "file_path" must be a non-empty string.');
  }

  const rawOffset = args["offset"];
  let offset = 1;
  if (rawOffset !== undefined) {
    if (!Number.isInteger(rawOffset) || (rawOffset as number) < 1) {
      throw new Error('[E_BAD_PAYLOAD] read: "offset" must be a positive integer.');
    }
    offset = rawOffset as number;
  }

  const rawLimit = args["limit"];
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (!Number.isInteger(rawLimit) || (rawLimit as number) < 1) {
      throw new Error('[E_BAD_PAYLOAD] read: "limit" must be a positive integer.');
    }
    limit = rawLimit as number;
  }

  const out: { path: string; offset: number; limit: number; encoding?: string } = {
    path,
    offset,
    limit,
  };
  const rawEncoding = args["encoding"];
  if (rawEncoding !== undefined) {
    if (typeof rawEncoding !== "string" || rawEncoding.trim().length === 0) {
      throw new Error('[E_BAD_PAYLOAD] read: "encoding" must be a non-empty string.');
    }
    if (normalizeEncoding(rawEncoding) === undefined) {
      throw new Error(
        `[E_BAD_ENCODING] Unknown encoding: ${rawEncoding}. Supported: ${SUPPORTED_ENCODINGS_TEXT}`,
      );
    }
    out.encoding = rawEncoding;
  }
  return out;
}

/**
 * Build the encoding-governed `read` tool.
 *
 * @param ctx - the plugin's host context, which carries `ctx.fs`.
 */
export function buildReadTool(ctx: Context) {
  return defineTool({
    name: "read",
    description: READ_DESCRIPTION,
    parameters: {
      file_path: {
        type: "string",
        required: true,
        description: "Path to read, resolved by the filesystem backend.",
      },
      offset: {
        type: "number",
        description: "1-based first line to return. Defaults to 1.",
      },
      limit: {
        type: "number",
        description: `Maximum number of lines to return. Defaults to ${DEFAULT_LIMIT}.`,
      },
      encoding: {
        type: "string",
        description:
          "Decode the file with this encoding instead of detecting it (like VS Code's " +
          '"Reopen with Encoding"). Use a candidate from a failed read. ' +
          "Case- and punctuation-insensitive, e.g. gbk, shift_jis, windows-1252.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          offset: { type: "integer", required: true },
          lines: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                number: { type: "integer", required: true },
                text: { type: "string", required: true },
              },
            },
          },
          totalLines: { type: "integer", required: true },
          warning: { type: "string" },
        },
      },
      render: (_args, value) => {
        const v = value as {
          path: string;
          offset: number;
          lines: Array<{ number: number; text: string }>;
          totalLines: number;
          warning?: string;
        };
        const blocks = [
          { type: "text" as const, text: formatReadOutput(v.path, v.lines, v.offset, v.totalLines) },
        ];
        if (v.warning !== undefined) blocks.push({ type: "text" as const, text: v.warning });
        return blocks;
      },
      presentationMeta: (_args, value) => {
        const v = value as {
          path: string;
          offset: number;
          lines: Array<{ number: number; text: string }>;
        };
        return {
          path: v.path,
          offset: v.offset,
          lines: v.lines.map(({ number, text }) => ({ number, text })),
        };
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolExecution) {
      const input = parseArgs((args ?? {}) as Record<string, unknown>);
      const cwd = execCwd(exec);

      let outcome: Awaited<ReturnType<typeof readFile>>;
      try {
        outcome = await readFile(ctx, input.path, cwd, {
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          ...(input.encoding === undefined ? {} : { encodingHint: input.encoding }),
          exec,
        });
      } catch (error) {
        // `readFile` already mapped fs errors; a decode failure carries its own
        // model-facing message and must not be wrapped again.
        if (error instanceof DecodeError) throw new Error(error.message);
        throw error;
      }

      const all = splitLines(outcome.text);
      // `read` and `str_replace_editor`'s `view` must report one total for one
      // file, so both go through `countVisibleLines` rather than each deriving it.
      const totalLines = countVisibleLines(outcome.text);
      const start = Math.min(input.offset, Math.max(totalLines, 1));
      const window = all.slice(start - 1, start - 1 + input.limit);
      const lines = window.map((text, i) => ({ number: start + i, text: clipLine(text) }));

      return {
        path: input.path,
        offset: start,
        lines,
        totalLines,
        ...(outcome.footer === undefined ? {} : { warning: outcome.footer.trim() }),
      };
    },
  });
}
