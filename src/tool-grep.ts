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
import type { RetainedItems } from "@deepseek-ai/dsh-output-retention";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { GrepMatch } from "@deepseek-ai/dsh-tool-fs-search";
import { loadConfig, type PluginConfig } from "./config.js";
import {
  candidatesOf,
  encodingsForPattern,
  filesNeedingDecoding,
  mergeMatches,
  needsTranscodedSearch,
  parseRgJson,
  placeholderFor,
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
 * root. Each run is self-validating: ripgrep transcodes a file with the encoding
 * it is given and only then matches, so a hit under `gbk` means the file really
 * is GBK for those bytes. Measured over five encodings holding the same text,
 * every `(path, lineNumber)` was claimed by exactly ONE encoding — no
 * duplicates and no false positives — so the union of the runs needs no scoring.
 *
 * The candidate list is narrowed first by {@link encodingsForPattern}, which
 * skips a page that cannot spell the pattern at all. For `配置项` that leaves
 * only `gbk`, so the common case is two runs (UTF-8 plus one), not one per
 * supported encoding.
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
 * @param workdir - the resolved workdir, for display paths.
 */
async function searchByTranscoding(
  kit: SearchKit,
  ctx: Context,
  subprocess: SubprocessLike,
  exec: ToolExecution,
  input: { pattern: string; path?: string; include?: string },
  encodings: readonly string[],
  workdir: string,
): Promise<DecodedMatch[]> {
  const out: DecodedMatch[] = [];
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

  for (const { label } of labels) {
    // The pattern's own `--encoding` for a legacy page, plus the always-present
    // UTF-8 run: a repository can hold both, and the UTF-8 run is what finds the
    // files that were never in a legacy page to begin with.
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
    for (const raw of parseRgJson(run.stdout)) {
      // A row that is still bytes means this encoding did not decode the file,
      // so this run's claim about it is not trustworthy; the encoding that does
      // decode it will report the line.
      if (raw.text === undefined) continue;
      out.push({
        path: kit.kit.toWorkdirRelative(raw.path, workdir),
        lineNumber: raw.lineNumber,
        line: raw.text,
      });
    }
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
  // `pattern=配置项`: the utf-8 run exits 0 with 18.5 MB retained of 25.1 MB and
  // is dropped as truncated, while gbk/utf-16le/utf-16be each exit 1 — a real
  // verdict, but about a different READING of the file, and none of them can
  // speak for the rows the truncated run lost. Nothing was refused, so the old
  // gate stayed silent and the union came out empty: `Found 0 matches`, while
  // the same corpus under an ASCII pattern fails loudly on pass 1. The threshold
  // is corpus size alone (about 65000 matching lines here), so this is a wide
  // search's ordinary outcome rather than a corner case.
  //
  // Narrow on purpose: `refused === 0` leaves the registered mixed disposition
  // (a truncated run beside a refused one) alone, and `out.length === 0` leaves
  // every sweep that answered with rows alone — a hit beside a truncated sibling
  // stands exactly as a hit beside a refused one. Only the empty union, the one
  // answer that must never be a guess, becomes a failure.
  if (out.length === 0 && refused === 0 && truncated > 0) {
    throw stdoutOverflow(capsOf(kit).rawOutputMaxBytes);
  }
  return out;
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
      // A TIE is refused, and the row is dropped, because nothing available can
      // tell which of the file's two readings is the text. The two passes are
      // both wrong about a legacy page's file, so "which pass matched" is not
      // evidence about the file — see the note above `utf16ByteOrder`.
      if (order === "tied") continue;
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
 * `tied` is a file whose NULs sit at both parities — its two readings are
 * byte-swaps of each other, both well-formed, and which of them is the text is
 * not decidable from the bytes. The gate refuses both.
 *
 * @param bytes - the file's bytes, or as much of them as were read.
 */
function utf16ByteOrder(bytes: Uint8Array): Utf16Order {
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
  if (odd > 0 && even === 0) return "utf16le";
  if (even > 0 && odd === 0) return "utf16be";
  // Neither parity wins, which is a genuine tie: the file is UTF-16-shaped but
  // its order is a coin toss, and the caller refuses it rather than guessing.
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
 * Read one file's bytes and report the byte order they are consistent with.
 *
 * A failure to read is `not-text`, which the caller treats exactly like "this is
 * not a UTF-16 file": this pass simply does not report the file. That is
 * deliberate — the file is still covered by the default pass and by pass 2, so
 * an unreadable file must not become a failed search.
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
    return utf16ByteOrder(await ctx.fs.readBytes(target, exec.signal, cap));
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
      if (needsTranscodedSearch(input.pattern)) {
        // The candidate list is the deployment's guess set PLUS the Unicode
        // encodings, which `supportedEncodings` deliberately leaves out: that
        // list exists to bound the GUESSING heuristic, where a UTF-16 page would
        // compete with the legacy pages on every file. Here the question is
        // different — which pages could hold these bytes at all — and omitting
        // UTF-16 would miss a BOM-less UTF-16 file entirely. Measured: ripgrep's
        // own BOM sniffing finds a marked UTF-16 file, but `--encoding=utf-16le`
        // is required for an unmarked one.
        const candidates = [...config.supportedEncodings, ...UNICODE_SEARCH_ENCODINGS];
        const legacy = encodingsForPattern(input.pattern, candidates);
        const transcoded = await searchByTranscoding(
          kit,
          ctx,
          subprocess,
          exec,
          input,
          ["utf8", ...legacy],
          workdir,
        );
        // UTF-32 cannot be reached through ripgrep's encoding support at all, so
        // it is found by its BOM and searched in JavaScript.
        //
        // Appended one by one rather than spread: the count is the UTF-32 matches
        // across every file searched, and V8 rejects a call with too many — the
        // same limit as the per-file sites above, reached here by a DIRECTORY of
        // large UTF-32 files, so a single modest file per tree is enough to trip
        // it. See `searchUndecodedFiles`.
        const utf32 = await searchUtf32Files(kit, ctx, subprocess, exec, input, config, workdir);
        for (const match of utf32) transcoded.push(match);
        const matches: GrepMatch[] = mergeMatches([transcoded]).map((match) => ({
          path: match.path,
          lineNumber: match.lineNumber,
          line: match.line,
        }));
        return finishSearch(kit, ctx, exec, matches);
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

      const files = filesNeedingDecoding(raw);

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

      if (files.length === 0) {
        // UTF-16 needs the same treatment as UTF-32 for a different reason:
        // ripgrep finds such a file only when its BOM sniffing fires, so a
        // BOM-less one is missed entirely. See `searchUnicodeFiles`.
        const unicode = await searchUnicodeFiles(
          kit,
          ctx,
          subprocess,
          exec,
          input,
          config,
          workdir,
          owned,
        );
        const matches: GrepMatch[] = mergeMatches([pass1, unicode, utf32]).map((match) => ({
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

      const unicode = await searchUnicodeFiles(
        kit,
        ctx,
        subprocess,
        exec,
        input,
        config,
        workdir,
        owned,
      );

      const merged = mergeMatches([pass1, second.matches, unicode, utf32]);
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
const UNICODE_SEARCH_ENCODINGS = ["utf16le", "utf16be"] as const;

/**
 * The byte-mode pattern that matches a UTF-32 byte-order mark.
 *
 * `(?-u)` disables ripgrep's Unicode mode, which is what allows raw byte escapes
 * at all; without it the pattern is rejected as a bad escape. Both byte orders
 * are covered because a file may be either.
 */
const UTF32_BOM_PATTERN = "(?-u)(\\xff\\xfe\\x00\\x00|\\x00\\x00\\xfe\\xff)";
