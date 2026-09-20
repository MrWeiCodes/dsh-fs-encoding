/**
 * `undo_last_edit` — reverting the last edit, content AND encoding.
 *
 * The encoding half is the part worth pinning down. An undo that restores the
 * old characters while leaving the file in a different encoding produces a file
 * that never existed, and the case that does it is not exotic: with
 * `normalizeToUtf8` on, every save of a legacy file migrates it to UTF-8, so
 * "revert that edit" means "go back to GBK". A content-only undo leaves the file
 * as UTF-8 and reports success.
 *
 * The other half is the safety guard: the undo compares the file against what
 * the edit WROTE before reverting, so a file changed since is refused rather
 * than silently overwritten. Both halves are asserted here, along with the
 * bound that keeps whole-file history from growing without limit.
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
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { resetConfigCache } from "../src/config.js";
import { clearEncodingState, getEncodingState } from "../src/encoding-state.js";
import { readFile as pluginRead } from "../src/io.js";
import { EncodingSandbox } from "../src/sandbox.js";
import { buildEditTool } from "../src/tool-edit.js";
import { buildInsertTool } from "../src/tool-insert.js";
import { buildUndoTool } from "../src/tool-undo.js";
import { buildWriteTool } from "../src/tool-write.js";
import {
  clearSessionUndo,
  clearUndoFor,
  getUndo,
  recordUndo,
  resetUndoState,
  undoByteCount,
  undoRecordCount,
} from "../src/undo-state.js";

let dir: string;
/** A throwaway `$DSH_HOME`, so the effective config is the test's, not the developer's. */
let home: string;
let savedHome: string | undefined;
let root: Context;
let sandbox: EncodingSandbox;
/**
 * `ToolRunContext`, not the narrower `ToolExecution`: `execute` receives the run
 * context, and typing it as the execution would make every call site a type
 * error while the runtime worked fine. Same convention as the other tool tests.
 */
let exec: ToolRunContext;

const SESSION = "undo-session";
const gbkBytes = (s: string) => Buffer.from(iconv.encode(s, "gbk"));

/** The four tools that write, plus the one that reverts. */
function tools() {
  return {
    edit: buildEditTool(root, sandbox),
    insert: buildInsertTool(root, sandbox),
    write: buildWriteTool(root, sandbox),
    undo: buildUndoTool(root, sandbox),
  };
}

/** Run one tool call and return its result value. */
async function run(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await tool.execute(args, exec)) as Record<string, unknown>;
}

async function keyOfPath(path: string): Promise<string> {
  const target = await root.fs.resolve(path, { cwd: dir });
  return String((target as unknown as { targetKey: string }).targetKey);
}

/** Bytes on disk, for the byte-exact assertions this plugin is built around. */
async function onDisk(name: string): Promise<Buffer> {
  return readFile(join(dir, name));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-encoding-undo-"));
  home = await mkdtemp(join(tmpdir(), "fs-encoding-undo-home-"));
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
  exec = {
    name: "read",
    callId: "c1",
    agent: { session: { id: SESSION, header: { cwd: dir } } },
  } as unknown as ToolRunContext;
  clearEncodingState();
  resetUndoState();
});

