/**
 * Regression tests for the migration path.
 *
 * `normalizeToUtf8: true` converts a legacy file to UTF-8 on save. The bug this
 * covers: the session's recorded encoding was left at the PRE-migration value,
 * so the next read in that session decoded the now-UTF-8 bytes as the old code
 * page — an `E_DECODE_FAILED` when a hint was supplied, and mojibake otherwise.
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
import { resetConfigCache } from "../src/config.js";
import { clearEncodingState, encodeForSave, getEncodingState } from "../src/encoding-state.js";
import { readFile as pluginRead, writeFile as pluginWrite } from "../src/io.js";
import { EncodingSandbox } from "../src/sandbox.js";

let dir: string;
/** A throwaway `$DSH_HOME`, so the effective config is the test's, not the developer's. */
let home: string;
let savedHome: string | undefined;
let root: Context;
let sandbox: EncodingSandbox;
let policy: SandboxExecutionPolicy;
let exec: ToolExecution;

const gbkBytes = (s: string) => Buffer.from(iconv.encode(s, "gbk"));

/** Whether these bytes are valid UTF-8. */
function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function keyOfPath(path: string): Promise<string> {
  const target = await root.fs.resolve(path);
  return String((target as unknown as { targetKey: string }).targetKey);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-encoding-migrate-"));
  // Point `$DSH_HOME` at a throwaway directory BEFORE anything reads the config.
  // These tests name `gbk` explicitly and assert on what the config decides
  // (`normalizeToUtf8` gates the whole subject here), so letting the developer's
  // real `$DSH_HOME/plugins/dsh-fs-encoding/config.yaml` participate makes the
  // outcome machine-dependent. Same isolation as `config.test.ts`.
  home = await mkdtemp(join(tmpdir(), "fs-encoding-migrate-home-"));
  savedHome = process.env["DSH_HOME"];
  process.env["DSH_HOME"] = home;
  resetConfigCache();
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
    agent: { session: { id: "migrate-session", header: { cwd: dir } } },
  } as unknown as ToolExecution;
  clearEncodingState();
});

