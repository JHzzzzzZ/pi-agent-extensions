---
name: todo-cli
description: todos/*.json 台账的命令参考卡——add（登记）/ claim（领取）/ complete（完成）/ summary（盘点）/ list（组合查询）/ triage（worktree↔条目交接扫描）/ lint（注册扩展↔todo 文件一致性）/ migrate（旧 markdown 一次性迁移与逃生回滚）八条原子命令，零依赖无构建。当需要调用 todo CLI 的某个子命令、确认参数与退出码、或排查「找不到仓库根 / 锁超时 / JSON 损坏 / 匹配到多条」时读它。
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
todo.mjs summary [--json]                                     # 按文件汇总 open/processing/done
todo.mjs list [--status open|processing|done] [--file <名>]   # 状态/文件过滤
todo.mjs list [--branch <子串>] [--tag <词>] [--text <关键词>] [--claimed-since <YYYY-MM-DD>] [--json]
todo.mjs add --file <名> "需求描述" [--tag 词1,词2] [--force]   # 追加 open 条目（跨文件查重）
todo.mjs claim --file <名> --match "子串" [--branch feat/x]    # 领取：open → processing，写 branch
todo.mjs complete --file <名> --match "子串" [--note "说明"]    # 完成：→ done，note 逐字进 notes
todo.mjs lint                                                 # 单向：pi.extensions 扩展 ↔ todos/<名>-todo.json
todo.mjs triage [--json]                                      # 只读：worktree 事实 × 条目 branch 关联
todo.mjs migrate from-md [--dry-run] [--force] | to-md        # md→JSON（带等价自检）/ JSON→md 逃生回滚
todo.mjs --help
```

- `--file` 四种写法等价：`general` / `general-todo` / `general-todo.json` / `general-todo.md`；只允许 `todos/` 下一层文件名（穿越直接拒绝）。
- `--match` 是**纯文本子串**（notes 不参与）；缺失或多条命中都报错，绝不猜第一条。
- `list` 的 flags 是 AND 组合；`--claimed-since` 对历史 null 时间戳不命中。
- 退出码：成功 0；裸调用/未知命令/锁超时/文件损坏/找不到文件或条目 → 1（`--help` 为 0）。**stderr 恒空**，所有信息走 stdout。

## 不变量与坑

- 写操作 = 每文件 O_EXCL 锁（`todos/.todo-cli/locks/`）+ temp+rename 原子落盘；锁忙静默重试，stale（>60s 或 pid 已死）自动抢占，SIGKILL 残留无需人工清理。
- `todos/*.json` 出现合并冲突标记或非法 JSON 时，**所有命令 fail-closed**；按条目 id 取并集手工解决后再跑。
- `add` 只追加 open（查重命中要 `--force` 才写）；`claim` 幂等（已 processing 不重复写）；`complete` 幂等（已 done 不重复写）。
- 条目 id 文件内 max+1 分配、永不复用；entries append-only。
- `triage` 依赖 git（`worktree list` / `branch --merged`）；`--root` 指到非 git 目录时会静态报错而非抛栈。
- 本工具不 commit、不碰 `todos/` 之外的文件（triage 只读）。

## 设计权威

命令面/锁/存储决策以代码与卡片为准：`docs/tools/todo-cli.md`（仓库卡片）、`docs/adr/0002-todos-json-storage.md`（JSON 权威决策）。
