/**
 * End-to-end tests for the encoding-aware `grep`.
 *
 * These run the REAL tool through the REAL `ToolRuntime` against the REAL
 * packaged ripgrep binary, on files written to a temporary directory. Nothing
 * about the search is mocked: the point of the feature is what a real ripgrep
 * does with real legacy-encoded bytes, and a stub would answer the question by
 * assumption.
 *
 * The suite is built around the two defects from the reported issue, because
 * they are the reason the tool exists:
 *
 * - a matching line in a non-UTF-8 file was shown as
 *   `(line is not valid UTF-8)` instead of its text;
 * - a non-ASCII pattern in a non-UTF-8 file matched NOTHING, silently.
 *
 * The second is the serious one and the harder to notice, so it gets its own
 * case with an explicit "the built-in would return zero here" assertion rather
 * than only a positive one.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { LocalSpillStore } from "@deepseek-ai/dsh-spill-local";
import { LocalSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-local";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt, TOOL_ORDER_REST } from "@deepseek-ai/dsh-system-prompt";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";
import iconv from "iconv-lite";
import { apply } from "../src/index.js";
import { GREP_TOOL_NAME } from "../src/tool-grep.js";

/** The session cwd every call resolves relative paths against. */
let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "dsh-grep-test-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Write one file into the workspace and return its absolute path. */
function fixture(name: string, text: string, encoding: string): string {
  const path = join(workspace, name);
  const bytes =
    encoding === "utf8bom"
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])
      : iconv.encode(text, encoding === "utf8" ? "utf8" : encoding);
  writeFileSync(path, bytes);
  return path;
}

/**
 * A realistic mostly-ASCII file with CJK lines appended.
 *
 * Detection needs enough text to tell the legacy pages apart: measured, a
 * one-line file holding a few CJK characters scores `gbk` and `big5` IDENTICALLY
 * (112.5 each), so admission cannot rank them and refuses. That is a real limit
 * of the heuristic and not what these tests are about, so the fixtures carry the
 * shape real source files have — mostly ASCII, with the non-ASCII content in
 * comments.
 *
 * @param cjk - the non-ASCII lines to append.
 * @param asciiLines - how many ASCII lines to put in front.
 */
function sourceLike(cjk: readonly string[], asciiLines = 40): string {
  const head = Array.from({ length: asciiLines }, (_, i) => `const key_${i} = value_${i};`);
  return `${[...head, ...cjk].join("\n")}\n`;
}

/**
 * Build a host wired like a real deployment, with the search seams mounted.
 *
 * The subprocess runtime is what the plugin probes for, so a test that wants the
 * encoding-aware `grep` has to mount it exactly as `dsh-base` does. The spill
 * store is mounted because a capped result tries to save itself, and a missing
 * one is a legitimate deployment too — covered separately.
 */
function makeHost(options: { subprocess?: boolean } = {}): Context {
  const root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: workspace }),
  });
  new SandboxedFileSystem(root, { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 });
  new SystemPrompt(root, { toolOrder: [TOOL_ORDER_REST] });
  new ToolRuntime(root);
  if (options.subprocess !== false) {
    new LocalSubprocessRuntime(root);
    new LocalSpillStore(root, {});
  }
  return root;
}

/** An agent-shaped subject with its own scope, plus the tool layer it owns. */
function makeAgent(root: Context, id = "agent-grep") {
  const agent = { id } as { id: string; ctx: Context; session: { header: { cwd: string } } };
  const scope = createScope(root, agent);
  agent.ctx = scope.ctx;
  agent.session = { header: { cwd: workspace } };
  return agent;
}

