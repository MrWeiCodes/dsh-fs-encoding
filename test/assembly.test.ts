/**
 * Assembly tests: the plugin's `apply()` and its per-agent install.
 *
 * The tool bodies are covered by `roundtrip.test.ts`; this file covers what
 * wraps them — that the three tools actually register on an agent's own scope
 * layer (shadowing the built-ins), that their prompt sections land, and that
 * the plugin refuses to install alongside `dsh-better-edit` instead of leaving
 * a half-registered tool set.
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
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";
import { SystemPrompt, TOOL_ORDER_REST } from "@deepseek-ai/dsh-system-prompt";
import { apply, inject, name } from "../src/index.js";

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

/**
 * A stand-in agent on its OWN cordis scope, with tool registrations counted.
 *
 * Counting `tools.register` calls is the precise probe: `effect` is also used
 * internally by the registries themselves, while a `register` call can only
 * come from an install.
 *
 * Each `root.extend()` yields a context whose `tools` proxy is distinct, so the
 * patch is applied per agent and each agent keeps its own counter.
 */
function makeAgent(root: Context, id = "agent-1"): Harness {
  const agentCtx = root.extend({ name: `agent-${id}` });
  const names: string[] = [];

  const tools = agentCtx.tools as unknown as {
    register: (def: { name: string }) => () => void;
  };
  const originalRegister = tools.register.bind(tools);
  tools.register = (def: { name: string }) => {
    names.push(def.name);
    return originalRegister(def);
  };

  return { agent: { id, ctx: agentCtx }, registeredNames: () => names };
}

