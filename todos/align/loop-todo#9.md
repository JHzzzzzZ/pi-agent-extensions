# loop-todo#9 — 后台模式允许重叠运行（同一任务多轮并发）

## 意图

`/loop --bg` / `loop_create mode=background` 的后台任务，同一个任务的**多轮运行允许真实重叠**，不再被丢弃。

现状（2026-09-15 登记时）：`startBgRun`（`src/extensions/loop/index.ts`）用 `bgEntries.has(t.id)` 守卫——同一任务上一轮子进程未结束时，本次到期触发只发一条 warning「上一轮后台仍在运行，本次触发跳过」并直接丢弃。后果：单轮耗时 > 间隔时（15m/30m 巡检 + 单轮 40 分钟）实际执行轮次远少于触发轮次，用户只能从 warning 察觉被丢弃，且 3h 单轮上限（loop-todo#10）会让长轮次更常见。

用户决策（2026-09-15 会话内逐条对齐）：

- 并发形态：**全放开，不设并发上限**（用户明确选择选项 A，已知成本风险自担；不做排队补跑）。
- 轮次记录：**当前会话内历史运行的所有轮次都保留**（不截断成"最近 N 轮"）。
- 持久化形态：全量轮次改用 **append-only 会话条目**（`loop-run-v1`，每轮一条），任务快照只装运行中的轮次——避免「全量轮次塞进快照」带来的 O(n²) 会话文件膨胀（15m 巡检跑满 7 天 ≈ 672 轮 → 快照累计 ~100MB；1m 任务可到 GB 量级）。
- 展示口径：运行中轮次全部列出，已完成折叠为最近 10 条 + 计数。
- 可视告警：同任务在途轮次首次 ≥3 时发一条 info 提示（纯可发现性，不丢轮次、不改语义）。

## 范围

**做什么**

1. `src/extensions/loop/index.ts`
   - 删除 `startBgRun` 的在途守卫（丢弃路径彻底消失：并发不设上限，触发即拉起）。
   - `bgEntries` 从 `Map<taskId, entry>` 改为按**轮次**跟踪（runId 键），每轮独立 `AbortController`；同任务多轮并存。
   - 轮次记录写入任务内存态 `runs`（v1.8 取代单对象 `lastRun`）；每轮终态触发 append-only 条目 `loop-run-v1`（自定义条目不进 LLM 上下文）。
   - 通知：完成每轮一条（带轮次起始时刻标识）；启动通知仅在该任务在途轮次 0→1 时发；同任务在途轮次首次 ≥3 发一条 info 提示（回落到 <3 后重置，下次再穿越再提示）。
   - widget 总览行：`· 后台运行 N 轮（M 个任务）`。
   - `session_start`：回放 `loop-run-v1` 条目重建本会话轮次历史；快照中的在途轮次在恢复时转为 `interrupted` 并补一条终态条目（宿主中途退出不留"永远运行中"）。
2. `src/extensions/loop/tasks.ts`
   - `BgRunRecord` 增加 `runId`；`LoopTask` 用 `runs: BgRunRecord[]`（全量轮次，内存态）取代 `lastRun`。
   - `serializeTasks` 改为**白名单**序列化：快照只持久化 `status === "running"` 的轮次（字段 `activeRuns`），历史轮次不进快照。
   - `hydrateTasks`：`activeRuns` / 旧快照 `lastRun` 都在恢复时转成 `runs` 记录（`running → interrupted` 语义不变）；旧 `lastRun` 作一条历史轮次迁移。
   - 展示：`formatBgRunLine` 拆成运行中行（每轮一条：起始时刻 + 会话 id + 已跑时长）与已完成行（最近 10 条）+ 折叠计数 `└ 更早 N 轮`。
3. `src/extensions/loop/runner.ts`：新增运行中会话 id 回调（`onSessionId`），让运行中的轮次行能显示可 resume 的会话 id；子进程名加轮次后缀 `--name loop-<taskId>-<HHMM>`（并发同名问题）。
4. 真机边界冒烟：opt-in 脚本 `src/extensions/loop/test/bg-overlap-smoke.mjs`（真实 pi 子进程两轮并发，需鉴权 + 网络，**不进** `npm test`）。
5. 交付同步：`docs/extensions/loop.md`（卡片 + `last verified`）、`src/extensions/loop/package.json` 1.7.0 → 1.8.0（minor）、根 `package.json` 版本联动与根 `README.md` 测试数（唯一来源）。

**不做什么**

