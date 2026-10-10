# remote-tools 复用宿主 Operations 接缝，并用宿主本地路径命名空间当远端路径信道

Status: accepted（2026-10-10，`remote-tools-todo#1` / `#6`；决策 1、2、3 均已落地——决策 3 的信道硬化由 `#7` 落地）

## 背景

需求（`todos/align/remote-tools-todo#1.md`）：给七个内置工具加可选 `remote` / `remotePort` / `remoteCwd`，
`remote` 为空时与内置**逐字一致**、非空时经系统 `ssh` 在远端执行，零运行时 npm 依赖。
宿主把内置工具的执行后端做成了**公开可替换的 Operations 接口**（`BashOperations` / `ReadOperations` /
`WriteOperations` / `EditOperations` / `LsOperations` / `FindOperations` / `GrepOperations`），
且扩展 `pi.registerTool()` 注册同名工具会覆盖内置定义
（`dist/core/agent-session.js` 的 `_refreshToolRegistry`：built-ins 先入注册表、custom tools 后入覆盖；
官方 Gondolin 扩展示例是同一做法）。

## 决策 1：覆盖同名工具 + 只换 Operations（grep 例外）

`read`/`write`/`edit`/`ls`/`find`/`bash` 一律 spread 宿主的 `createXxxToolDefinition`（保留 schema、描述、
`promptSnippet`/`promptGuidelines`、渲染器、`executionMode`），**只把 `operations` 换成远端实现**；
`remote` 为空时直接调宿主本地实现（零漂移、绝不 spawn ssh）。

保真来自「用同一份实现」：截断（`truncateHead`/`truncateLine`/`formatSize`）、限流提示、
文件变更队列（`withFileMutationQueue`）、渲染器、提示词片段全部天然一致。

代价：`grep` 无法这样复用——`GrepOperations` 只覆盖 `isDirectory`/`readFile`，真正的搜索是宿主的
**本地** `spawn ripgrep`（`dist/core/tools/grep.js`）⇒ 整份重写（远端 `rg --json` 优先、缺 rg 回退 GNU grep），
并因此失去宿主的 grep 渲染器（`grepRenderers` 未从包根导出，`registerToolRenderer` 的 `next()` 也够不着）。

## 决策 2：远端路径编码进宿主本地路径命名空间当信道

交给内置工具的远端路径统一编码成宿主形态：**标记根** `<扩展目录>/index.ts/pi-remote/…`（两平台同一形态；
`paths.ts` 的 `HOST_PATH_ROOT` / `toHostPath` / `toRemotePath`）。同一编码兼作「这条路径经过宿主解析」的**凭证**：
模型自己给的 `C:/…`、相对路径没有标记，ops 层原样返回后由 `validateRemotePath` 拒绝（fail-closed）。

为什么**必须**是这种形态（三条同时满足，均为实测）：`path.resolve` 原样保留（既不注入进程盘符、
也不让 `normalizeWindowsShellPath` 把单字母首段当 Git-Bash 盘符）、本地 `path`/`fs` 给 missing-path 错误
（`ENOENT`/`ENOTDIR`：write/edit 的 `withFileMutationQueue` 只容忍这两个码、read 的变体探测吞掉一切错误）、
`path.relative` 与宿主 find 的相对化落在同一命名空间。标记根放在**扩展目录里一个已存在的普通文件**下面
（而不是盘符根/根目录下的 `pi-remote`）是决策 3 的结论，见下。

**根因（2026-10-10 用户复现并回滚）**：这条信道借用了**别人管理的命名空间**，靠一条**不可执行**的约定
「本地不存在该前缀」维持。本地真存在该目录时：

1. `read` 的**变体探测**（宿主 `path-utils.js` 用**本地** `accessSync` 依次试 原路径 → AM/PM 窄空格 →
   NFD → 弯引号）会命中本地文件，把远端读取的**文件名换成变体名** ⇒ **静默读错文件**（实测：本地
   `it’s.txt` 在、远端 `it's.txt` 在，读出的是变体名的内容）；
2. 该路径不再以 ENOENT 失败 ⇒ 设计的 fail-closed 归因失真（本该失败的探测变成成功）；
3. 这条前提只写在**测试断言**里（`test/paths.test.ts` 的 `realpath` 必须 ENOENT 用例），运行时零守卫——
   本地建目录即转红，是「前提只被断言、未被执行」的直接证据。

写入不受影响（所有实际 I/O 都走注入的 ssh ops；`withFileMutationQueue` 的 `realpath` 只当锁键）。

## 决策 3（`#7` 已落地）：信道前提从「约定」变成「结构性事实 + 被执行的检查」

采用 **C'（标记根锚在扩展自带的普通文件下）+ A（运行时守卫）**：

- **C'｜结构性不可占用（主机制，两平台通用）**：标记根 = `<扩展目录>/index.ts/pi-remote`。锚点是一个**已存在的
  普通文件**（扩展入口自己）⇒ 只要它还是普通文件，本地就**建不出**这个目录：实测 Windows
  `mkdir -p <标记根>` → `ENOTDIR`、`realpath` → `ENOENT`（含深层、弯引号、345 字符长路径样本）；POSIX 同理
  `ENOTDIR`。于是「本地不存在该前缀」不再是靠人守的约定，而是文件系统的结构事实——变体探测根本没有可命中的本地文件。
