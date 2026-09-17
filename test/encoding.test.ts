import { describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import {
  bomBytesForEncoding,
  CANONICAL_ENCODINGS,
  chardetTop3Candidates,
  DEFAULT_SUPPORTED_ENCODINGS,
  decodeBytes,
  detectBom,
  encodeText,
  getTop3Candidates,
  hasScriptFamily,
  isSupportedEncoding,
  isValidUtf8,
  isAcceptableDecode,
  normalizeEncoding,
  rankCandidates,
  scoreText,
  top3Candidates,
  unassignedBytes,
} from "../src/encoding.js";

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const gbk = (s: string) => new Uint8Array(iconv.encode(s, "gbk"));
/** Bytes for `s` on a non-GBK legacy page, named so the call sites read clearly. */
const gbkAs = (s: string, enc: string) => new Uint8Array(iconv.encode(s, enc));

describe("normalizeEncoding", () => {
  it("canonicalizes case and punctuation", () => {
    expect(normalizeEncoding("UTF-8")).toBe("utf8");
    expect(normalizeEncoding("Shift-JIS")).toBe("shift_jis");
    expect(normalizeEncoding("shift_jis")).toBe("shift_jis");
    expect(normalizeEncoding("SJIS")).toBe("shift_jis");
    expect(normalizeEncoding("  GBK  ")).toBe("gbk");
  });

  it("maps legacy aliases onto one canonical id", () => {
    expect(normalizeEncoding("gb18030")).toBe("gbk");
    expect(normalizeEncoding("gb2312")).toBe("gbk");
    expect(normalizeEncoding("cp936")).toBe("gbk");
    expect(normalizeEncoding("cp1251")).toBe("windows-1251");
    expect(normalizeEncoding("latin1")).toBe("iso-8859-1");
  });

  it("resolves every Windows ANSI page under both advertised spellings", () => {
    // README promises each Windows ANSI page is reachable as `cp12xx` as well as
    // by its canonical name. Derived from CANONICAL_ENCODINGS rather than a
    // hand-written copy, so adding a page without its aliases fails here instead
    // of reaching a user as [E_BAD_ENCODING]. The encode/decode round-trip tests
    // cannot catch this: those functions go straight to iconv-lite and never
    // consult the alias table.
    const pages = CANONICAL_ENCODINGS.filter((enc) => enc.startsWith("windows-12"));
    expect(pages.length).toBeGreaterThan(0);

    for (const page of pages) {
      expect(normalizeEncoding(page), `${page} canonical`).toBe(page);
      // windows-1252 -> cp1252, windows-1250 -> cp1250, …
      const cpSpelling = page.replace("windows-", "cp");
      expect(normalizeEncoding(cpSpelling), `${cpSpelling} alias`).toBe(page);
      // …and the unhyphenated form the alias table is keyed by.
      expect(normalizeEncoding(page.replace("-", "")), `${page} unhyphenated`).toBe(page);
    }
  });

  it("has a script family for every non-Latin canonical encoding", () => {
    // A page missing from SCRIPT_FAMILIES scores lower than its rivals and can
    // lose to an unrelated page — silently, since no round-trip test notices.
    //
    // The Latin pages are named here as an EXPLICIT allowlist of "no family
    // needed", and the assertion is that the allowlist and the family table
    // partition the canonical set. An earlier version derived the expectation by
    // subtracting a hand-written LATIN_PAGES set, which was circular: adding a
    // Greek page to both ALIASES and that set kept the suite green while the page
    // silently lost its bonus. Here, adding a non-Latin page without a family
    // fails unless it is also added below — a deliberate, visible edit.
    const NO_FAMILY_NEEDED = new Set([
      // Unicode: the BOM and code-unit width are decided before guessing.
      "utf8",
      "utf8bom",
      "utf16le",
      "utf16be",
      "utf32le",
      "utf32be",
      // Latin-script pages: their script IS Latin, so a bonus could not
      // distinguish them from ordinary Western text.
      "iso-8859-1",
      "windows-1250",
      "windows-1252",
      "windows-1254",
      "windows-1257",
    ]);

    for (const enc of CANONICAL_ENCODINGS) {
      expect(
        hasScriptFamily(enc),
        `${enc}: either give it a SCRIPT_FAMILIES entry or list it in NO_FAMILY_NEEDED`,
      ).toBe(!NO_FAMILY_NEEDED.has(enc));
    }
    // Every name in the allowlist must be a real canonical encoding, so a typo
    // cannot silently exempt a page that does need a family.
    for (const enc of NO_FAMILY_NEEDED) {
      expect(CANONICAL_ENCODINGS, `${enc} is not a canonical encoding`).toContain(enc);
    }
  });

  it("keeps windows-1252 distinct from iso-8859-1", () => {
    // These are NOT aliases: they agree on 0x00-0x7F and 0xA0-0xFF but differ
    // across 0x80-0x9F, where cp1252 holds the curly quotes, dashes, ellipsis
    // and euro sign that Windows text uses constantly while iso-8859-1 maps
    // them to C1 control characters. Mapping cp1252 onto iso-8859-1 silently
    // dropped every one of those characters.
    expect(normalizeEncoding("cp1252")).toBe("windows-1252");
    expect(normalizeEncoding("windows-1252")).toBe("windows-1252");
    expect(normalizeEncoding("windows1252")).toBe("windows-1252");
    expect(normalizeEncoding("cp1252")).not.toBe(normalizeEncoding("iso-8859-1"));
  });

  it("decodes 0x80-0x9F differently for cp1252 and iso-8859-1", () => {
    // The byte range where the two encodings disagree.
    const bytes = Uint8Array.from([0x93, 0x94, 0x96, 0x97]);
    const asCp1252 = decodeBytes(bytes, normalizeEncoding("cp1252")!);
    const asLatin1 = decodeBytes(bytes, normalizeEncoding("latin1")!);

    expect(asCp1252).toBe("\u201C\u201D\u2013\u2014"); // “ ” – —
    // latin1 yields C1 controls here, not punctuation.
    expect(asLatin1).toBe("\u0093\u0094\u0096\u0097");
    expect(asCp1252).not.toBe(asLatin1);
  });

  it("rejects unknown names", () => {
    expect(normalizeEncoding("klingon")).toBeUndefined();
    expect(normalizeEncoding("")).toBeUndefined();
    expect(normalizeEncoding("   ")).toBeUndefined();
  });

  it("rejects Object.prototype members instead of leaking them", () => {
    // `ALIASES[key]` is a prototype-chain lookup on a plain object literal, so a
    // bare index returns a FUNCTION for these names — truthy, not a string, and
    // not an encoding. A `=== undefined` validation would accept `constructor`
    // and pass it to the codec layer, which then surfaced the interpreter's own
    // source text ("function Object() { [native code] }") in a model-facing
    // error. The lookup must be an own-property check.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(normalizeEncoding(name), `${name} must not resolve`).toBeUndefined();
      expect(isSupportedEncoding(name), `${name} must not be supported`).toBe(false);
    }
  });
});

