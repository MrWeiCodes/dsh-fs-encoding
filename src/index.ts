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
 * INSTALL POINT: the per-agent install hangs off BOTH `agent/created` and
 * `agent/session-start`, because `agent/session-start` is absent from the
 * `0.1.6-alpha` line onward while `agent/created` exists on every supported
 * line — see {@link onAgentEvent}. Whichever fires first installs; the other is
 * a no-op.
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
import { clearSessionUndo } from "./undo-state.js";
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
import {
  FS_ENCODING_SERVICE,
  isFsEncodingService,
  provideFsEncoding,
} from "./service.js";
import { buildEditTool } from "./tool-edit.js";
import { buildInsertTool } from "./tool-insert.js";
import { buildReadTool } from "./tool-read.js";
import { buildStrReplaceEditorTool } from "./tool-str-replace-editor.js";
import { buildUndoTool } from "./tool-undo.js";
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

/**
 * Names of the tools this plugin owns.
 *
 * The first three shadow the built-ins on the agent's layer. The last three are
 * ADDITIONS rather than shadows: `insert` and `undo_last_edit` have no built-in
 * counterpart, and `str_replace_editor` is only mounted by the headless / SDK /
 * ACP profiles, not by `dsh-base`, so in a web profile it is a new name too.
 *
 * All six are listed because all six are registered, and a name this plugin
 * registers is a name it can collide on — the conflict check is about the layer,
 * not about who the other plugin is.
 */
const OWNED_TOOLS = [
  "read",
  "write",
  "edit",
  "insert",
  "str_replace_editor",
  "undo_last_edit",
] as const;

/**
 * The operator-facing message for a detected conflict.
 *
 * States what was observed and what the two ways out are, and stops there: the
 * operator knows which plugins they installed, and this plugin cannot tell them
 * which one owns the layer. Naming a specific project would be wrong as soon as
 * a different one collides, and would read as a complaint about that project.
 *
 * The two collisions this plugin can hit are reported apart, because they point
 * at different things to look for: a TOOL name taken on the layer, or a PROMPT
 * SECTION name taken there. Both surface as "already registered", so telling
 * them apart is what keeps the message from sending the operator after the
 * wrong occupant.
 *
 * @param taken - the tool name the registry rejected, when the error named one.
 * @param section - the prompt section name that was rejected, when the error named one.
 */
function conflictMessage(taken?: string, section?: string): string {
  const who =
    section !== undefined
      ? `the prompt section "${section}" is already registered on this scope layer by another plugin`
      : taken === undefined
        ? `another plugin already provides ${OWNED_TOOLS.join(" / ")} on this scope layer`
        : `the tool "${taken}" is already registered on this scope layer by another plugin`;

  return (
    `dsh-fs-encoding: refusing to install — ${who}. Only one plugin can own a ` +
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
 * The prompt section name a duplicate-registration error refers to, when it
 * names one.
 *
 * Kept apart from {@link duplicateToolName} on purpose: both rejections say
 * "already registered", and only the wording tells the operator whether a tool
 * name or a prompt section name is the one already taken.
 *
 * @param error - the rejection thrown by the system-prompt registry.
 */
function duplicateSectionName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.message.match(/section "([^"]+)" is already registered/)?.[1];
}

/**
 * Subscribe to one agent-lifecycle event by NAME, across a DSH version skew.
 *
 * The two events this plugin needs are not both present on every supported
 * release: `agent/created` exists on every line, while `agent/session-start`
 * exists on the `0.1.5-rc` line only and is GONE from `0.1.6-alpha` onward,
 * where `agent/created` is the sole per-agent installation point. On the rc
 * line BOTH fire for one agent, `agent/created` first. A plugin that subscribes
 * to only one of them either never installs on the other line or, worse, fails
 * invisibly — cordis's `ctx.on` does NOT validate the event name: it lazily
 * creates a listener bucket under any string, so a name nothing emits registers
 * successfully and simply never fires. There is no error to catch and no log
 * line; the session just quietly runs the built-ins.
 *
 * So both names are subscribed on every version. Where both exist (the rc
 * line) the second delivery is a no-op because the caller records the agent
 * after the first successful install.
 *
 * The cast is the price of that skew, and it is deliberately narrow: the
 * handler is fully typed and the event name is the ONLY thing being asserted,
 * because the name is exactly what differs between the two versions. Typing it
 * honestly would require depending on one version's `Events` map and would
 * fail to compile against the other's.
 *
 * @param rootCtx - the host-plane plugin context.
 * @param eventName - the lifecycle event to subscribe to.
 * @param handler - called with the agent whose session began.
 */
function onAgentEvent(
  rootCtx: Context,
  eventName: "agent/created" | "agent/session-start",
  handler: (agent: Agent) => void,
): void {
  const subscribe = rootCtx.on as unknown as (
    name: string,
    listener: (payload: { agent: Agent }) => void,
  ) => () => void;
  subscribe.call(rootCtx, eventName, ({ agent }) => {
    handler(agent);
  });
}

