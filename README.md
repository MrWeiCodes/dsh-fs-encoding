# dsh-fs-encoding — DSH 文件编码守护

> 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供的文件编码治理插件：让 AI 读写文件时不再弄坏 BOM 与多字节编码

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
- **十九种编码**：UTF-8（含 BOM）、UTF-16、UTF-32，以及 GBK、Big5、Shift-JIS、EUC-KR 和 Windows-125x 全系（西欧、中欧、西里尔、希腊、土耳其、希伯来、阿拉伯、波罗的海）。
- **零学习成本**：`read` / `write` / `edit` 三个工具的参数、返回格式与原版完全一致，是**直接替换**，原有提示词和工作习惯都不用改；`read` 和 `write` 各多了一个可选的 `encoding` 参数（`write` 的只用于新建文件，见下）。
- **能建指定编码的新文件**：`write` 加一个 `encoding` 就能直接生成 GBK、Shift-JIS 等编码的文件，不用先写 UTF-8 再转码。
- **多两个工具**：`insert`（按行号插入，原生没有这个能力）和 `str_replace_editor`（4 个子命令的兼容层，同样带编码治理）。见下方「另外两个工具」。
- **配置简单**：一个 YAML 文件，几项开关，都能用环境变量覆盖。

## 使用

### 开箱即用

**装好就能用，不需要任何配置。** 插件没有必填项、没有初始化步骤，也不会改动你的项目——装上之后，AI 照常用 `read` / `write` / `edit`，编码的事插件自己处理：

- 读 UTF-8 文件（含带 BOM 的）：和原版完全一样，**BOM 不会再被吃掉**。
- 读带 BOM 的 UTF-16 / UTF-32 文件：自动识别。
- 改 GBK、Shift-JIS 等老编码文件：**按原编码写回**，不会被悄悄转成 UTF-8。
- 写新文件：默认 UTF-8，需要别的编码时加一个参数即可。

这些都不需要你做任何事，也不需要 AI 改调用习惯。日常使用中，AI 的调用方式与原版**完全一致**。

### AI 的调用区别

只有一种情况会不一样：**无 BOM 的非 UTF-8 文件**（典型是 GBK / Big5 / Shift-JIS 的老文件）。此时插件不会擅自猜，而是停下来让 AI 用显式编码重读一次：

```
[E_NOT_TEXT] legacy.txt is not valid UTF-8. Most likely gbk. Re-read with
read({ file_path: "legacy.txt", encoding: "gbk" }) to decode it, or set
autoGuessEncoding: true in the plugin config to decode automatically.
Candidates: gbk("你好，世界"), big5("斕疑"), shift_jis("ﾄ羲")
```

AI 照着提示里的调用重读一次即可，**它会自己完成**——你不需要介入。重读之后编码就从「猜测」变成了「已知事实」，后续每次写入都按它进行。

`read` 和 `write` 因此各多了一个可选参数：

```
read({ file_path: "legacy.txt", encoding: "gbk" })
write({ file_path: "run.bat", content: "echo 中文\r\n", encoding: "gbk" })
```

> **无 BOM 的 UTF-16 / UTF-32 文件**同理，用 `read({ file_path: "<路径>", encoding: "utf16le" })` 显式指定即可正常读写（这类文件在 Windows 上较少见，且无 BOM 时无法可靠自动区分字节序，因此不做猜测）。

> **为什么默认要问一下？** GBK、Big5、Shift-JIS 的字节范围在短文本上互相重叠，猜错在界面上是看不出来的——而且会**按错误的编码写回**，把文件彻底弄坏。所以插件默认选择「宁可失败，不可猜错」。如果你更希望它尽力解码，把 `autoGuessEncoding` 设为 `true` 即可。
>
> 即使开了 `autoGuessEncoding`，也有一种情况仍然会报错并列出候选：文件**极短**（几个字节），且两个独立的识别器给出了**不同的**答案。此时没有任何依据能判断谁对——实测这种情况下的首选有约 79% 是错的——插件宁可让你从候选里挑一个，也不替你赌一把。只要两者给出**相同**的答案，就会直接采用；文件稍长一些（几十字节以上）也基本不会再出现这种歧义。
>
> 另一种会报错的情况：识别器把文件判成了 **ISO-8859-1 / Windows-1252 这类单字节编码**，但按它解码出来的文本**几乎全是非 ASCII 字符**。真实的西文以字母和空格为主，不会长这样；而中文/日文/韩文/俄文的双字节被当成单字节读时，每个字符会变成两个拉丁字符，正好就是这个特征。这时插件不会采用这个判断，而是报错并列出候选——实测这一步能拦下 24 个本会被静默读错的文件，且**不会**误伤任何原本读对的文件。

