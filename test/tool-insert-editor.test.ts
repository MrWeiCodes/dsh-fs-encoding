/**
 * The `insert` and `str_replace_editor` tools end to end, over the real
 * filesystem and sandbox.
 *
 * Two things only an integration test can prove:
 *
 * 1. **Encoding survives.** Both tools route through this plugin's read/write
 *    path, so inserting into a GBK file must leave it a GBK file. The harness's
 *    own `str_replace_editor` reads and writes UTF-8 text and cannot do this —
 *    that is the reason this tool exists.
 * 2. **The commands reach the same code the standalone tools use**, so a file
 *    edited through `str_replace_editor` and one edited through `edit` end up
 *    under the same encoding record.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import * as observationPolicy from "@deepseek-ai/dsh-fs-observation-policy";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { clearEncodingState } from "../src/encoding-state.js";
import { EncodingSandbox } from "../src/sandbox.js";
import { buildInsertTool } from "../src/tool-insert.js";
import { buildStrReplaceEditorTool } from "../src/tool-str-replace-editor.js";

let dir: string;
let root: Context;
let insert: ReturnType<typeof buildInsertTool>;
let editor: ReturnType<typeof buildStrReplaceEditorTool>;
/**
 * The run context `execute` takes.
 *
 * `ToolRunContext`, not the narrower `ToolExecution`: `execute` receives the run
 * context, which extends the execution with `deferContext` / `concludeTurn`. The
 * plugin calls neither, so the cast is confined to the stub below and every call
 * site stays type-checked.
 */
let exec: ToolRunContext;

const utf8 = (s: string) => Buffer.from(s, "utf8");
const gbkBytes = (s: string) => Buffer.from(iconv.encode(s, "gbk"));

/** The tool result's model-facing text. */
function textOf(tool: { output?: { render?: unknown } }, args: unknown, value: unknown): string {
  const fn = tool.output?.render as
    | ((a: unknown, v: unknown) => Array<{ text: string }>)
    | undefined;
  if (fn === undefined) throw new Error("tool has no render");
  return fn(args, value).map((b) => b.text).join("");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-encoding-insert-"));
  root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: dir }),
  });
  new SandboxedFileSystem(root, { cwd: dir, diffBasisMaxBytes: 10 * 1024 * 1024 });
  observationPolicy.apply(root);
  const sandbox = new EncodingSandbox(root);
  insert = buildInsertTool(root, sandbox);
  editor = buildStrReplaceEditorTool(root, sandbox);
  exec = {
    name: "insert",
    callId: "call-1",
    agent: { session: { id: `s-${Math.random().toString(36).slice(2)}`, header: { cwd: dir } } },
  } as unknown as ToolRunContext;
  clearEncodingState();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("insert tool", () => {
  it("inserts after the named line", async () => {
    await writeFile(join(dir, "a.txt"), utf8("l1\nl2\nl3\n"));

    await insert.execute({ file_path: "a.txt", insert_line: 1, new_string: "NEW" }, exec);

    expect((await readFile(join(dir, "a.txt"))).toString("utf8")).toBe("l1\nNEW\nl2\nl3\n");
  });

  it("inserts at the very top for line 0", async () => {
    await writeFile(join(dir, "b.txt"), utf8("l1\nl2\n"));
    await insert.execute({ file_path: "b.txt", insert_line: 0, new_string: "HEADER" }, exec);
    expect((await readFile(join(dir, "b.txt"))).toString("utf8")).toBe("HEADER\nl1\nl2\n");
  });

  it("appends at the line count", async () => {
    await writeFile(join(dir, "c.txt"), utf8("l1\nl2\n"));
    await insert.execute({ file_path: "c.txt", insert_line: 2, new_string: "TAIL" }, exec);
    expect((await readFile(join(dir, "c.txt"))).toString("utf8")).toBe("l1\nl2\nTAIL\n");
  });

  it("rejects a line number past the end without writing", async () => {
    const original = utf8("l1\nl2\n");
    await writeFile(join(dir, "d.txt"), original);

    await expect(
      insert.execute({ file_path: "d.txt", insert_line: 99, new_string: "X" }, exec),
    ).rejects.toThrow(/outside the file's range/);

    expect((await readFile(join(dir, "d.txt"))).equals(original)).toBe(true);
  });

  it("keeps a GBK file GBK — the reason this tool exists", async () => {
    const p = join(dir, "gbk.txt");
    const original = "第一行\n第二行\n";
    await writeFile(p, gbkBytes(original));

    // Read first so the session records the encoding, as a model would.
    const { readFile: pluginRead } = await import("../src/io.js");
    await pluginRead(root, "gbk.txt", dir, { exec, encodingHint: "gbk" });

    await insert.execute({ file_path: "gbk.txt", insert_line: 1, new_string: "新增行" }, exec);

    const onDisk = await readFile(p);
    expect(iconv.decode(onDisk, "gbk")).toBe("第一行\n新增行\n第二行\n");
    // The decisive assertion: still not valid UTF-8.
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(onDisk)).toThrow();
  });

  it("reports the inserted line count to the model", async () => {
    await writeFile(join(dir, "e.txt"), utf8("l1\n"));
    const value = await insert.execute(
      { file_path: "e.txt", insert_line: 0, new_string: "a\nb" },
      exec,
    );
    const text = textOf(insert, { file_path: "e.txt" }, value);
    expect(text).toContain("Inserted 2 line(s)");
    expect(text).toContain("at the top");
  });

  it("refuses content the encoding cannot represent", async () => {
    const p = join(dir, "gbk2.txt");
    await writeFile(p, gbkBytes("内容\n"));
    const { readFile: pluginRead } = await import("../src/io.js");
    await pluginRead(root, "gbk2.txt", dir, { exec, encodingHint: "gbk" });

    await expect(
      insert.execute({ file_path: "gbk2.txt", insert_line: 0, new_string: "emoji 🎉" }, exec),
    ).rejects.toThrow(/E_UNMAPPABLE/);

    expect(iconv.decode(await readFile(p), "gbk")).toBe("内容\n");
  });
});

