# dir-context — 目录作用域上下文注入（嵌套 AGENTS.md on-demand）

> last verified @ e090c60

追加到当次工具结果里；带 `remote` 的调用**默认零注入**（远端路径不可与本机路径混解），装了 remote-tools 时改走能力协商**自动注入远端那条祖先链**。

规格：`docs/specs/dir-context.md`·跨扩展契约：[`docs/cross/remote-context-capability.md`](../cross/remote-context-capability.md)（与 remote-tools 的能力协商）·决策：`docs/adr/0011-dir-context-scoped-injection.md`（通道/边界/去重）+ `docs/adr/0012-dir-context-codemode.md`（codemode，v1.1 已实现）·对齐：`todos/align/dir-context-todo#1.md`、`#6.md`。

## 为什么这么做

pi 原生只加载 **agent dir + cwd + cwd 的全部祖先链**（`dist/core/resource-loader.js` 的 `loadProjectContextFiles()` 一路 `dirname` 向上），**子树一概不读**；而真实仓库是分层的（`src/AGENTS.md`、`src/components/AGENTS.md`）。业界标准（agents.md 规范：*"the closest AGENTS.md to the edited file wins"*）与 Claude Code 的官方语义（*"loads each one once Claude reads, writes, or edits another file in that subdirectory"*）都是**按需加载子树**。本扩展就是补这一格，且比 Claude 多覆盖两家已有 pi 扩展（`pi-subdir-context`、`pi-nested-agents-md`）都只做的 `read`：**write 新文件 / ls / bash 单文件读也触发**。

## 不变量（改代码前必须知道）