/** The compiled JSON Schema properties of a registered tool's parameters. */
function paramsOf(root: Context, toolName: string): Record<string, unknown> {
  const tool = root.tools.get(toolName) as unknown as {
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

    expect(h.registeredNames().sort()).toEqual(["edit", "read", "write"]);
    // And they are visible through the same registry the model's list comes from.
    expect(root.tools.get("read")).toBeDefined();
    expect(root.tools.get("write")).toBeDefined();
    expect(root.tools.get("edit")).toBeDefined();
  });

  it("installs exactly once even if session-start fires twice", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);

    root.emit("agent/session-start", { agent: h.agent } as never);
    // A second install would re-register the same names in one layer, which the
    // registry rejects outright — so this emit must be a no-op, not a throw.
    expect(() => root.emit("agent/session-start", { agent: h.agent } as never)).not.toThrow();

    expect(h.registeredNames().sort()).toEqual(["edit", "read", "write"]);
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
    expect(first.agent.ctx.tools.get("read")).toBeDefined();
    expect(second.agent.ctx.tools.get("read")).toBeDefined();
    expect(second.agent.ctx.tools.get("write")).toBeDefined();
    expect(second.agent.ctx.tools.get("edit")).toBeDefined();
  });

  it("refuses to install when a competing plugin already owns the layer", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    // Simulate the REAL conflict condition: the competing plugin has already
    // registered one of its own tools on this layer. This is what the check
    // observes — not a bundle list, which would be a prediction rather than the
    // condition itself.
    root.tools.register(
      defineTool({
        name: "undo_last_edit",
        description: "stand-in for the competing plugin's tool",
        parameters: {},
        output: {
          schema: { type: "string" },
          render: () => [{ type: "text", text: "ok" }],
        },
        execute: async () => "ok",
      }),
    );

    apply(root);
    const h = makeAgent(root);
    root.emit("agent/session-start", { agent: h.agent } as never);

    // Nothing of ours was registered.
    expect(h.registeredNames()).toHaveLength(0);
    expect(root.tools.get("read")).toBeUndefined();

    // And the operator got an actionable message, not a registry error.
    expect(logger.error).toHaveBeenCalledOnce();
    const message = logger.error.mock.calls[0]![0] as string;
    expect(message).toContain("dsh-better-edit");
    expect(message).toContain("disabled: true");
  });

  it("produces the actionable message when the registry rejects a duplicate", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    apply(root);
    const h = makeAgent(root);

    // Occupy one of OUR names on the same layer without the competing marker
    // tool, so the pre-check cannot see it and only the registry's own
    // duplicate rejection fires. This is the path a plugin that registers a
    // subset of the names would take.
    root.tools.register(
      defineTool({
        name: "read",
        description: "an unrelated plugin that took this name",
        parameters: {},
        output: {
          schema: { type: "string" },
          render: () => [{ type: "text", text: "ok" }],
        },
        execute: async () => "ok",
      }),
    );

    expect(() => root.emit("agent/session-start", { agent: h.agent } as never)).not.toThrow();

    // The message is the actionable one, not the raw registry error.
    expect(logger.error).toHaveBeenCalledOnce();
    const message = logger.error.mock.calls[0]![0] as string;
    expect(message).toContain("dsh-better-edit");
    expect(message).toContain("disabled: true");
  });

  it("rolls back a partial install so no half-shadowed set remains", () => {
    const root = makeHost();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });

    apply(root);
    const h = makeAgent(root);

    // Occupy `write` so our install registers `read` and then fails on `write`.
    // In this harness `root.extend()` shares one registry object with the root,
    // so a root-layer registration is visible to the agent's layer — the same
    // way a preset-layer tool is visible to an agent in a real deployment.
    root.tools.register(
      defineTool({
        name: "write",
        description: "an unrelated plugin that took this name",
        parameters: {},
        output: {
          schema: { type: "string" },
          render: () => [{ type: "text", text: "ok" }],
        },
        execute: async () => "ok",
      }),
    );

    root.emit("agent/session-start", { agent: h.agent } as never);

    // `read` was registered before the failure and must have been rolled back,
    // so the layer is not left half-shadowed.
    expect(h.registeredNames()).toContain("read");
    expect(h.registeredNames()).not.toContain("edit");
    expect(root.tools.get("read")).toBeUndefined();
    // The competing tool is untouched — the rollback removed only our own.
    expect(root.tools.get("write")).toBeDefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("installs normally when no competing plugin is present", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);
    root.emit("agent/session-start", { agent: h.agent } as never);

    expect(h.registeredNames().sort()).toEqual(["edit", "read", "write"]);
  });

  it("does not need any inventory service to detect the conflict", () => {
    // The check must not depend on a service whose absence silently disables
    // it — that was the failure mode of the previous implementation.
    const root = makeHost();
    expect(root.get("pluginInventory")).toBeUndefined();

    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    Object.defineProperty(root, "logger", { value: logger, configurable: true });
    root.tools.register(
      defineTool({
        name: "undo_last_edit",
        description: "stand-in",
        parameters: {},
        output: { schema: { type: "string" }, render: () => [{ type: "text", text: "ok" }] },
        execute: async () => "ok",
      }),
    );

    apply(root);
    const h = makeAgent(root);
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

    expect(Object.keys(paramsOf(root, "read")).sort()).toEqual([
      "encoding",
      "file_path",
      "limit",
      "offset",
    ]);
    const read = root.tools.get("read") as unknown as { description: string };
    expect(read.description).toContain("GBK");
  });

  it("write and edit keep the built-in argument names", () => {
    const root = makeHost();
    apply(root);
    const h = makeAgent(root);
    root.emit("agent/session-start", { agent: h.agent } as never);

    // fs-sandbox is mounted, so the escalation pair is advertised too.
    expect(Object.keys(paramsOf(root, "write")).sort()).toEqual([
      "content",
      "file_path",
      "justification",
      "sandbox_permissions",
    ]);
    expect(Object.keys(paramsOf(root, "edit")).sort()).toEqual([
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

    const write = root.tools.get("write") as unknown as {
      parameters: { properties: Record<string, { enum?: string[] }> };
    };
    expect(write.parameters.properties["sandbox_permissions"]?.enum).toEqual([
      "workspace-write",
      "danger-full-access",
    ]);
  });
});
