import { describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import {
  decodeForOpen,
  encodeForSave,
  DecodeError,
  UnmappableError,
  type FileEncodingState,
} from "../src/encoding-state.js";
import { decodeBytes, isAcceptableDecode, unassignedBytes } from "../src/encoding.js";
import { UTF8_BOM_BYTES } from "../src/line-endings.js";

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const gbk = (s: string) => new Uint8Array(iconv.encode(s, "gbk"));
const withBom = (s: string) => {
  const body = utf8(s);
  const out = new Uint8Array(3 + body.length);
  out.set(UTF8_BOM_BYTES, 0);
  out.set(body, 3);
  return out;
};

const noGuess = { autoGuessEncoding: false, supportedEncodings: ["gbk", "big5", "shift_jis"] };
const guessing = { autoGuessEncoding: true, supportedEncodings: ["gbk", "big5", "shift_jis"] };

describe("decodeForOpen — deterministic admission", () => {
  it("decodes plain UTF-8", async () => {
    const r = await decodeForOpen(utf8("hello\nworld\n"), noGuess);
    expect(r.text).toBe("hello\nworld\n");
    expect(r.encoding).toBe("utf8");
    expect(r.hasBOM).toBe(false);
    expect(r.lineEnding).toBe("\n");
  });

  it("recognizes a UTF-8 BOM and strips it from the text", async () => {
    const r = await decodeForOpen(withBom("hello\n"), noGuess);
    expect(r.text).toBe("hello\n");
    expect(r.encoding).toBe("utf8bom");
    expect(r.hasBOM).toBe(true);
  });

  it("recognizes UTF-16LE and UTF-16BE BOMs", async () => {
    const le = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi 世界", "utf16le")]));
    const rLe = await decodeForOpen(le, noGuess);
    expect(rLe.encoding).toBe("utf16le");
    expect(rLe.hasBOM).toBe(true);
    expect(rLe.text).toBe("hi 世界");

    const beBody = iconv.encode("hi 世界", "utf16be");
    const be = new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(beBody)]));
    const rBe = await decodeForOpen(be, noGuess);
    expect(rBe.encoding).toBe("utf16be");
    expect(rBe.hasBOM).toBe(true);
    expect(rBe.text).toBe("hi 世界");
  });

  it("detects CRLF line endings", async () => {
    const r = await decodeForOpen(utf8("a\r\nb\r\n"), noGuess);
    expect(r.lineEnding).toBe("\r\n");
  });

  it("fails loud on GBK when guessing is off, listing candidates", async () => {
    await expect(decodeForOpen(gbk("你好，世界，这是中文内容测试"), noGuess)).rejects.toThrow(
      DecodeError,
    );
    try {
      await decodeForOpen(gbk("你好，世界，这是中文内容测试"), noGuess);
    } catch (error) {
      expect((error as DecodeError).code).toBe("E_NOT_TEXT");
      expect((error as Error).message).toContain("gbk");
      // The suggested call must be usable as written: `read` rejects a payload
      // without `file_path`, so the hint has to carry the path it refers to.
      expect((error as Error).message).toContain('file_path: "(unknown path)"');
      expect((error as Error).message).toContain('encoding: "gbk"');
    }
  });

  it("suggests a re-read call that carries the real path", async () => {
    try {
      await decodeForOpen(gbk("你好，世界，这是中文内容测试"), noGuess, {
        displayPath: "legacy.txt",
      });
      expect.unreachable("expected E_NOT_TEXT");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as DecodeError).code).toBe("E_NOT_TEXT");
      expect(message).toContain('read({ file_path: "legacy.txt", encoding: "gbk" })');
    }
  });

  it("auto-decodes GBK when guessing is on, with a footer", async () => {
    const r = await decodeForOpen(gbk("你好，世界，这是中文内容测试"), guessing);
    expect(r.text).toBe("你好，世界，这是中文内容测试");
    expect(r.encoding).toBe("gbk");
    expect(r.footer).toBeDefined();
    expect(r.footer).toContain("gbk");
  });

  it("honors an explicit encoding hint and bypasses guessing", async () => {
    const r = await decodeForOpen(gbk("你好"), noGuess, { encodingHint: "gbk" });
    expect(r.text).toBe("你好");
    expect(r.encoding).toBe("gbk");
    expect(r.hasBOM).toBe(false);
  });

  it("keeps hasBOM when an explicit hint is combined with a BOM", async () => {
    const r = await decodeForOpen(withBom("hello"), noGuess, { encodingHint: "utf8" });
    expect(r.text).toBe("hello");
    expect(r.hasBOM).toBe(true);
  });

  it("rejects an unknown encoding hint", async () => {
    await expect(
      decodeForOpen(utf8("x"), noGuess, { encodingHint: "klingon" }),
    ).rejects.toThrow(/E_BAD_ENCODING/);
  });

  it("rejects a hint whose bytes are not decodable at all", async () => {
    // An odd-length UTF-16LE payload cannot be a hint-decoded UTF-16 text.
    await expect(
      decodeForOpen(Uint8Array.from([0x41, 0x00, 0x42]), noGuess, { encodingHint: "utf16le" }),
    ).rejects.toThrow(/E_DECODE_FAILED/);
  });

  it("reports replacement characters from a wrong legacy hint", async () => {
    // 0xFF is never a valid GBK lead byte, so decoding it as GBK yields U+FFFD.
    await expect(
      decodeForOpen(Uint8Array.from([0x41, 0xff, 0x42]), noGuess, { encodingHint: "gbk" }),
    ).rejects.toThrow(/E_DECODE_FAILED/);
  });

  it("names the unassigned byte but offers no way to read the file anyway", async () => {
    // 0x81 has no character in windows-1252, so the byte is worth naming. But the
    // message must not hand the model a way to read the file as something it is
    // not: two revisions did, and both corrupted files. The first flipped the
    // verdict to "not necessarily wrong"; the second kept the verdict but
    // suggested re-reading with iso-8859-1 — following that on a Greek
    // windows-1253 file decoded it as Latin-1 mojibake with no U+FFFD, so it was
    // accepted and recorded as the session's encoding.
    //
    // Asserting on the absence of a phrase would be vacuous, so this checks the
    // absence of the ADVICE: no encoding name is proposed anywhere in the text.
    try {
      await decodeForOpen(
        Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x81, 0x20, 0x6d]),
        noGuess,
        { encodingHint: "windows-1252", displayPath: "menu.txt" },
      );
      expect.unreachable("expected E_DECODE_FAILED");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as DecodeError).code).toBe("E_DECODE_FAILED");
      // The useful, factual part is kept.
      expect(message).toContain("0x81");
      expect(message).toContain("probably wrong");
      // No alternative encoding is recommended, and no "read it anyway" is offered.
      expect(message).not.toContain("iso-8859-1");
      expect(message).not.toContain("re-reading it with");
      expect(message).toContain("Re-read without an encoding to see candidates");
    }
  });

  it("does not offer a way to read a genuinely wrong guess as something else", async () => {
    // A GBK file read as windows-1252. 0x81 is an unassigned windows-1252 byte, so
    // a rule keyed on "the file contains a gap byte" fires here — and it is wrong:
    // the file is GBK. The danger is not just the verdict, it is any instruction
    // that makes the wrong decode stick. iso-8859-1 would decode these bytes with
    // no U+FFFD at all, so it would be ACCEPTED and recorded as the encoding.
    const bytes = new Uint8Array(iconv.encode("\u4e02\u4e04\u4e05\u4e06", "gbk"));
    expect(bytes.includes(0x81), "fixture must contain a windows-1252 gap byte").toBe(true);

    // The property that makes the advice harmful, asserted as a CONTRAST on this
    // fixture: the hint's own page rejects these bytes while latin1 accepts them,
    // so latin1 is exactly the escape hatch that would make the wrong decode
    // stick. Asserting only `isAcceptableDecode(asLatin1) === true` would be
    // vacuous — iso-8859-1 maps all 256 byte values to non-U+FFFD characters, so
    // that holds for any input whatsoever. The windows-1252 half is what makes
    // this fixture-specific and able to fail.
    const asLatin1 = decodeBytes(bytes, "iso-8859-1");
    const asHintPage = decodeBytes(bytes, "windows-1252");
    expect(asLatin1).toBeDefined();
    expect(asHintPage).toBeDefined();
    expect(
      isAcceptableDecode(asHintPage!),
      "the hint's own page must reject this fixture, or the test proves nothing",
    ).toBe(false);
    expect(
      isAcceptableDecode(asLatin1!),
      "iso-8859-1 is the tempting-but-wrong escape hatch this test guards",
    ).toBe(true);

    try {
      await decodeForOpen(bytes, noGuess, {
        encodingHint: "windows-1252",
        displayPath: "gbk.txt",
      });
      expect.unreachable("expected E_DECODE_FAILED");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as DecodeError).code).toBe("E_DECODE_FAILED");
      expect(message).toContain("probably wrong");
      expect(message).not.toContain("iso-8859-1");
      expect(message).not.toContain("re-reading it with");
    }
  });

  it("blames the encoding when no unassigned byte is involved", async () => {
    // A real cp1252 file's bytes read as GBK: GBK is a multi-byte page, so it
    // has no "unassigned byte" story to tell at all, and the message carries no
    // byte note. The byte note is what distinguishes the two messages, so this
    // asserts on that rather than on wording that would hold either way.
    const cp1252Text = "\u201CCurly\u201D \u2014 it\u2019s caf\u00E9 r\u00E9sum\u00E9";
    const bytes = new Uint8Array(iconv.encode(cp1252Text, "windows-1252"));
    expect(unassignedBytes("gbk")).toEqual([]);
    try {
      await decodeForOpen(bytes, noGuess, { encodingHint: "gbk", displayPath: "x.txt" });
      expect.unreachable("expected E_DECODE_FAILED");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as DecodeError).code).toBe("E_DECODE_FAILED");
      expect(message).toContain("probably wrong");
      expect(message).not.toContain("has no character in");
    }
  });
});

