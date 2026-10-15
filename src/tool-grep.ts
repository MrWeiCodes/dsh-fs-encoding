/**
 * The encoding-governed `grep` tool.
 *
 * Contract-compatible with the built-in `grep` (same `pattern` / `path` /
 * `include` arguments, same `{ matches: [{ path, lineNumber, line }] }` result
 * shape, same search card, same over-cap spill recovery) with one difference: a
 * file in a legacy code page is searched and reported as TEXT rather than as
 * unreadable bytes.
 *
 * ## What the built-in does, and why it is not enough
 *
 * The built-in runs ripgrep once and prints what comes back. Two failures follow
 * from that, and the second is the serious one:
 *
 * - Matching lines in a non-UTF-8 file are reported as the literal string
 *   `(line is not valid UTF-8)`. The content is right there in the file and the
 *   model is told it cannot be shown.
 * - A non-ASCII pattern is matched against RAW BYTES, so it cannot match a file
 *   whose bytes are not UTF-8. Searching a GBK file for a Chinese word returns
 *   ZERO matches — no error and no placeholder. The model reads that as "not
 *   present" when the truth is "not searched".
 *
 * ## The shape of the fix
 *
 * Ripgrep stays the engine; this tool drives it twice when needed. Pass 1 is the
 * built-in's own call, and everything it already decoded is adopted verbatim.
 * Only files that produced an undecodable row go to pass 2, where each is
 * re-searched with an encoding chosen per file. See
 * {@link module:dsh-fs-encoding/grep-search} for the measurements behind that
 * choice — in particular why a JavaScript-side search was rejected (25x slower,
 * and it would silently change the pattern language).
 *
 * ## Registration is conditional, deliberately
 *
 * The tool is registered only when `ctx.subprocess` is present. It is read with
 * `ctx.get` and NOT declared in `inject`, because cordis deactivates the WHOLE
 * plugin when any injected service is missing — measured: the fiber reports
 * `epoch: __INACTIVE__`, `apply` never runs, and mounting the service later does
 * not activate it either. Declaring `subprocess` would therefore trade this
 * tool's availability for `read` / `write` / `edit` working at all, in any
 * deployment that mounts the search plugin without the subprocess seam.
 *
 * So a missing `subprocess` costs exactly the thing it should: this plugin
 * leaves `grep` to the built-in, and the other five tools are unaffected.
 *
 * @module dsh-fs-encoding/tool-grep
 */

import type { Context } from "@deepseek-ai/cordis";
import type { FsTarget } from "@deepseek-ai/dsh-fs";
import type { RetainedItems } from "@deepseek-ai/dsh-output-retention";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { GrepMatch } from "@deepseek-ai/dsh-tool-fs-search";
import { loadConfig, type PluginConfig } from "./config.js";
import {
  candidatesOf,
  encodingsForPattern,
  filesNeedingDecoding,
  isPlainUtf8Text,
  mergeMatches,
  needsTranscodedSearch,
  parseRgJson,
  placeholderFor,
  provedFiles,
  readAndDecode,
  rgLabelFor,
  searchDecodedTextIsolated,
  utf16NewlineOrder,
  workdirOf,
  type DecodedMatch,
} from "./grep-search.js";
import { GREP_DESCRIPTION } from "./prompts.js";
import type { SearchKit } from "./search-kit.js";

/**
 * The subset of `ctx.subprocess` this tool calls.
 *
 * Structural rather than imported, so the plugin needs no type dependency on
 * `@deepseek-ai/dsh-subprocess` for a service it reaches opportunistically. The
 * shape is the one the built-in package's own spawn helper relies on, and
 * {@link subprocessOf} is what proves it at runtime before any call is made.
 */
interface SpawnOutcome {
  exitCode: number | null;
  signal: string | null;
}

interface CollectedStream {
  readFrom(offset: number): { text: string; lossy: boolean } | undefined;
}

interface SpawnHandle {
  done: Promise<SpawnOutcome>;
  collected: { stdout?: CollectedStream; stderr?: CollectedStream };
}

interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[];
    cwd: string;
    stdio: {
      stdin: "ignore";
      stdout: { maxBytes: number };
      stderr: { maxBytes: number };
    };
    graceMs: number;
    signal?: AbortSignal | undefined;
  }): SpawnHandle;
}

/**
 * Read the subprocess seam, or `undefined` when this deployment has none.
 *
 * A capability check rather than a truthiness test: `ctx.get` answers with
 * whatever object holds the name, and calling `spawn` on a foreign one would
 * throw inside the tool. Reading it fresh on every call is deliberate — each
 * `ctx.get` returns a NEW tracing proxy over the same service (measured:
 * `root.get("subprocess") !== root.get("subprocess")`), so caching the object or
 * comparing it by identity would both be wrong.
 *
 * @param ctx - the plugin context.
 * @returns the seam, or `undefined`.
 */
export function subprocessOf(ctx: Context): SubprocessLike | undefined {
  const candidate = ctx.get("subprocess") as Partial<SubprocessLike> | undefined;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  return typeof candidate.spawn === "function" ? (candidate as SubprocessLike) : undefined;
}

/**
 * Caps for the encoding-aware search.
 *
 * Defaulted from the search toolkit's own constants rather than re-declared, so
 * the two tools cap identically. The toolkit's `Config` is not exported, so a
 * deployment's `grepMaxMatches` override is not visible here and this tool uses
 * the shipped defaults. That is a deliberate limitation: reading another
 * plugin's private config would be worse than agreeing with its defaults.
 */
interface GrepCaps {
  maxMatches: number;
  maxLineBytes: number;
  maxMetaBytes: number;
  rawOutputMaxBytes: number;
  graceMs: number;
  stderrMaxBytes: number;
  timeoutMs: number;
}

/**
 * Read the caps off the toolkit.
 *
 * @param kit - the loaded search toolkit.
 */
function capsOf(kit: SearchKit): GrepCaps {
  return {
    maxMatches: kit.kit.GREP_MAX_MATCHES,
    maxLineBytes: kit.kit.GREP_MAX_LINE_BYTES,
    maxMetaBytes: kit.kit.SEARCH_META_MAX_BYTES,
    rawOutputMaxBytes: kit.kit.RAW_OUTPUT_MAX_BYTES,
    graceMs: kit.kit.SEARCH_GRACE_MS,
    stderrMaxBytes: kit.kit.SEARCH_STDERR_MAX_BYTES,
    timeoutMs: kit.kit.SEARCH_TIMEOUT_MS,
  };
}

/**
 * The outcome of one ripgrep run.
 *
 * `lossy` is carried out of {@link spawnRg} rather than dropped, because the
 * subprocess seam's collect disposition is "overflow keeps the TAIL": a `true`
 * flag means the HEAD of stdout was discarded, so what came back is a SUFFIX of
 * the real output, starting mid-record. The built-in treats exactly this as
 * `SEARCH_RAW_OUTPUT_OVERFLOW` and fails loudly instead of parsing a silently
 * partial stream, and pass 1 has to do the same — a partial result rendered as
 * "Found N matches" is indistinguishable from a complete one.
 */
interface RgRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Whether the seam dropped the head of stdout to stay within its cap. */
  stdoutLossy: boolean;
}

/**
 * Run ripgrep once through the subprocess seam.
 *
 * Deliberately a local implementation rather than the built-in `runRipgrep`,
 * even though that one is exported: pass 2 must run a search whose target is a
 * single file and whose `--encoding` differs per file, and it must report a
 * failed run's exit code and stderr rather than the built-in's `SearchError`
 * wording. Reusing the exported helper would serve pass 1 and leave pass 2 a
 * near-duplicate, so both passes go through one function here.
 *
 * `--no-config` is prepended for the reason the built-in documents: a host
 * `RIPGREP_CONFIG_PATH` (or an `rg.conf` beside the binary) can otherwise inject
 * `--pre` and make ripgrep execute an arbitrary preprocessor for every file it
 * touches. That is a security property, not a tidiness one.
 *
 * @param kit - the loaded search toolkit, for the binary path and the caps.
 * @param subprocess - the seam, already validated by {@link subprocessOf}.
 * @param exec - the calling execution, for the session cwd and the abort signal.
 * @param argv - ripgrep arguments, excluding the binary and `--no-config`.
 * @returns the exit code and the collected stdout/stderr, with `lossy` reporting
 *   whether the seam dropped the HEAD of stdout to fit its cap.
 * @throws when the command cannot be started, or when the caller aborts.
 */
async function spawnRg(
  kit: SearchKit,
  subprocess: SubprocessLike,
  exec: ToolExecution,
  argv: readonly string[],
): Promise<RgRun> {
  const caps = capsOf(kit);
  const rgPath = await kit.kit.resolveRgPath();
  const handle = subprocess.spawn({
    argv: [rgPath, "--no-config", ...argv],
    cwd: workdirOf(exec),
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: caps.rawOutputMaxBytes },
      stderr: { maxBytes: caps.stderrMaxBytes },
    },
    graceMs: caps.graceMs,
    signal: exec.signal,
  });
  // `done` REJECTS on abort rather than resolving with a signal, so an abort
  // arrives here as a thrown AbortError. It is not swallowed: the caller
  // re-throws it, because a cancelled search must not look like a finished one.
  const outcome = await handle.done;
  const stdout = handle.collected.stdout?.readFrom(0);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout?.text ?? "",
    stderr: handle.collected.stderr?.readFrom(0)?.text ?? "",
    stdoutLossy: stdout?.lossy ?? false,
  };
}

/**
 * Fail a run whose stdout the seam could not retain in full.
 *
 * The wording is the built-in's, because this is the built-in's own failure
 * mode: `completeStdout` refuses to parse a stream the transport truncated, and
 * a shadow that instead returned the retained tail would answer with a result
 * that STARTS somewhere in the middle of the repository and says nothing about
 * it. Measured on this repository, `grep({ pattern: "." })` produces 94 MB of
 * raw stdout against the 20 MB cap, so the tail is a small fraction of the
 * matches — presented as a normal, complete-looking result.
 *
 * @param rawOutputMaxBytes - the cap the seam was given.
 */
function stdoutOverflow(rawOutputMaxBytes: number): Error {
  return new Error(
    `[E_SEARCH_RAW_OUTPUT_OVERFLOW] grep produced more raw output than the subprocess ` +
      `seam retained within the ${rawOutputMaxBytes}-byte cap; narrow pattern, path, ` +
      `or include and retry`,
  );
}

/**
 * Classify a failed ripgrep run into a model-facing message.
 *
 * Exit 2 is ripgrep's own error channel and its stderr says why (an invalid
 * regex, an unreadable path). That text is passed through rather than replaced:
 * it names the actual problem, and the model can act on it directly.
 *
 * @param exitCode - the process exit code.
 * @param stderr - the retained stderr tail.
 */
function runFailure(exitCode: number | null, stderr: string): Error {
  const detail = stderr.trim().split("\n")[0] ?? "";
  if (exitCode === null) {
    return new Error(`[E_SEARCH_FAILED] grep was killed by a signal. ${detail}`.trim());
  }
  return new Error(
    `[E_SEARCH_FAILED] grep could not complete its search (ripgrep exited ${exitCode}). ${detail}`.trim(),
  );
}

/**
 * One file pass 2 could not answer for.
 *
 * The reason travels WITH the path rather than being re-derived by the caller,
 * because re-deriving it is what the second read was for: admission is the
 * expensive half of a decode, and the refusal it produces already holds the
 * candidate list the placeholder needs.
 */
interface UnresolvedFile {
  /** The raw path as ripgrep printed it. */
  file: string;
  /**
   * The admission refusal, when the failure was one, for its candidate list.
   *
   * `undefined` for the failures that have no candidates to offer — bytes that
   * are not text, an unreadable path, a ripgrep run that failed — which
   * {@link candidatesOf} answers with an empty list, exactly as a fresh
   * admission attempt would.
   */
  error: unknown;
  /**
   * Whether admission DECODED the file and only the binary check or the
   * re-search then refused it.
   *
   * The two kinds of "unresolved" are not the same for the caller's placeholder
   * loop: a file that decoded has real `text` rows that must be kept, while a
   * file admission refused has none — every row it reported is a reading of
   * bytes nothing admits. Both kinds leave `error` `undefined` (the refusals
   * that offer no candidates, and the re-search failures that have none to
   * offer), so the distinction has to be recorded here.
   *
   * The binary refusal carries it too, but only for the bytes that ARE text in
   * the page admission chose — {@link utf16NewlineOrder} is what tells the two
   * apart, and a UTF-16 file read as a legacy page does not qualify.
   */
  decoded?: boolean;
}

