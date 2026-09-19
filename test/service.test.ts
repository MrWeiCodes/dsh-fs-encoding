/**
 * The `ctx.fsEncoding` service: the plugin's decoding rules as a public seam.
 *
 * Two kinds of test live here, and the distinction matters:
 *
 * 1. **Contract tests** — what another plugin can rely on. These are written
 *    from the CONSUMER's side (register the plugin, look the service up the way
 *    a consumer would, decode bytes it read itself), not from the plugin's
 *    internals, because the whole point of the seam is that a consumer never
 *    touches those internals.
 * 2. **Honesty tests** — the fields that exist so a consumer cannot
 *    accidentally present a guess as a fact. `decided` is the load-bearing one:
 *    a service that returned only a string would leave every consumer to either
 *    lie or re-derive the provenance, which is the failure this seam prevents.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt, TOOL_ORDER_REST } from "@deepseek-ai/dsh-system-prompt";
import { resetConfigCache } from "../src/config.js";
import { resetEncodingState } from "../src/encoding-state.js";
import { apply } from "../src/index.js";
import {
  FS_ENCODING_SERVICE,
  FsEncodingService,
  isFsEncodingService,
  provideFsEncoding,
} from "../src/service.js";

const gbk = (s: string) => new Uint8Array(iconv.encode(s, "gbk"));
const shiftJis = (s: string) => new Uint8Array(iconv.encode(s, "shift_jis"));
const utf8 = (s: string) => new TextEncoder().encode(s);

let dir: string;
/** A throwaway `$DSH_HOME`, so the effective config is the test's, not the developer's. */
let home: string;
let root: Context;
/** The service as a CONSUMER gets it — through the context, not an import. */
let service: FsEncodingService;

/** The env keys `loadConfig` reads, so a test can pin the effective config. */
const ENV_KEYS = [
  "DSH_FS_ENCODING_AUTO_GUESS",
  "DSH_FS_ENCODING_SUPPORTED_ENCODINGS",
  "DSH_FS_ENCODING_MAX_FILE_BYTES",
] as const;

let savedEnv: Record<string, string | undefined>;
let savedHome: string | undefined;

