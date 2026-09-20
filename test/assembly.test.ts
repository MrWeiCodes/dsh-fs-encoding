/**
 * Assembly tests: the plugin's `apply()` and its per-agent install.
 *
 * The tool bodies are covered by `roundtrip.test.ts`; this file covers what
 * wraps them — that the three tools actually register on an agent's own scope
 * layer (shadowing the built-ins), that their prompt sections land, and that
 * the plugin refuses to install when another plugin already owns a tool name
 * instead of leaving a half-registered tool set.
 *
 * The harness is built from the REAL `ToolRuntime` and `SystemPrompt` services
 * on a real cordis scope, so `agent.ctx.tools.register(...)` goes through the
 * same layering the deployment uses. `register` throws on a duplicate name
 * within one layer, so a second `session-start` for the same agent must be a
 * no-op or the emit would throw.
 */

import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { ToolRuntime, defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { SystemPrompt, TOOL_ORDER_REST } from "@deepseek-ai/dsh-system-prompt";
import { bindScopeParent, createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import { CANONICAL_ENCODINGS, normalizeEncoding } from "../src/encoding.js";
import { DecodeError, decodeForOpen } from "../src/encoding-state.js";
import { apply, inject, name } from "../src/index.js";

/**
 * Every tool name one install registers, sorted.
 *
 * Kept in one place so adding a tool updates one line instead of five
 * assertions. The first three shadow the built-ins; `insert` and
 * `undo_last_edit` have no built-in counterpart, and `str_replace_editor` is
 * mounted only by the headless / SDK / ACP profiles, so in a web profile it is a
 * new name too.
 */
const REGISTERED_TOOL_NAMES = [
  "edit",
  "insert",
  "read",
  "str_replace_editor",
  "undo_last_edit",
  "write",
];

interface Harness {
  /** The agent-shaped object `agent/session-start` carries. */
  agent: { id: string; ctx: Context };
  /** The tool names this agent's install registered, in order. */
  registeredNames: () => string[];
}

/** Build a context wired like a real deployment. */
function makeHost(): Context {
  const root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: process.cwd() }),
  });
  new SandboxedFileSystem(root, { cwd: process.cwd(), diffBasisMaxBytes: 1024 * 1024 });
  // SystemPrompt must be mounted BEFORE ToolRuntime: the latter's constructor
  // reads `ctx.systemPrompt` to wire tool schemas into the prompt. The rest
  // entry is where tools not named in the order list are inserted.
  new SystemPrompt(root, { toolOrder: [TOOL_ORDER_REST] });
  new ToolRuntime(root);
  return root;
}

/** A stand-in tool, for occupying a name on some layer. */
function stubTool(toolName: string, description: string) {
  return defineTool({
    name: toolName,
    description,
    parameters: {},
    output: { schema: { type: "string" }, render: () => [{ type: "text", text: "ok" }] },
    execute: async () => "ok",
  });
}

/**
 * A stand-in agent on its OWN cordis scope, with its own tool layer inspected.
 *
 * Reading the agent's own layer is the precise probe, and it is the ONE thing
 * the public API cannot answer. `tools.get(name, scope)` resolves through the
 * scope CHAIN, so when the built-ins are inherited from a preset or global layer
 * it already answers `read`/`write`/`edit` before this plugin installs anything
 * — a baseline built on it swallows every install and reports nothing (verified:
 * both "inherited from an ancestor layer" and "in the global layer" tests fail
 * with `[]`). `ToolRuntime.layers` is where per-layer occupancy actually lives,
 * so the probe reaches for it deliberately; the cast below is what keeps that
 * reach visible to the type checker instead of silently untyped.
 *
 * The scope is minted with `createScope` and NOT `root.extend()`, because the
 * layer a registration lands on is the whole subject here: a real agent gets a
 * tagged scope (`createScope(loopCtx, agent).ctx`, keyed by the agent itself)
 * whose own layer shadows its ancestors'. An untagged `extend()` registers into
 * the GLOBAL layer instead, which silently hides every difference between "same
 * layer" (a real conflict) and "inherited layer" (shadowing, which is the point
 * of this plugin).
 *
 * @param root - the host context.
 * @param id - the agent id.
 * @param options.presetKey - when given, the agent's scope is parented to that
 *   scope, reproducing a deployment whose built-ins are mounted by a preset.
 * @param options.rivals - tool names a competing plugin already registered on
 *   this agent's OWN layer. Registered before the baseline is taken, so
 *   `registeredNames()` reports only what this plugin's install registered.
 */
