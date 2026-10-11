# 对齐：dir-context-todo#3 — codemode 嵌套调用的完整入参来源（方案 1）

- 条目：`dir-context-todo#3`（tags: `codemode`, `enhancement`，priority 7）· 分支引用：`feat/dir-context-nested-touches`（待第二次 claim 写入）
- 日期：2026-10-11（UTC）· 参与：用户（提出质疑 + 确认四项决策）+ agent（真机探针验证与方案）
- 状态：**已对齐**（用户 2026-10-11 回复「确认」）

## 意图

`dir-context-todo#2` 交付的 codemode 补偿路径有一个已知边界：**`details.calls[].args` 是宿主的截断预览**（`previewArgs` 上限 200 字符、超出加 `...` 尾）。脚本里的 `tools.write`（带文件内容）与 `tools.edit`（带 old/new 文本）几乎必然超限 ⇒ `JSON.parse(整串)` 失败 ⇒ 该条跳过 ⇒ **那一轮不注入**。

用户质疑（本会话）：「你为啥要管输入的 content 参数？你不是应该只管 name 和 path 参数吗？」——这个质疑是对的：本扩展**从来只读 `name` 与 `path`**，问题不在读了 `content`，而在于**宿主给的是「整个 args 序列化成的一个字符串」，字段级访问不存在**：我把整串交给 `JSON.parse`，截断即整体失败，连带丢掉了明明完整躺在串首的 `path`。

同一轮探索还发现一条**更好的数据来源**：codemode 脚本里的嵌套调用**也会触发扩展的 `tool_result` 事件**（`parentToolCallId` 非空），而该事件的 `input` 是**完整（未截断）入参**。

**真机探针证据**（2026-10-11，临时 agent 目录 + 真实 `pi --mode json -p --tools +codemode`，模型 `opencode-go/deepseek-v4-flash`，脚本 `tools.write({path, content: 300 个 x})` + `tools.read({path})`）：

```
嵌套  write     callId=call_00_B2TJ…/1   inputKeys=["path","content"]  path=src/components/New.tsx  contentLen=300
嵌套  read      callId=call_00_B2TJ…/2   inputKeys=["path"]            path=src/components/New.tsx
顶层  codemode  callId=call_00_B2TJ…     details.calls=[{name:"write", argsLen:200, argsTail:"…xxxx..."},{name:"read", argsLen:33}]
```

⇒ 嵌套事件的 `input` 完整；`parentToolCallId`（及 `toolCallId` 的 `<顶层 id>/<n>` 前缀）正好把嵌套调用归到**发起它的那次顶层 codemode 调用**上；顶层结果的 `details.calls[].args` 确实在 200 字符处被截断。
（宿主源码佐证：`agent-session.js` 的 `_afterToolCall({toolCall, args, result, isError}, parentToolCallId)` 对嵌套调用同样派发 `tool_result`，`input: args` 是原始未截断入参；codemode 的 `tool.d.ts` 亦明文写「Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so validation, `tool_call`/`tool_result` hooks, and permission checks apply exactly as for direct calls」。）

## 范围

**做什么（方案 1：嵌套事件的完整 input 为主，`details.calls` 降级为兜底）**

1. 新增「嵌套触碰缓冲」：收到 `parentToolCallId` 非空的 `tool_result` 时，用**完整 `event.input`** 跑既有的 `detectTouch`，把触碰记到该 `parentToolCallId` 名下（**不看 `isError`**，见决策 1）。
2. 顶层 codemode 结果到达时（`detectCodemodeTouches` 判真为 codemode）：取该 `toolCallId` 名下的缓冲触碰 **∪** 由 `details.calls` 解析出的触碰（同 `kind + rawPath` 去重），走既有流程（锚点解析 → 目录链并集 → 会话去重 → 预算 → 注入一次）。
3. 缓冲生命周期：按顶层 callId 分组；顶层结果到达即删该组；`session_start` / `session_compact` / `session_shutdown` 清空全部；每组条目数上限让内存有界。
4. 嵌套调用自身仍然**零注入**（结果只回到脚本、不进 transcript）——不变的 v1.0 语义。
5. 文档四面同步：卡片（`docs/extensions/dir-context.md`，含 `last verified`）、规格（`docs/specs/dir-context.md`）、根 README 的 dir-context 小节、插件 README；ADR-0012 补本条为「v1.2 落地补充」；`CONTEXT.md` 术语（「嵌套触碰缓冲」）；`docs/INDEX.md` 路由行同步。

