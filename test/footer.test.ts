/**
 * Regression tests for the auto-guess footer.
 *
 * When `autoGuessEncoding` is on, the first read of a legacy file reports that
 * the encoding was GUESSED. The bug this covers: the second read in the same
 * session took the memo's encoding and re-decoded with an explicit hint — and
 * the hint path produces no footer — so the warning vanished after the first
 * read. That is exactly backwards: a guess is least trustworthy the longer it
 * goes unmentioned.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import * as observationPolicy from "@deepseek-ai/dsh-fs-observation-policy";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { resetConfigCache } from "../src/config.js";
import { clearEncodingState, getEncodingState } from "../src/encoding-state.js";
import { readFile as pluginRead, writeFile as pluginWrite } from "../src/io.js";
import { EncodingSandbox } from "../src/sandbox.js";

let dir: string;
let root: Context;
let sandbox: EncodingSandbox;
let policy: SandboxExecutionPolicy;
let exec: ToolExecution;

/** Long enough that the heuristic scoring is decisive. */
const GBK_TEXT = "你好，世界，这是中文测试内容，用于触发自动猜测逻辑\n";

async function keyOfPath(path: string): Promise<string> {
  const target = await root.fs.resolve(path);
  return String((target as unknown as { targetKey: string }).targetKey);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-encoding-footer-"));
  root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: dir }),
  });
  new SandboxedFileSystem(root, { cwd: dir, diffBasisMaxBytes: 10 * 1024 * 1024 });
  observationPolicy.apply(root);
  sandbox = new EncodingSandbox(root);
  policy = { mode: "workspace-write", workspaceRoot: dir };
  exec = {
    name: "read",
    callId: "c1",
    agent: { session: { id: "footer-session", header: { cwd: dir } } },
  } as unknown as ToolExecution;
  clearEncodingState();
});

afterEach(async () => {
  delete process.env["DSH_FS_ENCODING_AUTO_GUESS"];
  resetConfigCache();
  await rm(dir, { recursive: true, force: true });
});

describe("with autoGuessEncoding on", () => {
  beforeEach(() => {
    process.env["DSH_FS_ENCODING_AUTO_GUESS"] = "true";
    resetConfigCache();
  });

  it("reports the guess on the first read", async () => {
    await writeFile(join(dir, "gbk.txt"), Buffer.from(iconv.encode(GBK_TEXT, "gbk")));
    const first = await pluginRead(root, "gbk.txt", dir, { exec });
    expect(first.state.encoding).toBe("gbk");
    expect(first.footer).toBeDefined();
    expect(first.footer).toContain("Auto-guessed");
  });

  it("still reports the guess on a second read in the same session", async () => {
    await writeFile(join(dir, "gbk.txt"), Buffer.from(iconv.encode(GBK_TEXT, "gbk")));

    const first = await pluginRead(root, "gbk.txt", dir, { exec });
    expect(first.footer).toBeDefined();

    // Before the fix this returned no footer: the memo's encoding was reused
    // through the hint path, which produces none.
    const second = await pluginRead(root, "gbk.txt", dir, { exec });
    expect(second.footer).toBeDefined();
    expect(second.footer).toContain("Auto-guessed");
  });

  it("keeps reporting the guess after a write in the same session", async () => {
    const p = join(dir, "gbk.txt");
    await writeFile(p, Buffer.from(iconv.encode(GBK_TEXT, "gbk")));

    const read = await pluginRead(root, "gbk.txt", dir, { exec });
    await pluginWrite(
      root,
      sandbox,
      { target: read.target, content: read.text.replace("世界", "地球"), exec, policy },
      "write",
    );

    // A write must not erase the provenance: the file was decoded from a guess,
    // and that is still true after an edit.
    const key = await keyOfPath(p);
    expect(getEncodingState("footer-session", key)?.footer).toContain("Auto-guessed");

    const after = await pluginRead(root, "gbk.txt", dir, { exec });
    expect(after.footer).toContain("Auto-guessed");
  });

  it("drops the guess note once the file is re-read as plain UTF-8", async () => {
    const p = join(dir, "gbk.txt");
    await writeFile(p, Buffer.from(iconv.encode(GBK_TEXT, "gbk")));
    await pluginRead(root, "gbk.txt", dir, { exec });

    // Replace with UTF-8 content of a different size, so the version changes.
    await writeFile(p, Buffer.from("plain ascii content that is clearly utf8 and long enough\n"));

    const reread = await pluginRead(root, "gbk.txt", dir, { exec });
    expect(reread.state.encoding).toBe("utf8");
    expect(reread.footer).toBeUndefined();
  });
});

describe("with autoGuessEncoding off", () => {
  it("never invents a guess note", async () => {
    await writeFile(join(dir, "u.txt"), Buffer.from("plain utf8\n"));
    const read = await pluginRead(root, "u.txt", dir, { exec });
    expect(read.state.encoding).toBe("utf8");
    expect(read.footer).toBeUndefined();
  });

  it("still fails loud on a legacy file rather than guessing", async () => {
    await writeFile(join(dir, "gbk.txt"), Buffer.from(iconv.encode(GBK_TEXT, "gbk")));
    await expect(pluginRead(root, "gbk.txt", dir, { exec })).rejects.toThrow(/E_NOT_TEXT/);
  });
});