function setAutoGuess(on: boolean): void {
  process.env["DSH_FS_ENCODING_AUTO_GUESS"] = on ? "true" : "false";
  resetConfigCache();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-encoding-service-"));
  // Point `$DSH_HOME` at a throwaway directory BEFORE anything reads the config.
  // Without this the service resolves the developer's real
  // `$DSH_HOME/plugins/dsh-fs-encoding/config.yaml`: the assertions would then
  // depend on whatever that machine happens to have configured (a single
  // `excludeEncodings` line is enough to fail them), and `apply()` below would
  // materialize the default config inside the real home. Same isolation as
  // `config.test.ts`.
  home = await mkdtemp(join(tmpdir(), "fs-encoding-service-home-"));
  savedHome = process.env["DSH_HOME"];
  process.env["DSH_HOME"] = home;
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetConfigCache();
  // Guessing OFF is the shipped default, and it is the interesting case: a
  // consumer must be able to tell "not attempted" from "attempted and failed".
  setAutoGuess(false);

  root = new Context();
  root.provide("sandboxPolicy", {
    defaultMode: "workspace-write",
    resolve: () => ({ mode: "workspace-write", workspaceRoot: dir }),
  });
  new SandboxedFileSystem(root, { cwd: dir, diffBasisMaxBytes: 10 * 1024 * 1024 });
  new SystemPrompt(root, { toolOrder: [TOOL_ORDER_REST] });
  new ToolRuntime(root);
  resetEncodingState();

  apply(root);
  // Looked up the way a consumer does. `ctx.get` needs no `inject` declaration
  // and does not throw when the plugin is absent, which is exactly the
  // "optional dependency" shape a consumer wants.
  service = root.get(FS_ENCODING_SERVICE) as FsEncodingService;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (savedHome === undefined) delete process.env["DSH_HOME"];
  else process.env["DSH_HOME"] = savedHome;
  resetConfigCache();
  resetEncodingState();
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("the service is reachable the way a consumer reaches it", () => {
  it("registers under a name that does not collide with a DSH service", () => {
    expect(service).toBeDefined();
    expect(typeof service.tryDecode).toBe("function");
    expect(typeof service.decode).toBe("function");
  });

  it("is provided host-plane, so it survives without an agent", () => {
    // Provided at load time rather than per agent: a consumer that renders a
    // preview has no agent in hand, and the decoding rules do not vary by
    // session anyway.
    expect(root.get(FS_ENCODING_SERVICE)).toBe(service);
  });

  it("is optional, not injected — a consumer reads it and handles absence", () => {
    const bare = new Context();
    expect(bare.get(FS_ENCODING_SERVICE)).toBeUndefined();
  });

  it("is distinguishable by shape from a foreign object under the same name", () => {
    // When another plugin already owns the name, cordis keeps the FIRST provider
    // and the later `provide` throws, so `ctx.get` answers with that other
    // object rather than `undefined`. A consumer guarding only against
    // `undefined` would then call `tryDecode` on it and crash; the capability
    // check is what makes the lookup safe.
    expect(isFsEncodingService(service)).toBe(true);
    expect(isFsEncodingService({ notTheService: true })).toBe(false);
    expect(isFsEncodingService(undefined)).toBe(false);
    expect(isFsEncodingService(null)).toBe(false);
    expect(isFsEncodingService({ tryDecode: () => {} })).toBe(false);

    const occupied = new Context();
    occupied.provide(FS_ENCODING_SERVICE, { notTheService: true });
    expect(() => provideFsEncoding(occupied)).toThrow(/already|registered/i);
    // The foreign object is what a consumer would receive — and the shape check
    // is what tells it not to use it.
    expect(isFsEncodingService(occupied.get(FS_ENCODING_SERVICE))).toBe(false);
  });
});

describe("decoding bytes the caller read itself", () => {
  it("decodes valid UTF-8 and says the bytes decided it", async () => {
    const r = await service.decode(utf8("hello\nworld\n"));
    expect(r.text).toBe("hello\nworld\n");
    expect(r.encoding).toBe("utf8");
    // Not a guess: strict UTF-8 succeeded, so a consumer may present this as fact.
    expect(r.decided).toBe("utf8");
    expect(r.hasBOM).toBe(false);
  });

  it("decodes a BOM-carrying file and reports the BOM", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("hello\n")]);
    const r = await service.decode(bytes);
    // The BOM is stripped from the text but reported, so a consumer rendering
    // the content does not show a stray U+FEFF.
    expect(r.text).toBe("hello\n");
    expect(r.hasBOM).toBe(true);
    expect(r.decided).toBe("bom");
  });

  it("decodes a legacy file when the caller names the encoding", async () => {
    const r = await service.decode(gbk("你好，世界"), { encoding: "gbk" });
    expect(r.text).toBe("你好，世界");
    expect(r.encoding).toBe("gbk");
    // The caller chose, so this is determined — a consumer shows it as fact.
    expect(r.decided).toBe("hint");
  });

  it("decodes Shift-JIS too, so the seam is not GBK-specific", async () => {
    const r = await service.decode(shiftJis("こんにちは"), { encoding: "shift_jis" });
    expect(r.text).toBe("こんにちは");
    expect(r.encoding).toBe("shift_jis");
  });

  it("reports the line ending, so a consumer can render without guessing", async () => {
    const r = await service.decode(utf8("a\r\nb\r\n"));
    expect(r.lineEnding).toBe("\r\n");
  });

  it("recognises every canonical name as an explicit hint", async () => {
    // The vocabulary must be honest: a name this service advertises may not come
    // back as "unknown encoding". It may still FAIL to decode these particular
    // bytes — that is a property of the bytes, not of the name (UTF-32LE cannot
    // make sense of ASCII, and should say so) — but the name itself must be
    // known, or a chooser offering it would produce a confusing argument error.
    for (const enc of service.knownEncodings()) {
      const r = await service.tryDecode(utf8("plain ascii\n"), { encoding: enc });
      if (!r.ok) {
        expect(r.refusal.code, `${enc} should be a known name`).not.toBe("E_BAD_ENCODING");
      }
    }
  });

  it("rejects a name outside the vocabulary as an argument error", async () => {
    const r = await service.tryDecode(utf8("x"), { encoding: "definitely-not-an-encoding" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.code).toBe("E_BAD_ENCODING");
  });
});

