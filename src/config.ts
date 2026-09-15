/**
 * Plugin configuration — `$DSH_HOME/plugins/dsh-fs-encoding/config.yaml` with
 * `DSH_FS_ENCODING_*` environment overrides on top.
 *
 * Deliberately a flat, hand-parsed YAML subset (scalars, inline arrays) rather
 * than a YAML dependency: the file holds only scalar keys, and a plugin that
 * shadows `read` should not add a parser to every session's boot path.
 *
 * @module dsh-fs-encoding/config
 */

import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { DEFAULT_SUPPORTED_ENCODINGS, normalizeEncoding } from "./encoding.js";
import { reReadCall } from "./prompts.js";

/** Resolved, validated plugin configuration. */
export interface PluginConfig {
  /**
   * When `true`, a file that is not valid UTF-8 and carries no BOM is decoded
   * with the best-scoring allowlisted encoding instead of failing.
   *
   * Defaults to `false` (matching VS Code's `files.autoGuessEncoding`): a wrong
   * guess is invisible to the model and would then be written back under the
   * wrong encoding, so guessing stays opt-in.
   */
  autoGuessEncoding: boolean;
  /**
   * When `true`, a file in a non-Unicode code page (GBK, Big5, Shift-JIS, …) is
   * rewritten as UTF-8 on its first save, migrating it. When `false` the
   * recorded encoding is preserved byte-exactly.
   *
   * UTF-16 and UTF-32 are NOT migrated: they are already Unicode, differing only
   * in byte order, so converting them would change the storage without making
   * the file any more portable — and would break a consumer expecting UTF-16.
   */
  normalizeToUtf8: boolean;
  /** Encodings considered by `autoGuessEncoding` and listed in Top-3 hints. */
  supportedEncodings: string[];
  /**
   * Encodings removed from the default guess set, when the user did not supply a
   * full {@link supportedEncodings} list.
   *
   * This exists so that "drop one encoding" does not force a user to write out
   * the whole list. Writing the list out would freeze today's set into the config
   * file, which is exactly what the commented-out default avoids: a later release
   * could no longer reach that deployment. A subtraction keeps the "follow the
   * shipped default, minus these" relationship, so additions still arrive.
   *
   * Ignored when `supportedEncodings` is set explicitly — an explicit list is
   * the user's whole answer, and subtracting from it would be second-guessing.
   *
   * Config-file only: there is deliberately no environment counterpart. The
   * environment names a whole set, so an env-level exclusion list would have no
   * coherent meaning when the file supplies the list instead.
   */
  excludeEncodings: string[];
  /** Inclusive byte cap for a whole-file read; larger files fail loud. */
  maxFileBytes: number;
}

const DEFAULT_CONFIG: PluginConfig = {
  autoGuessEncoding: false,
  normalizeToUtf8: false,
  supportedEncodings: [...DEFAULT_SUPPORTED_ENCODINGS],
  excludeEncodings: [],
  maxFileBytes: 10 * 1024 * 1024,
};

/** Commented YAML written on first load so the file is discoverable and editable. */
export const DEFAULT_CONFIG_YAML = `# dsh-fs-encoding config
# Location: $DSH_HOME/plugins/dsh-fs-encoding/config.yaml
# Generated with defaults on first load — edit or delete freely.

# Decode a non-UTF-8 file by guessing instead of failing.
# false (default, like VS Code): fail loud with Top-3 candidates and re-read
#   with ${reReadCall("gbk")}. A wrong guess is invisible and
#   would be written back under the wrong encoding, so guessing stays opt-in.
# true: auto-decode with the best-scoring allowlisted encoding.
autoGuessEncoding: false

# Migrate legacy (non-UTF-8) files to UTF-8 on their first save.
# false (default): preserve the original encoding byte-exactly on every save.
# true: rewrite as UTF-8 and remember the file as UTF-8 from then on.
normalizeToUtf8: false

# Encodings considered when guessing, and listed in the Top-3 error hint.
#
# To CHANGE the set, prefer excludeEncodings below — it keeps following this
# plugin's default, so encodings added in a later release still reach you.
#
# Setting this key REPLACES the default set entirely and freezes it into this
# file: a later release that adds an encoding will not reach you. Uncomment only
# when you want a set of your own. The current default is:
# supportedEncodings: [${DEFAULT_SUPPORTED_ENCODINGS.join(", ")}]

# Encodings to REMOVE from the default guess set. Applies only while
# supportedEncodings is left unset (an explicit list above is used verbatim).
# Config-file only: there is no environment variable for this key.
# Example — drop windows-1251, which mis-reads Western text as Cyrillic:
# excludeEncodings: [windows-1251]

# Inclusive byte cap for reading a whole file into memory (default 10485760 = 10 MiB).
maxFileBytes: 10485760
`;