/** Install the plugin for one agent and wait for the async `grep` registration. */
async function install(root: Context, agent: ReturnType<typeof makeAgent>): Promise<void> {
  apply(root);
  (root.emit as unknown as (name: string, payload: { agent: unknown }) => void)(
    "agent/session-start",
    { agent },
  );
  // `grep` is registered from an async continuation (the toolkit is imported on
  // demand), so the layer is polled rather than assumed ready.
  const scope = scopeOf(agent.ctx);
  for (let i = 0; i < 100; i++) {
    if (agent.ctx.tools.get(GREP_TOOL_NAME, scope) !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Run one `grep` call through the real registry pipeline. */
async function grep(
  agent: ReturnType<typeof makeAgent>,
  args: { pattern: string; path?: string; include?: string },
): Promise<{ text: string; value: { matches: Array<{ path: string; lineNumber: number; line: string }> }; isError: boolean }> {
  const result = await agent.ctx.tools.execute({
    callId: `c-${Math.random().toString(36).slice(2, 10)}` as never,
    name: GREP_TOOL_NAME,
    arguments: args,
    agent: agent as never,
    signal: new AbortController().signal,
  });
  const text = (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  const value = (result.value ?? { matches: [] }) as {
    matches: Array<{ path: string; lineNumber: number; line: string }>;
  };
  return { text, value, isError: result.isError };
}

/** The line text of the first match, or `undefined`. */
function firstLine(
  result: { value: { matches: Array<{ line: string }> } },
): string | undefined {
  return result.value.matches[0]?.line;
}

describe("grep: the reported defects", () => {
  it("shows a GBK file's matching line as TEXT once the session has established the encoding", async () => {
    // The reported symptom, and the documented remedy for it. `read` with an
    // explicit encoding is how a legacy file is opened at all; `io.ts` records
    // that answer and reuses it as the hint on every later read, so the search
    // has to consult the same record or it would report a placeholder for a file
    // the session has already decoded.
    fixture("gbk-ascii.js", sourceLike(["// PORT=8080 配置项 端口"]), "gbk");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    // Before the read: no record, so the search cannot decode the file.
    const before = await grep(agent, { pattern: "PORT", path: "gbk-ascii.js" });
    expect(firstLine(before)).toContain("not valid UTF-8");

    // The remedy: open the file under an explicit encoding.
    await agent.ctx.tools.execute({
      callId: "read-1" as never,
      name: "read",
      arguments: { file_path: "gbk-ascii.js", encoding: "gbk", offset: 41, limit: 1 },
      agent: agent as never,
      signal: new AbortController().signal,
    });

    // After it: the same search reports the real text.
    const after = await grep(agent, { pattern: "PORT", path: "gbk-ascii.js" });
    expect(after.isError).toBe(false);
    expect(firstLine(after)).toBe("// PORT=8080 配置项 端口");
    expect(after.text).not.toContain("not valid UTF-8");
  });

  it("reports candidate encodings rather than a bare placeholder when nothing is recorded", async () => {
    // The default `autoGuessEncoding` is `false`, and the honest consequence is
    // that neither `read` nor `grep` can decode this file — so the two must agree
    // about that. What this tool adds over the built-in is the candidate list:
    // the built-in prints `(line is not valid UTF-8)` and stops, leaving the
    // model nothing to act on.
    //
    // Forcing a guess here would be worse than useless: measured on this exact
    // file, admission picks `iso-8859-1` and renders the line as
    // `// PORT=8080 ÅäÖÃÏî ¶Ë¿Ú` — the silent corruption this plugin exists to
    // prevent, and a disagreement with `read` about the same bytes.
    fixture("gbk-undetected.js", sourceLike(["// PORT=8080 配置项 端口"]), "gbk");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "PORT", path: "gbk-undetected.js" });
    const line = firstLine(result) ?? "";
    expect(line).toContain("not valid UTF-8");
    expect(line).toMatch(/candidates: /);
  });

  it("FINDS a non-ASCII pattern in a GBK file, which the built-in silently misses", async () => {
    // The serious half of the report, and the half that works with NO
    // configuration: the transcoding strategy is self-validating, so it needs no
    // detection and no recorded encoding. The built-in matches the pattern
    // against raw bytes, so a UTF-8 pattern cannot occur in a GBK file and the
    // search returns zero matches with no error — indistinguishable from "not
    // present". Measured against ripgrep directly: `--regexp=配置项` over this
    // exact file returns nothing without `--encoding`.
    fixture("gbk-cjk.js", sourceLike(["// 配置项说明：端口设置", "// 中文注释第二行"]), "gbk");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "中文注释", path: "gbk-cjk.js" });

    expect(result.isError).toBe(false);
    expect(result.value.matches).toHaveLength(1);
    expect(firstLine(result)).toBe("// 中文注释第二行");
  });

  it("searches a mixed-encoding directory and decodes each file with its own encoding", async () => {
    // The case that rules out passing one `--encoding` to ripgrep: measured, a
    // single flag makes it miss every file in another encoding and mojibake the
    // ones it does match.
    const lines = ["// 配置项说明：端口设置"];
    fixture("mix-gbk.js", sourceLike(lines), "gbk");
    fixture("mix-utf8.js", sourceLike(lines), "utf8");
    fixture("mix-u16.js", sourceLike(lines), "utf16le");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "配置项", path: "." });

    const byPath = new Map(result.value.matches.map((m) => [m.path.replace(/^\.\\/, ""), m.line]));
    expect(byPath.get("mix-gbk.js")).toBe("// 配置项说明：端口设置");
    expect(byPath.get("mix-utf8.js")).toBe("// 配置项说明：端口设置");
    expect(byPath.get("mix-u16.js")).toBe("// 配置项说明：端口设置");
  });

  it("does not report the same line twice when several encodings are tried", async () => {
    // The transcoding strategy runs the pattern once per candidate encoding and
    // unions the results. A UTF-8 file matches under `utf-8`; the risk is that it
    // ALSO matches under a legacy page that happens to decode its bytes into the
    // same characters, which would double every line.
    fixture("dedupe.js", sourceLike(["// 配置项说明：端口设置"]), "utf8");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "配置项", path: "dedupe.js" });
    expect(result.value.matches).toHaveLength(1);
  });

  it("does not let an ASCII alternative mojibake a file another page decoded", async () => {
    // The regression this suite was missing. A pattern holding an ASCII
    // alternative — `配置|read` — matches under EVERY page, because `read` is the
    // same bytes in all of them, so a union built on "which pages matched" put one
    // page's mojibake on screen for a file another page had decoded: measured, a
    // UTF-8 and a GBK file both came back as Korean-looking garbage, and the page
    // that happened to run last was the one displayed.
    //
    // The evidence that a page decoded a file is a NON-ASCII character in one of
    // its submatches, which only that page's mapping of the bytes can produce —
    // so `read`'s ASCII span, identical under every page, proves nothing.
    const lines = ["// 配置项说明：端口设置", "// read the config first"];
    fixture("alt-gbk.js", sourceLike(lines), "gbk");
    fixture("alt-utf8.js", sourceLike(lines), "utf8");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "配置|read", path: "." });

    // Both files hold BOTH lines, so each is reported twice. Collected per file
    // rather than mapped to one line each, because the property under test is
    // that neither file's rows were replaced by another page's reading of them.
    const byPath = new Map<string, string[]>();
    for (const m of result.value.matches) {
      const key = m.path.replace(/^\.\\/, "");
      byPath.set(key, [...(byPath.get(key) ?? []), m.line]);
    }
    expect(byPath.get("alt-gbk.js")).toEqual(lines);
    expect(byPath.get("alt-utf8.js")).toEqual(lines);
  });

  it("keeps an ASCII-only alternative match in a legacy file, without mojibake", async () => {
    // The other half of the same rule, and the reason the sweep cannot simply
    // replace the strict pass: a GBK file whose matching line holds ONLY the ASCII
    // alternative still has to be reported, and it is the file-level proof from a
    // DIFFERENT line that lets its decode be trusted.
    fixture(
      "alt-ascii.js",
      `${sourceLike(["// 端口配置"])}PORT=8080 read the value\n`,
      "gbk",
    );
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "配置|read", path: "alt-ascii.js" });

    const lines = result.value.matches.map((m) => m.line);
    expect(lines).toContain("// 端口配置");
    expect(lines).toContain("PORT=8080 read the value");
  });

  it("reports a Latin-1 file both single-byte pages read identically", async () => {
    // `windows-1252` and `iso-8859-1` share a byte table on 0xA0-0xFF, so both
    // pages prove a Latin-1 file and both produce the SAME text for it. Treating
    // "two pages proved this file" as a contradiction threw that agreement away,
    // and since both pages are in the default `supportedEncodings` the result was
    // `Found 0 matches` for every Western accented search — the silent miss this
    // tool exists to remove, on a file that plainly holds the text.
    fixture("latin.txt", "Intro line.\n// café résumé\n", "windows-1252");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "café", path: "." });

    expect(result.value.matches.map((m) => m.line)).toEqual(["// café résumé"]);
  });

  it("lets the per-file pass settle a conflict that admission CAN identify", async () => {
    // The other half of the conflict rule: the placeholder is a FLOOR, not the
    // final answer. A file whose bytes carry enough of one page's text for
    // admission to identify it gets that page's real line instead — measured, this
    // Big5 file scores 160 under `big5` against 140 under `gbk`, so admission
    // picks it. Without the per-file pass running for a conflicted file, this
    // would report the candidate list where the text is knowable.
    fixture(
      "settle.txt",
      sourceLike([
        "// 操作說明：整體系統設定說明，連接埠設定說明，資料庫連線",
        "// 資料庫連線設定，整體系統說明",
      ]),
      "big5",
    );
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "操", path: "settle.txt" });

    expect(result.value.matches.map((m) => m.line)).toEqual([
      "// 操作說明：整體系統設定說明，連接埠設定說明，資料庫連線",
    ]);
  });

  it("splits a mixed-encoding file between the strict pass and the pages", async () => {
    // The two sources of truth are complementary, and this is the shape that shows
    // it. Line 1 is valid UTF-8, so the strict pass decodes it and the sweep must
    // not touch it; line 2 is GBK, which the strict pass cannot see at all, so the
    // `gbk` page is the only thing that can answer for it. Taking either source as
    // authoritative for the whole FILE loses the other's line.
    writeFileSync(
      join(workspace, "mixlit.txt"),
      Buffer.concat([
        Buffer.from("// 配置说明\n", "utf8"),
        iconv.encode("// 端口配置\n", "gbk"),
      ]),
    );
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "配置", path: "mixlit.txt" });

    expect(result.value.matches.map((m) => m.line)).toEqual(["// 配置说明", "// 端口配置"]);
  });

  it("compares UTF-16 pages against each other when no legacy page proved the file", async () => {
    // The two families must not be compared ACROSS — a UTF-16 page's line numbers
    // address a two-byte re-pairing, not the file's own lines — but WITHIN the
    // UTF-16 family they pair the same bytes, so their readings ARE of the same
    // lines and can genuinely contradict. Measured on this UTF-16BE file under
    // `[一-龥]`: `utf16le` reads line 1 as `⼀⼀䶑湿` while `utf16be` reads it as
    // `// 端口配置`. Treating the UTF-16 pages as a mere fallback adopted whichever
    // came first in candidate order, which is always `utf16le` — the mojibake.
    fixture("be.txt", "// 端口配置\n", "utf16be");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "[一-龥]", path: "be.txt" });

    expect(result.value.matches.map((m) => m.line)).toEqual(["// 端口配置"]);
  });

  it("names the candidates instead of guessing when two pages contradict", async () => {
    // A GBK file holding both `操` and `巨`: `巨` is `be de` in GBK, and `be de`
    // is `操` in Big5, so BOTH pages prove this file — and they read it
    // differently. Nothing in the sweep can order them, and the candidate list is
    // ordered for GUESSING rather than for this: measured, taking its first entry
    // renders this file as `// 巨弧操砰╰参砞﹚弧`, mojibake shown as if it were the
    // line. Admission cannot settle it either (measured: `gbk` and `big5` score
    // 177.5 apiece), so the honest answer is the one `read` would give — the line
    // number, and the pages that could hold these bytes.
    //
    // The two answers that are NOT acceptable are the ones this replaced: the
    // sweep used to drop such a file entirely (a silent `Found 0 matches` for a
    // file holding the pattern), and adopting the first candidate shows garbage.
    fixture(
      "tie.js",
      sourceLike(["// 操作说明：巨大的数据集，配置端口设置", "// 中文注释第二行，管理系统服务连接"]),
      "gbk",
    );
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "操", path: "tie.js" });

    const lines = result.value.matches.map((m) => m.line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/not valid UTF-8/);
    expect(lines[0]).toMatch(/candidates: /);
  });

  it("does not adopt one page's reading of an overlapping file as the answer", async () => {
    // The case that makes "take the first candidate" untenable rather than merely
    // arbitrary. `操` is `be de` in Big5 and `b2 d9` in GBK, so a Big5 file
    // holding both is proved by both pages — and `gbk` comes FIRST in the
    // candidate list, so a first-candidate rule renders this Big5 file as
    // `// 巨弧操砰╰参砞﹚弧`. Asserting the placeholder is asserting that no page's
    // unverified reading reaches the model.
    fixture("overlap.txt", sourceLike(["// 操作說明：紱體系統設定說明"]), "big5");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "操", path: "overlap.txt" });

    const lines = result.value.matches.map((m) => m.line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/candidates: /);
  });

  it("finds Chinese through a character-class pattern, which spells no CJK", async () => {
    // `[一-龥]` matches Chinese without ever spelling `一` or `龥`, so a proof rule
    // keyed on "a character the pattern holds" found no evidence under any page
    // and answered `Found 0 matches` for a GBK file full of Chinese.
    //
    // This file is a genuine conflict: gbk, big5, shift_jis and euc-kr all prove
    // it and all four read lines 41 and 42 DIFFERENTLY (measured: gbk gives
    // `// 端口配置说明：中文注释`, big5 gives `// 傷諳饜离佽隴ㄩ笢恅蛁庋`). Nothing in
    // the sweep can order four contradicting readings, and admission cannot
    // either (measured: gbk and big5 both score 152.5), so the honest answer is
    // the placeholder naming the candidate pages — which is what `read` would
    // give for the same bytes.
    //
    // What this pins is that the file is REPORTED at all: two lines with their
    // possible encodings, where the rule this replaced said `Found 0 matches`.
    fixture(
      "range.js",
      sourceLike(["// 端口配置说明：中文注释", "// 管理系统服务连接信息"]),
      "gbk",
    );
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "[一-龥]", path: "range.js" });

    expect(result.value.matches.map((m) => m.lineNumber)).toEqual([41, 42]);
    for (const match of result.value.matches) {
      expect(match.line).toMatch(/candidates: /);
    }
  });

  it("keeps a valid UTF-8 file's text out of the transcoding pages' hands", async () => {
    // The regression that made the file-level rule untenable. Every legacy page
    // "proves" a UTF-8 file — its bytes transcode to mojibake, and mojibake is
    // non-ASCII, so it satisfies the evidence rule — and they all disagree with
    // each other AND with the correct text. Measured on this repository's
    // README.md under `[一-龥]`: gbk 258 lines, big5 256, shift_jis 258, euc-kr
    // 239, against 256 lines the strict pass had decoded correctly; 23 files in
    // the repository were affected.
    //
    // So the strict pass wins for any line it decoded, and the pages answer only
    // for files it cannot see. This asserts the plainest form of that: a UTF-8
    // file's Chinese comes back as its own text, not as a placeholder.
    fixture("utf8-only.txt", sourceLike(["// 中文注释，合法 UTF-8 文件", "// 第二行中文说明"]), "utf8");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "[一-龥]", path: "utf8-only.txt" });

    expect(result.value.matches.map((m) => m.line)).toEqual([
      "// 中文注释，合法 UTF-8 文件",
      "// 第二行中文说明",
    ]);
  });

  it("finds a case-folded match whose text differs from the pattern", async () => {
    // `(?i)` makes the matched text differ from the pattern's own characters, so
    // a proof rule comparing the two saw no evidence and reported nothing for a
    // file that holds the text. README documents `(?i)` as available here.
    fixture(
      "fold.txt",
      sourceLike(["// ПРИВЕТ мир, это тестовый файл", "// вторая строка комментария"]),
      "windows-1251",
    );
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "(?i)привет", path: "fold.txt" });

    expect(result.value.matches.map((m) => m.line)).toEqual(["// ПРИВЕТ мир, это тестовый файл"]);
  });

  it("still re-searches a proved file whose other row only the strict pass matched", async () => {
    // A file the sweep proved is answered by that page's decode — but only for the
    // lines that page MATCHED. Here line 41 proves the file under `gbk`, while the
    // byte `0x81` in the last line makes its gbk decode `// 乺ead`, so the gbk run
    // never reports that line: only the strict pass matches it, on the raw bytes.
    // Treating the file as fully answered skipped the per-file pass, which left
    // that row a BARE `(line is not valid UTF-8)` — the remedy the placeholder
    // exists to carry is the candidate list, and only that pass can supply it.
    const head = Array.from({ length: 40 }, (_, i) => `const key_${i} = value_${i};`).join("\n");
    const tail = Buffer.from([0x2f, 0x2f, 0x20, 0x81, 0x72, 0x65, 0x61, 0x64, 0x0a]);
    fixture("mixed-row.js", `${head}\n// 端口配置项\n`, "gbk");
    // Appended as raw bytes, because the 0x81 pair is not expressible as GBK text.
    appendFileSync(join(workspace, "mixed-row.js"), tail);
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "配置项|read", path: "mixed-row.js" });

    const lines = result.value.matches.map((m) => m.line);
    // The proved row is reported from the gbk decode...
    expect(lines).toContain("// 端口配置项");
    // ...and the row only the strict pass could see still gets its remedy: a
    // placeholder that NAMES the candidate encodings, rather than a bare one.
    const undecoded = lines.find((line) => line.includes("not valid UTF-8"));
    expect(undecoded).toBeDefined();
    expect(undecoded).toMatch(/candidates: /);
  });

  it("does not report a valid UTF-8 file that holds none of what the pattern matches", async () => {
    // The defect that the `strictClean` rule could not reach. That rule covers
    // lines the strict pass MATCHED, and this file has no `[一-龥]` line to match
    // — its only non-ASCII character is an em-dash, whose UTF-8 bytes decode to
    // CJK under `gbk`. So the `gbk` page proved the file, `big5` reported nothing
    // on that line to contradict it, and the mojibake `鈥` was adopted as the
    // line's text.
    //
    // Measured over four such files (em-dash, arrow, bullet, trademark) before the
    // fix: 4 of 4 reported a bogus match. The rule that removes them is `read`'s
    // own: strict UTF-8 settles a file's encoding before any guessing, so such a
    // file has exactly one correct reading and no page may claim it.
    const body = Array.from({ length: 40 }, (_, i) => `const key_${i} = value_${i};`).join("\n");
    // A subdirectory of its own, so the search root holds exactly these files:
    // every test in this suite shares one workspace, and `.` would report their
    // fixtures too.
    mkdirSync(join(workspace, "punct"), { recursive: true });
    for (const [name, line] of [
      ["dash.js", "// note — dash only"],
      ["arrow.js", "// flow → next"],
      ["bullet.js", "// item • bullet"],
      ["tm.js", "// brand™ mark"],
    ] as const) {
      writeFileSync(join(workspace, "punct", name), Buffer.from(`${body}\n${line}\n`, "utf8"));
    }
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "[一-龥]", path: "punct" });

    // None of these files holds a CJK character, so none of them may be reported.
    expect(result.value.matches).toEqual([]);
  });

  it("still reports a legacy file for the same class pattern", async () => {
    // The other side of that rule, and the reason it tests the BYTES rather than
    // the pattern or the page: a GBK file holding the same text must keep its
    // hits. `[一-龥]` narrows the candidates to `gbk, big5, utf16le, utf16be`, and
    // the GBK file is claimed by both legacy pages with contradicting text — so
    // the honest answer for that file is the candidate placeholder, which is what
    // this asserts: reported, never silently dropped.
    const body = Array.from({ length: 40 }, (_, i) => `const key_${i} = value_${i};`).join("\n");
    writeFileSync(
      join(workspace, "cjk-class.js"),
      iconv.encode(`${body}\n// 端口配置说明：中文注释\n`, "gbk"),
    );
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "[一-龥]", path: "cjk-class.js" });

    const lines = result.value.matches.map((m) => m.line);
    expect(lines).toHaveLength(1);
    // Either the decoded text or a placeholder naming the candidates is an
    // acceptable answer; a silent `Found 0 matches` is not.
    expect(lines[0] === "// 端口配置说明：中文注释" || /candidates: /.test(lines[0]!)).toBe(true);
  });

  it("does not let a UTF-16 page claim a BOM-less file of the OTHER order", async () => {
    // The same defect as the row above, in the second family that can produce it.
    // A UTF-16 page re-pairs the file's bytes, so its line numbers do not address
    // the file's real lines — and for a BOM-less UTF-16LE file the `utf16be`
    // re-pairing of the ASCII lines is itself CJK, so it matched `[一-龥]` at
    // "line 1" and that row was reported beside the correct line 41.
    //
    // `searchUnicodeFiles` gates every row it reports through `utf16OrderOfFile`
    // ("only the pass whose order the file's own bytes name may report it"); the
    // sweep ran the same two pages without that gate. This asserts the gate holds
    // on the sweep's path too.
    const body = Array.from({ length: 40 }, (_, i) => `const key_${i} = value_${i};`).join("\n");
    mkdirSync(join(workspace, "u16order"), { recursive: true });
    for (const [name, buf] of [
      ["le.js", Buffer.from(`${body}\n// 端口配置说明：中文注释\n`, "utf16le")],
      ["be.js", Buffer.from(`${body}\n// 端口配置说明：中文注释\n`, "utf16le").swap16()],
    ] as const) {
      writeFileSync(join(workspace, "u16order", name), buf);
    }
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "[一-龥]", path: "u16order" });

    // One row per file, at the line the text is really on — no re-paired "line 1".
    const byPath = new Map<string, Array<{ lineNumber: number; line: string }>>();
    for (const m of result.value.matches) {
      const key = m.path.replace(/^\.\\/, "").replace(/^u16order\\/, "");
      byPath.set(key, [...(byPath.get(key) ?? []), { lineNumber: m.lineNumber, line: m.line }]);
    }
    expect([...byPath.keys()].sort()).toEqual(["be.js", "le.js"]);
    for (const name of ["le.js", "be.js"]) {
      const rows = byPath.get(name);
      expect(rows).toHaveLength(1);
      expect(rows?.[0]?.line).toBe("// 端口配置说明：中文注释");
      expect(rows?.[0]?.lineNumber).toBe(41);
    }
  });

  it("searches a Big5 file holding traditional characters", async () => {
    fixture("big5.txt", sourceLike(["// 設定項目說明：連接埠設定"]), "big5");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "連接埠", path: "big5.txt" });
    expect(firstLine(result)).toBe("// 設定項目說明：連接埠設定");
  });

  it("searches a Shift-JIS file", async () => {
    fixture("sjis.txt", sourceLike(["// 設定項目の説明"]), "shift_jis");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "説明", path: "sjis.txt" });
    expect(firstLine(result)).toBe("// 設定項目の説明");
  });

  it("finds a BOM-LESS UTF-16 file with an ASCII pattern", async () => {
    // The case that made the two strategies disagree about one file. ripgrep
    // searches an ASCII pattern by its bytes, which are the same in every
    // encoding — but it only KNOWS a file is UTF-16 because of its BOM, so
    // without a mark it never looks inside and the file is missed entirely:
    // `Found 0 matches`, with no placeholder and no error. Measured.
    //
    // The non-ASCII path found such a file all along (its candidate list holds
    // the UTF-16 pages), so leaving this unfixed meant one file got two answers
    // depending on whether the pattern happened to contain a non-ASCII
    // character.
    fixture("le-nobom.js", sourceLike(["// PORT=8080 中文注释"]), "utf16le");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "PORT", path: "le-nobom.js" });
    expect(result.isError).toBe(false);
    expect(firstLine(result)).toBe("// PORT=8080 中文注释");
  });

  it("finds a BOM-less UTF-16BE file too", async () => {
    fixture("be-nobom.js", sourceLike(["// PORT=8080 中文注释"]), "utf16be");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "PORT", path: "be-nobom.js" });
    expect(firstLine(result)).toBe("// PORT=8080 中文注释");
  });

  it("does not let a UTF-16 pass claim a file in another encoding", async () => {
    // The UTF-16 passes run unconditionally on the ASCII path, so they must be
    // exact. Measured against a directory holding every legacy page this plugin
    // ships plus odd-length and NUL-padded binary files — all containing the
    // literal `PORT` — each pass claimed only genuinely UTF-16 files, with no
    // false positive on any of them. This pins that property, because a
    // spurious claim would OVERWRITE a correct decode in the merge (it keeps the
    // last entry per line).
    const lines = ["// PORT=8080 ASCII needle"];
    fixture("sp-gbk.js", sourceLike(lines), "gbk");
    fixture("sp-big5.js", sourceLike(lines), "big5");
    fixture("sp-sjis.js", sourceLike(lines), "shift_jis");
    fixture("sp-euckr.js", sourceLike(lines), "euc-kr");
    fixture("sp-1251.js", sourceLike(lines), "windows-1251");
    fixture("sp-utf8.js", sourceLike(lines), "utf8");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "PORT", path: "." });
    const byPath = new Map(result.value.matches.map((m) => [m.path.replace(/^\.\\/, ""), m.line]));

    // Every UTF-8 and single-byte page decodes this line to the same text, and
    // none of them may be replaced by a UTF-16 reading of their bytes.
    for (const name of ["sp-utf8.js", "sp-1251.js"]) {
      expect(byPath.get(name)).toBe("// PORT=8080 ASCII needle");
    }
    // The multi-byte pages may be refused (admission cannot rank them under the
    // default config), but they must never come back as UTF-16 MOJIBAKE. A
    // UTF-16 misreading of single-byte text produces control characters, so the
    // check is by code point rather than by a regex over a control range.
    for (const name of ["sp-gbk.js", "sp-big5.js", "sp-sjis.js", "sp-euckr.js"]) {
      const line = byPath.get(name) ?? "";
      const hasControl = [...line].some((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code < 0x20 && code !== 0x09;
      });
      expect(hasControl, `${name} came back as mojibake: ${JSON.stringify(line)}`).toBe(false);
    }
  });

  it("searches a UTF-32LE file, which ripgrep cannot be asked for at all", async () => {
    // `--encoding=utf-32le` exits 2 with "unknown encoding", so this file takes
    // the JavaScript fallback rather than the ripgrep path.
    const path = join(workspace, "u32.txt");
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0x00]),
        iconv.encode(sourceLike(["// 配置项 port=8080"]), "utf32le"),
      ]),
    );
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "配置项", path: "u32.txt" });
    expect(firstLine(result)).toBe("// 配置项 port=8080");
  });
});

