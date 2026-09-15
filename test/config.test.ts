/**
 * Configuration loading, and the "unset means follow the code" contract.
 *
 * The generated template deliberately leaves `supportedEncodings` commented out
 * so that an encoding added in a later release reaches every deployment that
 * never overrode the list. That contract is what these tests pin down: it is
 * invisible in the code path (`parseEncodings` simply returns undefined) and
 * would otherwise be broken silently by editing the template.
 *
 * @module dsh-fs-encoding/test/config
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_YAML, ensureDefaultConfig, loadConfig, resetConfigCache } from "../src/config.js";
import { DEFAULT_SUPPORTED_ENCODINGS, isValidUtf8 } from "../src/encoding.js";

let home: string;
let configPath: string;

/** Write a config file (or leave it absent) and load it from a fresh cache. */
function loadWith(content?: string) {
  if (content !== undefined) writeFileSync(configPath, content);
  resetConfigCache();
  return loadConfig();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fs-encoding-config-"));
  process.env["DSH_HOME"] = home;
  const dir = join(home, "plugins", "dsh-fs-encoding");
  mkdirSync(dir, { recursive: true });
  configPath = join(dir, "config.yaml");
  resetConfigCache();
});

afterEach(() => {
  delete process.env["DSH_HOME"];
  delete process.env["DSH_FS_ENCODING_SUPPORTED_ENCODINGS"];
  resetConfigCache();
  rmSync(home, { recursive: true, force: true });
});

describe("the generated config template", () => {
  it("leaves supportedEncodings commented out so the shipped default applies", () => {
    // The key must not be an active line: writing it out would freeze today's
    // set into the file and a later release could not extend it.
    const activeLines = DEFAULT_CONFIG_YAML.split(/\r?\n/).filter(
      (line) => !line.trimStart().startsWith("#"),
    );
    expect(activeLines.some((line) => line.includes("supportedEncodings"))).toBe(false);
    // It is still shown, as a commented example, so the key is discoverable.
    expect(DEFAULT_CONFIG_YAML).toContain("# supportedEncodings: [");
  });

  it("yields the shipped default when loaded as generated", () => {
    const cfg = loadWith(DEFAULT_CONFIG_YAML);
    expect(cfg.supportedEncodings).toEqual([...DEFAULT_SUPPORTED_ENCODINGS]);
  });

  it("yields the shipped default when no config file exists at all", () => {
    const cfg = loadWith();
    expect(cfg.supportedEncodings).toEqual([...DEFAULT_SUPPORTED_ENCODINGS]);
  });
});

describe("an explicit supportedEncodings list", () => {
  it("overrides the default verbatim, including a narrower list", () => {
    expect(loadWith("supportedEncodings: [gbk]\n").supportedEncodings).toEqual(["gbk"]);
    expect(loadWith("supportedEncodings: [gbk, big5]\n").supportedEncodings).toEqual(["gbk", "big5"]);
  });

  it("is never silently rewritten when it differs from the default", () => {
    // The user chose this set; honouring it verbatim is the whole point of
    // "explicit wins". An earlier design tried to migrate lists that matched a
    // past default, which meant a user editing the file lost a default they had
    // never removed — there is no migration now, and nothing to lose.
    const chosen = "supportedEncodings: [gbk, big5, shift_jis, euc-kr, windows-1251, iso-8859-1, windows-1253]\n";
    const cfg = loadWith(chosen);
    expect(cfg.supportedEncodings).toEqual([
      "gbk",
      "big5",
      "shift_jis",
      "euc-kr",
      "windows-1251",
      "iso-8859-1",
      "windows-1253",
    ]);
  });

  it("falls back to the default when the value is empty or all-unknown", () => {
    // `parseEncodings` rejects a list that yields no usable name, so a typo
    // cannot leave the plugin with no candidates at all.
    expect(loadWith("supportedEncodings: []\n").supportedEncodings).toEqual([
      ...DEFAULT_SUPPORTED_ENCODINGS,
    ]);
    expect(loadWith("supportedEncodings: [not-a-real-encoding]\n").supportedEncodings).toEqual([
      ...DEFAULT_SUPPORTED_ENCODINGS,
    ]);
  });

  it("still honours the environment override on top of the file", () => {
    process.env["DSH_FS_ENCODING_SUPPORTED_ENCODINGS"] = "gbk,big5";
    expect(loadWith(DEFAULT_CONFIG_YAML).supportedEncodings).toEqual(["gbk", "big5"]);
  });

  it("lets the environment override beat an explicit list in the file", () => {
    // The README advertises the environment variables as overrides, and every
    // other key in this file works that way. An earlier revision read the
    // explicit list from the file alone, which silently made the file win — the
    // test above passed only because the generated template comments the key out.
    process.env["DSH_FS_ENCODING_SUPPORTED_ENCODINGS"] = "shift_jis";
    expect(loadWith("supportedEncodings: [gbk, big5]\n").supportedEncodings).toEqual(["shift_jis"]);

    process.env["DSH_FS_ENCODING_SUPPORTED_ENCODINGS"] = "big5,shift_jis";
    expect(loadWith("supportedEncodings: [gbk]\n").supportedEncodings).toEqual(["big5", "shift_jis"]);
  });
});

