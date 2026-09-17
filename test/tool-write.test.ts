/**
 * The `write` tool's `encoding` argument — plan B's gate.
 *
 * `encoding` names the encoding of a file being CREATED. On an existing file it
 * is refused, and that refusal is the whole point of the design: silently
 * accepting it would let a model believe it had converted a file when the plugin
 * had preserved the original encoding instead, and the reply cannot tell the two
 * apart. So the two behaviours under test are:
 *
 *   - a new file is created in the named encoding;
 *   - an existing file refuses the argument, before any read or write.
 *
 * The encoding round-trip itself is covered end-to-end in `roundtrip.test.ts`;
 * this file drives the TOOL, which is where the gate lives.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { clearEncodingState } from "../src/encoding-state.js";
import { EncodingSandbox } from "../src/sandbox.js";
import { buildWriteTool } from "../src/tool-write.js";

let dir: string;
let root: Context;
let tool: ReturnType<typeof buildWriteTool>;
let exec: ToolRunContext;

const gbkBytes = (s: string) => Buffer.from(iconv.encode(s, "gbk"));

/**
 * The tool's `execute` as the harness would call it.
 *
 * `exec` is a `ToolRunContext`, not the narrower `ToolExecution` this test used
 * to declare: `execute` takes the run context, which extends the execution with
 * `deferContext` / `concludeTurn`. The plugin never calls either, so the cast is
 * confined to the stub below and the call site stays type-checked.
 */
async function run(args: Record<string, unknown>) {
  return tool.execute(args, exec);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-encoding-write-"));
  root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: dir }),
  });
  new SandboxedFileSystem(root, { cwd: dir, diffBasisMaxBytes: 1024 * 1024 });
  const sandbox = new EncodingSandbox(root);
  tool = buildWriteTool(root, sandbox);
  const session = { id: `sess-${Math.random().toString(36).slice(2)}`, header: { cwd: dir } };
  exec = { name: "write", callId: "call-1", agent: { session } } as unknown as ToolRunContext;
  clearEncodingState();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("write: the encoding argument on a new file", () => {
  it("creates the file in the named encoding", async () => {
    const text = "你好，世界\r\n第二行\r\n";
    const result = (await run({
      file_path: "new-gbk.txt",
      content: text,
      encoding: "gbk",
    })) as { operation: string };

    expect(result.operation).toBe("create");
    const onDisk = await readFile(join(dir, "new-gbk.txt"));
    expect(onDisk.equals(gbkBytes(text))).toBe(true);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(onDisk)).toThrow();
  });

  it("accepts an alias spelling", async () => {
    // `normalizeEncoding` maps cp936 onto gbk; the tool must resolve aliases the
    // same way `read` does, or the two tools would disagree about what a name
    // means.
    await run({ file_path: "aliased.txt", content: "中文\n", encoding: "cp936" });
    const onDisk = await readFile(join(dir, "aliased.txt"));
    expect(iconv.decode(onDisk, "gbk")).toBe("中文\n");
  });

  it("is case- and punctuation-insensitive", async () => {
    await run({ file_path: "shifty.txt", content: "テスト\n", encoding: "Shift-JIS" });
    const onDisk = await readFile(join(dir, "shifty.txt"));
    expect(iconv.decode(onDisk, "shift_jis")).toBe("テスト\n");
  });

  it("still defaults to UTF-8 without a BOM when omitted", async () => {
    await run({ file_path: "plain.txt", content: "plain\n" });
    const onDisk = await readFile(join(dir, "plain.txt"));
    expect(onDisk[0]).not.toBe(0xef);
    expect(onDisk.toString("utf8")).toBe("plain\n");
  });

  it("rejects an unknown encoding name", async () => {
    await expect(
      run({ file_path: "bad.txt", content: "x\n", encoding: "not-a-real-encoding" }),
    ).rejects.toThrow(/\[E_BAD_ENCODING\]/);
  });

  it("rejects an empty encoding string", async () => {
    await expect(run({ file_path: "bad2.txt", content: "x\n", encoding: "   " })).rejects.toThrow(
      /\[E_BAD_PAYLOAD\]/,
    );
  });

  it("rejects an Object.prototype member as an unknown encoding", async () => {
    // A plain-object alias table makes `ALIASES["constructor"]` a function, so a
    // `=== undefined` check alone accepts it and the value reaches the codec,
    // which reports the interpreter's own source text. It must be rejected as an
    // ordinary unknown name.
    await expect(
      run({ file_path: "ctor.txt", content: "x\n", encoding: "constructor" }),
    ).rejects.toThrow(/\[E_BAD_ENCODING\] Unknown encoding: constructor/);
  });
});