**明确不做什么**

- 不改宿主、不 import 宿主内部路径（红线 8）；不向上游要「完整 args」（本方案已不需要）。
- 不做截断 JSON 的前缀抽取（会话里评估过的选项 2）：最坏情况会按误读的 `path` 注入**错误目录**的上下文，收益不抵风险。
- 不动顶层工具行为：`read`/`write`/`edit`/`ls`/bash 的直接调用路径逐字不变。
- 不改去重键、预算上限、排序口径、状态条契约。
- 不删 `details.calls` 解析路径（它是缓冲之外的第二来源，见决策 2）。

## 验收标准

1. **主路径生效**：一次 codemode 脚本里 `tools.write`（`content` 长度 300，即 `details.calls[].args` 必被截断那类）+ `tools.read` ⇒ 顶层结果里出现一次注入，含该目录链，且**不依赖** `details.calls`。
2. **不靠截断预览**：把顶层结果的 `details` 换成 `{ calls: [] }`（模拟预览不可用）⇒ 仍按嵌套缓冲注入（宿主事件路径测试锁定）。
3. **并集去重**：缓冲与 `details.calls` 同时给出同一路径 ⇒ 只注入一次；两条来源给出不同路径 ⇒ 目录链并集、仍由外向内。
4. **归组隔离**：两次 codemode 调用的嵌套事件互不串味（各自只拿自己 `parentToolCallId` 的缓冲）；顶层结果到达后该组缓冲删除（同 callId 再来一次不会重复计）。
5. **嵌套仍零注入**：嵌套调用的 `tool_result` 返回值逐字不变（返回 `undefined`）；顶层 codemode 结果 `isError` 时零注入。
6. **错误照算**：嵌套调用 `isError`（或宿主判定 cancelled）时其触碰**照算**（文件可能已被读写）。
7. **缓冲有界**：单组超过条目上限时丢弃后续触碰（只影响少注入，不影响正确性），并有测试锁定上限行为。
8. **纯逻辑 + 宿主路径双层测试**：缓冲归组/上限/并集去重走纯函数单测；端到端注入走真实 `ExtensionRunner.emitToolResult`（真实临时目录树）。
9. `npm test` + `npm run typecheck` 全绿；全仓 `test:all` 套件全绿（已知 `root:todo` 负载 flake 除外，`todo-cli#20`）。
10. **真机验收**：真实 `pi --tools +codemode` 让模型用脚本 `tools.write` 写大内容到深层目录 ⇒ codemode 结果里出现 `Loaded <相对路径>`，且模型答得出只写在嵌套 `AGENTS.md` 里的暗号。
11. **跨厂商独立评审**（红线 11）：reviewer 与开发者不同模型家族，逐条处理直到某轮无新意见。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-11（UTC）· **方式**：对话内确认（agent 先出真机探针证据 + 4 项决策与推荐值，用户回复「确认」）
- **逐条决策（全部按 agent 推荐值落定）**：
  1. **嵌套调用的 `isError` / cancelled = 照算**：缓冲**不看** `isError`（文件可能已经被读写，注入与脚本成败无关）；顶层 codemode 结果 `isError` 仍不注入（v1.1 口径不变）。
  2. **缓冲 ∪ `details.calls` = 取并集**（保留 `details.calls` 解析作兜底，不删代码）：主路径不再依赖截断预览；若宿主哪天不发某些嵌套事件，兜底仍能拿到路径，不会退化成零注入。
  3. **缓冲边界 = 按顶层 callId 分组 + 每组 64 条上限 + 顶层结果到达即删该组 + 会话 reset/shutdown 清空**：两个并行 codemode 不串味，内存有界；超限丢弃新条目（只少注入）。
  4. **嵌套里认的工具 = 完全复用 `detectTouch`**（`read`/`write`/`edit`/`ls` + bash 白名单单文件读）：与顶层、与 #2 同一套触发语义，不引入第二套。
- **已知风险（显式接受）**：① 缓冲只在「宿主确实派发嵌套 `tool_result`」时有效——探针已实测成立，且 `details.calls` 兜底；② 每组 64 条上限下极端脚本会少记触碰（少注入，不误注入）；③ 嵌套事件与被 `tool_call` 阻断的调用之间的时序未单独验证（阻断仍会走 `_afterToolCall` 并给出 error 结果，按决策 1 照算）。
