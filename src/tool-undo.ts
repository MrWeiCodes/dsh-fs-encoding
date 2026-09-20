/**
 * The encoding-governed `undo_last_edit` tool.
 *
 * Reverts a file to the content and the ENCODING it had before its most recent
 * edit, and refuses when the file has changed since — an undo must not discard
 * work it did not make.
 *
 * Both halves of "revert" matter, and the encoding half is the one a content-only
 * undo gets wrong. With `normalizeToUtf8` on, an ordinary save rewrites a legacy
 * file as UTF-8, so restoring the old characters while leaving the file UTF-8
 * would produce a file that never existed: the right text in the wrong encoding.
 * The record therefore carries the pre-edit `FileEncodingState` and the write
 * restores it — see `WriteRequest.restoreState`.
 *
 * The history is IN MEMORY and one edit deep. Two consequences the tool states
 * rather than hides: it does not survive a DSH restart, and editing a file twice
 * leaves only the second edit undoable.
 *
 * @module dsh-fs-encoding/tool-undo
 */

import type { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { diffForResult, formatLineChangeSummary } from "./diff-hunks.js";
import { DecodeError, UnmappableError } from "./encoding-state.js";
import { keyOf, readFile, sessionKeyFor, writeFile } from "./io.js";
import { toLF } from "./line-endings.js";
import { UNDO_DESCRIPTION } from "./prompts.js";
import type { EncodingSandbox, FsEscalationArgs } from "./sandbox.js";
import { clearUndoFor, getUndo } from "./undo-state.js";
import { execCwd } from "./workspace-context.js";

/** What one undo produced, in the shape the tool result carries. */
export interface UndoOutcome {
  /** The path as the caller wrote it. */
  path: string;
  /** The content before the undo (equal to `after` when nothing was reverted). */
  before: string;
  /** The content after the undo (equal to `before` when nothing was reverted). */
  after: string;
  /** Whether the file was actually reverted. */
  undone: boolean;
  /** A sentence explaining the outcome, shown to the model either way. */
  note: string;
}

/** Parse and validate the arguments shared by `undo_last_edit` and `undo_edit`. */
export function parseUndoArgs(
  args: Record<string, unknown>,
  toolName: string,
): { path: string } {
  const path = args["file_path"] ?? args["path"];
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`[E_BAD_PAYLOAD] ${toolName}: "file_path" must be a non-empty string.`);
  }
  return { path };
}

/**
 * Whether a read failure means the file is gone.
 *
 * Matched on the message rather than on `FsError.code`, because the code does
 * not survive the read path: `mapReadError` deliberately rewrites the built-ins'
 * codes into the model-facing sentences, and `FS_NOT_FOUND` becomes a plain
 * `Error`. Matching the sentence the plugin itself produces is therefore the
 * only handle available here — and it is a stable one, since that wording is
 * asserted by the read tests.
 *
 * @param error - the error a read threw.
 * @returns whether the file was reported missing.
 */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && /no such file/.test(error.message);
}

/**
 * Revert one file to its pre-edit content and encoding.
 *
 * Shared by the `undo_last_edit` tool and by `str_replace_editor`'s `undo_edit`
 * command, which have identical arguments and must not be able to drift: two
 * implementations of "undo" would eventually disagree about what is undoable.
 *
 * @param ctx - the plugin's host context.
 * @param sandbox - the fence and `fs/*` event gate.
 * @param path - the path as the caller wrote it.
 * @param exec - the calling execution.
 * @param toolName - the calling tool, for the escalation audit trail.
 * @param escalationArgs - the call's escalation fields, forwarded so an approved
 *   one-shot escalation reaches the fence. Dropping them made the advertised
 *   `sandbox_permissions`/`justification` a no-op, so the sanctioned retry after
 *   a `[sandbox: …]` denial failed identically and forever.
 * @returns what the undo produced.
 */
