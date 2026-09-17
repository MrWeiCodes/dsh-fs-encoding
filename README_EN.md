# dsh-fs-encoding — File Encoding Guardian for DSH

> A file-encoding governance plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): stop the AI from wrecking BOMs and multi-byte encodings when it reads and writes files

**🌏 [中文](README.md) | English**

`dsh` · `dsh-plugin` · `plugin` · `encoding` · `BOM` · `GBK` · `Big5` · `Shift-JIS` · `UTF-16` · `AI agent` · `编码` · `文件编码` · `乱码`

<!-- keywords: dsh, dsh-plugin, deepseek harness, plugin, encoding, bom, gbk, big5, shift-jis, utf-16, ai agent, 编码, 文件编码, 乱码 -->

## Introduction

DSH's built-in `read` / `write` / `edit` tools **only understand UTF-8**, which breaks down on the encodings common in Chinese, Japanese and Korean projects:

- **GBK, Big5 and Shift-JIS files simply cannot be read** — they fail with `invalid UTF-8 text` and the AI is left staring at an error;
- **UTF-8 files with a BOM can be read, but the BOM is silently swallowed** — one casual edit and those first three bytes are gone. For PHP, older compilers and some Windows software, a missing BOM can mean a parse error or garbled output;
- Worse, **there is no warning at all**: you find out the file is broken days later, with no idea which edit did it.

This plugin takes over those three tools and, while **preserving every existing behaviour** (sandbox fence, read-before-write protection, version checking, diff display), makes non-UTF-8 files and BOMs round-trip correctly: **whatever encoding a file had, it still has after the edit.**

## Features

- **Byte-exact preservation**: a file's encoding is decided once, at first read, and inverted on every save. Edit a GBK file and it is still a GBK file — never quietly converted to UTF-8.
- **BOM fidelity**: a BOM is restored exactly when the file had one, and never invented for a file that did not — correct in both directions.
- **Line-ending fidelity**: CRLF / LF / CR are detected at read and restored on save, so Windows projects are not rewritten to LF.
- **No silent corruption**: if the target encoding cannot represent the new content (an emoji in a GBK file), the plugin **refuses the write** and explains why, leaving the file untouched — instead of filling it with `?` and destroying it.
- **It tells you what to do when it cannot read**: for a non-UTF-8 file, the plugin lists the most likely encodings with a sample decode of each, so the AI (or you) can pick one and re-read — like VS Code's "Reopen with Encoding".
- **Nineteen encodings**: UTF-8 (with BOM), UTF-16, UTF-32, plus GBK, Big5, Shift-JIS, EUC-KR and the full Windows-125x family (Western, Central European, Cyrillic, Greek, Turkish, Hebrew, Arabic, Baltic).
- **Zero learning curve**: arguments and output format are identical to the built-ins — these are **drop-in replacements**, so existing prompts and habits keep working; `read` and `write` each gain one optional `encoding` argument (the one on `write` applies to new files only, see below).
- **Create files in a chosen encoding**: one `encoding` argument on `write` produces a GBK, Shift-JIS or other legacy-encoded file directly — no writing UTF-8 and converting afterwards.
- **Simple configuration**: one YAML file with a few switches, all overridable by environment variables.

## Usage

The three tools work exactly as the built-ins; `read` and `write` each gain one optional argument:

```
read({ file_path: "legacy.txt", encoding: "gbk" })
```

Without `encoding`, the plugin auto-detects UTF-8 files, UTF-16 / UTF-32 files that carry a BOM, and the BOM itself; **only a non-UTF-8 file without a BOM** makes it stop and ask, listing candidates:

```
[E_NOT_TEXT] legacy.txt is not valid UTF-8. Most likely gbk. Re-read with
read({ file_path: "legacy.txt", encoding: "gbk" }) to decode it, or set
autoGuessEncoding: true in the plugin config to decode automatically.
Candidates: gbk("你好，世界"), big5("斕疑"), shift_jis("ﾄ羲")
```

Re-read with the call shown in the message and the encoding turns from a guess into a known fact that every later save follows.