describe("refusal is a value a consumer can act on", () => {
  it("refuses a legacy file with guessing off, and says guessing was off", async () => {
    const r = await service.tryDecode(gbk("你好，世界，这是中文内容测试"), {
      displayPath: "notes.txt",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.code).toBe("E_NOT_TEXT");
    // The load-bearing field: "not attempted" and "attempted and failed" need
    // different advice, and a consumer cannot tell them apart from the message.
    expect(r.refusal.autoGuessEnabled).toBe(false);
    expect(r.refusal.candidates.map((c) => c.encoding)).toContain("gbk");
    expect(r.refusal.message).toContain("notes.txt");
  });

  it("offers candidates that a consumer can hand straight back as an encoding", async () => {
    const bytes = gbk("你好，世界，这是中文内容测试");
    const refused = await service.tryDecode(bytes);
    if (refused.ok) throw new Error("expected a refusal");
    const pick = refused.refusal.candidates.find((c) => c.encoding === "gbk");
    expect(pick).toBeDefined();

    // The round trip a chooser performs: show candidates, take the human's
    // pick, decode again. It must work without the consumer knowing anything
    // about how the candidate was found.
    const r = await service.decode(bytes, { encoding: pick?.encoding });
    expect(r.text).toContain("你好，世界");
    expect(r.decided).toBe("hint");
  });

  it("offers usable candidate names even for content that is not text", async () => {
    // Every byte value, which no page decodes to clean prose. The service still
    // offers candidates, because `iso-8859-1` maps every byte to SOME character
    // and so never produces U+FFFD — so "candidates exist" is not by itself a
    // claim that one of them is right. That is exactly why `ranked`/`adoptable`
    // are reported separately from the list: a consumer must not treat a
    // non-empty list as a verdict.
    const binary = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) binary[i] = i;
    const r = await service.tryDecode(binary);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.code).toBe("E_NOT_TEXT");
    for (const candidate of r.refusal.candidates) {
      // Whatever is offered must be nameable, so a chooser can pass it back.
      expect(service.knownEncodings()).toContain(candidate.encoding);
    }
  });

  it("reports a credible-but-unadoptable head without recommending it", async () => {
    // The dangerous middle case, taken from the plugin's own measured corpus: a
    // Big5 file where chardet ranks `iso-8859-1` first. There IS an order, so
    // `ranked` is true — but the head is a page the plugin has decided is not
    // credible for these bytes, so `adoptable` is false. A consumer that reads
    // only the list would offer the head as a default and reproduce the mojibake
    // the refusal exists to prevent.
    setAutoGuess(true);
    const bytes = new Uint8Array(iconv.encode("繁體中文測試", "big5"));
    const r = await service.tryDecode(bytes, { displayPath: "legacy.txt" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.ranked).toBe(true);
    expect(r.refusal.adoptable).toBe(false);
    expect(r.refusal.candidates.length).toBeGreaterThan(0);
    // The refusal says why the head is not being recommended.
    expect(r.refusal.message).toContain("does not look credible");
  });

  it("reports an unknown encoding as an argument error, not a text failure", async () => {
    const r = await service.tryDecode(utf8("x"), { encoding: "klingon" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.code).toBe("E_BAD_ENCODING");
    // Nothing to choose between: the name was wrong, and the message says so.
    expect(r.refusal.candidates.length).toBe(0);
  });

  it("refuses a non-string encoding instead of throwing", async () => {
    // The consumer is another plugin, often plain JavaScript, and the README
    // tells it `tryDecode` never throws. A value that is merely the wrong TYPE
    // must therefore be a refusal too — `normalizeEncoding` would otherwise call
    // `.trim()` on it and the TypeError would escape this method entirely.
    for (const bad of [null, 123, {}, []]) {
      const r = await service.tryDecode(utf8("x"), { encoding: bad as never });
      expect(r.ok, `encoding=${JSON.stringify(bad)} should refuse`).toBe(false);
      if (r.ok) throw new Error("expected a refusal");
      expect(r.refusal.code).toBe("E_BAD_ENCODING");
    }
  });

  it("refuses a non-string displayPath instead of throwing", async () => {
    // Same contract, other argument: `displayPath` is interpolated into the
    // refusal message, so an object with a throwing `toString` must not be able
    // to turn a refusal into an exception either.
    for (const bad of [null, 123, {}, ["a"]]) {
      const r = await service.tryDecode(utf8("x"), { displayPath: bad as never });
      expect(r.ok, `displayPath=${JSON.stringify(bad)} should refuse`).toBe(false);
      if (r.ok) throw new Error("expected a refusal");
      expect(r.refusal.code).toBe("E_BAD_ENCODING");
    }
  });

  it("refuses bytes that are not a Uint8Array instead of throwing", async () => {
    // `decodeForOpen` reads `bytes.length` and indexes into the buffer, so a
    // non-buffer would fail deep inside admission with a TypeError rather than
    // coming back as a refusal. A `Buffer` must still be ACCEPTED — it is a
    // Uint8Array subclass, and it is what a Node consumer naturally has.
    for (const bad of ["hello", null, undefined, 123, {}, new ArrayBuffer(4)]) {
      const r = await service.tryDecode(bad as never);
      expect(r.ok, `bytes=${String(bad)} should refuse`).toBe(false);
      if (r.ok) throw new Error("expected a refusal");
      expect(r.refusal.code).toBe("E_BAD_ENCODING");
    }
    const fromBuffer = await service.tryDecode(Buffer.from("hello"));
    expect(fromBuffer.ok).toBe(true);
  });

  it("accepts a Uint8Array from another realm, which instanceof would reject", async () => {
    // DSH evaluates dynamic packages in a `node:vm` context, so a Uint8Array a
    // plugin built there has that realm's prototype and fails
    // `instanceof Uint8Array` — while every byte operation works. The refusal
    // would then claim the value "is not a Uint8Array" while it demonstrably is,
    // and the bytes would never be decoded. The check must be realm-independent.
    const vm = await import("node:vm");
    const crossRealm = vm.runInNewContext("new Uint8Array([104, 105, 10])") as Uint8Array;
    expect(crossRealm instanceof Uint8Array).toBe(false);
    const r = await service.tryDecode(crossRealm);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a decode");
    expect(r.result.text).toBe("hi\n");

    // Wider views are still refused: this service decodes BYTES, and a
    // multi-byte view would silently reinterpret the same buffer.
    expect((await service.tryDecode(new Uint16Array([1, 2]) as never)).ok).toBe(false);
    expect((await service.tryDecode(new DataView(new ArrayBuffer(2)) as never)).ok).toBe(false);
  });

  it("refuses an oversized buffer rather than ranking it", async () => {
    // The tool path gets its cap from `fs.readBytes`; this service takes bytes
    // the caller read, so it needs its own bound or a single large file stalls
    // the host event loop while every allowlisted encoding decodes it.
    const big = new Uint8Array(64);
    const r = await service.tryDecode(big, { maxBytes: 16 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.code).toBe("E_TOO_LARGE");
    // Under the cap the same bytes go through normally.
    expect((await service.tryDecode(big, { maxBytes: 1024 })).ok).toBe(true);
  });

  it("refuses an unusable maxBytes instead of silently narrowing the cap", async () => {
    // `Infinity` is the obvious way to write "no cap". Quietly turning it into
    // the plugin's limit would reject the call AND advise raising the argument
    // that was just ignored, so an unusable value is refused by name.
    const big = new Uint8Array(64);
    for (const nonsense of [Infinity, NaN, -1, 0, 1.5]) {
      const r = await service.tryDecode(big, { maxBytes: nonsense });
      expect(r.ok, `maxBytes=${String(nonsense)} should refuse`).toBe(false);
      if (r.ok) throw new Error("expected a refusal");
      expect(r.refusal.code).toBe("E_BAD_ENCODING");
    }
    // Omitting it still means "the deployment's own limit".
    expect((await service.tryDecode(big)).ok).toBe(true);
  });

  it("refuses a Proxy wrapping a buffer instead of throwing from deep inside", async () => {
    // `instanceof Uint8Array` is TRUE for a Proxy around one (the proxy forwards
    // `[[GetPrototypeOf]]`), but every TypedArray accessor on it throws
    // "incompatible receiver" because the proxy has no internal slot. Accepting
    // it would turn a bad argument into a TypeError escaping `tryDecode`, which
    // the documentation says never happens — the caller is told it can skip its
    // own `try`. `ArrayBuffer.isView` is false here, so the refusal stays a value.
    const proxied = new Proxy(new Uint8Array([0x61]), {});
    expect(proxied instanceof Uint8Array).toBe(true);
    expect(ArrayBuffer.isView(proxied)).toBe(false);
    const r = await service.tryDecode(proxied as never);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.code).toBe("E_BAD_ENCODING");
  });

  it("refuses a detached buffer instead of decoding it as empty or throwing", async () => {
    // A view over a transferred (detached) ArrayBuffer still passes
    // `ArrayBuffer.isView` and reports `byteLength === 0`. Without an explicit
    // guard it takes one of two wrong paths: a `Uint8Array` is returned as a
    // zero-length array and the caller decodes it as an EMPTY FILE — a silent
    // misread of a buffer whose bytes are gone — while a signed or clamped view
    // reaches `buffer.slice` and throws "Cannot perform ... on a detached
    // ArrayBuffer", a TypeError escaping `tryDecode`.
    for (const make of [
      (ab: ArrayBuffer) => new Uint8Array(ab),
      (ab: ArrayBuffer) => new Int8Array(ab),
      (ab: ArrayBuffer) => new Uint8ClampedArray(ab),
    ]) {
      const ab = new ArrayBuffer(4);
      const view = make(ab);
      view.set([0x68, 0x69, 0x0a, 0x00]);
      structuredClone(ab, { transfer: [ab] });
      expect(view.byteLength).toBe(0);
      expect(ArrayBuffer.isView(view)).toBe(true);

      const r = await service.tryDecode(view as never);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected a refusal");
      expect(r.refusal.code).toBe("E_BAD_ENCODING");
    }
  });

  it("refuses an over-limit foreign view before copying it", async () => {
    // Normalization copies a cross-realm or signed view, so the cap has to be
    // enforced BEFORE the copy: checking afterwards would duplicate an
    // arbitrarily large buffer first, which is the memory amplification the cap
    // exists to prevent. A `Uint8Array` from another realm exercises exactly
    // that path (it is not `instanceof` this realm's class, so it is copied).
    const vm = await import("node:vm");
    const foreign = vm.runInNewContext("new Uint8Array(64)") as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);

    const refused = await service.tryDecode(foreign, { maxBytes: 16 });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("E_TOO_LARGE");
    // And it still decodes normally once the cap allows it.
    expect((await service.tryDecode(foreign, { maxBytes: 1024 })).ok).toBe(true);
  });

  it("does not copy an over-limit foreign view at all", async () => {
    // The point of enforcing the cap before normalizing is that the copy never
    // happens, and a result-code assertion cannot see that — reverting the order
    // still yields `E_TOO_LARGE`, just after duplicating the buffer. The copy
    // goes through `view.buffer.slice(...)`, and for a cross-realm view that
    // resolves to the OTHER realm's `ArrayBuffer.prototype.slice`, so counting
    // calls there observes the copy directly. Zero calls means the cap was
    // enforced first.
    const vm = await import("node:vm");
    const sandbox: { sliceCalls: number } = { sliceCalls: 0 };
    const context = vm.createContext(sandbox);
    vm.runInContext(
      `const realSlice = ArrayBuffer.prototype.slice;
       ArrayBuffer.prototype.slice = function (...args) {
         globalThis.sliceCalls += 1;
         return realSlice.apply(this, args);
       };`,
      context,
    );
    const foreign = vm.runInContext("new Uint8Array(4096)", context) as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);

    const refused = await service.tryDecode(foreign, { maxBytes: 16 });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("E_TOO_LARGE");
    expect(sandbox.sliceCalls, "an over-limit view must not be copied").toBe(0);

    // Under the cap the same view IS copied (that is the normalization path),
    // which proves the counter would have seen it.
    expect((await service.tryDecode(foreign, { maxBytes: 8192 })).ok).toBe(true);
    expect(sandbox.sliceCalls).toBe(1);
  });

  it("refuses an unusable maxBytes without throwing while describing it", async () => {
    // The refusal message must describe the offending value, and describing it
    // is itself a place a throw can escape: `String(value)` on an object whose
    // `toString` throws, or on a Symbol. The method promises never to throw, so
    // the description has to be built without calling into the value.
    for (const hostile of [
      Symbol("x"),
      10n,
      { toString: () => { throw new Error("boom"); } },
      {},
      () => {},
    ]) {
      const r = await service.tryDecode(utf8("x"), { maxBytes: hostile as never });
      expect(r.ok, "hostile maxBytes should refuse").toBe(false);
      if (r.ok) throw new Error("expected a refusal");
      expect(r.refusal.code).toBe("E_BAD_ENCODING");
      expect(r.refusal.message).toContain("maxBytes must be a positive safe integer");
    }
  });

  it("answers the only question the lookup can actually settle", () => {
    // The mount's log needs to say what a CONSUMER will get, because that is
    // what decides whether the decoding rules are usable. "Was this object
    // created by us?" is not reliably answerable — `instanceof` fails across two
    // copies of this module, and a process-global registry can be cleared or
    // pre-seeded by any other plugin — so the check is the capability, and the
    // message is graded on it rather than on a guess at ownership.
    expect(isFsEncodingService(service)).toBe(true);
    expect(isFsEncodingService({ tryDecode: () => {}, decode: () => {} })).toBe(true);
    expect(isFsEncodingService({ tryDecode: () => {} })).toBe(false);
    expect(isFsEncodingService(undefined)).toBe(false);
    expect(isFsEncodingService(null)).toBe(false);
    expect(isFsEncodingService({})).toBe(false);
    expect(isFsEncodingService("fsEncoding")).toBe(false);
  });

  it("reports a name collision by what consumers will actually receive", () => {
    // The regression this guards: grading the log on an ownership guess made the
    // message assert the opposite of the truth in both directions — a duplicate
    // mount was called "another plugin's object" while working perfectly, and a
    // foreign object could be made to look like ours and be called "consumers
    // are unaffected" while offering nothing. The capability check cannot be
    // fooled either way.
    const occupied = new Context();
    occupied.provide(FS_ENCODING_SERVICE, { notTheService: true });
    expect(() => provideFsEncoding(occupied)).toThrow(/already|registered/i);
    // What a consumer receives is a foreign object with no decode entry points:
    // the error branch, and the message says exactly that.
    expect(isFsEncodingService(occupied.get(FS_ENCODING_SERVICE))).toBe(false);

    // A look-alike that DOES offer the entry points is graded as usable, because
    // it is: the methods a consumer calls are present and callable.
    const usable = new Context();
    usable.provide(FS_ENCODING_SERVICE, { tryDecode: () => {}, decode: () => {} });
    expect(isFsEncodingService(usable.get(FS_ENCODING_SERVICE))).toBe(true);
  });

  it("is not fooled by a squatter that mimics the old ownership marks", () => {
    // Earlier revisions tried to answer "did our own code create this?" with a
    // property brand and then a process-global registry. Both were unsound: the
    // brand key is a public string any plugin can compute, and the registry lives
    // on `globalThis` under that same public key, so a foreign plugin could
    // pre-seed it (making its object look like ours) or clear it (making a real
    // duplicate mount look foreign). Neither mistake is possible now, because the
    // check is the capability itself.
    const squatter: Record<symbol, unknown> = {};
    squatter[Symbol.for("dsh-fs-encoding.service")] = true;
    squatter[Symbol.for("dsh-fs-encoding.service.instances")] = new WeakSet();
    // No decode entry points, so it is refused however it is marked.
    expect(isFsEncodingService(squatter)).toBe(false);

    // A look-alike that copies a real instance's members IS usable and is
    // reported as such — which is the honest answer: a consumer calling
    // `tryDecode` on it gets a working method, whatever its provenance.
    const real = new FsEncodingService();
    const copy = Object.create(null) as Record<string | symbol, unknown>;
    for (const key of Reflect.ownKeys(real)) copy[key] = (real as never)[key as never];
    for (const key of Reflect.ownKeys(FsEncodingService.prototype)) {
      copy[key] = (FsEncodingService.prototype as never)[key as never];
    }
    expect(isFsEncodingService(copy)).toBe(true);
  });

  it("refuses a non-object opts instead of silently ignoring it", async () => {
    // Reading a field off a non-object does NOT throw — it yields `undefined`,
    // which is indistinguishable from "not supplied". So `tryDecode(bytes,
    // "gbk")`, the easy slip of forgetting the braces, used to drop the named
    // encoding and fall through to guessing: the caller got a different decoding
    // than it asked for, with nothing to signal it. `null` is refused too,
    // because it is what a missing value looks like in JSON and database rows,
    // so accepting it would hide the very caller bug this check surfaces.
    for (const bad of [null, 7, "gbk", "nope", true, Symbol("x"), 10n, () => {}]) {
      const r = await service.tryDecode(utf8("x"), bad as never);
      expect(r.ok, `opts=${String(bad)} should refuse`).toBe(false);
      if (r.ok) throw new Error("expected a refusal");
      expect(r.refusal.code).toBe("E_BAD_ENCODING");
      expect(r.refusal.message).toContain("opts must be an object");
    }
    // Omitting the argument is the one spelling that means "use the defaults".
    expect((await service.tryDecode(utf8("x"))).ok).toBe(true);
    expect((await service.tryDecode(utf8("x"), {})).ok).toBe(true);
    expect((await service.tryDecode(utf8("x"), undefined)).ok).toBe(true);
    // And `decode` reports it the same way, as a thrown DecodeError.
    await expect(service.decode(utf8("x"), "gbk" as never)).rejects.toThrow(/opts must be an object/);
  });

  it("does not let a mistyped opts change which encoding is used", async () => {
    // The concrete consequence, on bytes that need the named encoding: passing
    // the encoding as a bare string (rather than inside the options object) must
    // fail loudly instead of decoding under a guess the caller never chose.
    const bytes = gbk("你好，世界，这是中文内容测试文件");
    const correct = await service.tryDecode(bytes, { encoding: "gbk" });
    expect(correct.ok).toBe(true);
    if (!correct.ok) throw new Error("expected a decode");
    expect(correct.result.encoding).toBe("gbk");

    const mistyped = await service.tryDecode(bytes, "gbk" as never);
    expect(mistyped.ok).toBe(false);
    if (mistyped.ok) throw new Error("expected a refusal");
    expect(mistyped.refusal.code).toBe("E_BAD_ENCODING");
  });

  it("throws the model-facing sentence from `decode`, for callers that want it", async () => {
    await expect(service.decode(gbk("你好，世界"), { displayPath: "x.txt" })).rejects.toThrow(
      /E_NOT_TEXT/,
    );
  });
});