describe("the BOM table", () => {
  it("names exactly the BOM-carrying encodings, both directions", () => {
    // `detectBom` (bytes → name) and `bomBytesForEncoding` (name → bytes) are two
    // directions of ONE table. If they ever disagree, a file can be written with a
    // BOM its own reader does not recognize — or read as BOM-carrying and saved
    // without one — and both failures are silent.
    const expected = ["utf8bom", "utf16le", "utf16be", "utf32le", "utf32be"];
    for (const enc of expected) {
      const bytes = bomBytesForEncoding(enc);
      expect(bytes, `${enc} must have a BOM`).toBeDefined();
      // Round-trip: the bytes this table hands the writer must be the bytes the
      // sniffer recognizes, and must name the same encoding back.
      expect(detectBom(bytes!)?.encoding).toBe(enc);
    }
    // And nothing else carries one.
    for (const enc of ["utf8", "gbk", "big5", "shift_jis", "euc-kr", "windows-1252"]) {
      expect(bomBytesForEncoding(enc), `${enc} must not have a BOM`).toBeUndefined();
    }
  });

  it("still prefers the longer BOM on a prefix overlap", () => {
    // The table is ordered longest-signature-first so this holds structurally.
    expect(bomBytesForEncoding("utf32le")).toEqual(Uint8Array.from([0xff, 0xfe, 0x00, 0x00]));
    expect(detectBom(Uint8Array.from([0xff, 0xfe, 0x00, 0x00]))?.encoding).toBe("utf32le");
  });
});

describe("detectBom", () => {
  it("recognizes UTF-8 BOM", () => {
    expect(detectBom(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toEqual({
      encoding: "utf8bom",
      bomLen: 3,
    });
  });

  it("prefers UTF-32LE over UTF-16LE (prefix overlap)", () => {
    // FF FE 00 00 is a UTF-32LE BOM whose first two bytes look like UTF-16LE.
    expect(detectBom(Uint8Array.from([0xff, 0xfe, 0x00, 0x00]))).toEqual({
      encoding: "utf32le",
      bomLen: 4,
    });
    expect(detectBom(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]))).toEqual({
      encoding: "utf16le",
      bomLen: 2,
    });
  });

  it("recognizes UTF-16BE and UTF-32BE", () => {
    expect(detectBom(Uint8Array.from([0xfe, 0xff, 0x41, 0x00]))?.encoding).toBe("utf16be");
    expect(detectBom(Uint8Array.from([0x00, 0x00, 0xfe, 0xff]))?.encoding).toBe("utf32be");
  });

  it("returns undefined without a BOM", () => {
    expect(detectBom(utf8("hello"))).toBeUndefined();
    expect(detectBom(new Uint8Array(0))).toBeUndefined();
  });
});

describe("isValidUtf8", () => {
  it("accepts valid UTF-8", () => {
    expect(isValidUtf8(utf8("hello 世界"))).toBe(true);
    expect(isValidUtf8(new Uint8Array(0))).toBe(true);
  });

  it("rejects invalid sequences rather than substituting", () => {
    expect(isValidUtf8(Uint8Array.from([0xff, 0xfe, 0xfd]))).toBe(false);
    expect(isValidUtf8(Uint8Array.from([0xc3, 0x28]))).toBe(false);
  });

  it("rejects a GBK payload", () => {
    expect(isValidUtf8(gbk("你好，世界"))).toBe(false);
  });
});

