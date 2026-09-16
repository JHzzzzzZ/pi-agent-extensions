# todo-cli-todo#16 todo 统一全局 id（repo-dev 首单）

> 领取：2026-09-15（本会话）· 对齐访谈：2026-09-15 grill-with-docs 三轮（登记 → frontier 三轮 → 终确认）

## 意图

当前条目 id 是文件内 max+1、跨文件重号（`todo-cli-todo#15` 与 `general-todo#15` 是两个不同条目却都叫 15），查重、依赖引用、对齐文档命名全以「文件#id」为准，人机都容易混。用户期望：所有 `todos/*.json` 条目支持**统一唯一 id**——类似数据库主键，全台账从不重复、永不复用。本单同时是 repo-dev 团队流程的首单（见 general-todo#8）。

## 范围

做什么：

1. **id 形态（U1）**：全局自增整数，计数器文件 `todos/.todo-cli/next-id`；`add` 写入时取号，计数器初值 = 全台账现存最大文件内 id（新旧不混淆）。取出的号永不回收（reopen / complete 都不归还）。
2. **锁语义（U6）**：取号专用全局锁 `todos/.todo-cli/locks/id.lock`，只护计数器读改写临界区；条目写入仍用现有每文件 O_EXCL 锁 + temp+rename。不做全写串行化。
3. **双轨（U2）**：存储 `entries[]` 新增 `globalId` 字段；CLI 展示与引用**保留 `文件#id`**（dependsOn 规范引用、align 文档命名 `todos/align/<名>#<id>.md`、`--match` 口径全不动）；`globalId` 只进 `list --json`，并用于跨文件查重与合并冲突仲裁（「按 id 取并集」时以 globalId 判同条目）。
4. **存量迁移（U5）**：一次性迁移——遍历全部 todo 文件按稳定顺序取号；逐字段保全（`createdAt`/`claimedAt`/`alignedAt`/`completedAt`/`tags`/`dependsOn`/全部 notes，#14 的教训）；附等价自检（条目数不变、除新增 globalId 外逐字段零变化，风格同 `migrate from-md` 自检）；迁移幂等（重跑不重复取号）。
5. **schema**：v3 → v4（新字段 globalId；读旧 v3 文件缺失该字段 → 先迁移再操作或读时 null 兜底，口径实现时定）。
6. **实施顺序（U3）**：#16 先行；todo-cli-todo#15（优先级）随后实现，其展示基于定稿后的 id 口径。
7. **repo-dev 首单**：过 align 门后交 repo-dev 团队实施，按 general-todo#8 约定在 `history/team-runs/<runId>/` 留七文档。
8. **契约同步**：SKILL.md、`docs/tools/todo-cli.md` 卡片、`CONTEXT.md` 新词条「全局 id（globalId）」、新 ADR（统一主键 + 双轨决策，满足难逆/惊异/真权衡三条件）、`docs/specs/` 规格、根 README 命令面与测试数、根版本 bump。
9. **TDD 先红后绿**：取号唯一性、迁移等价自检、幂等、并发无重号、旧文件兼容各先写失败用例。

明确不做什么：

- 不改 `--match` 语义、不改 dependsOn 引用格式、不换时间戳型 id（ULID/UUIDv7）、不做惰性分配、不把所有写操作升级全局锁、不改 `文件#id` 展示。

## 验收标准

1. 新 `add` 取全局号；同台账并发 add（真子进程并发）无重号；计数器持久、跨命令单调。
2. 存量一次性迁移：全部 todo 文件每条获得 globalId；等价自检通过（除 globalId 外字段零变化）；重跑迁移幂等、不重复取号。
3. `list --json` 带 globalId；`list` / `summary` 人类输出与现版本一致（状态计数自然变化除外）。
4. `reopen` / `complete` / `align` / `lint` / `triage` 契约零破坏；`npm run test:todo` 全绿 + `lint` exit 0。
5. 文档同步齐（范围 8 全项）+ 测试数实测更新 + 版本 bump。

## 人工确认

确认人：用户 · 日期：2026-09-15 · 方式：本会话 grill-with-docs——Q9 用户指定以本单替代 #15 作 repo-dev 首单；三轮 frontier 逐条采纳推荐值：U1 全局自增整数+计数器（否决 ULID）、U2 双轨（否决单轨全改 `#<全局id>`）、U3 #16 先行 #15 随后、U4 现在领取进 aligning、U5 一次性迁移+等价自检（否决惰性）、U6 取号专用全局锁（否决全写全局锁）；计数器初值与「globalId 仅进 --json」两处实现细节由 agent 定，用户答复「当前没问题」终确认。