/** The outcome of re-searching the files pass 1 could not decode. */
interface SecondPass {
  /** Decoded rows, which override pass 1's placeholders by `(path, lineNumber)`. */
  matches: DecodedMatch[];
  /** Files whose encoding could not be determined, in first-seen order. */
  unresolved: UnresolvedFile[];
}

/**
 * Re-search the files whose matched lines ripgrep could not decode.
 *
 * One file at a time, because `--encoding` is a whole-invocation flag: telling
 * ripgrep one encoding for a mixed directory makes it MISS the files in any
 * other encoding and mojibake the ones it does match. Measured over a directory
 * holding the same text as GBK and as UTF-8, `--encoding=gbk` returned the GBK
 * file correctly and rendered the UTF-8 file's line as
 * `alpha 閰嶇疆椤� port=8080`.
 *
 * Three outcomes per file, in order of preference:
 *
 * 1. The encoding is detected and ripgrep can search it → re-run with that
 *    encoding, which makes ripgrep transcode and emit readable `text`.
 * 2. The encoding is detected but ripgrep cannot search it (UTF-32) → decode in
 *    JavaScript and match there. Rare enough that the pattern-language
 *    difference this introduces stays contained.
 * 3. The encoding cannot be determined → report the file as unresolved, so the
 *    caller can enrich its placeholder with the candidate list.
 *
 * A failure on ONE file never fails the search: that file is reported as
 * unresolved and the rest of the results stand.
 *
 * @param ctx - the plugin context.
 * @param kit - the loaded search toolkit.
 * @param exec - the calling execution.
 * @param subprocess - the validated seam.
 * @param files - the raw paths to re-search, in first-seen order.
 * @param input - the validated arguments (the pattern and include filter).
 * @param config - the deployment's admission config.
 * @param workdir - the resolved workdir, for display paths.
 */
async function searchUndecodedFiles(
  ctx: Context,
  kit: SearchKit,
  exec: ToolExecution,
  subprocess: SubprocessLike,
  files: readonly string[],
  input: { pattern: string; include?: string },
  config: PluginConfig,
  workdir: string,
): Promise<SecondPass> {
  const matches: DecodedMatch[] = [];
  const unresolved: UnresolvedFile[] = [];

  for (const file of files) {
    const displayPath = kit.kit.toWorkdirRelative(file, workdir);
    // No `try` here: `readAndDecode` answers with a value for every outcome,
    // including an aborted read, which is one unresolved file rather than a
    // failed search — the same disposition the rest of this loop takes.
    const attempt = await readAndDecode(ctx, exec, file, config);
    if ("error" in attempt) {
      // `decoded` travels with the refusal rather than being re-derived here:
      // it is the one thing the caller's placeholder loop cannot see for itself,
      // and it is already known where the bytes are. See {@link ReadAttempt}.
      unresolved.push({
        file,
        error: attempt.error,
        ...(attempt.decoded === true ? { decoded: true } : {}),
      });
      continue;
    }

    const label = rgLabelFor(attempt.encoding);
    if (label === undefined) {
      // ripgrep has no such encoding (UTF-32, and only that today). Search the
      // decoded text here, behind a thread that can be killed: this pattern is
      // model-supplied and a backtracking blow-up would otherwise block the
      // whole process, which this tool shares with the agent.
      try {
        // Appended one by one rather than spread: the count is the number of
        // MATCHING LINES in the file, and V8 caps how many arguments one call may
        // receive (measured, and it moves with stack depth: ~125 000 at the top
        // level, less from deep inside a call), so a large UTF-32 file — well
        // within `maxFileBytes` — would fail the whole search with `RangeError`.
        const found = await searchDecodedTextIsolated(attempt.text, input.pattern, displayPath, {
          signal: exec.signal,
        });
        for (const match of found) matches.push(match);
      } catch (error) {
        if (error instanceof SyntaxError) throw patternError(error, input.pattern);
        throw error;
      }
      continue;
    }

    try {
      const argv = kit.kit.buildGrepCommand({
        pattern: input.pattern,
        path: file,
        ...(input.include === undefined ? {} : { include: input.include }),
      });
      // No `-a` here, and the reason is reachability rather than preference. This
      // run reads the WHOLE file, so `--encoding` would treat any NUL in it as a
      // line terminator and report an inflated line number — but a file can only
      // arrive here if {@link readAndDecode} admitted it, and that admission
      // reads the file through `fs.readBytes`, which THROWS `FS_TOO_LARGE` on a
      // file larger than the cap rather than truncating it. So the bytes
      // admission saw are the whole file, `binaryInEncoding` therefore sees
      // every NUL in it, and every encoding that reaches this line is one it
      // clears. Measured with the real sandboxed filesystem: a NUL inside the
      // cap is refused, and a file over the cap is refused before the NUL is
      // even reached — the four shapes (under/over the cap × NUL present/absent)
      // admit only the one with no NUL at all.
      const run = await spawnRg(kit, subprocess, exec, [`--encoding=${label}`, ...argv]);
      // A truncated stream is a SUFFIX of this file's rows, so it is not the
      // complete answer for the file. The file is reported as unresolved instead
      // of being answered with a partial list: the placeholder it keeps is
      // honest, while a short list of matches would read as the whole truth.
      //
      // No `error` is carried for these three failures: the file DECODED, so
      // admission has no candidates to offer for it and the placeholder stays
      // bare. That is what the caller's candidate lookup answers for a
      // `undefined` reason, and it is what a re-read used to establish.
      if (run.stdoutLossy) {
        unresolved.push({ file, error: undefined, decoded: true });
        continue;
      }
      if (run.exitCode !== 0 && run.exitCode !== 1) {
        unresolved.push({ file, error: undefined, decoded: true });
        continue;
      }
      // ripgrep transcoded the file, so every row should be `text` now. A row
      // that is STILL bytes means this encoding did not in fact decode the file,
      // so it is left to the caller's placeholder rather than invented here.
      for (const raw of parseRgJson(run.stdout)) {
        if (raw.text === undefined) continue;
        matches.push({ path: displayPath, lineNumber: raw.lineNumber, line: raw.text });
      }
    } catch (error) {
      // An abort must propagate: the caller cancelled the whole search, and
      // reporting one file as unresolved would hide that.
      if (exec.signal.aborted) throw error;
      unresolved.push({ file, error: undefined, decoded: true });
    }
  }
  return { matches, unresolved };
}

/**
 * Turn a `RegExp` construction failure into a model-facing error.
 *
 * The JavaScript fallback path compiles the pattern itself, and a pattern that
 * ripgrep accepts may still throw there (`(?i)` is the common case). Saying so
 * explicitly is what keeps the difference from reading as a bug in the search.
 *
 * @param error - the thrown `SyntaxError`.
 * @param pattern - the pattern that failed.
 */
function patternError(error: SyntaxError, pattern: string): Error {
  return new Error(
    `[E_INVALID_PATTERN] grep could not use ${JSON.stringify(pattern)} as a regular ` +
      `expression while searching a UTF-32 file, which is searched in JavaScript ` +
      `rather than by ripgrep. JavaScript syntax differs from ripgrep's: (?i) and ` +
      `(?s) are not supported. Original error: ${error.message}`,
  );
}

/** The canonical value one `grep` call produces. */
interface GrepValue {
  matches: GrepMatch[];
  /**
   * The saved spill artifact for a capped result, when one was saved.
   *
   * Carried in the VALUE rather than computed in `render`, because saving is
   * async and `render` is not. The built-in solves the same problem with a
   * `tools/post-execute` hook, which a shadow cannot lean on: the built-in's own
   * hook stands down when the live scoped owner is not its own definition, so it
   * will not fill this in for us.
   *
   * The whole `SpillRef` is kept, `retrievalHint` included — the locator alone
   * is not actionable, and a synthesized hint would tell the model where the
   * file is without telling it how to read it.
   */
  spill?: { locator: string; bytes: number; retrievalHint: string };
}

/**
 * Whether the search target is one explicit FILE rather than a directory.
 *
 * This decides one flag on the transcoding passes, and the difference it makes
 * is a real property of ripgrep rather than a tidiness preference. `-a` disables
 * ripgrep's binary detection outright, so the question is what that detection
 * was withholding.
 *
 * At a DIRECTORY root it withholds whole FILES: a NUL anywhere in a file's bytes
 * takes it out of the walk, so `-a` there newly admits every binary in the tree
 * — measured, `bin.dat` (a NUL-bearing file holding the pattern) appears in the
 * results only with the flag.
 *
 * At an explicit FILE path there is no such file to withhold — ripgrep searches
 * a directly named binary either way — so `-a` adds nothing and is left off.
 * The reason is NOT a line-number correction: measured over six NUL shapes (NUL
 * first, last, mid-file, on every line, a PNG-like header, and a 4096-byte NUL
 * run), the row and its number were identical with and without the flag, 6 of 6.
 *
 * A path that cannot be resolved or statted is not a file, which keeps the flag
 * off the run whose target ripgrep is about to reject anyway.
 *
 * @param ctx - the plugin context, for `fs`.
 * @param exec - the calling execution, for the cwd and the abort signal.
 * @param path - the caller's search target, when one was given.
 */
async function isExplicitFile(
  ctx: Context,
  exec: ToolExecution,
  path: string | undefined,
): Promise<boolean> {
  if (path === undefined) return false;
  try {
    const target = await ctx.fs.resolve(path, { cwd: workdirOf(exec) });
    const info = await ctx.fs.stat(target, exec.signal);
    return info?.type === "file";
  } catch (error) {
    if (exec.signal.aborted) throw error;
    return false;
  }
}

/**
 * A file two pages read differently, and the lines they disagree about.
 *
 * The sweep cannot say which page is right, and the candidate order is not an
 * answer to that question — measured, it picks the mojibake. So it reports the
 * file and the lines at stake, and the caller turns them into placeholders that
 * name the candidates while the per-file pass tries to settle it.
 */
interface ConflictedFile {
  /** The path as ripgrep printed it. */
  raw: string;
  /** The 1-based line numbers the pages contradict each other on, ascending. */
  lineNumbers: number[];
  /** The canonical encodings that proved the file, in candidate order. */
  candidates: string[];
}

/**
 * What one transcoding sweep concluded about the tree.
 *
 * `matches` are the rows the sweep stands behind, ready to merge. `conflicted`
 * are files two pages proved with contradicting text — a question the sweep
 * cannot answer and must not answer by guessing. The two are kept apart because
 * they have different destinations: one is a result, the other is a work item.
 */
interface SweepResult {
  /** Decoded rows, one file's worth per file, in first-seen order. */
  matches: DecodedMatch[];
  /** Files two pages read differently, with the lines they disagree on. */
  conflicted: ConflictedFile[];
}

/**
 * The lines the given pages DISAGREE about, if any.
 *
 * Disagreement is per LINE, and only per line. Pages may legitimately match
 * different SETS of lines — that is what a wrong page's text looks like, not a
 * second opinion about the file: measured on a plain GBK file holding three
 * Chinese comments, `[一-龥]` matches lines {2,4,6} under `gbk`/`big5`/`euc-kr`
 * and only {2,6} under `shift_jis`, because that page's decode of line 4 holds no
 * CJK at all. Treating a differing COUNT as a contradiction withheld lines the
 * correct page had decoded, so a file came back as placeholders.
 *
 * A page that matched FEWER lines therefore contributes nothing to the
 * contradiction: its silence about a line is not a competing reading of it. Only
 * where two pages report the SAME line number with DIFFERENT text is there a
 * question the sweep cannot answer.
 *
 * The pages compared are the caller's `encodings`, and the caller decides how far
 * that reaches. The two families do NOT address the same positions — a UTF-16
 * page pairs the bytes two at a time, so measured on a plain GBK file under
 * `[一-龥]`, `utf-16be` reports "line 1" while the legacy pages report lines 41
 * and 42 — and what that rules out is reading a re-pairing as a second opinion
 * about the lines a legacy page matched. It does not rule out asking both
 * families about ONE line number, which is what the sweep's caller does: a
 * disagreement there is withheld and handed to the per-file pass rather than
 * settled in either family's favour, and the caller's own `sources` still decides
 * whose text is shown for a line only one family reports. WITHIN the UTF-16
 * family the positions ARE comparable — both pair the same bytes — and there they
 * disagree for real: measured on a UTF-16BE file under `[一-龥]`, `utf16le` reads
 * line 1 as `⼀⼀䶑湿` while `utf16be` reads it as `// 端口配置`.
 *
 * @param encodings - the pages to compare, in preference order.
 * @param pages - each page's rows for one file, keyed by encoding.
 * @returns the line numbers those pages contradict each other on, ascending.
 */