describe("str_replace_editor — view", () => {
  it("shows a file with line numbers", async () => {
    await writeFile(join(dir, "v.txt"), utf8("alpha\nbeta\n"));
    const value = await editor.execute({ command: "view", path: "v.txt" }, exec);
    const text = textOf(editor, {}, value);
    expect(text).toContain("1: alpha");
    expect(text).toContain("2: beta");
    expect(text).toContain("total 2 lines");
  });

  it("honours view_range", async () => {
    await writeFile(join(dir, "vr.txt"), utf8("l1\nl2\nl3\nl4\n"));
    const value = await editor.execute(
      { command: "view", path: "vr.txt", view_range: [2, 3] },
      exec,
    );
    const text = textOf(editor, {}, value);
    expect(text).toContain("2: l2");
    expect(text).toContain("3: l3");
    expect(text).not.toContain("1: l1");
  });

  it("explains an out-of-range view instead of throwing", async () => {
    // A sentence the model can act on beats a bare error.
    await writeFile(join(dir, "vx.txt"), utf8("l1\n"));
    const value = await editor.execute(
      { command: "view", path: "vx.txt", view_range: [5, 9] },
      exec,
    );
    expect(textOf(editor, {}, value)).toContain("beyond the end");
  });

  it("lists a directory two levels deep, skipping hidden entries", async () => {
    await writeFile(join(dir, "top.txt"), utf8("x"));
    await writeFile(join(dir, ".hidden"), utf8("x"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "inner.txt"), utf8("x"));
    await mkdir(join(dir, "node_modules"), { recursive: true });

    const value = await editor.execute({ command: "view", path: "." }, exec);
    const text = textOf(editor, {}, value);

    // Only the LISTING rows, not the prose above them: the preamble names
    // `node_modules` on purpose ("excluding hidden items, node_modules, and
    // Python cache directories"), so a whole-output assertion would fail on the
    // sentence describing the exclusion rather than on the exclusion itself.
    const rows = text
      .split("\n")
      .filter((line) => /^[df?]\t/.test(line));

    expect(rows.some((r) => r.includes("top.txt"))).toBe(true);
    expect(rows.some((r) => r.includes("inner.txt"))).toBe(true);
    expect(rows.some((r) => r.includes(".hidden"))).toBe(false);
    expect(rows.some((r) => r.includes("node_modules"))).toBe(false);
    // The type markers the harness uses.
    expect(rows.some((r) => r.startsWith("d\t"))).toBe(true);
    expect(rows.some((r) => r.startsWith("f\t"))).toBe(true);
  });
});

