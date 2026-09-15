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
 * CONFLICT: any plugin that shadows `read` / `write` / `edit` on the same layer
 * collides with this one, because registering a name twice in a layer throws.
 * The conflict is detected by letting the registry answer — the registration is
 * what actually fails — and the rejection is reported with the tool name it
 * names. Whatever landed before the failure is rolled back, so the install is
 * refused with an actionable message rather than leaving a half-registered set.
 *
 * Deliberately NOT probed up front with `ctx.tools.get(name)`: without a scope
 * argument that reads the GLOBAL view, and the global layer is precisely the
 * one this plugin shadows on purpose. The built-in `read` / `write` / `edit`
 * sit there in every profile that mounts `tool-fs` host-plane (`dsh-headless`,
 * the SDK and ACP profiles), so treating an inherited name as a conflict would
 * refuse an install that would have succeeded — and silently, because the
 * refusal is only logged.
 *
 * The message deliberately names no other plugin. Which one is installed is the
 * operator's to determine — a hard-coded name would be wrong whenever a
 * different plugin holds the layer, and pointing at a specific project reads as
 * a judgement about it rather than a statement about this one.
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
 * The operator-facing message for a detected conflict.
 *
 * States what was observed and what the two ways out are, and stops there: the
 * operator knows which plugins they installed, and this plugin cannot tell them
 * which one owns the layer. Naming a specific project would be wrong as soon as
 * a different one collides, and would read as a complaint about that project.
 *
 * @param taken - the tool name the registry rejected, when the error named one.
 */
function conflictMessage(taken?: string): string {
  const who =
    taken === undefined
      ? `another plugin already provides ${OWNED_TOOLS.join(" / ")} on this scope layer`
      : `the tool "${taken}" is already registered on this scope layer by another plugin`;

  return (
    `dsh-fs-encoding: refusing to install — ${who}. Only one plugin can own a tool ` +
    `name on a layer, so enable either that plugin or this one: remove this plugin ` +
    `from the profile, or disable the other one in the profile's cordis.patch.yml ` +
    `with:\n  - id: <the other plugin's id>\n    disabled: true`
  );
}

/** Whether a thrown registration error is the registry's duplicate-name rejection. */
function isDuplicateRegistration(error: unknown): boolean {
  return error instanceof Error && /already registered/i.test(error.message);
}

/**
 * The tool name a duplicate-registration error refers to, when it names one.
 *
 * @param error - the rejection thrown by the tool registry.
 */
function duplicateToolName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.message.match(/tool "([^"]+)" is already registered/)?.[1];
}

/**
 * One per-agent registration bundle, disposed with the agent.
 *
 * Registration is where the conflict is settled, and it is wrapped: a plugin
 * that already owns one of these names on the agent's layer makes the registry
 * reject the duplicate, and that rejection is turned into the actionable
 * message instead of a raw registry error. Tools that landed before the failure
 * are rolled back, so a conflict never leaves a partially installed set.
 *
 * The check cannot be hoisted into a pre-flight occupancy probe: the only
 * scope-blind read (`ctx.tools.get(name)`) answers for the GLOBAL layer, which
 * this plugin is designed to shadow, so it would report the built-ins as a
 * conflict and refuse an install that the registry would have accepted.
 */
function installAgentTools(rootCtx: Context, agent: Agent): void {
  agent.ctx.effect(() => {
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
        // Name the tool the registry actually rejected, so the message points
        // at the real collision rather than a guessed plugin.
        rootCtx.logger.error(conflictMessage(duplicateToolName(error)));
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