describe("decodeBytes / encodeText round-trip", () => {
  it("round-trips GBK", () => {
    const text = "你好，世界\n第二行：中文内容\n";
    const bytes = encodeText(text, "gbk");
    expect(bytes).toBeDefined();
    expect(decodeBytes(bytes!, "gbk")).toBe(text);
    // The encoded bytes must be GBK, not UTF-8.
    expect(bytes!.length).toBeLessThan(utf8(text).length);
  });

  it("round-trips Big5 and Shift-JIS", () => {
    const big5Text = "繁體中文測試";
    expect(decodeBytes(encodeText(big5Text, "big5")!, "big5")).toBe(big5Text);
    const sjisText = "こんにちは世界";
    expect(decodeBytes(encodeText(sjisText, "shift_jis")!, "shift_jis")).toBe(sjisText);
  });

  it("round-trips UTF-16LE and UTF-16BE", () => {
    const text = "hello 世界";
    expect(decodeBytes(encodeText(text, "utf16le")!, "utf16le")).toBe(text);
    expect(decodeBytes(encodeText(text, "utf16be")!, "utf16be")).toBe(text);
  });

  it("returns undefined for an unknown encoding", () => {
    expect(encodeText("x", "not-a-real-encoding")).toBeUndefined();
    expect(decodeBytes(utf8("x"), "not-a-real-encoding")).toBeUndefined();
  });

  it("round-trips each Windows ANSI code page's own script", () => {
    // Each entry is a sample of the script that code page exists to carry.
    // These are the encodings added as a family; a regression in one is
    // otherwise invisible until a user hits it.
    const SAMPLES: Array<[string, string]> = [
      ["windows-1250", "Příliš žluťoučký kůň"], // Central European
      ["windows-1251", "Съешь же ещё этих мягких булок"], // Cyrillic
      ["windows-1252", "\u201CCurly\u201D \u2014 it\u2019s \u20AC5\u2026"], // Western
      ["windows-1253", "Ελληνικά κείμενο"], // Greek
      ["windows-1254", "Türkçe ğüşiöç İı"], // Turkish
      ["windows-1255", "עברית טקסט"], // Hebrew
      ["windows-1256", "العربية نص"], // Arabic
      ["windows-1257", "Latviešu āčēģīķļņšūž"], // Baltic
    ];

    for (const [enc, text] of SAMPLES) {
      // The plugin's OWN alias table must resolve the name, not just iconv-lite.
      // `encodeText`/`decodeBytes` go straight to iconv and never consult
      // ALIASES, so without this line a dropped alias key kept the suite green
      // while `read({encoding: "windows-1256"})` failed with E_BAD_ENCODING —
      // even though the README lists the name as supported.
      expect(normalizeEncoding(enc), `${enc} must resolve through ALIASES`).toBe(enc);

      const bytes = encodeText(text, enc);
      expect(bytes, `${enc} should encode`).toBeDefined();
      expect(decodeBytes(bytes!, enc), `${enc} should round-trip`).toBe(text);
    }
  });

  it("does not advertise windows-1258, whose combining bytes iconv cannot encode", () => {
    // Vietnamese needs combining sequences that iconv-lite's single-byte table
    // cannot split, so most Vietnamese characters encode to "?". Offering the
    // name would let a file be read but almost never saved.
    expect(normalizeEncoding("windows-1258")).toBeUndefined();
    expect(normalizeEncoding("cp1258")).toBeUndefined();
    // The failure it would cause, shown directly: a precomposed Vietnamese
    // character does not survive an encode/decode cycle under that code page.
    const bytes = iconv.encode("\u1EBF", "windows-1258");
    expect(iconv.decode(bytes, "windows-1258")).not.toBe("\u1EBF");
  });
});

describe("scoreText", () => {
  it("disqualifies text containing the replacement character", () => {
    expect(scoreText("bad \uFFFD text", "gbk")).toBe(-1000);
  });

  it("prefers a decode whose script matches the encoding", () => {
    const chinese = "你好世界";
    expect(scoreText(chinese, "gbk")).toBeGreaterThan(scoreText(chinese, "windows-1251"));
  });

  it("penalizes mostly-unprintable text", () => {
    const binary = "\u0001\u0002\u0003\u0004";
    expect(scoreText(binary, "gbk")).toBeLessThan(0);
  });

  it("treats C1 control characters as unprintable", () => {
    // U+0080-U+009F is what iso-8859-1 and windows-1251 produce for the bytes
    // 0x80-0x9F, where windows-1252 produces punctuation. Counting them as
    // printable made every mis-decode score as well as the correct one, so a
    // cp1252 file was never recognised as such.
    const c1 = "\u0093\u0094\u0097\u0080";
    expect(scoreText(c1, "iso-8859-1")).toBeLessThan(0);
    expect(scoreText(c1, "iso-8859-1")).toBeLessThan(scoreText("“”—€", "windows-1252"));
  });

  it("penalizes a decode that leaves C1 controls behind", () => {
    // The bytes 0x80-0x9F are punctuation in windows-1252 and C1 controls in
    // iso-8859-1. Counting those controls as printable made the two decodes tie,
    // so the correct page was never preferred. This is the half of the cp1252
    // fix that the scoring change is responsible for.
    const western = "Café — “résumé” €10…";
    const bytes = new Uint8Array(encodeText(western, "windows-1252")!);
    const asLatin1 = decodeBytes(bytes, "iso-8859-1")!;
    const asCp1252 = decodeBytes(bytes, "windows-1252")!;

    expect(scoreText(asCp1252, "windows-1252")).toBeGreaterThan(scoreText(asLatin1, "iso-8859-1"));
  });

  it("scores a candidate by how much of its own script the decode contains", () => {
    // Count-based, not share-based: a file that is mostly ASCII with a couple of
    // localized lines must still let its own encoding win. A share threshold was
    // tried and reverted because it penalised exactly those files.
    const chineseWithCode = "// 中文注释\nconst a = 1;\nfunction foo() { return 42; }\n";
    const bytes = new Uint8Array(encodeText(chineseWithCode, "gbk")!);
    const asGbk = decodeBytes(bytes, "gbk")!;
    const asCp1251 = decodeBytes(bytes, "windows-1251")!;

    expect(scoreText(asGbk, "gbk")).toBeGreaterThan(scoreText(asCp1251, "windows-1251"));
  });
});