function makeAgent(
  root: Context,
  id = "agent-1",
  options: { presetKey?: object; rivals?: readonly string[] } = {},
): Harness {
  const agent = { id, ctx: undefined as unknown as Context };
  const scope = createScope(root, agent);
  if (options.presetKey !== undefined) bindScopeParent(agent, options.presetKey);
  agent.ctx = scope.ctx;
  const agentCtx = scope.ctx;

  for (const rival of options.rivals ?? []) {
    agentCtx.tools.register(stubTool(rival, "stand-in for another plugin's tool"));
  }

  // Read the agent's OWN layer rather than counting `register` calls. Wrapping
  // `ctx.tools.register` would replace a method on the SHARED registry service
  // (the scoped context hands out a fresh tracing proxy per access, but writes
  // land on the one service), so one agent's counter would capture another
  // agent's installs — and, worse, the replacement bypasses the tracing that
  // binds `register` to the caller's context, sending every registration to the
  // GLOBAL layer instead of the agent's own. Reading the layer is both
  // side-effect-free and the actual question being asked.
  //
  // `layers` is private on ToolRuntime. The cast is intentional and is the only
  // way to observe per-layer occupancy; see the note above for why the public
  // `get(name, scope)` cannot stand in.
  const runtime = root.tools as unknown as {
    layers: { scoped: Map<object, { tools: Map<string, unknown> }> };
  };
  const ownLayer = () => runtime.layers.scoped.get(agent)?.tools;
  const baseline = new Set(ownLayer()?.keys() ?? []);
  const installedNames = (): string[] => {
    const names: string[] = [];
    for (const toolName of ownLayer()?.keys() ?? []) {
      if (!baseline.has(toolName)) names.push(toolName);
    }
    return names;
  };

  return { agent, registeredNames: installedNames };
}

/**
 * Mint a preset-shaped ancestor scope — the layer a deployment's built-ins sit
 * on when the profile moves `tool-fs` behind agent presets (as `dsh-web-app`
 * does). Returns the scope key, which is also the object `get(name, scope)`
 * takes as its viewing scope.
 */
function makePresetScope(root: Context, toolNames: readonly string[]): object {
  const preset = { id: "preset" };
  const scope = createScope(root, preset);
  for (const toolName of toolNames) {
    scope.ctx.tools.register(stubTool(toolName, "built-in on the preset layer"));
  }
  return preset;
}

/**
 * The compiled JSON Schema properties of a tool as ONE AGENT resolves it.
 *
 * Read through the agent's own scope: `root.tools.get(name)` answers for the
 * global view, where a per-agent shadow is deliberately invisible.
 */
function paramsOf(agentCtx: Context, toolName: string): Record<string, unknown> {
  const scope = scopeOf(agentCtx);
  const tool = agentCtx.tools.get(toolName, scope) as unknown as {
    parameters: { properties?: Record<string, unknown> };
  };
  return tool.parameters.properties ?? {};
}

describe("plugin identity", () => {
  it("declares the services the install touches", () => {
    expect(name).toBe("dsh-fs-encoding");
    // Missing any of these makes the install throw at session-start, which is
    // invisible from the model's side: the session silently runs the built-ins.
    expect(inject).toEqual(["tools", "systemPrompt", "fs"]);
  });
});

