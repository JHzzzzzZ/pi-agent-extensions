# dir-context — 目录作用域上下文注入（嵌套 AGENTS.md on-demand）

> last verified @ 待定（合入后回填）

一句话：模型**触碰某个目录**（`read` / `write` / `edit` / `ls` / bash 单文件读）时，把该目录到 cwd 之间、**严格位于 cwd 之下**的 `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` 追加到当次工具结果里。

规格：`docs/specs/dir-context.md`·决策：`docs/adr/0011-dir-context-scoped-injection.md`·对齐：`todos/align/dir-context-todo#1.md`。

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
- **`isError` 结果不注入**：失败结果里追加指令只会污染错误诊断。
- **bash 是保守白名单**：只认整条命令里**恰好一个** `cat` / `head` / `tail` 的单文件目标；带重定向（`>`/`<`）、变量展开（`$`/反引号）、多文件、非白名单命令一律「拿不准」⇒ 零注入。漏判只是少注入，误判最多多注入一个目录。
- **预算是硬上限**：单文件 32 KiB、单次注入合计 128 KiB，按 UTF-8 **码点**边界截断（绝不劈开多字节字符/代理对），被截断/被丢弃都在块内留标记。
- **发现用磁盘真名、链接逃逸整个跳过**：探到候选名后走 `realpathSync.native` 取磁盘上的真实文件名再返回（Windows 大小写不敏感的文件系统会让探 `AGENTS.md` 命中 `AGENTS.MD`，返回探针名会让 transcript 的 `Loaded` 行指向不存在的文件）；若真实位置落在 cwd 之外（文件级链接逃逸）则该候选**整个跳过**——fail-closed，与「cwd 之外零注入」同一口径，既不注入外部内容也不把外部路径展示出去。
- **状态段走契约**：footer 键 `70:dir-context`（`docs/cross/status-bar.md`），文本 `<N> dir-context`，**只在真的注入过之后出现**；写入必须经 `status-band.ts` 的 `writeBand`，`session_shutdown` 清登记。

## 文件地图

- `index.ts` — 接线：`tool_result` / `session_start` / `session_compact` / `session_shutdown` + 命令面（`/dir-context`、`/dir-context:status`）+ 已注入清单
- `touch.ts` — 工具 + 入参 → 被触碰的路径（含 bash 单文件读白名单与引号感知切词）
- `anchor.ts` — 被触碰的路径 → 锚点目录（目录类触碰指向文件时退到父目录）+ cwd 包含校验
- `discover.ts` — 锚点 → cwd 之间的每级唯一上下文文件（由外向内）
- `inject.ts` — 注入文本格式、码点安全截断、预算（纯函数）
- `paths.ts` — `canonicalize`（不存在路径也成立：最深的已存在祖先 + 尾巴）/ `isInside` / `toDisplayPath`
- `errors.ts` — 本层错误码（本扩展只有两类「本该注入却失败」）
- `status-band.ts` — 第七份 footer 段前缀协调拷贝（契约同源，勿改语义）

## 坑

- **Windows 上目录 symlink 需要管理员权限**：链接逃逸用例必须用 `junction`（普通权限可用）；建不出来时 `t.skip` 而不是静默绿。
- **测试的临时目录要 `realpathSync.native` 归一**：被测实现返回 canonical 路径，期望值不归一就会在 Windows 上因大小写/短路径差异假红。
- **`ExtensionRunner` 的第 3 个构造参数就是 `ctx.cwd`**（不是扩展目录）：宿主集成测试里必须传临时项目目录。
- **命令 handler 的 ctx 要用 `runner.createCommandContext()`**：手搓空对象会让 `ctx.ui` 为 undefined。
- **状态写入会重复渲染**：`writeBand` 的登记表是 `globalThis` 级、跨用例存活的，`session_start` 会以 `undefined` 调一次 writer——断言时要过滤 `undefined`（那是清登记，不是可见文本）。
- **`install-smoke` 的 `uiKeys` 不能列 `70:dir-context`**：启动期只清登记、不写可见文本（与 jev-safe-gate 同理）。
- **与第三方扩展同装会重复注入**：`pi-subdir-context` / `pi-nested-agents-md` 都在 `read` 路径注入，同装即同一份 AGENTS.md 进两次上下文（功能不冲突，只是浪费 token）。README 里已写明二者不要同装。
- **不覆盖 `grep` / `find`**：递归搜索的 `path` 只能注入一层，是近似而非精确，容易喂错上下文（v1 明确不做）。

## 测试与验证

- `cd src/extensions/dir-context && npm install && npm test && npm run typecheck`（46 个：触碰识别 6 / 锚点解析 9 / 发现 10（含 2 个平台条件跳过）/ 注入与截断 8 / 宿主事件路径 13）
- 宿主事件路径测试走**真实 `discoverAndLoadExtensions`（jiti 走 index.ts）+ 真实 `ExtensionRunner.emitToolResult`**，只 fake `sessionManager` / `modelRegistry` / actions（本扩展不读它们）；文件系统是真实临时目录树（realpath 与包含校验正是被测对象）。
- **2 个平台条件跳过**：创建文件符号链接需要权限（Windows 需管理员/开发者模式），建不出来时 `t.skip` 而非静默绿（Linux/macOS 上会真跑）。
- 真机验收：在真实会话里读一个深层文件（如 `src/extensions/pwr/engine/spec.ts`），transcript 里出现 `Loaded <相对路径>` 且内容正确；`/dir-context` 能列出已注入清单。
- 上游对照物：Claude Code 官方文档（`code.claude.com/docs/en/memory` 的 "How CLAUDE.md files load"）；两个先行 pi 扩展只钩 `read`，本扩展的差异面就是 `write`/`edit`/`ls`/bash 与「写新文件也触发」。
