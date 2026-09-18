/**
 * The tools' `presentationMeta` — what the diff card actually displays.
 *
 * This layer had NO coverage, which is why the whole-file diff bug shipped: the
 * tools handed the card the full `before`/`after` texts, and the UI counted every
 * line of them, so a one-line edit read as "changed 2,400 lines". `diff-hunks.ts`
 * has its own tests, but they cannot catch a tool that does not CALL it — these
 * drive the real tool definitions, so reverting either call site fails here.
 *
 * The tools are built against a real `Context` with the real sandboxed backend,
 * because `buildWriteTool`/`buildEditTool` read `ctx.fs` at execute time; only
 * `presentationMeta` is invoked, so no file is touched.
 */

import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { EncodingSandbox } from "../src/sandbox.js";
import { buildEditTool } from "../src/tool-edit.js";
import { buildWriteTool } from "../src/tool-write.js";
import { mk, uiCount, type Diff, type JsonValue } from "./diff-card-helpers.js";

function makeTools() {
  const root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: process.cwd() }),
  });
  new SandboxedFileSystem(root, { cwd: process.cwd(), diffBasisMaxBytes: 1024 * 1024 });
  const sandbox = new EncodingSandbox(root);
  return { write: buildWriteTool(root, sandbox), edit: buildEditTool(root, sandbox) };
}

/** Invoke a tool's `presentationMeta` (it lives under `output`). */
function metaOf(tool: ReturnType<typeof buildEditTool>, args: unknown, value: unknown): Diff[] {
  const fn = tool.output?.presentationMeta;
  if (fn === undefined) throw new Error("tool has no presentationMeta");
  // Two-step assertion: the declared parameter is `JsonValue`, which the opaque
  // `unknown` a test naturally holds does not overlap with.
  return (fn(args as JsonValue, value as JsonValue) as unknown as { diffs: Diff[] }).diffs;
}

/** Invoke a tool's `render` and return the text the model would see. */
function textOf(tool: ReturnType<typeof buildEditTool>, args: unknown, value: unknown): string {
  const fn = tool.output?.render;
  if (fn === undefined) throw new Error("tool has no render");
  const parts = fn(args as JsonValue, value as JsonValue) as unknown as Array<{
    type: string;
    text: string;
  }>;
  return parts.map((p) => p.text).join("");
}

describe("tool presentationMeta reports changed regions only", () => {
  it("edit: a one-line change in a long file is not a whole-file diff", () => {
    const { edit } = makeTools();
    const before = mk(2400);
    const after = before.replace("line 1200", "LINE 1200");

    const diffs = metaOf(
      edit,
      { file_path: "WeiPicSc.h" },
      { path: "WeiPicSc.h", before, after },
    );

    const { added, removed } = uiCount(diffs);
    // Two regressions in one number: the whole file (2400/2400) and the context
    // lines (7/7) are both gone. The card now shows the changed line only.
    expect(removed).toBe(1);
    expect(added).toBe(1);
    expect(diffs[0]!.path).toBe("WeiPicSc.h");
  });

  it("edit: an unchanged line never reaches the card", () => {
    // `FileDiff` cannot mark a line as context, so any context line would render
    // as a deletion AND an addition. The card must contain only changed lines.
    const { edit } = makeTools();
    const before = mk(2400);
    const after = before.replace("line 1200", "LINE 1200");

    const diffs = metaOf(edit, { file_path: "f.txt" }, { path: "f.txt", before, after });

    expect(diffs[0]!.oldText).toBe("line 1200");
    expect(diffs[0]!.newText).toBe("LINE 1200");
  });

  it("write: a one-line change in a long file is not a whole-file diff", () => {
    const { write } = makeTools();
    const before = mk(2400);
    const after = before.replace("line 1200", "LINE 1200");

    const diffs = metaOf(
      write,
      { file_path: "WeiPicSc.h" },
      { path: "WeiPicSc.h", operation: "update", before, after },
    );

    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
  });

  it("write: a created file reports no diffs", () => {
    // `before: null` means the file did not exist; there is nothing to diff
    // against, and the card shows no diff block.
    const { write } = makeTools();
    const diffs = metaOf(
      write,
      { file_path: "new.txt" },
      { path: "new.txt", operation: "create", before: null, after: "hello\n" },
    );

    expect(diffs).toEqual([]);
  });

  it("edit: scattered changes produce separate hunks", () => {
    const { edit } = makeTools();
    const before = mk(100);
    const after = before.replace("line 5", "A").replace("line 50", "B").replace("line 95", "C");

    const diffs = metaOf(edit, { file_path: "f.txt" }, { path: "f.txt", before, after });

    expect(diffs).toHaveLength(3);
    expect(uiCount(diffs)).toEqual({ added: 3, removed: 3 });
  });

  it("edit: an unchanged file reports no diffs", () => {
    const { edit } = makeTools();
    const text = mk(20);
    const diffs = metaOf(edit, { file_path: "f.txt" }, { path: "f.txt", before: text, after: text });

    expect(diffs).toEqual([]);
  });
});