- **只动 `tool_result`，且只追加**：原 `content` 逐字保留在前，注入文本作为**新的最后一个 text block**。注入失败/无候选一律返回 `undefined`（宿主透传原结果）——本扩展永不改坏工具结果本身。
- **必须回传 `structuredContent`**：宿主明文契约是「替换 `content` 而不返回 `structuredContent` **就丢掉结构化结果**」（`ToolResultEventResult` 注释 + runner 真的 `delete`），而 `read` / `bash` 都产出 `structuredContent`，两者都在本插件触发面上 ⇒ 注入时必须原样回传，否则 transcript 里的结构化数据静默丢失（跨厂商评审 B1，回归测试锁在宿主机用例里）。
- **无文本内容的结果不注入**：纯图片结果（如读取截图）追加元信息没有落点（spec 范围 6）。
- **cwd 之外零注入**：锚点经 `realpath` 归一后必须落在 cwd 之内（`paths.ts` 的 `isInside` 用 `path.relative`，`repo` 与 `repo-evil` 必须区分）；链接逃逸同样 fail-closed。cwd 自身的上下文文件**不注入**（pi 启动时已放进系统提示，重复注入纯浪费 token）。
- **顺序 = 由外向内**：祖先在前、最靠近锚点的最后；同目录只取一个（`AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`，与 pi 原生的文件集合一致）。
- **去重键是绝对路径，作用域是会话**：同一文件只注入一次；`session_compact` / `session_start` 清空缓存——compact 会把先前的注入从上下文里抹掉，必须允许**按需重载**（Claude 同语义），否则那段上下文永久丢失。`session_shutdown` 只清状态段登记。
- **嵌套工具调用（`event.parentToolCallId`）不注入**：这类结果只回到调用方工具（如 codemode 脚本），不进 transcript，注入没有意义。
- **codemode 走「顶层结果代偿」（v1.1 起）**：脚本里的 `tools.read/write/edit/ls/bash` 不直接注入，改在读它**顶层** codemode 结果的触碰；多个触碰取目录链**并集**（同一文件一次、整体仍由外向内），与顶层共用同一份会话缓存与预算。**主来源 = 嵌套 `tool_result` 事件的完整 `input`**（v1.2，宿主不截断）：按发起它的顶层调用 id 缓冲，顶层结果到达时取走；`details.calls[].args`（宿主 200 字符截断预览）降级为**兜底**，两源并集去重。`status` 为 `error`/`cancelled` 的嵌套调用**照算**（缓冲不看 `isError`：文件可能已被读写）；非触碰工具、顶层 `isError` 的 codemode 结果一律跳过。
- **嵌套触碰缓冲有界**（v1.2）：按顶层调用 id 分组（`parentToolCallId` == 顶层 `toolCallId`）；**取走判据 = 工具名 `codemode`**（与 `details` 形状解耦——形状漂移或缺 `details` 时该组照样消费、且缓冲触碰照旧生效）；单组 64 条（超出丢后续：少记不误记）、同时最多 8 组（超出淘汰最旧的组）；顶层结果到达**取走即删**（失败的顶层结果也消费该组，不跨结果残留）；`session_start` / `session_compact` / `session_shutdown` 清空。
- **远端调用：默认零注入，装了对端才自动注入（v1.3 起，v1.4 扩展）**：入参带非空 `remote` 时 `path` 在**远端**解析，按本地 cwd 解锚点会错注入（把本机同名路径的约定喂给远端结果）⇒ v1.3 一律零注入 + 一行提示。v1.4 起：若 `session_start` 的能力协商拿到了 remote-tools 提供的 `fetchRemoteContext`，就对**触发面上**的远端触碰申请远端上下文（一条 ssh 取完整条祖先链，由外向内、每目录取一个），去重/截断/预算/块格式**复用本地那一套**；块头标来源（`Loaded <host>:<远端绝对路径>` + `<dir-context remote="<host>" path="…">`）。**三态**：`injected`（注入了 ⇒ 不再追加提示）/ `nothing`（已注入过、或远端确实没有约定文件 ⇒ 不是失败也不提示）/ `unavailable`（没装对端或这一趟取失败 ⇒ 退回那行提示）。判据只看入参字段、**不 import remote-tools 任何模块**；字段缺失／空串／纯空白／缺省值字面量／非字符串 ⇒ 本地行为逐字不变。三条通路各自独立拦截：顶层调用、嵌套 `tool_result` 事件、`details.calls` 兜底。提示文案静态（不插值 host 等模型输入）、会话内一次、`session_start` / `session_compact` 后重置；提示**按入参字段附着，不限定工具**（`grep`/`find` 带 `remote` 也给提示，但不申请远端上下文）。
- **`isError` 结果不注入**：失败结果里追加指令只会污染错误诊断。注意与「嵌套调用 `isError` 照算」分开读：前者管**正在注入的那次结果**，后者管**被缓冲的触碰**。
- **bash 是保守白名单**：只认整条命令里**恰好一个** `cat` / `head` / `tail` 的单文件目标；带重定向（`>`/`<`）、变量展开（`$`/反引号）、多文件、非白名单命令一律「拿不准」⇒ 零注入。漏判只是少注入，误判最多多注入一个目录。
- **预算是硬上限**：单文件 32 KiB、单次注入合计 128 KiB，按 UTF-8 **码点**边界截断（绝不劈开多字节字符/代理对），被截断/被丢弃都在块内留标记。**「已注入」只标记真正进了文本的文件**：被预算丢弃的不算（否则后续触碰永久拿不到那份上下文——与读取失败的重试语义自相矛盾）；目录链并集让一次注入覆盖多个文件后，这条路径是常态（外部评审 P2）。
- **发现用磁盘真名、链接逃逸整个跳过**：探到候选名后走 `realpathSync.native` 取磁盘上的真实文件名再返回（Windows 大小写不敏感的文件系统会让探 `AGENTS.md` 命中 `AGENTS.MD`，返回探针名会让 transcript 的 `Loaded` 行指向不存在的文件）；若真实位置落在 cwd 之外（文件级链接逃逸）则该候选**整个跳过**——fail-closed，与「cwd 之外零注入」同一口径，既不注入外部内容也不把外部路径展示出去。
- **状态段走契约**：footer 键 `70:dir-context`（`docs/cross/status-bar.md`），文本 `<N> dir-context`，**只在真的注入过之后出现**；写入必须经 `status-band.ts` 的 `writeBand`，`session_shutdown` 清登记。

## 文件地图