### 新建指定编码的文件

默认新文件是 UTF-8（无 BOM）。要给旧系统生成一个 GBK 文件，加 `encoding` 即可：

```
write({ file_path: "run.bat", content: "echo 中文\r\n", encoding: "gbk" })
```

支持的编码名与 `read` 相同，别名和大小写都不敏感（`cp936`、`Shift-JIS` 都行）。名字里带 BOM 的（`utf8bom`、`utf16le`、`utf16be`、`utf32le`、`utf32be`）会写入对应的 BOM；其余都不写 BOM。编码表示不了的字符同样**拒绝写入**，不会写成 `?`。

> **`encoding` 只对新建文件有效。** 文件已存在时传它会直接报错 `E_ENCODING_NOT_APPLICABLE`，不会转换——因为「保持文件原有编码」是本插件的核心承诺，而转换会重写整个文件，AI 从返回结果里看不出区别。**不要为了转换而先删除文件**：删除会绕过「先读后写」闸门，让未读过的内容在返回结果里以 `before: null` 静默消失；而如果本会话读过该文件，删除后写入会一直失败 `FS_STALE_VERSION`，该路径在本会话内再也建不回来。本插件不提供编码转换；确实需要一份另一种编码的副本时，请写到**新路径**上。

### 另外两个工具

除上面三个之外，插件还注册两个工具，同样带编码治理（写入按文件原有编码落盘）。

**`insert`** —— 按行号插入，原生没有这个能力。字面替换只能插在能引用到上下文的地方，「在文件开头加一行」之类就得先读到那一行再原样复述，很不方便：

```
insert({ file_path: "config.ini", insert_line: 0, new_string: "[core]" })
```

`insert_line` 指**插入到该行之后**：`0` 插到最前，等于文件行数时追加到末尾。行号与 `read` 显示的完全一致。

**`str_replace_editor`** —— 4 个子命令的兼容层，让按这套工具写的提示词与习惯直接可用：

| 命令 | 作用 |
|---|---|
| `view` | 显示文件（带行号，可用 `view_range` 限定范围）；路径是目录时列出两层结构，跳过隐藏项、`node_modules`、`__pycache__` |
| `create` | 新建文件，已存在则拒绝 |
| `str_replace` | 替换唯一匹配；`old_str` 不唯一时拒绝并指出所在行号 |
| `insert` | 同 `insert` 工具，`insert_line` 语义一致 |
| `undo_edit` | **不支持**，会明确说明 |

> `str_replace` 额外接受一个可选的 `replace_all`：不传就是标准行为（要求唯一匹配），传 `true` 才全部替换。这是本插件加的唯一扩展参数。
>
> 原生的 `str_replace` 与 `insert` 只认 UTF-8，遇到 GBK 文件会直接失败或把文件转坏——这正是本插件接管它们的意义。

## 安装

> **⚠️ 冲突提示**：**任何**在同一个作用域层注册 `read` / `write` / `edit` / `insert` / `str_replace_editor` 中任一名字的插件都与本插件互斥——同一层重复注册同名工具会直接报错。
>
> 插件启动时若发现这些名字已被**同一层**的其他插件占用，会拒绝安装并指出**具体是哪个工具名**被占了，不会留下半残的工具集。要解决冲突，要么从 profile 移除本插件，要么关掉那个占用了名字的插件：
>
> ```yaml
> # 在 profile 的 cordis.patch.yml 中
> - id: <对方的插件 id>
>   disabled: true
> ```
>
> 注意：内建 `read` / `write` / `edit` 位于更外层的宿主／preset 层，**不构成冲突**——本插件正是要在 agent 自己的层上覆盖它们，这与原生工具的 shadow 机制一致。

