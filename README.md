# dsh-fs-encoding — DSH 文件编码守护

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供的文件编码治理插件：让 AI 读写文件时不再弄坏 BOM 与多字节编码

**仓库**：https://github.com/MrWeiCodes/dsh-fs-encoding

**🌏 中文 | [English](README_EN.md)**

`dsh` · `dsh-plugin` · `plugin` · `encoding` · `BOM` · `GBK` · `Big5` · `Shift-JIS` · `UTF-16` · `AI agent` · `编码` · `文件编码` · `乱码`

<!-- keywords: dsh, dsh-plugin, deepseek harness, plugin, encoding, bom, gbk, big5, shift-jis, utf-16, ai agent, 编码, 文件编码, 乱码 -->

## 简介

DSH 自带的 `read` / `write` / `edit` 三个文件工具**只认 UTF-8**，遇到中文、日文、韩文项目里常见的编码就会出问题：

- **GBK、Big5、Shift-JIS 等编码的文件根本读不了**，直接报 `invalid UTF-8 text`，AI 只能干看着；
- **带 BOM 的 UTF-8 文件能读，但 BOM 会被悄悄吃掉**——AI 随手改一次，文件开头那三个字节就没了。对 PHP、旧版编译器、部分 Windows 软件来说，文件头少了 BOM 就可能解析出错或直接乱码；
- 更麻烦的是**没有任何警告**：你只会在某天发现文件坏了，却不知道是哪次编辑弄坏的。

本插件接管这三个工具，在**完整保留原有行为**（沙箱围栏、读后写保护、版本校验、diff 展示）的前提下，让非 UTF-8 文件和 BOM 都能正确读写：**文件原来是什么编码，改完还是什么编码。**

## 功能特性

- **字节级保真**：文件编码在首次读取时确定一次，之后每次保存都按原编码写回。改一个 GBK 文件，它仍然是一个 GBK 文件，不会被偷偷转成 UTF-8。
- **BOM 保真**：原本有 BOM 就精确还原，原本没有就绝不擅自添加——两个方向都不会出错。
- **换行符保真**：CRLF / LF / CR 在读取时识别、保存时还原，Windows 项目不会被改成 LF。
- **绝不静默损坏**：如果目标编码表示不了新内容（比如往 GBK 文件里写 emoji），插件会**直接拒绝写入**并说明原因，文件保持原样——而不是写进去一堆 `?` 把文件毁掉。
- **读不了会告诉你怎么办**：遇到非 UTF-8 文件时，插件会列出最可能的几种编码和各自的解码效果，AI（或你）选一个重新读即可，就像 VS Code 的「通过编码重新打开」。
- **十二种编码**：UTF-8（含 BOM）、UTF-16、UTF-32，以及 GBK、Big5、Shift-JIS、EUC-KR、Windows-1251、ISO-8859-1 等常见代码页。
- **零学习成本**：三个工具的参数、返回格式与原版完全一致，是**直接替换**，原有提示词和工作习惯都不用改；`read` 只多了一个可选的 `encoding` 参数。
- **配置简单**：一个 YAML 文件，四个开关，都能用环境变量覆盖。

## 使用

三个工具与原版用法完全相同，`read` 多了一个可选参数：

```
read({ file_path: "legacy.txt", encoding: "gbk" })
```

不带 `encoding` 时插件会自动识别 UTF-8 文件、带 BOM 的 UTF-16 / UTF-32 文件以及 BOM 本身；**只有无 BOM 的非 UTF-8 文件**才会停下来问你，并给出候选：

```
[E_NOT_TEXT] legacy.txt is not valid UTF-8. Most likely gbk. Re-read with
read({ encoding: "gbk" }) to decode it, or set autoGuessEncoding: true in the
plugin config to decode automatically.
Candidates: gbk("你好，世界"), big5("斕疑"), shift_jis("ﾄ羲")
```

照着提示里的调用重读一次，编码就从「猜测」变成了「已知事实」，后续写入都会按它进行。

> **无 BOM 的 UTF-16 / UTF-32 文件**同理，用 `read({ encoding: "utf16le" })` 显式指定即可正常读写（这类文件在 Windows 上较少见，且无 BOM 时无法可靠自动区分字节序，因此不做猜测）。

> **为什么默认要问你一下？** GBK、Big5、Shift-JIS 的字节范围在短文本上互相重叠，猜错在界面上是看不出来的——而且会**按错误的编码写回**，把文件彻底弄坏。所以插件默认选择「宁可失败，不可猜错」。如果你更希望它尽力解码，把 `autoGuessEncoding` 设为 `true` 即可。

## 安装

### 方式一：让 AI 安装（最简单）

把本仓库地址告诉 DSH 的 AI 助手即可，例如：「安装 https://github.com/MrWeiCodes/dsh-fs-encoding 这个插件」。AI 会替你完成插件装载、依赖与补丁处理；之后重启 `dsh web`。

