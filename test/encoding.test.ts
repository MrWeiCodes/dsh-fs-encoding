import { describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import {
  chardetTop3Candidates,
  decodeBytes,
  detectBom,
  encodeText,
  getTop3Candidates,
  isValidUtf8,
  normalizeEncoding,
  scoreText,
  top3Candidates,
} from "../src/encoding.js";

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const gbk = (s: string) => new Uint8Array(iconv.encode(s, "gbk"));

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

  it("rejects unknown names", () => {
    expect(normalizeEncoding("klingon")).toBeUndefined();
    expect(normalizeEncoding("")).toBeUndefined();
    expect(normalizeEncoding("   ")).toBeUndefined();
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
