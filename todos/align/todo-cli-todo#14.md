# todo-cli-todo#14 reopen 子命令：把在途条目退回未领取

> 领取：2026-09-15（`claim --branch feat/todo-cli-reopen`）· 对齐访谈：2026-09-15 两轮 Q1–Q7 逐条答问
> 推翻 ADR-0003 的「历史 processing 不回退状态」：回退语义见新 ADR-0007，0003 只留指针

## 意图

五态是前向机（`open → aligning → aligned → processing → done`），`claim` 在 `processing` 上幂等 no-op，`docs/tools/todo-cli.md` 明写「历史 processing 不回退状态」—— 实际撞上 9 条**虚空 processing**（8 条 route A 上游根修跨插件登记 + agent-team#66）：零 claim、零分支、零对齐文档，却没有任何受支持手段退回未领取。

唯一替代（`migrate to-md` → `from-md --force`）的代价比条目原文说的更重：`buildTodoData` 从 1 重新编号（`migrate.ts`），除丢 `createdAt`/`claimedAt`/`completedAt`/`alignedAt`/`tags` 外还**重排条目 id** —— 而 id 是永不复用的条目身份。

要的是：给状态机一条显式的、可审计的回退通道，让台账诚实反映「这些条目从未真正开工」，且不伤任何历史字段。

## 范围

做什么：

1. 新子命令 `reopen --file <名> --match "子串" [--note "原因"]`：来源 `aligning` / `aligned` / `processing` 一律 → `open`，清空 `branch` / `claimedAt` / `alignedAt`；沿用既有锁（`withTodoLock`）+ 原子写 + `--match` 唯一定位口径（0 条或多条 fail-closed，绝不猜）。
2. 幂等与拒绝：已是 `open` → `changed:false`、exit 0、文件字节不变；`done` → exit 1 不写盘（撤销已完成条目另条登记）。
3. note 门（Q3，对齐 `complete` 先例）：来源 `aligning` / `aligned` 必须带 `--note`，否则 `NOTE_REQUIRED` + exit 1 不写盘；来源 `processing` 可选。
4. 注记文案（Q4）：追加单条注记 `撤销 <YYYY-MM-DD>：从 <源状态> 回到未领取`（日期取 `now()` 的 UTC 日期部分，与其它时间戳同口径）；带 `--note` 时同一条内以 `；` 连接原因、原因逐字（不解析括号/换行）。只追加不覆盖。
5. 陈旧对齐文档归档（Q1/Q6）：reopen 时把 `todos/align/<名>#<id>.md` 改名为 `todos/align/<名>#<id>.reopened-<UTC 紧凑时间戳>.md`（如 `.reopened-20260915T141733Z.md`）—— 旧留痕保留、规范路径腾空，重新 `claim` → `align` 必须重写新文档，否则 `align` 报 `ALIGN_DOC_MISSING`（否则旧文档会零人工二次过门，那道门就成摆设）。文档不存在（如本次 9 条虚空 processing）→ 跳过归档、正常通过。归档先于 JSON 写：归档失败整体中止、不写盘。归档文件保持 `.md` 后缀（命中 `.gitattributes` 的 `todos/align/*.md` LF 锁，不新增目录/pattern）。
6. 字段动刀范围（Q4）：保留 `id` / `text` / `createdAt` / `completedAt`（来源非 done，恒 null）/ `tags` / `dependsOn` / 全部历史 notes；`--branch` 不在 reopen 的参数面上（要分支引用等下次 `claim`）；schema 不动（仍 v3，无新字段）。
7. 语义边界（已核实）：reopen **不影响依赖语义** —— 来源状态本来都不是 `done`，依赖者的阻塞状态前后一致，故不告警下游；不碰 git / worktree / 分支（triage 的「无分支引用」段自然缩短）；不新增第六态（取消/搁置仍是 `complete --note`）。
8. 契约同步：`core.ts` 的 `USAGE` + `REPO_COMMANDS` + 分派；`SKILL.md`（frontmatter description + 命令面 + 不变量）；`docs/tools/todo-cli.md`（命令面契约改写成显式十子命令列表、状态机迁移表加 revert 行、「历史 processing…不回退状态」的已知坑改写、文件地图与改动清单测试数）；`CONTEXT.md`（新增术语「撤销（reopen）」；`complete` 词条 `_Avoid_` 点明「搁置/取消 ≠ 撤销」；顺手订正「条目（Entry）」词条的 schema v2 → v3 与补 `dependsOn` 字段——事实订正）；新 ADR `docs/adr/0007-todo-reopen.md` + ADR-0003 Consequences 加一行指针；规格 `docs/specs/todo-cli-reopen.md`；根 `README.md`（命令清单 + 测试数两处）；根版本 2.50.0（`chore(pi):` 独立 commit）。
9. TDD 先红后绿：三来源各一例 + 幂等 + `done` 拒绝 + 0/多匹配 fail-closed + note 门 + 归档行为（含归档失败不写盘）。

