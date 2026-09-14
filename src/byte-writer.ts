/**
 * Byte-level atomic file replacement.
 *
 * The harness's `FileSystem` seam has `readBytes` but no `writeBytes`: its only
 * mutation entry point takes a `string` and encodes it as UTF-8 internally. To
 * preserve a file's original encoding this plugin must publish raw bytes, and
 * it must do so without losing the guarantees `ctx.fs.writeText` provides —
 * atomicity, permission preservation, and hard-link safety.
 *
 * That is what this module is: `ctx.fs.writeText`'s storage mechanics,
 * reimplemented over `Uint8Array`. It is deliberately the ONLY place in the
 * plugin that touches `node:fs` for writing.
 *
 * @module dsh-fs-encoding/byte-writer
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Temp-file prefix; the UUID suffix makes it recognizable and collision-free. */
const TEMP_PREFIX = ".tmp-";

/** Matches exactly the temp names this module creates, so sweeping cannot delete a user file. */
const TEMP_UUID_RE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A crashed write's temp file is garbage after this long. */
const STALE_TEMP_MS = 60 * 60 * 1000;

/** Directories already swept this process — one pass per dir is enough. */
const sweptDirs = new Set<string>();

function errCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * Remove temp files this module left behind in an earlier crashed run.
 *
 * Only names matching {@link TEMP_UUID_RE} are candidates, and only when they
 * are older than an hour, so a concurrent write in another process is never
 * disturbed. Failures are swallowed: sweeping is hygiene, not correctness.
 */
async function sweepStaleTemps(dir: string): Promise<void> {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !TEMP_UUID_RE.test(entry.name)) continue;
      const tempPath = join(dir, entry.name);
      try {
        const info = await stat(tempPath);
        if (now - info.mtimeMs > STALE_TEMP_MS) await rm(tempPath, { force: true });
      } catch {
        // Raced with another sweeper or a permission hiccup — not fatal.
      }
    }
  } catch {
    // Directory unreadable — nothing to sweep.
  }
}

/**
 * fsync the parent directory so the rename itself is durable.
 *
 * POSIX only: Windows cannot open a directory for `fsync`, and its rename is
 * already durable through the filesystem's own metadata journaling.
 */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best-effort durability; the rename already succeeded.
  }
}

/** What the target looked like before the write, when it existed. */
interface ExistingTarget {
  mode: number;
  /** Link count — above 1, a rename would silently detach the other names. */
  nlink: number;
}

async function statExisting(path: string): Promise<ExistingTarget | undefined> {
  try {
    const info = await stat(path);
    return { mode: info.mode & 0o7777, nlink: info.nlink };
  } catch (error) {
    if (errCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Replace `path` with `bytes` atomically.
 *
 * Writes a random-suffix sibling opened with exclusive create, then renames it
 * over the target, so a reader observes either the complete old content or the
 * complete new content — never a partial write. Three details are load-bearing
 * and are each a bug that was already paid for once in the harness's own
 * implementation:
 *
 * 1. **Hard links are written in place.** `rename` would give the target a new
 *    inode and silently detach every other name pointing at the old one.
 * 2. **Permission bits are carried over** by `chmod`-ing the temp file before
 *    the rename, so a private file does not become world-readable.
 * 3. **Windows `EPERM`/`EACCES`/`EBUSY` falls back to an in-place write.**
 *    Windows refuses to rename over a file another process holds open; the
 *    content still lands, just without the atomicity guarantee.
 *
 * @param path - absolute path to replace.
 * @param bytes - the complete new content.
 * @throws whatever the underlying filesystem raises, after cleaning up the temp file.
 */
export async function writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const existing = await statExisting(path);

  // A rename would break the link, so a multiply-linked file is written through.
  if (existing !== undefined && existing.nlink > 1) {
    await writeFile(path, bytes);
    return;
  }

  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await sweepStaleTemps(dir);

  const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    // A Buffer is required for the byte path; a plain Uint8Array view is
    // accepted by the same call but keeping it explicit avoids an encoding
    // default ever creeping back in.
    await handle.writeFile(Buffer.from(bytes));
    if (existing !== undefined) await handle.chmod(existing.mode);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  try {
    await handle.close();
    await rename(tempPath, path);
    await syncDir(dir);
  } catch (error) {
    const code = errCode(error);
    if (
      process.platform === "win32" &&
      (code === "EPERM" || code === "EACCES" || code === "EBUSY")
    ) {
      try {
        await writeFile(path, bytes);
        return;
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Test seam: forget which directories were swept. */
export function resetSweepCache(): void {
  sweptDirs.clear();
}