function contradictedLines(
  encodings: readonly string[],
  pages: ReadonlyMap<string, readonly DecodedMatch[]>,
): number[] {
  const textOf = new Map<number, string>();
  const contradicted = new Set<number>();
  for (const encoding of encodings) {
    for (const row of pages.get(encoding)!) {
      const previous = textOf.get(row.lineNumber);
      if (previous === undefined) {
        textOf.set(row.lineNumber, row.line);
        continue;
      }
      if (previous !== row.line) contradicted.add(row.lineNumber);
    }
  }
  return [...contradicted].sort((a, b) => a - b);
}

/**
 * Re-search the whole tree under one candidate encoding.
 *
 * The strategy for a NON-ASCII pattern, and the only one that can work for it.
 * A non-ASCII pattern is a UTF-8 byte sequence, so the default call cannot match
 * a file in another encoding at all — measured: `--regexp=配置项` over a GBK
 * file returns zero matches, which is exactly the silent miss this tool exists
 * to fix. There is therefore no "undecodable row" to react to, and the
 * per-file strategy has nothing to trigger on.
 *
 * Instead the pattern is run once per candidate encoding over the whole search
 * root. A run's rows are adopted per FILE, and only for a file that run PROVED
 * it decoded — see {@link provedFiles} for what counts as proof and why a bare
 * match is not it.
 *
 * The candidate list is narrowed first by {@link encodingsForPattern}, which
 * skips a page that cannot spell the pattern at all. For `配置项` that leaves
 * `gbk` plus the two UTF-16 pages, so the common case is a handful of runs
 * rather than one per supported encoding.
 *
 * A run that fails is skipped rather than fatal, because one encoding's failure
 * must not discard the hits another encoding already produced. That reasoning
 * covers a run failing ALONE, and only that: every run failing is a different
 * fact, and it is reported. A pattern ripgrep cannot parse fails under every
 * encoding, so swallowing each of those failures in turn answered
 * `Found 0 matches` for a search that never ran at all — the "no" versus "not
 * searched" confusion this tool exists to remove.
 *
 * ## Why an explicit file gets `-a` and a directory does not
 *
 * `--encoding` makes ripgrep treat a NUL byte as a LINE TERMINATOR, which no
 * other mode does. Measured on one file, the line number of a line preceded by
 * N NULs is `true + N` under an explicit `--encoding` and `true` without it —
 * so the same file, searched by the same tool, reports a line number that
 * depends on whether the pattern happened to hold a non-ASCII character. This
 * path only ever runs for such a pattern, so it is the path that pays it.
 *
 * `-a` restores the byte semantics exactly. It is passed only when the target is
 * a single explicit file, because that is the only shape where it costs nothing:
 * see {@link isExplicitFile} for the measurement on each side. On a directory
 * root the flag is deliberately withheld — it would buy a NUL-bearing text file
 * back at the price of every binary in the tree, and that trade is not this
 * change's to make.
 *
 * @param kit - the loaded search toolkit.
 * @param ctx - the plugin context, for the target's own type.
 * @param subprocess - the validated seam.
 * @param exec - the calling execution.
 * @param input - the validated arguments.
 * @param encodings - the canonical names to try, in order.
 * @param config - the deployment's admission config, for the read cap.
 * @param workdir - the resolved workdir, for display paths.
 */
async function searchByTranscoding(
  kit: SearchKit,
  ctx: Context,
  subprocess: SubprocessLike,
  exec: ToolExecution,
  input: { pattern: string; path?: string; include?: string },
  encodings: readonly string[],
  config: PluginConfig,
  workdir: string,
): Promise<SweepResult> {
  const labels: Array<{ encoding: string; label: string }> = [];
  for (const encoding of encodings) {
    const label = rgLabelFor(encoding);
    if (label !== undefined) labels.push({ encoding, label });
  }
  // Resolved once for the whole sweep rather than per encoding: the answer is a
  // property of the caller's target, not of the encoding being tried.
  const byteLines = await isExplicitFile(ctx, exec, input.path);
  // How many runs ripgrep actually started, and how many of those it refused
  // with its own error channel. Kept to tell "one encoding's run failed" from
  // "the pattern is not a regex at all": the first is why the loop continues,
  // the second is why the search must fail.
  let started = 0;
  let refused = 0;
  let firstRefusal: RgRun | undefined;
  // Runs that made no claim about the tree at all: one whose stdout the seam
  // truncated, and one that never started. Kept apart from `refused`, which IS a
  // claim (ripgrep's own error channel), because a MISSING claim is the thing
  // that must never be rendered as "no matches".
  let truncated = 0;
  let firstLaunchError: unknown;
  // Rows per file, and per page within that file. Kept per page rather than
  // appended to one list because two pages can prove the same file, and whether
  // that is a contradiction is a per-LINE question answered after the whole
  // sweep has run — see the flattening below.
  const byPath = new Map<string, { raw: string; pages: Map<string, DecodedMatch[]> }>();
  // Whether a file's bytes are strict UTF-8 text, which settles its encoding and
  // therefore voids every page's claim about it. Memoized across the whole sweep
  // because the answer is a property of the BYTES: several pages claim the same
  // file, and a read per claim would be the same read repeated. See
  // {@link isPlainUtf8Text} for why this is the discriminator.
  const plainUtf8 = new Map<string, boolean>();
  // The byte order each file's own bytes name, for the UTF-16 pages only.
  // Memoized for the same reason as `plainUtf8`, and separate from it because a
  // file can be a UTF-16 candidate without being plain UTF-8 text and vice versa.
  const orderCache = new Map<string, Utf16Order>();

  for (const { encoding, label } of labels) {
    // The page's own `--encoding` for a legacy or Unicode candidate. UTF-8 is
    // deliberately not among the candidates: the strict pass below already
    // decodes every valid-UTF-8 file, and `--encoding=utf-8` would only add a
    // lossy second reading of the same bytes.
    const argv = kit.kit.buildGrepCommand(input);
    let run: RgRun;
    try {
      run = await spawnRg(kit, subprocess, exec, [
        ...(byteLines ? ["-a"] : []),
        `--encoding=${label}`,
        ...argv,
      ]);
    } catch (error) {
      if (exec.signal.aborted) throw error;
      firstLaunchError ??= error;
      continue;
    }
    started++;
    // A truncated stream is a suffix of this encoding's rows. Each run here is
    // one candidate's claim about the whole tree, and a partial claim cannot be
    // told apart from a complete one, so it is dropped rather than unioned in.
    if (run.stdoutLossy) {
      truncated++;
      continue;
    }
    // Exit 1 is "no matches" and is a NORMAL answer, so only a run ripgrep
    // itself refused (exit 2, or a signal) is counted here. Counting exit 1
    // would turn an ordinary empty search into a failure.
    if (run.exitCode !== 0 && run.exitCode !== 1) {
      refused++;
      firstRefusal ??= run;
      continue;
    }
    const rows = parseRgJson(run.stdout);
    // A MATCH is not proof that this page decoded the file, and this is where
    // that matters. A pattern holding an ASCII alternative — `配置|read` —
    // matches under EVERY page, because `read` is the same bytes in all of them,
    // so unioning each page's rows put one page's mojibake on screen for a file
    // another page had decoded: measured over a directory holding the same text
    // as UTF-8 and as GBK, four pages claimed every line and the last one to run
    // won — Korean-looking garbage for both files. What only THIS page can
    // produce is a NON-ASCII character in a submatch, because producing it
    // required mapping the file's bytes onto that character. See
    // {@link provedFiles}.
    const proved = new Set(provedFiles(rows));
    if (proved.size === 0) continue;
    // A file whose bytes are strict UTF-8 TEXT is not this page's to answer for,
    // whatever the page proved about it. Such a file has exactly one correct
    // reading — the strict pass's — so a page's decode of it is mojibake by
    // construction, and the proof rule cannot tell the difference because
    // mojibake is non-ASCII text too. Measured: a valid-UTF-8 file whose only
    // non-ASCII character was an em-dash came back as `// note 鈥� dash only`,
    // because that character's bytes decode to CJK under `gbk`; and this
    // repository's LICENSE alone was claimed by 4 pages under `[一-龥]`, 57 files
    // in total. See {@link isPlainUtf8Text}, which is `read`'s own rule.
    //
    // Asked per FILE rather than per row, and memoized across the whole sweep:
    // the answer is a property of the bytes, so the second page to claim the same
    // file must not pay for a second read of it.
    const answerable = new Set<string>();
    for (const path of proved) {
      let plain = plainUtf8.get(path);
      if (plain === undefined) {
        plain = await isPlainUtf8Text(ctx, exec, path, config);
        plainUtf8.set(path, plain);
      }
      if (plain) continue;
      // A UTF-16 page re-pairs the file's bytes, so its claim is admissible only
      // when the file's OWN bytes name that order — the same gate
      // `searchUnicodeFiles` applies to every row it reports, and for the same
      // reason. Without it a BOM-less UTF-16LE file is claimed by `utf16be` as
      // well: measured, its re-pairing of the ASCII lines is itself CJK, so it
      // matched `[一-龥]` at a line number the file does not have and the row was
      // reported beside the correct one. The two families are asked separately
      // because only a UTF-16 page can be wrong this way: a legacy page's line
      // numbers address the file's real lines whatever it decodes them to.
      if (encoding === "utf16le" || encoding === "utf16be") {
        let order = orderCache.get(path);
        if (order === undefined) {
          order = await utf16OrderOfFile(ctx, exec, path, config);
          orderCache.set(path, order);
        }
        if (order !== encoding) continue;
      }
      answerable.add(path);
    }
    if (answerable.size === 0) continue;
    // The proof is per FILE, not per row, and that is what carries the ASCII
    // alternative: `--encoding` transcoded the whole file in this one pass, so a
    // file proved by its non-ASCII row has its ASCII-matching rows reported from
    // the same decode. Measured on a GBK file whose line 1 is `# 端口配置` and
    // whose line 2 is the plain-ASCII `PORT=8080 read this`, the gbk run proves
    // the file on line 1 and both rows come out decoded.
    for (const raw of rows) {
      // A row that is still bytes means this encoding did not decode the file,
      // so this run's claim about it is not trustworthy; the encoding that does
      // decode it will report the line.
      if (raw.text === undefined) continue;
      // A row for a file this page did not prove is a reading nothing vouches
      // for, so it is left to the strict pass and to whichever page does prove
      // the file. Dropping it is the difference between "not searched" and
      // "searched and garbled".
      if (!answerable.has(raw.path)) continue;
      const displayPath = kit.kit.toWorkdirRelative(raw.path, workdir);
      let entry = byPath.get(displayPath);
      if (entry === undefined) {
        entry = { raw: raw.path, pages: new Map() };
        byPath.set(displayPath, entry);
      }
      const row: DecodedMatch = { path: displayPath, lineNumber: raw.lineNumber, line: raw.text };
      const page = entry.pages.get(encoding);
      if (page === undefined) entry.pages.set(encoding, [row]);
      else page.push(row);
    }
  }

  // A file's rows are decided LINE BY LINE, because that is the only unit on
  // which two pages can actually contradict each other.
  //
  // The file-level rule this replaces was too broad: it compared whole readings,
  // so a page that merely matched fewer lines (its decode of some line holding no
  // CJK at all) made the file a conflict and withheld lines another page had
  // decoded correctly. It was also measured to fire on files that were never in
  // doubt — see `contradictedLines`.
  //
  // So a line only one page reports is that page's answer, and a line several
  // pages report identically is theirs too. Only a line two COMPARABLE pages
  // report with different text is withheld, because no evidence here can order
  // them: measured, `操` is `be de` in Big5 and `b2 d9` in GBK, so a Big5 file
  // holding both is proved by both pages and under `gbk` reads
  // `// 巨弧操砰╰参砞﹚弧` — mojibake rather than a second opinion, and the candidate
  // order is no help because it is ordered for GUESSING rather than for this.
  //
  // A withheld line becomes a placeholder naming the pages that could hold the
  // bytes — the remedy an undecodable line gets, and the one `read` would give.
  // That keeps both promises the tool exists for: never render a hit as "no
  // matches", and never render it as text nothing vouches for.
  const out: DecodedMatch[] = [];
  const conflicted: ConflictedFile[] = [];
  for (const entry of byPath.values()) {
    // The pages whose TEXT answers for this file. A file any legacy page proved is
    // theirs to answer for: their line numbers address the file's real lines,
    // whereas a UTF-16 page re-pairs the bytes and would report positions no
    // reading of the file supports — measured on a plain GBK file under `[一-龥]`,
    // `utf-16be` says "line 1" where the legacy pages say 41 and 42. A file only
    // the UTF-16 pages proved is theirs, and there they DO compete: they pair the
    // same bytes, so their readings are of the same lines (measured on a UTF-16BE
    // file, `utf16le` reads line 1 as `⼀⼀䶑湿` against `utf16be`'s `// 端口配置`).
    const legacy = [...entry.pages.keys()].filter((e) => !UNICODE_SEARCH_ENCODINGS.has(e));
    const sources = legacy.length > 0 ? legacy : [...entry.pages.keys()];
    // The pages COMPARED are every page that proved the file, which is a WIDER set
    // than the pages reported. The two are different questions — whose text is
    // shown, and whether the text is in doubt — and separating them is the fix
    // here.
    //
    // Asking only `sources` was wrong for the one file both families prove and
    // where the UTF-16 page is the one holding the text. A BOM-less UTF-16LE file
    // is exactly that file: `-a` lets the `gbk` run treat the file's NUL bytes as
    // line terminators and re-pair them into legal CJK, so `gbk` PROVES it and
    // `legacy` is non-empty — and `sources` then held `gbk` alone. The `utf16le`
    // page, the only reading that can decode the file, was left out of the
    // comparison, so `gbk` could not be contradicted and its mojibake was reported
    // as the line. Measured on a BOM-less UTF-16LE file whose line 41 is
    // `// 消息队列消费失败`, searched for `[一-龥]` at an explicit path:
    // `pages=["gbk","utf16le"] legacy=["gbk"] sources=["gbk"]`, and the answer was
    // the gbk reading of the NUL-split bytes while the correct line was dropped —
    // and on a two-line fixture the second real hit was dropped with it.
    //
    // Comparing the families is safe HERE, and only here, because the outcome is
    // not a choice between them: a line they disagree about is withheld and handed
    // to the per-file pass, which decodes the file through admission and is the
    // only pass that can order two readings. What the comparison must NOT do is
    // decide which page's text is shown, and it does not — `sources` still decides
    // that, so a line only one family reports stays that family's answer. The two
    // families do not address the same positions, which is why a disagreement
    // about WHICH lines matched is still not a contradiction: only the same line
    // number read two ways is, and that is the shape a re-pairing and a legacy page
    // produce when both are looking at the same bytes.
    const contradicted = contradictedLines([...entry.pages.keys()], entry.pages);
    const contested = new Set(contradicted);
    const emitted = new Set<number>();
    for (const encoding of sources) {
      for (const row of entry.pages.get(encoding)!) {
        if (contested.has(row.lineNumber)) continue;
        if (emitted.has(row.lineNumber)) continue;
        emitted.add(row.lineNumber);
        out.push(row);
      }
    }
    if (contradicted.length === 0) continue;
    // The candidates are the pages that proved the file, which is a sharper list
    // than a guess: it is the set of encodings that can hold these bytes at all.
    // That is every page in `entry.pages`, and NOT `sources` — the two answer
    // different questions, exactly as the comparison above does. `sources` says
    // whose text the sweep stands behind, which is not the same as which pages
    // could decode the file, and naming only `sources` here hands the caller a
    // page that cannot read the file it is offered for: measured on a BOM-less
    // UTF-16LE file whose first line is ASCII before its first NUL — so the strict
    // pass owns it and the UTF-16 pass never sees it — the placeholder said
    // `candidates: gbk` for a file `gbk` re-pairs, while `utf16le`, the one page
    // that decodes it, was left out. The keys are already in candidate order.
    conflicted.push({
      raw: entry.raw,
      lineNumbers: contradicted,
      candidates: [...entry.pages.keys()],
    });
  }
  // Every run that ran was refused, which no encoding can explain: an encoding
  // problem is per-page, while a pattern ripgrep cannot parse fails identically
  // under all of them. This is therefore the pattern's own failure, and it is
  // reported with the same wording the default pass uses rather than left to
  // read as "not present".
  //
  // `refused === started` rather than `out.length === 0`, because an empty union
  // is also what a genuinely matchless search produces — and the whole point
  // here is that those two must not look alike. A sweep in which any run
  // ANSWERED (exit 0 or 1) keeps the existing disposition: the hits stand and a
  // failed sibling is still skipped, so a page-specific failure cannot discard
  // what another encoding found.
  if (started > 0 && refused === started && firstRefusal !== undefined) {
    throw runFailure(firstRefusal.exitCode, firstRefusal.stderr);
  }
  // Nothing ran at all, so no encoding was ever searched and the empty union is
  // not an answer to anything. The launcher's own error is propagated, which is
  // what the default pass does with the same failure: measured through a seam
  // whose `spawn` throws, the ASCII path surfaces the raw launch error while
  // this path answered `Found 0 matches`.
  if (started === 0 && firstLaunchError !== undefined) throw firstLaunchError;
  // An empty union that a truncated run could have filled.
  //
  // Measured on 80000 matching lines of a plain UTF-8 Chinese corpus with
  // `pattern=配置项`: a run exits 0 with 18.5 MB retained of 25.1 MB and is
  // dropped as truncated, while the other pages exit 1 — a real verdict, but
  // about a different READING of the file, and none of them can speak for the
  // rows the truncated run lost. Nothing was refused, so the old gate stayed
  // silent and the union came out empty: `Found 0 matches`, while the same
  // corpus under an ASCII pattern fails loudly on pass 1. The threshold is
  // corpus size alone (about 65000 matching lines here), so this is a wide
  // search's ordinary outcome rather than a corner case.
  //
  // Narrow on purpose: `refused === 0` leaves the registered mixed disposition
  // (a truncated run beside a refused one) alone, and `out.length === 0` leaves
  // every sweep that answered with rows alone — a hit beside a truncated sibling
  // stands exactly as a hit beside a refused one.
  //
  // `conflicted` is deliberately NOT part of this condition. A contradiction is
  // an answer about the lines it names, but a truncated run lost rows that are
  // not named by anything: its output is a SUFFIX, so the sweep cannot know which
  // lines are missing, and reporting the conflicted placeholders as the whole
  // result would render "not searched completely" as "these are the matches".
  // That is the confusion this gate exists to refuse, so a truncated sweep with
  // nothing adopted still fails loudly.
  if (out.length === 0 && refused === 0 && truncated > 0) {
    throw stdoutOverflow(capsOf(kit).rawOutputMaxBytes);
  }
  return { matches: out, conflicted };
}

