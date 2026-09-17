# 规格：todo 条目优先级（priority 软字段 + add --priority + list [pN]/--sort priority）

> 来源：`todos/todo-cli-todo.json` #15（2026-09-17 登记并领取）
> 对齐：`todos/align/todo-cli-todo#15.md`（已过人工确认；实施顺序 / 标记格式 / 轻量口径三项经用户批复，见 `history/team-runs/run-20260917-todocli15/10-design.md` §11）
> 状态：已实现（分支 `feat/todo-cli-priority`）

## 问题陈述

`todos/*.json` 的条目没有轻重缓急概念：`list` / `summary` 全靠人工读全文排期，登记时 agent 也无法表达「这条比那条急」。缺一个可写、可读、可排序的优先级字段。

本单的特殊约束是合成关系：姊妹单 #16（统一 globalId）方案已定稿但停在审批门，且其定稿方案把 schema v4 定义为「globalId 必填」。priority 的落法必须对「#16 先落 / 后落 / 并行」三种时序都成立。

## 方案

**软字段（不占版本位）**：`entries[].priority` 整数 1-10（10 最高），JSON 全版本（1/2/3/未来 4）可选；内存态必有（缺失读时归一 5）。v3→v4 独家归 #16 的 globalId，priority 在 v4 里继续保持可选——两单语义正交：globalId = 身份（必填），priority = 排期（可选）。

**写入**：`add --priority <1-10>`（缺省 5）。非十进制整数形态（`3.5` / `abc` / `1e1` / `+5`）、越界（`0` / `11` / `-1`）与裸 `--priority`（缺值空串）一律 `BAD_PRIORITY` + exit 1、不读不写盘；前导零 `05` 按数值 5 接受；成功日志不回显优先级。无 `priority set`（改值走 `reopen` → 重登记）。

**读取**：`list` 人读行在 `文件#id` 两空格后插 `[pN]`（不零填充）；`list --sort priority` = (priority desc, file asc, id asc)（同值桶保持默认序）；`list --json` 带字段；默认 `list` 除标记外与之前逐字节一致。

**present-but-invalid = BAD_SCHEMA（fail-closed）**：JSON 缺失 → 兜底 5；出现但非法（`"高"` / `3.5` / `0` / `11` / `null` / `true`）→ 结构损坏报错，不静默修复。与命令面的 `BAD_PRIORITY` 是同一家风的两层表达：入口拦非法输入，存储拦非法数据。

**顺带落字段（非批量回填）**：任一写操作整文件重写时，既有条目缺失的 priority 补 5（parse 归一 → serialize 自然落盘）；读命令（list/summary/triage/lint）永不写，旧文件保持字节原样。「顺带」与「强制」的分界 = 是否产生本不会发生的写盘。

**不进**：状态机、依赖门（`DEP_BLOCKED` 条件）、查重、`summary`/`triage` 输出、`--match`。优先级只影响展示/排序/人工排期。

## 用户故事

- 作为 agent，我登记时能用 `--priority` 表达这条比那条急（1-10，10 最高），不写就是 5。
- 作为 agent，我敲错优先级（`0` / `11` / `3.5` / `abc`）时被 fail-closed 拦下，台账零改动。
- 作为 agent / 人，我扫 `list` 时在行首固定列看到 `[pN]`，不用读全文判断缓急。
- 作为人，我排期时用 `list --sort priority` 拿到「最急在前」的稳定清单（同优先级内仍是文件 → id 序）。
- 作为机器消费方，我从 `list --json` 拿到 `priority` 字段自行排序。
- 作为存量台账（195 条全无 priority），我什么都不用做：读时兜底 5，读命令不改我的文件，下一次写操作自然补字段。
- 作为维护者，我不担心 priority 抢了 #16 的版本位：两单可以任意先后落地。

## 实现决策

