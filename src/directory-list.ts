/**
 * Directory listing for `str_replace_editor`'s `view` command.
 *
 * The harness's own `view` lists a directory as `type<TAB>path` rows, two levels
 * deep, excluding hidden entries plus `node_modules` and `__pycache__`. That shape
 * is reproduced here rather than approximated, because the model reads it with the
 * habits its training gave it — a different format is a small, silent handicap.
 *
 * Written against `ctx.fs.listDir` rather than forwarded to the harness package:
 * that package exports only `apply` / `Config` / `inject` / `name`, so its
 * `listDirectory` is module-private and cannot be called from outside. Going
 * through `ctx.fs` also keeps the sandbox and target resolution identical to every
 * other tool here.
 *
 * @module dsh-fs-encoding/directory-list
 */

import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";

/** How deep the listing descends below the named directory, matching the harness. */
export const LISTING_MAX_DEPTH = 2;

/**
 * How many rows the listing may emit before it is cut off.
 *
 * The harness truncates its listing by character count (`maxOutputChars`); a row
 * cap is the same protection in the unit this function actually builds. Without
 * one, a directory holding tens of thousands of entries (an un-ignored `dist/` or
 * `build/`) produces a result of that many rows, which is then sorted whole and
 * joined into a single string — all of it entering the result value, the session
 * log and, in the worst case, the model's context.
 */
export const LISTING_MAX_ROWS = 2000;

/**
 * Entries the listing hides.
 *
 * `node_modules` and `__pycache__` are named explicitly because they are the two
 * directories that reliably swamp a listing while never being what a reader wants
 * — the harness excludes exactly these, so the two agree.
 */
function isHidden(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === "__pycache__";
}

/** One row's leading type marker, the harness's `d` / `f` / `?` vocabulary. */
function typeMarker(type: "file" | "directory" | "other"): string {
  if (type === "directory") return "d";
  if (type === "file") return "f";
  return "?";
}

/**
 * Order two paths the way a code-point comparison does.
 *
 * Deliberately NOT `localeCompare`: that orders case-insensitively and by locale,
 * so the same directory would list differently on two machines and a model
 * comparing two listings would see spurious differences. The harness sorts by code
 * point, so this does too.
 *
 * @param left - one path.
 * @param right - the other.
 * @returns a negative, zero, or positive number, as `Array.sort` expects.
 */
function codepointCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Render a directory tree as the harness's `view` does.
 *
 * @param fs - the filesystem service.
 * @param target - the resolved directory to list.
 * @param signal - aborts the listing.
 * @returns the listing text, ready to hand to the model.
 */
export async function listDirectory(
  fs: FileSystem,
  target: FsTarget,
  signal?: AbortSignal,
): Promise<string> {
  const rows: string[] = [`d\t${target.displayPath}`];
  let truncated = false;

  const visit = async (dir: FsTarget, depth: number): Promise<void> => {
    if (truncated) return;
    const entries = await fs.listDir(dir, signal);
    for (const entry of entries) {
      if (isHidden(entry.name)) continue;
      if (rows.length >= LISTING_MAX_ROWS) {
        truncated = true;
        return;
      }
      rows.push(`${typeMarker(entry.type)}\t${entry.target.displayPath}`);
      if (entry.type === "directory" && depth < LISTING_MAX_DEPTH) {
        await visit(entry.target, depth + 1);
        if (truncated) return;
      }
    }
  };

  await visit(target, 1);

  // The root row is stamped before the walk, so sort the whole set — the harness
  // does the same, which is what puts the root in its path order rather than first.
  rows.sort((left, right) =>
    codepointCompare(
      left.slice(left.indexOf("\t") + 1),
      right.slice(right.indexOf("\t") + 1),
    ),
  );

  // Say so when the cap bit: a listing that silently stops looks like a complete
  // directory, and the model would conclude the remaining files do not exist.
  const note = truncated
    ? `\n[Truncated at ${LISTING_MAX_ROWS} entries; more exist but are not listed.]`
    : "";

  return (
    `Here're the files and directories up to ${LISTING_MAX_DEPTH} levels deep in ` +
    `${target.displayPath}, excluding hidden items, node_modules, and Python cache ` +
    `directories:\n${rows.join("\n")}\n${note}`
  );
}