- `index.ts` — 接线：`tool_result` / `session_start` / `session_compact` / `session_shutdown` + 命令面（`/dir-context`、`/dir-context:status`）+ 已注入清单
- `touch.ts` — 工具 + 入参 → 被触碰的路径（含 bash 单文件读白名单与引号感知切词）
- `remote.ts` — 远端调用判据（只读入参 `remote` 字段；缺省值字面量集合自持一份）+ 一行提示文案
- `remote-context.ts` — 远端上下文的**消费方**：能力握手（`pi.events` 收集频道）、请求/结果双向形状守卫、把对端给的文件合成本地同一套注入条目（去重键 `remote:<host>\0<路径>`）
- `codemode.ts` — 触碰提取与缓冲（纯函数）：顶层 codemode 结果双重判真（工具名 `codemode` + `details.calls` 结构）、`args` 解析容错、`dedupeTouches` 并集去重、`createNestedTouchBuffer`（按顶层调用 id 归组的嵌套触碰缓冲，有界）
- `anchor.ts` — 被触碰的路径 → 锚点目录（目录类触碰指向文件时退到父目录）+ cwd 包含校验
- `discover.ts` — 锚点 → cwd 之间的每级唯一上下文文件（由外向内）
- `inject.ts` — 注入文本格式、码点安全截断、预算（纯函数）
- `paths.ts` — `canonicalize`（不存在路径也成立：最深的已存在祖先 + 尾巴）/ `isInside` / `toDisplayPath`
- `errors.ts` — 本层错误码（本扩展只有两类「本该注入却失败」）
- `status-band.ts` — 第七份 footer 段前缀协调拷贝（契约同源，勿改语义）

## 坑

- **`isCodemodeTool` 不在宿主的公开导出面**：pi 1.1.0 的包入口只导出 `CodemodeToolDetails` 类型，`isCodemodeTool` 只存在于内部模块（`dist/extensions/codemode/tool.d.ts`）⇒ ADR-0012 里「用它判真伪」落不了地（红线 8：不改宿主、不 import 内部路径）。改用「工具名 `codemode` + `details.calls` 是数组」双重判真；同名第三方工具不带这个结构就不会误伤。
- **`details.calls[].args` 是宿主的截断预览**（`previewArgs` 上限 200 字符、超出加 `...` 尾）：它**只是兜底**——主来源是嵌套 `tool_result` 事件的完整 `input`（宿主 `_afterToolCall({…, args}, parentToolCallId)` 对嵌套调用同样派发 hook，`input` 未截断）。截断时 `JSON.parse` 失败就跳过那一条（少注入，不误注入），**别把它「修」成猜 JSON**；排查「为什么没注入」先确认嵌套事件到没到（只记日志的临时探针扩展即可）。
- **判 codemode 用的是工具名字面量**：宿主不允许脚本里再起脚本（无递归风险），但工具被改名/包装时补偿路径静默失效（顶层行为不受影响）。
- **非 codemode 的嵌套调用也会占缓冲组**：记录时刻只看得到 `parentToolCallId`、看不到父工具身份，所以其它扩展经 `ctx.executeTool` 发起的 `read`/`write`/… 嵌套调用同样被记；它们永不 `take`，只能靠组数上限（8）淘汰或会话 reset 回收。后果 = 极端并发下可能挤掉「马上要用」的 codemode 组（**只少注入，不误注入**）。别为它加猜测式过滤（拿不到父身份，任何过滤都是猜）。
- **Windows 上目录 symlink 需要管理员权限**：链接逃逸用例必须用 `junction`（普通权限可用）；建不出来时 `t.skip` 而不是静默绿。
- **测试的临时目录要 `realpathSync.native` 归一**：被测实现返回 canonical 路径，期望值不归一就会在 Windows 上因大小写/短路径差异假红。
- **`ExtensionRunner` 的第 3 个构造参数就是 `ctx.cwd`**（不是扩展目录）：宿主集成测试里必须传临时项目目录。
- **命令 handler 的 ctx 要用 `runner.createCommandContext()`**：手搓空对象会让 `ctx.ui` 为 undefined。
- **状态写入会重复渲染**：`writeBand` 的登记表是 `globalThis` 级、跨用例存活的，`session_start` 会以 `undefined` 调一次 writer——断言时要过滤 `undefined`（那是清登记，不是可见文本）。
- **`install-smoke` 的 `uiKeys` 不能列 `70:dir-context`**：启动期只清登记、不写可见文本（与 jev-safe-gate 同理）。
- **与第三方扩展同装会重复注入**：`pi-subdir-context` / `pi-nested-agents-md` 都在 `read` 路径注入，同装即同一份 AGENTS.md 进两次上下文（功能不冲突，只是浪费 token）。README 里已写明二者不要同装。
- **远端判据是字段级启发式，方向永远是「少注入」**（v1.3）：第三方扩展若恰好也用 `remote` 表示别的意思，会被判成远端而**不**注入本地上下文（安全方向）；缺省值字面量集合与 remote-tools 若未来漂移，后果同样是少注入。别把它「修」成看 `path` 形态——远端相对路径与本机相对路径在字符串层面不可区分，任何按 path 形态的猜测都回到错注入。
- **不覆盖 `grep` / `find`**：递归搜索的 `path` 只能注入一层，是近似而非精确，容易喂错上下文（v1 明确不做）。

