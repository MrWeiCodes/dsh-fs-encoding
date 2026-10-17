/**
 * The `read` tool's card projection.
 *
 * The client builds its file card from `presentationMeta`, not from `render`:
 * `readMeta` in `dsh-client-ui-tool` narrows
 * `{ path, offset, lines, totalLines }` and returns `null` unless `totalLines` is
 * a number, which silently degrades every read to the generic text card. This
 * tool shipped without `totalLines`, so the card never appeared — the model saw
 * the right text the whole time, which is why nothing caught it.
 *
 * The assertions below mirror the client's own predicate field for field rather
 * than asserting "not undefined": a projection that carries `totalLines: NaN`
 * or a stale count would pass the loose version and still render the wrong
 * footer.
 */

import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { buildReadTool } from "../src/tool-read.js";

function makeReadTool() {
  const root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: process.cwd() }),
  });
  new SandboxedFileSystem(root, { cwd: process.cwd(), diffBasisMaxBytes: 1024 * 1024 });
  return buildReadTool(root);
}

/** Invoke `presentationMeta` on a synthetic canonical value. */
function metaOf(value: unknown): Record<string, unknown> {
  const fn = makeReadTool().output?.presentationMeta;
  if (fn === undefined) throw new Error("read has no presentationMeta");
  return fn({}, value as never) as unknown as Record<string, unknown>;
}

/**
 * The client's acceptance rule, transcribed from `readMeta`.
 *
 * @param meta - the projection this tool produced.
 * @returns whether the client would render a file card for it.
 */
function clientAccepts(meta: Record<string, unknown>): boolean {
  const { path, offset, lines, totalLines, lang } = meta;
  if (typeof path !== "string") return false;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1) return false;
  if (typeof totalLines !== "number" || !Number.isInteger(totalLines) || totalLines < 0) return false;
  if (lang !== undefined && typeof lang !== "string") return false;
  if (!Array.isArray(lines)) return false;
  let previous = offset - 1;
  for (const line of lines) {
    if (typeof line !== "object" || line === null || Array.isArray(line)) return false;
    const { number, text } = line as { number: unknown; text: unknown };
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return false;
    if (number <= previous) return false;
    if (number > totalLines) return false;
    if (typeof text !== "string") return false;
    previous = number;
  }
  return true;
}

describe("read: the card projection satisfies the client's contract", () => {
  it("carries the file's total line count, which the client requires", () => {
    const meta = metaOf({
      path: "/tmp/example.txt",
      offset: 1,
      lines: [
        { number: 1, text: "alpha" },
        { number: 2, text: "beta" },
      ],
      totalLines: 2,
    });
    expect(meta.totalLines).toBe(2);
    expect(clientAccepts(meta)).toBe(true);
  });

  it("keeps a windowed read's offset, so the client numbers the right lines", () => {
    const meta = metaOf({
      path: "/tmp/example.txt",
      offset: 41,
      lines: [
        { number: 41, text: "alpha" },
        { number: 42, text: "beta" },
      ],
      totalLines: 100,
    });
    expect(meta.offset).toBe(41);
    expect(meta.totalLines).toBe(100);
    expect(clientAccepts(meta)).toBe(true);
  });

  it("accepts an empty window, which a blank file produces", () => {
    // `read` reports `totalLines: 0` for text that is nothing but newlines, and
    // the client accepts a zero total with no lines. A projection that dropped
    // `totalLines` for the empty case would fail here while passing the two
    // populated cases above.
    const meta = metaOf({ path: "/tmp/blank.txt", offset: 1, lines: [], totalLines: 0 });
    expect(meta.totalLines).toBe(0);
    expect(clientAccepts(meta)).toBe(true);
  });
});