afterEach(async () => {
  delete process.env["DSH_FS_ENCODING_NORMALIZE_TO_UTF8"];
  if (savedHome === undefined) delete process.env["DSH_HOME"];
  else process.env["DSH_HOME"] = savedHome;
  resetConfigCache();
  clearEncodingState();
  resetUndoState();
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("the encoding is restored, not just the content", () => {
  it("returns a migrated GBK file to GBK bytes", async () => {
    // The case a content-only undo gets wrong. `normalizeToUtf8` converts the
    // file on save, so after the edit the session's record says `utf8` while the
    // file the undo must restore was GBK. Reading the record at undo time — or
    // re-applying the migration — would leave the file as UTF-8 and call it a
    // revert.
    process.env["DSH_FS_ENCODING_NORMALIZE_TO_UTF8"] = "true";
    resetConfigCache();

    const original = "你好，世界\n";
    await writeFile(join(dir, "m.txt"), gbkBytes(original));
    await pluginRead(root, "m.txt", dir, { exec, encodingHint: "gbk" });

    const t = tools();
    await run(t.edit, { file_path: "m.txt", old_string: "世界", new_string: "地球" });

    // The migration really happened, or this test would prove nothing.
    const migrated = await onDisk("m.txt");
    expect(migrated.toString("utf8")).toContain("地球");
    expect(migrated.equals(gbkBytes("你好，地球\n"))).toBe(false);

    const result = await run(t.undo, { file_path: "m.txt" });
    expect(result["note"]).toContain("Reverted");

    const after = await onDisk("m.txt");
    expect(after.equals(gbkBytes(original)), "the file must be GBK again").toBe(true);
    // And the session's record must agree with the bytes, or the NEXT save would
    // encode as UTF-8 and undo the undo.
    const key = await keyOfPath("m.txt");
    expect(getEncodingState(SESSION, key)?.encoding).toBe("gbk");
  });

  it("returns a migrated file to GBK on a plain write too", async () => {
    // `write` overwrites rather than edits, and must be just as undoable.
    process.env["DSH_FS_ENCODING_NORMALIZE_TO_UTF8"] = "true";
    resetConfigCache();

    const original = "你好，世界\n";
    await writeFile(join(dir, "w.txt"), gbkBytes(original));
    await pluginRead(root, "w.txt", dir, { exec, encodingHint: "gbk" });

    const t = tools();
    await run(t.write, { file_path: "w.txt", content: "替换内容\n" });
    await run(t.undo, { file_path: "w.txt" });

    const after = await onDisk("w.txt");
    expect(after.equals(gbkBytes(original)), "a write must be undoable too").toBe(true);
  });

  it("keeps the encoding when no migration is configured", async () => {
    const original = "你好，世界\n";
    await writeFile(join(dir, "k.txt"), gbkBytes(original));
    await pluginRead(root, "k.txt", dir, { exec, encodingHint: "gbk" });

    const t = tools();
    await run(t.edit, { file_path: "k.txt", old_string: "世界", new_string: "地球" });
    expect((await onDisk("k.txt")).equals(gbkBytes(original))).toBe(false);

    await run(t.undo, { file_path: "k.txt" });
    expect((await onDisk("k.txt")).equals(gbkBytes(original))).toBe(true);
  });

  it("restores a UTF-8 BOM", async () => {
    // The BOM is a byte the file had; losing it is the original defect this
    // plugin exists to fix, so an undo must not reintroduce it.
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const original = Buffer.concat([bom, Buffer.from("hello\n", "utf8")]);
    await writeFile(join(dir, "b.txt"), original);

    const t = tools();
    await run(t.edit, { file_path: "b.txt", old_string: "hello", new_string: "goodbye" });
    expect((await onDisk("b.txt")).subarray(0, 3).equals(bom)).toBe(true);

    await run(t.undo, { file_path: "b.txt" });
    const after = await onDisk("b.txt");
    expect(after.equals(original), "the BOM must survive the round trip").toBe(true);
  });

  it("restores CRLF line endings", async () => {
    const original = "a\r\nb\r\n";
    await writeFile(join(dir, "c.txt"), original, "utf8");

    const t = tools();
    await run(t.edit, { file_path: "c.txt", old_string: "b", new_string: "B" });
    expect((await onDisk("c.txt")).toString("utf8")).toBe("a\r\nB\r\n");

    await run(t.undo, { file_path: "c.txt" });
    expect((await onDisk("c.txt")).toString("utf8"), "CRLF must come back").toBe(original);
  });

  it("restores UTF-16LE byte-for-byte", async () => {
    const text = "hello\nworld\n";
    const original = Buffer.from(text, "utf16le");
    // A UTF-16LE BOM so the file is admitted without a hint.
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), original]);
    await writeFile(join(dir, "u16.txt"), withBom);

    const t = tools();
    await run(t.edit, { file_path: "u16.txt", old_string: "world", new_string: "there" });
    await run(t.undo, { file_path: "u16.txt" });

    expect((await onDisk("u16.txt")).equals(withBom)).toBe(true);
  });
});

