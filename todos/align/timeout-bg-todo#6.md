# 对齐：timeout-bg-todo#6 — 后台任务完成通知改为中途送达（followUp → steer）

- 条目：`timeout-bg-todo#6`（tags: `通知`,`投递语义`）· 分支引用：`feat/timeout-bg-steer-notice`
- 日期：2026-12-12（UTC）· 参与：用户（报现象 + 选定方案 2）+ agent（宿主投递语义取证）
- 状态：**用户已确认**（2026-12-12，回复「2」= 采纳方案 2；方案代价「中途插话可能打乱 agent 计划」已在本会话显式列出）
- 档位：**T2**（只动 `src/extensions/timeout-bg/` 一个单元 + 其配套文档；无契约面变化）

## 意图

用户报现象：agent 连续工作时，后台任务早已结束，但完成通知一直不出现，要等 agent 收工才弹出来；要求先确认是不是 bug。

**取证结论：不是本插件的 bug，是宿主 `deliverAs: "followUp"` 的既定语义，但本插件的选型让它成为可改的行为。**

- 通知出处：`index.ts` 的 `deliverExit` → `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`。
- 流式中该消息进 pi-agent-core 的 followUp 队列（`agent-session.js` `sendCustomMessage`：`isStreaming` + `deliverAs === "followUp"` ⇒ `agent.followUp(...)`），不进 transcript、无 UI 痕迹。
- `agent-loop.js` 外层循环：followUp 队列**只在「agent 本来要停」的检查点** drain；agent 只要还在连续出 tool call，这个点就不来。
- 对照：`steer` 在内层循环每轮工具批结束后取（`getSteeringMessages()`），不 streaming 时 `triggerTurn: true` 直接起新 run（与 followUp 相同分支）——两个场景都立即送达。

用户决策：**采纳方案 2**——改为 `steer`，让通知在「当前 turn 工具批结束」那一刻进上下文，模型下一轮请求即看到并可以反应；接受「中途插话可能改变 agent 当前计划」这一代价。

## 范围

**做什么**

1. `deliverExit` 的投递参数 `deliverAs: "followUp"` → `"steer"`（`triggerTurn: true` 不变）。
2. 语义口径同步（同变更内）：`index.ts` 头注释、`README.md`「完成通知」条、`docs/extensions/timeout-bg.md` 卡（含 `last verified` 行）、模型面指南文案（`promptGuidelines` 里 "a follow-up message arrives when it finishes"）。
3. `text.ts` 的 `followUpText` 命名与注释若继续以 "followUp" 命名会误导（投递方式已不是 followUp）——改名（`exitNoticeText`）并同步调用点与测试；`docs/cross/shell-tool-capability.md` 若提到该通知的投递方式一并核对。
4. 测试：更新 `test/index.test.ts` 的投递断言为 `steer`；补一条**行为面**用例（见验收标准 3）。
5. 收尾四处同步按红线 7 走；根 README 测试数如有变化同步（唯一来源）。

**明确不做什么**

- 不加 `ui.notify` 即时 toast（方案 1 不做；将来需要另立条目）。
- 不改宿主、不打宿主补丁；不改 followUp 队列语义。
- 不改通知文本内容与格式（jobId / 退出码 / 耗时 / 末尾输出逐字不变）。
- 不改超时转后台、主动后台、默认超时、`/bg` 命令面、状态条段等既有行为（零回归）。
- 不做「流式时 steer / 空闲时 followUp」的分支判断：宿主两个分支都已给出正确结果，选一个常量即可。

## 验收标准

1. **代码面**：`deliverExit` 以 `{ deliverAs: "steer", triggerTurn: true }` 投递；插件内不再有把该通知描述为「follow-up」的文档/注释/指南文案。
2. **JSDoc 落地**：`test/index.test.ts` 断言 `options?.deliverAs === "steer"`，且既有「结束即通知」用例全绿。
3. **行为面用例（本轮新增，锁定宿主语义假设）**：用宿主真实 `AgentSession`（或等价的 agent-loop 驱动）证明——agent 流式中收到该消息时它进入 steering 队列、**在当前工具批结束后**被取走，而不是被推迟到 agent 停止；同一用例证明 followUp 模式下才推迟。此用例是本条目的价值所在（防「纸上正确」）。
4. **零回归**：timeout-bg 全套测试绿 + `npm run typecheck` 零错误；remote-tools 侧相关测试（job 托管组合）不受影响。
5. 跨厂商单轮评审（T2 口径，reviewer 显式回答「有无首轮未覆盖的行为面疑虑」）。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-12-12（UTC）· **方式**：对上一轮给出的三个方案回复「2」
- **决策**：采纳方案 2 —— `deliverAs` 改 `steer`，完成通知在「当前 turn 工具批结束」时进上下文（流式中），空闲时照旧触发新 turn。
- **已知取舍（显式接受）**：① 通知会在 agent 工作中插话，可能改变它当前计划（例如它正忙着别的事，会先响应这条通知）；② 因此不再有「被打扰」与「看得见」之间的开关，语义固定为「及时可见」。
- **实现期补充**：行为面测试接宿主真实 loop（`@earendil-works/pi-agent-core` 的 `Agent` + pi-ai faux provider），因此新增两个测试专用 devDependencies（`^1.2.0` = 当前 pi 运行时同版），记录在卡片里。
- **开工放行**：已确认，跑 `align` → `claim --branch feat/timeout-bg-steer-notice` 进 `processing` → worktree 实施（T2 免规格文档）。
