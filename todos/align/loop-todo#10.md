# loop-todo#10 — 后台单轮硬超时 30 分钟 → 3 小时

## 意图

loop 后台任务（`/loop --bg`、`loop_create mode=background`）的单轮硬超时写死在 `src/extensions/loop/runner.ts` 的 `BG_RUN_TIMEOUT_MS`（30 分钟）。

2026-09-15 真机实测证明这个值选错了：派单类任务把实现工作交给异步 subagent 后，headless 子 pi 在 `agent_end` 会 **auto-drain**（等待自己派出的异步子任务收尾，pi-subagents 的上限同为 30 分钟，从回合结束起算），而 loop 的 30 分钟**从 spawn 起算**、天然更早 20~30 秒到点。结果是每轮都在子任务收尾前被杀：

- loop 侧：round 记 `timeout`（`0c56ca98` 的 08:41 / 10:41 两轮，最后一次活动 09:10:56 / 11:11:07 vs 上限 09:11:08 / 11:11:08）；
- 子侧：异步 runner 进程消失、无结果落盘，随后被 stale-run reconciliation 标 `failed`（`#67` 那轮工作其实已在 11:07 落地并 merge 也被误标）。

用户决策（2026-09-15）：单轮上限提到 **3 小时**，使其大于子任务自身的 drain / 异步 run 预算，不再由 loop 抢先杀。

## 范围

**做什么**

1. `src/extensions/loop/runner.ts`：`BG_RUN_TIMEOUT_MS` 30 分钟 → `3 * 60 * 60 * 1000`；注释写清与 headless auto-drain（30 分钟）/ 异步 run 预算的先后关系（为什么必须更大）。
2. 测试锁定新默认值：`src/extensions/loop/test/runner.test.ts` 现有等值断言改 3 小时（先红后绿）。
3. 同步 `docs/extensions/loop.md`（超时描述 + `last verified` 行）、`src/extensions/loop/package.json` version（1.6.2 → 1.7.0，minor：行为变更）、根 `package.json`（版本联动）。

**不做什么**

- 不改 `KILL_GRACE_MS`（SIGTERM → 5s → SIGKILL）与超时杀进程语义。
- 不动 `tasks.ts` 的调度推进 / 7 天 TTL / 跳过语义。
- 不加 per-task 超时字段（YAGNI：等出现「不同任务不同预算」的具体需求再加）。
- 不改 pi-subagents / 宿主 headless drain 行为（仓库边界，见 `AGENTS.md` 红线 8）。

## 验收标准

1. `BG_RUN_TIMEOUT_MS === 3 * 60 * 60 * 1000`（`test/runner.test.ts` 等值断言，先红后绿）。
2. `cd src/extensions/loop && npm test` 全绿 + `npm run typecheck` 零错误。
3. `docs/extensions/loop.md` 与代码一致（3 小时 + 理由），`last verified @ <commit>` 更新为新 commit。
4. 版本：loop `1.7.0`、根 `package.json` 联动 bump。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-15
- 方式：会话指令原文——「单次loop的时间也提升到3h」（与 #67 真机验收同一会话；此前 loop 失败分析中已确认根因是三个 30 分钟上限撞车）
- 决策落盘：本文件；实现内注释记录 drain 关系