describe("bytes a single-byte page leaves unassigned", () => {
  // windows-1252 has five unassigned byte values. iconv-lite decodes each to
  // U+FFFD, which reads as "this decode failed" — so a real windows-1252 file
  // carrying one is reported as undecodable. That is deliberate: see the note on
  // `isAcceptableDecode`. The byte values are still worth knowing, because
  // naming the byte is what turns an unhelpful "the encoding is probably wrong"
  // into an actionable message.
  const UNASSIGNED_1252 = [0x81, 0x8d, 0x8f, 0x90, 0x9d];

  it("reports them, and reports none for a fully-mapped page", () => {
    expect([...unassignedBytes("windows-1252")]).toEqual(UNASSIGNED_1252);
    // iso-8859-1 defines all 256 bytes; windows-1256 happens to as well.
    expect([...unassignedBytes("iso-8859-1")]).toEqual([]);
    expect([...unassignedBytes("windows-1256")]).toEqual([]);
    // A multi-byte encoding is not a single-byte page, so the probe declines.
    // This is the guard that keeps the probe from inventing a gap count for a
    // page whose decode is not byte-per-character: `gbk` would otherwise report
    // the bytes its lead/trail structure rejects (verified by mutating the
    // 256-character check to a non-empty check, which makes this line fail).
    expect([...unassignedBytes("gbk")]).toEqual([]);
    // `utf8` is a weaker case and is deliberately not asserted: `decodeBytes`
    // runs it through a fatal TextDecoder, which throws on the 256-byte probe
    // and yields `undefined`, so the empty result comes from the error path
    // rather than from the guard. Any implementation returns [] here.
  });

  it("refuses a decode with U+FFFD even when the page has its own gaps", () => {
    // The regression this pins down: relaxing the rule to "the page has an
    // unassigned byte, so forgive U+FFFD" let a WRONG page through whenever the
    // file happened to contain one of its gap bytes. A short Shift-JIS file
    // (83 52 83 81 83 93 83 67) has 0x81, which windows-1252 leaves unassigned —
    // windows-1252 was accepted, and a save then rewrote 0x81 as 0x9D, silently
    // corrupting a file the user never edited. U+FFFD is disqualifying, always.
    const text = decodeBytes(Uint8Array.from([0x41, 0x81, 0x42]), "windows-1252")!;
    expect(text).toContain("\uFFFD");
    // The rule takes no encoding argument: it is a property of the TEXT, not of
    // the text/encoding pairing. An earlier signature took `enc` and ignored it,
    // which is what made the relaxed form look principled.
    expect(isAcceptableDecode(text)).toBe(false);
    expect(scoreText(text, "windows-1252")).toBe(-1000);
    expect(scoreText(text, "iso-8859-1")).toBe(-1000);
  });

  it("never lets a candidate that decodes with U+FFFD win", () => {
    // End-to-end shape of the same bug, at the level that actually corrupts: the
    // TOP pick must decode cleanly, because that is the encoding recorded as the
    // file's own — a later save would then rewrite bytes through it.
    //
    // Asserting on the whole list would be wrong: a candidate that produces
    // U+FFFD is still listed for the user to see, but `scoreText` scores it
    // -1000, so it can never outrank a clean decode.
    const bytes = Uint8Array.from([
      ...iconv.encode("Dear Mr. Smith, please review the attached r\u00E9sum\u00E9 \u2014 ", "windows-1252"),
      0x81,
      ...iconv.encode(" it is final. Thanks.", "windows-1252"),
    ]);
    const top = top3Candidates(bytes, DEFAULT_SUPPORTED_ENCODINGS)[0];
    expect(top, "a candidate list is always produced").toBeDefined();
    expect(
      decodeBytes(bytes, top!.encoding),
      `${top!.encoding} won but does not decode cleanly`,
    ).not.toContain("\uFFFD");
    expect(top!.score).toBeGreaterThan(-1000);
  });

  it("does not accept a wrong page just because the file hits one of its gaps", async () => {
    // The exact regression, and the reason the acceptance rule is strict. This
    // short Shift-JIS file contains 0x81, which windows-1252 leaves unassigned.
    // A rule of the form "forgive U+FFFD when the page has gaps" therefore
    // accepted windows-1252 — chardet's top verdict — and the recorded encoding
    // became windows-1252. Saving unchanged content then rewrote 0x81 as 0x9D,
    // and `encodeForSave`'s round-trip guard stayed silent because U+FFFD maps
    // back to an unassigned byte, so the check looked stable.
    const text = "// \u30b3\u30e1\u30f3\u30c8\nconst value = 1;\n";
    const bytes = new Uint8Array(iconv.encode(text, "shift_jis"));
    expect(bytes.includes(0x81), "fixture must hit a windows-1252 gap byte").toBe(true);

    const viaChardet = await chardetTop3Candidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    const top = viaChardet[0] ?? top3Candidates(bytes, DEFAULT_SUPPORTED_ENCODINGS)[0];
    expect(top, "a candidate is always produced").toBeDefined();
    expect(
      decodeBytes(bytes, top!.encoding),
      `${top!.encoding} was chosen for a Shift-JIS file and decodes with U+FFFD`,
    ).not.toContain("\uFFFD");
  });
});

