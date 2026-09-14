/**
 * End-to-end tests over the REAL harness services.
 *
 * These mount `SandboxedFileSystem` and `dsh-fs-observation-policy` exactly as
 * the web profile does, then drive the plugin's `readFile` / `writeFile`
 * orchestration. Unit tests prove the encoding math; these prove the
 * integration: that the sandbox fence, the version guard, and the observation
 * events all still line up when the plugin publishes bytes itself.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import * as observationPolicy from "@deepseek-ai/dsh-fs-observation-policy";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { clearEncodingState, DecodeError, UnmappableError } from "../src/encoding-state.js";
import { readFile as pluginRead, writeFile as pluginWrite } from "../src/io.js";
import { EncodingSandbox } from "../src/sandbox.js";

let dir: string;
let root: Context;
let sandbox: EncodingSandbox;
let exec: ToolExecution;
let policy: SandboxExecutionPolicy;

const utf8 = (s: string) => Buffer.from(s, "utf8");
const gbkBytes = (s: string) => Buffer.from(iconv.encode(s, "gbk"));

/** A minimal execution stand-in carrying the session the policy keys by. */
function makeExec(cwd: string): ToolExecution {
  const session = { id: `sess-${Math.random().toString(36).slice(2)}`, header: { cwd } };
  return { name: "read", callId: "call-1", agent: { session } } as unknown as ToolExecution;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-encoding-e2e-"));
  root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: dir }),
  });
  // Mount the REAL backend and the REAL observation policy.
  new SandboxedFileSystem(root, { cwd: dir, diffBasisMaxBytes: 10 * 1024 * 1024 });
  observationPolicy.apply(root);
  sandbox = new EncodingSandbox(root);
  exec = makeExec(dir);
  policy = { mode: "workspace-write", workspaceRoot: dir };
  clearEncodingState();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("read through the real ctx.fs", () => {
  it("reads a GBK file via an explicit encoding hint", async () => {
    const text = "你好，世界\n第二行：中文内容\n";
    await writeFile(join(dir, "gbk.txt"), gbkBytes(text));

    const outcome = await pluginRead(root, "gbk.txt", dir, { exec, encodingHint: "gbk" });
    expect(outcome.text).toBe(text);
    expect(outcome.state.encoding).toBe("gbk");
    expect(outcome.state.hasBOM).toBe(false);
  });

  it("fails loud on a GBK file without a hint, listing candidates", async () => {
    await writeFile(join(dir, "gbk.txt"), gbkBytes("你好，世界，这是中文测试内容"));
    await expect(pluginRead(root, "gbk.txt", dir, { exec })).rejects.toThrow(DecodeError);
  });

  it("reads a UTF-8 BOM file and records hasBOM", async () => {
    await writeFile(
      join(dir, "bom.txt"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8("hello\n")]),
    );

    const outcome = await pluginRead(root, "bom.txt", dir, { exec });
    expect(outcome.text).toBe("hello\n");
    expect(outcome.state.hasBOM).toBe(true);
    expect(outcome.state.encoding).toBe("utf8bom");
  });

  it("reports a missing file without leaking a raw FsError", async () => {
    await expect(pluginRead(root, "nope.txt", dir, { exec })).rejects.toThrow(/no such file/);
  });
});