describe("every writing tool leaves an undo point", () => {
  it("reverts an edit", async () => {
    await writeFile(join(dir, "a.txt"), "one\ntwo\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "a.txt", old_string: "two", new_string: "2" });
    const result = await run(t.undo, { file_path: "a.txt" });
    expect(result["note"]).toContain("Reverted");
    expect((await onDisk("a.txt")).toString("utf8")).toBe("one\ntwo\n");
  });

  it("reverts an insert", async () => {
    await writeFile(join(dir, "i.txt"), "one\ntwo\n", "utf8");
    const t = tools();
    await run(t.insert, { file_path: "i.txt", insert_line: 0, new_string: "zero" });
    expect((await onDisk("i.txt")).toString("utf8")).toBe("zero\none\ntwo\n");
    await run(t.undo, { file_path: "i.txt" });
    expect((await onDisk("i.txt")).toString("utf8")).toBe("one\ntwo\n");
  });

  it("reverts a whole-file write", async () => {
    await writeFile(join(dir, "w2.txt"), "original\n", "utf8");
    // Read first: `write` on an existing file this session never read is refused
    // by the plugin's own guard, which is what stops a blind overwrite from
    // re-encoding the file as UTF-8. That guard is not what this test is about.
    await pluginRead(root, "w2.txt", dir, { exec });
    const t = tools();
    await run(t.write, { file_path: "w2.txt", content: "replaced\n" });
    await run(t.undo, { file_path: "w2.txt" });
    expect((await onDisk("w2.txt")).toString("utf8")).toBe("original\n");
  });

  it("keeps only the LAST edit undoable", async () => {
    // One record per file, not a stack: the tool is `undo_last_edit`, so the
    // second edit replaces the first's history rather than stacking on it.
    await writeFile(join(dir, "s.txt"), "v1\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "s.txt", old_string: "v1", new_string: "v2" });
    await run(t.edit, { file_path: "s.txt", old_string: "v2", new_string: "v3" });
    await run(t.undo, { file_path: "s.txt" });
    expect((await onDisk("s.txt")).toString("utf8"), "back to v2, not v1").toBe("v2\n");
  });

  it("has nothing to undo after the history is spent", async () => {
    await writeFile(join(dir, "once.txt"), "v1\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "once.txt", old_string: "v1", new_string: "v2" });
    await run(t.undo, { file_path: "once.txt" });
    // Undoing an undo would be a redo, which this tool does not offer.
    const second = await run(t.undo, { file_path: "once.txt" });
    expect(second["note"]).toContain("No undo history");
    expect((await onDisk("once.txt")).toString("utf8")).toBe("v1\n");
  });

  it("does not make a created file undoable", async () => {
    // "Undo a creation" means deleting the file: destructive, and something the
    // model can already do deliberately. Excluded on purpose.
    const t = tools();
    await run(t.write, { file_path: "fresh.txt", content: "new\n" });
    const result = await run(t.undo, { file_path: "fresh.txt" });
    expect(result["note"]).toContain("No undo history");
    expect((await onDisk("fresh.txt")).toString("utf8")).toBe("new\n");
  });

  it("reports no history for a file nothing edited", async () => {
    await writeFile(join(dir, "untouched.txt"), "x\n", "utf8");
    const t = tools();
    const result = await run(t.undo, { file_path: "untouched.txt" });
    expect(result["note"]).toContain("No undo history");
  });
});

describe("a stale undo is refused, not forced", () => {
  it("refuses when the file changed after the edit", async () => {
    await writeFile(join(dir, "stale.txt"), "v1\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "stale.txt", old_string: "v1", new_string: "v2" });
    // Someone else — the user, another tool — edits the file.
    await writeFile(join(dir, "stale.txt"), "someone else\n", "utf8");

    const result = await run(t.undo, { file_path: "stale.txt" });
    expect(result["note"]).toContain("E_UNDO_STALE");
    expect(result["undone"]).toBe(false);
    // The other change must survive untouched.
    expect((await onDisk("stale.txt")).toString("utf8")).toBe("someone else\n");
  });

  it("discards the history when it refuses, so the refusal is not repeated", async () => {
    await writeFile(join(dir, "spent.txt"), "v1\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "spent.txt", old_string: "v1", new_string: "v2" });
    await writeFile(join(dir, "spent.txt"), "other\n", "utf8");

    const first = await run(t.undo, { file_path: "spent.txt" });
    expect(first["note"]).toContain("E_UNDO_STALE");
    // The record is gone: the second call answers "no history", not "stale"
    // again. That distinction is what proves the record was cleared.
    const second = await run(t.undo, { file_path: "spent.txt" });
    expect(second["note"]).toContain("No undo history");
  });

  it("refuses when the file was deleted after the edit", async () => {
    await writeFile(join(dir, "gone.txt"), "v1\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "gone.txt", old_string: "v1", new_string: "v2" });
    await rm(join(dir, "gone.txt"));

    const result = await run(t.undo, { file_path: "gone.txt" });
    expect(result["undone"]).toBe(false);
    // Not recreated: the undo has nothing to revert TO on disk, and inventing
    // the file back would resurrect something the caller deleted on purpose.
    await expect(onDisk("gone.txt")).rejects.toThrow();
  });
});

describe("the result satisfies the tool's own output schema", () => {
  it("returns only declared properties on every path", async () => {
    // The registry validates a tool's value against its declared schema and
    // rejects the whole call when anything is undeclared
    // (`additionalProperties: false`). Undeclared fields therefore do not make
    // the reply slightly wrong — they make EVERY call fail with
    // `INVALID_TOOL_OUTPUT`, *after* the write has already landed, so the model
    // sees an error, believes the undo did not happen, and retries into "no undo
    // history". Asserting the schema here is what pins that contract; the other
    // tests in this file call `execute` directly and would not notice.
    await writeFile(join(dir, "shape.txt"), "v1\n", "utf8");
    const t = tools();
    const edit = t.edit;
    const undo = t.undo;

    // A successful revert.
    await run(edit, { file_path: "shape.txt", old_string: "v1", new_string: "v2" });
    const reverted = await run(undo, { file_path: "shape.txt" });
    expect(validateJsonSchemaValue(undo.output.schema, reverted, "value")).toEqual([]);

    // The "no history" answer, which is a success rather than a failure.
    const noHistory = await run(undo, { file_path: "shape.txt" });
    expect(noHistory["note"]).toContain("No undo history");
    expect(validateJsonSchemaValue(undo.output.schema, noHistory, "value")).toEqual([]);

    // The stale refusal.
    await writeFile(join(dir, "shape2.txt"), "v1\n", "utf8");
    await run(edit, { file_path: "shape2.txt", old_string: "v1", new_string: "v2" });
    await writeFile(join(dir, "shape2.txt"), "other\n", "utf8");
    const stale = await run(undo, { file_path: "shape2.txt" });
    expect(stale["note"]).toContain("E_UNDO_STALE");
    expect(validateJsonSchemaValue(undo.output.schema, stale, "value")).toEqual([]);
  });
});

describe("a byte-level change is refused even when the text matches", () => {
  it("refuses when only the line endings changed", async () => {
    // The text comparison runs on LF-normalized content, so a CRLF-to-LF
    // conversion compares EQUAL to the record while being a real edit by someone
    // else. Reverting over it would silently discard that change, which is
    // exactly what the "a changed file is refused" promise rules out. The
    // version the edit produced is the only handle on it.
    await writeFile(join(dir, "eol.txt"), "a\r\nb\r\n", "utf8");
    await pluginRead(root, "eol.txt", dir, { exec });
    const t = tools();

    await run(t.edit, { file_path: "eol.txt", old_string: "b", new_string: "B" });
    // Someone else converts the endings; the normalized text is unchanged.
    await writeFile(join(dir, "eol.txt"), "a\nB\n", "utf8");

    const result = await run(t.undo, { file_path: "eol.txt" });
    expect(result["note"]).toContain("E_UNDO_STALE");
    expect(result["undone"]).toBe(false);
    // The other change survives untouched.
    expect((await onDisk("eol.txt")).toString("utf8")).toBe("a\nB\n");
  });

  it("refuses when only the BOM changed", async () => {
    await writeFile(join(dir, "bom.txt"), "hello\n", "utf8");
    await pluginRead(root, "bom.txt", dir, { exec });
    const t = tools();

    await run(t.edit, { file_path: "bom.txt", old_string: "hello", new_string: "goodbye" });
    // Someone else adds a UTF-8 BOM; the decoded text is unchanged.
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(join(dir, "bom.txt"), Buffer.concat([bom, Buffer.from("goodbye\n", "utf8")]));

    const result = await run(t.undo, { file_path: "bom.txt" });
    expect(result["undone"]).toBe(false);
    // The BOM is still there: the undo did not silently drop it.
    expect((await onDisk("bom.txt")).subarray(0, 3).equals(bom)).toBe(true);
  });
});

describe("the sandbox fence applies to an undo", () => {
  it("refuses an undo the policy denies, leaving the file untouched", async () => {
    await writeFile(join(dir, "fenced.txt"), "v1\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "fenced.txt", old_string: "v1", new_string: "v2" });

    // A read-only policy: the fence must stop the revert exactly as it stops any
    // other write. An undo is a write, not a privileged escape hatch.
    //
    // Subclassed rather than spread: `{ ...sandbox }` copies own properties and
    // drops the prototype, so `schemaFields` would be missing — a test artifact
    // that would look like a product bug.
    class ReadOnly extends EncodingSandbox {
      override async resolvePolicy(): Promise<SandboxExecutionPolicy> {
        return { mode: "read-only", workspaceRoot: dir };
      }
    }
    const undo = buildUndoTool(root, new ReadOnly(root));
    await expect(undo.execute({ file_path: "fenced.txt" } as never, exec)).rejects.toThrow(
      /denied|read-only/i,
    );
    expect((await onDisk("fenced.txt")).toString("utf8"), "unchanged").toBe("v2\n");
  });
});

describe("the history is bounded and per-session", () => {
  it("drops the oldest record when the byte budget is exceeded", async () => {
    // Whole files are held, so the bound that matters is bytes rather than
    // entries. A count-only bound would let a session retain
    // 4096 x maxFileBytes.
    const big = "x".repeat(20 * 1024 * 1024);
    const first = await root.fs.resolve(join(dir, "big1.txt"), { cwd: dir });
    const second = await root.fs.resolve(join(dir, "big2.txt"), { cwd: dir });
    const state = { encoding: "utf8", hasBOM: false, lineEnding: "\n" as const, version: undefined };

    recordUndo(SESSION, String((first as never as { targetKey: string }).targetKey), {
      previousText: big,
      nextText: "a",
      previousState: state,
      nextVersion: undefined,
      nextEncoding: "utf8",
      mode: "edit",
    });
    recordUndo(SESSION, String((second as never as { targetKey: string }).targetKey), {
      previousText: big,
      nextText: "b",
      previousState: state,
      nextVersion: undefined,
      nextEncoding: "utf8",
      mode: "edit",
    });

    // Two 20 MiB records exceed the 32 MiB budget, so the first is evicted and
    // the second — the most recent, the one `undo_last_edit` can reach — stays.
    expect(undoRecordCount()).toBe(1);
    expect(undoByteCount()).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it("does not record a single file larger than the whole budget", async () => {
    // Keeping it would evict every other file's history to hold one file's, and
    // the honest outcome is "this edit cannot be undone".
    const huge = "x".repeat(33 * 1024 * 1024);
    const target = await root.fs.resolve(join(dir, "huge.txt"), { cwd: dir });
    recordUndo(SESSION, String((target as never as { targetKey: string }).targetKey), {
      previousText: huge,
      nextText: "a",
      previousState: {
        encoding: "utf8",
        hasBOM: false,
        lineEnding: "\n",
        version: undefined,
      },
      nextVersion: undefined,
      nextEncoding: "utf8",
      mode: "edit",
    });
    expect(undoRecordCount()).toBe(0);
  });

  it("keeps two sessions' histories apart", async () => {
    await writeFile(join(dir, "s1.txt"), "v1\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "s1.txt", old_string: "v1", new_string: "v2" });

    // A different session must not be able to revert this one's edit: the
    // histories are keyed per session, like the encoding records.
    const other = {
      name: "read",
      callId: "c2",
      agent: { session: { id: "other-session", header: { cwd: dir } } },
    } as unknown as ToolRunContext;
    const undo = buildUndoTool(root, sandbox);
    const result = (await undo.execute({ file_path: "s1.txt" }, other)) as {
      note: string;
    };
    expect(result.note).toContain("No undo history");
    expect((await onDisk("s1.txt")).toString("utf8")).toBe("v2\n");
  });

  it("releases a session's history on disposal", async () => {
    await writeFile(join(dir, "d.txt"), "v1\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "d.txt", old_string: "v1", new_string: "v2" });
    expect(undoRecordCount()).toBe(1);

    clearSessionUndo(SESSION);
    expect(undoRecordCount()).toBe(0);
  });

  it("holds the whole process to a global budget, not just each session", async () => {
    // A per-session bound does not bound the process: 64 sessions x 32 MiB is
    // 2 GiB of retained text. Each subagent is its own session, so the sessions
    // accumulate in ordinary use. The global budget is what actually protects
    // the process, and it evicts across sessions — the oldest record first.
    const state = { encoding: "utf8", hasBOM: false, lineEnding: "\n" as const, version: undefined };
    // 5 MiB per string x 2 = 10 MiB per record: under the 32 MiB per-session cap,
    // so nothing is refused for being too large and only the global budget bites.
    const chunk = "x".repeat(5 * 1024 * 1024);
    for (let i = 0; i < 12; i += 1) {
      recordUndo(`budget-session-${i}`, `key-${i}`, {
        previousText: chunk,
        nextText: chunk,
        previousState: state,
        nextVersion: undefined,
        nextEncoding: "utf8",
        mode: "edit",
      });
    }

    // 12 x 10 MiB was offered (120 MiB). The global budget must have evicted
    // some of it, and what remains must be whole records — a partial drop would
    // mean the counter had drifted from the content it describes.
    expect(undoByteCount()).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(undoByteCount()).toBeLessThan(120 * 1024 * 1024);
    expect(undoByteCount() % (10 * 1024 * 1024)).toBe(0);
  });

  it("undoes a legacy file whose session encoding record was evicted", async () => {
    // The record carries the encoding the edit WROTE, and the undo's comparison
    // read uses it as a hint. Without that hint the read cannot admit a legacy
    // file at all once the session's encoding memo is gone (guessing is off by
    // default), so the undo would fail `E_NOT_TEXT` on a file it is perfectly
    // able to restore — the very case `previousState` exists to survive.
    const original = "你好，世界\n";
    await writeFile(join(dir, "evicted.txt"), gbkBytes(original));
    await pluginRead(root, "evicted.txt", dir, { exec, encodingHint: "gbk" });

    const t = tools();
    await run(t.edit, { file_path: "evicted.txt", old_string: "世界", new_string: "地球" });
    // Evict every encoding record, as MAX_SESSIONS would on a busy process.
    clearEncodingState();

    const result = await run(t.undo, { file_path: "evicted.txt" });
    expect(result["undone"]).toBe(true);
    expect((await onDisk("evicted.txt")).equals(gbkBytes(original))).toBe(true);
  });

  it("undoes a MIGRATED file whose session encoding record was evicted", async () => {
    // The harder half: the edit migrated the file to UTF-8, so the encoding on
    // disk is NOT the one in `previousState`. Hinting the comparison read with
    // `previousState`'s encoding would decode UTF-8 bytes as GBK and turn a
    // working undo into a false stale refusal.
    process.env["DSH_FS_ENCODING_NORMALIZE_TO_UTF8"] = "true";
    resetConfigCache();

    const original = "你好，世界\n";
    await writeFile(join(dir, "mig-evicted.txt"), gbkBytes(original));
    await pluginRead(root, "mig-evicted.txt", dir, { exec, encodingHint: "gbk" });

    const t = tools();
    await run(t.edit, { file_path: "mig-evicted.txt", old_string: "世界", new_string: "地球" });
    // The migration really happened, or this test proves nothing.
    expect((await onDisk("mig-evicted.txt")).equals(gbkBytes(original))).toBe(false);

    clearEncodingState();

    const result = await run(t.undo, { file_path: "mig-evicted.txt" });
    expect(result["undone"]).toBe(true);
    expect((await onDisk("mig-evicted.txt")).equals(gbkBytes(original))).toBe(true);
  });

  it("keeps the global byte count exact across clears and disposal", async () => {
    // The counter is the budget's only input, so a drift here would either leak
    // memory silently or evict records that should have stayed.
    await writeFile(join(dir, "acc.txt"), "v1\n", "utf8");
    const t = tools();
    await run(t.edit, { file_path: "acc.txt", old_string: "v1", new_string: "v2" });
    expect(undoByteCount()).toBe(6); // "v1\n" + "v2\n", the record's two texts

    clearSessionUndo(SESSION);
    expect(undoByteCount()).toBe(0);
    expect(undoRecordCount()).toBe(0);
  });

  it("counts the same bytes the records actually hold, after both evictions", () => {
    // The invariant behind the budget: the counter must equal the content that
    // is really retained. Checked by recomputing it from the surviving records
    // rather than by trusting a second read of the same number.
    //
    // This deliberately crosses BOTH eviction paths — the session-count bound
    // (64) and the global byte budget — because each subtracts from the counter
    // on its own, and a missed subtraction in either one leaks memory silently.
    const state = { encoding: "utf8", hasBOM: false, lineEnding: "\n" as const, version: undefined };
    const big = "x".repeat(2 * 1024 * 1024); // 4 MiB per record
    for (let i = 0; i < 20; i += 1) {
      recordUndo(`mix${i}`, `key${i}`, {
        previousText: big,
        nextText: big,
        previousState: state,
        nextVersion: undefined,
        nextEncoding: "utf8",
        mode: "edit",
      });
    }
    for (let i = 0; i < 60; i += 1) {
      recordUndo(`tiny${i}`, "key", {
        previousText: "ab",
        nextText: "cd",
        previousState: state,
        nextVersion: undefined,
        nextEncoding: "utf8",
        mode: "edit",
      });
    }

    let actual = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = getUndo(`mix${i}`, `key${i}`);
      if (r !== undefined) actual += r.previousText.length + r.nextText.length;
    }
    for (let i = 0; i < 60; i += 1) {
      const r = getUndo(`tiny${i}`, "key");
      if (r !== undefined) actual += r.previousText.length + r.nextText.length;
    }

    expect(undoByteCount()).toBe(actual);
    expect(undoByteCount()).toBeGreaterThan(0);
  });

  it("drops whole sessions when the session bound evicts, without leaking their bytes", () => {
    // 70 one-record sessions against MAX_SESSIONS = 64. The six oldest must be
    // dropped AND their bytes subtracted; a missing subtraction would leave the
    // counter permanently too high and evict records that should have stayed.
    const state = { encoding: "utf8", hasBOM: false, lineEnding: "\n" as const, version: undefined };
    for (let i = 0; i < 70; i += 1) {
      recordUndo(`s${i}`, "key", {
        previousText: "aa",
        nextText: "bb",
        previousState: state,
        nextVersion: undefined,
        nextEncoding: "utf8",
        mode: "edit",
      });
    }

    expect(undoRecordCount()).toBe(64);
    expect(undoByteCount()).toBe(64 * 4); // 64 surviving records x 4 units
    // The newest survives and the oldest is gone, so the eviction order is LRU
    // rather than arbitrary.
    expect(getUndo("s69", "key")).toBeDefined();
    expect(getUndo("s0", "key")).toBeUndefined();
  });

  it("clearing an already-evicted record does not subtract twice", () => {
    // Both clear paths run on records eviction may already have removed, and a
    // double subtraction would make the counter drift negative.
    const state = { encoding: "utf8", hasBOM: false, lineEnding: "\n" as const, version: undefined };
    for (let i = 0; i < 70; i += 1) {
      recordUndo(`s${i}`, "key", {
        previousText: "aa",
        nextText: "bb",
        previousState: state,
        nextVersion: undefined,
        nextEncoding: "utf8",
        mode: "edit",
      });
    }
    const before = undoByteCount();

    clearUndoFor("s0", "key"); // already evicted
    clearSessionUndo("s0"); // already evicted

    expect(undoByteCount()).toBe(before);
  });
});