describe("guessing a windows-1252 file", () => {
  it("offers windows-1252 among the candidates for Western punctuation", () => {
    // Before this change `windows-1252` was not a reachable name at all: the
    // alias table mapped `cp1252` onto iso-8859-1 and the canonical name was
    // unknown, so chardet's windows-1252 verdict was filtered out and the page
    // could not be suggested or selected. It now reaches the candidate list.
    //
    // The TOP slot is deliberately not asserted: `windows-1251` still outranks it
    // on this input, because reading cp1252 bytes as Cyrillic turns the accented
    // letters into a handful of Cyrillic characters and collects a script bonus.
    // That is a pre-existing weakness of the heuristic rather than something this
    // change introduced, and fixing it needs a better Cyrillic-vs-Latin
    // discriminator than a character count.
    const western =
      "Dear Mr. Smith, please review the attached résumé — it’s the final " +
      "version… The naïve assumption was that café sales would rise. “Excellent”.";
    const bytes = new Uint8Array(encodeText(western, "windows-1252")!);

    const candidates = top3Candidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    const offered = candidates.find((c) => c.encoding === "windows-1252");
    expect(offered, "windows-1252 should be reachable").toBeDefined();
    expect(decodeBytes(bytes, offered!.encoding)).toBe(western);
    // iso-8859-1 must rank below it: its decode leaves C1 controls behind.
    // Assert it is present first — `latin1?.score ?? -Infinity` would make the
    // comparison vacuously true the moment iso-8859-1 falls out of the Top-3.
    const latin1 = candidates.find((c) => c.encoding === "iso-8859-1");
    expect(latin1, "iso-8859-1 should be among the candidates").toBeDefined();
    expect(offered!.score).toBeGreaterThan(latin1!.score);
  });

  it("still ranks the true script first for non-Western files", () => {
    // The scoring change must not cost the scripts it was built for. Korean is
    // deliberately absent: euc-kr vs gbk on hangul is a pre-existing mis-rank
    // (HEAD's algorithm picks gbk too), unrelated to this change.
    const cases: Array<[string, string]> = [
      ["Съешь же ещё этих мягких булок", "windows-1251"],
      ["你好，世界，这是中文内容测试", "gbk"],
      ["こんにちは世界、日本語のテキストです", "shift_jis"],
    ];
    for (const [text, enc] of cases) {
      const bytes = new Uint8Array(encodeText(text, enc)!);
      const candidates = top3Candidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
      expect(candidates[0]!.encoding, `${enc} should win for ${text}`).toBe(enc);
      expect(decodeBytes(bytes, candidates[0]!.encoding)).toBe(text);
    }
  });
});

describe("top3Candidates", () => {
  it("ranks GBK first for GBK bytes", () => {
    const candidates = top3Candidates(gbk("你好，世界，这是一个测试文件"), [
      "gbk",
      "big5",
      "shift_jis",
      "windows-1251",
    ]);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.encoding).toBe("gbk");
    expect(candidates[0]!.score).toBeGreaterThan(candidates.at(-1)!.score);
  });

  it("produces a non-empty sample", () => {
    const candidates = top3Candidates(gbk("测试内容"), ["gbk"]);
    expect(candidates[0]!.sample.length).toBeGreaterThan(0);
  });

  it("returns an empty list when nothing decodes", () => {
    expect(top3Candidates(utf8("abc"), ["not-a-real-encoding"])).toEqual([]);
  });
});

describe("chardet integration", () => {
  it("returns candidates or degrades to empty without throwing", async () => {
    const result = await chardetTop3Candidates(gbk("你好世界，这是中文测试内容"), ["gbk", "big5"]);
    expect(Array.isArray(result)).toBe(true);
    // chardet is an optionalDependency; when absent this is simply empty.
    for (const c of result) expect(typeof c.encoding).toBe("string");
  });

  it("getTop3Candidates always yields a usable candidate list", async () => {
    // The top pick is NOT asserted to be gbk: on a short Chinese string the
    // GBK and Big5 byte ranges overlap, so a guess is a hint and not a
    // guarantee. That ambiguity is why autoGuessEncoding defaults to false.
    const result = await getTop3Candidates(gbk("你好，世界"), ["gbk", "big5"]);
    expect(result.length).toBeGreaterThan(0);
    expect(result.map((c) => c.encoding)).toContain("gbk");
    for (const c of result) expect(c.sample.length).toBeGreaterThan(0);
  });
});

