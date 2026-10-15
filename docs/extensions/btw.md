# btw — 旁路对话（不影响主对话的侧问答）

> last verified @ ffbff7f

一句话：`/btw <问题>` 在主对话运行中开一条**只读主会话、零写入**的侧对话——读当前分支尾部作上下文，经 `ctx.modelRegistry.streamSimple()` 直调模型，答案落只读覆盖面板；侧问答**不进主上下文、不打断主 run**（参考 Claude Code 的 `/btw`）。

## 为什么这么做

主对话跑长任务时要了解进展，现状下唯一通道是把问题当 steer/followUp 插进主对话（`how-pi-works.md`），必然写进主上下文、可能烧主模型 token、干扰主 agent 判断。可行性来自两处公开面：

- 扩展命令**在流式运行中立即执行**（`rpc-commands.md:31`，不经 steering/followUp 队列）；
- `ctx.modelRegistry.streamSimple()` 是「直调模型、零写会话」的宿主任口（goal 评估器同款，含虚拟模型路由与 `sessionId` 会话头注入，真机对照见 `todos/align/goal-todo#10.md`）。

## 不变量（改代码前必须知道）

- **零写入是硬不变量**：本扩展对宿主只读——不 `appendEntry`、不 `sendMessage`、不 `sendUserMessage`、不碰主 run。三道锁：`index-host.test.ts` 用 `ExtensionActions` 计数器断言零写调用、源码结构守卫（六个源文件里出现写 API 即红）、真机验收看 session JSONL 零新增。
- **侧调用只走 `streamSimple`**，不直调 provider、不自拼请求头（虚拟模型 `api=pi-virtual` 直调必然失败；opencode 系 `x-opencode-session` 由 provider 层从 `options.sessionId` 注入）。
- **有界**：单飞（`inFlight`，同一时刻一个侧调用）+ `SIDE_CALL_TIMEOUT_MS=120s` 看门狗。侧调用循环**与 abort 竞速**（`Promise.race([iterator.next(), abortRace])`）——`for await` 只在事件边界看 signal，provider 挂住时会把命令处理器一起挂住；收尾也**不 await** `iterator.return()`（挂住的 provider，其 cleanup 同样可能永不落定）。
- **上下文只读快照**：`sessionManager.buildContextEntries()`（压缩感知的当前分支）→ `buildContextText` 预算装填：总预算 `MAX_CONTEXT_CHARS=30k`（字符）、逐块上限（工具结果 800 / 助手文本与压缩摘要 4000 / 用户 4000 / 参数预览 300）、**由新到旧**装填，丢 N 条在头部标注 `（更早的 N 条已省略）`。正在流式、尚未落盘的那条看不到——MVP 已知限制，写进 README。
- **侧线程只在内存**：`ThreadTurn[]`（最多 `MAX_THREAD_MESSAGES=8` 条 = 4 轮，成对入线、超出丢最早一对）；`session_start` / `session_shutdown` 重置（含 `/btw:model` 覆盖）。不落盘、不 appendEntry。
- **面板相位与超时语义**：`aborted` 由调用方区分「用户关面板」与「看门狗超时」（`phaseForResult(result, timedOut)`）——超时显示「已超时」、用户取消显示「已取消」，绝不混为一谈。最终文本以 `done` 消息为准（有些 provider 不发 `text_delta`，只靠增量面板会剩空态）。
- **面板降级链**：`ctx.mode === "tui"` → `ctx.ui.custom` 覆盖面板（factory 未被调用或抛错 ⇒ `supported:false`）→ 降级 notify（截断 `MAX_NOTIFY_CHARS=800`）；`!ctx.hasUI`（print/json）→ stderr 一行并返回，**不静默**。
- **无每秒跳动文本**：面板只有静态状态词（思考中… / 已完成 / 出错 / 已超时 / 已取消）+ 增量正文（repo 教训：overlay 逐秒变化即纵向堆叠物本身）。
- **不偷编辑器按键**：面板只在覆盖层获得焦点期间吃键（`Esc`/`q`/`ctrl+c` 关、`J`/`K`/`↑↓`/`PgUp`/`PgDn` 滚），`isKeyRelease` 顶部短路（Kitty 协议 release 不能当第二次按键）。

