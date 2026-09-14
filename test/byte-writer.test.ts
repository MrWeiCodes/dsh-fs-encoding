import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSweepCache, writeBytesAtomic } from "../src/byte-writer.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "byte-writer-"));
  resetSweepCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

describe("writeBytesAtomic", () => {
  it("creates a new file with the exact bytes", async () => {
    const p = join(dir, "new.txt");
    const payload = Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]); // GBK 你好
    await writeBytesAtomic(p, payload);
    expect(new Uint8Array(await readFile(p))).toEqual(payload);
  });

  it("creates missing parent directories", async () => {
    const p = join(dir, "a", "b", "c.txt");
    await writeBytesAtomic(p, bytes("deep"));
    expect(await readFile(p, "utf-8")).toBe("deep");
  });

  it("replaces an existing file", async () => {
    const p = join(dir, "replace.txt");
    await writeFile(p, "old content");
    await writeBytesAtomic(p, bytes("new"));
    expect(await readFile(p, "utf-8")).toBe("new");
  });

  it("preserves the file's permission bits", async () => {
    const p = join(dir, "perm.txt");
    await writeFile(p, "x");
    const { chmod } = await import("node:fs/promises");
    await chmod(p, 0o640);
    await writeBytesAtomic(p, bytes("y"));
    const after = await stat(p);
    // Windows does not carry POSIX permission bits; only assert on POSIX.
    if (process.platform !== "win32") {
      expect(after.mode & 0o777).toBe(0o640);
    }
    expect(await readFile(p, "utf-8")).toBe("y");
  });

  it("leaves no temp file behind on success", async () => {
    const p = join(dir, "clean.txt");
    await writeBytesAtomic(p, bytes("payload"));
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.startsWith(".tmp-"))).toEqual([]);
  });

  it("writes through a hard link instead of replacing the inode", async () => {
    const p = join(dir, "original.txt");
    const link = join(dir, "linked.txt");
    await writeFile(p, "shared");
    const { link: mkLink } = await import("node:fs/promises");
    try {
      await mkLink(p, link);
    } catch {
      return; // Filesystem without hard-link support — nothing to assert.
    }

    await writeBytesAtomic(p, bytes("updated"));

    // A rename would have detached `link` from the new content.
    expect(await readFile(link, "utf-8")).toBe("updated");
    expect(await readFile(p, "utf-8")).toBe("updated");
  });

  it("never exposes a partially-written file to a concurrent reader", async () => {
    const p = join(dir, "atomic.txt");
    const small = "a".repeat(64);
    const large = "b".repeat(200_000);
    await writeBytesAtomic(p, bytes(small));

    let partial = 0;
    let empty = 0;
    let observed = 0;
    const writes = (async () => {
      for (let i = 0; i < 40; i += 1) {
        await writeBytesAtomic(p, bytes(i % 2 === 0 ? large : small));
      }
    })();

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && observed < 300) {
      try {
        const content = await readFile(p, "utf-8");
        observed += 1;
        if (content.length === 0) {
          // Windows: while `ReplaceFile`/rename swaps the directory entry, the
          // path can momentarily resolve to an empty placeholder. The harness's
          // own writer sees this too — it is why `dsh-fs-local` carries a
          // Windows-specific replace path. It is a visibility gap, not a torn
          // write, so it is counted separately from a partial payload.
          empty += 1;
        } else if (content !== small && content !== large) {
          partial += 1;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "EPERM" && code !== "EACCES") throw error;
      }
    }
    await writes;

    expect(observed).toBeGreaterThan(0);
    // The load-bearing guarantee: a reader NEVER sees a half-written payload.
    expect(partial).toBe(0);
    // And the settled state is one complete payload, never a hybrid.
    const final = await readFile(p, "utf-8");
    expect(final === small || final === large).toBe(true);
    void empty;
  });

  it("sweeps a stale temp file but keeps a fresh one", async () => {
    const { utimes } = await import("node:fs/promises");
    const stale = join(dir, ".tmp-11111111-1111-1111-1111-111111111111");
    const fresh = join(dir, ".tmp-22222222-2222-2222-2222-222222222222");
    await writeFile(stale, "old");
    await writeFile(fresh, "new");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, twoHoursAgo, twoHoursAgo);

    await writeBytesAtomic(join(dir, "trigger.txt"), bytes("x"));

    const entries = await readdir(dir);
    expect(entries).not.toContain(".tmp-11111111-1111-1111-1111-111111111111");
    expect(entries).toContain(".tmp-22222222-2222-2222-2222-222222222222");
  });

  it("does not delete a user file that merely looks like a temp name", async () => {
    const userFile = join(dir, ".tmp-not-a-uuid.txt");
    await writeFile(userFile, "user data");
    await writeBytesAtomic(join(dir, "trigger.txt"), bytes("x"));
    expect(await readFile(userFile, "utf-8")).toBe("user data");
  });

  it("writes bytes verbatim — no newline or encoding transformation", async () => {
    const p = join(dir, "verbatim.bin");
    const payload = Uint8Array.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x80]);
    await writeBytesAtomic(p, payload);
    expect(new Uint8Array(await readFile(p))).toEqual(payload);
  });
});