/**
 * One per-agent registration bundle, disposed with the agent.
 *
 * Registration is where the conflict is settled, and it is wrapped: a plugin
 * that already owns one of these names on the agent's layer makes the registry
 * reject the duplicate, and that rejection is turned into the actionable
 * message instead of a raw registry error. Everything that landed before the
 * failure — tools AND prompt sections — is rolled back, so a conflict never
 * leaves a partially installed set.
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
    const insertTool = buildInsertTool(rootCtx, sandbox);
    const strReplaceEditorTool = buildStrReplaceEditorTool(rootCtx, sandbox);
    const undoTool = buildUndoTool(rootCtx, sandbox);

    try {
      disposers.push(agent.ctx.tools.register(readTool));
      disposers.push(agent.ctx.tools.register(writeTool));
      disposers.push(agent.ctx.tools.register(editTool));
      disposers.push(agent.ctx.tools.register(insertTool));
      disposers.push(agent.ctx.tools.register(strReplaceEditorTool));
      disposers.push(agent.ctx.tools.register(undoTool));

      // Same section names as the built-ins on the agent's own layer, so the
      // encoding-aware contract replaces the UTF-8-only text. Registered inside
      // the SAME try as the tools on purpose: a section name already taken on
      // this layer throws right here, and the rollback below must undo the
      // tools as well. Left outside, a section collision would strand a
      // shadowed tool set with no encoding contract beside it, and the retry
      // from the other lifecycle event would then misreport this plugin's own
      // leftovers as another plugin's tool conflict.
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
    } catch (error) {
      // Roll back whatever landed before the failure — tools and prompt
      // sections alike — so the agent runs a coherent tool set (the built-ins)
      // rather than a half-installed one.
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // A disposer that throws must not mask the original failure.
        }
      }
      if (isDuplicateRegistration(error)) {
        // Name the tool or section the registry actually rejected, so the
        // message points at the real collision rather than a guessed plugin.
        rootCtx.logger.error(
          conflictMessage(duplicateToolName(error), duplicateSectionName(error)),
        );
        return () => undefined;
      }
      throw error;
    }

    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}

/**
 * Mount the bundle: materialize the default config, publish the decoding
 * service, then install the tools per agent.
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

  // The decoding rules other plugins need. Provided once, host-plane, at load
  // time — not per agent — because the rules do not vary by session; what
  // varies is the recorded encoding, which is deliberately not part of the
  // service. Wrapped because a second provider of the same name on this scope
  // throws, and a plugin that cannot publish its service must still install its
  // tools rather than lose both.
  //
  // The message asserts only what this process can actually verify. "Was the
  // object already there created by us?" is NOT answerable: `instanceof` fails
  // across two copies of this module (a duplicate mount then looks foreign), and
  // a process-global registry can be cleared or pre-seeded by any other plugin
  // (a foreign object then looks like ours). Both mistakes produce a confident
  // wrong diagnosis, which is worse than a vague right one. What IS verifiable
  // is what a consumer will receive — `undefined`, an object offering the decode
  // entry points, or an object that does not — and that is what decides whether
  // the rules are usable, so that is what the log states and grades on.
  try {
    provideFsEncoding(rootCtx);
  } catch (error) {
    const existing = rootCtx.get(FS_ENCODING_SERVICE);
    const detail = error instanceof Error ? error.message : String(error);
    if (isFsEncodingService(existing)) {
      rootCtx.logger.warn(
        `dsh-fs-encoding: the "${FS_ENCODING_SERVICE}" service was already provided on this ` +
          `scope (${detail}). This mount did not publish its own instance, so consumers get ` +
          `whichever object is already registered — an object that does provide the decode ` +
          `entry points (an earlier mount of this plugin, or another plugin using the same ` +
          `name). The tools are installed as usual.`,
      );
    } else {
      rootCtx.logger.error(
        `dsh-fs-encoding: could not provide the "${FS_ENCODING_SERVICE}" service: ${detail}. ` +
          `Consumers calling ctx.get("${FS_ENCODING_SERVICE}") will receive ${
            existing === undefined ? "undefined" : "an object without the decode entry points"
          }, so this plugin's decoding rules are NOT available to them. The tools are unaffected.`,
      );
    }
  }

  const installed = new WeakSet<Agent>();

  /**
   * Install this agent's tool set exactly once, from whichever lifecycle event
   * the running harness emits.
   *
   * The agent is recorded only after a NON-THROWING attempt, and that ordering
   * is load-bearing. `installAgentTools` returns normally both when it
   * installed and when it refused a duplicate name (a conflict is final — the
   * other plugin is not going to vacate the name), so those are the two
   * conclusions worth remembering. An UNEXPECTED throw is not one of them:
   * leaving the agent unrecorded lets the other lifecycle event retry, instead
   * of the plugin silently never installing and the session quietly running the
   * UTF-8-only built-ins.
   *
   * @param agent - the agent whose session just began.
   */
  const installOnce = (agent: Agent): void => {
    if (installed.has(agent)) return;
    try {
      installAgentTools(rootCtx, agent);
      installed.add(agent);
    } catch (error) {
      rootCtx.logger.warn(
        `dsh-fs-encoding: failed to install tools for agent ${agent.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  // Both events are subscribed, and on the rc line BOTH fire for one agent:
  // `agent/created` is emitted first (agent-loop's `publish()`), so it installs
  // and the later `agent/session-start` finds the agent already recorded and
  // does nothing. Without that record the second install would re-register the
  // same names in one layer, which the registry rejects outright.
  onAgentEvent(rootCtx, "agent/created", installOnce);
  onAgentEvent(rootCtx, "agent/session-start", installOnce);

  // Release the per-session records a finished session owned. Without this a
  // long-lived process keeps one bucket per session that ever ran; the bounds in
  // `encoding-state` and `undo-state` are the backstop, this is the precise
  // release. The undo records matter more here: each holds whole files, so a
  // leaked bucket is measured in megabytes rather than bytes.
  rootCtx.on("agent/disposed", ({ agent }) => {
    clearSession(agent.id);
    clearSessionUndo(agent.id);
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
export {
  FS_ENCODING_SERVICE,
  FsEncodingService,
  isFsEncodingService,
  provideFsEncoding,
  type FsDecodeOptions,
  type FsDecodeRefusal,
  type FsDecodeResult,
} from "./service.js";
export type { DecodeProvenance } from "./encoding-state.js";
export type { FileSystem };
