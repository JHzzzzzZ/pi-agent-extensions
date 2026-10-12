# 对齐：dir-context-todo#10 — 并行工具调用时注入块只落在一个结果上

- 条目：`dir-context-todo#10`（priority 5）· 分支引用：待定（worktree 建好后回填）
- 日期：2026-10-12（UTC）· 参与：用户（真机现象提出）+ agent（验证与设计）
- 状态：**已对齐**（用户选定方案 A）

## 意图

用户提出「read 内容过长、或 AGENTS.md 过长、加起来 > 50KB 时不会注入」。真机验证（真实 `pi` 1.1.0 + 工作树与包缓存逐字一致的 dir-context 源码，临时目录探针 `%TEMP%\dirctx-probe{,3,4}`）：

- **50KB 阈值这条不成立**：单次 read 195KB 文件（read 自截断 50KB）+ 245B AGENTS.md ⇒ 注入，结果 51545B；+ 31.9KB AGENTS.md（合计 83218B）⇒ 注入；212KB AGENTS.md ⇒ 注入（按 32KiB 截断并标 `[truncated to 32768 bytes of 212205 bytes]`）。50KB 是 **read 工具自己的截断上限**，不是本插件阈值。
- **但用户看到的现象真实存在，触发条件是并行工具调用**：同一条 assistant 消息里并发多个 `read` 且落在**同一条目录链**上时，四个结果里只有**一个**带 `<dir-context>` 块，其余静默无标记，且赢家随机（探针第 1 次跑挂在最后一个小文件、第 2 次跑挂在大文件）。用户真实会话 2026-10-12T09-40 亦如此：`read src/extensions/loop/index.ts`（19653B）无块，同一条消息里的 `read src/extensions/loop/tasks.ts` 才有块。

根因（host 机制，已读打包源码确认）：`executeToolCallsParallel` 对同一条消息的多个调用用 `Promise.all` **并发执行**，每个调用的 `finalizeExecutedToolCall` → `tool_result` hook 在各自的 async 链里按**完成顺序**触发，结果消息再按原始顺序装配；插件侧「同一绝对路径每会话只注入一次」（`injected` 集合）让**最先跑完 hook 的那次**独吞块，其余触碰看到已标记即静默跳过。⇒ 「把块挂到本批次第一个结果」在插件层**做不到**（拿不到批次边界与消息内顺序），只能改语义。

## 范围

**做什么**（已定档：**方案 A**）

- **全量块仍每链每 turn 只出现一次**（去重保留），**同 turn 内同链的后续触碰结果追加一行指针**（静态文案 + 该链的展示路径，如 `Loaded src/AGENTS.md (already injected earlier in this turn — content not repeated)`）⇒ 不再有静默无标记的结果。
- 状态模型：`injected`（本 turn **之前**已注入，会话级）与 `injectedThisTurn`（本 turn 内已注入）；触碰时 `injected` 命中 ⇒ 照旧静默（跨 turn 去重，不重复唠叨），仅 `injectedThisTurn` 命中 ⇒ 出指针行。turn 边界用 **`turn_start`** 把 `injectedThisTurn` 并入 `injected` 后清空（`turn_end` 不一定在中断时触发，`turn_start` 才是可靠边界；`session_start` / `session_compact` / `session_shutdown` 两个集合一起清）。
- 指针行**不读文件、不进 `loaded[]`/状态段计数、不参与预算**（它没有正文），只在结果本身有文本内容、非错误、非嵌套调用时追加（与原块同一批闸门）。
- 嵌套调用（codemode）补偿路径、预算/截断/块格式、`structuredContent` 回传、远端三态语义一律不动。
- **远端（已知不对称）**：远端触碰的重复判定发生在 fetch 之后，且拿不到远端文件清单 ⇒ 本 turn 内已注入过的远端链再触碰仍按现状静默（不猜、不为出指针多发一趟 ssh）。这条写进卡片「已知不对称」，本机路径才是本条的验收面。
- 测试：宿主级用例（真实 `ExtensionRunner`）并发触发同链两条 `tool_result`，锁定「每条结果都有块(A: 指针 / B: 全量)」；真机 A/B（真实 `pi`，一条消息 4 个并行 read，同目录 + 两目录各一遍）。
- 文档同步：`docs/extensions/dir-context.md` 的不变量（去重口径从「会话」措辞精确到「turn 内每结果、跨 turn 去重」）+ `src/extensions/dir-context/README.md` + 版本 bump + 卡片 `last verified`。

**明确不做什么**

- 不改 read 工具的 50KB 截断、不改本插件 32KiB/128KiB 预算（都不是本条的问题）。
- 不改「cwd 自身及以上的约定文件不注入」（宿主已放进 system prompt）。
- 不做「按消息内顺序/位置挑结果」的一切猜测式实现（host 不暴露批次边界，任何猜测都会漂移）。
- 不动 `docs/cross/` 任何契约面（状态键、错误码、能力协商协议均不变）⇒ T2 档。

## 验收标准

1. **同 turn 并发同链（本机）**：一条 assistant 消息里 N 个触碰落在同一目录链 ⇒ 恰好 1 个全量块 + N-1 行指针，且**没有结果既无块也无指针**；并发触发（`Promise.all` 同时 emit 两条 `tool_result`）时断言「一个全量 + 一个指针」而不假定谁是赢家。
2. **跨 turn 去重保留**：同一目录在后续 turn 再触碰 ⇒ 静默（不重复注入、也不出指针——指针只服务「同一批里没拿到正文」的补位）。
3. **不同链互不影响**：一条消息里两个不同链的触碰 ⇒ 各自都有全量块（现状已满足，加回归锁）。
4. **明细完整**：`/dir-context` 清单与状态段计数不因指针行而虚高（指针不计数）。
5. 单测（`node --test` 全绿）+ 宿主级真实 `ExtensionRunner` 用例 + `npm run typecheck` 零错误。
6. 真机对照：真实 `pi` 跑「4 并行 read 同目录」与「4 并行 read 两目录」，两种形状下模型都能答出只写在嵌套 AGENTS.md 里的暗号（探针脚本复用 `%TEMP%\dirctx-probe*`）。
7. 跨厂商独立评审单轮（T2 口径）+ 行为面显式回答；P1/P2 处理完即 merge。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-12（UTC）· **方式**：对话内回答 **「A」**
- **用户选择的语义**：方案 **A** —— 全量块每链每 turn 只出现一次，同 turn 内同链的其余触碰结果补一行指针；跨 turn 去重保留。
- **agent 提请注意（用户已知悉）**：① 用户最初描述的「>50KB 不注入」经实测不成立（证据见「意图」），本条修的是并行调用下的块归属；② 方案 A 下「读大文件那个结果」拿到的是**指针**而不是规则正文（正文在同 turn 的另一个结果里）；③ 远端链在本 turn 内的重复触碰仍静默（已知不对称，见「范围」）。
