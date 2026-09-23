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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { FsTarget, FsVersion } from "@deepseek-ai/dsh-fs";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { SystemPrompt, TOOL_ORDER_REST } from "@deepseek-ai/dsh-system-prompt";
import { resetConfigCache } from "../src/config.js";
import { encodingStateCount, getEncodingState, resetEncodingState } from "../src/encoding-state.js";
import { apply } from "../src/index.js";
import { keyOf, readFile as pluginRead } from "../src/io.js";
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
  // `maxRetries` is load-bearing, not defensive noise: `apply()` materializes
  // the default config without awaiting it (`index.ts` — deliberately, so a
  // config failure cannot fail the boot), so that `mkdir` + `writeFile` can
  // still be in flight here. On Windows the removal can then list the directory,
  // have the background write recreate a file inside it, and fail the `rmdir`
  // with ENOTEMPTY — an error about the test's own cleanup, not about anything
  // under test. The retry gives the losing side of that race time to settle.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

  it("refuses an option whose getter throws, instead of letting it escape", async () => {
    // The option half of the hole. Every FIELD was validated, but the reads
    // themselves were bare `opts.field` accesses — and a getter, or a Proxy's
    // `get` trap, may throw. That turned a documented "never throws" into a
    // rejected promise for an `opts` that passes the object check, which is
    // precisely the shape a consumer skips its own `try` for. (The `bytes`
    // argument is the other half, and is covered by its own test below.)
    for (const key of ["encoding", "displayPath", "maxBytes"] as const) {
      const hostile = {
        get [key]() {
          throw new Error(`${key} getter boom`);
        },
      };
      const r = await service.tryDecode(utf8("x"), hostile as never);
      expect(r.ok, `a throwing ${key} getter should refuse`).toBe(false);
      if (r.ok) throw new Error("expected a refusal");
      expect(r.refusal.code).toBe("E_BAD_ENCODING");
      expect(r.refusal.message).toContain(`${key} could not be read`);
    }

    // A Proxy whose `get` trap throws is the same hole with no getter written.
    const proxied = new Proxy({}, {
      get() {
        throw new Error("proxy get boom");
      },
    });
    const viaProxy = await service.tryDecode(utf8("x"), proxied as never);
    expect(viaProxy.ok).toBe(false);

    // `decode` must report the same thing as a `DecodeError`, not a TypeError.
    await expect(
      service.decode(utf8("x"), {
        get encoding() {
          throw new Error("boom");
        },
      } as never),
    ).rejects.toThrow(/could not be read/);
  });

  it("reads the view's own bytes, never the view's own properties", async () => {
    // `ArrayBuffer.isView` proves the internal slot is present but says nothing
    // about who owns the PROPERTIES: a subclass — or `defineProperty` on a plain
    // instance — can shadow `buffer`, `byteOffset`, `byteLength` or `length` with
    // an accessor that throws, or with one that LIES. The byte layout is
    // therefore read through the prototype's own accessors (which read the
    // internal slots, cannot be shadowed and cannot lie), so a caller's accessors
    // are not consulted at all: a hostile view can neither redirect the decode
    // nor make it throw.
    //
    // `BYTES_PER_ELEMENT` is the exception, and only because it has no accessor
    // to capture: it is a data property of each concrete prototype, so the read
    // has to go through the value and a throwing accessor there IS reached. That
    // is still safe — it is refused rather than escaping — which is what the two
    // groups below pin down.
    for (const prop of ["buffer", "byteOffset", "byteLength", "length"] as const) {
      // Throwing accessor: never invoked, so this decodes rather than escaping.
      const throwing = new Uint8Array([0x61, 0x62, 0x63]);
      Object.defineProperty(throwing, prop, {
        get() {
          throw new Error(`${prop} boom`);
        },
      });
      const r = await service.tryDecode(throwing, { encoding: "utf8" });
      expect(r.ok, `a throwing ${prop} accessor must not escape`).toBe(true);
      if (!r.ok) throw new Error("expected a decode");
      expect(r.result.text, prop).toBe("abc");
    }
    // The element-size read cannot avoid the value, so a throw there becomes a
    // refusal. The point is that it does NOT escape `tryDecode`.
    const throwingElementSize = new Uint8Array([0x61, 0x62, 0x63]);
    Object.defineProperty(throwingElementSize, "BYTES_PER_ELEMENT", {
      get() {
        throw new Error("BYTES_PER_ELEMENT boom");
      },
    });
    const refusedElementSize = await service.tryDecode(throwingElementSize);
    expect(refusedElementSize.ok, "a throwing element-size accessor must refuse, not escape").toBe(false);
    if (refusedElementSize.ok) throw new Error("expected a refusal");
    expect(refusedElementSize.refusal.code).toBe("E_BAD_ENCODING");

    // A LYING accessor is the dangerous shape, and the reason the slots are read
    // instead of the properties: a guard that merely wrapped these reads in a
    // `try` would still have honoured the lie, silently decoding a different
    // range than the view denotes. Each of these lies about a different part of
    // the byte layout, and every one must be ignored.
    const backing = new Uint8Array([0x41, 0x42, 0x61, 0x62, 0x63]); // "ABabc"
    const lies: Array<[string, () => unknown]> = [
      ["buffer", () => new Uint8Array([0x58, 0x59, 0x5a]).buffer], // "XYZ"
      ["buffer", () => 4096], // not even a buffer
      ["byteOffset", () => 0], // would decode "ABa"
      ["byteLength", () => 1], // would decode "a"
      ["length", () => 999], // would decode past the view
    ];
    for (const [prop, lie] of lies) {
      const lying = backing.subarray(2);
      Object.defineProperty(lying, prop, { get: lie });
      const r = await service.tryDecode(lying, { encoding: "utf8" });
      expect(r.ok, `a lying ${prop} accessor must not redirect the decode`).toBe(true);
      if (!r.ok) throw new Error("expected a decode");
      expect(r.result.text, `the lie about ${prop} must be ignored`).toBe("abc");
    }

    // A class field is the accidental version of the same shadow — no malice,
    // just a name collision with a prototype getter. (Declared through
    // `defineProperty` rather than a class field because TypeScript refuses the
    // field outright: the shadow is a type error at the declaration site, which
    // is exactly why the runtime path still has to cope with it.)
    class CachedBuffer extends Uint8Array {}
    const cachedView = new CachedBuffer([0x61, 0x62, 0x63]);
    Object.defineProperty(cachedView, "buffer", { value: 8, writable: true });
    const cached = await service.tryDecode(cachedView, { encoding: "utf8" });
    expect(cached.ok).toBe(true);
    if (!cached.ok) throw new Error("expected a decode");
    expect(cached.result.text, "a shadowing class field must be ignored").toBe("abc");

    // The element size is what decides whether a view may be decoded as BYTES,
    // so a wider view claiming `BYTES_PER_ELEMENT === 1` must stay refused, or
    // the same buffer would be silently reinterpreted. The declaration is only a
    // first gate; the internal slots are what settle it (a one-byte view has as
    // many bytes as elements), which is why a lying declaration cannot pass.
    for (const lie of [
      () => 1,
      () => "1",
      () => true,
    ]) {
      const wider = new Uint16Array([0x6261]);
      Object.defineProperty(wider, "BYTES_PER_ELEMENT", { get: lie });
      const refusedWide = await service.tryDecode(wider as never);
      expect(refusedWide.ok, "a wider view must not pass by shadowing its element size").toBe(false);
      if (refusedWide.ok) throw new Error("expected a refusal");
      expect(refusedWide.refusal.code).toBe("E_BAD_ENCODING");
    }
    // A DATA shadow (not an accessor) is the same lie told without a getter.
    const widerData = new Uint16Array([0x6261]);
    Object.defineProperty(widerData, "BYTES_PER_ELEMENT", { value: 1, writable: true });
    expect((await service.tryDecode(widerData as never)).ok).toBe(false);

    // An empty wider view is the case a slot-only ratio cannot settle on its own
    // (`0 === 0` for every element size), so the declaration decides it: an empty
    // `Uint16Array` is still not a byte view and must stay refused.
    expect((await service.tryDecode(new Uint16Array(0) as never)).ok).toBe(false);

    // The detached check must also read the slot: a view over a transferred
    // buffer must stay refused no matter what its properties claim.
    const detached = new Uint8Array([0x61, 0x62, 0x63]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    Object.defineProperty(detached, "buffer", { get: () => new ArrayBuffer(3) });
    const refusedDetached = await service.tryDecode(detached);
    expect(refusedDetached.ok, "a detached buffer must stay refused").toBe(false);
    if (refusedDetached.ok) throw new Error("expected a refusal");
    expect(refusedDetached.refusal.code).toBe("E_BAD_ENCODING");
  });

  it("refuses a Proxy reporting an endless prototype chain, without hanging", async () => {
    // The element-size check must not walk the prototype chain by hand. A Proxy
    // whose `getPrototypeOf` trap returns a fresh proxy each time describes an
    // ENDLESS chain, and a hand-written walk would spin on it forever —
    // synchronously, blocking the host event loop for every session, which is a
    // worse failure than the throw this guard exists to stop. The native lookup
    // is guarded by the engine and terminates, so the read stays bounded.
    const endless: ProxyHandler<object> = {
      getOwnPropertyDescriptor: () => undefined,
      getPrototypeOf: () => new Proxy({}, endless),
    };
    const view = new Uint8Array([0x61, 0x62, 0x63]);
    Object.setPrototypeOf(view, new Proxy({}, endless));

    const r = await service.tryDecode(view);
    expect(r.ok, "an endless prototype chain must refuse, not hang").toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.code).toBe("E_BAD_ENCODING");

    // And it must not become a way past the element-size gate either: a wider
    // view that lies about its element size stays refused even when its
    // prototype chain cannot be enumerated.
    const wider = new Uint16Array([0x6261]);
    Object.defineProperty(wider, "BYTES_PER_ELEMENT", { value: 1 });
    Object.setPrototypeOf(wider, new Proxy({}, endless));
    expect((await service.tryDecode(wider as never)).ok).toBe(false);
  });

  it("still enforces the cap when the view lies about its size", async () => {
    // The cap has to be read from the slot too. An under-reported `byteLength` is
    // the shape that matters: it would otherwise walk an oversized view straight
    // past the cap and into the full candidate ranking the cap exists to prevent.
    const big = new Uint8Array(4096);
    Object.defineProperty(big, "byteLength", { get: () => 8 });
    const r = await service.tryDecode(big, { maxBytes: 16 });
    expect(r.ok, "an under-reported byteLength must not defeat the cap").toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.refusal.code).toBe("E_TOO_LARGE");

    // And an over-reported one must not refuse a view that is actually small.
    const small = new Uint8Array([0x61, 0x62, 0x63]);
    Object.defineProperty(small, "byteLength", { get: () => 1 << 20 });
    const allowed = await service.tryDecode(small, { maxBytes: 16, encoding: "utf8" });
    expect(allowed.ok, "an over-reported byteLength must not refuse a small view").toBe(true);

    // Both properties lied about at once. This is the combination that matters:
    // the cap is checked against the DECLARED length first, so a view that
    // under-reports `byteLength` walks past that gate — and if the second check
    // (on the view actually decoded) read the caller's `length` instead of the
    // slot, it would agree with the lie and the oversized buffer would be
    // decoded whole. Verified against the pre-change build, where this exact
    // input decoded all 4096 bytes under a 16-byte cap.
    const doubleLiar = new Uint8Array(4096);
    Object.defineProperty(doubleLiar, "byteLength", { get: () => 8 });
    Object.defineProperty(doubleLiar, "length", { get: () => 8 });
    const both = await service.tryDecode(doubleLiar, { maxBytes: 16 });
    expect(both.ok, "two agreeing lies must not defeat the cap").toBe(false);
    if (both.ok) throw new Error("expected a refusal");
    expect(both.refusal.code).toBe("E_TOO_LARGE");
  });

  it("decodes a view it had to re-view, honouring the view's own offset", async () => {
    // The guard re-views the caller's value so admission never touches the
    // caller's own accessors. That must stay a VIEW over the same bytes, with
    // the offset and length of the ORIGINAL view: rebuilding it as
    // `new Uint8Array(normalized.buffer)` would silently decode the whole
    // backing buffer — here four leading zero bytes the caller excluded.
    const gbkBytes = gbk("你好，世界");
    const padded = new Uint8Array(gbkBytes.length + 8);
    padded.set(gbkBytes, 4);
    const slice = padded.subarray(4, 4 + gbkBytes.length);
    expect(slice.byteOffset).toBe(4);

    const r = await service.tryDecode(slice, { encoding: "gbk" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a decode");
    expect(r.result.encoding).toBe("gbk");
    expect(r.result.text, "the excluded padding must not reach the decode").toBe("你好，世界");

    // And the view is not narrowed by the re-view either: a subarray of the
    // result must still address the caller's bytes, not a private copy.
    const whole = new Uint8Array(gbkBytes.length + 8);
    whole.set(gbkBytes, 4);
    const middle = whole.subarray(4, 4 + gbkBytes.length);
    const decoded = await service.tryDecode(middle, { encoding: "gbk" });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("expected a decode");
    expect(decoded.result.text).toBe("你好，世界");
  });

  it("still accepts every legitimate shape of opts after the guard", async () => {
    // The guard reads through an index signature, so the shapes that must keep
    // working are pinned here: an object with no prototype and a frozen object
    // both take the same path as a plain literal, and `encoding` must still
    // reach admission rather than being swallowed by the guard.
    const gbkBytes = gbk("你好，世界");
    for (const [name, opts] of [
      ["plain literal", { encoding: "gbk" }],
      ["frozen", Object.freeze({ encoding: "gbk" })],
      ["null-prototype", Object.assign(Object.create(null), { encoding: "gbk" })],
      ["all three fields", { encoding: "gbk", displayPath: "x.txt", maxBytes: 4096 }],
    ] as Array<[string, unknown]>) {
      const r = await service.tryDecode(gbkBytes, opts as never);
      expect(r.ok, `${name} should decode`).toBe(true);
      if (!r.ok) throw new Error("expected a decode");
      expect(r.result.encoding, name).toBe("gbk");
    }
    // And a getter that RETURNS a usable value is fine — the guard is about
    // throws, not about refusing accessors.
    const viaGetter = await service.tryDecode(gbkBytes, {
      get encoding() {
        return "gbk";
      },
    } as never);
    expect(viaGetter.ok).toBe(true);
    if (!viaGetter.ok) throw new Error("expected a decode");
    expect(viaGetter.result.encoding).toBe("gbk");
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

  it("asks about exactly the members the caller names", () => {
    // The reason the names are a parameter: an instance can be OLDER than the
    // consumer's idea of it (the first registration of the name wins, so a mount
    // may be handed an earlier build). A fixed list is wrong in one direction or
    // the other — verifying less than is called lets the call throw, verifying
    // more rejects an instance whose decode entry points work fine.
    expect(isFsEncodingService(service, "recordedEncoding")).toBe(true);
    expect(isFsEncodingService(service, "tryDecode", "recordedEncoding")).toBe(true);

    // A build from before `recordedEncoding` existed: the decode entry points
    // still answer `true`, and the newer method answers `false` — which is the
    // distinction a consumer needs to warn instead of silently degrading.
    const older = { tryDecode: () => {}, decode: () => {} };
    expect(isFsEncodingService(older)).toBe(true);
    expect(isFsEncodingService(older, "recordedEncoding")).toBe(false);
    expect(isFsEncodingService(older, "tryDecode", "recordedEncoding")).toBe(false);

    // A foreign object is refused whichever question is asked.
    expect(isFsEncodingService({ notTheService: true }, "recordedEncoding")).toBe(false);
    expect(isFsEncodingService(null, "recordedEncoding")).toBe(false);
  });

  it("stays a correct one-argument predicate in a callback position", () => {
    // The regression this guards: the historical signature was UNARY, so
    // consumers hand this function straight to `filter`/`find`/`every`. Those
    // call the predicate with `(element, index, array)`, so a variadic-only
    // implementation reads the INDEX as a method name, asks whether the object
    // has a method called `"0"`, and answers `false` for a perfectly good
    // service — silently, with no error. Measured before the fix: `filter` went
    // from 2 matches to 0 and `every` from `true` to `false`.
    const good = { tryDecode: () => {}, decode: () => {} };
    const pool = [good, service];

    expect(pool.filter(isFsEncodingService)).toHaveLength(2);
    expect(pool.every(isFsEncodingService)).toBe(true);
    expect(pool.find(isFsEncodingService)).toBe(good);

    // A name held in an optional variable is refused by the TYPES — a TypeScript
    // caller must decide which question it is asking rather than pass a maybe —
    // while the runtime tolerates it, because a plain-JavaScript consumer has no
    // overloads to consult and `undefined` there means "not asked for", not "a
    // member named undefined". The `@ts-expect-error` asserts the first half and
    // the assertion below it the second.
    // @ts-expect-error -- the types require the caller to decide
    expect(isFsEncodingService(good, undefined)).toBe(true);
    // @ts-expect-error -- ditto
    expect(isFsEncodingService(good, undefined, "tryDecode")).toBe(true);
    // …and dropping it must not weaken a real question.
    // @ts-expect-error -- ditto
    expect(isFsEncodingService(good, undefined, "recordedEncoding")).toBe(false);
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

  it("answers recordedEncoding without becoming an observation", async () => {
    // Reading a record must not be confused with making one: the method reports
    // what the tool path recorded, and a consumer rendering a preview can call
    // it as freely as `decode`.
    await writeFile(join(dir, "seen.txt"), gbk("你好，世界\n"));
    await pluginRead(root, "seen.txt", dir, {
      exec: makeExec("session-q"),
      encodingHint: "gbk",
    });
    const target = await root.fs.resolve(join(dir, "seen.txt"));

    const before = encodingStateCount();
    service.recordedEncoding("session-q", target, null);
    service.recordedEncoding("never-recorded", target, null);
    expect(encodingStateCount()).toBe(before);
  });
});

/** An execution carrying the session the record is keyed by. */
function makeExec(sessionId: string): ToolExecution {
  return {
    name: "read",
    callId: "call-1",
    agent: { session: { id: sessionId, header: { cwd: dir } } },
  } as unknown as ToolExecution;
}

describe("the recorded encoding is queryable without being writable", () => {
  /** Read a GBK file through the plugin's own path, so a real record exists. */
  async function recordGbk(name: string, sessionId: string, text = "你好，世界\n") {
    await writeFile(join(dir, name), gbk(text));
    const outcome = await pluginRead(root, name, dir, {
      exec: makeExec(sessionId),
      encodingHint: "gbk",
    });
    const target = await root.fs.resolve(join(dir, name));
    return { target, outcome };
  }

  it("answers undefined for a file no session recorded", async () => {
    await writeFile(join(dir, "plain.txt"), Buffer.from("plain\n"));
    const target = await root.fs.resolve(join(dir, "plain.txt"));
    // Not a throw and not a guess: "I have nothing" is an answer.
    expect(service.recordedEncoding("session-q", target)).toBeUndefined();
  });

  it("reports the encoding the tool will actually use", async () => {
    const { target, outcome } = await recordGbk("gbk.txt", "session-q");
    // `null` here is the explicit "do not check freshness": this case is about
    // the record's CONTENT, and the staleness question has its own cases below.
    const rec = service.recordedEncoding("session-q", target, null);
    expect(rec).toBeDefined();
    // The whole point of the seam: a consumer that guessed from the bytes could
    // land on a different page, and its diff would describe text the tool never
    // touches. The record is what `readFile` itself used.
    expect(rec?.encoding).toBe("gbk");
    expect(rec?.encoding).toBe(outcome.state.encoding);
  });

  it("carries the real provenance, not the hint the caller passed", async () => {
    // `decodeForOpen`'s hint branch reports `"hint"` for ANY explicit encoding
    // ("the CALLER specified this"), so a consumer that re-decodes with the
    // returned name gets a different provenance than the record holds. A guessed
    // file re-decoded that way would be presented as a determination — the exact
    // failure this plugin exists to prevent.
    await writeFile(join(dir, "guessed.txt"), gbk("你好，世界，这是中文测试内容\n"));
    setAutoGuess(true);
    await pluginRead(root, "guessed.txt", dir, { exec: makeExec("session-g") });
    const target = await root.fs.resolve(join(dir, "guessed.txt"));

    const rec = service.recordedEncoding("session-g", target, null);
    expect(rec?.decided).toBe("guessed");
    // The contrast, executed rather than asserted in prose: re-decoding with the
    // returned name answers `"hint"`.
    const reDecoded = await service.decode(gbk("你好，世界，这是中文测试内容\n"), {
      encoding: rec?.encoding,
    });
    expect(reDecoded.decided).toBe("hint");
  });

  it("reports the BOM and line-ending the save will restore", async () => {
    // Through the helper, so the fixture lives in one place: an inline copy here
    // would drift from `recordGbk` the moment either side changes how it reads.
    const text = "第一行\r\n第二行\r\n";
    const { target } = await recordGbk("crlf.txt", "session-q", text);

    const rec = service.recordedEncoding("session-q", target, null);
    expect(rec?.hasBOM).toBe(false);
    expect(rec?.lineEnding).toBe("\r\n");
  });

  it("returns the record when the version matches", async () => {
    const { target } = await recordGbk("versioned.txt", "session-q");
    const info = await root.fs.stat(target);
    expect(service.recordedEncoding("session-q", target, info?.version)).toBeDefined();
  });

  it("answers undefined when the file changed since it was recorded", async () => {
    const { target } = await recordGbk("stale.txt", "session-q");
    // A different version is a claim that this record describes a file that is
    // no longer there. Reporting it would let a preview decode text the tool
    // will never see.
    const stale = "different-version" as FsVersion;
    expect(service.recordedEncoding("session-q", target, stale)).toBeUndefined();
  });

  it("omitting the version is fail-closed, not 'skip the check'", async () => {
    const { target } = await recordGbk("failclosed.txt", "session-q");
    // A caller with no version is one that could not observe the file — a `stat`
    // that returned nothing. The write path reads an absent version the same way
    // (`invalidateIfStale(…, undefined)` deletes a versioned record), so this
    // must NOT hand back a record the next write would discard.
    expect(service.recordedEncoding("session-q", target)).toBeUndefined();
  });

  it("returns the record as it stands when the caller explicitly skips", async () => {
    const { target } = await recordGbk("history.txt", "session-q");
    // `null` is the deliberate "do not check freshness" — the only spelling that
    // skips, so a caller that merely lacks a version cannot get this by accident.
    expect(service.recordedEncoding("session-q", target, null)).toBeDefined();
  });

  it("treats an unversioned record as unusable once a version is supplied", async () => {
    // The fail-closed direction of the shared comparison: `undefined` on the
    // record's side compares unequal to a real version, so a record that cannot
    // be confirmed fresh is not presented as fresh.
    const { target } = await recordGbk("unversioned.txt", "session-q");
    const state = getEncodingState("session-q", keyOf(target));
    expect(state).toBeDefined();
    // Rewrite the record without a version, the way a hand-built state looks.
    const { setEncodingState } = await import("../src/encoding-state.js");
    setEncodingState("session-q", keyOf(target), { ...state!, version: undefined });

    const fresh = "some-version" as FsVersion;
    expect(service.recordedEncoding("session-q", target, fresh)).toBeUndefined();
    // With neither side reporting a version there is nothing to contradict the
    // record, so the omitted argument is not stale here.
    expect(service.recordedEncoding("session-q", target)).toBeDefined();
    // And the explicit skip still works.
    expect(service.recordedEncoding("session-q", target, null)).toBeDefined();
  });

  it("keeps two sessions' records apart, and reads either on request", async () => {
    const { target } = await recordGbk("shared.txt", "session-a");
    await pluginRead(root, "shared.txt", dir, {
      exec: makeExec("session-b"),
      encodingHint: "big5",
    });

    // Cross-session reads are allowed — this plugin serves a whole process, not
    // one conversation — and each answer is that session's own record.
    expect(service.recordedEncoding("session-a", target, null)?.encoding).toBe("gbk");
    expect(service.recordedEncoding("session-b", target, null)?.encoding).toBe("big5");
    expect(service.recordedEncoding("session-c", target, null)).toBeUndefined();
  });

  it("reads the anonymous bucket for an agentless caller", async () => {
    const { target } = await recordGbk("anon.txt", "session-q");
    // `undefined` is its own bucket, distinct from every real session's, so an
    // agentless caller neither inherits nor satisfies a session's record.
    expect(service.recordedEncoding(undefined, target, null)).toBeUndefined();
  });

  it("does not write, and so cannot authorize a write", async () => {
    // The load-bearing guarantee. A record is what `writeFile` inverts to decide
    // the bytes AND what its `FS_NOT_OBSERVED` guard checks, so a method that
    // could create one would let a consumer authorize a save the session never
    // read. Measured: inserting a record flips that guard from refusing to
    // allowing.
    await writeFile(join(dir, "never-read.txt"), gbk("你好，世界\n"));
    const target = await root.fs.resolve(join(dir, "never-read.txt"));
    const before = encodingStateCount();

    expect(service.recordedEncoding("session-q", target)).toBeUndefined();
    expect(service.recordedEncoding("session-q", target, null)).toBeUndefined();
    expect(service.recordedEncoding(undefined, target)).toBeUndefined();
    expect(service.recordedEncoding("session-q", target, "v" as FsVersion)).toBeUndefined();

    expect(encodingStateCount()).toBe(before);
    expect(getEncodingState("session-q", keyOf(target))).toBeUndefined();
  });

  it("does not delete a stale record — it only declines to report it", async () => {
    // A query must not have the write path's side effect. `invalidateIfStale`
    // DELETES on a mismatch; this method reports `undefined` and leaves the
    // record alone, so a consumer can never destroy a record merely by asking.
    const { target } = await recordGbk("kept.txt", "session-q");
    const key = keyOf(target);
    const before = getEncodingState("session-q", key);
    expect(before).toBeDefined();

    expect(service.recordedEncoding("session-q", target, "other" as FsVersion)).toBeUndefined();
    // The omitted-version (fail-closed) answer declines too, and equally leaves
    // the record in place: asking is never destructive, whichever way it answers.
    expect(service.recordedEncoding("session-q", target)).toBeUndefined();
    // Still there, unchanged.
    expect(getEncodingState("session-q", key)).toEqual(before);
  });

  it("answers undefined for unusable arguments instead of throwing", async () => {
    const { target } = await recordGbk("robust.txt", "session-q");
    // Same promise `tryDecode` makes: a consumer is usually another plugin,
    // often plain JavaScript, documented to skip its own `try`.
    expect(service.recordedEncoding("session-q", null as unknown as FsTarget)).toBeUndefined();
    expect(service.recordedEncoding("session-q", {} as FsTarget)).toBeUndefined();
    expect(
      service.recordedEncoding("session-q", undefined as unknown as FsTarget),
    ).toBeUndefined();
    expect(service.recordedEncoding(42 as unknown as string, target)).toBeUndefined();
    expect(service.recordedEncoding(null as unknown as string, target)).toBeUndefined();
  });
});
