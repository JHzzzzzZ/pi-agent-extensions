# 规格：todo 统一全局 id（globalId）

> 来源：`todos/todo-cli-todo.json` #16（2026-09-16 登记并领取，同日对齐）
> 对齐：用户批准方案全文（含迁移触发 = 独立子命令、旧版兼容 = 读归一 null + 只压写路径两处定夺；AGENTS.md 红线 1 合并仲裁措辞随同变更），见 `todos/align/todo-cli-todo#16.md`
> 状态：已实现

## 问题陈述

`todos/*.json` 的条目 id 是**文件内** max+1（`schema.ts` 的 `nextId`），跨文件重号：`todo-cli-todo#15` 与 `general-todo#15` 是两个条目。查重提示、`dependsOn` 引用、对齐文档命名、合并冲突「按 id 取并集」全靠 `文件#id` 复合键人肉消歧——缺一个全台账唯一、永不复用的**机器身份**来做判同与查重。存储面需要 schema v3 → v4 与存量 18 文件 / 195 条（2026-09-16 实测）一次性迁移且逐字段保全；并发面跨文件取号不能靠现有每文件锁，需要取号专用全局锁。

## 方案

**数据**：`TodoEntry` 新增 `globalId: number | null`。v4 文件必填正整数（缺失/非正整数 = 结构损坏 fail-closed）；v1/v2/v3 读入缺失归一 null（未迁移瞬态），出现则须为正整数（合并产物/手写混入保全）。读 `1|2|3|4` 都归一 v4，写出一律 v4；文件内 `id`（max+1）不动。

**取号**：计数器 `todos/.todo-cli/next-id` = 下一个待发号（十进制 ASCII + LF），只在 `locks/id.lock` 临界区内经 `atomicWriteFile` 读改写（锁名 `"id"` 复用既有 O_EXCL / stale 抢占 / 同进程重入原语，零新锁代码）。缺失（fresh clone，计数器被 gitignore）自愈初始化为 `max(全台账条目 id, 全台账条目 globalId, 0) + 1`；损坏报 `ID_COUNTER_CORRUPT`（提示删文件重试自愈）。**只前进、永不回收**：complete/reopen 不归还，失败/中止烧号留缺口。

**双轨边界**：`文件#id` 继续承担展示 / `dependsOn` 引用 / 对齐文档命名 / `--match`（全部既有契约字节不变）；`globalId` 只进 `list --json` 与机器判定（`lint` 查重、合并冲突按它判同条目取并集）。不发 `--global-id` 过滤参数。

**写门禁**：六个写命令（`add`/`claim`/`align`/`complete`/`reopen`/`dep`）在已读到的 docs 里发现任一条目 `globalId === null` → `GLOBAL_ID_PENDING：仍有 N 条条目缺 globalId（如 todos/<名>.json），先运行 migrate global-id` + exit 1、零写盘零取号；`add` 在锁外与锁内新鲜 parse 后各判一次（防竞态窗口）。读命令（`list`/`summary`/`triage`/`lint`）容忍 null 瞬态，`lint` 报「缺失」引导。

**迁移**：独立子命令 `migrate global-id [--dry-run]`：预检重复 globalId → 中止零写盘（先手工按 globalId 判同仲裁）；无缺口 → `没有需要迁移的条目` exit 0（幂等零动作）；dry-run 只报将迁移文件数/条目数与起始号（零写盘零取号）；正式迁移按文件名 sort + 文件内数组序逐条取号，逐文件锁内新鲜重读 → 迁移前后逐字段等价自检（`verifyGlobalIdMigration`）不过则该文件零写、整体中止（已写文件保留、重跑接续，号已烧不回收）→ 收尾全台账复检 → 输出统计行。锁序恒为 文件锁 → id 锁（全库唯二嵌套点：`runAdd` 与两个迁移命令）。

## 用户故事

- 作为 agent，我 `add` 之后拿到一个全台账唯一的 `globalId`，跨文件重号不再靠人肉消歧。
- 作为 agent，我不需要改任何习惯：`list` 人读行 / `--match` / 依赖引用 / 对齐文档命名都还是 `文件#id`。
- 作为 agent，我在未迁移台账上写操作时被明确挡下（`GLOBAL_ID_PENDING`），知道先跑 `migrate global-id` 而不是数据静默变脏。
- 作为 agent，我合并两个分支后跑 `lint`：同一条目两边取了不同号（漏判同）或同号漂在两个文件都能被发现。
- 作为人，我在迁移前可以 `--dry-run` 看清将动哪些文件、多少条目、从几号开始；迁移中断后重跑会接续，不重号、不回退。
- 作为人，fresh clone 上计数器文件缺失不会导致重发号撞存量（自愈取 `max(id, globalId)+1`）。

## 实现决策