> **⚠️ 冲突提示**：本插件与 `dsh-better-edit` 都在同一层注册 `read` / `write` / `edit`，**两者只能启用一个**。若你装了 `dsh-better-edit`，请在 profile 的 `cordis.patch.yml` 里把它关掉：
>
> ```yaml
> - id: dsh-better-edit
>   disabled: true
> ```
>
> 插件启动时会主动检测这个冲突并给出可操作的提示，不会留下一个半残的工具集。

### 方式二：一行命令（自助安装）

```powershell
dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
```

> **⚠️ 首次安装需要放行构建脚本。** 本插件是 TypeScript 项目，`lib/` 由 `prepare` 脚本编译生成。pnpm 10 出于安全考虑**默认阻止依赖执行构建脚本**，因此第一次安装会失败并打印一段提示，其中包含一个带 commit 号的完整标识（每次提交都会变，所以无法预先写在文档里）。
>
> 按提示操作即可：
>
> 1. 打开 profile 目录下的 `pnpm-workspace.yaml`（没有就新建），把提示里给出的那一行原样粘进去：
>
>    ```yaml
>    onlyBuiltDependencies:
>      - "dsh-fs-encoding@git+https://github.com/MrWeiCodes/dsh-fs-encoding.git#<提示里的commit号>"
>    ```
>
> 2. 重新执行上面的 `dsh plugin add` 命令。
>
> 这是 pnpm 10 对所有 git 依赖的统一安全策略（防止安装时执行任意代码），不是本插件特有的问题。若不想放行构建，请改用「方式三：手动安装」。
>
> **从本地目录安装的已知问题**：Windows 上若插件目录与 profile **不在同一个盘符**（例如插件在 `G:\`、profile 在 `C:\`），pnpm 会把 `file:` 依赖错误解析成 `C:\Users\<用户名>\...` 而安装失败。此时请改用「方式三」。

### 方式三：手动安装

无 pnpm 或离线环境时的备选路径：

1. 把本仓库克隆到 profile 的插件目录，并在目标目录构建一次（`prepare` 脚本会生成 `lib/`）：
   ```powershell
   # 示例：web profile
   $dst = "$HOME\.dsh\profiles\web\packages\dsh-fs-encoding"
   git clone https://github.com/MrWeiCodes/dsh-fs-encoding.git $dst
   cd $dst
   npm install      # 同时触发 prepare → 生成 lib/
   ```
2. 在 profile 的 `package.json` 的 `dependencies` 中加入：
   ```json
   "dsh-fs-encoding": "file:./packages/dsh-fs-encoding"
   ```
3. 把 `cordis.patch.yml` 的内容并入 profile 的 `cordis.patch.yml`（在文件末尾追加）。
4. 重新安装依赖并重启：`pnpm install`（或 `npm install`）、`dsh web`。

## 更新

- **方式一（AI 安装）的**：直接告诉 AI「更新 dsh-fs-encoding 插件」即可。
- **方式二（dsh plugin）安装的**：
  ```powershell
  dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
  ```
  若没有拉到最新提交（git 依赖有缓存），先移除再重新添加：
  ```powershell
  dsh plugin --profile web remove dsh-fs-encoding
  dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
  ```
  然后重启 `dsh web`。**更新到新提交后 commit 号会变**，若 pnpm 再次提示需要放行构建，按「方式二」的说明更新 `pnpm-workspace.yaml` 里的标识即可。
- **方式三（手动）安装的**：
  ```powershell
  cd "$HOME\.dsh\profiles\web\packages\dsh-fs-encoding"
  git pull            # 或重新拷贝新版本覆盖
  npm install         # 依赖声明有变化时执行，同时重新触发 prepare
  ```
  然后重启 `dsh web`。

配置（`$DSH_HOME/plugins/dsh-fs-encoding/config.yaml`）在更新后都会保留。

## 卸载

### 方式一（AI 安装）的：让 AI 卸载

直接告诉 AI 助手「卸载 dsh-fs-encoding 插件」，AI 会移除插件、清理补丁与依赖。

### 方式二（dsh plugin）安装的

```powershell
dsh plugin --profile web remove dsh-fs-encoding
```

然后重启 `dsh web`。原生的 `read` / `write` / `edit` 会立刻恢复，无需任何额外操作。

### 方式三（手动）安装的

1. 从 profile 的 `cordis.patch.yml` 中删除本插件的 `insert` 行。
2. 从 profile 的 `package.json` 的 `dependencies` 中删除 `"dsh-fs-encoding": ...`。
3. 重新安装依赖并重启：`pnpm install`（或 `npm install`）、`dsh web`。

### 残留位置清单（AI 卸载时按此清理）

- **配置目录**：`$DSH_HOME/plugins/dsh-fs-encoding/`——`$DSH_HOME` 默认是 `~/.dsh`（Windows 下 `C:\Users\<用户名>\.dsh`），插件的 `config.yaml` 保存在这里。卸载不会自动删除，如需彻底清理请手动删除整个目录。
- **插件目录**（方式三安装时）：`$DSH_HOME/profiles/<profile>/packages/dsh-fs-encoding/`。
- **依赖与补丁**（方式三安装时）：profile 的 `package.json` 中的 `"dsh-fs-encoding": ...` 依赖、`cordis.patch.yml` 中的 `insert` 行。
- 无全局注册表、npm 全局包或系统级写入；插件不在会话日志里写入任何自有事件。

## 配置

`$DSH_HOME/plugins/dsh-fs-encoding/config.yaml`，首次加载时自动生成：

```yaml
# 非 UTF-8 文件是猜测解码还是直接失败。
# false（默认，与 VS Code 一致）：失败并列出前三个候选编码。
autoGuessEncoding: false

