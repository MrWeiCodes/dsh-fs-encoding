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
import { normalizeEncoding, SUPPORTED_ENCODINGS_TEXT } from "./encoding.js";
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
function parseArgs(args: Record<string, unknown>): {
  path: string;
  content: string;
  encoding: string | undefined;
} {
  const path = args["file_path"] ?? args["path"];
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('[E_BAD_PAYLOAD] write: "file_path" must be a non-empty string.');
  }
  const content = args["content"];
  if (typeof content !== "string") {
    throw new Error('[E_BAD_PAYLOAD] write: "content" must be a string.');
  }
  const rawEncoding = args["encoding"];
  if (rawEncoding === undefined || rawEncoding === null) {
    return { path, content, encoding: undefined };
  }
  if (typeof rawEncoding !== "string" || rawEncoding.trim().length === 0) {
    throw new Error('[E_BAD_PAYLOAD] write: "encoding" must be a non-empty string.');
  }
  const encoding = normalizeEncoding(rawEncoding);
  if (encoding === undefined) {
    throw new Error(
      `[E_BAD_ENCODING] Unknown encoding: ${rawEncoding}. Supported: ${SUPPORTED_ENCODINGS_TEXT}`,
    );
  }
  return { path, content, encoding };
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
      encoding: {
        type: "string",
        description:
          "Encoding for a NEW file (gbk, big5, shift_jis, utf16le, ...). Only valid " +
          "when the file does not exist yet; an existing file keeps its own encoding, " +
          "so passing this for one is an error. Defaults to UTF-8 without a BOM.",
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

      // `encoding` names the encoding of a file that does not exist yet. On an
      // existing file it is refused rather than ignored, and refused BEFORE any
      // read or write: silently accepting it would let a model believe it had
      // converted a file when the plugin had preserved the original encoding
      // instead, and the two outcomes are indistinguishable from the reply.
      //
      // The alternative — treating it as "convert this file" — is deliberately
      // not offered. Preserving a file's encoding across a write is this plugin's
      // core contract, and a conversion is not something to trigger by adding an
      // argument to an unrelated call: it would rewrite every character of a file
      // the model only meant to save, and the model cannot see the difference.
      //
      // The message deliberately does NOT suggest deleting the file to get the
      // conversion. That advice is actively harmful, and it used to be here:
      // deleting is the one action that bypasses the read-before-write gate, so a
      // file this session had never read could be destroyed and recreated with
      // the reply reporting `operation: "create"` / `before: null` — identical to
      // creating a brand-new file, with the old content unrecoverable and
      // invisible. And when the session HAD read the file (the common case, since
      // the gate requires a read), the deletion left the observation policy
      // holding `present@old-version` while the plugin could no longer emit
      // `absent` for a path that does not exist, so every later write failed
      // `FS_STALE_VERSION` and the path was unwritable for the rest of the
      // session. There is no in-session recovery from that, so the advice must
      // not be given. A genuine conversion needs a purpose-built tool that reads
      // first and carries the version guard; it is not a side effect of `write`.
      if (input.encoding !== undefined && operation === "update") {
        throw new Error(
          `[E_ENCODING_NOT_APPLICABLE] "${input.path}" already exists, so it keeps its own ` +
            `encoding — the "encoding" argument only applies to a new file. ` +
            `Write without it to save the content while preserving the existing encoding. ` +
            `This plugin does not convert an existing file's encoding; if you need a copy in ` +
            `${input.encoding}, write it to a NEW path instead.`,
        );
      }

      // Capture the previous content for the diff card, in the file's own
      // encoding, so the card shows what actually changed. This read is for
      // presentation only and must NOT arm the read-before-write gate: the
      // model never saw this content, and letting it count would let a blind
      // overwrite pass as if the file had been read.
      //
      // It must not record the encoding either. `observe: false` only suppresses
      // the `fs/observed` event; without `recordState: false` this read would
      // still write whatever encoding it guessed into the session's record. After
      // an eviction that guess becomes the answer the coming save inverts, and
      // the write guard — which refuses a file whose encoding the session no
      // longer knows — would see a record and stand down. Measured before this
      // flag existed: a windows-1252 file's euro sign (0x80) was silently
      // rewritten as windows-1251's 0x88, and a GBK file whose bytes also form
      // valid UTF-8 was converted to UTF-8 outright.
      let before: string | null = null;
      if (operation === "update") {
        try {
          const previous = await readFile(ctx, input.path, cwd, {
            ...(exec.signal === undefined ? {} : { signal: exec.signal }),
            exec,
            observe: false,
            recordState: false,
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
          {
            target,
            content: input.content,
            exec,
            policy,
            ...(input.encoding === undefined ? {} : { newFileEncoding: input.encoding }),
          },
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
