# 规格：todo 依赖关系（dependsOn + 依赖门）

> 来源：`todos/todo-cli-todo.json` #10（用户 2026-09-12 登记，2026-09-14 对齐）
> 对齐：2026-09-14 用户对 6 个决策点全部采纳（引用形态 / 声明入口 / 阻塞边界与展示 / 环与悬空 / schema 版本 / 取消即解锁），见 `todos/align/todo-cli-todo#10.md`
> 状态：已实现

## 问题陈述

「A 的开工前提是 B 完成」这类约束此前无处声明：只能写进条目文本或人的记忆。B 未落地就开 A 的工，返工发生在最贵的时候（已经写完全部代码）。台账已经有五态与对齐门（ADR-0003），但门只看条目自身——**条目之间的关系是盲区**。

缺的不是「更聪明的排序」，而是一条可机器验证的硬约束：A 声明依赖 B 后，只要 B 不是 `done`，A 就不能开工（不能从 `aligned` 进 `processing`），且在盘点时看得见「现在在等谁」。

## 方案

**数据**：条目新增原生字段 `dependsOn: string[]`。存储形态统一为规范引用 `文件基名#id`（如 `general-todo#11`，同文件也写全名）；输入接受与 `--file` 同口径的四种写法（`general` / `general-todo` / `general-todo.json` / `general-todo.md`）并归一。schema 升 v3：写出必填（空数组），读 v1/v2 归一为 `[]`。

**声明入口**：登记时 `add --dep a#1,b#2`；此后用新子命令 `dep` 增删——`dep add --file <名> --match "子串" --on a#1,b#2`、`dep remove --file <名> --match "子串" --on a#1`（均经 `--file` + `--match` 唯一定位引用方）。不做 `dep list`：`list --json` 已带 `dependsOn`。

**依赖门（唯一硬门）**：第二次 `claim`（`aligned → processing`）时，若存在 `status !== done` 的依赖，则 fail-closed——exit 1、静态错误码 `DEP_BLOCKED`、逐条列出 `<文件#id>（<状态>）`、不写盘（条目留在 `aligned`）。首次 `claim`（`open → aligning`）与 `align` 不受此门约束：被阻塞条目可以先对齐、先写文档再排队。

**写入期校验**：`add --dep` / `dep add` 拒绝「目标不存在」「自引用」「成环」（成环回显环路径，如 `a#1 → b#2 → a#1`）；`dep remove` 对不在 `dependsOn` 里的引用报错。全部不写盘、exit 1。

**lint 全量扫描**：悬空引用 / 自引用 / 依赖环——跨分支合并能造出写路径没见过的图，lint 是对账出口。

**展示口径**：`list` 人读行对阻塞条目行尾追加阻塞标记（非阻塞条目字节不变）；`list --json` 增加 `dependsOn` 与派生 `blocked`（由未完成依赖推导）；`triage` 在 `aligned` 段列出阻塞明细；`summary` 与排序一律不变。

**取消即解锁**：不新增第六态。`complete` 一律 `done` ⇒ 依赖机械解锁；`complete` 输出追加一行提示，列出直接依赖本条目的未完成条目。

## 用户故事

- 作为 agent，A 依赖 B 时我不能开工，且拿到「在等 B（`general-todo#11`，processing）」的明确提示，而不是开工后才发现前提未落地。
- 作为 agent，我登记 A 时顺手写 `--dep general-todo#11`，依赖声明与需求登记同一步完成，不必事后再补。
- 作为 agent，我在盘点时就能看出哪些 `aligned` 条目被阻塞（`list` 标记 / `triage` 明细），不会反复撞门。
- 作为 agent，我写错引用（指向不存在的条目）或造出环（含自引用）时立刻被拒绝，并看到环路径。
- 作为 agent，合并两个分支后跑 `lint` 能发现合并造出的悬空引用与环。
- 作为人，被依赖条目被取消（`complete --note`）时我收到「哪些条目依赖它」的提示，从而决定是否重新对齐下游。

## 实现决策