## 测试与验证

（116 个：触碰识别 6 / 锚点解析 9 / 发现 13（含 2 个平台条件跳过）/ 注入与截断 8 / codemode 明细与缓冲 18 / 远端判据 7 / 远端上下文消费方 10 / 宿主事件路径 45）
- 宿主事件路径测试走**真实 `discoverAndLoadExtensions`（jiti 走 index.ts）+ 真实 `ExtensionRunner.emitToolResult`**，只 fake `sessionManager` / `modelRegistry` / actions（本扩展不读它们）；文件系统是真实临时目录树（realpath 与包含校验正是被测对象）。
- **远端零注入的真机/真实函数 A/B（v1.3）**：同一条事件 `read { path: "src/components/Button.tsx", remote: "prod" }`（本机**确实存在** `src/components/AGENTS.md`）——修复前（HEAD）注入 `Loaded src/AGENTS.md`，修复后零注入 + 一行提示；A/B 脚本把两个版本各加载一次（`git show HEAD:<file>` 取出旧源码到临时目录）后在真实 `ExtensionRunner` 上跑同一条事件。
- **远端自动注入的真机 A/B（v1.4）**：真实 `pi` + 真实 remote-tools + 真实 ssh 到本机 WSL（远端用其自带的 `~/.hermes/hermes-agent/` 多层真实 `AGENTS.md`，**不在远端写任何文件**），本地另造同名目录 + 诱饵 `AGENTS.md`——v1.3 对照：零注入 + 一行提示；v1.4：注入两条由外向内的远端块（带 `user@localhost:` 来源）、无提示、本地诱饵零泄漏；同文件连读两次：第二次纯透传。
- **2 个平台条件跳过**：创建文件符号链接需要权限（Windows 需管理员/开发者模式），建不出来时 `t.skip` 而非静默绿（Linux/macOS 上会真跑）。
- 真机验收：在真实会话里读一个深层文件（如 `src/extensions/pwr/engine/spec.ts`），transcript 里出现 `Loaded <相对路径>` 且内容正确；`/dir-context` 能列出已注入清单。
- **codemode 真机验收（v1.1）**：临时 agent 目录 + 真实 `pi --mode json -p --tools +codemode`，让模型用脚本 `tools.read` 读深层文件——codemode 工具结果里出现 `Loaded <相对路径>`，且模型答得出只写在嵌套 `AGENTS.md` 里的暗号（观测脚本：临时目录自建，跑完删除）。
- **codemode 写大载荷真机 A/B（v1.2）**：同一脚本让模型用 `tools.write` 写 300 字符内容（`details.calls[].args` 必被截断）——v1.2 注入且答出暗号；v1.1 对照组零注入、模型答「看不到任何相关内容」。这条对照是本次改进的验收证据。
- 上游对照物：Claude Code 官方文档（`code.claude.com/docs/en/memory` 的 "How CLAUDE.md files load"）；两个先行 pi 扩展只钩 `read`，本扩展的差异面就是 `write`/`edit`/`ls`/bash 与「写新文件也触发」。