/** Directory holding this plugin's shared home (config, caches). */
export function configDir(): string {
  return join(resolveDshHome(), "plugins", "dsh-fs-encoding");
}

function configYamlPath(): string {
  return join(configDir(), "config.yaml");
}

/** Parse the flat YAML subset this plugin writes: `key: value` and `key: [a, b]`. */
function parseSimpleYaml(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    const hash = value.indexOf(" #");
    if (hash !== -1) value = value.slice(0, hash).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const t = value.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  return undefined;
}

function parseEncodings(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[ ,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (items.length === 0) return undefined;
  // Keep only names this plugin can actually decode; a typo in the allowlist
  // must not turn into a silent no-candidate guess.
  const valid = items.filter((s) => normalizeEncoding(s) !== undefined);
  return valid.length > 0 ? valid : undefined;
}

/**
 * Parse an exclusion list into canonical names.
 *
 * Unlike {@link parseEncodings} an empty result is meaningful — "exclude
 * nothing" — so a value that parses to nothing yields an empty array rather than
 * `undefined`, and the caller is not left guessing whether the key was absent.
 *
 * @param value - the raw value from the config file.
 * @returns canonical encoding names to remove, possibly empty.
 */
function parseExclusions(value: string | undefined): string[] {
  if (value === undefined) return [];
  const names: string[] = [];
  for (const item of value.replace(/^\[/, "").replace(/\]$/, "").split(/[ ,;]+/)) {
    const canonical = normalizeEncoding(item.trim());
    if (canonical !== undefined && !names.includes(canonical)) names.push(canonical);
  }
  return names;
}

/**
 * Apply {@link PluginConfig.excludeEncodings} to a guess set.
 *
 * Both sides are canonicalized before comparing. `excluded` is canonical (see
 * {@link parseExclusions}); `encodings` is the shipped default, which is
 * canonical too — an environment list never reaches here, because it takes the
 * `overridden` branch in {@link loadConfig}. The `normalizeEncoding` on the left
 * is therefore an identity today, kept so a future caller passing an operator's
 * own spelling still compares correctly. A plain string comparison would
 * silently ignore an exclusion written as `cp1251` or `sjis`.
 *
 * A subtraction may legitimately empty the list (a user could exclude every
 * default), but an empty guess set would make the plugin useless with no
 * explanation, so the exclusions are dropped and the full set is kept instead —
 * a config mistake must not silently disable guessing altogether.
 *
 * @param encodings - the set to subtract from.
 * @param excluded - canonical names to remove.
 * @returns the reduced set, or the original when the reduction would empty it.
 */
function applyExclusions(encodings: readonly string[], excluded: readonly string[]): string[] {
  if (excluded.length === 0) return [...encodings];
  const dropped = new Set(excluded);
  const reduced = encodings.filter((enc) => !dropped.has(normalizeEncoding(enc) ?? enc));
  return reduced.length > 0 ? reduced : [...encodings];
}

let cached: PluginConfig | undefined;
let cachedMtimeMs: number | undefined;
let cachedEnvKey: string | undefined;

function envOverrides(): Partial<PluginConfig> {
  const out: Partial<PluginConfig> = {};
  const guess = parseBool(process.env["DSH_FS_ENCODING_AUTO_GUESS"]);
  if (guess !== undefined) out.autoGuessEncoding = guess;
  const norm = parseBool(process.env["DSH_FS_ENCODING_NORMALIZE_TO_UTF8"]);
  if (norm !== undefined) out.normalizeToUtf8 = norm;
  const encs = parseEncodings(process.env["DSH_FS_ENCODING_SUPPORTED_ENCODINGS"]);
  if (encs !== undefined) out.supportedEncodings = encs;
  const maxBytes = Number(process.env["DSH_FS_ENCODING_MAX_FILE_BYTES"]);
  if (Number.isSafeInteger(maxBytes) && maxBytes > 0) out.maxFileBytes = maxBytes;
  return out;
}

/**
 * Load the effective configuration, cached by config-file mtime and by the
 * environment values that participate.
 *
 * A malformed or unreadable config file degrades to the defaults rather than
 * failing a tool call — the file is a convenience, not a contract.
 *
 * `supportedEncodings` is intentionally absent from the generated config, so
 * "not set" means "whatever this version ships". A key that IS present wins,
 * which is what makes an explicit choice stick. There is no migration step and
 * none is needed: adding an encoding in a later release reaches every deployment
 * that never overrode the list, and never touches a deployment that did.
 *
 * @returns the merged, validated configuration.
 */
export function loadConfig(): PluginConfig {
  const path = configYamlPath();
  let mtime: number | undefined;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // No config file — defaults plus environment.
  }

  const env = envOverrides();
  const envKey = JSON.stringify(env);
  if (cached !== undefined && cachedMtimeMs === mtime && cachedEnvKey === envKey) return cached;

  let fromFile: Partial<PluginConfig> = {};
  try {
    const parsed = parseSimpleYaml(readFileSync(path, "utf-8"));
    const guess = parseBool(parsed["autoGuessEncoding"]);
    if (guess !== undefined) fromFile.autoGuessEncoding = guess;
    const norm = parseBool(parsed["normalizeToUtf8"]);
    if (norm !== undefined) fromFile.normalizeToUtf8 = norm;
    const encs = parseEncodings(parsed["supportedEncodings"]);
    // Only an EXPLICIT list overrides the shipped default. A missing key (the
    // generated template comments it out) leaves the default in force, so a later
    // release can extend the set without touching anyone's config. A list that IS
    // written out is the user's answer and is used verbatim — there is no attempt
    // to guess whether it was chosen or merely inherited from an older template.
    if (encs !== undefined) fromFile.supportedEncodings = encs;
    const excluded = parseExclusions(parsed["excludeEncodings"]);
    if (excluded.length > 0) fromFile.excludeEncodings = excluded;
    const maxBytes = Number(parsed["maxFileBytes"]);
    if (Number.isSafeInteger(maxBytes) && maxBytes > 0) fromFile.maxFileBytes = maxBytes;
  } catch {
    // ENOENT or unreadable: keep the defaults.
    fromFile = {};
  }

  const merged = { ...DEFAULT_CONFIG, ...fromFile, ...env };
  // Precedence for the guess set, highest first:
  //   1. DSH_FS_ENCODING_SUPPORTED_ENCODINGS — the operator named the whole set,
  //      so nothing in the file may narrow it. (`excludeEncodings` has no
  //      environment counterpart, so there is no env-vs-env case to resolve.)
  //   2. an explicit list in the config file — the user's whole answer, used
  //      verbatim (no subtraction; that would second-guess their choice).
  //   3. the shipped default, minus the file's excludeEncodings.
  // Reading `fromFile` alone here used to make the file beat the environment,
  // silently ignoring the override.
  const overridden = env.supportedEncodings !== undefined;
  const explicit = overridden ? undefined : fromFile.supportedEncodings;
  cached = {
    ...merged,
    supportedEncodings:
      explicit !== undefined
        ? [...explicit]
        : overridden
          ? [...merged.supportedEncodings]
          : applyExclusions(merged.supportedEncodings, merged.excludeEncodings),
  };
  cachedMtimeMs = mtime;
  cachedEnvKey = envKey;
  return cached;
}

/**
 * Materialize the commented default config when absent.
 *
 * Idempotent (`wx`), so a concurrent boot cannot clobber a user's edits, and
 * best-effort: a failure is never fatal to the plugin.
 *
 * An existing file is NEVER rewritten. An earlier revision tried to "retire" a
 * `supportedEncodings` line inherited from an older template, which meant
 * reading the user's file as UTF-8 and writing it back — that silently transcoded
 * a non-UTF-8 config to replacement characters, converted its CRLF line endings
 * to LF, and, when the value happened to be truncated to a template default,
 * deleted an encoding the user had added. Nothing in this file is worth that
 * risk: the plugin works from compiled defaults, and the template now ships the
 * key commented out, so a fresh install never pins the set in the first place.
 */
export async function ensureDefaultConfig(): Promise<void> {
  const dir = configDir();
  const path = join(dir, "config.yaml");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, DEFAULT_CONFIG_YAML, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    // Best-effort: the plugin works with compiled defaults.
  }
}

/** Drop the memoized configuration. Test seam. */
export function resetConfigCache(): void {
  cached = undefined;
  cachedMtimeMs = undefined;
  cachedEnvKey = undefined;
}