## 文件地图

- `index.ts` — 三条命令（`btw` / `btw:clear` / `btw:model`）+ 生命周期 + `BtwDeps`
- `context.ts` — 条目 → 上下文纯文本（`renderTranscriptEntry` / `buildContextText`）
- `side-call.ts` — `buildSidePrompt` / `runSideCall` / `StreamSimplePort`（本扩展用到的宿主那一小面）
- `panel.ts` — `computePanelBodyHeight` / `renderPanelFrame` / `handlePanelKey` / `BtwPanel` / `presentBtwPanel`
- `spec.ts` — 全部上限与静态文案（改上限只动这里）；`errors.ts` — `BtwErrorCodes` + result union

## 测试与验证

- `cd src/extensions/btw && npm install && npm test && npm run typecheck`（61 个：context 12 / side-call 9 / panel 13 / index-unit 11 / index-host 10 + 结构守卫 + 2 真机 opt-in）
- **真机 opt-in**：`PI_BTW_E2E_MODEL=<provider/id> node --test test/real-pi.test.ts`（未设环境变量时 skip）。起真实 `pi --mode rpc --extension <本目录 index.ts>`（临时 agent 目录 + 拷入 auth.json，跑完即删，不碰用户配置），断言：① 空闲 `/btw` 出真实模型回答且 `disposition=handled`（命令被宿主直接处理、不进主对话）；② 主 agent 流式跑 `sleep 25` 期间 `/btw` 仍能作答（notify 先于 `agent_settled`）；③ 两种情况会话文件都零 `user`/`assistant` 条目（真机零写入证据）。
- 宿主路径测试走**真实发现+加载（jiti 走 `index.ts`）+ 真实 `ExtensionRunner` + `runner.createCommandContext()`**，只 fake `streamSimple`（网络边界）、`sessionManager`（本扩展只读两个方法）、`ExtensionActions`（计数写调用）、`ui`（记录组件 / notify）。
- 面板渲染的**单物理行契约**（每行恰好 width 显示列，CJK 双宽）在 `panel.test.ts` 逐行用 `visibleWidth` 断言；真实宿主渲染管线本身由 agent-team `viewer-host.test.ts` 覆盖，不在此重复。
- 真机验收：主 agent 流式运行中 `/btw 现在在干啥` → 面板出答案、主 run 不中断、`~/.pi/agent/sessions/…jsonl` 零新增条目；同口径的可重跑用例是 `test/real-pi.test.ts`（opt-in，`PI_BTW_E2E_MODEL`）。

## 已知坑

- **`ui.custom` 的 factory 是同步跑在 `await ui.custom(...)` 之前的**：侧调用在 factory 里启动（组件一创建就开跑）；presenter 返回 `supported:false` 时调用方**必须自己跑一次侧调用**（降级通道），别让「面板没出来」变成「什么都没发生」。
- **不要在 `for await (const event of stream)` 里等 signal**：事件不来就永远不检查（超时/关闭全部失效）。竞速 + 不 await cleanup 两条是行为不变量，不是优化。
- **`iterator.next()` 的失败方要挂 `.catch()`**：竞速中被丢弃的 `next()` promise 迟到 reject 会变成 unhandled rejection（进程级噪音）。
- **上游条目形状用最小结构对象构造（`TranscriptEntry`）**：`context.ts` 只读 `type` / `message.{role,content,toolName,command,exitCode,output}` / `summary` / `content`，测试不必造完整 `SessionEntry`；新增读取字段时同步扩这个接口与 `renderTranscriptEntry`。
- **`ExtensionActions` 的计数 fake 只对「真的调用了写 API」敏感**：源码结构守卫是第二道网（防止有人用 `pi.appendEntry(` 以外的写法绕过——比如 `sessionManager.appendCustomEntry`，后者同样被守卫列出）。