describe("write: the encoding argument on an existing file", () => {
  it("refuses it, naming the file and the reason", async () => {
    await writeFile(join(dir, "exists.txt"), gbkBytes("原有内容\n"));

    await expect(
      run({ file_path: "exists.txt", content: "新内容\n", encoding: "big5" }),
    ).rejects.toThrow(/\[E_ENCODING_NOT_APPLICABLE\]/);
  });

  it("does not tell the caller to delete the file", async () => {
    // The refusal used to recommend "delete the file first if you really mean to
    // recreate it". Following that is destructive in one case and a dead end in
    // the other: an unread file is destroyed with the reply reporting
    // `operation: "create"` / `before: null` (indistinguishable from creating a
    // new file), and a read file leaves the observation policy holding a stale
    // `present`, so every later write fails `FS_STALE_VERSION` and the path can
    // never be recreated in this session. The message must not suggest it.
    await writeFile(join(dir, "nodescribelete.txt"), gbkBytes("原有内容\n"));

    const error = await run({
      file_path: "nodescribelete.txt",
      content: "新内容\n",
      encoding: "big5",
    }).catch((e: unknown) => e as Error);

    const message = (error as Error).message;
    expect(message).toMatch(/\[E_ENCODING_NOT_APPLICABLE\]/);
    expect(message).not.toMatch(/delete the file/i);
    // And it must offer the constructive path instead.
    expect(message).toMatch(/NEW path/i);
  });

  it("leaves the file untouched when it refuses", async () => {
    const original = gbkBytes("原有内容\n");
    await writeFile(join(dir, "untouched.txt"), original);

    await expect(
      run({ file_path: "untouched.txt", content: "新内容\n", encoding: "big5" }),
    ).rejects.toThrow();

    expect((await readFile(join(dir, "untouched.txt"))).equals(original)).toBe(true);
  });

  it("still writes normally when the argument is omitted", async () => {
    // The read-before-write gate applies here, so the session must have read it.
    await writeFile(join(dir, "normal.txt"), gbkBytes("原始\n"));
    const { readFile: pluginRead } = await import("../src/io.js");
    const read = await pluginRead(root, "normal.txt", dir, { exec, encodingHint: "gbk" });

    const result = (await run({
      file_path: "normal.txt",
      content: read.text.replace("原始", "更新"),
    })) as { operation: string };

    expect(result.operation).toBe("update");
    const onDisk = await readFile(join(dir, "normal.txt"));
    expect(iconv.decode(onDisk, "gbk")).toBe("更新\n");
  });
});

describe("write: the diff-baseline read must not answer for the session", () => {
  /**
   * The tool reads the file before writing it, to build the diff card. That read
   * is explicitly presentation-only (`observe: false`), but suppressing the
   * observation event is not enough: if it also STORES the encoding it derived,
   * the session's record becomes a guess, and the write guard — which refuses a
   * file whose encoding the session no longer knows — sees a record and stands
   * down.
   *
   * These tests drive the TOOL, because that is the only layer where the bug
   * lives. A test that calls `pluginWrite` directly passes whether or not the tool
   * passes `recordState: false`, so it cannot catch a regression here; verified by
   * deleting that flag from `tool-write` and watching the direct-call tests stay
   * green while these fail.
   */
  const gbkAmbiguous = Buffer.from([0xd6, 0xb5, 0x0a]);

  it("refuses after an eviction instead of inverting a guess", async () => {
    process.env["DSH_FS_ENCODING_AUTO_GUESS"] = "true";
    try {
      await writeFile(join(dir, "evicted-tool.txt"), gbkAmbiguous);
      const { readFile: pluginRead, sessionKeyFor } = await import("../src/io.js");
      await pluginRead(root, "evicted-tool.txt", dir, { exec, encodingHint: "gbk" });

      // The LRU eviction the guard exists for.
      clearEncodingState(sessionKeyFor(exec));

      await expect(
        run({ file_path: "evicted-tool.txt", content: "新内容\n" }),
      ).rejects.toThrow(/no encoding record/);

      // The bytes must be exactly what they were: this is a refusal, not a
      // silent conversion to UTF-8.
      const onDisk = await readFile(join(dir, "evicted-tool.txt"));
      expect(onDisk.equals(gbkAmbiguous)).toBe(true);
    } finally {
      delete process.env["DSH_FS_ENCODING_AUTO_GUESS"];
    }
  });

  it("leaves no encoding record behind when the diff read runs", async () => {
    // The narrower, direct assertion: after an eviction, a tool write must not
    // leave the session believing a guessed encoding. Without `recordState: false`
    // this records `utf8` (the guess) and the write succeeds.
    process.env["DSH_FS_ENCODING_AUTO_GUESS"] = "true";
    try {
      await writeFile(join(dir, "norecord.txt"), gbkAmbiguous);
      const { readFile: pluginRead, sessionKeyFor } = await import("../src/io.js");
      const { getEncodingState } = await import("../src/encoding-state.js");
      await pluginRead(root, "norecord.txt", dir, { exec, encodingHint: "gbk" });
      clearEncodingState(sessionKeyFor(exec));

      await run({ file_path: "norecord.txt", content: "新内容\n" }).catch(() => undefined);

      // Whatever happened, the session must not have adopted a guess.
      const resolved = await root.fs.resolve(join(dir, "norecord.txt"));
      const recorded = getEncodingState(sessionKeyFor(exec), resolved.targetKey);
      expect(recorded?.encoding).not.toBe("utf8");
    } finally {
      delete process.env["DSH_FS_ENCODING_AUTO_GUESS"];
    }
  });
});