- 不加并发上限、不做排队补跑（排队会把"错过不补跑"改成无界积压，用户明确否决）。
- 不改前台 followUp 注入语义、调度推进（错过不补跑）、7 天 TTL、3h 单轮超时（loop-todo#10）、`KILL_GRACE_MS` 与 SIGTERM→SIGKILL 策略。
- 删除 / 暂停 / 7 天过期清理**不干预在途轮次**：只影响后续触发，在途轮次跑完只发通知、不写回任务（删除/过期回执补一句在途轮次数）；只有 `session_shutdown` 杀全部在途并逐轮标 `interrupted`。
- 不做 per-task 并发配置、不做跨会话共享轮次历史、不动 `MAX_TASKS` / 任务文本上限等其它常量。
- 不改宿主 pi / pi-subagents（仓库边界，`AGENTS.md` 红线 8）。

## 验收标准

1. **重叠运行**（fake child 进程边界测试，先红后绿）：同一后台任务两轮真实重叠——`runBg` 两次调用并存、各自独立 session id、各自完成通知；任务 `runs` 两条记录。
2. **无丢弃路径**：在途时再次到期必拉起新一轮（删除「仍在运行，本次触发跳过」行为与其测试）。
3. **全量历史**：会话内 N 轮 → N 条 `loop-run-v1` 条目；`session_start` 回放后 `runs` 完整、顺序正确；快照不含已完成轮次（体积不随轮次增长）。
4. **旧快照兼容**：带 `lastRun` 的旧快照水合为一条历史轮次（含 `running → interrupted` 转换），不报错、不丢任务、迁移后补写为条目。
5. **生命周期**：`session_shutdown` 逐轮 abort + 每轮 `interrupted`；在途任务被删除/过期 → 跑完只通知、不复活任务。
6. **展示**：`/loop:list` 与 `loop_list` 运行中每轮一行、已完成最近 10 条 + 折叠计数（含数百轮量级用例，锁输出不爆）；widget 显示 `N 轮（M 个任务）`。
7. **通知**：完成每轮一条带轮次标识；启动通知仅 0→1；在途首次 ≥3 一条 info 提示。
8. **真机边界**：opt-in 冒烟脚本用真实 pi 子进程跑出两轮并发，脚本输出与结论记录在交付说明中（默认 `npm test` 不联网）。
9. **门禁**：`cd src/extensions/loop && npm test` 全绿 + `npm run typecheck` 零错误；根 `npm run test:all` 绿；文档、版本、测试数四处同步。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-15
- 方式：会话内两轮 grilling 逐条问答，用户原文回复：
  - 第一轮（并发形态 / 状态模型 / 通知 / 终止语义 / 测试层次 / 子会话命名）：`Q1: A，Q2: 当前会话历史运行的所有loop轮次都装起来；其余可以；`
  - 第二轮（全量轮次持久化形态 = append-only 条目 / 展示折叠口径 / 无上限下的阈值提示）：`没问题；`
- 本文件即对齐产物，回执写实现结论与偏差。

### 实现期偏差记录（用户已知口径，收尾报告同步）

1. **轮次条目只在终态写**：对齐时留了「启动即写 running 条目 / 完成再关联」的选项，实现定为**只有终态写 `loop-run-v1`**（每轮恰好一条、无状态改写），运行中态由快照 `activeRuns` 承载（宿主中途退出靠它转 interrupted 并补写条目）。
2. **新增 runner `onSessionId` 回调**：验收要求运行中的轮次行能显示可 resume 的会话 id，而会话 id 原先只在进程结束时才拿到——runner 捕获 JSON 头即回调，index 写进轮次记录并落盘。
3. **新增 runner `piEntry` 覆盖**（对齐外的小缝）：真机冒烟脚本在 node 下直调 `runBgAgent` 时，`getPiInvocation` 靠宿主 `argv[1]` 认 pi 入口，把调用方脚本当入口**递归拉起自己**（实测撞到一次进程风暴，已清理干净；脚本另加 `--mode/-p` 自检保险）。
4. **展示文案定稿**：运行中行 `└ 运行中 · HH:MM:SS · 已跑 Ns · 会话 <id>`；已完成行 `└ 完成 · HH:MM:SS · 会话 <id> · 摘要`；折叠行 `└ 更早 N 轮`；已完成展示上限 `BG_HISTORY_DISPLAY = 10`；阈值提示常量 `BG_CONCURRENCY_NOTICE = 3`——均为对齐决议的落地细节，语义未变。
5. **真机冒烟实测结论**：`test/bg-overlap-smoke.mjs` 用真实 pi 子进程两轮并发跑通（并发峰值 2、两个独立 session id 与会话文件、耗时 6s），输出已附收尾报告。