/**
 * One ripgrep run that names every UTF-32 file under the search root.
 *
 * UTF-32 is the one encoding ripgrep cannot be told about at all: measured,
 * `--encoding=utf-32le` exits 2 with "unknown encoding", and its BOM sniffing
 * does not cover UTF-32 either, so such a file produces no match and no
 * undecodable row — it is simply invisible to both search strategies.
 *
 * It is found by its byte-order mark instead, in byte mode. The pattern is
 * `(?-u)`-anchored because ripgrep's default Unicode mode would reject the raw
 * byte escapes, and `--encoding=none` keeps the search on the bytes themselves.
 * Measured against a directory holding UTF-32LE, UTF-32BE, UTF-16LE, UTF-8-BOM,
 * GBK and plain ASCII files, the alternation named exactly the two UTF-32 files
 * and nothing else — so it is a precise trigger, not a heuristic.
 *
 * The mark is required. A BOM-less UTF-32 file is genuinely undetectable here
 * (nothing distinguishes its bytes from binary), which is the same limit the
 * plugin's own admission has.
 *
 * @param kit - the loaded search toolkit.
 * @param subprocess - the validated seam.
 * @param exec - the calling execution.
 * @param input - the validated arguments, for the search root and include filter.
 * @returns the absolute paths of the UTF-32 files found.
 */
async function findUtf32Files(
  kit: SearchKit,
  subprocess: SubprocessLike,
  exec: ToolExecution,
  input: { path?: string; include?: string },
): Promise<string[]> {
  const argv = ["--files-with-matches", "-a", "--encoding=none", `--regexp=${UTF32_BOM_PATTERN}`];
  if (input.include !== undefined) argv.push(`--glob=${input.include}`);
  if (input.path !== undefined) argv.push("--", input.path);
  let run: RgRun;
  try {
    run = await spawnRg(kit, subprocess, exec, argv);
  } catch (error) {
    if (exec.signal.aborted) throw error;
    return [];
  }
  // A truncated stream is a suffix of the file list, so the files it omits are
  // simply not searched. Returning the tail as if it were the whole list would
  // hide that; returning nothing makes the omission uniform and visible in the
  // same way, and the default pass still covers everything ripgrep can decode.
  if (run.stdoutLossy) return [];
  if (run.exitCode !== 0 && run.exitCode !== 1) return [];
  return run.stdout.split("\n").filter((line) => line.length > 0);
}

/**
 * Search the UTF-32 files under the search root, in JavaScript.
 *
 * The one encoding ripgrep cannot search, so the only files that take the
 * JavaScript path — which is what keeps the pattern-language difference
 * (`(?i)` and `(?s)` are ripgrep syntax that throws in JavaScript) contained to
 * a file type that is vanishingly rare in a source tree.
 *
 * A pattern JavaScript cannot compile is reported as such rather than swallowed:
 * the model can rewrite it, and a silent empty result would read as "not
 * present" — the exact confusion this tool exists to remove.
 *
 * @param kit - the loaded search toolkit.
 * @param ctx - the plugin context.
 * @param subprocess - the validated seam.
 * @param exec - the calling execution.
 * @param input - the validated arguments.
 * @param config - the deployment's admission config.
 * @param workdir - the resolved workdir, for display paths.
 */
async function searchUtf32Files(
  kit: SearchKit,
  ctx: Context,
  subprocess: SubprocessLike,
  exec: ToolExecution,
  input: { pattern: string; path?: string; include?: string },
  config: PluginConfig,
  workdir: string,
): Promise<DecodedMatch[]> {
  const files = await findUtf32Files(kit, subprocess, exec, input);
  const out: DecodedMatch[] = [];
  for (const file of files) {
    // ripgrep prints the path relative to the spawn cwd when the search root was
    // relative, and absolute when it was absolute. `ctx.fs.resolve` handles both
    // against the session cwd, so no rewriting is needed here — but the DISPLAY
    // path has to be derived from what ripgrep printed, not from the resolved
    // target, so the two agree with the rest of the results.
    const attempt = await readAndDecode(ctx, exec, file, config);
    // A file that cannot be read is simply not reported by this pass, exactly as
    // before — the reason is of no use here, since this path has no placeholder
    // to enrich.
    if ("error" in attempt) continue;
    try {
      // Appended one by one rather than spread: this file's matching lines are
      // the argument count, and V8 rejects a call with too many — the same limit
      // as the UTF-32 site above, reached by a single file rather than a tree.
      const found = await searchDecodedTextIsolated(
        attempt.text,
        input.pattern,
        kit.kit.toWorkdirRelative(file, workdir),
        { signal: exec.signal },
      );
      for (const match of found) out.push(match);
    } catch (error) {
      if (error instanceof SyntaxError) throw patternError(error, input.pattern);
      throw error;
    }
  }
  return out;
}

