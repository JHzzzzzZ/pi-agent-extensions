# dir-context — 目录作用域上下文注入（规格）

> 状态：已实现（v1.0.0 + v1.1 + v1.2 + v1.3，entry `dir-context-todo#1` / `#2` / `#3` / `#4`）
> 对齐记录：[`todos/align/dir-context-todo#1.md`](../align/dir-context-todo#1.md)·[`#2.md`](../align/dir-context-todo#2.md)·[`#3.md`](../align/dir-context-todo#3.md)·[`#4.md`](../align/dir-context-todo#4.md)·决策：[`docs/adr/0011-dir-context-scoped-injection.md`](../adr/0011-dir-context-scoped-injection.md)（v1.0.0）+ [`docs/adr/0012-dir-context-codemode.md`](../adr/0012-dir-context-codemode.md)（v1.1）

## 问题陈述

pi 原生只把 **agent dir + cwd + cwd 的全部祖先链** 的上下文文件放进系统提示（`loadProjectContextFiles()` 从 cwd 起一路 `dirname` 向上，无子树分支）。真实仓库是分层的：`src/AGENTS.md` 描述应用层约定、`src/components/AGENTS.md` 描述组件层约定——模型读 `src/components/Button.tsx` 时**拿不到这两份**，除非它自己去读（实战中它往往不读）。业界标准（agents.md 规范："the closest AGENTS.md to the edited file wins"）与 Claude Code（"loads each one once Claude reads, writes, or edits another file in that subdirectory"）都把「离被触碰文件最近的指令自动生效」当作默认行为。

## 方案

`pi.on("tool_result")` 上拦截「触碰了某个目录」的工具结果，把该目录到 cwd 之间、**严格位于 cwd 之下**的上下文文件追加成一个新的 text block。

触发面：`read` / `write` / `edit`（入参 `path` 所在目录，含**写新文件**）、`ls`（目标目录）、bash 里**恰好一个** `cat` / `head` / `tail` 单文件读的目标文件。`grep` / `find` 不做（递归搜索按 `path` 注入一层是近似而非精确）。bash 带重定向、变量展开、命令替换、多文件一律「拿不准」⇒ 不注入。

**codemode（v1.1）**：脚本里的 `tools.read/write/edit/ls/bash` 是嵌套调用（结果只回到脚本），但 codemode 的**顶层**工具结果带着每个嵌套调用的明细 `details.calls` ⇒ 在那里把明细翻译回同一套触碰语义（多个触碰取目录链并集），复用同一份去重/预算注入一次。

**远端调用（v1.3）**：`remote-tools` 一类插件给工具加了 `remote="[user@]host"` 参数，带它则该次调用的 `path` 按**远端**规则解析（省略/相对路径按远端 `$HOME`，绝对 POSIX 路径直接用）。本扩展只看 `input.path` 并按本地 cwd 解锚点，于是远端相对路径（`docs/x.md`）会被当成本机同名路径 ⇒ **把本机约定喂给远端结果**（错注入，比不注入更危险）。修法：入参有非空 `remote` 即**零注入**（不看 `path`、不做锚点解析、不碰本地文件系统），只追加一行静态提示；字段缺失/空/纯空白/缺省值字面量 ⇒ 本地行为逐字不变。判据只看入参字段，**不 import remote-tools 任何模块**（两个插件各自独立安装/升级）。

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
5. **去重与重载**：同一绝对路径**每 turn 只给一次正文**（v1.6，`dir-context-todo#10`）——`turn_start` 是边界，同 turn 内同链的其余触碰结果补一行自闭合**指针**（无正文、不进预算/计数），跨 turn 不再重复；`session_start` / `session_compact` 清空两个集合（compact 后上下文已不在窗口里，必须允许按需重载）。
6. **预算**：单文件 32 KiB、单次注入合计 128 KiB，按 UTF-8 码点边界截断；截断与丢弃都在块内留标记。**「已注入」只标记真正进了文本的文件**：被预算丢弃的不算（否则后续触碰永久拿不到那份上下文，与读取失败的重试语义自相矛盾）；目录链并集让一次注入覆盖多个文件后，这条路径是常态。
7. **降级**：`isError` 结果、无文本内容的结果、嵌套工具调用（`parentToolCallId`）、无候选目录、读取失败（只报一次告警，不标记已注入以便重试）——一律返回 `undefined` 透传原结果。
8. **codemode 补偿路径（v1.1）**：嵌套调用自身不注入；改在读它**顶层** codemode 结果的触碰，把每个条目翻译回第 1 条的触碰语义（`read`/`write`/`edit`/`ls` + bash 单文件读白名单）。多条触碰取目录链**并集**（同一文件一次、整体仍由外向内），与顶层共用同一份会话去重缓存与预算。`status` 为 `error`/`cancelled` **照算**；非触碰工具、顶层 `isError` 的 codemode 结果一律跳过。判真伪用「工具名 `codemode` + `details.calls` 是数组」双重结构守卫——宿主的 `isCodemodeTool` 不在公开导出面（见 ADR-0012 的落地偏差）。
9. **主来源 = 嵌套事件的完整入参（v1.2）**：`details.calls[].args` 是宿主的 200 字符截断预览，带大载荷的 `tools.write` / `tools.edit` 必然解析失败。改为在嵌套 `tool_result` 事件（`parentToolCallId` 非空）上取**完整 `event.input`**，按发起它的顶层调用 id 缓冲，顶层 codemode 结果到达时取走；`details.calls` 解析降级为**兜底**，两源并集去重。缓冲有界（单组 64 条、最多 8 组、取走即删、会话 reset 清空），且**不看嵌套调用的 `isError`**（文件可能已被读写）。**取走判据只看工具名 `codemode`**（与 `details` 形状解耦：形状漂移或缺 `details` 时缓冲照样消费、缓冲触碰照样生效）——否则那组缓冲会永久残留、里面的触碰被白白丢掉（首轮评审发现）。真机探针证据（`pi --mode json -p --tools +codemode` + 只记日志的临时扩展）：嵌套 `write` 事件 `inputKeys=["path","content"]`、`path` 完整、`content` 长度 300，而同一调用的 `details.calls[].args` 长度恰为 200 且以 `...` 结尾。
10. **远端调用零注入（v1.3）**：判据是**入参字段**——`remote` 是非空字符串且不是缺省值字面量（`null`/`undefined`/`nil`/`none`/`n/a`/`na`，trim + 大小写无关；本插件自持一份小集合，不跨插件引用）。命中即跳过整条触碰链路（不看 `path`、不 resolveAnchor、不读文件系统），只追加一行静态提示（会话内一次，`session_start`/`session_compact` 重置）。**三条通路各自独立拦截**：① 顶层调用的入参；② 嵌套 `tool_result` 事件的 `input`（记触碰之前拦，否则记下的触碰会在顶层结果里变成错注入）；③ `details.calls` 兜底（独立于 ② 的第二来源，必须各自拦）。② 的远端记号汇到嵌套缓冲的 `remote` 位上，等顶层 codemode 结果到达时给提示（③ 只拦不注、**不记记号**——`detectCodemodeTouches` 是纯函数，拿不到缓冲；所以「只有在 `details.calls` 里可见的远端调用」（宿主不发嵌套事件时）会被静默跳过，方向安全：只是少一行提示）。提示**按入参字段附着、不限定工具**：带 `remote` 的 `grep` / `find`（不在触发面上、恒零注入）结果也会拿到那行提示——附着面比「触发工具」宽一档，方向安全（只是多一行文本）、会话内一次。
11. **远端目录自动注入（v1.4）**：见 `docs/cross/remote-context-capability.md`。消费方在 `session_start` 广播盒子收能力；命中触发面的远端触碰把**原始** `path`（+`kind`）交给对端解析（本侧不猜远端路径），拿回由外向内的文件列表后走 `inject.ts` 的既有去重/截断/预算；块头带 `remote="<host>"` 与 `Loaded <host>:<路径>`；三态 `injected`/`nothing`/`unavailable` 决定是否退回那行提示。codemode 路径把请求同样缓冲进嵌套分组、在顶层 codemode 结果代偿。
## 测试决策

- 框架 `node:test` + `node:assert/strict`；116 个（触碰识别 6 / 锚点解析 9 / 发现 13 / 注入与截断 8 / codemode 明细与缓冲 18 / 远端判据 7 / 远端上下文消费方 10 / 宿主事件路径 45）。
- **宿主事件路径测试接真实实现**：`discoverAndLoadExtensions`（jiti 走真实 `index.ts`）+ 真实 `ExtensionRunner.emitToolResult`，只 fake `sessionManager` / `modelRegistry` / actions（本扩展不读它们）。风险点在宿主接缝上，纸面替身抓不到。
- 文件系统用**真实临时目录树**（realpath、链接、大小写不敏感正是被测对象），不用路径字符串替身。
- **跨厂商评审一条 P2 已就地修复**（kimi-coding/k3-256k）：预算丢弃的文件曾被误标「已注入」而永不重试——修法是把 `injected` 标记移到 `buildInjection` 之后、只认 `injection.injected`，并用「五级目录 × 32 KiB（>128 KiB 上限）→ 最后一份被丢弃 → 下次触碰补上」的宿主用例锁定。
- **codemode 补偿路径走真实宿主事件**：`details` 用真实 `CodemodeToolDetails` 形状（`calls[].{id,name,args,status}`）喂进真实 `ExtensionRunner.emitToolResult`，断言「注入后原 `content` 逐字保留、`details` 原样回传、只追加一个 text block」；纯逻辑（`args` 截断/非法 JSON/未知工具/结构守卫）在 `codemode.test.ts` 全覆盖。
- 平台条件跳过仅 2 处（创建文件符号链接需权限），skip 而非静默绿。
- 真机验收 A/B（真实 `pi -p`，模型 kimi-coding/k3-256k）：问「只读 Button.tsx，回答该目录暗号」——带扩展答出暗号且 transcript 里出现 `Loaded src/components/AGENTS.md`，不带扩展答「文件里没有暗号、按你的要求我没读其它文件」。
- **远端零注入的真实函数 A/B（v1.3）**：把修复前源码（`git show HEAD:<file>`）与工作区两版各用 `discoverAndLoadExtensions` 加载一次，在真实 `ExtensionRunner` 上喂同一条事件 `read { path: "src/components/Button.tsx", remote: "prod" }`（本机**确实存在** `src/components/AGENTS.md`）——修复前追加块 1、注入 `Loaded src/AGENTS.md`；修复后追加块 1、注入「（无）」且文本为那行提示。宿主用例同时锁住：附带块时原 `content` 逐字保留为第一块、`structuredContent` 原样回传、状态条不写注入计数。
- **远端判据的本地側不变性**：字段缺失／空串／纯空白／缺省值字面量／非字符串五种变体在宿主路径上逐个跑「照常注入 `Loaded src/components/AGENTS.md` 且不出现提示」（每次 `session_compact` 清缓存以真正走一次注入）。

## 已知边界

- **远端判据是字段级启发式，方向永远是「少注入」**（v1.3）：第三方扩展若恰好也用 `remote` 表示别的意思，会被判成远端而不注入本地上下文（安全方向）；缺省值字面量集合与 remote-tools 若未来漂移，后果同样是少注入。不做 path 形态猜测——远端相对路径与本机相对路径在字符串层面不可区分。
- **远端目录的约定不会自动到**（v1.3）：模型需要自行 `read` 那份远端 `AGENTS.md`（多一次往返，决定权在模型）。远端 `grep`/`find` 不在本插件的触发面上。
- **`details.calls[].args` 的截断预览只是兜底**（v1.2 起）：主来源换成嵌套事件的完整 `input` 之后，`tools.write` / `tools.edit` 大载荷不再漏判（真机 A/B 已验：v1.2 注入、v1.1 零注入）。仍存在的边界是「宿主某个版本不发嵌套 `tool_result` 事件」——那时退回兜底，截断条目仍会被跳过（少注入，不误注入）。
- **判 codemode 依赖工具名字面量 `codemode`**：工具被改名/包装时补偿路径静默失效（顶层行为不受影响）。宿主的 `isCodemodeTool` 不在公开导出面，结构守卫已是当前可用的最紧判据。

## 范围外

**远端侧自动注入已实现（v1.4）**：v1.3 把远端调用改成零注入 + 一行提示后，`#6` 把它升级为**自动注入**——经宿主 `pi.events` 从 remote-tools 取回远端目录的祖先链（一条 ssh、由外向内、到远端 `$HOME` 或 `/` 为止），注入规则与本地完全共用；取不到就退回那行提示。方案与「为什么不在本侧 ssh」见 `todos/align/dir-context-todo#6.md` 与 `docs/cross/remote-context-capability.md`。
