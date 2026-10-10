# dir-context — 目录作用域上下文注入（规格）

> 状态：已实现（v1.0.0，entry `dir-context-todo#1`）
> 对齐记录：[`todos/align/dir-context-todo#1.md`](../align/dir-context-todo#1.md)·决策：[`docs/adr/0011-dir-context-scoped-injection.md`](../adr/0011-dir-context-scoped-injection.md)（v1.0.0）+ [`docs/adr/0012-dir-context-codemode.md`](../adr/0012-dir-context-codemode.md)（v1.1，待实现）

## 问题陈述

pi 原生只把 **agent dir + cwd + cwd 的全部祖先链** 的上下文文件放进系统提示（`loadProjectContextFiles()` 从 cwd 起一路 `dirname` 向上，无子树分支）。真实仓库是分层的：`src/AGENTS.md` 描述应用层约定、`src/components/AGENTS.md` 描述组件层约定——模型读 `src/components/Button.tsx` 时**拿不到这两份**，除非它自己去读（实战中它往往不读）。业界标准（agents.md 规范："the closest AGENTS.md to the edited file wins"）与 Claude Code（"loads each one once Claude reads, writes, or edits another file in that subdirectory"）都把「离被触碰文件最近的指令自动生效」当作默认行为。

## 方案

`pi.on("tool_result")` 上拦截「触碰了某个目录」的工具结果，把该目录到 cwd 之间、**严格位于 cwd 之下**的上下文文件追加成一个新的 text block。

触发面：`read` / `write` / `edit`（入参 `path` 所在目录，含**写新文件**）、`ls`（目标目录）、bash 里**恰好一个** `cat` / `head` / `tail` 单文件读的目标文件。`grep` / `find` 不做（递归搜索按 `path` 注入一层是近似而非精确）。bash 带重定向、变量展开、命令替换、多文件一律「拿不准」⇒ 不注入。

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
## 测试决策

- 框架 `node:test` + `node:assert/strict`；46 个（触碰识别 6 / 锚点解析 9 / 发现 10 / 注入与截断 8 / 宿主事件路径 13）。
- **宿主事件路径测试接真实实现**：`discoverAndLoadExtensions`（jiti 走真实 `index.ts`）+ 真实 `ExtensionRunner.emitToolResult`，只 fake `sessionManager` / `modelRegistry` / actions（本扩展不读它们）。风险点在宿主接缝上，纸面替身抓不到。
- 文件系统用**真实临时目录树**（realpath、链接、大小写不敏感正是被测对象），不用路径字符串替身。
- 平台条件跳过仅 2 处（创建文件符号链接需权限），skip 而非静默绿。
- 真机验收 A/B（真实 `pi -p`，模型 kimi-coding/k3-256k）：问「只读 Button.tsx，回答该目录暗号」——带扩展答出暗号且 transcript 里出现 `Loaded src/components/AGENTS.md`，不带扩展答「文件里没有暗号、按你的要求我没读其它文件」。

## 已知缺口（v1.1 已决策、待实现）

**codemode 脚本内的触碰不触发注入**。嵌套调用（`tools.read/write/edit/ls/bash` 从脚本里发起）的结果只回到调用方脚本、不进 transcript（宿主 `docs/extensions.md`），所以 v1.0.0 有意跳过 `parentToolCallId`；代价是模型改用 codemode 干活时又拿不到局部约定。

已定方案（未实现，见 [ADR-0012](../adr/0012-dir-context-codemode.md)、工单 `dir-context-todo#2`）：在 **codemode 自身的顶层结果**上读 `details.calls`（`CodemodeNestedCall { name, args, status }`，`args` 是紧凑 JSON 预览），复用本规格第 3-7 条的发现/顺序/去重/预算注入一次；`error`/`cancelled` 的嵌套调用照算，`args` 截断或解析失败则跳过。**代码现状仍是跳过嵌套调用**，勿把该方案当已实现行为读。

## 范围外

不做 `.claude/rules/` 风格的 glob 路径作用域规则；不做 `@path` 导入展开；不做 cwd 之外注入；不做 `grep` / `find` 触发；不做 `settings.json` 配置项（v1 无开关）；不做 widget（避开 widget 排序带契约）。