describe("write through the real ctx.fs — the encoding round-trip", () => {
  it("edits a GBK file and leaves it GBK (the bug this plugin exists to fix)", async () => {
    const p = join(dir, "gbk.txt");
    const original = "你好，世界\n第二行：中文内容\n";
    await writeFile(p, gbkBytes(original));

    const read = await pluginRead(root, "gbk.txt", dir, { exec, encodingHint: "gbk" });
    const edited = read.text.replace("世界", "地球");
    await pluginWrite(root, sandbox, { target: read.target, content: edited, exec, policy }, "write");

    const onDisk = await readFile(p);
    expect(onDisk.equals(gbkBytes(edited))).toBe(true);
    // The decisive assertion: the file must NOT be valid UTF-8.
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(onDisk)).toThrow();
    expect(iconv.decode(onDisk, "gbk")).toBe(edited);
  });

  it("preserves a UTF-8 BOM across an edit", async () => {
    const p = join(dir, "bom.txt");
    await writeFile(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8("hello bom\n")]));

    const read = await pluginRead(root, "bom.txt", dir, { exec });
    await pluginWrite(
      root,
      sandbox,
      { target: read.target, content: read.text.replace("bom", "BOM"), exec, policy },
      "write",
    );

    const onDisk = await readFile(p);
    expect([onDisk[0], onDisk[1], onDisk[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(onDisk.subarray(3).toString("utf8")).toBe("hello BOM\n");
  });

  it("preserves CRLF across an edit", async () => {
    const p = join(dir, "crlf.txt");
    await writeFile(p, utf8("line one\r\nline two\r\n"));

    const read = await pluginRead(root, "crlf.txt", dir, { exec });
    expect(read.state.lineEnding).toBe("\r\n");
    await pluginWrite(
      root,
      sandbox,
      { target: read.target, content: read.text.replace("one", "ONE"), exec, policy },
      "write",
    );

    expect((await readFile(p)).toString("utf8")).toBe("line ONE\r\nline two\r\n");
  });

  it("writes a brand-new file as UTF-8 without a BOM", async () => {
    const p = join(dir, "fresh.txt");
    const target = await root.fs.resolve(p);
    await pluginWrite(root, sandbox, { target, content: "brand new\n", exec, policy }, "write");

    const onDisk = await readFile(p);
    expect(onDisk[0]).not.toBe(0xef);
    expect(onDisk.toString("utf8")).toBe("brand new\n");
  });

  it("preserves a UTF-16LE file byte-exactly", async () => {
    const p = join(dir, "u16.txt");
    const text = "hello 世界\n";
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    await writeFile(p, original);

    const read = await pluginRead(root, "u16.txt", dir, { exec });
    expect(read.text).toBe(text);
    await pluginWrite(root, sandbox, { target: read.target, content: text, exec, policy }, "write");

    expect((await readFile(p)).equals(original)).toBe(true);
  });

  it("refuses a write the encoding cannot represent, leaving the file intact", async () => {
    const p = join(dir, "gbk.txt");
    const original = "你好，世界\n";
    await writeFile(p, gbkBytes(original));

    const read = await pluginRead(root, "gbk.txt", dir, { exec, encodingHint: "gbk" });
    await expect(
      pluginWrite(
        root,
        sandbox,
        { target: read.target, content: `${read.text}emoji 🎉\n`, exec, policy },
        "write",
      ),
    ).rejects.toThrow(UnmappableError);

    // The file must be untouched.
    expect((await readFile(p)).equals(gbkBytes(original))).toBe(true);
  });

  it("round-trips a file read, edited, and written three times in a row", async () => {
    const p = join(dir, "repeat.txt");
    const original = "第一行\n第二行\n第三行\n";
    await writeFile(p, gbkBytes(original));

    let text = original;
    const words = ["一", "二", "三"];
    for (let i = 0; i < 3; i += 1) {
      const read = await pluginRead(root, "repeat.txt", dir, { exec, encodingHint: "gbk" });
      text = read.text.replace(`第${words[i]}行`, `第${words[i]}行(改)`);
      await pluginWrite(root, sandbox, { target: read.target, content: text, exec, policy }, "write");
    }

    const onDisk = await readFile(p);
    expect(iconv.decode(onDisk, "gbk")).toBe(text);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(onDisk)).toThrow();
  });
});

