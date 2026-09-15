# todo 状态机加回退通道：reopen 把在途条目退回未领取，陈旧对齐文档归档

Status: accepted（2026-09-15，todo-cli-todo:14；用户两轮对齐访谈选定：归档形态、来源 aligning/aligned 的 note 门、注记带源状态、字段动刀范围、依赖无关性、术语「撤销」）

五态是**前向机**（open → aligning → aligned → processing → done），`claim` 在 `processing` 上幂等 no-op。真实台账却撞上了前向机造不出的状态：9 条**虚空 processing**（8 条 route A 上游根修跨插件登记 + agent-team#66）——零 claim、零分支、零对齐文档，登记时误写成「在途」，此后没有任何受支持手段退回未领取。唯一的既有替代是 `migrate to-md` → `from-md --force` 重建台账，而 `buildTodoData` 从 1 重新编号：除丢 `createdAt`/`claimedAt`/`completedAt`/`alignedAt`/`tags` 外还**重排条目 id**——id 是永不复用的条目身份，重排等于毁掉跨文件引用与历史注记的锚。

决定：给状态机一条显式的、可审计的回退通道。新增第十个子命令 `reopen --file <名> --match "子串" [--note "原因"]`：来源 `aligning` / `aligned` / `processing` 一律 → `open`，清 `branch` / `claimedAt` / `alignedAt`，其余字段（`id`/`text`/`createdAt`/`tags`/`dependsOn`/历史 notes）原样；notes 追加一条 `撤销 <UTC 日期>：从 <源状态> 回到未领取`（带 `--note` 时以 `；` 接原因）。从 `aligning` / `aligned` 撤销**必须带 `--note`**（推翻对齐结论要留原因，与 `complete` 的对齐阶段收口同口径）；`done` 拒绝（撤销已完成条目另条登记）；已是 `open` 幂等（不写盘、文件字节不变）。存在对齐文档时**先归档**为 `todos/align/<名>#<id>.reopened-<UTC 紧凑时间戳>.md` 再写 JSON——旧留痕不删，但规范路径腾空，重新 `claim` → `align` 必须重写新文档。不新增第六态、不碰依赖语义与 git/worktree。

## Considered Options

- **不做回退（维持「历史 processing 不回退状态」）**：虚空 processing 永久留在在途段，triage 的「无分支引用」清单持续污染，盘点失真——否决。
- **用 `migrate to-md` → `from-md --force` 重建台账当回退**：丢时间戳且**重排 id**，id 复用/重排破坏身份与跨文件引用——否决（这正是本条的起因）。
- **接受旧对齐文档继续有效（reopen 不动 `todos/align/`）**：旧文档会零人工二次过门，align 那道人工门变摆设——否决。
- **用 mtime 判定对齐文档是否陈旧**：git 不保留 mtime，克隆/换机后判定漏水——否决。
- **新增第六态（reverted / cancelled）**：状态机加宽一层，且与「取消/搁置也是 done」语义重叠；回退的目标状态本来就是 open——否决。
- **原地改名归档 `.reopened-<UTC 紧凑>.md`（同目录、后缀仍 `.md`）（选定）**：不动 `.gitattributes` 的 `todos/align/*.md` LF 锁，不留「归档目录」这个新面；时间戳不含冒号，Windows 文件名安全。
- **`reopen --all` / `--status` 批量形态**：批量撤销正是本次要清理的错误的放大器，且无第二个真机案例——推迟（rule of three）。

## Consequences

- **ADR-0003 的「历史 processing 不回退状态」被推翻**：回退语义以本 ADR 为准；0003 只保留指针。历史 `processing` 仍是「已开工」，不要求补对齐文档——但需要退回未领取时有了显式命令。
- 命令面契约从九子命令变**十子命令**：`USAGE`、`SKILL.md`、`docs/tools/todo-cli.md` 的迁移表与命令面同步（`REPO_COMMANDS` 漏加会被当未知命令）。
- 状态机迁移表新增 revert 组（`reopen` × aligning/aligned/processing/open/done）；`claim`/`align`/`complete`/`migrate`/`lock`/`schema` 的既有契约不动，schema 不新增字段（仍 v3）。
- `reopen` 的归档**先于 JSON 写**：归档失败整体中止（`ALIGN_ARCHIVE_FAILED`）、JSON 零改动；反向（归档成功而写盘失败）留下的归档文件名与内容仍可人工辨识，不静默丢留痕。
- 依赖语义不变：来源状态本来都不是 `done`，依赖者的阻塞状态前后一致，故不告警下游。撤销不碰 git / worktree / 分支，triage 的「无分支引用」段自然缩短。
- 撤销**不是取消**：取消/搁置仍走 `complete --note`（→ done）。两者在台账里的区别是终态与可再领取性（open 可再领取，done 不可）。