describe("chardet floor-confidence handling", () => {
  it("keeps gbk in the candidate list for short GBK input", async () => {
    // Regression: chardet answers an 8-byte GBK file with
    // Shift_JIS(10), Big5(10), EUC-JP(10), EUC-KR(10), GB18030(10), ASCII(0).
    // GB18030 is this plugin's `gbk` and sits FIFTH, so filtering to the
    // allowlist and stopping at three returned shift_jis/big5/euc_kr — the
    // correct encoding was absent and the model was told to re-read as
    // Shift-JIS. The all-floor verdict is chardet declining to choose, and its
    // order among those pages is arbitrary.
    const result = await getTop3Candidates(gbk("中文测试"), DEFAULT_SUPPORTED_ENCODINGS);
    expect(result.map((c) => c.encoding)).toContain("gbk");
  });

  it("reports the short-GBK list as unranked and still offers gbk", async () => {
    // `gbk` must be PRESENT — that is what the coverage fix guarantees. top-1 is
    // not claimable: the heuristic scores `gbk` and `big5` identically (110
    // against 110), so nothing separates these pages and `rankCandidates` must
    // say so rather than dress an arbitrary pick up as a decision.
    const result = await rankCandidates(gbk("中文测试内容"), DEFAULT_SUPPORTED_ENCODINGS);
    expect(result.ranked).toBe(false);
    expect(result.basis).toBe("chardet-abstained");
    expect(result.candidates.map((c) => c.encoding)).toContain("gbk");
    // An unranked list gets one slot more than a ranked one, because three
    // cannot hold both chardet's verdicts and the heuristic's contribution.
    expect(result.candidates.length).toBe(4);
  });

  it("keeps chardet's own verdicts when the heuristic would evict them", async () => {
    // The interleave this replaced walked both lists in lockstep, so the
    // heuristic's filler evicted chardet's verdicts one-for-one. Measured on
    // Korean input that dropped the correct `euc-kr` page on 4 of 9 samples
    // where a plain union kept it. `euc-kr` must therefore survive the merge.
    const bytes = gbkAs("시스템 정보", "euc-kr");
    const verdicts = await chardetTop3Candidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(verdicts.map((c) => c.encoding)).toContain("euc-kr");

    const result = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(result.basis).toBe("chardet-abstained");
    expect(result.candidates.map((c) => c.encoding)).toContain("euc-kr");
    // chardet's head stays first, so the displayed order still matches HEAD.
    expect(result.candidates[0]!.encoding).toBe(verdicts[0]!.encoding);
  });

  it("still prefers chardet when its verdict carries evidence", async () => {
    // Above the floor chardet HAS identified the file, and the two measured
    // attempts to override it there both made things worse. Deferring must
    // survive the floor rule.
    const result = await rankCandidates(gbk("中文测试内容中文测试数据"), DEFAULT_SUPPORTED_ENCODINGS);
    expect(result.ranked).toBe(true);
    expect(result.basis).toBe("chardet-ranked");
    expect(result.candidates[0]!.encoding).toBe("gbk");
  });

  it("never returns an empty list for decodable non-UTF-8 bytes", async () => {
    // The fallback must be a strict improvement: whatever chardet declined to
    // decide, the heuristic still produces candidates for.
    for (const sample of ["中文测试", "中文测试内容", "中文测试内容中文测试数据"]) {
      const result = await getTop3Candidates(gbk(sample), DEFAULT_SUPPORTED_ENCODINGS);
      expect(result.length).toBeGreaterThan(0);
      expect(result.map((c) => c.encoding)).toContain("gbk");
    }
  });

  it("does not crown the heuristic over a page chardet ranked", async () => {
    // THE regression this rule exists to stop. chardet rates the real UTF-32LE
    // decoding at 100, so its pick must survive; the heuristic cannot separate
    // East Asian pages from each other (see `chardetRankedAnyPage`) and must not
    // be consulted at all here.
    const utf32 = new Uint8Array(iconv.encode("ABCD", "utf32le"));
    const ranked = await rankCandidates(utf32, [...DEFAULT_SUPPORTED_ENCODINGS, "utf32le"]);
    expect(ranked.basis).toBe("chardet-ranked");
    expect(ranked.candidates[0]!.encoding).toBe("utf32le");
  });

  it("never records a short Shift_JIS file under a different page", async () => {
    // The measured corruption, pinned end to end. The heuristic's `scoreText`
    // puts `gbk` in the same 105–115 band whichever East Asian page is actually
    // correct, so a margin over the runner-up (`日本語の` gives 6.0) looks like a
    // separation and is not one. Promoting it recorded `gbk` and the model saw
    // `擔杮岅偺` — printable, U+FFFD-free, and re-encoding to the ORIGINAL bytes,
    // so a write-back reproduced the file and nothing downstream noticed.
    for (const text of ["日本語", "漢字", "東京", "日本語の", "関数日本語", "日本語の文書"]) {
      const bytes = gbkAs(text, "shift_jis");
      const ranked = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
      // Whatever the ordering, it must not be presented as evidence...
      if (ranked.candidates[0]!.encoding !== "shift_jis") {
        expect(ranked.ranked).toBe(false);
      }
      // ...and the correct page must always be on the list.
      expect(ranked.candidates.map((c) => c.encoding)).toContain("shift_jis");
    }
  });

  it("keeps chardet's ranking for single-byte pages scoring above the step", async () => {
    // Regression guard for the opposite mistake: chardet's `sbcs` family scores
    // `Math.floor(rawPercent * 300)`, which really does land on 11…33. Those are
    // single-byte pages ranking themselves, NOT the multi-byte no-evidence step,
    // and treating them as "no opinion" was measured to make things worse — four
    // ISO-8859-1 samples chardet had right got handed to the heuristic, which
    // guessed windows-1251. Latin-1 text must therefore stay chardet's call.
    const latin = new Uint8Array(iconv.encode("Café naïve résumé à la française, señor. Voilà des accents.", "iso-8859-1"));
    const ranked = await rankCandidates(latin, DEFAULT_SUPPORTED_ENCODINGS);
    expect(ranked.ranked).toBe(true);
    expect(ranked.candidates[0]!.encoding).toBe("iso-8859-1");
  });

  it("keeps the correct page in the list for short CJK input", async () => {
    // The coverage property, which is what the union can actually deliver:
    // chardet's cap of three fills up with pages it could not separate, so the
    // correct page is often fourth and is lost. Measured on `中文测试`, GB18030
    // (this plugin's `gbk`) sits fifth behind four sibling pages and the model
    // was told to re-read a GBK file as Shift-JIS.
    for (const [text, enc] of [
      ["中文测试", "gbk"],
      ["中文测试内容", "gbk"],
      ["日本語", "shift_jis"],
      ["こんにちは", "shift_jis"],
      ["密碼錯誤", "big5"],
    ] as const) {
      const result = await getTop3Candidates(gbkAs(text, enc), DEFAULT_SUPPORTED_ENCODINGS);
      expect(result.map((c) => c.encoding)).toContain(enc);
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("does not let a non-family 10 stand in for the multi-byte floor", async () => {
    // The case decided by `CHARDET_FLOOR_FAMILIES`. `Utf8.match` returns 10 for a
    // buffer with no multi-byte sequence at all — the same NUMBER as the
    // multi-byte step, from an unrelated branch meaning something else. With
    // `utf8` allowed, chardet's filtered verdicts here are UTF-8(10), Big5(10),
    // GB18030(10): every value is the step, and only the page NAME keeps this
    // from looking like an abstention. Remove the family check and the list is
    // wrongly declared unranked, discarding three pages chardet did offer.
    const ascii = new Uint8Array(Buffer.from("hello, this is plain ascii text.", "utf8"));
    const ranked = await rankCandidates(ascii, ["utf8", "gbk", "big5"]);
    expect(ranked.candidates.map((c) => c.encoding)).toEqual(["utf8", "big5", "gbk"]);
    expect(ranked.ranked).toBe(true);
    expect(ranked.basis).toBe("chardet-ranked");
  });

  it("treats an all-floor multi-byte list as an abstention, not a ranking", async () => {
    // The counterpart, and the reason the family check is load-bearing in both
    // directions: with `utf8` out of the allowlist every remaining verdict IS the
    // multi-byte step, so this must report an abstention. Deleting the family
    // check flips the test above; deleting the floor test flips this one.
    const ascii = new Uint8Array(Buffer.from("hello, this is plain ascii text.", "utf8"));
    const ranked = await rankCandidates(ascii, ["gbk", "big5", "shift_jis"]);
    expect(ranked.ranked).toBe(false);
    expect(ranked.basis).toBe("chardet-abstained");
    expect(ranked.candidates.map((c) => c.encoding)).not.toContain("utf8");
  });

  it("treats a lone floor verdict as an abstention too", async () => {
    // A single floor verdict is chardet saying it could not rank, so it must not
    // be adopted as a decision just because it is the only one. Measured shape:
    // `["windows-1251","gbk"]` on Shift_JIS bytes yields one floor verdict and a
    // list whose head scores 10 while the tail scores 103 — the head is plainly
    // not the best candidate, so `ranked` must be false.
    const bytes = gbkAs("日本語", "shift_jis");
    const ranked = await rankCandidates(bytes, ["windows-1251", "gbk"]);
    expect(ranked.basis).toBe("chardet-abstained");
    expect(ranked.ranked).toBe(false);
  });

  it("reports heuristic-only when chardet has no verdict at all", async () => {
    // The chardet-less shape (it is an `optionalDependency`): no second opinion
    // exists, so the heuristic is the deployment's only signal and is adopted —
    // `basis` keeps that distinct from a chardet abstention, which is the case
    // worth caveating. An allowlist chardet has no recogniser for reaches the
    // same branch without uninstalling anything: for Shift_JIS bytes, `gbk` IS
    // matched (as GB18030, at the floor → abstention) while `windows-1251` is
    // not matched at all (→ heuristic-only).
    const bytes = gbkAs("日本語", "shift_jis");
    const matched = await rankCandidates(bytes, ["gbk"]);
    expect(matched.basis).toBe("chardet-abstained");

    const unmatched = await rankCandidates(bytes, ["windows-1251"]);
    expect(unmatched.basis).toBe("heuristic-only");
    expect(unmatched.ranked).toBe(true);
    expect(unmatched.candidates.map((c) => c.encoding)).toEqual(["windows-1251"]);
  });

  it("extends a short chardet list with heuristic candidates", async () => {
    // Measured over 461 samples: appending instead of replacing raised the rate
    // at which the correct encoding appears from 364/461 to 375/461 while
    // leaving the top-1 rate at 256/461. The union tail must therefore contain a
    // page chardet itself did NOT name — asserting only that `gbk` is present
    // would pass under a plain "replace" implementation too, because the
    // heuristic's own head is `gbk` for this fixture.
    const bytes = gbk("中文测试");
    const verdicts = await chardetTop3Candidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    const named = new Set(verdicts.map((v) => v.encoding));

    const result = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(result.basis).toBe("chardet-abstained");
    const added = result.candidates.filter((c) => !named.has(c.encoding));
    // A page chardet never named can only come from the heuristic — this is what
    // the union buys, and what "replace" would lose.
    expect(added.length).toBeGreaterThan(0);
    expect(added.map((c) => c.encoding)).toContain("gbk");
  });

  it("does not run the heuristic when chardet ranked a full list", async () => {
    // The performance gate, pinned by its observable consequence: with three
    // ranked verdicts the returned scores are chardet's own confidences, so the
    // list is untouched by `scoreText`. A heuristic pass would replace them with
    // 100-scale values, so asserting the raw confidences distinguishes the two.
    const bytes = gbk("中文测试内容中文测试数据");
    const verdicts = await chardetTop3Candidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(verdicts.length).toBeGreaterThanOrEqual(3);
    const ranked = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(ranked.candidates.map((c) => c.score)).toEqual(verdicts.slice(0, 3).map((v) => v.confidence));
  });

  it("prefers a Latin page when chardet named one the allowlist cannot use", async () => {
    // The case that made `heuristic-only` the largest source of silent
    // mis-encodings. For this fixture chardet reports `ISO-8859-2:16
    // ISO-8859-9:16` — both Latin pages, neither in the allowlist — so every
    // verdict is filtered out and the branch looks identical to "chardet is not
    // installed". The heuristic then picks `windows-1251`, because Cyrillic has a
    // `scriptBonus` entry and plain Latin has none, so a Cyrillic reading scores
    // strictly higher than the correct Latin one.
    //
    // Without the fix the head is `windows-1251` and the model sees `CafÃ©`.
    // Measured over 1682 Latin/Cyrillic samples the rule repaired 18
    // windows-1252 files, broke 0, and never fired on a true Cyrillic file.
    const bytes = gbkAs("Café résumé naïve", "windows-1252");
    const ranked = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(ranked.basis).toBe("heuristic-only");
    expect(ranked.candidates[0]?.encoding).toBe("windows-1252");
    expect(decodeBytes(bytes, ranked.candidates[0]?.encoding ?? "")).toBe("Café résumé naïve");
  });

  it("still adopts the heuristic head when chardet named no Latin page", async () => {
    // The other half of the rule, and the reason it is a PREFERENCE rather than a
    // refusal: chardet naming an East Asian page the allowlist rejects says
    // nothing about which Latin page is right, so the heuristic's head must stand.
    // Here chardet reports only `Shift_JIS:10 Big5:10 GB18030:10`, all filtered
    // out by the single-entry allowlist, and `windows-1251` must remain the pick.
    const bytes = gbkAs("日本語", "shift_jis");
    const ranked = await rankCandidates(bytes, ["windows-1251"]);
    expect(ranked.basis).toBe("heuristic-only");
    expect(ranked.candidates.map((c) => c.encoding)).toEqual(["windows-1251"]);
  });

  it("does not promote a Latin page over a Cyrillic head chardet did not refute", async () => {
    // The silent-corruption guard, and the reason the rule is gated on chardet
    // NAMING a Latin page rather than merely staying silent. For these bytes
    // chardet reports `UTF-32LE:80 ASCII:0` — it has named no script at all — and
    // the heuristic's list is `[windows-1251, windows-1252, iso-8859-1]`. The
    // Cyrillic head is CORRECT and the Latin alternative is WRONG, so dropping
    // the gate would silently rewrite the file as windows-1252 and destroy the
    // text on write-back.
    //
    // Widening the gate to "chardet named no non-Latin page" was measured and
    // rejected: it fixed 20 Latin files but broke 6 Cyrillic ones, and every
    // short Cyrillic word in this shape (`я`, `в`, `и`, `а`, `у`, `о`, `с`, `к`)
    // has only 1-2 Cyrillic letters, so no score margin separates it from a
    // Latin word with one accented letter. Refusing to widen is the honest call.
    const bytes = gbkAs("я", "windows-1251");
    const ranked = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(ranked.basis).toBe("heuristic-only");
    expect(ranked.candidates[0]?.encoding).toBe("windows-1251");
    expect(decodeBytes(bytes, ranked.candidates[0]?.encoding ?? "")).toBe("я");
  });

  it("keeps a ranked Cyrillic verdict even when a Latin page is also listed", async () => {
    // The same guard one branch over: when chardet DOES rank `windows-1251`, the
    // rule is not reachable at all. Asserting the head pins that the protection is
    // structural rather than incidental.
    const bytes = gbkAs("Это тестовый файл в кодировке Windows-1251.", "windows-1251");
    const ranked = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(ranked.basis).toBe("chardet-ranked");
    expect(ranked.candidates[0]?.encoding).toBe("windows-1251");
  });

  it("refuses to adopt a single-byte head that a CJK file's bytes contradict", async () => {
    // chardet ranks `ISO-8859-1:27` above the `Big5:10` that is actually right,
    // because its `sbcs` scorer counts the ASCII letters and spaces that the
    // WRONG page's own decode manufactures: each 2-byte CJK character becomes two
    // Latin-1 characters, so the misread is 92% non-ASCII. Adopting it showed the
    // model `ÁcÅé¤¤¤å´ú¸Õ` and would have written that back.
    //
    // The fix is the non-ASCII share of the head's own decode, not a score margin:
    // measured over 385 samples this rule refused 0 files that previously read
    // correctly while converting 24 silent mis-reads into a recoverable refusal.
    const bytes = gbkAs("繁體中文測試", "big5");
    const ranked = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(ranked.basis).toBe("chardet-ranked");
    expect(ranked.candidates[0]?.encoding).toBe("iso-8859-1");
    expect(ranked.adoptable).toBe(false);
  });

  it("still adopts a single-byte head when the decode looks like Western text", async () => {
    // The other side of the same rule, and the reason it tests the DECODE rather
    // than the page name. Accented Western prose also has a CJK page on chardet's
    // list (all at the floor), but its correct single-byte reading is only 10%
    // non-ASCII — letters and spaces dominate — so it must still be adopted.
    // Measured shares for this family are 0.00–0.25 against 0.50–1.00 for the
    // misread CJK family; the ranges do not overlap.
    const bytes = gbkAs("L’équipe technique a résolu le problème.", "windows-1252");
    const ranked = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(ranked.basis).toBe("chardet-ranked");
    expect(ranked.adoptable).toBe(true);
    expect(decodeBytes(bytes, ranked.candidates[0]?.encoding ?? "")).toBe(
      "L’équipe technique a résolu le problème.",
    );
  });

  it("adopts an ASCII source file whose only non-ASCII is a Latin comment", async () => {
    // The trap that a share-only rule has to survive: an ASCII-heavy file is
    // ~0% non-ASCII under ANY page, so a rule keyed on "mostly ASCII means
    // Western" would have to guess. Keying on the HEAD's decode instead leaves
    // this file adopted, because `iso-8859-1` reads it back exactly.
    const source = "// comment\nfunction handle(input) {\n  return input.trim();\n}\n";
    const bytes = gbkAs(source, "windows-1252");
    const ranked = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(ranked.adoptable).toBe(true);
    expect(decodeBytes(bytes, ranked.candidates[0]?.encoding ?? "")).toBe(source);
  });

  it("does not apply the single-byte guard to a correctly ranked Cyrillic page", async () => {
    // The guard is restricted to `iso-8859-1`/`windows-1252`. A Cyrillic file is
    // 75% non-ASCII and chardet ranks `windows-1251` correctly, so a guard keyed
    // on the share alone — without the page-name check — would refuse it.
    const bytes = gbkAs("Привет, мир!", "windows-1251");
    const ranked = await rankCandidates(bytes, DEFAULT_SUPPORTED_ENCODINGS);
    expect(ranked.basis).toBe("chardet-ranked");
    expect(ranked.adoptable).toBe(true);
    expect(ranked.candidates[0]?.encoding).toBe("windows-1251");
  });
});