describe("str_replace_editor — str_replace", () => {
  it("replaces a unique match", async () => {
    await writeFile(join(dir, "r.txt"), utf8("a\nb\nc\n"));
    await editor.execute(
      { command: "str_replace", path: "r.txt", old_str: "b", new_str: "B" },
      exec,
    );
    expect((await readFile(join(dir, "r.txt"))).toString("utf8")).toBe("a\nB\nc\n");
  });

  it("refuses an ambiguous match and names the lines", async () => {
    const original = utf8("x\nkeep\nx\n");
    await writeFile(join(dir, "amb.txt"), original);

    await expect(
      editor.execute({ command: "str_replace", path: "amb.txt", old_str: "x", new_str: "Y" }, exec),
    ).rejects.toThrow(/matched 2 times.*lines 1, 3/s);

    expect((await readFile(join(dir, "amb.txt"))).equals(original)).toBe(true);
  });

  it("replaces every occurrence when replace_all is passed", async () => {
    // The opt-in extension: omitting it reproduces the harness exactly.
    await writeFile(join(dir, "all.txt"), utf8("x\nkeep\nx\n"));
    const value = await editor.execute(
      { command: "str_replace", path: "all.txt", old_str: "x", new_str: "Y", replace_all: true },
      exec,
    );
    expect((await readFile(join(dir, "all.txt"))).toString("utf8")).toBe("Y\nkeep\nY\n");
    expect(textOf(editor, {}, value)).toContain("Replaced 2 occurrence(s)");
  });

  it("reports a missing match without writing", async () => {
    const original = utf8("a\n");
    await writeFile(join(dir, "miss.txt"), original);

    await expect(
      editor.execute(
        { command: "str_replace", path: "miss.txt", old_str: "zzz", new_str: "Y" },
        exec,
      ),
    ).rejects.toThrow(/was not found/);

    expect((await readFile(join(dir, "miss.txt"))).equals(original)).toBe(true);
  });

  it("keeps a GBK file GBK", async () => {
    const p = join(dir, "rgbk.txt");
    await writeFile(p, gbkBytes("原始内容\n第二行\n"));
    const { readFile: pluginRead } = await import("../src/io.js");
    await pluginRead(root, "rgbk.txt", dir, { exec, encodingHint: "gbk" });

    await editor.execute(
      { command: "str_replace", path: "rgbk.txt", old_str: "原始内容", new_str: "更新内容" },
      exec,
    );

    const onDisk = await readFile(p);
    expect(iconv.decode(onDisk, "gbk")).toBe("更新内容\n第二行\n");
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(onDisk)).toThrow();
  });
});

