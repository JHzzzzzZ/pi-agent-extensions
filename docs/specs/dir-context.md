# dir-context — 目录作用域上下文注入（规格）

> 状态：已实现（v1.0.0 + v1.1，entry `dir-context-todo#1` / `#2`）
> 对齐记录：[`todos/align/dir-context-todo#1.md`](../align/dir-context-todo#1.md)·[`#2.md`](../align/dir-context-todo#2.md)·决策：[`docs/adr/0011-dir-context-scoped-injection.md`](../adr/0011-dir-context-scoped-injection.md)（v1.0.0）+ [`docs/adr/0012-dir-context-codemode.md`](../adr/0012-dir-context-codemode.md)（v1.1）

## 问题陈述

pi 原生只把 **agent dir + cwd + cwd 的全部祖先链** 的上下文文件放进系统提示（`loadProjectContextFiles()` 从 cwd 起一路 `dirname` 向上，无子树分支）。真实仓库是分层的：`src/AGENTS.md` 描述应用层约定、`src/components/AGENTS.md` 描述组件层约定——模型读 `src/components/Button.tsx` 时**拿不到这两份**，除非它自己去读（实战中它往往不读）。业界标准（agents.md 规范："the closest AGENTS.md to the edited file wins"）与 Claude Code（"loads each one once Claude reads, writes, or edits another file in that subdirectory"）都把「离被触碰文件最近的指令自动生效」当作默认行为。

## 方案

`pi.on("tool_result")` 上拦截「触碰了某个目录」的工具结果，把该目录到 cwd 之间、**严格位于 cwd 之下**的上下文文件追加成一个新的 text block。

触发面：`read` / `write` / `edit`（入参 `path` 所在目录，含**写新文件**）、`ls`（目标目录）、bash 里**恰好一个** `cat` / `head` / `tail` 单文件读的目标文件。`grep` / `find` 不做（递归搜索按 `path` 注入一层是近似而非精确）。bash 带重定向、变量展开、命令替换、多文件一律「拿不准」⇒ 不注入。

**codemode（v1.1）**：脚本里的 `tools.read/write/edit/ls/bash` 是嵌套调用（结果只回到脚本），但 codemode 的**顶层**工具结果带着每个嵌套调用的明细 `details.calls` ⇒ 在那里把明细翻译回同一套触碰语义（多个触碰取目录链并集），复用同一份去重/预算注入一次。

## 用户故事

- 作为在分层仓库里干活的用户，模型第一次读到 `src/components/` 下的文件时，`src/AGENTS.md` 与 `src/components/AGENTS.md` 自动进入上下文，我不必在提示里贴一遍。
- 作为在意 token 的用户，同一份文件在一次会话里只进一次上下文，`/compact` 之后才会重新按需加载。
- 作为在意安全边界的用户，模型读 cwd 之外的文件（宿主包目录、`../shared/`）时不会因为我在那里放了 AGENTS.md 而拖进一堆无关上下文。
- 作为排查问题的用户，`/dir-context` 能列出本会话已注入了哪些文件，footer 段 `<N> dir-context` 让我一眼看到发生了注入。

## 实现决策

1. **通道 = `tool_result` 追加 text block**：原 `content` 逐字保留在前；注入内容带 `Loaded <相对路径>` 抬头与 `<dir-context path="…">` 包裹，供 transcript 肉眼核对。备选（`turn_end` 独立消息 / 改 `tool_call` 入参 / `before_agent_start` 全量塞）见 ADR-0011。
2. **必须回传 `structuredContent`**：宿主明文契约规定「替换 `content` 而不返回 `structuredContent` 就丢掉结构化结果」（runner 真的 `delete`），`read` / `bash` 都产出它 ⇒ 原样回传（跨厂商评审 B1）。
3. **发现顺序**：每目录唯一一个、优先级 `AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`（与 pi 原生候选集合一致）、结果**由外向内**；返回 realpath 归一后的磁盘真名。
4. **作用域 fail-closed**：锚点经 `realpath` 归一后必须落在 cwd 之内（链接逃逸、`repo` vs `repo-evil` 前缀冒充、`../` 越界一律零注入）；cwd 自身的上下文文件不注入（pi 已加载）。
5. **去重与重载**：会话内每绝对路径一次；`session_start` / `session_compact` 清空缓存（compact 后上下文已不在窗口里，必须允许按需重载）。
6. **预算**：单文件 32 KiB、单次注入合计 128 KiB，按 UTF-8 码点边界截断；截断与丢弃都在块内留标记。
7. **降级**：`isError` 结果、无文本内容的结果、嵌套工具调用（`parentToolCallId`）、无候选目录、读取失败（只报一次告警，不标记已注入以便重试）——一律返回 `undefined` 透传原结果。
8. **codemode 补偿路径（v1.1）**：嵌套调用自身不注入；改在读它**顶层** codemode 结果的 `details.calls`（`{ name, args, status }`，`args` 是宿主的紧凑 JSON 截断预览），把每个条目翻译回第 1 条的触碰语义（`read`/`write`/`edit`/`ls` + bash 单文件读白名单）。多条触碰取目录链**并集**（同一文件一次、整体仍由外向内，`discoverContextFilesForAnchors`），与顶层共用同一份会话去重缓存与预算。`status` 为 `error`/`cancelled` **照算**（文件可能已被读写，注入与脚本成败无关）；非触碰工具、`args` 截断或非法 JSON、`isError` 的 codemode 结果一律跳过（少注入，不误注入）。判真伪用「工具名 `codemode` + `details.calls` 是数组」双重结构守卫——宿主的 `isCodemodeTool` 不在公开导出面（见 ADR-0012 的落地偏差）。
## 测试决策

- 框架 `node:test` + `node:assert/strict`；63 个（触碰识别 6 / 锚点解析 9 / 发现 13 / 注入与截断 8 / codemode 明细 10 / 宿主事件路径 17）。
- **宿主事件路径测试接真实实现**：`discoverAndLoadExtensions`（jiti 走真实 `index.ts`）+ 真实 `ExtensionRunner.emitToolResult`，只 fake `sessionManager` / `modelRegistry` / actions（本扩展不读它们）。风险点在宿主接缝上，纸面替身抓不到。
- 文件系统用**真实临时目录树**（realpath、链接、大小写不敏感正是被测对象），不用路径字符串替身。
- **codemode 补偿路径走真实宿主事件**：`details` 用真实 `CodemodeToolDetails` 形状（`calls[].{id,name,args,status}`）喂进真实 `ExtensionRunner.emitToolResult`，断言「注入后原 `content` 逐字保留、`details` 原样回传、只追加一个 text block」；纯逻辑（`args` 截断/非法 JSON/未知工具/结构守卫）在 `codemode.test.ts` 全覆盖。
- 平台条件跳过仅 2 处（创建文件符号链接需权限），skip 而非静默绿。
- 真机验收 A/B（真实 `pi -p`，模型 kimi-coding/k3-256k）：问「只读 Button.tsx，回答该目录暗号」——带扩展答出暗号且 transcript 里出现 `Loaded src/components/AGENTS.md`，不带扩展答「文件里没有暗号、按你的要求我没读其它文件」。
- **codemode 真机验收（v1.1）**：临时 agent 目录 + 真实 `pi --mode json -p --tools +codemode`（模型 `opencode-go/deepseek-v4-flash`），提示要求「必须用 codemode 脚本 `tools.read` 读深层文件」——codemode 工具结果里出现 `Loaded src/AGENTS.md` 与 `Loaded src/components/AGENTS.md`，且模型答得出只写在嵌套 `AGENTS.md` 里的暗号（同时验证 `details.calls` 的真实 `args` 形状可解析：`{"path":…,"offset":null,"limit":null}`）。

## 已知边界

- **codemode 路径对自带大载荷的工具覆盖弱于顶层**：`details.calls[].args` 是宿主的**截断预览**（`previewArgs` 上限 200 字符、超出加 `...` 尾），截断后不是合法 JSON ⇒ 该条跳过。`tools.read` / `tools.ls` / `tools.bash` 通常够短能解析，而 `tools.write`（带 `content`）与 `tools.edit`（带 `edits`）很容易超限 ⇒ **脚本里新建/编辑深层文件时可能拿不到局部约定**（顶层直接调用不受影响）。取舍是既定口径「少注入不误注入」；真要覆盖得向宿主动要完整入参（同期不做）。
- **判 codemode 依赖工具名字面量 `codemode`**：工具被改名/包装时补偿路径静默失效（顶层行为不受影响）。宿主的 `isCodemodeTool` 不在公开导出面，结构守卫已是当前可用的最紧判据。

## 范围外

不做 `.claude/rules/` 风格的 glob 路径作用域规则；不做 `@path` 导入展开；不做 cwd 之外注入；不做 `grep` / `find` 触发；不做 `settings.json` 配置项（v1 无开关）；不做 widget（避开 widget 排序带契约）。