/**
 * Run the search once per Unicode encoding and collect the decoded rows.
 *
 * The ASCII path's blind spot, and the reason this exists at all: ripgrep
 * searches for an ASCII pattern by its BYTES, which are identical in every
 * encoding this plugin supports — so the default call finds a GBK file's
 * `PORT=8080` perfectly well. What it cannot do is DECODE the line it found, and
 * for UTF-16 the problem is one step earlier: measured, ripgrep's own BOM
 * sniffing is what makes a UTF-16 file searchable, so a BOM-LESS UTF-16 file is
 * not found at all — `Found 0 matches`, with no placeholder and no error.
 *
 * That is a genuine inconsistency rather than a deliberate limit, because the
 * non-ASCII path DOES find such a file (its candidate list contains the UTF-16
 * pages). One file, two answers depending on whether the pattern happened to
 * contain a non-ASCII character.
 *
 * ## Why these passes need a per-file gate
 *
 * They are NOT exact, contrary to what an earlier revision of this comment
 * claimed. ripgrep does not skip a file whose bytes are not UTF-16 when an
 * explicit `--encoding` is given; it re-pairs the bytes and matches the result.
 * Measured over this repository's own `src` with `\w+`: pass 1 returns 8186
 * rows, and the `utf-16le` pass returns 24 rows that are pure mojibake
 * (`潣獮⁴潰瑲㴠㠠㠰㬰` for `const port = 8080;`). The merge is last-writer-wins,
 * so those rows REPLACED correct results — 24 files corrupted by one search, and
 * 90 phantom `(path, lineNumber)` pairs that pass 1 never had at all.
 *
 * Two gates therefore apply, and BOTH are needed:
 *
 * 1. **Ownership.** A file an earlier pass already decoded is not the UTF-16
 *    passes' business. Pass 1's cleanly decoded rows and pass 2's decoded rows
 *    are both "owned"; a row for an owned file is dropped. This alone removes
 *    every phantom and every overwrite of an earlier pass's output.
 * 2. **Byte order.** Ownership cannot resolve a file that NO earlier pass saw,
 *    which is exactly the BOM-less UTF-16 file these passes exist for: both the
 *    `utf-16le` and the `utf-16be` run claim it, and since the BE run goes last,
 *    a genuine UTF-16LE file was reported as BE mojibake — measured on a BOM-less
 *    UTF-16LE file with `\w+`, the correct `const key_0 = value_0;` was replaced
 *    by an ideographic rendering of the same bytes. The order is therefore taken
 *    from the file's own bytes.
 *
 * A file with no order evidence (no mark, no NUL byte at all, no newline whose
 * pair survives the wrong reading, and no parity the NUL counts agree on) is
 * left to the default pass and to pass 2 rather than guessed at: its two
 * readings are both well-formed, so admitting either would be a coin toss that
 * silently overwrites the other.
 *
 * That last case is a TIE, and it is refused rather than resolved. A tie is a
 * file whose NULs sit at both parities, which is what a genuine UTF-16 file
 * containing one CJK character looks like AND what a legacy page's file with two
 * stray NULs at opposite parities looks like. The two are not distinguishable
 * from the bytes, and the cost of guessing is asymmetric: measured on a
 * single-line GBK file whose two stray NULs make it tied, the pattern `\d`
 * reported the UTF-16 mojibake `偏刀㴸8〠엤훃쿮` as if it were the line, while the
 * correct `PORT=8080 配置项` was in the file all along. Reporting a wrong
 * reading as text is the one failure this plugin exists to prevent, so a tied
 * file keeps whatever the default pass and pass 2 gave it.
 *
 * A tie is NOT resolved by asking which UTF-16 pass matched. Both passes are
 * wrong about a legacy page's file, so "only this order matched" is evidence
 * about two readings that are both mojibake, not about the file — measured, the
 * GBK file above matches `\d` under `utf-16be` alone and `R` under `utf-16le`
 * alone, and adopting either reports garbage. Resolving it needs a fact about
 * the file's LEGACY reading, which no pass here has.
 *
 * The price is the case a tie used to be adopted for: a BOM-less single-line
 * UTF-16 file holding `一刀ABC`, where the pattern `ABC` answers `Found 0
 * matches` again. That is a silent miss on a real file, and it is the honest
 * half of the trade — the alternative reported mojibake as text. A BOM-less
 * UTF-16 file WITH newlines is unaffected: its newline pairs name the order
 * before the parity counts are consulted, so it is still found.
 *
 * A file that is not UTF-16 text at all — UTF-32, or an unreadable path — is the
 * case that must stay refused, and it keeps both passes off the file.
 *
 * ## Cost
 *
 * Two extra spawns on every ASCII search. Measured on this repository (70
 * files): 29 ms for the single default pass against 80 ms for all three. That
 * is the price of correctness here, and it is bounded — the count does not grow
 * with the number of files. The byte-order gate reads a file only after the
 * ownership gate has accepted it, so a repository with no UTF-16 files costs no
 * extra reads at all.
 *
 * @param kit - the loaded search toolkit.
 * @param ctx - the plugin context, for the byte-order read.
 * @param subprocess - the validated seam.
 * @param exec - the calling execution.
 * @param input - the validated arguments.
 * @param config - the deployment's admission config.
 * @param workdir - the resolved workdir, for display paths.
 * @param owned - display paths an earlier pass already decoded.
 * @param refusedCandidates - the candidate list an earlier pass already refused a
 *   line with, keyed by `(displayPath, lineNumber)`. See the `tied` branch.
 */
async function searchUnicodeFiles(
  kit: SearchKit,
  ctx: Context,
  subprocess: SubprocessLike,
  exec: ToolExecution,
  input: { pattern: string; path?: string; include?: string },
  config: PluginConfig,
  workdir: string,
  owned: ReadonlySet<string>,
  refusedCandidates: ReadonlyMap<string, readonly string[]>,
): Promise<DecodedMatch[]> {
  const out: DecodedMatch[] = [];
  for (const encoding of UNICODE_SEARCH_ENCODINGS) {
    const label = rgLabelFor(encoding);
    if (label === undefined) continue;
    let run: RgRun;
    try {
      run = await spawnRg(kit, subprocess, exec, [
        `--encoding=${label}`,
        ...kit.kit.buildGrepCommand(input),
      ]);
    } catch (error) {
      if (exec.signal.aborted) throw error;
      continue;
    }
    // A truncated stream is a SUFFIX of the real rows, so adopting it would
    // report a partial result as a complete one. This pass is an auxiliary one:
    // dropping it costs the BOM-less UTF-16 files it would have found, while
    // adopting it would cost correctness. The default pass has already failed
    // loudly on its own overflow, so this is the quiet half of the same rule.
    if (run.stdoutLossy) continue;
    if (run.exitCode !== 0 && run.exitCode !== 1) continue;
    // Resolved once per pass rather than per row: the answer is a per-file fact
    // and the read is the expensive part.
    const orderByPath = new Map<string, Utf16Order>();
    for (const raw of parseRgJson(run.stdout)) {
      // A row still in `bytes` means this encoding did not decode the file after
      // all, so this pass has nothing trustworthy to say about that line.
      if (raw.text === undefined) continue;
      const displayPath = kit.kit.toWorkdirRelative(raw.path, workdir);
      if (owned.has(displayPath)) continue;
      if (!orderByPath.has(raw.path)) {
        orderByPath.set(raw.path, await utf16OrderOfFile(ctx, exec, raw.path, config));
      }
      const order = orderByPath.get(raw.path);
      // `not-text` is a UTF-32 file, an unreadable path, or a file whose own
      // bytes hold a U+0000 code unit: not UTF-16 text, so neither pass may
      // speak for it.
      if (order === undefined || order === "not-text") continue;
      // A TIE is refused, because nothing available can tell which of the file's
      // two readings is the text. The two passes are both wrong about a legacy
      // page's file, so "which pass matched" is not evidence about the file — see
      // the note above `utf16ByteOrder`.
      //
      // Refused VISIBLY rather than dropped, and that is the whole reason this
      // branch has a body. Both passes are off the file, so dropping the row
      // leaves nothing at all behind it, and a file whose only match was here
      // renders as `Found 0 matches` — the silent miss this tool exists to
      // remove, arriving by the one route the per-file pass cannot cover: a file
      // over `maxFileBytes` never reaches admission, so no candidate list is ever
      // built for it. Measured on a 6032-byte BOM-less UTF-16LE file whose line 1
      // is 3000 ASCII characters and whose only break sits at byte 6000, searched
      // for `配置说明` with `maxFileBytes` 4096: the workspace answered `Found 0
      // matches` where the same bytes on the strict path returned the line
      // verbatim. A placeholder at the matched line number, naming the two pages
      // that can hold these bytes, is the honest answer and the one `read` gives.
      //
      // The line numbers are a UNION over both pages, which is the same shape
      // `contradictedLines` produces and for the same reason: the two readings do
      // not have to break in the same places, so the only safe claim is that
      // SOMETHING matched around here and which encoding it was is undecided.
      // `mergeMatches` deduplicates the two pages' identical placeholders.
      //
      // A line the sweep ALREADY refused keeps BOTH candidate lists, and that is
      // the whole point of this branch having a map to consult. The two lists are
      // not alternatives to choose between — they are the two families of page
      // that could hold these bytes, and neither pass can rule the other out:
      //
      //   - the sweep's list is the pages that PROVED the file, and it exists only
      //     for a file the strict pass could not decode at all;
      //   - this list is the two pages that pair the bytes, and it exists whenever
      //     no LEGACY page proved the file.
      //
      // Taking either alone hands the caller a dead end on the other's files, and
      // both directions are measured. On the reported fixture — a single-line Big5
      // file carrying two stray NULs — the sweep names `gbk, big5` while `read`
      // under `utf16le` AND `utf16be` both fail with `E_DECODE_FAILED`. On the
      // mirror image, an over-cap BOM-less UTF-16LE file, the sweep names
      // `gbk, big5`, both of those fail, and `utf16le` is the one that returns the
      // line. The merge is last-writer-wins on `(path, lineNumber)`, so without
      // this the second case replaced the correct pair with the first case's — the
      // defect this parameter exists to fix, in the other direction.
      //
      // The sweep's list leads, because its evidence is stronger: it says these
      // pages DECODED the file, while this one only says these pages could. The
      // `read` this placeholder invites is a single call with one candidate, so the
      // order is the difference between the answer on the first try and on the
      // second.
      if (order === "tied") {
        const prior = refusedCandidates.get(`${displayPath}\u0000${raw.lineNumber}`);
        const candidates =
          prior === undefined
            ? [...UNICODE_SEARCH_ENCODINGS]
            : [...new Set([...prior, ...UNICODE_SEARCH_ENCODINGS])];
        out.push({
          path: displayPath,
          lineNumber: raw.lineNumber,
          line: placeholderFor(candidates),
        });
        continue;
      }
      // Only the pass whose order the file's own bytes name may report it.
      if (order !== encoding) continue;
      out.push({ path: displayPath, lineNumber: raw.lineNumber, line: raw.text });
    }
  }
  return out;
}