- `schema.ts`：`TodoFileVersion` 增 4、`TodoFileData.version: 4`、`TodoEntry.globalId`；`validateEntry` 对 v4 必填正整数（v1-v3 可选但出现须合法）、parse 归一 v4、`emptyTodoData` 产 v4、serialize 跟随 `data.version`（写出一律 v4）。
- 新模块 `globalid.ts`：`allocateGlobalId`（id 锁内分发 N 并原子写 N+1）、`peekNextGlobalId`（dry-run 只读预看）、`findGlobalIdProblems`（缺失/重复，lint + 迁移预检两个消费方）、`verifyGlobalIdMigration`（迁移等价自检内核）。不 import core/migrate（无环）；导出面最小化。
- `core.ts`：`runAdd` 在依赖校验通过后、构造 entry 前 `allocateGlobalId`（失败整个写 outcome 失败、零改动且不烧号；取号后写盘失败留缺口——允许）；六个写命令挂 `globalIdGateMessage`；`lintTodos` 并入 `findGlobalIdProblems` 问题行；`migrate` 分派 `global-id`；`USAGE`/文件头注释同步。
- `migrate.ts`：`migrateGlobalId` 编排（逐文件锁内新鲜重读 + 逐条取号 + `verifyGlobalIdMigration` + 收尾全台账复检）；`migrateFromMd` 落盘编排改为逐条取号（一步到位产 v4，不留 v3 中间态）；`migrateToMd` 零改动（渲染按字段取用，自动忽略 `globalId`）。
- `query.ts`：`QueryEntry` 增 `globalId`（core 的 `{...entry}` 投影自动携带），人读行 / 过滤 / 排序零改动。
- `lock.ts` 零改动（锁名 `"id"` 复用成原语）；`depends.ts` / `align.ts` / `todo.mjs` 零改动。
- 错误码（stdout 静态模板 + exit 1）：`GLOBAL_ID_PENDING`（写门禁）、`ID_COUNTER_CORRUPT`（计数器损坏/自愈失败）、`LOCK_TIMEOUT`（取号锁超时，复用锁层既有码）。

## 测试决策

按 10-design §5 的十五条用例逐条锁定（先红后绿；`node:test` + `assert/strict`，无 mock 库，真子进程照 `concurrency.test.ts` 先例）：

- `schema.test.ts`：① v4 必填 `globalId`（缺失/非正整数 → `BAD_SCHEMA`）与 serialize 恒 v4；② v1/v2/v3 读入归一 null、v3 带合法 `globalId` 保留。
- `globalid.test.ts`：③ 连续取号唯一且 +1、计数器跨调用持久；④ 自愈 `max(id, globalId)+1`（fresh clone 存量 71..265 无计数器从 266 起不撞车）；⑤ 计数器损坏 `ID_COUNTER_CORRUPT` + `verifyGlobalIdMigration` 字段漂移/条目数变化/既有号被改/新号非单调各返回问题。
- `todo-cli.test.ts`：⑥ add 落盘 `globalId` 递增、`list --json` 带 `globalId` 而人读行与 `summary` 字节不变；⑦ 写门禁六个写命令 `GLOBAL_ID_PENDING` exit 1 且文件字节不变、`list`/`lint` 仍可读（lint 报缺失行）；⑧ 号不回收（complete/reopen 后计数器不动、再 add 不复用已收口号）；⑨ lint 逮跨文件重复号 exit 1、手工仲裁 + 迁移后通过。
- `migrate.test.ts`：⑩ 稳定顺序取号 + 逐字段保全（全时间戳/tags/dependsOn/多 notes 深比对）+ dry-run 零写盘零取号；⑪ 幂等重跑零动作零写盘 + 重复号预检中止零写盘；⑫ from-md 产 v4 完备（逐条 `globalId` + 计数器就位）、to-md 对 v4 照常（`globalId` 不进 md）。
- `concurrency.test.ts`：⑬ 跨文件 3+3 真子进程并发 add——唯一性只靠 `id.lock`、6 条全落全互异、计数器 = max+1、locks 零残留、stderr 恒空；⑭ 既有同文件并发 add 追加 `globalId` 互异断言。
- `interrupt.test.ts`：⑮ SIGKILL 风暴后全台账 `globalId` 互异、计数器 ≥ `max(globalId)+1`（烧号/缺口允许，重号与倒退不允许）。
- 必跑门：`npm run test:todo`（107 个全绿）+ `node .agents/skills/todo-cli/todo-cli/todo.mjs lint`（exit 0）；人类输出契约的字节级回归由既有用例承担，除「version 字面量 3→4」的刻意更新外不改语义。

## 范围外

- 不做 `--global-id` 过滤参数、不改 `--match`/排序/`文件#id` 展示（对齐文档明确不做）。
- 不做 ULID/UUID 型 id、不做惰性分配、不做全写操作升级全局锁。
- 不做写前自动迁移/定时迁移（一次性显式命令）；不做合并冲突的自动仲裁（`globalId` 只是判同身份，手工并集 + lint 兜底不变）。
- `migrate to-md` 不表达 `globalId`（md 无此语法，逃生舱保持降级语义）。
- 不改 `lock.ts`/`depends.ts`/`align.ts`/`todo.mjs` 契约；不改仓库外文件；不做主仓库根 `todos/` 的实际迁移（由主会话验收后与 merge 同一 push 执行）。
