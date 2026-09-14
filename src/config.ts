/**
 * Plugin configuration — `$DSH_HOME/plugins/dsh-fs-encoding/config.yaml` with
 * `DSH_FS_ENCODING_*` environment overrides on top.
 *
 * Deliberately a flat, hand-parsed YAML subset (scalars, inline arrays) rather
 * than a YAML dependency: the file holds four keys, and a plugin that shadows
 * `read` should not add a parser to every session's boot path.
 *
 * @module dsh-fs-encoding/config
 */

import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { DEFAULT_SUPPORTED_ENCODINGS, normalizeEncoding } from "./encoding.js";

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
  /** Inclusive byte cap for a whole-file read; larger files fail loud. */
  maxFileBytes: number;
}

const DEFAULT_CONFIG: PluginConfig = {
  autoGuessEncoding: false,
  normalizeToUtf8: false,
  supportedEncodings: [...DEFAULT_SUPPORTED_ENCODINGS],
  maxFileBytes: 10 * 1024 * 1024,
};

/** Commented YAML written on first load so the file is discoverable and editable. */
export const DEFAULT_CONFIG_YAML = `# dsh-fs-encoding config
# Location: $DSH_HOME/plugins/dsh-fs-encoding/config.yaml
# Generated with defaults on first load — edit or delete freely.

# Decode a non-UTF-8 file by guessing instead of failing.
# false (default, like VS Code): fail loud with Top-3 candidates and re-read
#   with read({encoding: "gbk"}). A wrong guess is invisible and would be
#   written back under the wrong encoding, so guessing stays opt-in.
# true: auto-decode with the best-scoring allowlisted encoding.
autoGuessEncoding: false

# Migrate legacy (non-UTF-8) files to UTF-8 on their first save.
# false (default): preserve the original encoding byte-exactly on every save.
# true: rewrite as UTF-8 and remember the file as UTF-8 from then on.
normalizeToUtf8: false

# Encodings considered when guessing, and listed in the Top-3 error hint.
supportedEncodings: [gbk, big5, shift_jis, euc-kr, windows-1251, iso-8859-1]

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
    if (encs !== undefined) fromFile.supportedEncodings = encs;
    const maxBytes = Number(parsed["maxFileBytes"]);
    if (Number.isSafeInteger(maxBytes) && maxBytes > 0) fromFile.maxFileBytes = maxBytes;
  } catch {
    // ENOENT or unreadable: keep the defaults.
    fromFile = {};
  }

  cached = { ...DEFAULT_CONFIG, ...fromFile, ...env };
  cachedMtimeMs = mtime;
  cachedEnvKey = envKey;
  return cached;
}

/**
 * Materialize the commented default config when absent. Idempotent (`wx`), so a
 * concurrent boot cannot clobber a user's edits, and best-effort: a failure is
 * never fatal to the plugin.
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