/**
 * The byte order a file's own bytes are consistent with, if any.
 *
 * A mark is decisive and is checked first, because ripgrep honours it over
 * `--encoding` and the two passes therefore agree on a marked file. The
 * four-byte UTF-32LE mark is tested before the two-byte UTF-16LE one, since
 * `ff fe 00 00` starts with `ff fe` and would otherwise be read as UTF-16.
 *
 * Without a mark the NEWLINES decide first, and the NUL bytes only after them.
 * That half lives in {@link utf16NewlineOrder}, because the placeholder loop
 * asks it about a file admission decoded and the two must not disagree.
 *
 * The newline is the structural fact that survives the wrong reading. U+000A is
 * `0a 00` in LE and `00 0a` in BE, and what those two byte pairs spell when read
 * the other way round — U+0A00 and U+0000 — is not a newline either. So a file
 * that breaks into lines under one order and collapses into a single very long
 * line under the other is decidable, and nothing about its NULs can outvote it.
 *
 * That matters because the NUL counts alone cannot separate the two uses of a
 * NUL. UTF-16 stores each ASCII character with exactly one, at the parity of the
 * order — but it ALSO stores a code point like U+4E00 (「一」) with one, at the
 * OTHER parity. A single such character, and there are 82 of them in the CJK
 * Unified Ideographs block, therefore puts a NUL at both parities and used to
 * make the file "undecidable" outright. Both passes then dropped the file's
 * correct line, and since ripgrep never sniffed it either (see
 * `searchUnicodeFiles`) the search answered `Found 0 matches` for a file whose
 * bytes were never in doubt: measured on 40 ASCII lines plus one
 * `// 第一项 PORT=8080` comment in BOM-less UTF-16LE, 994 NULs sat at one parity
 * against 1 at the other, with 41 newlines on top.
 *
 * An undecided order is still a VALUE rather than an omission, because the two
 * ways it can be undecided are not the same for the caller's gate. {@link
 * Utf16Order} separates them: `not-text` is the UTF-32 file (which has its own
 * BOM-driven path, and which the U+0000 guard above refuses outright), while
 * `tied` is a file whose two readings are byte-swaps of each other, both
 * well-formed, and which of them is the text is not decidable from the bytes.
 * The gate refuses both.
 *
 * `tied` is reached two ways, and the second is not a tie of counts at all: the
 * NUL parities may both be populated, or `bytes` may be a PREFIX of a larger file
 * that named no order by its line breaks. The second is refused for the same
 * reason as the first — see the `partial` branch below, where the reading a
 * window would have named is shown to be a coin toss.
 *
 * @param bytes - the file's bytes, or a bounded PREFIX of them.
 * @param partial - whether `bytes` is a prefix of a larger file rather than the
 *   whole of it. Only the NUL counts depend on it, and they depend on it
 *   completely — see the `partial` branch below.
 */
function utf16ByteOrder(bytes: Uint8Array, partial: boolean): Utf16Order {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return "not-text";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";
  let even = 0;
  let odd = 0;
  let nulUnits = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 0) even++;
    else odd++;
  }
  // Character-aligned, so each pair is one UTF-16 code unit and a match requires
  // the pair to sit on a character boundary rather than anywhere in the stream.
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) nulUnits++;
  }
  // A UTF-16 TEXT file has no U+0000 code unit, and this is what keeps the
  // newline evidence below from claiming a UTF-32 file: UTF-32 spells an ASCII
  // character as three NULs beside it, so pairing those bytes as UTF-16 unavoidably
  // produces U+0000 units. Measured on a BOM-less UTF-32LE source file, the
  // `0a 00` inside each `0a 00 00 00` read as a newline and the file was claimed
  // as UTF-16LE — 762 rows of single characters, on lines numbered into the
  // thousands, replacing the single placeholder row per real line it had before.
  // Returning `undefined` here cannot take a verdict away from a file that used
  // to have one: a U+0000 unit puts a NUL at both parities, which is exactly the
  // shape the parity counts below refuse.
  if (nulUnits > 0) return "not-text";
  // No NUL byte anywhere, so there is no pair-alignment evidence to weigh at
  // all — this is not a tie, it is the absence of the whole question. A UTF-16
  // text file of any length holds a NUL for every ASCII character it contains,
  // so a file with none is either not UTF-16 or the pure-CJK, newline-less case
  // the note above leaves uncovered; both are refused here. Without this the
  // counts below fall through to `tied`, which would name a file whose two
  // readings were never in question as one this gate had weighed.
  if (even === 0 && odd === 0) return "not-text";
  // Both branches imply the parity the NUL counts would have named anyway — a
  // `0a 00` pair IS a NUL at an odd offset — so this only ever decides a file
  // the counts had left undecided, never overrules one they had settled.
  //
  // Read off {@link utf16NewlineOrder} rather than counted again here: the
  // placeholder loop asks the same alignment question about a file admission
  // decoded, and two copies of this rule would be free to drift into disagreeing
  // about which files are UTF-16.
  //
  // Its two names are matched rather than returned straight through, because it
  // answers `string | undefined` and the only two values it can produce are
  // those below — the `undefined` arm it shares with this function means
  // something else here, so passing it on would be a type error that happens to
  // be right rather than a rule.
  const byNewline = utf16NewlineOrder(bytes);
  if (byNewline === "utf16le" || byNewline === "utf16be") return byNewline;
  // The counts below are a WHOLE-FILE statistic, and a truncated window is not
  // entitled to them. Parity is a property of the offset, so a prefix does
  // sample the same statistic — but it samples it without the file's own
  // counter-evidence, and that is enough to invert the verdict. A BOM-less
  // UTF-16BE file of CJK whose every code unit ends in a NUL byte puts those
  // NULs at ODD offsets, which is exactly the shape ASCII puts at odd offsets
  // in UTF-16LE; on the whole file the trailing `00 0a` adds a NUL at the other
  // parity and the counts come out `tied`, while the first 4096 bytes of the
  // same file hold no break at all and the counts name `utf16le` — the opposite
  // order. Measured on a 3000-character CJK line with no break before byte
  // 4096, in both orders: the window named the other order each time and the
  // wrong page's re-pairing replaced the file's real text with mojibake. So a
  // window that names no order by its line breaks abstains instead of guessing,
  // which is what the caller already does with `tied`.
  if (!partial) {
    if (odd > 0 && even === 0) return "utf16le";
    if (even > 0 && odd === 0) return "utf16be";
  }
  // Neither parity wins, which is a genuine tie: the file is UTF-16-shaped but
  // its order is a coin toss, and the caller refuses it rather than guessing.
  // A `partial` window lands here too, and for the same reason: the one order it
  // could name is one it cannot rule the other out against.
  return "tied";
}

/**
 * What {@link utf16ByteOrder} concluded, including the two ways it can abstain.
 *
 * A named union rather than `string | undefined` because the three answers call
 * for three different treatments: only a named order licenses a pass to report
 * the file, while `tied` and `not-text` both keep BOTH passes off it and differ
 * only in why. Collapsing `not-text` into `tied` is what made a BOM-less UTF-32
 * file — 41 honest placeholder rows — come back as 1037 rows of single
 * characters.
 */
type Utf16Order = "utf16le" | "utf16be" | "tied" | "not-text";

/**
 * The bytes {@link utf16ByteOrder} reads its verdict from, for one file, and
 * whether they are the whole file.
 *
 * The whole file when it fits the cap, and a bounded PREFIX of it when it does
 * not. The prefix carries two of the three facts the verdict rests on — the
 * byte-order mark and which alignment the line breaks sit on — and it is exactly
 * those two that can decide a file on their own. The third, the parity of the
 * NUL bytes, is a whole-file statistic that a window is not entitled to, so it
 * is reported as unusable rather than guessed at; see the `partial` branch in
 * {@link utf16ByteOrder} for the measurement that made that necessary. The window
 * is bounded by the same `cap`, so this reads no more than the whole-file path
 * would have.
 *
 * The fallback is a fallback rather than the only path, and that is deliberate.
 * `readBytes` is the seam every deployment has, so a file it CAN serve is read
 * exactly as before; only a read it refuses is retried as a window. Taking the
 * window unconditionally would make a backend without `readByteRange` answer
 * `not-text` for every file — the whole UTF-16 half of this tool, gone — whereas
 * a fallback that cannot run leaves the refusal it was standing in for.
 *
 * `readBytes` is where this is needed, and the reason is its contract: it THROWS
 * `FS_TOO_LARGE` on a file over the cap instead of returning a truncated result.
 * The caller's `catch` reads any failure as `not-text`, which for a file whose
 * own bytes name a UTF-16 order refuses BOTH UTF-16 pages — and they are the only
 * two that can decode it, so the file leaves the result entirely. Measured with
 * `maxFileBytes` at 64 KiB over a BOM-less UTF-16LE file of a few lines past the
 * cap: the file vanished from a directory search that names its line before the
 * change, and naming the file directly answered `(line is not valid UTF-8 —
 * candidates: gbk, big5)` — two pages that cannot hold those bytes at all,
 * offered as the remedy for a file this gate had thrown away.
 *
 * @param ctx - the plugin context, for `fs`.
 * @param exec - the calling execution, for the abort signal.
 * @param target - the resolved file.
 * @param cap - the inclusive byte cap, already reduced to the file's own size.
 * @returns the bytes to decide on, and whether they are only a prefix of it.
 * @throws when neither read can be taken, for the caller's `not-text`.
 */
async function utf16BytesOfFile(
  ctx: Context,
  exec: ToolExecution,
  target: FsTarget,
  cap: number,
): Promise<{ bytes: Uint8Array; partial: boolean }> {
  try {
    return { bytes: await ctx.fs.readBytes(target, exec.signal, cap), partial: false };
  } catch (error) {
    if (exec.signal.aborted) throw error;
    return {
      bytes: await ctx.fs.readByteRange(target, { offset: 0, length: cap }, exec.signal),
      // The refusal being retried is `readBytes` declining to answer a file over
      // `cap` — that is the one failure it has that a window can serve — so the
      // bytes coming back are a prefix of a file larger than them.
      partial: true,
    };
  }
}

/**
 * Read one file's bytes and report the byte order they are consistent with.
 *
 * A failure to read is `not-text`, which the caller treats exactly like "this is
 * not a UTF-16 file": this pass simply does not report the file. That is
 * deliberate — the file is still covered by the default pass and by pass 2, so
 * an unreadable file must not become a failed search. It is a refusal about the
 * bytes that could not be TAKEN, and {@link utf16BytesOfFile} is what keeps a
 * file the cap refused from landing here.
 *
 * @param ctx - the plugin context, for `fs`.
 * @param exec - the calling execution, for the cwd and the abort signal.
 * @param file - the path as ripgrep printed it.
 * @param config - the deployment's admission config, for the read cap.
 */
async function utf16OrderOfFile(
  ctx: Context,
  exec: ToolExecution,
  file: string,
  config: PluginConfig,
): Promise<Utf16Order> {
  try {
    const target = await ctx.fs.resolve(file, { cwd: workdirOf(exec) });
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined || info.type !== "file") return "not-text";
    const cap =
      info.size === undefined ? config.maxFileBytes : Math.min(info.size, config.maxFileBytes);
    const { bytes, partial } = await utf16BytesOfFile(ctx, exec, target, cap);
    return utf16ByteOrder(bytes, partial);
  } catch (error) {
    if (exec.signal.aborted) throw error;
    return "not-text";
  }
}

/**
 * Build the encoding-governed `grep` tool.
 *
 * @param ctx - the plugin's host context.
 * @param kit - the loaded search toolkit; the caller has established it is usable.
 * @param subprocess - the validated seam; the caller has already established it exists.
 */