### 方式一：插件市场安装（dsh-market，推荐）

已安装 [dsh-market](https://github.com/dsh-market/dsh-market)（DSH 插件市场）的用户：打开 **设置 → 插件市场（Plugin Market）**，搜索 `dsh-fs-encoding`，点卡片上的「安装」并按提示确认，安装完成后**重启 `dsh web`**。

市场卡片：<https://awesome-dsh-plugin.com/p/MrWeiCodes/dsh-fs-encoding/>

### 方式二：让 AI 安装（最简单）

把本仓库地址告诉 DSH 的 AI 助手即可，例如：「安装 https://github.com/MrWeiCodes/dsh-fs-encoding 这个插件」。AI 会替你完成插件装载、依赖与补丁处理；之后重启 `dsh web`。

### 方式三：从 npm 安装（推荐）

```powershell
dsh plugin --profile web add dsh-fs-encoding
```

**推荐这条路径的原因**：npm 包里已包含编译好的 `lib/`，安装时不执行任何构建脚本——不受 pnpm 构建授权限制的影响，也不依赖你本地的编译环境。之后重启 `dsh web`。

### 方式四：从 GitHub 安装

```powershell
dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
```

从 GitHub 装的是源码，`lib/` 由 `prepare` 脚本现场编译，所以**装完可能需要在 profile 的 `pnpm-workspace.yaml` 里放行构建脚本**（pnpm 10 起默认阻止依赖执行构建脚本，按它打印的提示把那一行粘进去再重跑即可）。**不想处理这一步就用「方式三」**——npm 包已包含编译产物，没有这个环节。

> **从本地目录安装的已知问题**：Windows 上若插件目录与 profile **不在同一个盘符**（例如插件在 `G:\`、profile 在 `C:\`），pnpm 会把 `file:` 依赖错误解析成 `C:\Users\<用户名>\...` 而安装失败。此时请改用「方式五」。

### 方式五：手动安装

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

- **方式一（插件市场安装）的**：在插件市场里点更新即可。
- **方式二（AI 安装）的**：直接告诉 AI「更新 dsh-fs-encoding 插件」即可。
- **方式三（npm 安装）的**：
  ```powershell
  dsh plugin --profile web add dsh-fs-encoding@latest
  ```
  然后重启 `dsh web`。npm 路径同样不涉及构建步骤。
- **方式四（GitHub 安装）的**：
  ```powershell
  dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
  ```
  若没有拉到最新提交（git 依赖有缓存），先移除再重新添加：
  ```powershell
  dsh plugin --profile web remove dsh-fs-encoding
  dsh plugin --profile web add -w github:MrWeiCodes/dsh-fs-encoding
  ```
  然后重启 `dsh web`。**更新到新提交后 commit 号会变**，若 pnpm 再次要求放行构建，按方式四的说明重做一次即可。
- **方式五（手动）安装的**：
  ```powershell
  cd "$HOME\.dsh\profiles\web\packages\dsh-fs-encoding"
  git pull            # 或重新拷贝新版本覆盖
  npm install         # 依赖声明有变化时执行，同时重新触发 prepare
  ```
  然后重启 `dsh web`。

配置（`$DSH_HOME/plugins/dsh-fs-encoding/config.yaml`）在更新后都会保留。

## 卸载

### 方式一（插件市场安装）的：插件市场卸载

打开 **设置 → 插件市场**，在 dsh-fs-encoding 卡片上点「卸载」（两步确认），本会话安装的插件会即时移除。

### 方式二（AI 安装）的：让 AI 卸载

直接告诉 AI 助手「卸载 dsh-fs-encoding 插件」，AI 会移除插件、清理补丁与依赖。

### 方式三（npm）／方式四（GitHub）安装的

```powershell
dsh plugin --profile web remove dsh-fs-encoding
```

然后重启 `dsh web`。原生的 `read` / `write` / `edit` 会立刻恢复，无需任何额外操作。

### 方式五（手动）安装的

1. 从 profile 的 `cordis.patch.yml` 中删除本插件的 `insert` 行。
2. 从 profile 的 `package.json` 的 `dependencies` 中删除 `"dsh-fs-encoding": ...`。
3. 重新安装依赖并重启：`pnpm install`（或 `npm install`）、`dsh web`。

### 残留位置清单（AI 卸载时按此清理）

- **配置目录**：`$DSH_HOME/plugins/dsh-fs-encoding/`——`$DSH_HOME` 默认是 `~/.dsh`（Windows 下 `C:\Users\<用户名>\.dsh`），插件的 `config.yaml` 保存在这里。卸载不会自动删除，如需彻底清理请手动删除整个目录。
- **插件目录**（方式五安装时）：`$DSH_HOME/profiles/<profile>/packages/dsh-fs-encoding/`。
- **依赖与补丁**（方式五安装时）：profile 的 `package.json` 中的 `"dsh-fs-encoding": ...` 依赖、`cordis.patch.yml` 中的 `insert` 行。
- 无全局注册表、npm 全局包或系统级写入；插件不在会话日志里写入任何自有事件。

## 配置

**默认配置就能用，通常不需要动它。** 只有想调整「猜编码」的行为时才需要改。

配置文件位置（首次启动自动生成，内含完整注释）：

```
$DSH_HOME/plugins/dsh-fs-encoding/config.yaml
```

### 全部选项

| 选项 | 默认值 | 作用 |
|---|---|---|
| `autoGuessEncoding` | `false` | 遇到读不了的非 UTF-8 文件时：自动猜，还是报错让你选 |
| `normalizeToUtf8` | `false` | 保存时是否把 GBK 等老编码**转成 UTF-8** |
| `supportedEncodings` | 内置清单 | **参与自动猜测**的编码清单 |
| `excludeEncodings` | 空 | 从内置清单里**去掉**几个编码 |
| `maxFileBytes` | 10 MiB | 单个文件的读取上限 |

### 常见需求（直接抄）

**想让它自己猜，不要每次都来问我**

```yaml
autoGuessEncoding: true
```

**想彻底告别编码问题**（GBK 文件第一次保存后就变成 UTF-8）

```yaml
normalizeToUtf8: true
```

**某个编码老是猜错**（例如西里尔文抢走了西欧文本）

```yaml
excludeEncodings: [windows-1251]
```

### 编码清单：两个键有什么区别

插件内置一份用于**自动猜测**的编码清单。你可以做减法，也可以整个换掉：

| 你的需求 | 该用哪个 | 插件以后新增编码时 |
|---|---|---|
| 只想去掉一两个 | `excludeEncodings` | ✅ 仍然自动生效 |
| 想完全用自己的清单 | `supportedEncodings` | ❌ 收不到了 |

**为什么建议优先用 `excludeEncodings`**：`supportedEncodings` 一旦写上，就等于把清单**冻结**在你的配置文件里——插件以后支持了新编码，你也不会收到，而且它不会替你改回去（插件从不修改已有配置）。

> **清单只影响"自动猜测"，不影响"能不能读"。** 任何编码都可以显式指定读取，即使它不在清单里：
>
> ```
> read({ file_path: "legacy.txt", encoding: "windows-1253" })
> ```

### 环境变量

适合临时测试或容器部署。**环境变量始终优先于配置文件**：

| 变量 | 对应选项 |
|---|---|
| `DSH_FS_ENCODING_AUTO_GUESS` | `autoGuessEncoding` |
| `DSH_FS_ENCODING_NORMALIZE_TO_UTF8` | `normalizeToUtf8` |
| `DSH_FS_ENCODING_SUPPORTED_ENCODINGS` | `supportedEncodings` |
| `DSH_FS_ENCODING_MAX_FILE_BYTES` | `maxFileBytes` |

`excludeEncodings` **没有**环境变量——它是唯一只能在配置文件里写的选项。

> **`normalizeToUtf8` 不会转换 UTF-16 / UTF-32 文件**：它们本来就是 Unicode，强行转码反而会破坏依赖它们的程序。

## 支持的编码

| 类别 | 编码 |
|---|---|
| Unicode | `utf8`、`utf8bom`、`utf16le`、`utf16be`、`utf32le`、`utf32be` |
| 东亚 | `gbk`（含 `gb18030`、`gb2312`、`cp936`）、`big5`（含 `cp950`）、`shift_jis`（含 `sjis`、`cp932`）、`euc-kr`（含 `cp949`） |
| Windows ANSI | `windows-1250`（中欧）、`windows-1251`（西里尔）、`windows-1252`（西欧）、`windows-1253`（希腊）、`windows-1254`（土耳其）、`windows-1255`（希伯来）、`windows-1256`（阿拉伯）、`windows-1257`（波罗的海）——每个都可用 `cp12xx` 写法 |
| 其他 | `iso-8859-1`（含 `latin1`） |

> **关于 `windows-1258`（越南语）**：暂不支持。越南语需要组合字符（`ế` 是一个码点、两个字节），而底层 `iconv-lite` 的单字节表无法拆分，67 个常用越南语字符中有 52 个会被编码成 `?`。加入它会造成「文件读得出来却几乎存不进去」，反而更像 bug，因此暂时不开放。

> **这张表是"能读写"，不是"会自动猜"。** 自动猜测只用配置里的那一小份清单（默认 7 种），范围小是为了降低猜错率。表里其他编码照样能用，显式指定即可：`read({ file_path: "x.txt", encoding: "windows-1253" })`。清单怎么调见上方[配置](#配置)。

编码名大小写与写法都兼容：`Shift-JIS`、`shift_jis`、`SJIS` 指的是同一个编码。

## 常见错误

| 报错 | 含义与处理 |
|---|---|
| `E_NOT_TEXT` | 不是合法 UTF-8 且无 BOM。按提示用 `read({ file_path: "...", encoding: "..." })` 重读，或开启 `autoGuessEncoding`。 |
| `E_UNMAPPABLE` | 目标编码表示不了新内容（如 GBK 里的 emoji）。**文件未被修改**，请改用能表示该字符的编码，或先做 `normalizeToUtf8` 迁移（该迁移只作用于**已有**文件；新建文件请直接换一个编码名）。 |
| `E_BAD_ENCODING` | 编码名不认识，改用上表里的名字。 |
| `E_ENCODING_NOT_APPLICABLE` | 对**已存在**的文件传了 `write` 的 `encoding`。该参数只用于新建文件；文件会保持原有编码，未做任何改动。本插件**不提供编码转换**——不要为了转换而删除文件（见上文说明），需要另一种编码的副本请写到新路径。 |
| `E_DECODE_FAILED` | 字节无法按指定编码解码，多半是编码选错了，换一个候选重试。 |
| `FS_STALE_VERSION` | 文件在读取之后被改动过（或已被删除）。重新读一次再改，避免覆盖别人的修改。 |
| `FS_NOT_OBSERVED` | 本次会话没有这个文件的编码记录，因此不能重写它：**已存在**的文件若本会话没读过（或记录已被回收），`write` 会拒绝而不是按 UTF-8 重写。先 `read` 一次再写；若它不是文本文件，本插件无法重写它。新建文件不受影响。 |
| `FS_EDIT_NOT_FOUND` | 没找到要替换的 `old_string`，确认内容与缩进是否一致。 |
| `FS_AMBIGUOUS_EDIT` | `old_string` 匹配到多处。补足上下文让它唯一，或加 `replace_all: true` 全部替换。 |
| `FS_SANDBOX_DENIED` | 被 DSH 沙箱拦下（如写入工作区外的路径），属于原有安全策略。 |

## 兼容性与冲突

- **零侵入**：插件只使用 DSH 的公开接口注册工具，**不修改 DSH 原生代码**，也不替换 `ctx.fs` 文件系统本身；卸载后原生工具立即恢复，不留痕迹。
- **原有保障全部保留**：沙箱围栏、读后写保护、版本校验、观察记录等原生行为一项不少——写入前该拦的照样拦，该问的照样问。
- **与任何注册同名工具的插件互斥**：本插件在作用域层注册 `read` / `write` / `edit` / `insert` / `str_replace_editor`，而同一层重复注册同名工具会直接报错。判定依据是这些名字在**该 agent 自己的层**上是否已被占用，与对方是谁无关——发现冲突即拒绝安装并指出被占用的工具名（见上方安装说明）。宿主／preset 层的内建工具不属于冲突。
- **会话状态**：编码信息保存在内存中、按会话隔离，不写入磁盘、不污染仓库。DSH 重启后首次读取会重新识别编码。
- **对外提供服务**：插件安装后会提供 `fsEncoding` 服务，供其他插件复用同一套编码判定（见下方[给插件开发者](#给插件开发者)）。

## 给插件开发者

DSH 的 `ctx.fs` 只认 UTF-8：它用严格的 `TextDecoder` 解码，所以一个 GBK 文件在它看来是 `FS_NOT_TEXT`。本插件的工具层解决了**模型**读文件的问题，但**其他插件**直接调 `ctx.fs` 渲染内容时（审批预览、差异卡片、文件查看器）仍然会撞上这个限制，于是要么显示一个本该能读的文件的错误，要么自己再实现一套猜测——同一份部署的两处对同一个文件给出不同解读。

本插件因此提供一个服务，把「这些字节是什么文本」这件事收在一处：

```js
// 消费方：用 ctx.get 读取，无需 inject，插件没装时返回 undefined
const fsEncoding = ctx.get("fsEncoding");
// 注意：名字被别的插件占用时，ctx.get 返回的是那个插件的对象而不是 undefined，
// 所以判"有没有"要按能力判，不能只判 undefined。
// 下面用的 isFsEncodingService 与守卫等价，它校验的正是 tryDecode 与 decode 两个方法——
// 手写守卫时两个都要查，只查 tryDecode 会放过"只有 tryDecode"的异物，
// 于是后面调 decode 时抛 TypeError，守卫就白写了
if (!isFsEncodingService(fsEncoding)) {
  // 插件未安装（或服务名被占用）：按原来的方式处理（通常是显示"不是 UTF-8"）
}

// 自己负责读盘（沙箱、路径解析都是调用方的上下文）
const target = await ctx.fs.resolve(path, { cwd });
// 三个参数都是必需的：maxBytes 是 readBytes 唯一的上限，漏传不会报错，
// 而是把整个文件无界读进内存。signal 与 maxBytes 都取自你自己的执行上下文
// （例如 ctx.fsEncoding 之外，你手里应当已有 exec 与一个自定的上限）
const bytes = await ctx.fs.readBytes(target, exec?.signal, maxBytes);

const outcome = await fsEncoding.tryDecode(bytes, { displayPath: path });
if (outcome.ok) {
  outcome.result.text;      // 解码后的文本（BOM 已去掉）
  outcome.result.encoding;  // 例如 "gbk"
  outcome.result.decided;   // "bom" | "utf8" | "hint" | "guessed"
  outcome.result.hasBOM;
  outcome.result.lineEnding;
} else {
  outcome.refusal.message;    // 可直接展示的说明（与 read 工具的措辞一致）
  outcome.refusal.candidates; // 候选编码，可供用户挑选
  outcome.refusal.ranked;     // 候选是否按证据排序（false 表示顺序无意义）
  outcome.refusal.adoptable;  // 首位是否可信到可以采用
  outcome.refusal.autoGuessEnabled; // 是"没尝试猜"还是"猜了但没结果"
}
```

三个设计要点：

- **`decided` 是必须看的字段。** 只有 `"bom"` / `"utf8"` / `"hint"` 是确定的，`"guessed"` 是概率性猜测。面向人展示内容时应当说明这一点——把一个猜测当成文件真实编码展示，正是本插件要消除的问题。
- **拒绝是返回值，不是异常。** `tryDecode` 对任意输入都不会抛错（包括 `encoding` 传了非字符串这类参数错误，会作为拒绝返回）；需要与 `read` 工具完全一致的报错文本时用 `decode`。
- **服务不读文件、不记录状态。** 读盘由调用方负责；解码不写入会话的编码记录，所以预览不会替你"读过"某个文件、进而授权后续写入。

其他方法：`isUtf8(bytes)`（廉价判断**这些字节是不是合法 UTF-8**——注意这不等于 `ctx.fs.readText` 一定成功，后者还会把前 8 KiB 含 NUL 的内容判为二进制）、`supportedEncodings()`（本部署实际会尝试的集合，做选择器时用它，而不是自己列一份）、`knownEncodings()`（全部可用的编码名）、`autoGuessEnabled()`、`isFsEncodingService(value)`（判断 `ctx.get` 拿到的是不是本服务）。

`tryDecode` / `decode` 接受 `maxBytes` 选项限制单次解码的字节数，默认取本插件的 `maxFileBytes`；超限会以拒绝（`E_TOO_LARGE`）返回，而不是对超大输入做全量候选排序。注意没有「无上限」的写法：省略 `maxBytes` 表示用本部署的 `maxFileBytes`，而 `Infinity` / `NaN` / 非正数这类不可用的值会以 `E_BAD_ENCODING` 拒绝，不会被静默当成默认值（否则错误信息会建议你调大一个刚被忽略的参数）。

`tryDecode` 对任意输入都不抛错，参数错误一律作为拒绝返回：`encoding` / `displayPath` 传了非字符串、`bytes` 不是 `Uint8Array`、`maxBytes` 不可用，都会拒绝。

**`opts` 本身传错也会拒绝，而不是被当成"没传"。** 只有**整个参数省略**（或传 `undefined`）才表示用默认值；`null`、字符串、数字等一律拒绝：

```js
await fsEncoding.tryDecode(bytes);                          // 默认值
await fsEncoding.tryDecode(bytes, {});                      // 默认值
await fsEncoding.tryDecode(bytes, { encoding: "gbk" });     // 指定编码

await fsEncoding.tryDecode(bytes, "gbk");   // 拒绝：少写了一对花括号
await fsEncoding.tryDecode(bytes, null);    // 拒绝：null 不算"没传"
```

这一条是刻意的：在 JavaScript 里读一个非对象的属性**不会报错**，只会得到 `undefined`——和"没传"完全一样。所以 `tryDecode(bytes, "gbk")` 这种漏写花括号的写法，曾经会**静默丢掉你指定的编码**，退回自动猜测，解码结果可能和你要的完全不同却毫无提示。`null` 同样拒绝，因为它是 JSON 和数据库里"缺值"的样子，放行等于把调用方的 bug 藏起来。

## 开发

```powershell
npm install
npm run typecheck   # 对 src 与 test 跑 tsc --noEmit
npm test            # 运行测试套件
npm run build       # src/ → lib/
```

测试既覆盖编码算法本身，也用真实的文件系统与沙箱组件做集成验证，包括全部编码的字节级往返、BOM / CRLF 保真、不可映射字符拒绝、陈旧写入拒绝与沙箱围栏。

如需自定义插件功能或修改插件，直接使用 DSH 的 Creator mode 即可快速进行开发修改。

## 路线图

尚未实现：`undo_last_edit`（撤销上一次编辑）。

## 致谢

本插件的编码处理层最初从 [dsh-better-edit](https://github.com/Rianico/dsh-better-edit/) 中抽出——BOM 保真、多字节编码的读写往返等基础能力源自那里。独立成插件后，围绕「读到的字节与写回的字节一致」这一目标重写并扩展：Windows ANSI 全系、可配置的猜测清单、候选排序的证据判定、`ctx.fsEncoding` 服务等。感谢该项目打下的基础。

两者都在作用域层注册 `read` / `write` / `edit`，因此不能同时启用（原因见上方[兼容性与冲突](#兼容性与冲突)）。

## 许可

[MIT](LICENSE)