明确不做什么：

- 不做批量 reopen（无 `--all` / `--status` 之类）、不删归档文件、不做 `done` 的撤销。
- 不改 `align` 的判定口径（不加 mtime 判定：git 不保留 mtime，那道判定会漏水）、不改 `claim` / `complete` / `migrate` / `lock` / `schema` 的既有契约。
- 不新增第六态、不改 `list` / `summary` / `triage` 的输出字节（状态计数自然变化除外）。
- 不碰 `todos/` 之外（不 commit、不删 worktree、不动分支）；不改仓库外文件（`~/.pi/agent/skills/`）。

## 验收标准

1. 三来源各一例：`aligning` / `aligned` / `processing` 的条目 reopen 后 `status === "open"`、`branch` / `claimedAt` / `alignedAt` 全 null、`tags` / `dependsOn` / `createdAt` / 历史 notes 原样、末条注记为 `撤销 <UTC 日期>：从 <源状态> 回到未领取`（带 `--note` 时以 `；` 连接）。
2. 幂等：已是 `open` 再 reopen → exit 0、`changed:false`、文件字节不变。
3. `done` 拒绝：exit 1、不写盘、条目仍 done。
4. 匹配口径：0 匹配与多匹配都 exit 1、不写盘（复用 `locateEntry`）。
5. note 门：来源 `aligning` / `aligned` 无 `--note` → `NOTE_REQUIRED` + exit 1 不写盘；来源 `processing` 无 `--note` → 通过。
6. 归档：来源有对齐文档 → 规范路径消失、出现 `<名>#<id>.reopened-<ts>.md`、随后 `claim` → `align` 报 `ALIGN_DOC_MISSING`；来源无文档 → 正常通过；归档路径被占（目录占位）→ exit 1、JSON 零改动。
7. 写路径沿用每文件 O_EXCL 锁 + temp+rename 原子写；既有 88 个测试零破坏，新增用例走 `node:test` 且不引入 mock 库。
8. 必跑门全绿：`npm run test:todo` + `node .agents/skills/todo-cli/todo-cli/todo.mjs lint`（exit 0）；根 `README.md` / 卡片测试数同步为实测值。
9. 真机闭环：先用 `reopen` 把本次 9 条虚空 processing（8 条 route A + agent-team#66，`--note "从未开工：零 claim / 零分支 / 零对齐文档"`）撤销为 `open`，再跑 `triage` 确认 processing 段清零、无分支引用清单为空。
10. 文档同步齐（范围 8 全项）+ 对齐文档归档语义写进卡片已知坑。

## 人工确认

确认人：用户 · 日期：2026-09-15 · 方式：本会话两轮逐条答问，七项建议全部采纳——Q1 陈旧对齐文档归档（否决「接受」与 mtime 判定）、Q2 9 条虚空 processing 回 open 池（不搁置）、Q3 来源 aligning/aligned 的 reopen 必须带 `--note`、Q4 注记带来源状态 + 字段动刀范围（保留 tags/dependsOn/createdAt/历史 notes）、Q5 新开 ADR-0007 并在 ADR-0003 留指针、Q6 原地加 `.reopened-<UTC 紧凑>.md` 后缀归档、Q7 术语「撤销（reopen）」+ `complete` 词条钉死区别 + 顺手订正 schema 口径。文档过目后答复「没问题」。