export async function performUndo(
  ctx: Context,
  sandbox: EncodingSandbox,
  path: string,
  exec: ToolExecution,
  toolName: string,
  escalationArgs: FsEscalationArgs = {},
): Promise<UndoOutcome> {
  const cwd = execCwd(exec);
  const policy = await sandbox.resolvePolicy(toolName, escalationArgs, exec);

  let target;
  try {
    target = await ctx.fs.resolve(path, {
      cwd,
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    });
  } catch (error) {
    throw sandbox.mapError(error, policy);
  }

  const sessionKey = sessionKeyFor(exec);
  const key = keyOf(target);
  const record = getUndo(sessionKey, key);
  if (record === undefined) {
    // Not an error. "There is nothing to undo" is an ANSWER, and a file that was
    // never edited — or one whose history was spent, evicted, or lost to a
    // restart — is not a failure of the call.
    return {
      path,
      before: "",
      after: "",
      undone: false,
      note:
        `No undo history for ${path}. Either nothing edited it in this session, or the ` +
        `history was already used. Note that undo history is kept in memory only, so it ` +
        `does not survive a DSH restart.`,
    };
  }

  let current: string;
  let currentVersion: string | undefined;
  try {
    const outcome = await readFile(ctx, path, cwd, {
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      exec,
      // The encoding the EDIT wrote, which is what these bytes are. This read
      // exists only to compare the file against the record, so it must not move
      // either gate:
      //
      // - `observe: false` keeps it from advancing the observation policy to
      //   "now" — with it, `writeFile`'s version guard would compare the write
      //   against the version this read just recorded and could never fail,
      //   disabling the one check that catches a byte-level change the text
      //   comparison cannot see.
      // - `recordState: false` keeps a guess made here from becoming the
      //   session's encoding record and authorizing a later silent re-encode
      //   (the same protection `tool-write`'s baseline read has).
      //
      // The hint is what makes the read work at all once the session's encoding
      // record has been evicted: with guessing off (the default) a legacy file
      // cannot be admitted without one, and the undo would fail `E_NOT_TEXT` on
      // a file it is able to restore. The record already knows the answer.
      encodingHint: record.nextEncoding,
      observe: false,
      recordState: false,
    });
    current = toLF(outcome.text);
    currentVersion = outcome.state.version;
  } catch (error) {
    // Two ways the file can no longer be compared against the record, and both
    // are ANSWERS rather than failures — the caller asked to undo an edit on a
    // file that is gone or unreadable, and "that is no longer possible" is the
    // truth. Both also DISCARD the record: it can never apply again, so keeping
    // it would repeat the same refusal on every later call.
    if (error instanceof DecodeError) {
      clearUndoFor(sessionKey, key);
      return {
        path,
        before: "",
        after: "",
        undone: false,
        note: `[E_UNDO_STALE] cannot undo on ${path}: ${error.message}`,
      };
    }
    if (isMissingFile(error)) {
      clearUndoFor(sessionKey, key);
      return {
        path,
        before: "",
        after: "",
        undone: false,
        // Deliberately does NOT recreate the file. The undo restores CONTENT,
        // and content needs a file to live in; writing one back would resurrect
        // something the caller deleted on purpose, with a version the
        // observation policy never saw.
        note:
          `[E_UNDO_STALE] cannot undo on ${path}: the file no longer exists. ` +
          `The undo history for it has been discarded.`,
      };
    }
    throw sandbox.mapError(error, policy);
  }

  // The guard that makes this safe rather than merely convenient. The record
  // describes the file as the edit LEFT it; if the file says something else, then
  // someone — the user, another tool, another session — changed it since, and
  // reverting would silently discard that work. Refusing is the only outcome
  // that cannot destroy content the caller never saw.
  //
  // Two checks, because neither is sufficient alone:
  //
  // - **Version** catches a change the TEXT cannot show. The text comparison
  //   below runs on LF-normalized, BOM-stripped content, so a file whose line
  //   endings were converted (CRLF to LF), whose BOM was added or removed, or
  //   whose encoding changed without changing a character all compare EQUAL —
  //   yet each is a real edit by someone else, and reverting over it destroys it.
  //   The version the edit itself produced is the only handle on those, which is
  //   why the record carries it.
  // - **Text** catches a change that leaves the version untouched (a backend
  //   that reports no version at all) and is the check that works when the
  //   version is unknown.
  //
  // The record is dropped on the way out: it can never apply again, and keeping
  // it would repeat the same refusal on every later call.
  const versionChanged =
    record.nextVersion !== undefined &&
    currentVersion !== undefined &&
    currentVersion !== record.nextVersion;
  if (versionChanged || current !== record.nextText) {
    clearUndoFor(sessionKey, key);
    return {
      path,
      before: current,
      after: current,
      undone: false,
      note:
        `[E_UNDO_STALE] cannot undo on ${path}: the file was modified after the edit, ` +
        `so reverting would overwrite those changes. The undo history for this file has ` +
        `been discarded.`,
    };
  }

  try {
    await writeFile(
      ctx,
      sandbox,
      {
        target,
        content: record.previousText,
        exec,
        policy,
        // Restores the pre-edit encoding, BOM and line endings, and suppresses
        // the migration toggle — the migration being undone is part of the edit,
        // so re-running it would immediately re-convert what this write restores.
        restoreState: record.previousState,
        // No `previousText`: this write consumes the history instead of adding
        // to it. Undoing an undo would be a redo, which this tool does not offer.
      },
      record.mode,
    );
  } catch (error) {
    if (error instanceof UnmappableError || error instanceof DecodeError) {
      throw new Error(error.message);
    }
    if (error instanceof FsError) throw error;
    throw sandbox.mapError(error, policy);
  }

  return {
    path,
    before: current,
    after: record.previousText,
    undone: true,
    note: `Reverted the last edit on ${path}.`,
  };
}

