/**
 * Lazy, failure-tolerant loading of the search toolkit.
 *
 * The encoding-aware `grep` reuses several things from
 * `@deepseek-ai/dsh-tool-fs-search` rather than re-deriving them — the ripgrep
 * argv builder, the argument validator, the pending/completed card presenters,
 * the output formatter, and the shared caps. Re-deriving them would mean two
 * implementations of one contract, and the search card in particular is a
 * contract the CLIENT reads.
 *
 * ## Why the import is dynamic
 *
 * That package is what MOUNTS the built-in `grep`, and a deployment need not
 * have it: the `minimal` agent preset ships no `tool-fs-search` row at all,
 * while `dsh-web-app` disables the host-plane one and lets each preset re-add
 * it. A static `import` would therefore be a load-time failure of THIS plugin in
 * such a deployment — taking `read`, `write` and `edit` down with it, which is
 * the same trap `inject` sets and the reason `subprocess` is read with `ctx.get`
 * too. The failure has to cost `grep` and nothing else.
 *
 * So the module is imported once, on first use, through a memoized promise that
 * resolves to `undefined` when the package is absent. Every caller then treats
 * "no toolkit" exactly like "no subprocess": the built-in `grep` stays in place.
 *
 * The import is also where a genuine version skew would surface. The plugin's
 * peer range spans four DSH release lines, and a package that renamed
 * `presentGrepCall` would otherwise fail at module load; here it degrades to
 * "this plugin does not provide grep", which is survivable and diagnosable.
 *
 * @module dsh-fs-encoding/search-kit
 */

/** The shape of the toolkit, taken from the package's own types. */
export type SearchKitModule = typeof import("@deepseek-ai/dsh-tool-fs-search");

/**
 * The retention primitives, loaded alongside the search toolkit.
 *
 * `ItemRetainer` is what applies the inline match cap, and the built-in's own
 * `retainGrepMatches` wrapper is not exported — so this plugin drives the
 * retainer directly, through the SAME class, which is what keeps the cap
 * semantics and the truncation footer identical between the two tools.
 *
 * It rides this load rather than one of its own because the two are needed
 * together or not at all: retention exists here only to cap a grep result, and
 * the package that provides it is a peer of the search toolkit.
 */
export type RetainerCtor = typeof import("@deepseek-ai/dsh-output-retention").ItemRetainer;

/** Everything the encoding-aware `grep` needs from its sibling packages. */
export interface SearchKit {
  /** The search toolkit's exports. */
  kit: SearchKitModule;
  /** The inline-cap retainer, shared with the built-in's retention semantics. */
  ItemRetainer: RetainerCtor;
}

/**
 * The members this plugin actually calls.
 *
 * Checked at load rather than trusted, because the peer range spans several
 * release lines and a missing member would otherwise throw at the first search
 * — inside a tool call, where the model sees it as a search failure rather than
 * as a broken install.
 */
const REQUIRED_MEMBERS = [
  "buildGrepCommand",
  "parseGrepArgs",
  "presentGrepCall",
  "presentGrepResult",
  "previewLine",
  "formatGrepOutput",
  "toWorkdirRelative",
  "trySaveFormattedResult",
  "resolveRgPath",
] as const;

/** The memoized load, so the module is imported at most once per process. */
let pending: Promise<SearchKit | undefined> | undefined;

/**
 * Import the search toolkit, or answer `undefined` when it is unusable.
 *
 * Never rejects: a missing package, a package whose entry point throws on load,
 * and a package missing a member this plugin needs all resolve to `undefined`,
 * because the caller's response is the same in every case — leave `grep` to the
 * built-in.
 *
 * @param onUnavailable - called once with the reason, for the operator log.
 * @returns the toolkit, or `undefined`.
 */
export function loadSearchKit(
  onUnavailable: (reason: string) => void,
): Promise<SearchKit | undefined> {
  pending ??= (async () => {
    let kit: SearchKitModule;
    let retention: typeof import("@deepseek-ai/dsh-output-retention");
    try {
      [kit, retention] = await Promise.all([
        import("@deepseek-ai/dsh-tool-fs-search"),
        import("@deepseek-ai/dsh-output-retention"),
      ]);
    } catch (error) {
      onUnavailable(
        `a required package could not be imported (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return undefined;
    }
    // The member check lives inside its own `try` because a module namespace is
    // not guaranteed to answer a missing property with `undefined`: an ESM
    // namespace does, but an instrumented or proxied one (a test double, a
    // bundler's interop shim, a runtime that traps `get`) may throw instead. An
    // uncaught throw here would reject the memoized promise and surface as a
    // failed search rather than as "this deployment has no grep", which is the
    // exact distinction this module exists to preserve.
    try {
      const missing = REQUIRED_MEMBERS.filter(
        (member) => typeof (kit as Record<string, unknown>)[member] !== "function",
      );
      if (missing.length > 0) {
        onUnavailable(`the installed search toolkit does not export ${missing.join(", ")}`);
        return undefined;
      }
      if (typeof retention.ItemRetainer !== "function") {
        onUnavailable("the installed output-retention package does not export ItemRetainer");
        return undefined;
      }
      return { kit, ItemRetainer: retention.ItemRetainer };
    } catch (error) {
      onUnavailable(
        `the installed search packages could not be inspected (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return undefined;
    }
  })();
  return pending;
}

/**
 * Reset the memoized load.
 *
 * Test-only. A suite that wants to exercise both the available and the
 * unavailable path in one process cannot do so while the first answer is cached,
 * and re-importing a genuinely absent package is the only way to observe the
 * degradation.
 */
export function resetSearchKitForTests(): void {
  pending = undefined;
}