# 是否在首次保存时把 legacy（非 UTF-8）文件迁移为 UTF-8。
# false（默认）：字节级保留原编码。
normalizeToUtf8: false

# 猜测时考虑的编码，也用于 Top-3 错误提示。
supportedEncodings: [gbk, big5, shift_jis, euc-kr, windows-1251, iso-8859-1]

# 整文件读入内存的字节上限（默认 10485760 = 10 MiB）。
maxFileBytes: 10485760
```

环境变量覆盖：`DSH_FS_ENCODING_AUTO_GUESS`、`DSH_FS_ENCODING_NORMALIZE_TO_UTF8`、`DSH_FS_ENCODING_SUPPORTED_ENCODINGS`、`DSH_FS_ENCODING_MAX_FILE_BYTES`。

> **关于 `normalizeToUtf8`**：设为 `true` 后，GBK 等老编码文件会在第一次保存时转成 UTF-8（从此告别编码问题）；UTF-16 / UTF-32 文件**不会**被转换——它们本来就是 Unicode，强行转码反而会破坏依赖它们的程序。

## 支持的编码

| 类别 | 编码 |
|---|---|
| Unicode | `utf8`、`utf8bom`、`utf16le`、`utf16be`、`utf32le`、`utf32be` |
| Legacy 代码页 | `gbk`（含 `gb18030`、`gb2312`、`cp936`）、`big5`、`shift_jis`（含 `sjis`、`cp932`）、`euc-kr`、`windows-1251`、`iso-8859-1` |

编码名大小写与写法都兼容：`Shift-JIS`、`shift_jis`、`SJIS` 指的是同一个编码。

## 常见错误

| 报错 | 含义与处理 |
|---|---|
| `E_NOT_TEXT` | 不是合法 UTF-8 且无 BOM。按提示用 `read({ encoding: "..." })` 重读，或开启 `autoGuessEncoding`。 |
| `E_UNMAPPABLE` | 目标编码表示不了新内容（如 GBK 里的 emoji）。**文件未被修改**，请改用能表示该字符的编码，或先做 `normalizeToUtf8` 迁移。 |
| `E_BAD_ENCODING` | 编码名不认识，改用上表里的名字。 |
| `E_DECODE_FAILED` | 字节无法按指定编码解码，多半是编码选错了，换一个候选重试。 |
| `FS_STALE_VERSION` | 文件在读取之后被改动过。重新读一次再改，避免覆盖别人的修改。 |
| `FS_NOT_OBSERVED` | 本次会话从未读过这个文件。先 `read` 再写。 |
| `FS_EDIT_NOT_FOUND` | 没找到要替换的 `old_string`，确认内容与缩进是否一致。 |
| `FS_AMBIGUOUS_EDIT` | `old_string` 匹配到多处。补足上下文让它唯一，或加 `replace_all: true` 全部替换。 |
| `FS_SANDBOX_DENIED` | 被 DSH 沙箱拦下（如写入工作区外的路径），属于原有安全策略。 |

## 兼容性与冲突

- **零侵入**：插件只使用 DSH 的公开接口注册工具，**不修改 DSH 原生代码**，也不替换 `ctx.fs` 文件系统本身；卸载后原生工具立即恢复，不留痕迹。
- **原有保障全部保留**：沙箱围栏、读后写保护、版本校验、观察记录等原生行为一项不少——写入前该拦的照样拦，该问的照样问。
- **与 `dsh-better-edit` 互斥**：两者都在同一作用域层注册 `read` / `write` / `edit`，而同一层重复注册同名工具会直接报错。**只能启用其中一个**（见上方安装说明）。插件启动时会检测并给出明确提示，不会静默失败。
- **其他文件类插件**：若某插件也注册同名文件工具，请先确认两者是否在同一层，必要时只保留一个。
- **会话状态**：编码信息保存在内存中、按会话隔离，不写入磁盘、不污染仓库。DSH 重启后首次读取会重新识别编码。

## 开发

```powershell
npm install
npm run typecheck   # 对 src 与 test 跑 tsc --noEmit
npm test            # 133 个测试
npm run build       # src/ → lib/
```

测试既覆盖编码算法本身，也用真实的文件系统与沙箱组件做集成验证，包括十二种编码的字节级往返、BOM / CRLF 保真、不可映射字符拒绝、陈旧写入拒绝与沙箱围栏。

如需自定义插件功能或修改插件，直接使用 DSH 的 Creator mode 即可快速进行开发修改。

## 路线图

第二阶段（尚未实现）：`undo_last_edit` 与 `str_replace_editor`。

## 许可

[MIT](LICENSE)