/**
 * Render an undo outcome as the message the model reads.
 *
 * @param outcome - what the undo produced.
 * @returns the message.
 */
export function formatUndoOutput(outcome: UndoOutcome): string {
  if (!outcome.undone) return outcome.note;
  const summary = formatLineChangeSummary(
    diffForResult(outcome, outcome.path, outcome.before, outcome.after).count,
  );
  return `${outcome.note}${summary}`;
}

/**
 * Build the `undo_last_edit` tool.
 *
 * @param ctx - the plugin's host context.
 * @param sandbox - the fence and `fs/*` event gate.
 */
export function buildUndoTool(ctx: Context, sandbox: EncodingSandbox) {
  return defineTool({
    name: "undo_last_edit",
    description: UNDO_DESCRIPTION,
    parameters: {
      file_path: {
        type: "string",
        required: true,
        description: "Path to the file whose last edit should be reverted.",
      },
      ...(sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {}),
    },
    output: {
      // Every field `performUndo` returns is declared, because the registry
      // validates a tool's value against this schema and REJECTS the call when
      // anything is undeclared (`additionalProperties: false`). Leaving
      // `undone`/`note` out made every call fail with `INVALID_TOOL_OUTPUT`
      // *after* the file had already been reverted — the worst possible shape,
      // since the model sees an error, believes the undo did not happen, and
      // retries into "no undo history". `render` reads both fields, so they are
      // part of the contract rather than extras.
      //
      // The diff projection is the same one `edit` uses, so the card shows the
      // revert as a real diff. When nothing was reverted, `before === after` and
      // the card stays empty on its own — no special case needed.
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true },
          before: { type: "string", required: true },
          after: { type: "string", required: true },
          undone: { type: "boolean", required: true },
          note: { type: "string", required: true },
        },
      },
      render: (_args, value) => [
        { type: "text" as const, text: formatUndoOutput(value as UndoOutcome) },
      ],
      presentationMeta: (_args, value) => {
        const v = value as UndoOutcome;
        return { diffs: diffForResult(v, v.path, v.before, v.after).diffs };
      },
    },
    async execute(args, exec: ToolExecution) {
      const rec = (args ?? {}) as Record<string, unknown>;
      const input = parseUndoArgs(rec, "undo_last_edit");
      return performUndo(
        ctx,
        sandbox,
        input.path,
        exec,
        "undo_last_edit",
        rec as FsEscalationArgs,
      );
    },
  });
}
