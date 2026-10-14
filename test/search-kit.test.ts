/**
 * Tests for the lazy search-toolkit load.
 *
 * This module exists for one reason: `@deepseek-ai/dsh-tool-fs-search` is what
 * MOUNTS the built-in `grep`, and a deployment need not have it — the `minimal`
 * agent preset ships no `tool-fs-search` row, and `dsh-web-app` disables the
 * host-plane one and lets each preset re-add it. A static import would make this
 * plugin fail to LOAD there, taking `read` / `write` / `edit` down with it.
 *
 * So the failure path is the point of the module, and it is what these tests
 * pin: an absent package, a package that throws on load, and a package missing a
 * member this plugin calls must all resolve to `undefined` rather than reject.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** The reasons reported to the operator log, one per load attempt. */
const reasons: string[] = [];

afterEach(() => {
  reasons.length = 0;
  vi.resetModules();
  vi.doUnmock("@deepseek-ai/dsh-tool-fs-search");
  vi.doUnmock("@deepseek-ai/dsh-output-retention");
});

describe("loadSearchKit", () => {
  it("resolves the toolkit when both packages are present", async () => {
    const { loadSearchKit, resetSearchKitForTests } = await import("../src/search-kit.js");
    resetSearchKitForTests();

    const kit = await loadSearchKit((reason) => reasons.push(reason));

    expect(kit).toBeDefined();
    expect(typeof kit?.kit.buildGrepCommand).toBe("function");
    expect(typeof kit?.ItemRetainer).toBe("function");
    expect(reasons).toEqual([]);
  });

  it("answers undefined, not a rejection, when the toolkit cannot be imported", async () => {
    // The whole point: `grep` degrades, the other six tools do not.
    vi.doMock("@deepseek-ai/dsh-tool-fs-search", () => {
      throw new Error("simulated: package not installed");
    });
    const { loadSearchKit, resetSearchKitForTests } = await import("../src/search-kit.js");
    resetSearchKitForTests();

    const kit = await loadSearchKit((reason) => reasons.push(reason));

    expect(kit).toBeUndefined();
    expect(reasons).toHaveLength(1);
    // The message names the failure rather than claiming a cause it cannot know:
    // an absent package and a package that throws on load are indistinguishable
    // from here, and both mean the same thing to the operator.
    expect(reasons[0]).toContain("could not be imported");
  });

  it("answers undefined when the toolkit loads but is missing a member this plugin calls", async () => {
    // The version-skew case: the peer range spans four DSH release lines, and a
    // release that renamed a presenter would otherwise throw at the first search
    // — inside a tool call, where the model reads it as a failed search rather
    // than as a broken install.
    vi.doMock("@deepseek-ai/dsh-tool-fs-search", () => {
      // A deliberately INCOMPLETE stand-in: the members this plugin calls are
      // absent, which is exactly the shape a renamed export produces.
      return { GREP_MAX_MATCHES: 250 };
    });
    const { loadSearchKit, resetSearchKitForTests } = await import("../src/search-kit.js");
    resetSearchKitForTests();

    const kit = await loadSearchKit((reason) => reasons.push(reason));

    expect(kit).toBeUndefined();
    expect(reasons).toHaveLength(1);
    // Two messages are acceptable here, and both are honest: a namespace that
    // simply lacks the member reports "does not export", while one that THROWS
    // on the missing property (a proxy, a bundler shim) reports "could not be
    // inspected". Either way the promise resolves rather than rejecting, which
    // is the property that matters.
    expect(reasons[0]).toMatch(/does not export|could not be inspected/);
  });

  it("answers undefined when the retention package lacks ItemRetainer", async () => {
    // The retainer is what applies the inline cap; without it a broad search
    // would return every match inline instead of spilling the remainder.
    vi.doMock("@deepseek-ai/dsh-output-retention", () => ({}));
    const { loadSearchKit, resetSearchKitForTests } = await import("../src/search-kit.js");
    resetSearchKitForTests();

    const kit = await loadSearchKit((reason) => reasons.push(reason));

    expect(kit).toBeUndefined();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/ItemRetainer|could not be inspected/);
  });

  it("imports at most once, so a failure is not retried per agent", async () => {
    const { loadSearchKit, resetSearchKitForTests } = await import("../src/search-kit.js");
    resetSearchKitForTests();

    const first = await loadSearchKit((reason) => reasons.push(reason));
    const second = await loadSearchKit((reason) => reasons.push(reason));

    expect(first).toBe(second);
    expect(reasons).toEqual([]);
  });
});