describe("apply", () => {
  it("registers read, write and edit on the agent's own scope", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);

    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(h.registeredNames().sort()).toEqual(REGISTERED_TOOL_NAMES);
    // And they are visible through the same registry the model's list comes
    // from — read through the agent's scope, since a per-agent shadow is
    // deliberately invisible in the global view.
    const scope = scopeOf(h.agent.ctx);
    expect(h.agent.ctx.tools.get("read", scope)).toBeDefined();
    expect(h.agent.ctx.tools.get("write", scope)).toBeDefined();
    expect(h.agent.ctx.tools.get("edit", scope)).toBeDefined();
  });

  it("installs exactly once even if session-start fires twice", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);

    root.emit("agent/session-start", { agent: h.agent } as never);
    // A second install would re-register the same names in one layer, which the
    // registry rejects outright — so this emit must be a no-op, not a throw.
    expect(() => root.emit("agent/session-start", { agent: h.agent } as never)).not.toThrow();

    expect(h.registeredNames().sort()).toEqual(REGISTERED_TOOL_NAMES);
  });

  it("installs for a second agent without disturbing the first", () => {
    const root = makeHost();
    apply(root);
    const first = makeAgent(root, "a1");
    const second = makeAgent(root, "a2");

    root.emit("agent/session-start", { agent: first.agent } as never);
    // The second agent's install must not throw. A duplicate registration in
    // one layer is rejected by the registry, so reaching the assertion at all
    // proves each agent's install targeted its own layer.
    expect(() =>
      root.emit("agent/session-start", { agent: second.agent } as never),
    ).not.toThrow();

    // Both agents resolve the three tools through their own scoped view.
    const firstScope = scopeOf(first.agent.ctx);
    const secondScope = scopeOf(second.agent.ctx);
    expect(first.agent.ctx.tools.get("read", firstScope)).toBeDefined();
    expect(second.agent.ctx.tools.get("read", secondScope)).toBeDefined();
    expect(second.agent.ctx.tools.get("write", secondScope)).toBeDefined();
    expect(second.agent.ctx.tools.get("edit", secondScope)).toBeDefined();
  });

  it("installs normally when the built-ins are inherited from an ancestor layer", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    // The web-app shape: `tool-fs` is disabled host-plane and mounted by the
    // preset instead, so the built-ins live on an ANCESTOR layer. Shadowing an
    // inherited name is legal and is exactly what this plugin exists to do, so
    // the install must succeed rather than report a conflict.
    const presetKey = makePresetScope(root, ["read", "write", "edit"]);

    apply(root);
    const h = makeAgent(root, "agent-1", { presetKey });
    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(h.registeredNames().sort()).toEqual(REGISTERED_TOOL_NAMES);
    expect(logger.error).not.toHaveBeenCalled();
    // And the agent resolves OUR definitions, not the inherited ones.
    expect(paramsOf(h.agent.ctx, "read")["encoding"]).toBeDefined();
  });

  it("installs normally when the built-ins are in the global layer", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    // The headless / SDK / ACP shape: `dsh-base` mounts `tool-fs` host-plane and
    // those profiles never disable it, so the built-ins sit in the GLOBAL layer.
    // An occupancy probe that read the global view would call this a conflict
    // and refuse to install — the regression this test pins down.
    for (const toolName of ["read", "write", "edit"]) {
      root.tools.register(stubTool(toolName, "built-in in the global layer"));
    }

    apply(root);
    const h = makeAgent(root);
    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(h.registeredNames().sort()).toEqual(REGISTERED_TOOL_NAMES);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("refuses to install when another plugin owns a tool name on the same layer", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    // The REAL conflict: another plugin registered one of our names on the
    // AGENT'S OWN layer, which is the only layer where a duplicate throws.
    apply(root);
    const h = makeAgent(root, "agent-1", { rivals: ["read"] });
    root.emit("agent/session-start", { agent: h.agent } as never);

    // Nothing of ours was registered, and the rival is untouched.
    expect(h.registeredNames()).toHaveLength(0);

    // The operator got an actionable message, not a raw registry error.
    expect(logger.error).toHaveBeenCalledOnce();
    const message = logger.error.mock.calls[0]![0] as string;
    expect(message).toContain('"read"');
    expect(message).toContain("disabled: true");
  });

  it("never names another plugin in the conflict message", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    apply(root);
    const h = makeAgent(root, "agent-1", { rivals: ["edit"] });
    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(logger.error).toHaveBeenCalledOnce();
    const message = logger.error.mock.calls[0]![0] as string;

    // It names the tool that is actually taken...
    expect(message).toContain('"edit"');
    // ...and stops there. Which plugin holds the layer is the operator's to
    // determine: a hard-coded name would be wrong whenever a different plugin
    // collides, and would read as a complaint about that particular project.
    expect(message).not.toMatch(/dsh-better-edit/i);
    // The placeholder tells the operator what to fill in rather than guessing.
    expect(message).toContain("<the other plugin's id>");
  });

  it("names the rejected tool when the registry is what catches the duplicate", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    apply(root);
    const h = makeAgent(root);

    // A registration that fails part-way: the registry's own rejection is what
    // fires, and the tool it names is what the operator must be shown.
    const realRegister = h.agent.ctx.tools.register.bind(h.agent.ctx.tools);
    let calls = 0;
    vi.spyOn(h.agent.ctx.tools, "register").mockImplementation((tool: ToolDefinition) => {
      calls += 1;
      if (calls === 2) throw new Error('tool "write" is already registered in this scope');
      return realRegister(tool);
    });

    expect(() => root.emit("agent/session-start", { agent: h.agent } as never)).not.toThrow();

    expect(logger.error).toHaveBeenCalledOnce();
    const message = logger.error.mock.calls[0]![0] as string;
    // The tool named in the registry error is what the operator sees.
    expect(message).toContain('"write"');
    expect(message).toContain("disabled: true");
    // And no plugin is named — only the tool that is actually taken.
    expect(message).not.toMatch(/dsh-better-edit/i);
  });

  it("reports an unnamed conflict when the registry rejection names no tool", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    apply(root);
    const h = makeAgent(root);

    // A duplicate rejection whose text does not carry a quoted tool name: the
    // message must still be the actionable one, falling back to the generic
    // "another plugin already provides …" wording rather than printing
    // "undefined".
    const realRegister = h.agent.ctx.tools.register.bind(h.agent.ctx.tools);
    let calls = 0;
    vi.spyOn(h.agent.ctx.tools, "register").mockImplementation((tool: ToolDefinition) => {
      calls += 1;
      if (calls === 2) throw new Error("this name is already registered in this scope");
      return realRegister(tool);
    });

    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(logger.error).toHaveBeenCalledOnce();
    const message = logger.error.mock.calls[0]![0] as string;
    expect(message).toContain("another plugin already provides");
    expect(message).toContain("disabled: true");
    expect(message).not.toContain("undefined");
  });

  it("rolls back a partial install so no half-shadowed set remains", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    apply(root);
    const h = makeAgent(root);

    // Let `read` land, then make the next registration throw.
    const realRegister = h.agent.ctx.tools.register.bind(h.agent.ctx.tools);
    let calls = 0;
    vi.spyOn(h.agent.ctx.tools, "register").mockImplementation((tool: ToolDefinition) => {
      calls += 1;
      if (calls === 2) throw new Error('tool "write" is already registered in this scope');
      return realRegister(tool);
    });

    root.emit("agent/session-start", { agent: h.agent } as never);

    // `read` was registered before the failure and must have been rolled back,
    // so the layer is not left half-shadowed: NOTHING of ours survives.
    expect(h.registeredNames()).toHaveLength(0);
    const scope = scopeOf(h.agent.ctx);
    expect(h.agent.ctx.tools.get("read", scope)).toBeUndefined();
    expect(h.agent.ctx.tools.get("write", scope)).toBeUndefined();
    expect(h.agent.ctx.tools.get("edit", scope)).toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
    const message = logger.error.mock.calls[0]![0] as string;
    expect(message).toContain('"write"');
    expect(message).toContain("disabled: true");
  });

  it("installs normally when no other plugin holds a name", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);
    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(h.registeredNames().sort()).toEqual(REGISTERED_TOOL_NAMES);
  });

  it("refuses the install when another plugin holds str_replace_editor", () => {
    // The added names participate in the conflict check exactly like the
    // shadowed ones: registering a name twice on a layer throws, whoever wants it.
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);
    h.agent.ctx.tools.register(stubTool("str_replace_editor", "someone else's"));

    const logger = { error: vi.fn(), warn: vi.fn() };
    (root as unknown as { logger: unknown }).logger = logger;

    root.emit("agent/session-start", { agent: h.agent } as never);

    // Only the foreign tool remains — ours were rolled back.
    expect(h.registeredNames().sort()).toEqual(["str_replace_editor"]);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]![0] as string).toContain('"str_replace_editor"');
  });

  it("refuses the install when another plugin holds insert", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);
    h.agent.ctx.tools.register(stubTool("insert", "someone else's"));

    const logger = { error: vi.fn(), warn: vi.fn() };
    (root as unknown as { logger: unknown }).logger = logger;

    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(h.registeredNames().sort()).toEqual(["insert"]);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]![0] as string).toContain('"insert"');
  });

  it("does not need any inventory service to detect the conflict", () => {
    // The check must not depend on a service whose absence silently disables
    // it — that was the failure mode of the previous implementation.
    const root = makeHost();
    expect(root.get("pluginInventory")).toBeUndefined();

    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    apply(root);
    const h = makeAgent(root, "agent-1", { rivals: ["read"] });
    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(h.registeredNames()).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe("tool schemas", () => {
  it("read exposes the encoding argument alongside the native ones", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);
    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(Object.keys(paramsOf(h.agent.ctx, "read")).sort()).toEqual([
      "encoding",
      "file_path",
      "limit",
      "offset",
    ]);
  });

  it("lists every accepted encoding in the error, not in the always-sent description", async () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);
    root.emit("agent/session-start", { agent: h.agent } as never);

    const scope = scopeOf(h.agent.ctx);
    const read = h.agent.ctx.tools.get("read", scope) as unknown as {
      description: string;
      parameters: { properties: { encoding: { description: string } } };
    };

    // The full list lives in the E_BAD_ENCODING message, which only exists on
    // the error path. Keeping it out of the description and the argument help
    // costs nothing: a model that hits a bad name is told every valid one.
    //
    // Assert against the REAL message, not against the constant it is built
    // from: comparing SUPPORTED_ENCODINGS_TEXT with CANONICAL_ENCODINGS is a
    // tautology (the former is the latter joined) and would stay green even if
    // a short literal list were hard-coded back into an error message.
    let message = "";
    try {
      await decodeForOpen(
        new Uint8Array([0x41]),
        { autoGuessEncoding: false, supportedEncodings: [] },
        { encodingHint: "definitely-not-an-encoding" },
      );
      expect.unreachable("expected E_BAD_ENCODING");
    } catch (error) {
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe("E_BAD_ENCODING");
      message = (error as Error).message;
    }
    for (const enc of CANONICAL_ENCODINGS) {
      expect(message).toContain(enc);
    }

    // Neither always-sent string may carry the list.
    expect(read.description).not.toContain("windows-1250");
    expect(read.parameters.properties.encoding.description).not.toContain("windows-1250");

    // Every advertised name must actually resolve.
    for (const enc of CANONICAL_ENCODINGS) {
      expect(normalizeEncoding(enc)).toBeDefined();
    }
  });

  it("write and edit keep the built-in argument names", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);
    root.emit("agent/session-start", { agent: h.agent } as never);

    // fs-sandbox is mounted, so the escalation pair is advertised too.
    //
    // `encoding` is the one deliberate ADDITION to the built-in `write` shape: it
    // names the encoding of a file being created. The built-in names must all
    // still be present and unchanged, which is what this guards.
    expect(Object.keys(paramsOf(h.agent.ctx, "write")).sort()).toEqual([
      "content",
      "encoding",
      "file_path",
      "justification",
      "sandbox_permissions",
    ]);
    expect(Object.keys(paramsOf(h.agent.ctx, "edit")).sort()).toEqual([
      "file_path",
      "justification",
      "new_string",
      "old_string",
      "replace_all",
      "sandbox_permissions",
    ]);
  });

  it("advertises the escalation enum with the wider modes", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);
    root.emit("agent/session-start", { agent: h.agent } as never);

    const scope = scopeOf(h.agent.ctx);
    const write = h.agent.ctx.tools.get("write", scope) as unknown as {
      parameters: { properties: Record<string, { enum?: string[] }> };
    };
    expect(write.parameters.properties["sandbox_permissions"]?.enum).toEqual([
      "workspace-write",
      "danger-full-access",
    ]);
  });
});
