/**
 * The directory a tool call resolves relative paths against.
 *
 * The reported defect: on DSH 0.2.1 a session can `cd` (the `working_directory`
 * tool), and after that the built-in `read` opens `package.json` in the NEW
 * directory while this plugin's `read` answered `no such file`. The plugin read
 * `session.header.cwd`, which is frozen at session creation; the current
 * directory lives in a `working-directory/change` event that only the
 * `workingDirectory` service folds.
 *
 * Two things are pinned here, because either one alone would pass while the
 * feature stayed broken:
 *
 *   - the cwd follows the service (not the header) when the service is mounted;
 *   - the header still answers on a deployment that has no such service, which
 *     is every DSH line before 0.2.1 — and is why the service cannot be an
 *     `inject`ed dependency.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { clearEncodingState } from "../src/encoding-state.js";
import { buildReadTool } from "../src/tool-read.js";
import { resolveWorkspace } from "../src/workspace-context.js";

let root0: string;

beforeAll(() => {
  root0 = mkdtempSync(join(tmpdir(), "fs-encoding-cwd-"));
});

afterAll(() => {
  rmSync(root0, { recursive: true, force: true });
});

/** An agent-shaped subject whose session header names `headerCwd`. */
function makeExec(headerCwd: string): ToolRunContext {
  const session = { id: `sess-${Math.random().toString(36).slice(2)}`, header: { cwd: headerCwd } };
  return {
    name: "read",
    callId: "call-1",
    agent: { session },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

/** A host with a sandboxed filesystem rooted at `cwd`. */
function makeHost(cwd: string): Context {
  const root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: cwd }),
  });
  new SandboxedFileSystem(root, { cwd, diffBasisMaxBytes: 1024 * 1024 });
  clearEncodingState();
  return root;
}

describe("resolveWorkspace", () => {
  it("follows the workingDirectory service instead of the frozen session header", async () => {
    // Two directories, each holding a file of the SAME name and different
    // content: resolving the wrong one cannot be mistaken for a right answer.
    const start = join(root0, "start");
    const later = join(root0, "later");
    mkdirSync(start, { recursive: true });
    mkdirSync(later, { recursive: true });
    writeFileSync(join(start, "note.txt"), "from the start directory\n");
    writeFileSync(join(later, "note.txt"), "from the later directory\n");

    const root = makeHost(start);
    // The service as 0.2.1 defines it: `ensure` answers the session's CURRENT
    // directory. Stubbed rather than mounted, because the real service needs a
    // session store, a projection registry and a prompt — none of which this
    // plugin reads, and all of which would be scaffolding around one call.
    root.provide("workingDirectory", { ensure: async () => later });

    const exec = makeExec(start);
    const cwd = await resolveWorkspace(root, exec);
    expect(cwd).toBe(later);

    // The decisive half: the tool actually opens the file the service named.
    const tool = buildReadTool(root);
    const result = (await tool.execute({ file_path: "note.txt" }, exec)) as {
      lines: Array<{ text: string }>;
    };
    expect(result.lines[0]?.text).toBe("from the later directory");
  });

  it("falls back to the session header when no workingDirectory service is mounted", async () => {
    // Every DSH line before 0.2.1. The fallback is what keeps this plugin working
    // there at all, and the reason the service is probed with `ctx.get` rather
    // than declared in `inject` — an injected service that is missing
    // deactivates the whole plugin, taking read/write/edit with it.
    const start = join(root0, "header-only");
    mkdirSync(start, { recursive: true });
    writeFileSync(join(start, "note.txt"), "from the header directory\n");

    const root = makeHost(start);
    const exec = makeExec(start);
    expect(await resolveWorkspace(root, exec)).toBe(start);

    const tool = buildReadTool(root);
    const result = (await tool.execute({ file_path: "note.txt" }, exec)) as {
      lines: Array<{ text: string }>;
    };
    expect(result.lines[0]?.text).toBe("from the header directory");
  });

  it("answers the process cwd for an agent-less caller", async () => {
    const root = makeHost(process.cwd());
    const exec = { name: "read", callId: "call-1", signal: new AbortController().signal } as unknown as ToolRunContext;
    expect(await resolveWorkspace(root, exec)).toBe(process.cwd());
  });
});
