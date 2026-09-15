# 规格：todo 回退通道（reopen 子命令）

> 来源：`todos/todo-cli-todo.json` #14（2026-09-15 登记并领取，同日对齐）
> 对齐：用户两轮逐条答问（Q1–Q7 全部采纳），见 `todos/align/todo-cli-todo#14.md`
> 状态：已实现

## 问题陈述

五态状态机（ADR-0003）只前向：`open → aligning → aligned → processing → done`，`claim` 在 `processing` 上幂等。台账里因此可能出现「状态说在途、事实上从未开工」的条目——本次实测 9 条虚空 `processing`（8 条 route A 上游根修跨插件登记 + `agent-team#66`）：零 `claim`、零 `branch`、零对齐文档，却没有任何受支持手段退回 `open`。

唯一既有替代 `migrate to-md` → `from-md --force` 重建台账的代价超出条目原文估计：除丢 `createdAt`/`claimedAt`/`completedAt`/`alignedAt`/`tags` 外，`buildTodoData` 还会从 1 重新编号，**重排条目 id**——id 是永不复用的条目身份，重排即毁掉跨文件引用与历史锚点。

缺的是一条显式、可审计、不伤任何历史字段的回退通道。

## 方案

**新子命令**：`reopen --file <名> --match "子串" [--note "原因"]`（第十子命令）。沿用既有每文件锁、temp+rename 原子写与 `--match` 唯一定位口径（0 条或多条匹配 fail-closed，绝不猜）。

**迁移**：来源 `aligning` / `aligned` / `processing` 一律 → `open`；清 `branch` / `claimedAt` / `alignedAt`；`id` / `text` / `createdAt` / `completedAt`（来源非 done ⇒ 恒 null）/ `tags` / `dependsOn` / 全部历史 notes 原样。

**注记**：追加单条 `撤销 <YYYY-MM-DD>：从 <源状态> 回到未领取`（日期取 `now()` 的 UTC 日期部分，与其它时间戳同口径；`<源状态>` 取 status 字段原值 `aligning`/`aligned`/`processing`）。带 `--note` 时同一条内以 `；` 连接、原因逐字（不解析括号/换行）。只追加不覆盖。

**门与幂等**：从 `aligning` / `aligned` 撤销必须带 `--note`（否则 `NOTE_REQUIRED` + exit 1 不写盘，对齐 `complete` 的对齐阶段收口口径）；`processing` 的 `--note` 可选。`done` 拒绝（`ALREADY_DONE` + exit 1，撤销已完成条目另条登记）；已是 `open` 幂等（exit 0、`状态未变`、文件字节不变）。

**陈旧对齐文档归档**：`reopen` 把 `todos/align/<名>#<id>.md` 改名为同目录 `todos/align/<名>#<id>.reopened-<UTC 紧凑时间戳>.md`（如 `.reopened-20260915T141733Z.md`）——旧留痕保留、规范路径腾空，重新 `claim` → `align` 必须重写新文档（否则 `align` 报 `ALIGN_DOC_MISSING`），人工门不被旧文档二次过。文档不存在（虚空 processing 即是）→ 跳过归档、正常通过。归档**先于** JSON 写：目标已存在或改名失败 → `ALIGN_ARCHIVE_FAILED` + exit 1、JSON 零改动。归档文件后缀仍 `.md`，沿用 `.gitattributes` 的 `todos/align/*.md` LF 锁，不新增目录/pattern。

## 用户故事

- 作为 agent，我发现条目被误标为在途（或对齐结论被推翻）时，能用一条命令把它退回未领取，而不是伪造一次「完成」或手工编辑 JSON。
- 作为 agent，我撤销时看到的状态/时间戳/标签/依赖/历史注记原封不动，只有该清的字段被清，且注记里写明了「从哪个状态回退、为什么」。
- 作为 agent，我撤销一个已确认对齐的条目时被要求写原因（`--note`），不会静默推翻人工确认过的结论。
- 作为 agent，我撤销后必须重写对齐文档才能再次开工——旧文档不会被当成新确认。
- 作为 agent，我误敲 `reopen` 到一个本来就 open 的条目时不产生任何写入（幂等、字节不变）。
- 作为人，我在盘点时看到 processing 段只含真正开工的条目（9 条虚空 processing 被清回 open 池）。

