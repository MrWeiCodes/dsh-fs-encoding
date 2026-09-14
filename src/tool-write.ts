/**
 * The encoding-governed `write` tool.
 *
 * Contract-compatible with the built-in `write` (same `file_path` / `content`
 * arguments, same `path`/`operation`/`before`/`after` result shape and diff
 * card) but the file is published as bytes in its own recorded encoding instead
 * of always being re-encoded as UTF-8.
 *
 * @module dsh-fs-encoding/tool-write
 */

import type { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { DecodeError, UnmappableError } from "./encoding-state.js";
import { readFile, writeFile } from "./io.js";
import { toLF } from "./line-endings.js";
import { WRITE_DESCRIPTION } from "./prompts.js";
import type { EncodingSandbox, FsEscalationArgs } from "./sandbox.js";
import { execCwd } from "./workspace-context.js";

function formatWriteOutput(displayPath: string, operation: string): string {
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${operation === "create" ? "Created" : "Updated"} file
</content>`;
}

/** Parse and validate the write arguments. */
function parseArgs(args: Record<string, unknown>): { path: string; content: string } {
  const path = args["file_path"] ?? args["path"];
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('[E_BAD_PAYLOAD] write: "file_path" must be a non-empty string.');
  }
  const content = args["content"];
  if (typeof content !== "string") {
    throw new Error('[E_BAD_PAYLOAD] write: "content" must be a string.');
  }
  return { path, content };
}

/**
 * Build the encoding-governed `write` tool.
 *
 * @param ctx - the plugin's host context.
 * @param sandbox - the fence and `fs/*` event gate.
 */
export function buildWriteTool(ctx: Context, sandbox: EncodingSandbox) {
  return defineTool({
    name: "write",
    description: WRITE_DESCRIPTION,
    parameters: {
      file_path: {
        type: "string",
        required: true,
        description: "Path to write, resolved by the filesystem backend.",
      },
      content: {
        type: "string",
        required: true,
        description: "Full text content to write.",
      },
      ...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          operation: { type: "string", required: true, enum: ["create", "update"] },
          before: { required: true, oneOf: [{ type: "string" }, { type: "null" }] },
          after: { type: "string", required: true },
        },
      },
      render: (_args, value) => {
        const v = value as { path: string; operation: string };
        return [{ type: "text" as const, text: formatWriteOutput(v.path, v.operation) }];
      },
      presentationMeta: (args, value) => {
        const v = value as { before: string | null; after: string };
        const a = args as { file_path?: string };
        if (v.before === null) return { diffs: [] };
        return {
          diffs: [{ path: a.file_path ?? "", oldText: v.before, newText: v.after }],
        };
      },
    },
    async execute(args, exec: ToolExecution) {
      const input = parseArgs((args ?? {}) as Record<string, unknown>);
      const cwd = execCwd(exec);
      const policy = await sandbox.resolvePolicy(
        "write",
        (args ?? {}) as FsEscalationArgs,
        exec,
      );

      let target;
      try {
        target = await ctx.fs.resolve(input.path, {
          cwd,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        });
      } catch (error) {
        throw sandbox.mapError(error, policy);
      }

      const existing = await ctx.fs.stat(target, exec.signal).catch(() => undefined);
      const operation: "create" | "update" = existing === undefined ? "create" : "update";

      // Capture the previous content for the diff card, in the file's own
      // encoding, so the card shows what actually changed. This read is for
      // presentation only and must NOT arm the read-before-write gate: the
      // model never saw this content, and letting it count would let a blind
      // overwrite pass as if the file had been read.
      let before: string | null = null;
      if (operation === "update") {
        try {
          const previous = await readFile(ctx, input.path, cwd, {
            ...(exec.signal === undefined ? {} : { signal: exec.signal }),
            exec,
            observe: false,
          });
          before = toLF(previous.text);
        } catch {
          before = null;
        }
      }

      try {
        await writeFile(
          ctx,
          sandbox,
          { target, content: input.content, exec, policy },
          "write",
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
        operation,
        before,
        after: toLF(input.content),
      };
    },
  });
}