afterEach(async () => {
  delete process.env["DSH_FS_ENCODING_NORMALIZE_TO_UTF8"];
  if (savedHome === undefined) delete process.env["DSH_HOME"];
  else process.env["DSH_HOME"] = savedHome;
  resetConfigCache();
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("encodeForSave reports the encoding it actually used", () => {
  it("reports the recorded encoding when no migration happens", () => {
    const result = encodeForSave("你好", {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    });
    expect(result.encoding).toBe("gbk");
    expect(Buffer.from(result.bytes).equals(gbkBytes("你好"))).toBe(true);
  });

  it("reports utf8 when migration converted a legacy file", () => {
    const result = encodeForSave(
      "你好",
      { encoding: "gbk", hasBOM: false, lineEnding: "\n", version: undefined },
      { normalizeToUtf8: true },
    );
    expect(result.encoding).toBe("utf8");
    expect(Buffer.from(result.bytes).toString("utf8")).toBe("你好");
    expect(isUtf8(Buffer.from(result.bytes))).toBe(true);
  });

  it("leaves a UTF-16 file alone, because it is already Unicode", () => {
    // `normalizeToUtf8` migrates non-Unicode code pages (GBK, Big5, …). UTF-16
    // is Unicode with a different byte order, so converting it would change the
    // file's storage without making it any more "UTF-8" in any meaningful
    // sense — and would silently break a consumer expecting UTF-16.
    const result = encodeForSave(
      "hello",
      { encoding: "utf16le", hasBOM: true, lineEnding: "\n", version: undefined },
      { normalizeToUtf8: true },
    );
    expect(result.encoding).toBe("utf16le");
    expect(result.hasBOM).toBe(true);
    expect([result.bytes[0], result.bytes[1]]).toEqual([0xff, 0xfe]);
  });

  it("keeps the BOM when no migration happens", () => {
    const result = encodeForSave("hello", {
      encoding: "utf8bom",
      hasBOM: true,
      lineEnding: "\n",
      version: undefined,
    });
    expect(result.encoding).toBe("utf8bom");
    expect(result.hasBOM).toBe(true);
    expect([result.bytes[0], result.bytes[1], result.bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("the session's record follows a migration", () => {
  it("updates the record so the next read decodes the migrated bytes correctly", async () => {
    process.env["DSH_FS_ENCODING_NORMALIZE_TO_UTF8"] = "true";
    resetConfigCache();

    const p = join(dir, "gbk.txt");
    const text = "你好，世界\n";
    await writeFile(p, gbkBytes(text));

    const read = await pluginRead(root, "gbk.txt", dir, { exec, encodingHint: "gbk" });
    expect(read.state.encoding).toBe("gbk");

    await pluginWrite(
      root,
      sandbox,
      { target: read.target, content: read.text.replace("世界", "地球"), exec, policy },
      "write",
    );

    // The bytes are now UTF-8.
    const onDisk = await readFile(p);
    expect(isUtf8(onDisk)).toBe(true);
    expect(onDisk.toString("utf8")).toBe("你好，地球\n");

    // The record must say utf8, not the pre-migration gbk.
    const key = await keyOfPath(p);
    expect(getEncodingState("migrate-session", key)?.encoding).toBe("utf8");

    // And a re-read with the OLD hint must not be attempted against UTF-8
    // bytes: the record now says utf8, so no hint is needed at all.
    const reread = await pluginRead(root, "gbk.txt", dir, { exec });
    expect(reread.text).toBe("你好，地球\n");
    expect(reread.state.encoding).toBe("utf8");
  });

  it("does not carry the retired encoding's provenance across a migration", async () => {
    // Migration is the one write where the old provenance must NOT survive: the
    // bytes are UTF-8 now, and a strict UTF-8 validation is a DETERMINATION, so
    // keeping the pre-migration `"hint"`/`"guessed"` would pair `encoding: "utf8"`
    // with a provenance that only described the retired page — reporting a
    // settled fact as a guess, and (for a guess) leaving a footer that names a
    // page the file no longer uses.
    process.env["DSH_FS_ENCODING_NORMALIZE_TO_UTF8"] = "true";
    resetConfigCache();

    const p = join(dir, "gbk.txt");
    await writeFile(p, gbkBytes("你好，世界\n"));

    const read = await pluginRead(root, "gbk.txt", dir, { exec, encodingHint: "gbk" });
    expect(read.state.decided).toBe("hint");

    await pluginWrite(
      root,
      sandbox,
      { target: read.target, content: read.text.replace("世界", "地球"), exec, policy },
      "write",
    );

    const key = await keyOfPath(p);
    const record = getEncodingState("migrate-session", key);
    expect(record?.encoding).toBe("utf8");
    // The determination that actually applies to the bytes now on disk.
    expect(record?.decided).toBe("utf8");
    expect(record?.footer).toBeUndefined();

    // And the next read must report the same thing, not the retired provenance.
    const reread = await pluginRead(root, "gbk.txt", dir, { exec });
    expect(reread.state.decided).toBe("utf8");
  });

  it("keeps the provenance when no migration happens", async () => {
    // The mirror case: an ordinary save of a legacy file leaves the encoding
    // alone, so the provenance must still describe how that encoding was chosen.
    const p = join(dir, "gbk.txt");
    await writeFile(p, gbkBytes("你好，世界\n"));

    const read = await pluginRead(root, "gbk.txt", dir, { exec, encodingHint: "gbk" });
    await pluginWrite(
      root,
      sandbox,
      { target: read.target, content: read.text.replace("世界", "地球"), exec, policy },
      "write",
    );

    const key = await keyOfPath(p);
    expect(getEncodingState("migrate-session", key)?.encoding).toBe("gbk");
    expect(getEncodingState("migrate-session", key)?.decided).toBe("hint");
  });

  it("labels a created file by what actually determined its bytes", async () => {
    // A created file has no read to inherit from, and leaving the provenance
    // blank is not neutral: the next read reuses the memo as an explicit hint,
    // and the hint path reports "hint" — documented as "the CALLER specified
    // this" — for an encoding the plugin chose by itself. So the create path
    // must derive the label instead of omitting it.
    const plain = join(dir, "fresh.txt");
    const plainTarget = await root.fs.resolve(plain);
    await pluginWrite(root, sandbox, { target: plainTarget, content: "new\n", exec, policy }, "write");
    const plainKey = await keyOfPath(plain);
    expect(getEncodingState("migrate-session", plainKey)?.decided).toBe("utf8");
    // And the next read must keep saying so, not drift to "hint".
    const reread = await pluginRead(root, "fresh.txt", dir, { exec });
    expect(reread.state.decided).toBe("utf8");

    // When the caller DID name an encoding, "hint" is the accurate label.
    const named = join(dir, "named.txt");
    const namedTarget = await root.fs.resolve(named);
    await pluginWrite(
      root,
      sandbox,
      { target: namedTarget, content: "你好\n", exec, policy, newFileEncoding: "gbk" },
      "write",
    );
    expect(getEncodingState("migrate-session", await keyOfPath(named))?.decided).toBe("hint");
  });

  it("does not migrate when the option is off", async () => {
    const p = join(dir, "gbk.txt");
    const text = "你好，世界\n";
    await writeFile(p, gbkBytes(text));

    const read = await pluginRead(root, "gbk.txt", dir, { exec, encodingHint: "gbk" });
    await pluginWrite(
      root,
      sandbox,
      { target: read.target, content: read.text.replace("世界", "地球"), exec, policy },
      "write",
    );

    const onDisk = await readFile(p);
    expect(isUtf8(onDisk)).toBe(false);
    expect(iconv.decode(onDisk, "gbk")).toBe("你好，地球\n");

    const key = await keyOfPath(p);
    expect(getEncodingState("migrate-session", key)?.encoding).toBe("gbk");
  });

  it("records utf8 for a file first created in this session", async () => {
    const p = join(dir, "fresh.txt");
    const target = await root.fs.resolve(p);
    await pluginWrite(root, sandbox, { target, content: "new\n", exec, policy }, "write");

    const key = await keyOfPath(p);
    expect(getEncodingState("migrate-session", key)?.encoding).toBe("utf8");
    const onDisk = await readFile(p);
    expect(onDisk[0]).not.toBe(0xef);
    expect(onDisk.toString("utf8")).toBe("new\n");
  });
});