export function buildGrepTool(ctx: Context, kit: SearchKit, subprocess: SubprocessLike) {
  const caps = capsOf(kit);
  return defineTool({
    name: "grep",
    description: GREP_DESCRIPTION,
    parameters: {
      pattern: {
        type: "string",
        required: true,
        description: "Regular expression to search for (ripgrep syntax).",
      },
      path: {
        type: "string",
        description:
          "File or directory to search. Defaults to the session workspace; a relative path resolves against it.",
      },
      include: {
        type: "string",
        description:
          'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
      },
    },
    timeoutMs: caps.timeoutMs,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          matches: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", required: true },
                lineNumber: { type: "integer", required: true },
                line: { type: "string", required: true },
              },
            },
          },
          spill: {
            type: "object",
            additionalProperties: false,
            properties: {
              locator: { type: "string", required: true },
              bytes: { type: "integer", required: true },
              retrievalHint: { type: "string", required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as GrepValue;
        return [
          {
            type: "text" as const,
            text: kit.kit.formatGrepOutput(retain(kit, v.matches), v.spill as never),
          },
        ];
      },
      // The search card is derived from this metadata by the CLIENT, not from
      // `presentResult`: measured, `searchCardModel` narrows
      // `{ shape, files, total, truncated }` itself. The shape therefore has to
      // match the built-in's projection even though that projector is not
      // exported and this one is written out by hand.
      presentationMeta: (_args, value) => grepMeta(kit, retain(kit, (value as GrepValue).matches)),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec: ToolExecution) {
      const input = kit.kit.parseGrepArgs(
        args as { pattern: string; path?: string; include?: string },
      );
      const config = loadConfig();
      const workdir = workdirOf(exec);

      // A non-ASCII pattern needs the transcoding strategy: the default call
      // cannot match it in any file whose encoding is not UTF-8, so there would
      // be no undecodable row to react to and the per-file strategy below would
      // never run. Measured: `--regexp=配置项` over a GBK file returns zero
      // matches — the silent miss this tool exists to fix.
      //
      // The sweep runs FIRST and seeds the pass below, rather than replacing it.
      // It is not a superset of the strict pass, and the reason is the ASCII
      // alternative: for `配置|read`, a GBK file holding only `read` on a line
      // with legacy bytes produces a strict `bytes` row and NO proof from any
      // page — the file has the pattern's ASCII half and not its non-ASCII half
      // — so the strict pass and the per-file pass are what answer for it. What
      // the sweep uniquely contributes is the files the strict pass cannot even
      // SEE: a GBK file whose matching line holds `配置` produces no strict row
      // at all, because the pattern's UTF-8 bytes are not in the file.
      let proven: DecodedMatch[] = [];
      // Files two pages read differently. Nothing here can say which is right, so
      // the sweep claims no text for them: their lines become placeholders that
      // name the candidates, and the per-file pass below decodes them through
      // admission — the only pass that can answer for them. See
      // `searchByTranscoding`.
      let conflicted: ConflictedFile[] = [];
      if (needsTranscodedSearch(input.pattern)) {
        // The candidate list is the deployment's guess set PLUS the Unicode
        // encodings, which `supportedEncodings` deliberately leaves out: that
        // list exists to bound the GUESSING heuristic, where a UTF-16 page would
        // compete with the legacy pages on every file. Here the question is
        // different — which pages could hold these bytes at all — and omitting
        // UTF-16 would miss a BOM-less UTF-16 file entirely. Measured: ripgrep's
        // own BOM sniffing finds a marked UTF-16 file, but `--encoding=utf-16le`
        // is required for an unmarked one.
        //
        // UTF-8 is deliberately absent: the strict pass below already decodes
        // every valid-UTF-8 file, and `--encoding=utf-8` would only add a lossy
        // reading of the same bytes.
        const candidates = [...config.supportedEncodings, ...UNICODE_SEARCH_ENCODINGS];
        const legacy = encodingsForPattern(input.pattern, candidates);
        const sweep = await searchByTranscoding(
          kit,
          ctx,
          subprocess,
          exec,
          input,
          legacy,
          config,
          workdir,
        );
        for (const match of sweep.matches) proven.push(match);
        for (const file of sweep.conflicted) conflicted.push(file);
      }

      // Pass 1: exactly the built-in's call. Everything ripgrep can already read
      // is adopted here, which is every line of a UTF-8 repository.
      const first = await spawnRg(kit, subprocess, exec, kit.kit.buildGrepCommand(input));
      // The order is the built-in's: a non-zero exit is its own actionable error
      // (an invalid regex names itself on stderr), and only then is the retained
      // stdout checked. A `lossy` stream is a SUFFIX of the real output — the
      // seam keeps the tail — so `parseRgJson` would silently drop the half-
      // written first record and render the remainder as a complete result.
      // Measured on this repository, `grep({ pattern: "." })` produces 94 MB of
      // raw stdout against the 20 MB cap.
      if (first.exitCode !== 0 && first.exitCode !== 1) {
        throw runFailure(first.exitCode, first.stderr);
      }
      if (first.stdoutLossy) throw stdoutOverflow(caps.rawOutputMaxBytes);
      const raw = parseRgJson(first.stdout);

      // A line the strict pass already decoded as clean TEXT is not the sweep's to
      // answer for, and letting the sweep claim it was the most expensive mistake
      // this change made.
      //
      // The reason is that a UTF-8 file is legible to EVERY legacy page: ripgrep
      // transcodes its bytes through the page and the result is mojibake, but
      // mojibake is still non-ASCII text, so it satisfies the proof rule and the
      // page claims the file. Measured on this repository's README.md (valid
      // UTF-8) with `[一-龥]`: gbk claimed 258 lines, big5 256, shift_jis 258 and
      // euc-kr 239 — four contradicting claims about a file the strict pass had
      // already decoded correctly, all 256 lines of it. Under the file-level
      // conflict rule that followed, every one of those real matches was withheld
      // and the file came back as placeholders; 23 files in this repository alone
      // were affected, README.md and `src/encoding.ts` among them.
      //
      // So the precedence is the tool's own promise — `grep` never knows more than
      // `read` — applied per line: what the strict pass decoded as text IS the
      // answer, and a page's claim about that line is redundant at best. What the
      // sweep uniquely contributes is the files the strict pass cannot SEE at all,
      // which for a non-ASCII pattern is every file in another encoding: measured,
      // a GBK file yields no strict row for `配置项`, so nothing here filters it.
      //
      // A U+0000-bearing `text` row does not count as decoded: ripgrep reports a
      // BOM-less UTF-16 file that way, and that mojibake is exactly what the
      // `owned` set refuses below.
      //
      // Guarded on the sweep having claimed something, because that is the only
      // case there is anything to filter: an ASCII search never runs the sweep, so
      // both lists are empty and building this index would walk every row of the
      // result — with a `toWorkdirRelative` per row — to decide nothing. That is
      // the common path, not a corner case.
      if (proven.length > 0 || conflicted.length > 0) {
        const strictClean = new Set<string>();
        for (const match of raw) {
          if (match.text === undefined || match.text.includes("\u0000")) continue;
          strictClean.add(
            `${kit.kit.toWorkdirRelative(match.path, workdir)}\u0000${match.lineNumber}`,
          );
        }
        if (strictClean.size > 0) {
          proven = proven.filter(
            (match) => !strictClean.has(`${match.path}\u0000${match.lineNumber}`),
          );
          conflicted = conflicted.flatMap((file) => {
            const displayPath = kit.kit.toWorkdirRelative(file.raw, workdir);
            const lineNumbers = file.lineNumbers.filter(
              (lineNumber) => !strictClean.has(`${displayPath}\u0000${lineNumber}`),
            );
            return lineNumbers.length > 0 ? [{ ...file, lineNumbers }] : [];
          });
        }
      }

      const pass1: DecodedMatch[] = [];
      // The rows the placeholder loop below may rewrite: the ones that are NOT a
      // real decode. An undecodable row is one; so is a row ripgrep called
      // `text` while filling it with literal U+0000, which is a BOM-less UTF-16
      // file read as UTF-8 — the same mojibake the `owned` set refuses, and for
      // the same reason. Collecting them here is what keeps the loop off a row
      // ripgrep genuinely decoded: a later pass cannot tell a placeholder from a
      // line that legitimately reads like one, and stamping the placeholder over
      // a real line would call valid UTF-8 invalid.
      const rewritable: DecodedMatch[] = [];
      for (const match of raw) {
        const displayPath = kit.kit.toWorkdirRelative(match.path, workdir);
        // An undecodable row gets a bare placeholder here. It is replaced by
        // pass 2 when that file can be decoded, or enriched with candidates when
        // it cannot.
        const row =
          match.text === undefined
            ? { path: displayPath, lineNumber: match.lineNumber, line: placeholderFor([]) }
            : { path: displayPath, lineNumber: match.lineNumber, line: match.text };
        pass1.push(row);
        if (match.text === undefined || match.text.includes("\u0000")) rewritable.push(row);
      }

      // UTF-32 files are invisible to this path for the same reason they are
      // invisible to the transcoded one: ripgrep cannot decode them, so a match
      // in such a file is not an undecodable ROW — it is no row at all. They are
      // found by their BOM and searched in JavaScript, and their hits merge in
      // alongside everything else.
      const utf32 = await searchUtf32Files(kit, ctx, subprocess, exec, input, config, workdir);

      // Which files still need the per-file pass: the ones with an undecodable
      // row that the sweep did not cover, plus every conflicted file.
      //
      // Coverage is the load-bearing half. A file the sweep proved is answered by
      // that page's decode — but only for the lines that page MATCHED, and a
      // strict `bytes` row can be a line the page does not match at all: measured
      // on a GBK file whose line 1 is `// 配置` and whose line 2 holds the byte
      // `0x81` before `read`, the gbk decode of line 2 is `// 乺ead`, so the page
      // never reports it while the strict pass matches it on the raw bytes.
      // Skipping such a file leaves that row with a bare placeholder and no
      // candidate list — the remedy the placeholder exists to carry. So the sweep
      // answers a file only when it covered every undecodable row of it.
      //
      // `undecodedLines` is built from the same rows `filesNeedingDecoding`
      // projects, so a file in that list always has an entry here; only the
      // `covered` half can be absent, which is why only that one is checked.
      const undecodedLines = new Map<string, Set<number>>();
      for (const match of raw) {
        if (match.bytes === undefined) continue;
        const displayPath = kit.kit.toWorkdirRelative(match.path, workdir);
        const lines = undecodedLines.get(displayPath);
        if (lines === undefined) undecodedLines.set(displayPath, new Set([match.lineNumber]));
        else lines.add(match.lineNumber);
      }
      const coveredLines = new Map<string, Set<number>>();
      for (const match of proven) {
        const lines = coveredLines.get(match.path);
        if (lines === undefined) coveredLines.set(match.path, new Set([match.lineNumber]));
        else lines.add(match.lineNumber);
      }
      const files: string[] = [];
      const queued = new Set<string>();
      for (const file of filesNeedingDecoding(raw)) {
        const displayPath = kit.kit.toWorkdirRelative(file, workdir);
        const covered = coveredLines.get(displayPath);
        const undecoded = undecodedLines.get(displayPath)!;
        // The sweep answered this file in full, so the per-file pass has nothing
        // to add — and would pay a read plus a spawn to reach the same rows.
        if (covered !== undefined && [...undecoded].every((lineNumber) => covered.has(lineNumber))) {
          continue;
        }
        if (queued.has(displayPath)) continue;
        queued.add(displayPath);
        files.push(file);
      }
      // Both lists carry ripgrep's own paths, because that is what the per-file
      // pass reads and decodes; `queued` keeps a file in both lists from being
      // decoded twice.
      for (const file of conflicted) {
        const displayPath = kit.kit.toWorkdirRelative(file.raw, workdir);
        if (queued.has(displayPath)) continue;
        queued.add(displayPath);
        files.push(file.raw);
      }

      // Which files an earlier pass already decoded, and which the UTF-16 passes
      // therefore have no business re-reading. A pass-1 row counts only when it
      // is CLEAN text: ripgrep reports a BOM-less UTF-16 file's matched line as
      // `text` carrying literal U+0000 characters when the search root is that
      // file rather than a directory, and treating that mojibake as an owned
      // decode would block the UTF-16 pass that reads the file correctly.
      const owned = new Set<string>();
      for (const match of raw) {
        if (match.text === undefined || match.text.includes("\u0000")) continue;
        owned.add(kit.kit.toWorkdirRelative(match.path, workdir));
      }
      // A file the sweep PROVED is owned too. Its rows are the answer for that
      // file, and the UTF-16 passes must not overwrite them — the same rule pass
      // 2's matches get below, and for the same reason.
      //
      // A CONFLICTED file is deliberately NOT owned here. The sweep claimed no
      // text for it, so there is nothing to protect, and the two passes that can
      // still answer for it are the per-file pass (which owns it the moment it
      // decodes the file, just below) and — for a file it cannot decode — the
      // UTF-16 passes, exactly as for any other undecodable file.
      for (const match of proven) owned.add(match.path);

      if (files.length === 0) {
        // UTF-16 needs the same treatment as UTF-32 for a different reason:
        // ripgrep finds such a file only when its BOM sniffing fires, so a
        // BOM-less one is missed entirely. See `searchUnicodeFiles`.
        //
        // No line has been refused on this path: `files` is empty, so
        // `conflicted` is empty too — every conflicted file is queued for the
        // per-file pass just below. The map is therefore empty rather than
        // omitted, and the parameter keeps one meaning at both call sites.
        const unicode = await searchUnicodeFiles(
          kit,
          ctx,
          subprocess,
          exec,
          input,
          config,
          workdir,
          owned,
          EMPTY_REFUSALS,
        );
        const matches: GrepMatch[] = mergeMatches([pass1, proven, unicode, utf32]).map((match) => ({
          path: match.path,
          lineNumber: match.lineNumber,
          line: match.line,
        }));
        return finishSearch(kit, ctx, exec, matches);
      }

      const second = await searchUndecodedFiles(
        ctx,
        kit,
        exec,
        subprocess,
        files,
        input,
        config,
        workdir,
      );

      // A file pass 2 decoded is owned too. Its rows are the answer for that
      // file, and the UTF-16 passes must not overwrite them — the failure the
      // per-file strategy was added to fix in the first place.
      for (const match of second.matches) owned.add(match.path);

      // A file whose encoding could not be determined keeps its placeholder, but
      // the candidate list is what turns that placeholder into something the
      // model can act on: re-read the file with one of them, then search again.
      //
      // The list comes from the refusal pass 2 already has. It used to be
      // re-derived here by resolving, statting, reading and admitting each file
      // a second time — the whole-file work this loop exists to avoid paying
      // twice.
      //
      // Whether a row may keep ripgrep's text is a FILE-level question on top of
      // the row-level one `rewritable` answers.
      //
      // The row-level rule alone is not enough, because a row's own bytes are no
      // evidence that the FILE was decoded. `佐` is `50 4f` in UTF-16LE, so the
      // first line of a BOM-less UTF-16LE file arrives as a valid-UTF-8 `text` row
      // holding no U+0000 at all — the NUL sits in the NEXT line's first byte,
      // which ripgrep reports as `bytes`. Measured on a file of `佐呒\n配佐\n`
      // searched for `P`: line 1 is `text` `PORT` and line 2 is `bytes`. Admission
      // refuses that file as binary, so nothing decoded it and that `PORT` is a
      // byte artifact rather than a line.
      //
      // The candidate list is not the whole of that file-level question, because
      // an empty one is ambiguous. A file admission REFUSED as non-text has
      // nothing to offer, but so does a file admission DECODED whose re-search
      // then failed — and for that second file the clean `text` rows are real
      // lines, so rewriting them would throw away text that was decoded
      // correctly. `decoded` separates the two, and only the refusal makes a
      // clean row an artifact.
      if (second.unresolved.length > 0) {
        const byDisplay = new Map<string, { candidates: string[]; decoded: boolean }>();
        for (const { file, error, decoded } of second.unresolved) {
          byDisplay.set(kit.kit.toWorkdirRelative(file, workdir), {
            candidates: candidatesOf(error),
            decoded: decoded === true,
          });
        }
        const rowLevel = new Set(rewritable);
        for (const match of pass1) {
          const entry = byDisplay.get(match.path);
          if (entry === undefined) continue;
          // A file with a textual reading keeps the rows ripgrep decoded; a file
          // with none keeps only the rows that were never text to begin with.
          if ((entry.decoded || entry.candidates.length > 0) && !rowLevel.has(match)) continue;
          match.line = placeholderFor(entry.candidates);
        }
      }

      // A conflicted line's placeholder. It is the one outcome that is neither a
      // silent `Found 0 matches` nor a page's unverified reading shown as the
      // line: the placeholder names the pages that PROVED the file, which is a
      // sharper list than a guess because it is exactly the set of encodings that
      // can hold these bytes.
      //
      // Both filters this needs are already applied upstream, so nothing is
      // re-checked here. `conflicted` holds only lines the strict pass did NOT
      // decode (filtered where `strictClean` is built), and `mergeMatches` puts
      // `second.matches` after `pass1`, so a line the per-file pass decoded
      // replaces this placeholder rather than competing with it. Re-deriving
      // either fact here is what produced the U+0000 blind spot and the
      // file-level skip that this comment used to describe.
      //
      // The keys are kept alongside the rows, because `mergeMatches` is not the
      // only later writer: the UTF-16 passes come after this one, and a `tied` file
      // collides with these rows on the very same key. That map is the LINE-level
      // counterpart of `owned` — a line another pass has already refused, and the
      // list it refused it with — and it is what lets the two refusals be UNIONED
      // instead of one silently replacing the other. See `searchUnicodeFiles`.
      const conflictedLines = new Map<string, readonly string[]>();
      for (const file of conflicted) {
        const displayPath = kit.kit.toWorkdirRelative(file.raw, workdir);
        for (const lineNumber of file.lineNumbers) {
          conflictedLines.set(`${displayPath}\u0000${lineNumber}`, file.candidates);
          pass1.push({
            path: displayPath,
            lineNumber,
            line: placeholderFor(file.candidates),
          });
        }
      }

      const unicode = await searchUnicodeFiles(
        kit,
        ctx,
        subprocess,
        exec,
        input,
        config,
        workdir,
        owned,
        conflictedLines,
      );

      const merged = mergeMatches([pass1, proven, second.matches, unicode, utf32]);
      // The canonical value carries ONLY the three declared fields. The
      // candidate list that `DecodedMatch` tracks internally is already folded
      // into the placeholder TEXT, and the schema is `additionalProperties:
      // false` — returning the extra field would fail output validation and
      // turn every search into an error.
      const matches: GrepMatch[] = merged.map((match) => ({
        path: match.path,
        lineNumber: match.lineNumber,
        line: match.line,
      }));
      return finishSearch(kit, ctx, exec, matches);
    },
    presentCall: kit.kit.presentGrepCall,
    presentResult: kit.kit.presentGrepResult,
  });
}