describe("the fs event gate still lines up with the built-ins", () => {
  it("a plugin write is observed, so the next built-in write succeeds", async () => {
    const p = join(dir, "handoff.txt");
    await writeFile(p, utf8("first\n"));

    const read = await pluginRead(root, "handoff.txt", dir, { exec });
    await pluginWrite(
      root,
      sandbox,
      { target: read.target, content: "plugin wrote this\n", exec, policy },
      "write",
    );

    // Without the plugin's fs/observed emission this would throw
    // FS_STALE_VERSION: the policy's recorded version would still be the one
    // from before the plugin's write.
    const fresh = await root.fs.resolve(p);
    const intent = await root.waterfall("fs/write-intent", fresh, exec, () => undefined);
    const outcome = await root.fs.writeText(fresh, "built-in after plugin\n", intent, undefined, policy);
    expect(outcome.operation).toBe("update");
    expect((await readFile(p)).toString("utf8")).toBe("built-in after plugin\n");
  });

  it("a stale write is rejected rather than clobbering an external change", async () => {
    const p = join(dir, "stale.txt");
    await writeFile(p, utf8("original\n"));

    // A model-facing read arms the gate (readFile emits fs/observed itself).
    const read = await pluginRead(root, "stale.txt", dir, { exec });

    // Someone else changes the file after our read.
    await writeFile(p, utf8("changed externally\n"));

    await expect(
      pluginWrite(root, sandbox, { target: read.target, content: "our edit\n", exec, policy }, "write"),
    ).rejects.toThrow(/changed since it was read/);

    expect((await readFile(p)).toString("utf8")).toBe("changed externally\n");
  });

  it("refuses to overwrite an existing file this session never read", async () => {
    const p = join(dir, "unread.txt");
    await writeFile(p, utf8("someone else's work\n"));

    const strangerExec = makeExec(dir);
    const target = await root.fs.resolve(p);

    await expect(
      pluginWrite(root, sandbox, { target, content: "clobbered\n", exec: strangerExec, policy }, "write"),
    ).rejects.toThrow(/without reading it first/);

    expect((await readFile(p)).toString("utf8")).toBe("someone else's work\n");
  });

  it("a presentation-only read does not arm the gate", async () => {
    const p = join(dir, "diffonly.txt");
    await writeFile(p, utf8("original\n"));

    // observe:false is what the write tool uses to build a diff card. It must
    // not count as the model having read the file.
    await pluginRead(root, "diffonly.txt", dir, { exec, observe: false });

    const target = await root.fs.resolve(p);
    await expect(
      pluginWrite(root, sandbox, { target, content: "blind\n", exec, policy }, "write"),
    ).rejects.toThrow(/without reading it first/);
  });
});

describe("the sandbox fence", () => {
  it("refuses a read-only write", async () => {
    const p = join(dir, "ro.txt");
    await writeFile(p, utf8("x\n"));
    const target = await root.fs.resolve(p);
    const roPolicy: SandboxExecutionPolicy = { mode: "read-only", workspaceRoot: dir };

    await expect(
      pluginWrite(root, sandbox, { target, content: "y\n", exec, policy: roPolicy }, "write"),
    ).rejects.toThrow(/read-only/);
    expect((await readFile(p)).toString("utf8")).toBe("x\n");
  });

  it("refuses a write outside the workspace root", async () => {
    // Must be a path that is NOT inside a system temp area: `writableRoots`
    // deliberately includes the platform temp dirs, so a tmpdir-based "outside"
    // would be writable by design.
    const outside = process.platform === "win32" ? "C:\\Windows\\Temp" : "/var/tmp";
    const p = join(outside, `dsh-fs-encoding-probe-${Date.now()}.txt`);
    const target = await root.fs.resolve(p);
    await expect(
      pluginWrite(root, sandbox, { target, content: "x\n", exec, policy }, "write"),
    ).rejects.toThrow(/workspace-write/);
  });

  it("allows a write inside the workspace root", async () => {
    const p = join(dir, "inside.txt");
    const target = await root.fs.resolve(p);
    await pluginWrite(root, sandbox, { target, content: "ok\n", exec, policy }, "write");
    expect((await readFile(p)).toString("utf8")).toBe("ok\n");
  });
});