describe("grep: encoding-independent behaviour", () => {
  it("returns a plain UTF-8 result with no placeholder and no second pass", async () => {
    fixture("plain.txt", "alpha\nbeta\nPORT=1\n", "utf8");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "PORT", path: "plain.txt" });
    expect(result.value.matches).toEqual([
      { path: "plain.txt", lineNumber: 3, line: "PORT=1" },
    ]);
  });

  it("reports zero matches without an error", async () => {
    fixture("none.txt", "alpha\nbeta\n", "utf8");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "not-present-anywhere", path: "none.txt" });
    expect(result.isError).toBe(false);
    expect(result.value.matches).toEqual([]);
    // The built-in's own wording for an empty result: a count header and an
    // empty body, not a sentence.
    expect(result.text).toContain("Found 0 matches");
  });

  it("honours the include filter", async () => {
    fixture("inc-a.txt", "NEEDLE\r\n", "utf8");
    fixture("inc-b.md", "NEEDLE\r\n", "utf8");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "NEEDLE", path: ".", include: "*.md" });
    // The display path keeps the search root's own prefix (ripgrep prints `.\`
    // for a `.` root), which is the built-in's behaviour too — the point here is
    // that only the matching file is reported.
    expect(result.value.matches).toHaveLength(1);
    expect(result.value.matches[0]?.path).toContain("inc-b.md");
  });

  it("reports a failed run with ripgrep's own message", async () => {
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    // An invalid regex is ripgrep's exit 2, and its stderr names the problem.
    const result = await grep(agent, { pattern: "([unclosed", path: "." });
    expect(result.isError).toBe(true);
  });
});