/**
 * Cap the matches, save the complete result when they were cut, and return the
 * canonical value.
 *
 * Shared by both search strategies, because the cap, the spill handoff and the
 * output shape are properties of the RESULT rather than of how it was found.
 *
 * The complete result is saved through the toolkit's own best-effort helper, so
 * a capped search keeps the recovery path the built-in provides. The whole
 * `SpillRef` is carried, `retrievalHint` included — a locator alone would tell
 * the model where the file is without telling it how to read it.
 *
 * @param kit - the loaded search toolkit.
 * @param ctx - the plugin context, for the spill store lookup.
 * @param exec - the calling execution, which owns the spill artifact.
 * @param matches - every match found, in display order.
 */
async function finishSearch(
  kit: SearchKit,
  ctx: Context,
  exec: ToolExecution,
  matches: GrepMatch[],
): Promise<GrepValue> {
  const retained = retain(kit, matches);
  let spill: GrepValue["spill"];
  if (retained.truncated) {
    const saved = await kit.kit.trySaveFormattedResult(
      ctx,
      exec,
      "grep-results.txt",
      `Found ${matches.length} matches\n\n${formatMatchesPlain(matches)}`,
    );
    if (saved !== undefined) {
      spill = { locator: saved.locator, bytes: saved.bytes, retrievalHint: saved.retrievalHint };
    }
  }
  return { matches, ...(spill === undefined ? {} : { spill }) };
}

/**
 * Apply the inline caps, reusing the built-in's retainer.
 *
 * `ItemRetainer` comes from `@deepseek-ai/dsh-output-retention` because the
 * built-in's own `retainGrepMatches` is not exported. Going through the same
 * retainer keeps the cap semantics — and therefore the truncation footer —
 * identical to the built-in's.
 *
 * @param kit - the loaded search toolkit.
 * @param matches - every match, in display order.
 */
function retain(kit: SearchKit, matches: GrepMatch[]): RetainedItems<GrepMatch> {
  const caps = capsOf(kit);
  const retainer = new kit.ItemRetainer<GrepMatch>({ kind: "head", maxItems: caps.maxMatches });
  for (const match of matches) {
    retainer.push({ ...match, line: kit.kit.previewLine(match.line, caps.maxLineBytes) });
  }
  return retainer.finish();
}

/**
 * The complete result in the built-in's spill format.
 *
 * Written out rather than borrowed because the built-in's `formatGrepMatches` is
 * not exported either. The grouping is the same — file, then one `Line N:` row
 * per match — so a spilled file reads like the inline result it stands in for.
 *
 * @param matches - every match.
 */
function formatMatchesPlain(matches: readonly GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const group = byFile.get(match.path);
    if (group === undefined) byFile.set(match.path, [match]);
    else group.push(match);
  }
  return [...byFile]
    .map(([path, group]) => `${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join("\n")}`)
    .join("\n\n");
}

/**
 * Project retained matches into the search card's metadata.
 *
 * Mirrors the built-in `grepSearchMeta`, which is not exported. The field names
 * are the client's contract, not this module's choice: `searchCardModel` reads
 * `shape` / `files` / `total` / `truncated`, and a mismatch silently downgrades
 * the card to the generic fallback rather than failing loudly.
 *
 * @param kit - the loaded search toolkit.
 * @param retained - the capped matches.
 */
function grepMeta(kit: SearchKit, retained: RetainedItems<GrepMatch>): {
  shape: "matches";
  files: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }>;
  total: number;
  truncated: boolean;
} {
  const byFile = new Map<string, Array<{ lineNumber: number; line: string }>>();
  for (const match of retained.items) {
    const group = byFile.get(match.path);
    const row = { lineNumber: match.lineNumber, line: match.line };
    if (group === undefined) byFile.set(match.path, [row]);
    else group.push(row);
  }
  const meta = {
    shape: "matches" as const,
    files: [...byFile].map(([path, matches]) => ({ path, matches })),
    total: retained.seen,
    truncated: retained.truncated,
  };
  // The meta is persisted with the session log and re-sent on every request, so
  // it is bounded independently of the match cap: trailing file groups are
  // dropped until it fits. `total` is preserved because it counts what the
  // search FOUND, not what the card retains. A single group too large to fit is
  // kept, so the card never goes empty and hides a real result.
  //
  // The budget is compared in UTF-8 BYTES, not in `.length`, which counts UTF-16
  // code units: that is the quantity the built-in's `metaBytes` bounds, and the
  // quantity the session log actually carries. Measured on 40 CJK-named files,
  // `.length` let the meta reach 171,845 bytes against the 65,536-byte budget —
  // 2.62x over — while the built-in kept 2 groups.
  const maxMetaBytes = capsOf(kit).maxMetaBytes;
  let serialized = JSON.stringify(meta);
  while (Buffer.byteLength(serialized, "utf8") > maxMetaBytes && meta.files.length > 1) {
    meta.files.pop();
    meta.truncated = true;
    serialized = JSON.stringify(meta);
  }
  return meta;
}

/** The tool name, so `index.ts` and the tests share one spelling. */
export const GREP_TOOL_NAME = "grep";

/**
 * Unicode encodings the transcoding strategy tries beyond the guess set.
 *
 * `supportedEncodings` bounds the GUESSING heuristic, where a UTF-16 page would
 * compete with the legacy pages on every file and win often enough to matter.
 * The transcoding strategy asks a different question — which encodings could
 * hold this pattern at all — and there the Unicode pages belong: measured,
 * ripgrep finds a BOM-carrying UTF-16 file by sniffing but needs
 * `--encoding=utf-16le` for an unmarked one, so leaving them out would miss
 * BOM-less UTF-16 files entirely.
 *
 * UTF-32 is absent on purpose: ripgrep rejects `--encoding=utf-32le` outright
 * (exit 2, "unknown encoding"), so offering it would only produce a failed run.
 */
const UNICODE_SEARCH_ENCODINGS: ReadonlySet<string> = new Set(["utf16le", "utf16be"]);

/**
 * A refusal map with nothing in it, for a call site that has refused no line.
 *
 * The parameter it fills means "lines an earlier pass already refused, and the
 * candidates it named", and a path that queued every conflicted file for the
 * per-file pass has none. Named rather than inlined as a fresh `new Map()` so that
 * call site reads as the deliberate empty map it is rather than as an omission.
 */
const EMPTY_REFUSALS: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * The byte-mode pattern that matches a UTF-32 byte-order mark.
 *
 * `(?-u)` disables ripgrep's Unicode mode, which is what allows raw byte escapes
 * at all; without it the pattern is rejected as a bad escape. Both byte orders
 * are covered because a file may be either.
 */
const UTF32_BOM_PATTERN = "(?-u)(\\xff\\xfe\\x00\\x00|\\x00\\x00\\xfe\\xff)";