> **UTF-16 / UTF-32 files without a BOM** work the same way — specify explicitly with `read({ file_path: "<path>", encoding: "utf16le" })`. Such files are rare on Windows, and without a BOM the byte order cannot be reliably detected, so the plugin does not guess.

> **Why does it ask by default?** GBK, Big5 and Shift-JIS byte ranges overlap on short inputs, so a wrong guess is invisible in the UI — and would then be **written back under the wrong encoding**, ruining the file. The plugin therefore prefers "fail rather than guess wrong". If you would rather have best-effort decoding, set `autoGuessEncoding: true`.
>
> Even with `autoGuessEncoding` on, one case still fails loudly with the candidate list: a **very short** file (a few bytes) where two independent detectors name **different** pages. Nothing then distinguishes them — measured, the top pick is wrong about 79% of the time in that case — so the plugin lets you choose from the candidates instead of gambling for you. When both detectors name the **same** page it is adopted directly, and files of any ordinary length (tens of bytes and up) effectively never hit this.
>
> A second case that fails loudly: a detector names a **single-byte page** such as ISO-8859-1 or Windows-1252, but decoding with it yields text that is **almost entirely non-ASCII**. Real Western text is mostly letters and spaces, so it does not look like that — whereas 2-byte CJK, Korean or Cyrillic text read as a single-byte page turns every character into two Latin ones, which is exactly that shape. The plugin refuses the verdict and lists candidates instead. Measured, this catches 24 files that would otherwise be silently mis-read, and refuses **none** that previously read correctly.

### Creating a file in a chosen encoding

A new file is UTF-8 without a BOM by default. To generate a GBK file for a legacy system, add `encoding`:

```
write({ file_path: "run.bat", content: "echo 中文\r\n", encoding: "gbk" })
```

The accepted names are the same as `read`'s, and aliases and case are insensitive (`cp936`, `Shift-JIS` both work). Names that carry a BOM (`utf8bom`, `utf16le`, `utf16be`, `utf32le`, `utf32be`) write it; every other name writes none. Content the encoding cannot represent is **refused**, never written as `?`.

> **`encoding` applies to new files only.** Passing it for an existing file fails with `E_ENCODING_NOT_APPLICABLE` instead of converting — preserving a file's encoding is this plugin's core promise, and a conversion rewrites every character of the file in a way the AI cannot see from the reply. **Do not delete the file to force a conversion**: deleting bypasses the read-before-write gate, so content the session never read disappears silently behind a `before: null`, and if the session *had* read the file, every later write fails `FS_STALE_VERSION` and the path cannot be recreated for the rest of the session. This plugin does not convert encodings; when you need a copy in another encoding, write it to a **new path**.

## Installation

> **⚠️ Conflict**: **any** plugin that registers `read` / `write` / `edit` on the same scope layer is mutually exclusive with this one — registering a name twice in a layer throws, so only one such plugin can be enabled.
>
> If those three names are already held by another plugin **on the same layer**, the install is refused with the offending tool named, rather than leaving a half-registered tool set. To resolve it, either remove this plugin from the profile or disable the plugin that holds the name:
>
> ```yaml
> # in the profile's cordis.patch.yml
> - id: <the other plugin's id>
>   disabled: true
> ```
>
> Note: the built-in `read` / `write` / `edit` live on an outer host/preset layer and are **not** a conflict — shadowing them on the agent's own layer is exactly what this plugin does, matching how the native tools shadow each other.

### Option 1: let the AI install (easiest)

Just give your DSH AI assistant the repository URL, e.g. "install the plugin https://github.com/MrWeiCodes/dsh-fs-encoding". The AI handles plugin loading, dependencies and the patch for you; then restart `dsh web`.

### Option 2: install from npm (recommended)

```powershell
dsh plugin --profile web add dsh-fs-encoding
```

**Why this is the recommended path**: the npm package already ships the compiled `lib/`, so the install runs no build scripts at all — unaffected by pnpm's build-script gate, and independent of your local build environment. Then restart `dsh web`.

