# agent-team-todo#56 用户插队（steer/排队）输入的 prompt 在界面无显示，需要突出

## 意图

用户在 viewer 里发出的消息，**原文在界面上彻底消失**：steer 即时通道只回一句 notice（`chat.ts:232`「已插话给 X（steer）：不打断当前任务…」），原文只在 `buildSteerMessage`（`chat.ts:107`，前缀【用户消息·插话】）里直送 leader 的 stdin；排队/派单通道只把 `{runId,targetLabel,message}` 放进**内存**队列（`chat.ts`，不落盘）。结果：自己发了什么无从确认，回看 `/team:view` 或 `team_transcript` 也查不到（用户 2026-09-11 真机反馈）。

关键事实（已核）：转录 kind 白名单 = `task|assistant|tool|error|system|question|answer`（`transcript.ts:25`），reader **严格丢弃未知 kind**（`transcript.ts:141`）；转录是 per-actor JSONL（leader = `_leader`）；viewer 已可用宿主 `userMessageBg` 主题（`viewer.ts:105`）。

## 范围

**做什么**

1. 转录新增 `user` kind（进 `TRANSCRIPT_ENTRY_KINDS` 白名单），落**目标 actor**（steer 目标必为 leader ⇒ `_leader`）+ leader 侧各一条（消息就是交给它处理的）——记录的是**用户输入原文**，不带 `【用户消息·插话】` 包装（那是 wire 上的标记，不是用户写的话）。
2. 写入时机 = **提交时刻**（用户「我发了什么」的真值）：steer 即时落；排队消息提交即落，随后派出时补一条 `system` 行「已派出（新 run <id>）」；若在派出前被 stop 丢弃，补「未派出（run 已停止）」——排队中状态**不建第二个事实源**（队列本身仍易失、不落盘）。
3. viewer 呈现：独立亮块——首行 `▌用户 · <时间>`（accent），正文整行按 `userMessageBg` 背景（与 agent/leader 输出视觉区分），按 `ts` 插入 body 流；`team_transcript` 输出对应条目带 `[user]` 前缀。
4. 测试：① 真实渲染（沿 `viewer-ask-host.test.ts`：真实 `TuiMainScreen` + 假终端）断言 `user` 块上屏且走 `userMessageBg` 分类；② 转录断言覆盖三条路径——steer 即时、排队后派出、排队后被 stop 丢弃（只剩提交记录 + 「未派出」system 行）。

**不做什么**

- **notice 文案不改**（用户 2026-09-14 决议：原文在 viewer 里呈现，通知不必再复述）。
- 不动 widget 亮块（避免触碰状态条/widget 栈契约）。
- 不改 steer wire 协议（`buildSteerMessage` 的前缀标记保留）、不改队列易失语义、不改 `team_transcript` 工具的既有输出格式（只新增 kind 行）。
- 不做用户输入的编辑/撤回/重发（本条目只解决「看得见原文」）。

## 验收标准

1. 单测：`user` kind 进白名单且 reader 能读回；未知 kind 仍被丢弃（白名单语义不变）。
2. 转录三路径断言：steer ⇒ 目标 actor + leader 各一条 `user` 原文；排队派出 ⇒ `user` + system「已派出」；排队被 stop ⇒ `user` + system「未派出」。
3. viewer-host 真实渲染：`user` 块上屏、首行标签与时间正确、正文按 `userMessageBg` 渲染（与 assistant 块分类不同）；`team_transcript` 输出带 `[user]`。
4. 零回归：`npm test` 全绿 + `npm run typecheck` 零错误；既有 kind 渲染、viewer 互斥/收起、steer 与排队行为不变。
5. 文档同步：`docs/extensions/agent-team.md`（含 `last verified` 行，补 `user` kind 与呈现契约）+ 扩展 README；根 README 测试数更新。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-14
- 方式：本轮 5 问确认——Q1 新 kind `user` + 目标 actor 落点（同意）、Q2 提交时刻写入 + 派出/未派出 system 行（同意）、Q3 viewer 独立亮块 + `team_transcript` 前缀、widget 不动（同意）、Q4 notice 文案**不改**（用户决议：原文在 viewer 呈现即可）、Q5 测试形态三条路径 + 真实渲染（同意）。