describe("encodeForSave — invert at save", () => {
  it("defaults to UTF-8 without BOM for an unknown file", () => {
    const { bytes } = encodeForSave("hello", undefined);
    expect(Buffer.from(bytes).toString("utf8")).toBe("hello");
    expect(bytes[0]).not.toBe(0xef);
  });

  it("re-encodes a GBK file as GBK, not UTF-8", () => {
    const state: FileEncodingState = {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    };
    const { bytes } = encodeForSave("你好，世界", state);
    expect(new Uint8Array(iconv.encode("你好，世界", "gbk"))).toEqual(bytes);
    // Proof it is not UTF-8: decoding the same bytes as UTF-8 must fail.
    expect(bytes.length).toBeLessThan(utf8("你好，世界").length);
  });

  it("restores a UTF-8 BOM", () => {
    const state: FileEncodingState = {
      encoding: "utf8bom",
      hasBOM: true,
      lineEnding: "\n",
      version: undefined,
    };
    const { bytes } = encodeForSave("hello", state);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    expect(Buffer.from(bytes.subarray(3)).toString("utf8")).toBe("hello");
  });

  it("never adds a BOM to a file that had none", () => {
    const { bytes } = encodeForSave("hello", {
      encoding: "utf8",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    });
    expect(bytes[0]).not.toBe(0xef);
  });

  it("restores UTF-16LE and UTF-16BE BOMs as bytes", () => {
    const le: FileEncodingState = {
      encoding: "utf16le",
      hasBOM: true,
      lineEnding: "\n",
      version: undefined,
    };
    const { bytes: leBytes } = encodeForSave("hi", le);
    expect(leBytes[0]).toBe(0xff);
    expect(leBytes[1]).toBe(0xfe);

    const be: FileEncodingState = {
      encoding: "utf16be",
      hasBOM: true,
      lineEnding: "\n",
      version: undefined,
    };
    const { bytes: beBytes } = encodeForSave("hi", be);
    expect(beBytes[0]).toBe(0xfe);
    expect(beBytes[1]).toBe(0xff);
  });

  it("restores CRLF line endings", () => {
    const state: FileEncodingState = {
      encoding: "utf8",
      hasBOM: false,
      lineEnding: "\r\n",
      version: undefined,
    };
    const { bytes } = encodeForSave("a\nb\n", state);
    expect(Buffer.from(bytes).toString("utf8")).toBe("a\r\nb\r\n");
  });

  it("restores CRLF on a GBK file too", () => {
    const state: FileEncodingState = {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\r\n",
      version: undefined,
    };
    const { bytes } = encodeForSave("你好\n世界\n", state);
    expect(decodeAsGbk(bytes)).toBe("你好\r\n世界\r\n");
  });

  it("refuses to write a character the encoding cannot represent", () => {
    const state: FileEncodingState = {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    };
    expect(() => encodeForSave("hello 🎉", state)).toThrow(UnmappableError);
    try {
      encodeForSave("hello 🎉", state);
    } catch (error) {
      const e = error as UnmappableError;
      expect(e.message).toContain("E_UNMAPPABLE");
      expect(e.message).toContain("unchanged");
      expect(e.encoding).toBe("gbk");
      // The whole astral character must be reported, not a lone surrogate half.
      expect(e.detail.char).toBe("🎉");
      expect(e.detail.codePoint).toBe(0x1f389);
    }
  });

  it("reports the first unmappable character in a longer string", () => {
    const state: FileEncodingState = {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    };
    // GBK covers → and ① but has no emoji, so the emoji is the offender even
    // though it appears after characters that DO map.
    try {
      encodeForSave("中文→emoji 🎉 后面还有字", state);
      throw new Error("expected the save to be refused");
    } catch (error) {
      expect((error as UnmappableError).detail.char).toBe("🎉");
    }
  });

  it("allows the same character once normalizeToUtf8 migrates the file", () => {
    const state: FileEncodingState = {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    };
    const { bytes } = encodeForSave("hello 🎉", state, { normalizeToUtf8: true });
    expect(Buffer.from(bytes).toString("utf8")).toBe("hello 🎉");
  });

  it("does not migrate a UTF-8 file when normalizeToUtf8 is set", () => {
    const state: FileEncodingState = {
      encoding: "utf8bom",
      hasBOM: true,
      lineEnding: "\n",
      version: undefined,
    };
    const { bytes } = encodeForSave("x", state, { normalizeToUtf8: true });
    expect(bytes[0]).toBe(0xef);
  });
});