- `schema.ts`：`TodoFileVersion` 增 3；`TodoEntry` 增 `dependsOn: string[]`；`validateEntry` 在 v3 下要求 `dependsOn` 是字符串数组，v1/v2 读入归一为 `[]`；`parseTodoJson` 接受 `1|2|3`，返回 `{version: 3}`；`serializeTodo` 输出 v3。
- 新增纯函数模块（`depends.ts`）：引用解析与归一（`parseDepRef` / `formatDepRef` / `normalizeDepRef`）、`resolveDepTargets`（引用 → 命中条目，处理短名/不存在）、`detectDepCycle`（在写入候选图上做 DFS，返回环路径或 null）、`findDepProblems`（全量台账的悬空/自引用/环清单，供 lint）、`isBlocked`（条目 + 全量索引 → 未完成依赖清单）。
- `core.ts`：`runClaim` 在 `aligned → processing` 分支前调用依赖检查（阻塞 → `DEP_BLOCKED` + exit 1，不写盘）；`runAdd` 解析 `--dep` 并做写前校验；新增 `runDep`（`add`/`remove`）；`runComplete` 在成功后计算「直接依赖本条目且未完成」的列表并输出提示行；`runList` 人读行追加阻塞标记、`--json` 补 `dependsOn` 与 `blocked`；`lintTodos` 接入 `findDepProblems`；`REPO_COMMANDS` 增 `dep`，`USAGE` 同步。
- `query.ts`：`QueryEntry` 增 `dependsOn: string[]` 与派生 `blocked: boolean`；`serializeEntries` 只对 `blocked` 条目追加标记（`（阻塞：等待 a#1, b#2）`），非阻塞行字节不变。
- `migrate.ts`：md 无依赖语法，迁移条目的 `dependsOn` 一律 `[]`（等价自检沿用既有字段集，不新增 md 语法）。
- 错误码：`DEP_BLOCKED`（门）、`DEP_NOT_FOUND`（目标不存在）、`DEP_SELF`（自引用）、`DEP_CYCLE`（环，附路径）、`DEP_ABSENT`（`dep remove` 移除不存在的引用）——全部走 stdout 静态模板，不插值用户输入以外的内容；退出码 1。
- 文档：`CONTEXT.md` 五个术语；ADR-0005；`docs/tools/todo-cli.md`（含 `last verified`）；`SKILL.md`；根 `README.md` 测试数。

## 测试决策

- `depends.ts` 纯函数（`test/depends.test.ts`）：引用归一四写法；短名歧义与不存在；自引用；二元环、跨文件三元环、无环的反例（同一节点两条路径）；`findDepProblems` 对悬空/自引用/环的分类；`isBlocked` 只看直接依赖且 `done` 即解锁。
- schema（`test/schema.test.ts`）：v3 可读；v1/v2 读入归一 `dependsOn: []`；v3 缺 `dependsOn` / 类型非字符串数组拒绝；`version: 4` 拒绝；写出 `"version": 3`。
- core 闭环（`test/todo-cli.test.ts`，临时 fixture）：`add --dep` 写入归一引用并拒绝悬空/自引用/环；`dep add` / `dep remove` 成功与失败各例；`claim` 阻塞（exit 1 + 提示含 `文件#id` 与状态 + 条目仍为 aligned）→ 依赖 `complete` 后同一命令成功转 `processing`；被阻塞条目仍可首次 `claim`（对齐不受阻）与 `align`；`list` 人读标记与非阻塞行字节不变、`--json` 带 `dependsOn`/`blocked`；`summary` 输出与改动前逐字节一致；`complete` 提示行；`lint` 对含环/悬空台账 exit 1。
- 真子进程（`test/concurrency.test.ts`）：两个子进程并发 `dep add` 到同一文件不同条目——无丢更新、无锁残留；并发下环校验仍 fail-closed。
- 进程边界 E2E：`--help` 含 `dep`；`dep` 缺 `--file` / `--match` / `--on` 的提示与 exit 1、stderr 恒空。
- 必跑门：`npm run test:todo`、`npm run test:contract`、`npm run test:smoke`、`node .agents/skills/todo-cli/todo-cli/todo.mjs lint`。

## 范围外

- 不新增第六态（「取消/搁置」仍是 `done`），不区分完成与放弃。
- 不改 `list` / `summary` / `triage` 的排序；blocked 不沉底。
- 不做依赖的传递展开提示、不做依赖图可视化、不做自动 claim / 自动等待。
- 不做 `dep list` 子命令、不加 `reopen` / `--force` 旁路。
- 不动 `lock.ts`、`align.ts` 契约、`migrate` 的 md 语法（md 里不表达依赖）。
- 不改仓库外文件（`~/.pi/agent/skills/`）；不加根级 typecheck 门。
