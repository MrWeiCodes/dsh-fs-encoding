import { describe, expect, it } from "vitest";
import iconv from "iconv-lite";
import {
  decodeForOpen,
  encodeForSave,
  DecodeError,
  getEncodingState,
  invalidateIfStale,
  isStale,
  openStateFor,
  provenanceOf,
  resetEncodingState,
  setEncodingState,
  UnmappableError,
  type FileEncodingState,
} from "../src/encoding-state.js";
import {
  CANONICAL_ENCODINGS,
  DEFAULT_SUPPORTED_ENCODINGS,
  decodeBytes,
  encodeText,
  isAcceptableDecode,
  unassignedBytes,
} from "../src/encoding.js";
import { UTF8_BOM_BYTES } from "../src/line-endings.js";

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const gbk = (s: string) => new Uint8Array(iconv.encode(s, "gbk"));
const shiftJis = (s: string) => new Uint8Array(iconv.encode(s, "shift_jis"));
const big5 = (s: string) => new Uint8Array(iconv.encode(s, "big5"));
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

  it("refuses rather than records a short Shift_JIS file under a page nobody ranked", async () => {
    // The corruption, pinned end to end. The heuristic's `scoreText` puts `gbk`
    // in the same band whichever East Asian page is correct, so an earlier
    // margin rule promoted it and recorded `gbk` for this file: the model saw
    // `擔杮岅`, which is printable, U+FFFD-free, and re-encodes to the ORIGINAL
    // bytes under gbk — so a write-back reproduced the file and nothing noticed.
    //
    // For this input chardet names `shift_jis` and the heuristic names `gbk`, so
    // the two disagree and nothing establishes which is right. The read must
    // therefore fail loudly with the candidates rather than silently adopt
    // either page. Measured over 1915 native samples, an unranked head is wrong
    // 79% of the time; adopting it is the corruption, refusing is the fix.
    const bytes = shiftJis("日本語");
    await expect(decodeForOpen(bytes, guessing)).rejects.toThrow(/E_NOT_TEXT/);
    try {
      await decodeForOpen(bytes, guessing, { displayPath: "legacy.txt" });
      expect.unreachable("expected E_NOT_TEXT");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("Most likely");
      expect(message).toContain("unordered");
      // The list is still offered, with samples, so the model can choose.
      expect(message).toMatch(/shift_jis\(".+?"\)/);
      expect(message).toContain('file_path: "legacy.txt"');
    }
  });

  it("adopts a page when chardet and the heuristic independently agree on it", async () => {
    // Agreement is the one piece of real evidence in an abstention: measured, 62
    // of 75 such cases are correct, against 21% for chardet's head alone and 36%
    // for the heuristic's. Here both name `shift_jis`, so the read succeeds.
    const r = await decodeForOpen(shiftJis("こんにちは"), guessing);
    expect(r.encoding).toBe("shift_jis");
    expect(r.text).toBe("こんにちは");
    // It is still a guess, so the footer must say so.
    expect(r.footer).toBeDefined();
    expect(r.footer).toContain("No encoding could be ranked above the others");
  });

  it("never prints candidate scores that contradict the adopted pick", async () => {
    // An abstention list unions chardet's confidences (its floor, 10) with the
    // heuristic's `scoreText` values (up to ~115). `unionByScore` now re-scores
    // every entry onto the `scoreText` scale so the exported field means one
    // thing — measured, the concatenated list used to be non-monotone in 475 of
    // 552 abstained samples. The footer still prints no numbers here, because
    // the order is chardet's rather than the score order, and printing numbers
    // beside an order they did not produce invites the model to distrust it.
    const r = await decodeForOpen(shiftJis("こんにちは"), guessing);
    expect(r.footer).toBeDefined();
    const footer = r.footer as string;
    expect(footer).toContain("No encoding could be ranked above the others");
    // No candidate number may appear: that is what removed the contradiction.
    expect(footer).not.toMatch(/\b(?:shift_jis|gbk|big5|euc-kr)\s+\d/);
  });

  it("does not call a rejected single-byte head most-likely", async () => {
    // The message defect this pins. `isImplausibleSingleByteHead` returns
    // `{ ranked: true, adoptable: false }` — the order is chardet's real ranking,
    // but the head is a page the plugin has just decided is not credible. An
    // earlier revision branched the wording on `ranked` alone, so this file got
    // "Most likely iso-8859-1" plus a copy-pasteable
    // `read({ ..., encoding: "iso-8859-1" })` — recommending the exact page the
    // refusal existed to prevent, and handing the model the mangled text
    // `ÁcÅé¤¤¤å´ú¸Õ`. Measured, that sentence was emitted for 100% of these
    // refusals before the wording branched on `adoptable`.
    //
    // The full default allowlist is required: the rule only fires when chardet
    // ranks `iso-8859-1`, which needs that page to be permitted.
    const wide = { autoGuessEncoding: true, supportedEncodings: [...DEFAULT_SUPPORTED_ENCODINGS] };
    try {
      await decodeForOpen(big5("繁體中文測試"), wide, { displayPath: "legacy.txt" });
      expect.unreachable("expected E_NOT_TEXT");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as DecodeError).code).toBe("E_NOT_TEXT");
      expect(message).not.toContain("Most likely");
      // It must say WHY the top pick is not being recommended, so the model does
      // not read the list as a ranking it should follow from the top.
      expect(message).toContain("does not look credible");
      // The list is still offered, in chardet's order, with a usable call shape.
      expect(message).toContain("big5");
      expect(message).toContain('file_path: "legacy.txt"');
    }
  });

  it("does not claim a most-likely encoding when nothing could be ranked", async () => {
    // `buildTop3Message`'s "Most likely X" is acted on by the model, so it must
    // not be emitted from a list nothing separated. Measured: this input's
    // candidates are all at chardet's floor, and an earlier revision still said
    // "Most likely shift_jis" — a claim the ranking could not support either way.
    try {
      await decodeForOpen(shiftJis("日本語"), noGuess, { displayPath: "legacy.txt" });
      expect.unreachable("expected E_NOT_TEXT");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as DecodeError).code).toBe("E_NOT_TEXT");
      expect(message).not.toContain("Most likely");
      expect(message).toContain("unordered");
      // The list is still offered, so the caller can choose with the samples in
      // front of it rather than being told nothing.
      expect(message).toContain("shift_jis");
      expect(message).toContain('file_path: "legacy.txt"');
    }
  });

  it("offers the unranked list as a real list, not an empty one", async () => {
    // An abstention must still enumerate candidates. The failure this pins is a
    // fallback to an EMPTY list, which would render as "No candidate encoding
    // decoded cleanly. This may be a binary file." — a wrong diagnosis for a
    // perfectly decodable legacy text file. It is also the shape a `try/catch`
    // around the ranking would produce, and nothing in that chain can throw for a
    // config-shaped allowlist, so such a catch could only ever hide a bug.
    try {
      await decodeForOpen(shiftJis("日本語"), noGuess, { displayPath: "legacy.txt" });
      expect.unreachable("expected E_NOT_TEXT");
    } catch (error) {
      const message = (error as Error).message;
      expect((error as DecodeError).code).toBe("E_NOT_TEXT");
      expect(message).not.toContain("binary file");
      // At least the page that decodes the bytes must be named, with a sample.
      expect(message).toMatch(/shift_jis\(".+?"\)/);
    }
  });

  it("honors an explicit encoding hint and bypasses guessing", async () => {
    const r = await decodeForOpen(gbk("你好"), noGuess, { encodingHint: "gbk" });
    expect(r.text).toBe("你好");
    expect(r.encoding).toBe("gbk");
    expect(r.hasBOM).toBe(false);
  });

  it("keeps hasBOM when the hint names the BOM-carrying form", async () => {
    // The name has to MATCH the mark, and this test is the pair to
    // "refuses a BOM the named encoding cannot write back". An earlier version of
    // it asserted `encodingHint: "utf8"` here and expected `hasBOM: true` — a
    // state the save cannot honour, because `encodeForSave` writes a BOM only for
    // the `utf8bom` name. That expectation was the bug: the read reported a BOM
    // the write then dropped. Naming `utf8bom` is what actually keeps it.
    const r = await decodeForOpen(withBom("hello"), noGuess, { encodingHint: "utf8bom" });
    expect(r.text).toBe("hello");
    expect(r.hasBOM).toBe(true);
    expect(r.encoding).toBe("utf8bom");
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

  it("does not lock a file out when the session's own recorded name is reused", async () => {
    // The regression this pins: `io.ts` feeds the session's recorded encoding back
    // as the hint on every later read. A file whose first read went through the
    // GUESS branch records a page that reads the mark as CONTENT, so a check that
    // compared encoding NAMES alone refused it on the second read — and no name
    // could reopen it, because the file's real mark was never the recorded one.
    // The file became unreadable and uneditable for the rest of the session.
    //
    // What makes it admissible is that the legacy page reproduces the mark bytes
    // as content, which is what `incompatibleBom` now asks the codec instead of
    // assuming. The allowlist is the default set, because reaching the guess
    // branch for a BOM-prefixed body needs a page that can read the mark as text.
    const permissive = {
      autoGuessEncoding: true,
      supportedEncodings: [...DEFAULT_SUPPORTED_ENCODINGS],
    };
    for (const bytes of [
      // UTF-8 BOM followed by GBK text, whose mark bytes no UTF-8 decoder accepts.
      Uint8Array.from([0xef, 0xbb, 0xbf, 0xd6, 0xd0, 0xce, 0xc4]),
      // UTF-8 BOM followed by a truncated sequence.
      Uint8Array.from([0xef, 0xbb, 0xbf, 0xe4, 0xb8]),
    ]) {
      const first = await decodeForOpen(bytes, permissive, { displayPath: "probe.txt" });
      expect(first.decided).toBe("guessed");
      expect(first.hasBOM).toBe(false);

      // The second read is the one that used to fail.
      const second = await decodeForOpen(bytes, permissive, {
        encodingHint: first.encoding,
        displayPath: "probe.txt",
      });
      expect(second.encoding).toBe(first.encoding);
      expect(second.text).toBe(first.text);

      // And the bytes really are reproducible under that recorded name.
      const saved = encodeForSave(second.text, openStateFor(second, undefined));
      expect(Buffer.from(saved.bytes).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("does not lock a file out when only the BODY is non-canonical", async () => {
    // The same lockout in its second shape, and the one a whole-file byte compare
    // gets wrong. The mark here IS reproducible — the page reads `EF BB BF` as
    // content and writes it straight back — but a byte pair further along is
    // non-canonical (`A2 E3` for the euro sign, written back as `80`; `A3 A0` for
    // the ideographic space, written back as `A1 A1`), so a check that asked
    // "would re-encoding reproduce EVERY byte" blamed the mark, refused a file
    // whose mark is fine, and named `utf8bom` as the remedy for a body `utf8bom`
    // cannot decode at all. The refusal landed on the SECOND read, so a file the
    // first read had just accepted stopped opening for the rest of the session.
    //
    // The mark question is therefore asked of the MARK. Byte fidelity is NOT
    // asserted below, and deliberately so: these bodies legitimately change bytes
    // on save, which is the accepted behaviour of a canonicalising codec (see the
    // multi-byte cases in the encoding suite). What must hold is that the session
    // can still reopen the file and get the same text back.
    const permissive = {
      autoGuessEncoding: true,
      supportedEncodings: [...DEFAULT_SUPPORTED_ENCODINGS],
    };

    // Guess branch: the first read records a page that reads the mark as content,
    // and the recorded name must reopen the file. This is the user-visible half.
    const guessed = Uint8Array.from([0xef, 0xbb, 0xbf, 0x81, 0x41, 0xa2, 0xe3]);
    const firstGuessed = await decodeForOpen(guessed, permissive, { displayPath: "probe.txt" });
    expect(firstGuessed.decided).toBe("guessed");
    const secondGuessed = await decodeForOpen(guessed, permissive, {
      encodingHint: firstGuessed.encoding,
      displayPath: "probe.txt",
    });
    expect(secondGuessed.encoding).toBe(firstGuessed.encoding);
    expect(secondGuessed.text).toBe(firstGuessed.text);

    // Hint branch: a doubled mark over a non-canonical body, read as the page that
    // sees the marks as content. Refusing this is what a whole-file compare did.
    const doubled = Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0xa3, 0xa0, 0xd6, 0xd0, 0xce, 0xc4]);
    const hinted = await decodeForOpen(doubled, permissive, {
      encodingHint: "gbk",
      displayPath: "probe.txt",
    });
    expect(hinted.encoding).toBe("gbk");
    expect(hinted.hasBOM).toBe(false);
  });

  it("blames the decode, not the mark, when the body does not decode at all", async () => {
    // The mark refusal must not shadow the accurate message. `EF BB BF E4 B8` is a
    // utf8bom mark over a TRUNCATED sequence: `utf8` cannot read it, and neither
    // can `utf8bom`, so naming the mark as the obstacle would recommend a remedy
    // that fails too and send the model in a circle. The reason to refuse is that
    // the bytes do not decode, and that is what has to be said.
    for (const [hint, bytes] of [
      ["utf8", [0xef, 0xbb, 0xbf, 0xe4, 0xb8]],
      ["utf8", [0xff, 0xfe, 0x41, 0x00, 0x00, 0xd8]],
    ] as const) {
      try {
        await decodeForOpen(Uint8Array.from(bytes), noGuess, { encodingHint: hint, displayPath: "probe.md" });
        expect.unreachable("expected E_DECODE_FAILED");
      } catch (error) {
        const message = (error as Error).message;
        expect((error as DecodeError).code).toBe("E_DECODE_FAILED");
        expect(message).toContain(`cannot be decoded as ${hint}`);
        expect(message).not.toContain("byte-order mark");
      }
    }

    // A mark that IS the obstacle still says so, and its remedy works.
    try {
      await decodeForOpen(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41, 0x42]), noGuess, {
        encodingHint: "utf8",
        displayPath: "probe.md",
      });
      expect.unreachable("expected E_DECODE_FAILED");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("byte-order mark");
      expect(message).toContain('"utf8bom"');
    }
    const recovered = await decodeForOpen(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41, 0x42]), noGuess, {
      encodingHint: "utf8bom",
      displayPath: "probe.md",
    });
    expect(recovered.text).toBe("AB");
  });

  it("refuses a mark only PART of which the named encoding would drop", async () => {
    // Why the BOM question is a byte round trip and not a name comparison or a
    // "does the codec swallow the mark" probe. A codec can drop part of a foreign
    // mark and keep the rest as content: `utf16le` eats the leading `FF FE` of a
    // `utf32le` mark and reads `00 00` as a NUL, so adopting utf16le for such a
    // file loses two bytes on save. Asking whether the whole mark is swallowed
    // says no here and admits it.
    //
    // The other direction matters just as much, and the same test covers it: a
    // legacy page reads `EF BB BF` as `ï»¿`, which re-encodes to the very same
    // bytes, so those files ARE reproducible and must stay readable — refusing
    // them by name is what locked a file out of its own session.
    await expect(
      decodeForOpen(Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x41, 0x41, 0x41]), noGuess, {
        encodingHint: "utf16le",
        displayPath: "probe.md",
      }),
      "a utf32le mark read as utf16le loses its first two bytes",
    ).rejects.toThrow(/E_DECODE_FAILED/);

    // The reproducible pairings stay readable, and their bytes survive a save.
    for (const [hint, bytes] of [
      ["gbk", [0xef, 0xbb, 0xbf, 0x41, 0x42]],
      ["windows-1252", [0xef, 0xbb, 0xbf, 0x41, 0x42]],
      ["utf16be", [0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]],
    ] as const) {
      const admitted = await decodeForOpen(Uint8Array.from(bytes), noGuess, {
        encodingHint: hint,
        displayPath: "probe.md",
      });
      const saved = encodeForSave(admitted.text, openStateFor(admitted, undefined));
      expect(
        Buffer.from(saved.bytes).equals(Buffer.from(bytes)),
        `${hint} must reproduce the mark bytes it reads as content`,
      ).toBe(true);
    }
  });

  it("refuses a body that begins with mark bytes it cannot write back", async () => {
    // The double-strip regression: the hint branch hands `roundTrips` a range with
    // the mark already removed, so a second strip inside the helper ate 2-4 REAL
    // content bytes and the comparison then passed on the wrong range. Every BOM
    // family was affected, and each of these was admitted while its save silently
    // dropped bytes. They must be refused instead.
    for (const [hint, bytes] of [
      ["utf8bom", [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0xef, 0xbf, 0xbd]],
      ["utf16le", [0xff, 0xfe, 0xff, 0xfe, 0xfd, 0xff]],
      ["utf16be", [0xfe, 0xff, 0xfe, 0xff, 0xff, 0xfd]],
      ["utf32le", [0xff, 0xfe, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x00, 0xfd, 0xff, 0x00, 0x00]],
      ["utf32be", [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0xff, 0xfd]],
    ] as const) {
      await expect(
        decodeForOpen(Uint8Array.from(bytes), noGuess, { encodingHint: hint, displayPath: "probe.md" }),
        `${hint} must not adopt a body whose mark bytes it would drop`,
      ).rejects.toThrow(/E_DECODE_FAILED/);
    }
  });

  it("refuses a BOM body the mark's own page cannot reproduce", async () => {
    // Step 2 used to adopt on `decoded !== undefined` alone, so a body that the
    // mark's page decodes but cannot re-encode was taken on the strength of its
    // first two bytes — while the SAME bytes with an explicit hint of that name
    // were refused. A lone surrogate is the case: `00 D8` decodes to U+FFFD and
    // re-encodes to `FD FF`, so a save rewrites bytes the user never edited.
    //
    // The assertion is that step 2 REFUSES these bytes, which is what the title
    // claims. It deliberately does NOT claim that every adopted file is
    // byte-reproducible: that is a stronger invariant this plugin does not
    // establish, and asserting it here would be false comfort. A truncated
    // UTF-32 body is the counterexample — `FF FE 00 00 41 00 00` decodes to ""
    // with no U+FFFD at all, so rule 1 admits it and a save drops the tail. That
    // case is pre-existing (HEAD behaves the same) and is not what step 2 fixed.
    for (const bytes of [
      [0xff, 0xfe, 0x41, 0x00, 0x00, 0xd8],
      [0xfe, 0xff, 0x00, 0x41, 0xd8, 0x00],
    ]) {
      // Guessing off, so nothing can rescue the body after step 2 declines it.
      await expect(
        decodeForOpen(Uint8Array.from(bytes), {
          autoGuessEncoding: false,
          supportedEncodings: [...DEFAULT_SUPPORTED_ENCODINGS],
        }, { displayPath: "probe.txt" }),
        "step 2 must not adopt a surrogate body on the strength of its mark",
      ).rejects.toThrow(/E_NOT_TEXT/);
    }
  });

  it("refuses a BOM the named encoding cannot write back", async () => {
    // A save takes its BOM from the encoding NAME, while the read strips the
    // file's real BOM before decoding. When the two disagree the save rewrites
    // the prefix, so a file whose BOM the name does not account for must not be
    // adopted — however clean its text is. This is the case a body-only round
    // trip called reversible.
    await expect(
      decodeForOpen(Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbf, 0xbd]), noGuess, {
        encodingHint: "utf8",
        displayPath: "probe.md",
      }),
    ).rejects.toThrow(/E_DECODE_FAILED/);

    await expect(
      decodeForOpen(Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0xfd, 0xff]), noGuess, {
        encodingHint: "utf16le",
        displayPath: "probe.md",
      }),
    ).rejects.toThrow(/E_DECODE_FAILED/);

    // The matching form stays readable, and its bytes survive an untouched save.
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbf, 0xbd]);
    const admitted = await decodeForOpen(bytes, noGuess, {
      encodingHint: "utf8bom",
      displayPath: "probe.md",
    });
    expect(admitted.text).toBe("\uFFFD");
    const saved = encodeForSave(admitted.text, openStateFor(admitted, undefined));
    expect(Buffer.from(saved.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("admits a legal UTF-8 file whose CONTENT holds a literal U+FFFD", async () => {
    // `EF BF BD` IS U+FFFD's own UTF-8 encoding, so the character can be file
    // content rather than a decoder's footprint. The old text rule could not tell
    // those apart, so step 3 (strict UTF-8) accepted these bytes while the hint
    // branch refused them — same bytes, opposite answers, one call. UTF-8 has no
    // unassigned bytes, so the character is spellable there and must be admitted.
    const bytes = Uint8Array.from([0x58, 0xef, 0xbf, 0xbd, 0x59]);

    // Both paths must agree, and both must admit.
    const bare = await decodeForOpen(bytes, noGuess, { displayPath: "probe.md" });
    expect(bare.encoding).toBe("utf8");
    expect(bare.decided).toBe("utf8");
    expect(bare.text).toBe("X\uFFFDY");

    // The hint is what a SECOND read of the same file uses (the session record
    // feeds it back as `encodingHint`), which is why the asymmetry locked the
    // file out permanently after a successful first read.
    const hinted = await decodeForOpen(bytes, noGuess, {
      encodingHint: "utf8",
      displayPath: "probe.md",
    });
    expect(hinted.encoding).toBe("utf8");
    expect(hinted.decided).toBe("hint");
    expect(hinted.text).toBe(bare.text);

    // The alias spelling a caller may pass explicitly.
    const aliased = await decodeForOpen(bytes, noGuess, {
      encodingHint: "utf-8",
      displayPath: "probe.md",
    });
    expect(aliased.text).toBe(bare.text);
  });

  it("still refuses bytes that only LOOK like that file, in both directions", async () => {
    // The fix must not become a general reprieve. A truncated sequence is NOT the
    // character, and a decode that does not even succeed cannot be adopted.
    await expect(
      decodeForOpen(Uint8Array.from([0x58, 0xef, 0xbf, 0x59]), noGuess, {
        encodingHint: "utf8",
      }),
    ).rejects.toThrow(/E_DECODE_FAILED/);

    // And the historical corruption stays refused: a wrong single-byte page that
    // hits an unassigned byte produces the same U+FFFD as the right page, so no
    // text rule separates them — and the round trip cannot either, since U+FFFD
    // re-encodes onto a gap byte. Accepting this was what rewrote 0x81 as 0x9D.
    await expect(
      decodeForOpen(Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x81, 0x20, 0x6d]), noGuess, {
        encodingHint: "windows-1252",
        displayPath: "menu.txt",
      }),
    ).rejects.toThrow(/E_DECODE_FAILED/);
  });

  it("admits a legal multi-byte file the byte round trip alone would refuse", async () => {
    // `iconv-lite`'s encoders canonicalise rather than invert, so a byte-exact
    // round trip is the WRONG admission test: these sequences decode to ordinary
    // characters with no U+FFFD at all, but write back as a different (equally
    // valid) pair. Measured, 2091 Shift-JIS byte pairs and 100 Big5 ones do this.
    //
    // A gate that demanded the round trip refused these files — and refused them
    // under the CORRECT encoding too, so no spelling of the name could open them.
    // Each case below is a file that must stay readable. The bytes are written
    // out literally rather than produced with `encodeText`, because the whole
    // point is the NON-canonical spelling: encoding the text would yield the
    // canonical pair that iconv-lite prefers, and the fixture would stop testing
    // anything.
    const cases = [
      // The CP936 spelling of the euro sign; iconv writes 0x80 instead.
      ["gbk", Uint8Array.from([0xa2, 0xe3]), "\u20AC"],
      // The CP936 spelling of the ideographic space; iconv writes A1 A1 instead.
      ["gbk", Uint8Array.from([0xa3, 0xa0]), "\u3000"],
      // A CP932 NEC row-13 character, written back as its canonical twin.
      ["shift_jis", Uint8Array.from([0x87, 0x90]), "\u2252"],
      // A Big5 ETEN character, likewise.
      ["big5", Uint8Array.from([0x8e, 0x69]), "\u7BB8"],
    ] as const;

    for (const [enc, bytes, expected] of cases) {
      const viaHint = await decodeForOpen(bytes, noGuess, { encodingHint: enc, displayPath: "doc.txt" });
      expect(viaHint.text, `${enc} must read its own bytes back`).toBe(expected);
      expect(viaHint.encoding).toBe(enc);

      // The bytes really are non-canonical: re-encoding does NOT reproduce them,
      // which is exactly why a round trip cannot be the admission test.
      const back = encodeText(viaHint.text, enc)!;
      expect(
        Buffer.from(back).equals(Buffer.from(bytes)),
        `${enc} fixture must exercise a non-canonical mapping`,
      ).toBe(false);
    }
  });

  it("refuses a page whose U+FFFD can only be its own unassigned byte", async () => {
    // The distinction the text rule could not draw, and the one a byte round trip
    // cannot draw either. windows-1252 leaves five bytes unassigned, and
    // `iconv-lite` writes U+FFFD onto one of them (0x9D) — so a decoder-invented
    // replacement re-encodes to the very byte it came from and round-trips
    // perfectly. Accepting that was the third form of the historical corruption:
    // the wrong page adopted, and a save rewriting the file.
    //
    // What settles it is not the round trip but the page's own gap table: if the
    // character's encoding lands on a byte the page leaves unassigned, the U+FFFD
    // cannot have come from the file. The list is derived from the SAME table the
    // rule reads, so a page cannot quietly become the exception by being left off
    // it: every canonical encoding that has a gap is covered, and the assertion
    // below fails loudly if one that had gaps ever stops having them.
    const gapPages = CANONICAL_ENCODINGS.filter((enc) => unassignedBytes(enc).length > 0);
    // Measured: seven pages, all of the Windows ANSI family. The number is pinned
    // so that a page silently dropping out of the list is a failure rather than a
    // quietly narrower test.
    expect(gapPages.length, `expected the seven Windows pages, got ${gapPages.join(", ")}`).toBe(7);
    for (const enc of gapPages) {
      const gaps = unassignedBytes(enc);
      expect(gaps.length, `${enc} must have gaps for this test to mean anything`).toBeGreaterThan(0);
      for (const gap of gaps) {
        await expect(
          decodeForOpen(Uint8Array.from([0x58, gap, 0x59]), noGuess, { encodingHint: enc }),
          `${enc} must refuse its own unassigned byte 0x${gap.toString(16)}`,
        ).rejects.toThrow(/E_DECODE_FAILED/);
      }
    }

    // The character itself is still readable in the encodings that really can
    // spell it: UTF-8 spells it `EF BF BD`, UTF-16LE spells it `FD FF`, and
    // neither page has a gap for it to hide in.
    const utf8Literal = await decodeForOpen(Uint8Array.from([0x58, 0xef, 0xbf, 0xbd, 0x59]), noGuess, {
      encodingHint: "utf8",
    });
    expect(utf8Literal.text).toBe("X\uFFFDY");
    const utf16Literal = await decodeForOpen(
      Uint8Array.from([0x58, 0x00, 0xfd, 0xff, 0x59, 0x00]),
      noGuess,
      { encodingHint: "utf16le" },
    );
    expect(utf16Literal.text).toBe("X\uFFFDY");
  });

  it("admits a literal U+FFFD in UTF-16, and refuses a lone surrogate", async () => {
    // `FD FF` is U+FFFD in UTF-16LE, so the same false positive existed there.
    // A lone surrogate is a different case: it also decodes to U+FFFD, but the
    // text rule could not see it at all, while the round trip does (`00 D8`
    // becomes `FD FF`).
    const literal = Uint8Array.from([0x58, 0x00, 0xfd, 0xff, 0x59, 0x00]);
    const admitted = await decodeForOpen(literal, noGuess, { encodingHint: "utf16le" });
    expect(admitted.text).toBe("X\uFFFDY");

    await expect(
      decodeForOpen(Uint8Array.from([0x58, 0x00, 0x00, 0xd8, 0x59, 0x00]), noGuess, {
        encodingHint: "utf16le",
      }),
    ).rejects.toThrow(/E_DECODE_FAILED/);
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

describe("encodeForSave — newFileEncoding (a file being created)", () => {
  it("creates the file in the named encoding when there is no state", () => {
    const out = encodeForSave("你好，世界", undefined, { newFileEncoding: "gbk" });
    expect(out.encoding).toBe("gbk");
    expect(Buffer.from(out.bytes).equals(Buffer.from(iconv.encode("你好，世界", "gbk")))).toBe(true);
  });

  it("defaults to UTF-8 when neither state nor a name is present", () => {
    const out = encodeForSave("你好", undefined);
    expect(out.encoding).toBe("utf8");
    expect(Buffer.from(out.bytes).toString("utf8")).toBe("你好");
  });

  it("gives a BOM only for a BOM-carrying name", () => {
    // `utf8bom`/`utf16le` denote BOM-carrying forms on the read side, so a new
    // file created under one must carry it. Every other name stays BOM-free.
    expect(encodeForSave("x", undefined, { newFileEncoding: "utf8bom" }).hasBOM).toBe(true);
    expect(encodeForSave("x", undefined, { newFileEncoding: "utf8" }).hasBOM).toBe(false);
    expect(encodeForSave("x", undefined, { newFileEncoding: "gbk" }).hasBOM).toBe(false);
    expect(encodeForSave("x", undefined, { newFileEncoding: "utf16le" }).hasBOM).toBe(true);

    const le = encodeForSave("x", undefined, { newFileEncoding: "utf16le" });
    expect([le.bytes[0], le.bytes[1]]).toEqual([0xff, 0xfe]);
  });

  it("refuses content the named encoding cannot represent", () => {
    expect(() => encodeForSave("emoji 🎉", undefined, { newFileEncoding: "gbk" })).toThrow(
      UnmappableError,
    );
  });

  it("lets an existing file's own encoding win over the name", () => {
    // The backstop for plan B's precedence: a recorded encoding is never
    // overridden by `newFileEncoding`. `tool-write` refuses the argument earlier
    // on an existing file, so this asserts the lower layer cannot be talked into
    // a conversion either.
    const state: FileEncodingState = {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    };
    const out = encodeForSave("你好", state, { newFileEncoding: "big5" });
    expect(out.encoding).toBe("gbk");
    expect(Buffer.from(out.bytes).equals(Buffer.from(iconv.encode("你好", "gbk")))).toBe(true);
  });

  it("is not migrated to UTF-8 by the normalizeToUtf8 config", () => {
    // `normalizeToUtf8` retires the encoding of an EXISTING legacy file on its
    // first save. A caller naming an encoding for a NEW file has asked for that
    // encoding, so a global config must not silently overrule it and create the
    // file as UTF-8 while the reply implies otherwise.
    const out = encodeForSave("你好", undefined, {
      newFileEncoding: "gbk",
      normalizeToUtf8: true,
    });
    expect(out.encoding).toBe("gbk");
    expect(Buffer.from(out.bytes).equals(Buffer.from(iconv.encode("你好", "gbk")))).toBe(true);
  });

  it("still migrates an EXISTING legacy file under the same config", () => {
    // The other half of the gate above: the migration must keep working for the
    // case it was written for.
    const state: FileEncodingState = {
      encoding: "gbk",
      hasBOM: false,
      lineEnding: "\n",
      version: undefined,
    };
    const out = encodeForSave("你好", state, { normalizeToUtf8: true });
    expect(out.encoding).toBe("utf8");
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

describe("provenanceOf is the single definition of a record's provenance", () => {
  // Shared by the read path (which feeds it to `openStateFor`, so a memo-reusing
  // read does not relabel a guess as a determination) and the service (which
  // reports it to a consumer that must agree with a tool). Two copies would
  // eventually disagree, and the disagreement is visible in exactly the way the
  // field exists to prevent: one side presenting a guess as a determination.
  //
  // These cases are the ones the REAL paths cannot produce, which is why they
  // need pinning here: every record this plugin writes carries `decided`, so on
  // the ordinary paths `decided` and `footer` agree and a broken fallback rule
  // would go unnoticed. The distinguishing inputs are a record that predates
  // `decided` (footer only) and one where the two disagree.
  //
  // The required fields are filled by a helper so each case states only what it
  // is about; spelling out `encoding`/`hasBOM`/`lineEnding`/`version` in every
  // literal would bury the two fields under test.
  const rec = (
    fields: Partial<Pick<FileEncodingState, "decided" | "footer">>,
  ): FileEncodingState => ({
    encoding: "gbk",
    hasBOM: false,
    lineEnding: "\n",
    version: undefined,
    ...fields,
  });

  it("prefers decided when the record carries one", () => {
    expect(provenanceOf(rec({ decided: "utf8" }))).toBe("utf8");
    expect(provenanceOf(rec({ decided: "bom" }))).toBe("bom");
    expect(provenanceOf(rec({ decided: "hint" }))).toBe("hint");
    expect(provenanceOf(rec({ decided: "guessed" }))).toBe("guessed");
  });

  it("falls back to the footer for a record that predates decided", () => {
    // The footer is written ONLY by the guess path, so its presence proves the
    // encoding was guessed. Without this fallback such a record would fall
    // through to the caller's `"hint"` and present a guess as a determination.
    expect(provenanceOf(rec({ footer: "Auto-guessed GBK (best of 3)" }))).toBe("guessed");
    // A footer that is present but EMPTY still counts as present — `!== undefined`
    // is the rule, and the safe direction is to call it a guess.
    expect(provenanceOf(rec({ footer: "" }))).toBe("guessed");
  });

  it("lets decided win when the two disagree", () => {
    // The ordering matters and is the thing a swapped implementation gets wrong:
    // a record that says `utf8` while carrying a stale guess footer describes
    // UTF-8, and reporting `guessed` there would warn about a file that has
    // nothing to warn about.
    expect(provenanceOf(rec({ decided: "utf8", footer: "Auto-guessed GBK" }))).toBe("utf8");
    expect(provenanceOf(rec({ decided: "bom", footer: "Auto-guessed GBK" }))).toBe("bom");
    // Same value either way — the point is that `decided` is what was read.
    expect(provenanceOf(rec({ decided: "guessed", footer: "Auto-guessed GBK" }))).toBe("guessed");
  });

  it("answers undefined when the record says nothing", () => {
    // Not a guess and not a determination: the caller decides, because the read
    // path has a `"hint"` from admission to fall back on while the service has
    // to supply its own. Answering `"hint"` here would make that choice for both.
    expect(provenanceOf(undefined)).toBeUndefined();
    expect(provenanceOf(rec({}))).toBeUndefined();
  });
});

describe("isStale is the single definition of a record going out of date", () => {
  // Two callers share this comparison: `invalidateIfStale` DELETES on a
  // mismatch (the write path's guard) and the service REPORTS `undefined`
  // (a query, which must not change state). If they ever disagreed, a preview
  // and the tool that follows it would answer "is this record still good?"
  // differently — the class of inconsistency the service exists to end. These
  // tests pin the comparison itself, and the deletion that must keep matching
  // it.

  const stateAt = (version: string | undefined): FileEncodingState => ({
    encoding: "gbk",
    hasBOM: false,
    lineEnding: "\n",
    version,
  });

  it("compares by equality, in both directions", () => {
    expect(isStale(stateAt("v1"), "v1")).toBe(false);
    expect(isStale(stateAt("v1"), "v2")).toBe(true);
  });

  it("treats an unversioned record as stale against any real version", () => {
    // The fail-closed direction: a record that cannot be confirmed fresh is not
    // presented as fresh. This is why a caller that CAN pass the version should.
    expect(isStale(stateAt(undefined), "v1")).toBe(true);
  });

  it("treats a versioned record as stale against an absent version", () => {
    // The other direction, and the reason the service checks `currentVersion`
    // for `undefined` BEFORE calling this: `undefined` there means "do not
    // check", which must not be read as "the file reports no version".
    expect(isStale(stateAt("v1"), undefined)).toBe(true);
  });

  it("does not consider two absent versions stale", () => {
    // `undefined === undefined`: with neither side reporting a version there is
    // nothing to contradict the record.
    expect(isStale(stateAt(undefined), undefined)).toBe(false);
  });

  it("deletes exactly when isStale says so", () => {
    // The equivalence that keeps the two callers honest.
    resetEncodingState();
    for (const [recorded, current, expected] of [
      ["v1", "v1", "kept"],
      ["v1", "v2", "dropped"],
      [undefined, "v1", "dropped"],
      [undefined, undefined, "kept"],
    ] as const) {
      resetEncodingState();
      setEncodingState("s", "k", stateAt(recorded));
      invalidateIfStale("s", "k", current);
      const surviving = getEncodingState("s", "k");
      if (expected === "kept") expect(surviving, `${recorded}/${current}`).toBeDefined();
      else expect(surviving, `${recorded}/${current}`).toBeUndefined();
      // And the predicate agrees with what the deletion did.
      expect(isStale(stateAt(recorded), current)).toBe(expected === "dropped");
    }
    resetEncodingState();
  });
});