describe("guessing, when the deployment enables it", () => {
  it("decodes a legacy file and marks it as guessed", async () => {
    setAutoGuess(true);
    const r = await service.decode(gbk("你好，世界，这是中文内容测试文件"));
    expect(r.encoding).toBe("gbk");
    // The distinction the whole `decided` field exists for: this is a
    // probabilistic pick, and a consumer MUST be able to tell.
    expect(r.decided).toBe("guessed");
  });

  it("reports guessing as enabled in a refusal it could not resolve", async () => {
    // A short Shift-JIS string: chardet names `shift_jis` and the heuristic names
    // `gbk`, so the two producers disagree and nothing establishes which is
    // right. Guessing ran and still refused, which is the case a consumer must
    // be able to describe as "we tried" rather than "we did not try".
    setAutoGuess(true);
    const r = await service.tryDecode(shiftJis("日本語"), { displayPath: "legacy.txt" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.autoGuessEnabled).toBe(true);
    // The refusal must not present the head as a recommendation.
    expect(r.refusal.message).not.toContain("Most likely");
  });

  it("still prefers a determination over a guess", async () => {
    setAutoGuess(true);
    // Valid UTF-8 must never be routed through the guesser, even with guessing
    // on: a guess here could only be worse than the certain answer.
    const r = await service.decode(utf8("plain\n"));
    expect(r.decided).toBe("utf8");
  });
});

describe("the service reports the deployment's policy, not its own opinion", () => {
  it("lists the effective guess set, honouring exclusions", () => {
    const before = service.supportedEncodings();
    expect(before).toContain("windows-1251");

    process.env["DSH_FS_ENCODING_SUPPORTED_ENCODINGS"] = "gbk, big5";
    resetConfigCache();
    const after = service.supportedEncodings();
    // The operator narrowed the set; a consumer offering a chooser must follow,
    // or it will offer pages this deployment deliberately excluded.
    expect(after).toEqual(["gbk", "big5"]);
  });

  it("separates the vocabulary from the policy", () => {
    process.env["DSH_FS_ENCODING_SUPPORTED_ENCODINGS"] = "gbk";
    resetConfigCache();
    // `knownEncodings` is what a NAME may be; `supportedEncodings` is what this
    // deployment will TRY. An explicit hint may name anything in the former.
    expect(service.supportedEncodings()).toEqual(["gbk"]);
    expect(service.knownEncodings()).toContain("utf16le");
    expect(service.knownEncodings().length).toBeGreaterThan(service.supportedEncodings().length);
  });

  it("exposes the auto-guess flag without parsing a message", () => {
    expect(service.autoGuessEnabled()).toBe(false);
    setAutoGuess(true);
    expect(service.autoGuessEnabled()).toBe(true);
  });

  it("answers the cheap UTF-8 question without running admission", () => {
    expect(service.isUtf8(utf8("hello"))).toBe(true);
    expect(service.isUtf8(gbk("你好"))).toBe(false);
    // An empty file is valid UTF-8 — the boundary a `!bytes.length` shortcut
    // would get right by accident and a strict decoder gets right by rule.
    expect(service.isUtf8(new Uint8Array(0))).toBe(true);
  });

  it("answers the UTF-8 question the same way admission does", async () => {
    // The two must not drift: a caller that probes with `isUtf8` and then calls
    // `decode` has to get the same verdict from both, or the documented "cheap
    // path" becomes a second, disagreeing decoder. The invariant is one-way —
    // valid UTF-8 always decodes (via the BOM step or the UTF-8 step), while
    // bytes that are NOT valid UTF-8 may still decode through a BOM or a guess.
    const samples = [
      utf8("plain ascii\n"),
      utf8(""),
      gbk("你好，世界"),
      new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
      new Uint8Array([0x80]),
    ];
    for (const bytes of samples) {
      const r = await service.tryDecode(bytes);
      if (service.isUtf8(bytes)) {
        expect(r.ok, "valid UTF-8 must not be refused").toBe(true);
        if (r.ok) expect(["utf8", "bom"]).toContain(r.result.decided);
      }
    }
  });
});

describe("the service is a question, not an observation", () => {
  it("records nothing, so a preview cannot authorize a later save", async () => {
    // A consumer decoding a file to RENDER it must not arm the plugin's
    // read-before-write gate. If it did, an approval preview would let a model
    // write a file it never read.
    const bytes = gbk("你好，世界");
    await service.decode(bytes, { encoding: "gbk" });
    await service.tryDecode(bytes, { displayPath: "x.txt" });

    const { encodingStateCount } = await import("../src/encoding-state.js");
    expect(encodingStateCount()).toBe(0);
  });

  it("is deterministic — the same bytes give the same answer twice", async () => {
    const bytes = gbk("你好，世界，这是中文内容测试");
    setAutoGuess(true);
    const first = await service.decode(bytes);
    const second = await service.decode(bytes);
    expect(second.encoding).toBe(first.encoding);
    expect(second.text).toBe(first.text);
  });

  it("does not cache across a config change", async () => {
    const bytes = gbk("你好，世界，这是中文内容测试");
    // Guessing off: refusal. The service reads the effective config per call,
    // so flipping it must change the answer without re-registering anything.
    const refused = await service.tryDecode(bytes);
    expect(refused.ok).toBe(false);
    setAutoGuess(true);
    const accepted = await service.tryDecode(bytes);
    expect(accepted.ok).toBe(true);
  });
});
