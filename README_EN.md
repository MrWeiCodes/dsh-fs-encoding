# dsh-fs-encoding — File Encoding Guardian for DSH

> A file-encoding governance plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): stop the AI from wrecking BOMs and multi-byte encodings when it reads and writes files

**Repository**: https://github.com/MrWeiCodes/dsh-fs-encoding

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
- **Twelve encodings**: UTF-8 (with BOM), UTF-16, UTF-32, plus common code pages such as GBK, Big5, Shift-JIS, EUC-KR, Windows-1251 and ISO-8859-1.
- **Zero learning curve**: arguments and output format are identical to the built-ins — these are **drop-in replacements**, so existing prompts and habits keep working; `read` merely gains one optional `encoding` argument.
- **Simple configuration**: one YAML file with four switches, all overridable by environment variables.

## Usage

The three tools work exactly as the built-ins; `read` gains one optional argument:

```
read({ file_path: "legacy.txt", encoding: "gbk" })
```

Without `encoding`, the plugin auto-detects UTF-8 files, UTF-16 / UTF-32 files that carry a BOM, and the BOM itself; **only a non-UTF-8 file without a BOM** makes it stop and ask, listing candidates:

```
[E_NOT_TEXT] legacy.txt is not valid UTF-8. Most likely gbk. Re-read with
read({ encoding: "gbk" }) to decode it, or set autoGuessEncoding: true in the
plugin config to decode automatically.
Candidates: gbk("你好，世界"), big5("斕疑"), shift_jis("ﾄ羲")
```

Re-read with the call shown in the message and the encoding turns from a guess into a known fact that every later save follows.

> **UTF-16 / UTF-32 files without a BOM** work the same way — specify explicitly with `read({ encoding: "utf16le" })`. Such files are rare on Windows, and without a BOM the byte order cannot be reliably detected, so the plugin does not guess.

> **Why does it ask by default?** GBK, Big5 and Shift-JIS byte ranges overlap on short inputs, so a wrong guess is invisible in the UI — and would then be **written back under the wrong encoding**, ruining the file. The plugin therefore prefers "fail rather than guess wrong". If you would rather have best-effort decoding, set `autoGuessEncoding: true`.

## Installation

### Option 1: let the AI install (easiest)

Just give your DSH AI assistant the repository URL, e.g. "install the plugin https://github.com/MrWeiCodes/dsh-fs-encoding". The AI handles plugin loading, dependencies and the patch for you; then restart `dsh web`.

> **⚠️ Conflict**: this plugin and `dsh-better-edit` both register `read` / `write` / `edit` on the same layer, so **only one of them can be enabled**. If you have `dsh-better-edit`, disable it in your profile's `cordis.patch.yml`:
>
> ```yaml
> - id: dsh-better-edit
>   disabled: true
> ```
>
> The plugin detects this conflict at boot and reports it with an actionable message rather than leaving a half-registered tool set.

### Option 2: one-liner (self-service)

```powershell
dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
```