- **A｜运行时守卫（兜底）**：远端调用前检查锚文件仍是普通文件，不是就 fail-closed 报专码 `HOST_MARKER_CONFLICT`
  （本地分支不受影响，零额外 fs 操作）。它兜住「锚文件被删/被换成目录」这一种破坏方式。
- 二者一起把原根因的三个后果（变体探测读错文件 / fail-closed 归因失真 / 前提只被断言未被执行）全部消掉。

被否决的备选（同一轮考虑）：

- **B'｜Windows 用含 `?` 的标记名**：`?` 在 Windows 文件名里非法 ⇒ 本地永不可能存在，但 POSIX 没有这种字符
  （只覆盖一半平台），且换成 C' 后不再必要。
- **只做 A**：能报错但不能防患，属于「事后熔断」；C' 才是把前提变成结构事实。
- **`<扩展目录>/pi-remote`（子目录形态）**：只是「不太可能被占用」（pi 会重克隆包缓存、项目级安装时
  标记根落在用户项目里），没变成结构性，不采。

## 决策 4（`#8` 已落地）：接缝里的**可选端口**必须补齐，且判定逻辑只从宿主同一份实现取

`ReadOperations.detectImageMimeType` 是可选的，不实现它宿主就静默把图片当文本读（`read.js` 的
`ops.detectImageMimeType ? … : undefined`；用户实测 PNG 读出 `�PNG…` 乱码）。补实现时的两条取舍：

- **判定不复刻**：魔数/动图 PNG/BMP 校验在宿主 `utils/mime.js` 只此一份，而包根只导出
  `detectSupportedImageMimeTypeFromFile`（纯 buffer 版未导出，包 `exports` 又封死深路径 import）⇒
  远端取回的嗅探样本先落到**本地临时文件**、再交给这个函数。代价是每次远端 read 一次本地临时文件
  （用完即删）；换来宿主升级自动跟上（备选是复制 ~50 行魔数逻辑，判为漂移负债，否决）。
- **不新增往返**：样本搭 `access` 那一次往返的顺风车（`head -c 8192 … | base64`），read 仍是 2 次 ssh；
  样本上限取 8192 ≥ 宿主 `IMAGE_TYPE_SNIFF_BYTES = 4100`，宿主将来调大也不会嗅到截断样本。
- 纪律：接新工具或跟新宿主时，先枚举 `XxxOperations` 的**全部端口（含可选）**，再决定实现哪些。

## Considered Options

- **全部整份重写（R1，真正的根解）**：不再借命名空间，远端路径只用纯 posix 逻辑 + 我们的 ops。
  否决：丢掉宿主实现保真——`read` 的行号/图片处理、`edit` 的 `applyEditsToNormalizedContent`（BOM/行尾/
  唯一匹配语义）与 `details.diff`、`ls`/`find` 的格式化与限流**都未从包根导出**，要复刻且要长期手工跟宿主
  行为漂移；保真主线是这个特性的立身之本，R1 要重写 5 个 execute，须另立条目重新对齐。
- **改宿主 `dist/` 打补丁**：违反仓库红线 8（仓库外文件），只能用公开扩展 API 解决或提上游。
- **「同步下来改完传回去」整树镜像**：镜像会过期、有冲突风险、传的数据更多；`read`/`ls`/`find`/`bash`
  本就不需要同步，唯一绕不过的 `grep` 用重写而不是镜像。
- **UNC 形态 `\\pi-remote\…` 当信道**：Windows 上 `fs.realpath` 报 `UNKNOWN`（不是 ENOENT）⇒ write/edit 的
  本地文件变更队列直接抛错（真机验收抓到过）。否决。
- **URL 形式路径（如 `remote:/src/tmp`）**：这一层是宿主的 `node:path`/`node:fs` 在处理字符串——
  无前导 `/`、无盘符 ⇒ 被当**相对路径**拼到本机 cwd；硬凑成绝对（`C:\remote:\…`）又回到「本地可能真存在」
  的原点。否决（URL 风格可作为**模型侧语法**的独立议题，与本信道无关）。

## Consequences

- 信道是**内部实现细节**：模型侧契约仍是 `path`（远端绝对 POSIX）+ `remote`/`remotePort`/`remoteCwd`
  （对齐文档的扁平参数口径）；换信道不动模型面。
- 宿主对工具路径有**本地副作用**（read 的变体探测、write/edit 的 realpath 锁键）——卡片「坑」与本 ADR 的
  根因是同一件事；硬化后标记根是**结构上不可占用**的（C'），守卫（A）只是兜底。
- 代价：标记根路径比原 `C:\pi-remote` 长 ~90 字符，且随安装形态变化（全局扩展目录 / 包缓存 clone / 项目
  `.pi/extensions/`），单测不再断言常量前缀（用导出的 `HOST_PATH_ROOT`）。
- `grep` 渲染器丢失、宿主行为漂移需随宿主版本手工跟（`docs/extensions/remote-tools.md` 的
  `last verified @` 行就是这条纪律的落点）。
- 相关验收：单元 70（+7 真机 opt-in）、真机 7/7（WSL Ubuntu）、以及 `#7` 的复现实验（本地存在标记根 ⇒
  变体探测读错文件名、`paths.test.ts` 的 realpath 断言转红）。
