# todo-cli-todo#10 todo 依赖关系（dependsOn + 依赖门）

> 领取：2026-09-14（`claim --branch feat/todo-cli-depends-on`）· 对齐访谈：2026-09-14 第一轮 Q1–Q6 逐条答问
> 门的插位由 ADR-0003 钉死：`aligned → processing` 之前（对齐已完成、尚未开工）

## 意图

把「A 的开工前提是 B 完成」从人脑记忆变成台账里可机器验证的约束：条目之间可声明依赖（A 依赖 B），B 未完成（`status !== done`）时 A 不得开工——在开工门上 fail-closed，并给出可断言的阻塞提示（逐条列出未完成依赖的 `文件#id` 与状态）。

目的：在返工成本最低处（开工前）挡住「前提未落地就动手」，让 agent 领取前就看见「现在还不能开工、在等谁」。

## 范围

做什么：

1. 依赖引用形态（Q1）：存储一律规范化为 `文件基名#id`（如 `general-todo#11`，无 `.json`，同文件也写全名）；输入接受与 `--file` 同口径的四种写法（`general` / `general-todo` / `general-todo.json` / `general-todo.md`），写盘前归一；允许跨文件依赖。
2. 声明入口（Q2）：登记时 `add --dep a#1,b#2`（逗号分隔，与 `--tag` 同构——`parseArgs` 对重复 flag 只留最后一个）；改依赖用新子命令 `dep`（`dep add --file <名> --match "子串" --on a#1,b#2` / `dep remove --file <名> --match "子串" --on a#1`）；不做 `dep list`（用 `list --json` 的 `dependsOn` 字段）。命令面 8 → 9 子命令。
3. 依赖门（Q3）：唯一硬门 = 第二次 `claim`（`aligned → processing`）；被阻塞时 exit 1、静态错误码 `DEP_BLOCKED`、逐条列出未完成依赖的 `文件#id` 与状态，不写盘（条目留在 `aligned`）。首次 `claim`（`open → aligning`）与 `align` 不受阻——被阻塞条目可以先对齐、先写文档。
4. 写入期校验（Q4）：`add --dep` / `dep add` fail-closed 拒绝「目标不存在」「自引用」「成环」（回显环路径）；`dep remove` 对不存在的引用报错。
5. lint 全量扫描（Q4）：悬空引用 / 自引用 / 依赖环——跨分支合并能造出写路径没见过的环。
6. 展示口径（Q3）：`list` 人读行对阻塞条目行尾追加阻塞标记（非阻塞条目字节不变）；`list --json` 增加 `dependsOn` 原生字段与派生 `blocked` 字段；`triage` 在 `aligned` 段列出阻塞明细；`summary` 不变（字节稳定）。
7. 取消即解锁（Q6）：`complete` 一律 `done` ⇒ 机械解锁；`complete` 输出追加一行提示，列出直接依赖本条目的未完成条目。不新增第六态。
8. schema v3（Q5）：条目新增 `dependsOn: string[]`，写出必填（空数组），读 v1/v2 归一为 `[]`，不做批量回填；`alignedAt` 仍自 v2 起必填。
9. 文档同步：`CONTEXT.md` 术语（依赖 / 依赖门 / 阻塞条目 / 悬空引用 / 依赖环）、新 ADR `docs/adr/0005-todo-depends-on.md`、规格 `docs/specs/todo-cli-depends-on.md`、卡片 `docs/tools/todo-cli.md`（含 `last verified`）、`SKILL.md` 命令参考卡、`USAGE`。

明确不做什么：

- 不新增第六态（「取消/搁置」仍是 `done`，不区分语义）。
- 不改 `list` / `summary` / `triage` 的排序（blocked 不沉底）；不改非阻塞条目的输出字节。
- 不做依赖图的传递展开（只报直接依赖的未完成状态，不展开下游）。
- 不做 `dep list` 子命令、不做依赖优先级 / 自动 claim / 自动等待。
- 不动 `lock.ts`、`migrate`、`align.ts` 的既有契约；不改仓库外文件（`~/.pi/agent/skills/`）。

## 验收标准

1. 依赖未完成时 `claim`（`aligned → processing`）exit 1、输出含每个未完成依赖的 `文件#id` 与状态、条目仍为 `aligned`。
2. 依赖全部 `done` 后同一命令 exit 0 且条目转 `processing`。
3. 环（含跨文件环与自引用）与悬空引用在 `add --dep` / `dep add` 写路径被拒绝、exit 1、不写盘；`lint` 对含环/悬空的台账 exit 1 并列出问题条目。
4. 旧台账零破坏：现有 18 个 `todos/*.json` 全部可读（读 v1/v2 归一 `dependsOn: []`）；任一写操作后文件变 `version: 3` 且条目齐全。
5. `list` 人读行：阻塞条目带标记、非阻塞条目字节不变；`list --json` 含 `dependsOn` 与 `blocked`；`summary` 输出与改动前逐字节一致。
6. 单测覆盖：引用形态归一（四种写法）、跨文件依赖、写路径环/悬空拒绝、claim 门（阻塞 → 解锁）、`dep add/remove`、lint 扫描、schema v3 兼容；真子进程用例覆盖锁路径（并发写依赖不丢更新）。
7. 必跑门全绿：`npm run test:todo`、`npm run test:contract`、`npm run test:smoke`、`node .agents/skills/todo-cli/todo-cli/todo.mjs lint`。
8. 文档同步：`CONTEXT.md` / ADR-0005 / 规格 / 卡片（`last verified` 更新）/ `SKILL.md` / `USAGE` / 根 `README.md` 测试数。

## 人工确认

确认人：用户 · 日期：2026-09-14 · 方式：本会话逐条答问，六项建议全部采纳——Q1 引用形态（`文件基名#id` + 四种写法归一 + 允许跨文件）、Q2 声明入口（`add --dep` + `dep add/remove`，命令面 8→9）、Q3 阻塞边界（硬门只在第二次 claim；list 加标记、triage 列阻塞、summary 不变）、Q4 环与悬空（写路径拒绝 + lint 全量扫描双保险，悬空不放行）、Q5 schema 升 v3、Q6 done 即解锁 + `complete` 提示。用户答复「没问题」。