describe("str_replace_editor — insert", () => {
  it("inserts AFTER the named line, matching the harness", async () => {
    await writeFile(join(dir, "i.txt"), utf8("l1\nl2\nl3\n"));
    await editor.execute(
      { command: "insert", path: "i.txt", insert_line: 1, new_str: "NEW" },
      exec,
    );
    expect((await readFile(join(dir, "i.txt"))).toString("utf8")).toBe("l1\nNEW\nl2\nl3\n");
  });

  it("treats 0 as the top", async () => {
    await writeFile(join(dir, "i0.txt"), utf8("l1\n"));
    await editor.execute({ command: "insert", path: "i0.txt", insert_line: 0, new_str: "TOP" }, exec);
    expect((await readFile(join(dir, "i0.txt"))).toString("utf8")).toBe("TOP\nl1\n");
  });

  it("rejects an out-of-range line without writing", async () => {
    const original = utf8("l1\n");
    await writeFile(join(dir, "ir.txt"), original);

    await expect(
      editor.execute({ command: "insert", path: "ir.txt", insert_line: 9, new_str: "X" }, exec),
    ).rejects.toThrow(/outside the file's range/);

    expect((await readFile(join(dir, "ir.txt"))).equals(original)).toBe(true);
  });
});

describe("str_replace_editor — create", () => {
  it("creates a new file as UTF-8", async () => {
    await editor.execute(
      { command: "create", path: "new.txt", file_text: "hello\n" },
      exec,
    );
    expect((await readFile(join(dir, "new.txt"))).toString("utf8")).toBe("hello\n");
  });

  it("creates an empty file from an empty file_text", async () => {
    // The harness's `requiredForCommand` allows an empty string here, so a caller
    // that creates a placeholder file must not be rejected.
    await editor.execute({ command: "create", path: "empty.txt", file_text: "" }, exec);
    expect((await readFile(join(dir, "empty.txt"))).length).toBe(0);
  });

  it("keeps the CRLF a caller explicitly asked for", async () => {
    // A file being created has no recorded line ending to restore, so normalizing
    // here would silently rewrite what the caller wrote — and `write` does not.
    await editor.execute(
      { command: "create", path: "crlf.txt", file_text: "a\r\nb\r\n" },
      exec,
    );
    expect((await readFile(join(dir, "crlf.txt"))).toString("utf8")).toBe("a\r\nb\r\n");
  });

  it("refuses an existing file", async () => {
    const original = utf8("keep me\n");
    await writeFile(join(dir, "exists.txt"), original);

    await expect(
      editor.execute({ command: "create", path: "exists.txt", file_text: "clobber\n" }, exec),
    ).rejects.toThrow(/already exists/);

    expect((await readFile(join(dir, "exists.txt"))).equals(original)).toBe(true);
  });
});

describe("str_replace_editor — harness-compatible argument shapes", () => {
  it("treats an omitted new_str as deletion", async () => {
    // The harness documents "omit new_str rather than setting it to null" for a
    // deletion, so the omitted form must work.
    await writeFile(join(dir, "del.txt"), utf8("a\nb\nc\n"));
    await editor.execute({ command: "str_replace", path: "del.txt", old_str: "b\n" }, exec);
    expect((await readFile(join(dir, "del.txt"))).toString("utf8")).toBe("a\nc\n");
  });

  it("refuses an explicit null new_str instead of deleting the match", async () => {
    // The harness distinguishes the two: omitted means delete, explicit null is
    // refused. Accepting null as "delete" would destroy content on a malformed call.
    const original = utf8("a\nb\nc\n");
    await writeFile(join(dir, "nulldel.txt"), original);

    await expect(
      editor.execute(
        { command: "str_replace", path: "nulldel.txt", old_str: "b", new_str: null },
        exec,
      ),
    ).rejects.toThrow(/must be omitted \(not null\)/);

    expect((await readFile(join(dir, "nulldel.txt"))).equals(original)).toBe(true);
  });

  it("accepts null placeholders on parameters the command does not use", async () => {
    await writeFile(join(dir, "null.txt"), utf8("a\nb\n"));
    await editor.execute(
      {
        command: "str_replace",
        path: "null.txt",
        old_str: "b",
        new_str: "B",
        file_text: null,
        insert_line: null,
        view_range: null,
      },
      exec,
    );
    expect((await readFile(join(dir, "null.txt"))).toString("utf8")).toBe("a\nB\n");
  });
});

describe("str_replace_editor — view_range validation", () => {
  it("rejects an inverted range instead of showing an empty window", async () => {
    // Slicing [3, 2] yields nothing, and the shared footer would then ask the
    // model to retry the same offset forever.
    await writeFile(join(dir, "inv.txt"), utf8("l1\nl2\nl3\nl4\nl5\n"));
    const value = await editor.execute(
      { command: "view", path: "inv.txt", view_range: [3, 2] },
      exec,
    );
    const text = textOf(editor, {}, value);
    expect(text).toContain("invalid");
    expect(text).not.toContain("Use offset=");
  });

  it("rejects a start below 1 with a message about the start", async () => {
    await writeFile(join(dir, "lo.txt"), utf8("l1\nl2\n"));
    const value = await editor.execute(
      { command: "view", path: "lo.txt", view_range: [0, 2] },
      exec,
    );
    const text = textOf(editor, {}, value);
    expect(text).toContain("first line must be 1 or greater");
    expect(text).not.toContain("beyond the end");
  });

  it("rejects an end past the last line instead of clamping it", async () => {
    // The harness refuses this too; clamping silently would read as a full window.
    await writeFile(join(dir, "hi.txt"), utf8("l1\nl2\n"));
    const value = await editor.execute(
      { command: "view", path: "hi.txt", view_range: [1, 99] },
      exec,
    );
    const text = textOf(editor, {}, value);
    expect(text).toContain("invalid");
    expect(text).toContain("2 line(s)");
  });

  it("treats both bounds of an empty file's range consistently", async () => {
    // An empty file reports 0 lines, but line 1 is still addressable (the harness's
    // own `allLines` is `[""]`). Using the raw total for one bound and a floor of 1
    // for the other made `[1, 1]` fail while `[1, -1]` succeeded on the same file.
    await writeFile(join(dir, "zero.txt"), utf8(""));

    const one = textOf(
      editor,
      {},
      await editor.execute({ command: "view", path: "zero.txt", view_range: [1, 1] }, exec),
    );
    const all = textOf(
      editor,
      {},
      await editor.execute({ command: "view", path: "zero.txt", view_range: [1, -1] }, exec),
    );
    expect(one).not.toContain("invalid");
    expect(all).not.toContain("invalid");
    expect(one).toContain("total 0 lines");
    expect(all).toContain("total 0 lines");
    // And the cap did not cut anything, so nothing may claim a truncation.
    expect(one).not.toContain("Truncated");
    expect(all).not.toContain("Truncated");
  });

  it("reports the same total AND the same lines as `read` for every file shape", async () => {
    // The two tools publish one numbering for one file. A lone newline used to be
    // the exception — `read` said 0 lines while `view` said 1 — and bounding the
    // window by the raw total then made `view` render NO lines where `read`
    // rendered one blank line. Both the total and the body are asserted here,
    // because checking only the total let the second half through.
    const { buildReadTool } = await import("../src/tool-read.js");
    const readTool = buildReadTool(root);

    const shapes = ["", "\n", "\n\n", "\n\n\n", "a", "a\n", "a\nb", "a\nb\n", "\n\na\n", "a\n\nb\n"];
    for (const [i, shape] of shapes.entries()) {
      const name = `shape-${i}.txt`;
      await writeFile(join(dir, name), utf8(shape));

      const readValue = (await readTool.execute({ file_path: name }, exec)) as {
        totalLines: number;
        lines: Array<{ number: number; text: string }>;
      };
      const viewText = textOf(
        editor,
        {},
        await editor.execute({ command: "view", path: name }, exec),
      );
      const published = viewText.match(/total (\d+) lines/)?.[1];
      const rendered = viewText.split("\n").filter((line) => /^\d+: /.test(line));

      expect(published, `total for shape=${JSON.stringify(shape)}`).toBe(
        String(readValue.totalLines),
      );
      expect(rendered.length, `rendered lines for shape=${JSON.stringify(shape)}`).toBe(
        readValue.lines.length,
      );
    }
  });
});

describe("str_replace_editor — the continuation hint", () => {
  it("corrects the read-tool offset hint whenever the window stops early", async () => {
    // `view` has no `offset` parameter, so the shared footer's hint must always be
    // followed by one that names this tool's own argument.
    await writeFile(
      join(dir, "hint.txt"),
      utf8(Array.from({ length: 300 }, (_, i) => `l${i + 1}`).join("\n") + "\n"),
    );

    const ranged = textOf(
      editor,
      {},
      await editor.execute({ command: "view", path: "hint.txt", view_range: [1, 50] }, exec),
    );
    expect(ranged).toContain("Use offset=");
    expect(ranged).toContain("is for the read tool");
    expect(ranged).toContain("view_range=[51, -1]");

    // And the whole-file case that hits the 2000-line cap.
    await writeFile(
      join(dir, "hint2.txt"),
      utf8(Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n") + "\n"),
    );
    const capped = textOf(
      editor,
      {},
      await editor.execute({ command: "view", path: "hint2.txt" }, exec),
    );
    expect(capped).toContain("is for the read tool");
    expect(capped).toContain("Truncated to 2000 lines");
    expect(capped).toContain("view_range=[2001, -1]");
  });

  it("says nothing extra when the window reaches the end", async () => {
    await writeFile(join(dir, "eof.txt"), utf8("a\nb\n"));
    const text = textOf(
      editor,
      {},
      await editor.execute({ command: "view", path: "eof.txt" }, exec),
    );
    expect(text).toContain("End of file");
    expect(text).not.toContain("is for the read tool");
  });
});

describe("str_replace_editor — create keeps CRLF through a later edit", () => {
  it("records the created file's real line ending", async () => {
    // A created file has no recorded ending, and its content is published
    // verbatim — so the record must describe those bytes. Recording LF there made
    // the next edit rewrite the whole file's CRLF as LF.
    await editor.execute({ command: "create", path: "keep.txt", file_text: "a\r\nb\r\n" }, exec);
    expect((await readFile(join(dir, "keep.txt"))).toString("utf8")).toBe("a\r\nb\r\n");

    await editor.execute(
      { command: "str_replace", path: "keep.txt", old_str: "b", new_str: "B" },
      exec,
    );
    expect((await readFile(join(dir, "keep.txt"))).toString("utf8")).toBe("a\r\nB\r\n");
  });
});

describe("str_replace_editor — output caps", () => {
  it("caps a large view and says it truncated", async () => {
    // `read` caps at 2000 lines; `view` shows the same files to the same model, so
    // it must not be the unbounded way in.
    const many = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeFile(join(dir, "big.txt"), utf8(many));

    const value = await editor.execute({ command: "view", path: "big.txt" }, exec);
    const text = textOf(editor, {}, value);
    expect(text).toContain("Truncated");
    expect(text).toContain("2000");
    expect(text).toContain("2500");
  });

  it("clips an over-long single line", async () => {
    await writeFile(join(dir, "long.txt"), utf8(`${"x".repeat(5000)}\n`));
    const value = await editor.execute({ command: "view", path: "long.txt" }, exec);
    const text = textOf(editor, {}, value);
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(4000);
  });
});

describe("str_replace_editor — lone CR files", () => {
  it("refuses insert into a lone-CR file rather than misplacing the line", async () => {
    // `read` sees ONE line here; the LF-normalized text sees three. A line number
    // valid in both readings cannot be told apart, so the call must be refused.
    const original = utf8("a\rb\rc\r");
    await writeFile(join(dir, "cr.txt"), original);

    await expect(
      editor.execute({ command: "insert", path: "cr.txt", insert_line: 1, new_str: "X" }, exec),
    ).rejects.toThrow(/lone CR/);

    expect((await readFile(join(dir, "cr.txt"))).equals(original)).toBe(true);
  });
});

describe("str_replace_editor — ambiguity message stays bounded", () => {
  it("lists a bounded number of lines and reports the total", async () => {
    const many = Array.from({ length: 500 }, () => "x").join("\n") + "\n";
    await writeFile(join(dir, "amb-big.txt"), utf8(many));

    let message = "";
    try {
      await editor.execute(
        { command: "str_replace", path: "amb-big.txt", old_str: "x", new_str: "Y" },
        exec,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("matched 500 times");
    expect(message).toContain("500 total");
    // 20 line numbers, not 500.
    expect(message.split(",").length).toBeLessThan(30);
  });
});

describe("str_replace_editor — unsupported and invalid commands", () => {
  it("explains that undo_edit is unsupported", async () => {
    // Listed in the enum precisely so this sentence is reachable.
    await writeFile(join(dir, "u.txt"), utf8("x\n"));
    await expect(
      editor.execute({ command: "undo_edit", path: "u.txt" }, exec),
    ).rejects.toThrow(/undo_edit is not supported/);
  });

  it("names the valid commands for an unknown one", async () => {
    await expect(editor.execute({ command: "frobnicate", path: "x" }, exec)).rejects.toThrow(
      /unknown command.*view, create, str_replace, insert, undo_edit/s,
    );
  });

  it("rejects a missing path", async () => {
    await expect(editor.execute({ command: "view" }, exec)).rejects.toThrow(/"path"/);
  });
});
