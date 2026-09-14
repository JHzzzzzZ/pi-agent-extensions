# 规格：todo 状态机扩为对齐驱动（open → aligning → aligned → processing → done）

> 来源：`todos/todo-cli-todo.json` #11（用户 2026-09-12 登记，2026-09-14 选定方案）
> 对齐：2026-09-14 用户对 5 个决策点全部同意（门形态 / 对齐文档落点与校验 / 依赖门插位 / 展示口径 / 收口门）
> 状态：已实现

## 问题陈述

现在 `claim` 一步把 open 直接转 processing——领取即开工。但真正贵的返工发生在开工前：条目文本三言两语，agent 按自己的理解写代码，做完才发现意图没对齐。缺一道**可审计的人工对齐门**：领取后必须先写逐条对齐文档、与人工确认，才能动代码。

CLI 无法证明「是人敲的」，能证明的只有两件机器可验证的事实：**状态迁移顺序合法**、**对齐文档存在且结构完整**。人工门本身靠流程留痕（文档 `## 人工确认` 小节 + 红线 10 审批）。

## 方案

状态机扩为五态，`claim` 变两段式，新增子命令 `align`：

| 命令 | 当前状态 | 结果 |
| --- | --- | --- |
| `claim [--branch X]` | open | → `aligning`；`branch` = 提供值或 null；`claimedAt` = now（首次领取，之后不覆盖）；输出对齐文档路径 + 必填小节 |
| `claim` | aligning | 幂等：不写盘、状态未变；输出仍提示「写文档 → 人工确认 → align」 |
| `claim [--branch X]` | aligned | → `processing`；`branch` 提供了就覆盖、没提供保留原值（不置 null） |
| `claim` | processing | 幂等：不写盘、状态未变 |
| `claim` | done | `ALREADY_DONE` + exit 1（不变） |
| `align [--note T]` | aligning | 校验对齐文档 → → `aligned`；`alignedAt` = now；`--note` 逐字进 notes（可选） |
| `align` | aligned | 幂等：不写盘、状态未变 |
| `align` | open / processing / done | `NOT_ALIGNING` + exit 1 |
| `complete [--note T]` | open / processing | → `done`；`--note` 可选（不变） |
| `complete [--note T]` | aligning / aligned | → `done`；**必须带 `--note`**，否则 `NOTE_REQUIRED` + exit 1（取消/搁置要留原因） |
| `complete` | done | 幂等：不写盘、状态未变（不变） |

对齐文档契约（`align` 时校验，任一不满足 fail-closed）：

1. 路径固定派生 `todos/align/<todo 文件基名>#<id>.md`（不接受 `--doc` 自由路径 → 无路径穿越面）；不存在 → `ALIGN_DOC_MISSING：缺少对齐文档 <派生路径>`。
2. 正文出现 `<文件基名>#<id>` 字样（推荐写在 H1，防串条目复制）。
3. 四个二级小节齐全且各有一段非空正文：`## 意图`、`## 范围`、`## 验收标准`、`## 人工确认`；否则 `ALIGN_DOC_INCOMPLETE：对齐文档缺少小节：<清单>`（第 2 条不满足时标记同列进清单）。

单源模板写在 `docs/tools/todo-cli.md`；`claim` 只打印路径 + 小节名，不打印整篇、不代建文件。

## 用户故事

- 作为 agent，登记/领取后得到「写对齐文档 → 拿人工确认 → `align`」的明确下一步，在返工成本最低处把意图问清。
- 作为 agent，对齐文档不完整时 `align` 明确报缺哪些小节，而不是放行一个空壳门。
- 作为人，`complete` 从对齐阶段收口必须留原因（取消/搁置可追溯）。
- 作为 agent，`aligned` 之后的 `claim` 才是「开工」，从 processing 到合并全程无人值守。

## 实现决策

- 新增 `.agents/skills/todo-cli/todo-cli/align.ts`（当时的 `todo-cli/align.ts`；纯函数、零 IO）：`alignDocPath` / `alignDocRelPath` / `ALIGN_SECTIONS` / `validateAlignDoc`。
- schema 升 v2：条目新增 `alignedAt: string | null`；`ENTRY_STATUSES` 五态；`parseTodoJson` 接受 `version: 1 | 2` 并在内存归一成 v2（v1 的 `alignedAt` 视为 null），写出一律 v2（任一写操作重写整文件 ⇒ 该文件一次性升级；不做批量回填）。
- 历史语义保留：现存 `open`/`processing`/`done` 原义不变；历史 `processing` 视为「已开工」，不要求补对齐文档、不回退状态。
- 展示/统计口径：list 行首标记 `[ ]` / `[?]`(aligning) / `[>]`(aligned) / `[~]`(processing) / `[x]`(done)；`summary` 五态 + total；`triage` 保留 `processing` 段语义不变并新增同构的 `aligning`/`aligned` 段；`lint` 不变。
- `migrate`：`renderMarkdown`/`parseLegacyMarkdown`/`buildTodoData`/`countEntries` 覆盖五态，`from-md` 等价自检在新状态下仍成立。
- 依赖门（#10 `dependsOn`）契约插在 `aligned → processing` 之前，本变更不实现。
- 回滚边界：旧版 CLI 读 v2 文件会明确报错（`version 必须是 1`），回滚 = git 历史 + `migrate to-md`。

## 测试决策

- `align.ts` 纯函数：路径派生；空文档/缺小节/小节空正文/缺 `名#id` 四种失败各自报出缺项；正常文档通过。
- schema：v1 可读且归一为 v2；v2 可读；`version: 3` 拒绝；非法 status / `alignedAt` 非字符串拒绝；`serializeTodo` 输出 `"version": 2`。
- core 闭环（临时 fixture）：claim→aligning→align 无文档报 `ALIGN_DOC_MISSING`→写文档→align=aligned→align 幂等→claim=processing（branch 保留/覆盖两例）→complete=done；`align` 在 open/processing/done 报 `NOT_ALIGNING`；`complete` 从 aligning/aligned 无 `--note` 报 `NOTE_REQUIRED`。
- query：五标记 + `--status aligning|aligned` 过滤。
- summary/triage：五态计数、`aligning`/`aligned` 段（active/stale/noRef）、`--json` 可解析、triage 只读。
- migrate：新状态 md 渲染↔解析 round-trip 等价、日志五态计数、`to-md` 保 JSON。
- 真子进程（concurrency）：claim 断言改 `aligning`；新增「claim → 写文档 → align → 再 claim」序列；两个子进程同时 `align` 同一条目（幂等、无丢更新、无锁残留）。
- E2E：`--help` 用法含 `align`；`align` 缺 `--match` / 缺 `--file` 提示 + exit 1、stderr 恒空。
- 必跑门：`npm run test:todo`、`npm run test:contract`、`npm run test:smoke`、`node .agents/skills/todo-cli/todo-cli/todo.mjs lint` 全绿。

## 范围外

- 不实现 `dependsOn`/环检测（#10）：只把契约写进 ADR 与卡。
- 不回填历史 `processing` 条目的对齐文档，不加批量迁移命令。
- 不加 `reopen`/`shelve`/`--force` 旁路；取消/搁置 = `complete --note`。
- 不动 `lock.ts`、`lint`、`migrate to-md` 的定位、`--claimed-since` 语义。
- 不新增/不重建仓库外 skill 文件（`~/.pi/agent/skills/`）；不改任何仓库外文件。
- 不加根级 typecheck 门；不改 `agent-manager/`、12 个扩展目录。