### Option 3: install from GitHub

```powershell
dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
```

A GitHub install fetches the sources, so `lib/` is compiled on the spot by the `prepare` script — which means **you may need to allow build scripts** in the profile's `pnpm-workspace.yaml` (pnpm 10 and later blocks dependency build scripts by default; paste the line it prints and re-run). **If you would rather skip that, use Option 2** — the npm package already contains the compiled output and has no such step.

> **Known issue with local-directory installs**: on Windows, if the plugin directory and the profile are on **different drives** (e.g. plugin on `G:\`, profile on `C:\`), pnpm mis-resolves the `file:` dependency to `C:\Users\<username>\...` and the install fails. Use **Option 4** instead.

### Option 4: manual installation

Fallback for environments without pnpm or for offline use:

1. Clone this repository into your DSH profile's plugin directory and build it once there (the `prepare` script generates `lib/`):
   ```powershell
   # example: web profile
   $dst = "$HOME\.dsh\profiles\web\packages\dsh-fs-encoding"
   git clone https://github.com/MrWeiCodes/dsh-fs-encoding.git $dst
   cd $dst
   npm install      # also triggers prepare → generates lib/
   ```
2. Add to the `dependencies` of the profile's `package.json`:
   ```json
   "dsh-fs-encoding": "file:./packages/dsh-fs-encoding"
   ```
3. Append the contents of `cordis.patch.yml` to your profile's `cordis.patch.yml`.
4. Reinstall dependencies and restart: `pnpm install` (or `npm install`), then `dsh web`.

## Updating

- **Installed via Option 1 (AI)**: just tell your AI assistant "update the dsh-fs-encoding plugin".
- **Installed via Option 2 (npm)**:
  ```powershell
  dsh plugin --profile web add dsh-fs-encoding@latest
  ```
  Then restart `dsh web`. The npm path involves no build step either.
- **Installed via Option 3 (GitHub)**:
  ```powershell
  dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
  ```
  If the latest commit is not fetched (git dependencies are cached), remove and re-add:
  ```powershell
  dsh plugin --profile web remove dsh-fs-encoding
  dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
  ```
  Then restart `dsh web`. **The commit hash changes with the new commit**, so if pnpm asks you to allow build scripts again, redo the step described under Option 3.
- **Installed via Option 4 (manual)**:
  ```powershell
  cd "$HOME\.dsh\profiles\web\packages\dsh-fs-encoding"
  git pull            # or re-copy the new version over the old files
  npm install         # run if dependency declarations changed; also re-runs prepare
  ```
  Then restart `dsh web`.

Your configuration (`$DSH_HOME/plugins/dsh-fs-encoding/config.yaml`) is preserved across updates.

## Uninstallation

### Installed via Option 1 (AI): let the AI uninstall

Just tell your AI assistant "uninstall the dsh-fs-encoding plugin"; the AI removes the plugin and cleans up the patch and dependencies.

### Installed via Option 2 (npm) / Option 3 (GitHub)

```powershell
dsh plugin --profile web remove dsh-fs-encoding
```

Then restart `dsh web`. The built-in `read` / `write` / `edit` come back immediately — nothing else to do.

### Installed via Option 4 (manual)

1. Remove this plugin's `insert` row from your profile's `cordis.patch.yml`.
2. Remove `"dsh-fs-encoding": ...` from the `dependencies` of the profile's `package.json`.
3. Reinstall dependencies and restart: `pnpm install` (or `npm install`), then `dsh web`.

### Leftover locations (cleanup checklist for the AI)

- **Config directory**: `$DSH_HOME/plugins/dsh-fs-encoding/` — `$DSH_HOME` defaults to `~/.dsh` (`C:\Users\<username>\.dsh` on Windows); the plugin's `config.yaml` lives here. Uninstallation does not delete it automatically; delete the whole directory manually for a complete cleanup.
- **Plugin directory** (Option 4 installs): `$DSH_HOME/profiles/<profile>/packages/dsh-fs-encoding/`.
- **Dependency & patch** (Option 4 installs): the `"dsh-fs-encoding": ...` dependency in the profile's `package.json`, and the `insert` row in `cordis.patch.yml`.
- No global registry, npm global packages, or system-level writes; the plugin writes no events of its own into session logs.

## Configuration

**The defaults work — you normally do not need to touch this.** Only change it to adjust how encoding *guessing* behaves.

Config file location (created automatically on first start, with full comments inside):

```
$DSH_HOME/plugins/dsh-fs-encoding/config.yaml
```

### All options

| Option | Default | What it does |
|---|---|---|
| `autoGuessEncoding` | `false` | On an unreadable non-UTF-8 file: guess, or fail and let you choose |
| `normalizeToUtf8` | `false` | Whether saving converts legacy files (GBK, …) **to UTF-8** |
| `supportedEncodings` | built-in list | The encodings considered by **automatic guessing** |
| `excludeEncodings` | empty | **Remove** a few encodings from the built-in list |
| `maxFileBytes` | 10 MiB | Read size limit for a single file |

### Common needs (copy and paste)

**Let it guess instead of asking every time**

```yaml
autoGuessEncoding: true
```

**Be done with encoding problems for good** (a GBK file becomes UTF-8 after its first save)

```yaml
normalizeToUtf8: true
```

**One encoding keeps guessing wrong** (e.g. Cyrillic stealing Western text)

```yaml
excludeEncodings: [windows-1251]
```

### The encoding list: what the two keys do

The plugin ships a built-in list used for **automatic guessing**. You can subtract from it, or replace it wholesale:

| What you want | Which key | When the plugin adds an encoding later |
|---|---|---|
| Just drop one or two | `excludeEncodings` | ✅ You get it automatically |
| Use a list of your own | `supportedEncodings` | ❌ You will not receive it |

**Why `excludeEncodings` is the better default**: writing `supportedEncodings` **freezes** the list into your config file — encodings added in a later release will never reach you, and the plugin will not change it back for you (it never modifies an existing config).

> **The list only affects *guessing*, not *reading*.** Any encoding can be read by naming it explicitly, even when it is not on the list:
>
> ```
> read({ file_path: "legacy.txt", encoding: "windows-1253" })
> ```

### Environment variables

Useful for a quick test or a container deployment. **An environment override always wins over the config file**:

| Variable | Option |
|---|---|
| `DSH_FS_ENCODING_AUTO_GUESS` | `autoGuessEncoding` |
| `DSH_FS_ENCODING_NORMALIZE_TO_UTF8` | `normalizeToUtf8` |
| `DSH_FS_ENCODING_SUPPORTED_ENCODINGS` | `supportedEncodings` |
| `DSH_FS_ENCODING_MAX_FILE_BYTES` | `maxFileBytes` |

`excludeEncodings` has **no** environment variable — it is the only option that lives in the config file alone.

> **`normalizeToUtf8` does not convert UTF-16 / UTF-32 files**: they are already Unicode, and re-encoding them would break programs that depend on them.

## Supported encodings

| Kind | Encodings |
|---|---|
| Unicode | `utf8`, `utf8bom`, `utf16le`, `utf16be`, `utf32le`, `utf32be` |
| East Asian | `gbk` (incl. `gb18030`, `gb2312`, `cp936`), `big5` (incl. `cp950`), `shift_jis` (incl. `sjis`, `cp932`), `euc-kr` (incl. `cp949`) |
| Windows ANSI | `windows-1250` (Central European), `windows-1251` (Cyrillic), `windows-1252` (Western), `windows-1253` (Greek), `windows-1254` (Turkish), `windows-1255` (Hebrew), `windows-1256` (Arabic), `windows-1257` (Baltic) — each also accepted as `cp12xx` |
| Other | `iso-8859-1` (incl. `latin1`) |

> **On `windows-1258` (Vietnamese)**: not supported. Vietnamese needs combining sequences — `ế` is one code point but two bytes — and the underlying `iconv-lite` single-byte table cannot split them, so 52 of 67 common Vietnamese characters encode to `?`. Offering it would let a file be read but almost never saved, which reads as a bug rather than a limitation, so the name is deliberately absent.

> **This table is what can be *read and written*, not what gets *guessed*.** Automatic guessing uses only the short list in the config (7 encodings by default) — a small set keeps the wrong-guess rate down. Everything else in the table still works when named explicitly: `read({ file_path: "x.txt", encoding: "windows-1253" })`. See [Configuration](#configuration) for how to adjust the list.

Names are case- and style-insensitive: `Shift-JIS`, `shift_jis` and `SJIS` all mean the same encoding.

## Common errors

| Error | Meaning and fix |
|---|---|
| `E_NOT_TEXT` | Not valid UTF-8 and no BOM. Re-read with `read({ file_path: "...", encoding: "..." })` as suggested, or enable `autoGuessEncoding`. |
| `E_UNMAPPABLE` | The target encoding cannot represent the new content (an emoji in a GBK file). **The file was not modified** — switch to an encoding that can, or migrate with `normalizeToUtf8` (that migration applies to an **existing** file only; for a new file just name a different encoding). |
| `E_BAD_ENCODING` | Unknown encoding name; use one from the table above. |
| `E_ENCODING_NOT_APPLICABLE` | `encoding` was passed to `write` for a file that **already exists**. The argument applies to new files only; the file keeps its own encoding and nothing was changed. This plugin does **not** convert encodings — do not delete the file to force one (see above); write a copy to a new path instead. |
| `E_DECODE_FAILED` | The bytes do not decode under the requested encoding — the encoding is probably wrong; try another candidate. |
| `FS_STALE_VERSION` | The file changed after it was read (or was deleted). Read it again before editing, to avoid clobbering someone else's change. |
| `FS_NOT_OBSERVED` | This session has no encoding record for the file, so it cannot be rewritten: an **existing** file that was not read this session (or whose record was reclaimed) is refused rather than re-encoded as UTF-8. Read it once before writing; if it is not a text file, this plugin cannot rewrite it. Creating a new file is unaffected. |
| `FS_EDIT_NOT_FOUND` | The `old_string` to replace was not found; check the content and indentation. |
| `FS_AMBIGUOUS_EDIT` | `old_string` matched more than once. Add surrounding context to make it unique, or set `replace_all: true`. |
| `FS_SANDBOX_DENIED` | Refused by DSH's sandbox (e.g. writing outside the workspace) — the existing safety policy at work. |

## Compatibility & conflicts

- **Zero-intrusion**: the plugin only uses DSH's public interfaces to register tools; it does **not** modify native DSH code and does not replace the `ctx.fs` filesystem itself. Uninstalling restores the built-in tools immediately, leaving nothing behind.
- **Every existing guarantee is kept**: sandbox fence, read-before-write protection, version checking and observation records all behave exactly as before — anything that should be blocked or questioned still is.
- **Mutually exclusive with any plugin registering the same tool names**: this plugin registers `read` / `write` / `edit` on the scope layer, and registering a name twice in a layer throws, so only one such plugin can be active at a time. The test is whether those three names are already occupied **on that agent's own layer**, regardless of who occupies them — on a collision it refuses to install and names the occupied tool (see Installation above). Built-ins on a host/preset layer are not a collision.
- **Session state**: encoding information is kept in memory and isolated per session — never written to disk, never polluting your repository. After a DSH restart, the encoding is detected afresh on the first read.

## Development

```powershell
npm install
npm run typecheck   # tsc --noEmit for src and test
npm test            # run the test suite
npm run build       # src/ → lib/
```

The suite covers the encoding algorithms themselves and drives the real filesystem and sandbox components for integration cases, including byte-exact round-trips for every supported encoding, BOM / CRLF fidelity, unmappable-character refusal, stale-write rejection and the sandbox fence.

To customize the plugin, use DSH's Creator mode for quick development.

## Roadmap

Phase 2 (not yet implemented): `undo_last_edit` and `str_replace_editor`.

## License

[MIT](LICENSE)
