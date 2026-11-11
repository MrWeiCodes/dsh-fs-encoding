/**
 * The UTF-32 BOM probe, run against the real ripgrep binary.
 *
 * The probe decides which files take the per-file JavaScript search, and its
 * cost is per CANDIDATE rather than per genuine UTF-32 file — so a probe that
 * over-names turns a second-long search into a minute-long one. These tests run
 * the real argv against real bytes, because the defect being pinned is a
 * property of ripgrep's own regex and anchoring behaviour: a stub would answer
 * the question by assumption, and the assumption is what was wrong.
 *
 * A genuine UTF-32LE file and a genuine UTF-16LE file whose first character is
 * U+0000 are byte-identical in their first four bytes. No probe can separate
 * them, so that one file is deliberately absent here — see the note in
 * `findUtf32Files`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRgPath } from "@deepseek-ai/dsh-tool-fs-search";
import { utf32ProbeArgv } from "../src/tool-grep.js";

let root: string;
/** The same binary production spawns, resolved the same way. */
let rgPath: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "dsh-u32-probe-"));
  rgPath = await resolveRgPath();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Encode text as UTF-32 by hand.
 *
 * Node has no `utf32` encoder and `iconv-lite` is not what runs in production
 * here, so the code units are written directly.
 */
function utf32(text: string, little: boolean): Buffer {
  const out = Buffer.alloc(text.length * 4);
  for (let i = 0; i < text.length; i += 1) {
    if (little) out.writeUInt32LE(text.charCodeAt(i), i * 4);
    else out.writeUInt32BE(text.charCodeAt(i), i * 4);
  }
  return out;
}

/**
 * The file-size cap handed to the probe.
 *
 * Every fixture here is a few bytes, so the value never changes an answer; it is
 * passed because production passes one and the argv would otherwise be
 * incomplete.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Run the probe and return the file names it named, relative to `root`. */
function probe(dir: string): string[] {
  let stdout: string;
  try {
    // `--no-config` sits where `spawnRg` puts it: a host RIPGREP_CONFIG_PATH
    // otherwise injects `--null`, `--color` or a `--glob` that changes what this
    // probe answers, and the failure would look like a probe bug.
    const argv = ["--no-config", ...utf32ProbeArgv({}, MAX_FILE_BYTES), "--", dir];
    stdout = execFileSync(rgPath, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // Exit 1 is "no match", which is a normal answer here and the expected one
    // for every case that must name nothing.
    const status = (error as { status?: number }).status;
    if (status !== 1) throw error;
    stdout = String((error as { stdout?: string }).stdout ?? "");
  }
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(root.length + 1).replaceAll("\\", "/"));
}

describe("utf32 probe: names the mark, not the byte sequence", () => {
  it("names a genuine UTF-32LE file", () => {
    const dir = join(root, "le");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "u32le.txt"),
      Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), utf32("hi\n", true)]),
    );
    expect(probe(dir)).toEqual(["le/u32le.txt"]);
  });

  it("names a genuine UTF-32BE file", () => {
    const dir = join(root, "be");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "u32be.txt"),
      Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), utf32("hi\n", false)]),
    );
    expect(probe(dir)).toEqual(["be/u32be.txt"]);
  });

  it("does not name a file whose mark sits past offset 0", () => {
    // The four bytes are present but preceded by other content. An unanchored
    // alternation names this file, and every such file is then decoded and
    // searched through a fresh Worker for nothing.
    const dir = join(root, "mid");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mid.bin"),
      Buffer.concat([
        Buffer.from("AAAAA"),
        Buffer.from([0xff, 0xfe, 0x00, 0x00]),
        Buffer.from("tail\n"),
      ]),
    );
    expect(probe(dir)).toEqual([]);
  });

  it("does not name a file whose mark starts a later line", () => {
    // The line-anchored variant is the trap this pins: without multiline mode
    // ripgrep runs the pattern once per line, so `\A` matches the start of line
    // 2 and the file is named anyway.
    const dir = join(root, "line2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "line2.bin"),
      Buffer.concat([
        Buffer.from("first line\n"),
        Buffer.from([0xff, 0xfe, 0x00, 0x00]),
        Buffer.from("rest\n"),
      ]),
    );
    expect(probe(dir)).toEqual([]);
  });

  it("does not name a plain UTF-16LE file", () => {
    // `FF FE` is the UTF-16LE mark; the NUL pair an unanchored probe needs comes
    // from the text itself, which is why this is the common false positive.
    const dir = join(root, "u16");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "u16le.txt"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello world\n", "utf16le")]),
    );
    expect(probe(dir)).toEqual([]);
  });

  it("does not name a UTF-8 file or a legacy-page file", () => {
    const dir = join(root, "text");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plain.txt"), Buffer.from("hello\n"));
    writeFileSync(join(dir, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("hi\n")]));
    expect(probe(dir)).toEqual([]);
  });

  it("names only the genuine UTF-32 files in a mixed directory", () => {
    const dir = join(root, "mixed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "real-le.txt"),
      Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), utf32("a\n", true)]),
    );
    writeFileSync(
      join(dir, "real-be.txt"),
      Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), utf32("b\n", false)]),
    );
    writeFileSync(join(dir, "plain.txt"), Buffer.from("c\n"));
    writeFileSync(
      join(dir, "mid.bin"),
      Buffer.concat([Buffer.from("xxxx"), Buffer.from([0x00, 0x00, 0xfe, 0xff])]),
    );
    expect(probe(dir).sort()).toEqual(["mixed/real-be.txt", "mixed/real-le.txt"]);
  });
});
