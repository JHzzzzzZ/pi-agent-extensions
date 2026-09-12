# dev_extensions（Pi 扩展工作区）

Pi 编码助手的扩展工作区：12 个零构建 TypeScript ESM 插件（pwr 工作流编排、agent-team 多 agent 协作等，见 AGENTS.md）+ 仓库级工具（todo CLI、install-smoke）+ 独立工具 agent-manager。本文件是全仓术语表；架构与目录事实在 AGENTS.md，决策记录在 `docs/adr/`。

## Language

### todos 工作流（todo-cli 域）

**条目（Entry）**:
`todos/<名>.json` 里的一条待办，schema v1 原生字段 = id / text / status / branch / tags / notes / 三时间戳。
_Avoid_: todo 行、任务、item

**顶层条目**:
行首（不缩进）的条目；缩进的说明行不是条目，是上一条顶层条目的 notes。条目计数只指顶层。
_Avoid_: 子任务、sub-entry

**登记（add）**:
把一条新需求追加为 open 条目的动作；只登记，不改状态。
_Avoid_: 提交、创建 todo

**领取（claim）**:
把 open 条目转 processing 并写入 `--branch` 分支引用的动作；done 条目不可领取。
_Avoid_: 认领、开始做

**完成（complete）**:
把条目转 done 的收口动作；`--note` 逐字进 notes（不解析括号/换行）。
_Avoid_: 勾选、关闭

**processing**:
条目三态之一（open / processing / done），表示已被领取、进行中；分支引用在 `branch` 字段。
_Avoid_: 进行中标记、`（processing）`注记

**台账**:
一个 checkout（主工作区或 worktree）内 `todos/` 的整体状态；每个 worktree 有自己的台账，随分支合并汇入主干。
_Avoid_: 数据库、索引

**分支引用（branch）**:
条目的原生字段，`claim --branch feat/x` 写入；triage 以它与 worktree 分支精确相等来互映射。
_Avoid_: `@ 引用`、processing 标注

**注记（notes）**:
条目的完成备注、历史标注与缩进子行的统一存放池，保序；不参与 `--match`/`--text` 匹配。
_Avoid_: 备注、comment

**id**:
条目在文件内的稳定编号，max+1 分配、永不复用/重排；跨分支合并冲突按 id 取并集手工解决。
_Avoid_: 行号、序号

### 存储与并发

**方案 C**:
「JSON 唯一权威、CLI 唯一读写入口」的存储架构（ADR-0001）；无 markdown、无 sqlite、无降级路径。
_Avoid_: JSON 化、迁移后形态

**权威（authority）**:
持久真相的唯一载体，现为 `todos/<名>.json`；手工编辑 JSON 视为破坏存储。
_Avoid_: 数据源、source of truth 文件

**等价自检**:
`migrate from-md` 逐文件「渲染→再解析→再构建」与首次构建 deepEqual 的零丢失证明；任一不过关整体零写入。
_Avoid_: roundtrip 测试（那是单测层的对应物）

**逃生回滚（migrate to-md）**:
JSON → 规范 md 的常驻转换；只增 md 不删 JSON，配合 git 历史旧版 CLI 可彻底回到 markdown 工作流。是逃生通道，不是视图。
_Avoid_: 导出、md 视图

**stale 抢占**:
锁残留（pid 已死 / 内容损坏 / 超 60s）被下一个写者就地接管并重试的机制；SIGKILL 中断释放的唯一路径。
_Avoid_: 锁清理、强制解锁