describe("byte-exact round-trip", () => {
  /**
   * A file is admitted the way the plugin really admits it: BOM-carrying files
   * are identified by their BOM, and legacy code pages are reached through the
   * explicit `encoding` hint a model gets from the failed-read candidate list.
   *
   * Guessing is deliberately NOT used here. GBK, Big5 and Shift-JIS overlap on
   * short inputs, so a guess is not a correctness guarantee — which is exactly
   * why `autoGuessEncoding` defaults to false.
   */
  const cases: Array<{
    name: string;
    text: string;
    encoding: string;
    hasBOM: boolean;
    hint?: string;
  }> = [
    { name: "utf8", text: "hello 世界\n", encoding: "utf8", hasBOM: false },
    { name: "utf8bom", text: "hello 世界\n", encoding: "utf8bom", hasBOM: true },
    { name: "gbk", text: "你好，世界\n第二行：中文内容\n", encoding: "gbk", hasBOM: false, hint: "gbk" },
    { name: "big5", text: "繁體中文測試\n", encoding: "big5", hasBOM: false, hint: "big5" },
    { name: "shift_jis", text: "こんにちは世界\n", encoding: "shift_jis", hasBOM: false, hint: "shift_jis" },
    { name: "euc-kr", text: "안녕하세요 세계\n", encoding: "euc-kr", hasBOM: false, hint: "euc-kr" },
    { name: "windows-1251", text: "Привет, мир\n", encoding: "windows-1251", hasBOM: false, hint: "windows-1251" },
    { name: "iso-8859-1", text: "Grüße, Welt\n", encoding: "iso-8859-1", hasBOM: false, hint: "iso-8859-1" },
    { name: "utf16le", text: "hello 世界\n", encoding: "utf16le", hasBOM: true },
    { name: "utf16be", text: "hello 世界\n", encoding: "utf16be", hasBOM: true },
    { name: "utf32le", text: "hello 世界\n", encoding: "utf32le", hasBOM: true },
    { name: "utf32be", text: "hello 世界\n", encoding: "utf32be", hasBOM: true },
  ];

  for (const c of cases) {
    it(`${c.name}: read then write reproduces the original bytes exactly`, async () => {
      const state: FileEncodingState = {
        encoding: c.encoding,
        hasBOM: c.hasBOM,
        lineEnding: "\n",
        version: undefined,
      };
      const { bytes: original } = encodeForSave(c.text, state);

      const decoded = await decodeForOpen(
        original,
        noGuess,
        c.hint === undefined ? {} : { encodingHint: c.hint },
      );
      expect(decoded.text).toBe(c.text);
      expect(decoded.hasBOM).toBe(c.hasBOM);

      const { bytes: rewritten } = encodeForSave(decoded.text, {
        encoding: decoded.encoding,
        hasBOM: decoded.hasBOM,
        lineEnding: decoded.lineEnding,
        version: undefined,
      });
      expect(Buffer.from(rewritten).equals(Buffer.from(original))).toBe(true);
    });

    it(`${c.name}: an edit changes only the edited characters`, async () => {
      const state: FileEncodingState = {
        encoding: c.encoding,
        hasBOM: c.hasBOM,
        lineEnding: "\n",
        version: undefined,
      };
      const { bytes: original } = encodeForSave(c.text, state);
      const decoded = await decodeForOpen(
        original,
        noGuess,
        c.hint === undefined ? {} : { encodingHint: c.hint },
      );

      // Replace one character rather than appending, so the assertion proves
      // the surviving bytes are re-encoded correctly and not merely concatenated.
      const firstChar = [...c.text][0]!;
      const edited = `${c.text.replace(firstChar, "X")}`;
      const { bytes: rewritten } = encodeForSave(edited, {
        encoding: decoded.encoding,
        hasBOM: decoded.hasBOM,
        lineEnding: decoded.lineEnding,
        version: undefined,
      });

      // The edited file must still be the same encoding, and re-read cleanly.
      const again = await decodeForOpen(
        rewritten,
        noGuess,
        c.hint === undefined ? {} : { encodingHint: c.hint },
      );
      expect(again.encoding).toBe(decoded.encoding);
      expect(again.text).toBe(edited);
    });
  }

  it("a GBK edit leaves the file encoded as GBK, not UTF-8", async () => {
    const text = "你好，世界\n";
    const state: FileEncodingState = {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    };
    const { bytes: original } = encodeForSave(text, state);
    const decoded = await decodeForOpen(original, noGuess, { encodingHint: "gbk" });
    const { bytes: rewritten } = encodeForSave(decoded.text.replace("世界", "地球"), {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    });

    // Must NOT be valid UTF-8 — that is the bug this plugin exists to fix.
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(rewritten)).toThrow();
    expect(decodeAsGbk(rewritten)).toBe("你好，地球\n");
  });

  it("a UTF-8 BOM survives a round-trip that changes content", async () => {
    const state: FileEncodingState = {
      encoding: "utf8bom",
      hasBOM: true,
      lineEnding: "\n",
      version: undefined,
    };
    const { bytes: original } = encodeForSave("hello bom\n", state);
    const decoded = await decodeForOpen(original, noGuess);
    const { bytes: rewritten } = encodeForSave(decoded.text.replace("bom", "BOM"), {
      encoding: decoded.encoding,
      hasBOM: decoded.hasBOM,
      lineEnding: decoded.lineEnding,
      version: undefined,
    });
    expect(rewritten[0]).toBe(0xef);
    expect(rewritten[1]).toBe(0xbb);
    expect(rewritten[2]).toBe(0xbf);
    expect(Buffer.from(rewritten.subarray(3)).toString("utf8")).toBe("hello BOM\n");
  });

  it("CRLF survives a round-trip byte-exactly", async () => {
    const text = "line one\r\nline two\r\n";
    const original = utf8(text);
    const decoded = await decodeForOpen(original, noGuess);
    expect(decoded.lineEnding).toBe("\r\n");
    const { bytes: rewritten } = encodeForSave(decoded.text, {
      encoding: decoded.encoding,
      hasBOM: decoded.hasBOM,
      lineEnding: decoded.lineEnding,
      version: undefined,
    });
    expect(Buffer.from(rewritten).equals(Buffer.from(original))).toBe(true);
  });

  it("CRLF survives on a GBK file too", async () => {
    const text = "你好\r\n世界\r\n";
    const original = new Uint8Array(iconv.encode(text, "gbk"));
    const decoded = await decodeForOpen(original, noGuess, { encodingHint: "gbk" });
    expect(decoded.lineEnding).toBe("\r\n");
    const { bytes: rewritten } = encodeForSave(decoded.text, {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: decoded.lineEnding,
      version: undefined,
    });
    expect(Buffer.from(rewritten).equals(Buffer.from(original))).toBe(true);
  });
});

function decodeAsGbk(bytes: Uint8Array): string {
  return iconv.decode(Buffer.from(bytes), "gbk");
}