describe("the message the model sees carries the size of the change", () => {
  it("edit: keeps the built-in wording and appends real changed-line counts", () => {
    const { edit } = makeTools();
    const before = mk(2400);
    const after = before.replace("line 1200", "LINE 1200");

    const text = textOf(
      edit,
      { file_path: "src/foo.ts" },
      { path: "src/foo.ts", before, after },
    );

    // The built-in sentence is preserved (this plugin is a drop-in replacement),
    // with the change size appended.
    expect(text).toBe(
      "The file src/foo.ts has been updated successfully. Added 1 line(s), removed 1 line(s).",
    );
  });

  it("edit: the card and the message report the same number", () => {
    // The whole point of dropping context: both surfaces now describe the same
    // change, so a reader never sees "Added 1 line(s)" beside a card claiming 7.
    const { edit } = makeTools();
    const before = mk(2400);
    const after = before.replace("line 1200", "LINE 1200");

    const text = textOf(edit, { file_path: "f.txt" }, { path: "f.txt", before, after });
    const diffs = metaOf(edit, { file_path: "f.txt" }, { path: "f.txt", before, after });
    const cardLines = diffs[0]!.oldText!.split("\n").length;

    expect(text).toContain("Added 1 line(s), removed 1 line(s).");
    expect(cardLines).toBe(1);
  });

  it("edit: preserves the replace_all wording", () => {
    const { edit } = makeTools();
    const text = textOf(
      edit,
      { file_path: "f.txt", replace_all: true },
      { path: "f.txt", before: "a\n", after: "b\n" },
    );

    expect(text).toBe(
      "The file f.txt has been updated. All occurrences were successfully replaced. " +
        "Added 1 line(s), removed 1 line(s).",
    );
  });

  it("edit: says nothing extra when the content is identical", () => {
    const { edit } = makeTools();
    const text = mk(10);
    const rendered = textOf(edit, { file_path: "f.txt" }, { path: "f.txt", before: text, after: text });

    expect(rendered).toBe("The file f.txt has been updated successfully.");
  });

  it("write: reports a created file's total line count inside the content block", () => {
    const { write } = makeTools();
    const text = textOf(
      write,
      { file_path: "new.txt" },
      { path: "new.txt", operation: "create", before: null, after: "a\nb\nc\n" },
    );

    // The summary belongs INSIDE `<content>`, not after `</content>`.
    expect(text).toBe(
      "<path>new.txt</path>\n<type>file</type>\n<content>\nCreated file (3 line(s))\n</content>",
    );
    // A creation has no before-side, so it must not claim removals.
    expect(text).not.toContain("removed");
  });

  it("write: reports an update with added/removed counts", () => {
    const { write } = makeTools();
    const before = mk(2400);
    const after = before.replace("line 1200", "LINE 1200");

    const text = textOf(
      write,
      { file_path: "f.txt" },
      { path: "f.txt", operation: "update", before, after },
    );

    expect(text).toContain("Updated file (added 1, removed 1 line(s))");
  });

  it("write: a created empty file reports zero lines", () => {
    const { write } = makeTools();
    const text = textOf(
      write,
      { file_path: "empty.txt" },
      { path: "empty.txt", operation: "create", before: null, after: "" },
    );

    expect(text).toContain("Created file (0 line(s))");
  });

  it("write: an unchanged update adds no parenthetical", () => {
    const { write } = makeTools();
    const text = mk(10);
    const rendered = textOf(
      write,
      { file_path: "f.txt" },
      { path: "f.txt", operation: "update", before: text, after: text },
    );

    expect(rendered).toBe(
      "<path>f.txt</path>\n<type>file</type>\n<content>\nUpdated file\n</content>",
    );
  });

  it("write: an update whose baseline read failed reports a total, not a fake diff", () => {
    // `before: null` on an `update` means the presentation read of the previous
    // content failed — NOT that the file was empty. `operation` is `"update"`,
    // so the tool stat'ed the file and knows it exists. Diffing against `""`
    // would claim the whole file was added and nothing was removed: a statement
    // about content the tool never saw, and one the empty card contradicts.
    const { write } = makeTools();
    const after = mk(2400);

    const text = textOf(
      write,
      { file_path: "f.txt" },
      { path: "f.txt", operation: "update", before: null, after },
    );

    expect(text).toBe(
      "<path>f.txt</path>\n<type>file</type>\n<content>\nUpdated file (2400 line(s))\n</content>",
    );
    // The false half of the old wording: it asserted nothing was removed.
    expect(text).not.toContain("removed");
    // And the card agrees — no diff to show, because there is no honest one.
    expect(metaOf(write, { file_path: "f.txt" }, { path: "f.txt", operation: "update", before: null, after })).toEqual([]);
  });
});

describe("the card and the message share one diff", () => {
  it("edit: both callbacks report the same change", () => {
    // The harness calls `render` then `presentationMeta` for one result. Deriving
    // them from two independent diffs is both wasted work and a chance for the
    // card and the message to disagree; `diffForResult` memoizes per result.
    // With no context lines the two numbers are now the same one.
    const { edit } = makeTools();
    const before = mk(400);
    const after = before.replace("line 200", "LINE 200");
    const value = { path: "f.txt", before, after };

    const text = textOf(edit, { file_path: "f.txt" }, value);
    const diffs = metaOf(edit, { file_path: "f.txt" }, value);

    expect(text).toContain("Added 1 line(s), removed 1 line(s).");
    expect(uiCount(diffs)).toEqual({ added: 1, removed: 1 });
  });

  it("edit: the card is stamped with the path the edit ran against", () => {
    // The path comes from the RESULT, so a caller using the `path` alias rather
    // than `file_path` still gets a correctly labelled card.
    const { edit } = makeTools();
    const text = mk(40);

    const diffs = metaOf(
      edit,
      { path: "aliased.txt" },
      { path: "aliased.txt", before: text, after: text.replace("line 20", "X") },
    );

    expect(diffs[0]!.path).toBe("aliased.txt");
  });
});