describe("grep: degraded deployments", () => {
  it("leaves the built-in grep in place when there is no subprocess service", async () => {
    const root = makeHost({ subprocess: false });
    const agent = makeAgent(root);
    apply(root);
    (root.emit as unknown as (name: string, payload: { agent: unknown }) => void)(
      "agent/session-start",
      { agent },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const scope = scopeOf(agent.ctx);
    // No subprocess means no encoding-aware grep. The important half is that the
    // six filesystem tools are still installed — declaring `subprocess` in
    // `inject` would have deactivated the whole plugin instead.
    expect(agent.ctx.tools.get(GREP_TOOL_NAME, scope)).toBeUndefined();
    expect(agent.ctx.tools.get("read", scope)).toBeDefined();
    expect(agent.ctx.tools.get("write", scope)).toBeDefined();
    expect(agent.ctx.tools.get("edit", scope)).toBeDefined();
  });

  it("keeps a placeholder with candidate encodings when the encoding is undecidable", async () => {
    // A SHORT GBK file that is almost entirely non-ASCII: measured, `gbk` and
    // `big5` score identically (107.5) on this content, so admission cannot rank
    // them and refuses. The placeholder then has to carry the candidates,
    // because that list is the whole remedy — the model can re-read the file with
    // one of them and search again.
    fixture("undecidable.txt", "配置项\r\n", "gbk");
    const root = makeHost();
    const agent = makeAgent(root);
    await install(root, agent);

    const result = await grep(agent, { pattern: "PORT|配置项", path: "undecidable.txt" });
    const line = firstLine(result) ?? "";
    // Either it decoded (and reports the text) or it could not (and reports
    // candidates). What must never happen is a bare placeholder with no way
    // forward — that is the built-in's behaviour this tool exists to improve on.
    if (line.includes("not valid UTF-8")) {
      expect(line).toMatch(/candidates: /);
    } else {
      expect(line).toBe("配置项");
    }
  });
});