## 实现决策

- `align.ts`：新增导出 `archiveStamp`（ISO → `YYYYMMDDTHHMMSSZ`，非 ISO 退化去非数字字符）、`reopenArchiveRelPath` / `reopenArchivePath`——归档命名与对齐文档路径同源，避免 core 里拼字符串。
- `core.ts`：新增 `runReopen`（锁临界区内 read-all → locate → 状态分支 → 归档 → mutate → 原子写）；`USAGE` 增行、`REPO_COMMANDS` 增 `reopen`、写命令分派复用既有的 `--file`/`--match` 前置校验块；文件头注释与用法清单同步。
- 归档顺序固定：先 `fs.existsSync(target)` 判冲突（含目录占位），再 `fs.renameSync`；两步失败都返回静态消息，JSON 不写。
- `now()` 在锁临界区内只取一次，归档时间戳与注记日期同源（真实时钟下两次调用可能跨秒）。
- 错误码（全部 stdout 静态模板 + exit 1）：`NOTE_REQUIRED`（对齐阶段无 note）、`ALREADY_DONE`（done 拒绝）、`ALIGN_ARCHIVE_FAILED`（归档冲突/失败）；匹配失败沿用 `NOT_FOUND`/`AMBIGUOUS`。
- 依赖语义不动（来源非 done ⇒ 依赖者的阻塞状态前后一致），不告警下游；不碰 git / worktree / 分支；schema 不动（仍 v3）。
- 文档：`docs/tools/todo-cli.md`（命令面 + 迁移表 + 已知坑）、`SKILL.md`（frontmatter description + 命令面 + 撤销小节 + 不变量）、`CONTEXT.md`（术语「撤销」；`complete` 词条钉死与撤销的区别；顺手订正「条目」词条 v2 → v3 并补 `dependsOn`）、ADR-0007 + ADR-0003 指针、根 `README.md` 与根版本。

## 测试决策

- `test/todo-cli.test.ts`（临时 fixture，`main` 注入 `now`）：
  - 三来源各一例（aligning 带 note / aligned 带 note / processing 无 note）→ status、字段清空/保留、注记逐字（日期、源状态、`；` 连接）；
  - 门与幂等：已是 open 幂等且文件字节不变；done 拒绝且不写盘；aligning/aligned 无 note → `NOTE_REQUIRED` 不写盘；0 匹配 / 多匹配 fail-closed 不写盘；
  - 归档：有文档 → 规范路径消失、出现 `.reopened-<stamp>.md`、内容原样、随后 `claim` → `align` 报 `ALIGN_DOC_MISSING`；无文档 → 跳过；目标被目录占位 → `ALIGN_ARCHIVE_FAILED`、JSON 零改动、原文档未改名。
- 进程边界 E2E：`--help` 含 `reopen`；`reopen` 缺 `--file` / `--match` 的提示与 exit 1、stderr 恒空。
- 必跑门：`npm run test:todo`（92 个）+ `node .agents/skills/todo-cli/todo-cli/todo.mjs lint`（exit 0）。
- 真机闭环：用 `reopen` 把 9 条虚空 processing（`--note "从未开工：零 claim / 零分支 / 零对齐文档"`）退回 open 池，再跑 `triage` 确认 processing 段清零。

## 范围外

- 不做批量 reopen（无 `--all` / `--status`）、不删归档文件、不撤销 `done`。
- 不改 `align` 的判定口径（不加 mtime 判定）、不改 `claim` / `complete` / `migrate` / `lock` / `schema` 契约。
- 不新增第六态；不改 `list` / `summary` / `triage` 的输出字节（状态计数自然变化除外）。
- 不碰 `todos/` 之外（不 commit、不删 worktree、不动分支）；不改仓库外文件（`~/.pi/agent/skills/`）。
