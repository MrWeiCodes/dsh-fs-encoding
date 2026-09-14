/**
 * dsh-fs-encoding — encoding-governed `read` / `write` / `edit` for DeepSeek
 * Harness.
 *
 * The harness's filesystem seam is UTF-8-only by contract: it decodes with a
 * strict `TextDecoder` (so a GBK file is `FS_NOT_TEXT`), its `TextDecoder`
 * swallows a leading UTF-8 BOM, and its only mutation entry point takes a
 * `string` and always encodes it as UTF-8 — there is no `writeBytes`. The
 * practical result is that a GBK file cannot be read, and editing a BOM-carrying
 * file silently drops the BOM.
 *
 * This plugin closes that gap from the tool layer. It shadows the three
 * model-facing tools on each agent's OWN scope layer (nearest layer wins in
 * dsh's tool registry), reads through the public `ctx.fs.readBytes` byte seam,
 * and publishes bytes itself. It does NOT replace `ctx.fs`, and it reproduces
 * every guarantee `ctx.fs.writeText` would have provided — the sandbox fence,
 * the `fs/write-intent` / `fs/edit-intent` version guards, and the
 * `fs/observed` observation — using only public seams, so the built-in tools
 * keep working against the same state.
 *
 * CONFLICT: `dsh-better-edit` registers `read` / `edit` (and a
 * `str_replace_editor` shadow) on the same layer. Registering one name twice in
 * a layer throws, so the two plugins cannot be enabled together; this one
 * detects that and refuses to install rather than leaving a half-registered
 * tool set.
 *
 * @module dsh-fs-encoding
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import { ensureDefaultConfig } from "./config.js";
import { clearSession } from "./encoding-state.js";
import {
  editSectionText,
  ORDER_EDIT,
  ORDER_READ,
  ORDER_WRITE,
  readSectionText,
  SECTION_EDIT,
  SECTION_READ,
  SECTION_WRITE,
  writeSectionText,
} from "./prompts.js";
import { EncodingSandbox } from "./sandbox.js";
import { buildEditTool } from "./tool-edit.js";
import { buildReadTool } from "./tool-read.js";
import { buildWriteTool } from "./tool-write.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-fs-encoding";

/**
 * Services the per-agent install touches: `tools` and `systemPrompt` for the
 * shadow registrations, `fs` for the byte seam.
 *
 * Cordis refuses property access to an undeclared service, and the failure is
 * invisible from the model's side — the install throws at session-start and the
 * session quietly runs the built-ins — so this list must stay complete.
 */
export const inject = ["tools", "systemPrompt", "fs"];

/** Names of the tools this plugin owns. */
const OWNED_TOOLS = ["read", "write", "edit"] as const;

/**
 * A tool name only `dsh-better-edit` registers.
 *
 * Detecting the conflict by a tool that plugin OWNS is deliberately different
 * from reading a bundle list: it observes the real condition (another plugin
 * has taken this layer) rather than predicting it from configuration. A
 * renamed bundle, a reordered profile, or a hand-written patch all still land
 * here, because the question asked is "is something already here?".
 */
const COMPETING_TOOL = "undo_last_edit";

/** The plugin known to register the same tool names on the same layer. */
const COMPETING_PLUGIN = "dsh-better-edit";

/** The operator-facing message for a detected conflict. */
function conflictMessage(): string {
  return (
    `dsh-fs-encoding: refusing to install — ${COMPETING_PLUGIN} registers the same tools ` +
    `(${OWNED_TOOLS.join(", ")}) on the same scope layer. Enable only one of them in the ` +
    `profile's cordis.patch.yml:\n  - id: ${COMPETING_PLUGIN}\n    disabled: true`
  );
}

/** Whether a thrown registration error is the registry's duplicate-name rejection. */
function isDuplicateRegistration(error: unknown): boolean {
  return error instanceof Error && /already registered/i.test(error.message);
}

/**
 * One per-agent registration bundle, disposed with the agent.
 *
 * The conflict check runs here rather than once at `apply()` because the
 * competing plugin also installs per agent: only at this point is the layer's
 * real occupancy observable.
 *
 * Registration is additionally wrapped, so a conflict this check cannot see —
 * a plugin that registers only some of the names, or one that installs after
 * this listener — still produces the actionable message instead of a raw
 * registry error. Already-registered tools are rolled back so a failure never
 * leaves a partially installed set.
 */
function installAgentTools(rootCtx: Context, agent: Agent): void {
  agent.ctx.effect(() => {
    if (agent.ctx.tools.get(COMPETING_TOOL) !== undefined) {
      rootCtx.logger.error(conflictMessage());
      return () => undefined;
    }

    // `fs` is host-plane: read it off the plugin's own context (covered by
    // `inject`) rather than the agent's scoped one, whose fiber chain does not
    // declare it. Session cwd still reaches each call via `execCwd`.
    const sandbox = new EncodingSandbox(rootCtx);
    const disposers: Array<() => void> = [];

    const readTool = buildReadTool(rootCtx);
    const writeTool = buildWriteTool(rootCtx, sandbox);
    const editTool = buildEditTool(rootCtx, sandbox);

    try {
      disposers.push(agent.ctx.tools.register(readTool));
      disposers.push(agent.ctx.tools.register(writeTool));
      disposers.push(agent.ctx.tools.register(editTool));
    } catch (error) {
      // Roll back whatever landed before the failure, so the agent runs a
      // coherent tool set (the built-ins) rather than a half-shadowed one.
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // A disposer that throws must not mask the original failure.
        }
      }
      if (isDuplicateRegistration(error)) {
        rootCtx.logger.error(conflictMessage());
        return () => undefined;
      }
      throw error;
    }

    // Same section names as the built-ins on the agent's own layer, so the
    // encoding-aware contract replaces the UTF-8-only text.
    disposers.push(
      agent.ctx.systemPrompt.section({
        name: SECTION_READ,
        order: ORDER_READ,
        text: () => readSectionText(),
      }),
    );
    disposers.push(
      agent.ctx.systemPrompt.section({
        name: SECTION_WRITE,
        order: ORDER_WRITE,
        text: () => writeSectionText(),
      }),
    );
    disposers.push(
      agent.ctx.systemPrompt.section({
        name: SECTION_EDIT,
        order: ORDER_EDIT,
        text: () => editSectionText(),
      }),
    );

    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}

/**
 * Mount the bundle: materialize the default config, then install the tools per
 * agent.
 *
 * @param rootCtx - the host-plane plugin context.
 */
export function apply(rootCtx: Context): void {
  // Best-effort: a failure here must never fail the boot.
  ensureDefaultConfig().catch((error: unknown) => {
    rootCtx.logger.warn(
      `dsh-fs-encoding: default config materialization failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  const registered = new WeakSet<Agent>();
  rootCtx.on("agent/session-start", ({ agent }) => {
    if (registered.has(agent)) return;
    registered.add(agent);
    try {
      installAgentTools(rootCtx, agent);
    } catch (error) {
      rootCtx.logger.warn(
        `dsh-fs-encoding: failed to install tools for agent ${agent.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  // Release the encoding records a finished session owned. Without this a
  // long-lived process keeps one bucket per session that ever ran; the bound in
  // `encoding-state` is the backstop, this is the precise release.
  rootCtx.on("agent/disposed", ({ agent }) => {
    clearSession(agent.id);
  });
}

export {
  READ_DESCRIPTION,
  WRITE_DESCRIPTION,
  EDIT_DESCRIPTION,
  readSectionText,
  writeSectionText,
  editSectionText,
} from "./prompts.js";
export type { FileSystem };