- `schema.ts`：`TodoEntry.priority`（插 tags 与 dependsOn 之间）；`validateEntry` 加版本无关软校验（出现即查，三重门 typeof → Number.isInteger → 1..10）；`parseTodoJson` 归一处 `priority: record.priority ?? 5`。`serializeTodo` / `emptyTodoData` / `nextId` 零改动（整对象序列化自动落字段）。
- `core.ts`：本地纯函数 `parsePriorityOption`（result union，`BAD_PRIORITY` 随所属层码走，消息静态模板不插值输入；与 `parseDepRefsOption` 同型）；`runAdd` 在 text 校验后、读盘前解析（fail-closed 不读不写）；entry 字面量加一行；`runList` 一行接线 `{ json, sort }`；`USAGE` 两行同步。
- `query.ts`：`QueryEntry.priority`（core 的 `{...entry}` 投影自动携带 ⇒ `--json` 无需改投影代码）；新导出 `sortByPriority`（先默认序、再以 priority 降序做稳定 sort）；`serializeEntries` opts 扩 `sort?: "priority"`（排序决策收在唯一输出路径，不信任调用方输入序）；人读行模板插标记；`parseFilterOptions` 扩 `sort`（非法值/空串 → 既有 `BAD_FILTER`，list 选项解析失败统一出口）。
- `migrate.ts`：`buildTodoData` 字面量加 `priority: 5`（md 无优先级语法，与 tags / dependsOn 同型默认值）；`renderMarkdown` 不渲染（to-md 是逃生降级，丢 priority 可接受）。migrate 子命令面 / 等价自检结构零变化。
- `lock.ts` / `depends.ts` / `align.ts` / `todo.mjs` 零改动：priority 是纯数据字段，写入落在既有文件锁临界区内，无新并发面。
- 新错误码：`BAD_PRIORITY`（core 层，随 `parsePriorityOption` 的 result union 走——todo-cli 无 errors.ts 惯例，与 `BAD_JSON` / `BAD_SCHEMA` / `BAD_FILTER` 同构）；复用 `BAD_SCHEMA`（新 reason 模板「条目 priority 必须是 1-10 的整数」）与 `BAD_FILTER`（新消息「--sort 只支持 priority」）。
- 文档：SKILL.md / `docs/tools/todo-cli.md` / 根 README / CONTEXT.md「条目（Entry）」词条 / ADR-0009（原拟 0008，#16 先合并占号后顺延）；根版本 2.55.0（集成时点 minor）。

## 测试决策

- `test/schema.test.ts`（+4）：S1 全版本缺失兜底 5（v1 带合法值保留）；S2 边界 1/5/10 保真；S3 六种非法形态 `BAD_SCHEMA`；S4 parse→serialize 往返补字段。
- `test/query.test.ts`（+5）：Q1 `sortByPriority` 键序与输入序无关；Q2 `serializeEntries` 排序接线与默认序不变；Q3 人读行标记格式（`[p10]` 不填充、阻塞后缀原样）；Q4 `--json` 带字段；Q5 `--sort` 解析 fail-closed。
- `test/todo-cli.test.ts`（+7）：T1 add 缺省 / 边界 / 前导零 / 日志不回显；T2 非法值 exit 1 + 文件字节不变 + 目标文件不创建；T3 旧数据读兜底 `[p5]` + 零写盘 + 写路径顺带补 5 且 version 不变；T4 `--sort priority` 端到端与默认序对照 + `BAD_FILTER`；T5 默认 list「现版格式 + `[pN]`」逐字节对照；T6 `--json` 带字段 + summary 不变（人读与 `--json`）；T7 真子进程 E2E（`--help` 含新 flag；拷工具进临时仓库跑 add/list）。
- `test/migrate.test.ts`（+2）：M1 from-md 条目一律 5；M2 to-md 带 priority（含非 5）照常渲染、md 无语法、往返抹平为 5（已知坑回归锁）。
- 存量断言适配（只加标记/字段，不改序不改措辞）：`query.test.ts` / `todo-cli.test.ts` / `interrupt.test.ts` 的人读行 deepEqual 补 ` [p5]`；`schema` / `concurrency` / `interrupt` 的 TodoEntry fixture 补 `priority: 5`。
- 门：`npm run test:todo` 134/134（集成 #16 后实测）+ `lint` exit 0。

## 范围外

- `priority set` 子命令、批量改优先级（reopen → 重登记是既有通道）。
- 默认排序改优先级、`summary`/`triage` 加优先级、`--priority` 过滤。
- schema 版本位变更、任何 migrate 子命令、主动批量回填（顺带落字段由日常写操作自然发生）。
- globalId 相关一切（#16 的领地）；本单只立接口约定：其迁移逐字段保全清单必须包含 priority。
- 零填充标记、`[pN]` 可配置、按 priority 的通知 / 拦截 / 自动排期。