> **⚠️ The first install needs build scripts allowed.** This is a TypeScript project, and `lib/` is produced by the `prepare` script. For safety, pnpm 10 **blocks dependency build scripts by default**, so the first install fails and prints a message containing a full identifier with a commit hash (it changes on every commit, so it cannot be pre-written in this document).
>
> Follow the printed instruction:
>
> 1. Open `pnpm-workspace.yaml` in your profile directory (create it if absent) and paste the printed line verbatim:
>
>    ```yaml
>    onlyBuiltDependencies:
>      - "dsh-fs-encoding@git+https://github.com/MrWeiCodes/dsh-fs-encoding.git#<commit-hash-from-the-message>"
>    ```
>
> 2. Re-run the `dsh plugin add` command above.
>
> This is pnpm 10's blanket security policy for all git dependencies (it prevents arbitrary code execution at install time), not something specific to this plugin. If you would rather not allow build scripts, use **Option 3: manual installation**.
>
> **Known issue with local-directory installs**: on Windows, if the plugin directory and the profile are on **different drives** (e.g. plugin on `G:\`, profile on `C:\`), pnpm mis-resolves the `file:` dependency to `C:\Users\<username>\...` and the install fails. Use **Option 3** instead.

### Option 3: manual installation

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
- **Installed via Option 2 (dsh plugin)**:
  ```powershell
  dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
  ```
  If the latest commit is not fetched (git dependencies are cached), remove and re-add:
  ```powershell
  dsh plugin --profile web remove dsh-fs-encoding
  dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
  ```
  Then restart `dsh web`. **The commit hash changes with the new commit**, so if pnpm again asks you to allow build scripts, update the identifier in `pnpm-workspace.yaml` as described under Option 2.
- **Installed via Option 3 (manual)**:
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

### Installed via Option 2 (dsh plugin)

```powershell
dsh plugin --profile web remove dsh-fs-encoding
```

Then restart `dsh web`. The built-in `read` / `write` / `edit` come back immediately — nothing else to do.

### Installed via Option 3 (manual)

1. Remove this plugin's `insert` row from your profile's `cordis.patch.yml`.
2. Remove `"dsh-fs-encoding": ...` from the `dependencies` of the profile's `package.json`.
3. Reinstall dependencies and restart: `pnpm install` (or `npm install`), then `dsh web`.

### Leftover locations (cleanup checklist for the AI)

- **Config directory**: `$DSH_HOME/plugins/dsh-fs-encoding/` — `$DSH_HOME` defaults to `~/.dsh` (`C:\Users\<username>\.dsh` on Windows); the plugin's `config.yaml` lives here. Uninstallation does not delete it automatically; delete the whole directory manually for a complete cleanup.
- **Plugin directory** (Option 3 installs): `$DSH_HOME/profiles/<profile>/packages/dsh-fs-encoding/`.
- **Dependency & patch** (Option 3 installs): the `"dsh-fs-encoding": ...` dependency in the profile's `package.json`, and the `insert` row in `cordis.patch.yml`.
- No global registry, npm global packages, or system-level writes; the plugin writes no events of its own into session logs.

## Configuration

`$DSH_HOME/plugins/dsh-fs-encoding/config.yaml`, generated on first load:

```yaml
# Decode a non-UTF-8 file by guessing instead of failing.
# false (default, like VS Code): fail loud with Top-3 candidates.
autoGuessEncoding: false

# Migrate legacy (non-UTF-8) files to UTF-8 on their first save.
# false (default): preserve the original encoding byte-exactly.
normalizeToUtf8: false

# Encodings considered when guessing, and listed in the Top-3 error hint.
supportedEncodings: [gbk, big5, shift_jis, euc-kr, windows-1251, iso-8859-1]

# Inclusive byte cap for reading a whole file into memory (default 10485760 = 10 MiB).
maxFileBytes: 10485760
```

Environment overrides: `DSH_FS_ENCODING_AUTO_GUESS`, `DSH_FS_ENCODING_NORMALIZE_TO_UTF8`, `DSH_FS_ENCODING_SUPPORTED_ENCODINGS`, `DSH_FS_ENCODING_MAX_FILE_BYTES`.

> **About `normalizeToUtf8`**: when set to `true`, legacy files such as GBK are converted to UTF-8 on their first save (encoding problems gone for good). UTF-16 / UTF-32 files are **not** converted — they are already Unicode, and re-encoding them would break programs that depend on them.

## Supported encodings

| Kind | Encodings |
|---|---|
| Unicode | `utf8`, `utf8bom`, `utf16le`, `utf16be`, `utf32le`, `utf32be` |
| Legacy code pages | `gbk` (incl. `gb18030`, `gb2312`, `cp936`), `big5`, `shift_jis` (incl. `sjis`, `cp932`), `euc-kr`, `windows-1251`, `iso-8859-1` |

Names are case- and style-insensitive: `Shift-JIS`, `shift_jis` and `SJIS` all mean the same encoding.

## Common errors

| Error | Meaning and fix |
|---|---|
| `E_NOT_TEXT` | Not valid UTF-8 and no BOM. Re-read with `read({ encoding: "..." })` as suggested, or enable `autoGuessEncoding`. |
| `E_UNMAPPABLE` | The target encoding cannot represent the new content (an emoji in a GBK file). **The file was not modified** — switch to an encoding that can, or migrate with `normalizeToUtf8` first. |
| `E_BAD_ENCODING` | Unknown encoding name; use one from the table above. |
| `E_DECODE_FAILED` | The bytes do not decode under the requested encoding — the encoding is probably wrong; try another candidate. |
| `FS_STALE_VERSION` | The file changed after it was read. Read it again before editing, to avoid clobbering someone else's change. |
| `FS_NOT_OBSERVED` | The file was never read in this session. Read before writing. |
| `FS_EDIT_NOT_FOUND` | The `old_string` to replace was not found; check the content and indentation. |
| `FS_AMBIGUOUS_EDIT` | `old_string` matched more than once. Add surrounding context to make it unique, or set `replace_all: true`. |
| `FS_SANDBOX_DENIED` | Refused by DSH's sandbox (e.g. writing outside the workspace) — the existing safety policy at work. |

## Compatibility & conflicts

- **Zero-intrusion**: the plugin only uses DSH's public interfaces to register tools; it does **not** modify native DSH code and does not replace the `ctx.fs` filesystem itself. Uninstalling restores the built-in tools immediately, leaving nothing behind.
- **Every existing guarantee is kept**: sandbox fence, read-before-write protection, version checking and observation records all behave exactly as before — anything that should be blocked or questioned still is.
- **Mutually exclusive with `dsh-better-edit`**: both register `read` / `write` / `edit` on the same scope layer, and registering one name twice in a layer throws. **Enable only one** (see Installation above). The plugin detects this at boot and reports it clearly rather than failing silently.
- **Other file-related plugins**: if another plugin also registers tools with these names, check whether they share a layer and keep only one if needed.
- **Session state**: encoding information is kept in memory and isolated per session — never written to disk, never polluting your repository. After a DSH restart, the encoding is detected afresh on the first read.

## Development

```powershell
npm install
npm run typecheck   # tsc --noEmit for src and test
npm test            # 133 tests
npm run build       # src/ → lib/
```

The suite covers the encoding algorithms themselves and drives the real filesystem and sandbox components for integration cases, including byte-exact round-trips for all twelve encodings, BOM / CRLF fidelity, unmappable-character refusal, stale-write rejection and the sandbox fence.

To customize the plugin, use DSH's Creator mode for quick development.

## Roadmap

Phase 2 (not yet implemented): `undo_last_edit` and `str_replace_editor`.

## License

[MIT](LICENSE)
