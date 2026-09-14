/**
 * Regression tests for the defects found after the first delivery:
 *
 * 1. The diff-card read used to fail on a legacy file, because it re-read the
 *    file without an encoding hint and a GBK file cannot be admitted without
 *    one. The fix reuses the session's recorded encoding.
 * 2. The memo that records that encoding was keyed by target alone, so two
 *    sessions shared one entry, and nothing ever evicted it.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import * as observationPolicy from "@deepseek-ai/dsh-fs-observation-policy";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import {
  clearEncodingState,
  clearSession,
  encodingStateCount,
  getEncodingState,
  sessionCount,
} from "../src/encoding-state.js";
import { readFile as pluginRead } from "../src/io.js";

let dir: string;
let root: Context;

const gbkBytes = (s: string) => Buffer.from(iconv.encode(s, "gbk"));

function makeExec(cwd: string, sessionId: string): ToolExecution {
  return {
    name: "read",
    callId: "call-1",
    agent: { session: { id: sessionId, header: { cwd } } },
  } as unknown as ToolExecution;
}

/** The canonical key a path resolves to, as the plugin memoizes it. */
async function keyOfPath(path: string): Promise<string> {
  const target = await root.fs.resolve(path);
  return String((target as unknown as { targetKey: string }).targetKey);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-encoding-fixes-"));
  root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: dir }),
  });
  new SandboxedFileSystem(root, { cwd: dir, diffBasisMaxBytes: 10 * 1024 * 1024 });
  observationPolicy.apply(root);
  clearEncodingState();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a session's recorded encoding is reused on a later read", () => {
  it("re-reads a legacy file without a repeated hint", async () => {
    const text = "你好，世界\n";
    await writeFile(join(dir, "gbk.txt"), gbkBytes(text));

    const first = await pluginRead(root, "gbk.txt", dir, {
      exec: makeExec(dir, "s1"),
      encodingHint: "gbk",
    });
    expect(first.text).toBe(text);

    // No hint this time. Before the fix this threw E_NOT_TEXT, which is what
    // silently stripped the diff card from a write.
    const second = await pluginRead(root, "gbk.txt", dir, { exec: makeExec(dir, "s1") });
    expect(second.text).toBe(text);
    expect(second.state.encoding).toBe("gbk");
  });

  it("still fails loud when the file was never admitted in this session", async () => {
    // The reuse must not become a permissive fallback: with no memo and no
    // hint, a legacy file still fails with candidates.
    await writeFile(join(dir, "gbk.txt"), gbkBytes("你好，世界，这是中文测试内容"));
    await expect(
      pluginRead(root, "gbk.txt", dir, { exec: makeExec(dir, "fresh") }),
    ).rejects.toThrow(/E_NOT_TEXT/);
  });

  it("drops the recorded encoding when the file changes on disk", async () => {
    const p = join(dir, "shift.txt");
    await writeFile(p, gbkBytes("你好\n"));
    await pluginRead(root, "shift.txt", dir, { exec: makeExec(dir, "s1"), encodingHint: "gbk" });

    // Replace the file with UTF-8 content of a different size, so the version
    // changes and the memo is invalidated rather than reused.
    await writeFile(p, Buffer.from("plain ascii that is long enough to change the version\n"));

    const reread = await pluginRead(root, "shift.txt", dir, { exec: makeExec(dir, "s1") });
    expect(reread.state.encoding).toBe("utf8");
    expect(reread.text).toContain("plain ascii");
  });
});

describe("encoding state is scoped per session", () => {
  it("keeps two sessions' records apart", async () => {
    await writeFile(join(dir, "shared.txt"), gbkBytes("你好\n"));

    await pluginRead(root, "shared.txt", dir, {
      exec: makeExec(dir, "session-a"),
      encodingHint: "gbk",
    });
    await pluginRead(root, "shared.txt", dir, {
      exec: makeExec(dir, "session-b"),
      encodingHint: "big5",
    });

    const key = await keyOfPath(join(dir, "shared.txt"));

    // Before the fix one Map entry served both sessions, so the second read
    // silently overwrote the first session's encoding.
    expect(getEncodingState("session-a", key)?.encoding).toBe("gbk");
    expect(getEncodingState("session-b", key)?.encoding).toBe("big5");
  });

  it("does not let another session's record satisfy a read", async () => {
    await writeFile(join(dir, "gbk.txt"), gbkBytes("你好，世界，这是中文测试内容"));
    await pluginRead(root, "gbk.txt", dir, {
      exec: makeExec(dir, "session-a"),
      encodingHint: "gbk",
    });

    // session-b has no record, so it must not inherit session-a's and must
    // fail loud rather than silently decoding under another session's choice.
    await expect(
      pluginRead(root, "gbk.txt", dir, { exec: makeExec(dir, "session-b") }),
    ).rejects.toThrow(/E_NOT_TEXT/);
  });

  it("releases a session's records when the session ends", async () => {
    await writeFile(join(dir, "a.txt"), Buffer.from("one\n"));
    await writeFile(join(dir, "b.txt"), Buffer.from("two\n"));
    await pluginRead(root, "a.txt", dir, { exec: makeExec(dir, "doomed") });
    await pluginRead(root, "b.txt", dir, { exec: makeExec(dir, "doomed") });
    expect(encodingStateCount()).toBeGreaterThanOrEqual(2);
    expect(sessionCount()).toBeGreaterThanOrEqual(1);

    clearSession("doomed");

    const key = await keyOfPath(join(dir, "a.txt"));
    expect(getEncodingState("doomed", key)).toBeUndefined();
  });

  it("treats an agentless read as its own bucket rather than a shared one", async () => {
    await writeFile(join(dir, "anon.txt"), Buffer.from("anon\n"));
    const agentless = { name: "read", callId: "c", agent: undefined } as unknown as ToolExecution;
    const outcome = await pluginRead(root, "anon.txt", dir, { exec: agentless });
    expect(outcome.text).toBe("anon\n");
    // No crash, and the record lands under the anonymous bucket.
    expect(encodingStateCount()).toBeGreaterThanOrEqual(1);
  });

  it("bounds the number of tracked sessions", async () => {
    // A long-lived process sees many sessions; without a bound the map would
    // grow forever. The bound is enforced by evicting the least recently used.
    for (let i = 0; i < 80; i += 1) {
      await writeFile(join(dir, `f${i}.txt`), Buffer.from(`content ${i}\n`));
      await pluginRead(root, `f${i}.txt`, dir, { exec: makeExec(dir, `session-${i}`) });
    }
    expect(sessionCount()).toBeLessThanOrEqual(64);
  });
});