describe("an existing config file is never rewritten", () => {
  // An earlier revision "retired" a `supportedEncodings` line inherited from an
  // older template by reading the file as UTF-8 and writing it back. That
  // transcoded a non-UTF-8 config to replacement characters, converted CRLF to
  // LF, and — when the value truncated to a template default — deleted an
  // encoding the user had added. The plugin now only ever creates the file.
  const LEGACY_LIVE_LINE = "supportedEncodings: [gbk, big5, shift_jis, euc-kr, windows-1251, iso-8859-1]\n";

  it("keeps a written-out list verbatim, whatever its value", () => {
    // No attempt is made to guess whether the list was chosen or inherited: a key
    // that is present wins. (Forward compatibility across template versions is
    // not promised; the generated template comments the key out precisely so that
    // a fresh install never pins the set.)
    expect(loadWith(LEGACY_LIVE_LINE).supportedEncodings).toEqual([
      "gbk",
      "big5",
      "shift_jis",
      "euc-kr",
      "windows-1251",
      "iso-8859-1",
    ]);
  });

  it("leaves the file byte-identical, including CRLF and an edited list", async () => {
    const crlf = "autoGuessEncoding: true\r\nsupportedEncodings: [gbk, windows-1253]\r\n";
    loadWith(crlf);
    await ensureDefaultConfig();
    expect(readFileSync(configPath, "utf-8")).toBe(crlf);
  });

  it("does not corrupt a non-UTF-8 config file", async () => {
    // Reading a GBK file as UTF-8 and writing it back turned every Chinese
    // character into U+FFFD — unrecoverable damage to a file the user owns.
    //
    // The fixture must be genuinely non-UTF-8 AND carry a live
    // `supportedEncodings` line: an earlier version of this test used pure
    // ASCII with no such line, so it passed even against a mutanted
    // `ensureDefaultConfig` that read the file as UTF-8 and rewrote it.
    const gbkBytes = iconv.encode(
      "# 中文注释\nautoGuessEncoding: true\nsupportedEncodings: [gbk, windows-1253]\n",
      "gbk",
    );
    writeFileSync(configPath, gbkBytes);
    const before = readFileSync(configPath);
    expect(isValidUtf8(new Uint8Array(before))).toBe(false);
    await ensureDefaultConfig();
    expect(readFileSync(configPath).equals(before)).toBe(true);
  });
});

describe("excludeEncodings", () => {
  it("removes one encoding without freezing the rest of the default", () => {
    // The point of a subtraction: "drop this one" must not require writing out
    // the whole list, which would stop future additions from arriving.
    const cfg = loadWith("excludeEncodings: [windows-1251]\n");
    expect(cfg.supportedEncodings).not.toContain("windows-1251");
    expect(cfg.supportedEncodings).toEqual(
      DEFAULT_SUPPORTED_ENCODINGS.filter((enc) => enc !== "windows-1251"),
    );
  });

  it("accepts alias spellings and ignores unknown names", () => {
    const cfg = loadWith("excludeEncodings: [cp1251, not-a-real-encoding]\n");
    expect(cfg.supportedEncodings).not.toContain("windows-1251");
    expect(cfg.supportedEncodings).toContain("windows-1252");
  });

  it("is ignored when an explicit list is given", () => {
    // An explicit list is the user's whole answer; subtracting from it again
    // would be second-guessing a decision they already made.
    const cfg = loadWith("supportedEncodings: [gbk, big5]\nexcludeEncodings: [gbk]\n");
    expect(cfg.supportedEncodings).toEqual(["gbk", "big5"]);
  });

  it("keeps the full default when the exclusions would empty it", () => {
    // A config mistake must not silently leave the plugin with no candidates.
    const all = DEFAULT_SUPPORTED_ENCODINGS.join(", ");
    const cfg = loadWith(`excludeEncodings: [${all}]\n`);
    expect(cfg.supportedEncodings).toEqual([...DEFAULT_SUPPORTED_ENCODINGS]);
  });

  it("does NOT narrow an environment-provided list", () => {
    // The README states the environment always wins over the config file, and the
    // template says excludeEncodings applies only while supportedEncodings is
    // unset. Subtracting from an operator-provided list contradicted both: the
    // environment named the whole set, so nothing in the file may narrow it.
    process.env["DSH_FS_ENCODING_SUPPORTED_ENCODINGS"] = "gbk,big5,shift_jis";
    const cfg = loadWith("excludeEncodings: [big5]\n");
    expect(cfg.supportedEncodings).toEqual(["gbk", "big5", "shift_jis"]);
  });

  it("has no environment counterpart, so env can never be silently dropped", () => {
    // A `DSH_FS_ENCODING_EXCLUDE_ENCODINGS` variable used to exist. It was
    // unenforceable by construction: an exclusion list only means something
    // relative to a base set, and the environment already names a whole set via
    // DSH_FS_ENCODING_SUPPORTED_ENCODINGS — so whenever the two were combined,
    // one of them had to lose, and the loser was always the exclusion. It was
    // removed rather than given a precedence rule, because the file-level
    // `excludeEncodings` key already covers the real use case ("follow the
    // shipped default, minus these") without that ambiguity.
    process.env["DSH_FS_ENCODING_EXCLUDE_ENCODINGS"] = "windows-1251";
    const cfg = loadWith(DEFAULT_CONFIG_YAML);
    expect(cfg.supportedEncodings).toContain("windows-1251");
    expect(cfg.excludeEncodings).toEqual([]);
  });

  it("still matches an alias spelling when reducing the default", () => {
    // The README promises cp1251 / sjis / latin1 are equivalent to their
    // canonical names. Comparing the two sides without canonicalizing silently
    // ignored every exclusion written that way. Exercised through the default
    // path, which is the one exclusions still apply to.
    expect(loadWith("excludeEncodings: [cp1251]\n").supportedEncodings).not.toContain(
      "windows-1251",
    );
    expect(loadWith("excludeEncodings: [sjis]\n").supportedEncodings).not.toContain("shift_jis");
    expect(loadWith("excludeEncodings: [latin1]\n").supportedEncodings).not.toContain(
      "iso-8859-1",
    );
  });
});