describe("write: an existing file whose encoding the session does not know", () => {
  /**
   * This test file mounts NO observation policy, which `sandbox.ts` documents as
   * the composition where "no policy mounted means an unconditional write". That
   * sentence is now narrower than it reads, and these tests pin the real rule:
   * the encoding record — not the policy — is what authorizes rewriting an
   * EXISTING file. Only a genuinely new file is unconditional.
   *
   * The distinction matters because it is the plugin's whole reason to exist. With
   * no record, `encodeForSave` reads the file as new and encodes UTF-8, so an
   * unguarded write replaces every non-ASCII byte of a legacy file. Measured on
   * HEAD, which had no such refusal: a GBK file written this way came back as
   * `e696b0e58685e5aeb90a` (UTF-8) instead of `d6d0cec4c4dac8dd0a`, and the reply
   * looked like an ordinary successful update.
   */
  it("refuses to rewrite an existing legacy file the session never read", async () => {
    const original = gbkBytes("中文内容\n");
    await writeFile(join(dir, "legacy.txt"), original);

    await expect(run({ file_path: "legacy.txt", content: "新内容\n" })).rejects.toThrow(
      /no encoding record/,
    );

    // The decisive assertion: the bytes are untouched, not silently re-encoded.
    expect((await readFile(join(dir, "legacy.txt"))).equals(original)).toBe(true);
  });

  it("refuses even for a plain UTF-8 file, so the rule does not depend on content", async () => {
    // A UTF-8 file would round-trip harmlessly, so a content-dependent rule could
    // let it through. It must not: the plugin cannot know the file is UTF-8
    // without reading it, and "it happened to be safe this time" is not a rule.
    await writeFile(join(dir, "utf8.txt"), Buffer.from("original\n", "utf8"));

    await expect(run({ file_path: "utf8.txt", content: "replaced\n" })).rejects.toThrow(
      /no encoding record/,
    );
    expect((await readFile(join(dir, "utf8.txt"))).toString("utf8")).toBe("original\n");
  });

  it("still creates a genuinely new file without any read", async () => {
    // The other side: a file that does not exist has no record either, and must
    // stay writable. This is what keeps the rule from making `write` unusable.
    const result = (await run({ file_path: "fresh.txt", content: "brand new\n" })) as {
      operation: string;
    };
    expect(result.operation).toBe("create");
    expect((await readFile(join(dir, "fresh.txt"))).toString("utf8")).toBe("brand new\n");
  });

  it("allows the rewrite once the session has read the file", async () => {
    // And the recovery path the refusal names must actually work.
    const original = gbkBytes("中文内容\n");
    await writeFile(join(dir, "recover2.txt"), original);

    const { readFile: pluginRead } = await import("../src/io.js");
    await pluginRead(root, "recover2.txt", dir, { exec, encodingHint: "gbk" });

    const result = (await run({ file_path: "recover2.txt", content: "新内容\n" })) as {
      operation: string;
    };
    expect(result.operation).toBe("update");
    expect(iconv.decode(await readFile(join(dir, "recover2.txt")), "gbk")).toBe("新内容\n");
  });
});
