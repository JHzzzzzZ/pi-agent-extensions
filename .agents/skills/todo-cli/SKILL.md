---
name: todo-cli
description: todos/*.json 台账的命令参考卡——add（登记）/ claim（两段式领取）/ align（对齐确认）/ dep（依赖增删）/ complete（完成）/ reopen（在途条目退回未领取）/ summary（盘点）/ list（组合查询）/ triage（worktree↔条目交接扫描）/ lint（注册扩展↔todo 文件一致性 + 依赖图/全局 id 扫描）/ migrate（旧 markdown 一次性迁移、全局 id 迁移与逃生回滚），零依赖无构建。状态机五态 open→aligning→aligned→processing→done（含依赖门，reopen 是唯一受支持的回退通道）与对齐文档契约见正文。当需要调用 todo CLI 的某个子命令、确认参数与退出码、或排查「找不到仓库根 / 锁超时 / JSON 损坏 / 匹配到多条 / 对齐文档缺失 / 依赖阻塞 / 撤销与归档」时读它。
---

# todo-cli

`todos/<名>.json` 工作流（AGENTS.md 红线 1）的 CLI：**JSON 是唯一持久真相，CLI 是唯一读写入口**（手工编辑 JSON 视为破坏存储）。本文件只讲**怎么敲命令**；什么时候该登记、盘点优先级怎么排属于 `todo-add` / `todo-triage`。

## 入口

入口与实现同居在本 skill 目录里：

```bash
node .agents/skills/todo-cli/todo-cli/todo.mjs <子命令> [参数]
```

也可走包装器（自动定位内层工具，等价）：

```bash
<skill>/scripts/todo.sh <子命令> [参数]
```

## 仓库根怎么定（决定作用于哪个仓库的 todos/）

1. `--root <dir>` —— 显式指定（相对当前 cwd 解析，必须是已存在目录），放在任意子命令前
2. `git rev-parse --show-toplevel`（以当前 cwd 起）—— 仓库任意子目录都能用
3. 都拿不到 → 静态报错 + exit 1（**fail-closed**，绝不静默改用 cwd）

`--help`、裸调用、未知命令不需要仓库根。注意：**cwd 决定仓库**——在 `.worktrees/<名>` 里调用作用于该 worktree 的 `todos/`，不是主工作区。

## 命令面

```bash
todo.mjs summary [--json]                                     # 按文件汇总 open/aligning/aligned/processing/done
todo.mjs list [--status open|aligning|aligned|processing|done] [--file <名>]   # 状态/文件过滤
todo.mjs list [--branch <子串>] [--tag <词>] [--text <关键词>] [--claimed-since <YYYY-MM-DD>] [--json]
todo.mjs add --file <名> "需求描述" [--tag 词1,词2] [--dep 文件#id,...] [--force]   # 追加 open 条目（跨文件查重；--dep 登记即声明依赖）
todo.mjs claim --file <名> --match "子串" [--branch feat/x]    # 两段式领取：open→aligning / aligned→processing
todo.mjs align --file <名> --match "子串" [--note "说明"]       # 对齐确认：校验对齐文档，aligning→aligned
todo.mjs dep add|remove --file <名> --match "子串" --on 文件#id,...   # 增删直接依赖（add 写前校验悬空/自引用/环）
todo.mjs complete --file <名> --match "子串" [--note "说明"]    # 完成：→ done，note 逐字进 notes
todo.mjs reopen --file <名> --match "子串" [--note "原因"]      # 撤销：在途条目 → open（对齐文档归档；done 拒绝）
todo.mjs lint                                                 # 单向：pi.extensions 扩展 ↔ todos/<名>-todo.json + 依赖图扫描
todo.mjs triage [--json]                                      # 只读：worktree 事实 × 条目 branch 关联
todo.mjs migrate from-md [--dry-run] [--force] | to-md | global-id [--dry-run]   # md→JSON / JSON→md 逃生回滚 / 存量一次性取全局 id
todo.mjs --help
```

### 对齐门（五态）

`claim` 是两段式的：首次领取 `open → aligning`（此时**写对齐文档、不许写代码**），文档过 `align` 校验才 `aligning → aligned`，在 `aligned` 上再 `claim` 才进 `processing`（此后到 merge 无人值守）。五态只前向，唯一受支持的**回退通道**是 `reopen`（见下）。

### 撤销（reopen）

`reopen --file <名> --match "子串" [--note "原因"]` 把 `aligning` / `aligned` / `processing` 一律退回 `open`（清 `branch` / `claimedAt` / `alignedAt`，保留 `tags` / `dependsOn` / `createdAt` / 历史 notes），notes 追加一条 `撤销 <UTC 日期>：从 <源状态> 回到未领取`（带 `--note` 时以 `；` 接原因）。从 `aligning` / `aligned` 撤销**必须带 `--note`**（`NOTE_REQUIRED`，与 `complete` 对齐阶段收口同口径）；`done` 拒绝（`ALREADY_DONE`，撤销已完成条目另条登记）；已是 `open` 幂等（`状态未变`，不写盘）。存在对齐文档时**先归档**为 `todos/align/<名>#<id>.reopened-<UTC 紧凑>.md` 再写盘（归档失败整体中止：`ALIGN_ARCHIVE_FAILED`），因此重新 `claim` → `align` 必须重写新文档。不碰依赖语义与 git/worktree；无批量形态（无 `--all`）。决策见 ADR-0007。

### 依赖门

条目可声明 `dependsOn`（规范引用 `文件基名#id`，可跨文件；输入接受 `general#11` / `general-todo#11` 等同 `--file` 口径的写法，存储统一归一）。依赖未 `done`（含指向不存在条目的悬空引用）时，第二次 `claim`（`aligned → processing`）报 `DEP_BLOCKED` 并逐条列出等待对象与状态，条目留在 `aligned`；首次 `claim` 与 `align` 不受此门约束。`add --dep` / `dep add` 在写入前拒绝悬空目标、自引用与成环（`lint` 另做全量图扫描兑合并产物）；`list` 对阻塞条目行尾追加 `（阻塞：等待 a#1, b#2）`，`list --json` 带 `dependsOn` 与 `blockedBy`（非空即阻塞），`triage` 在 aligned 段列明细，`complete` 输出直接依赖者提示。决策见 ADR-0005。

### 全局 id（globalId）

条目新增 `globalId` 字段（schema v4）：**全台账唯一、永不回收**的统一主键，由 `todos/.todo-cli/next-id` 计数器在 `locks/id.lock` 内发号（`add` 与迁移落盘时自动取号，失败/中止烧掉的号留缺口不回收）。**双轨**：`文件#id` 继续承担展示 / `dependsOn` 引用 / 对齐文档命名（人类契约不变），`globalId` 只进 `list --json` 与机器判定——`lint` 查重、跨分支合并冲突按其判同条目取并集。计数器被 gitignore（fresh clone 可能缺失），缺失时自愈为 `max(全台账条目 id, globalId) + 1`；损坏报 `ID_COUNTER_CORRUPT`（删该文件重跑即自愈）。旧 v1/v2/v3 文件读入时 `globalId` 归一为 null：读命令（`list`/`summary`/`triage`/`lint`）照常可读（`lint` 报 `globalId 缺失` 引导），六个写命令（`add`/`claim`/`align`/`complete`/`reopen`/`dep`）fail-closed 报 `GLOBAL_ID_PENDING`——**先跑 `migrate global-id`**（`--dry-run` 只预演：预检重号中止 / 无缺口幂等零动作 / 迁移中断后重跑接续，已写文件保留）。

对齐文档固定派生 `todos/align/<文件基名>#<id>.md`（无自由路径参数），需四小节 `## 意图` / `## 范围` / `## 验收标准` / `## 人工确认` 各带非空正文，且正文出现 `<名>#<id>` 标记；`claim` 只打印路径与必填小节，**不代建文件**。缺失报 `ALIGN_DOC_MISSING`，结构不全报 `ALIGN_DOC_INCOMPLETE`。从 `aligning`/`aligned` 用 `complete` 收口**必须带 `--note`**（取消/搁置留原因）。模板单源在 `docs/tools/todo-cli.md`。

- `--file` 四种写法等价：`general` / `general-todo` / `general-todo.json` / `general-todo.md`；只允许 `todos/` 下一层文件名（穿越直接拒绝）。
- `--match` 是**纯文本子串**（notes 不参与）；缺失或多条命中都报错，绝不猜第一条。
- `list` 的 flags 是 AND 组合；`--claimed-since` 对历史 null 时间戳不命中。
- 退出码：成功 0；裸调用/未知命令/锁超时/文件损坏/找不到文件或条目 → 1（`--help` 为 0）。**stderr 恒空**，所有信息走 stdout。

## 不变量与坑

- 写操作 = 每文件 O_EXCL 锁（`todos/.todo-cli/locks/`）+ temp+rename 原子落盘；锁忙静默重试，stale（>60s 或 pid 已死）自动抢占，SIGKILL 残留无需人工清理。
- `todos/*.json` 出现合并冲突标记或非法 JSON 时，**所有命令 fail-closed**；手工按 globalId 判同条目取并集（`文件#id` 展示不变）解决后再跑。
- `add` 只追加 open（查重命中要 `--force` 才写）；`claim` 在 `aligning`/`processing` 上幂等（不重复写）；`complete` 幂等（已 done 不重复写）；`reopen` 在已 `open` 上幂等（不重复写、文件字节不变）。
- 条目 id 文件内 max+1 分配、永不复用；entries append-only；globalId 全台账唯一、永不回收（v4 落盘恒为正整数）。
- `triage` 依赖 git（`worktree list` / `branch --merged`）；`--root` 指到非 git 目录时会静态报错而非抛栈。
- 本工具不 commit、不碰 `todos/` 之外的文件（triage 只读）。`reopen` 只归档 `todos/align/` 下的对齐文档（改名不删文件），且不碰 git / worktree / 分支。

## 设计权威

命令面/锁/存储决策以代码与卡片为准：`docs/tools/todo-cli.md`（仓库卡片）、`docs/adr/0002-todos-json-storage.md`（JSON 权威决策）、`docs/adr/0007-todo-reopen.md`（回退与归档决策）、`docs/adr/0008-todo-global-id.md`（全局 id 与双轨决策）。
