# dev_extensions（Pi 扩展工作区）

Pi 编码助手的扩展工作区：12 个零构建 TypeScript ESM 插件（pwr 工作流编排、agent-team 多 agent 协作等，见 AGENTS.md）+ 仓库级工具（todo CLI、install-smoke）+ 独立工具 agent-manager。本文件是全仓术语表；架构与目录事实在 AGENTS.md，决策记录在 `docs/adr/`。

## Language

### todos 工作流（todo-cli 域）

**条目（Entry）**:
`todos/<名>.json` 里的一条待办，schema v3 原生字段 = id / text / status / branch / tags / dependsOn / notes / createdAt / claimedAt / completedAt / alignedAt + 可选 priority（1-10，10 最高，缺省 5；全版本可选软字段，见 ADR-0008）（读兼容 v1/v2，写出一律 v3）。
_Avoid_: todo 行、任务、item

**顶层条目**:
行首（不缩进）的条目；缩进的说明行不是条目，是上一条顶层条目的 notes。条目计数只指顶层。
_Avoid_: 子任务、sub-entry

**登记（add）**:
把一条新需求追加为 open 条目的动作；只登记，不改状态。
_Avoid_: 提交、创建 todo

**领取（claim）**:
两段式状态推进：首次领取把 open 条目转 `aligning` 并写入 `--branch` 分支引用与 `claimedAt`；在 `aligned` 上再次领取才转 `processing`（此后无人值守至收口）。`aligning`/`processing` 上重复领取是幂等 no-op；done 条目不可领取。
_Avoid_: 认领、开始做

**对齐门**:
五态状态机 `open → aligning → aligned → processing → done` 中「开工前必须与人工对齐」的那道门：`aligning` 阶段写对齐文档、禁止写代码，`align` 结构校验通过（且人工已确认）才进 `aligned`。CLI 只保证迁移顺序与文档结构，不能证明「是人敲的」。决策见 ADR-0003。
_Avoid_: 审批流、gate、人工门（指代不清时用「审批」，红线 10）

**对齐文档（align doc）**:
`todos/align/<文件基名>#<id>.md` 的逐条对齐记录，四小节 `## 意图`/`## 范围`/`## 验收标准`/`## 人工确认` 各需非空正文，且正文须出现 `<名>#<id>` 标记（防串条目）；路径固定派生、无自由路径参数。模板单源在 `docs/tools/todo-cli.md`。`reopen` 把它归档为同目录的 `.reopened-<UTC 紧凑>.md`（旧留痕保留，规范路径腾空）。
_Avoid_: 需求文档、设计文档

**aligning**:
条目五态之一，表示已领取、正在写对齐文档并与人工确认；此阶段禁止写代码。`claimedAt` 已写，`alignedAt` 为 null。
_Avoid_: 对齐中状态、待确认

**aligned**:
条目五态之一，表示对齐已确认、待开工；再次 `claim` 才进 `processing`。`alignedAt` 由 `align` 写入。
_Avoid_: 已批准、ready

**完成（complete）**:
把条目转 done 的收口动作；`--note` 逐字进 notes（不解析括号/换行）。从 `aligning`/`aligned` 收口必须带 `--note`（取消/搁置留原因），从 `open`/`processing` 收口可选。取消/搁置也是 done（终态、不可再领取）——与把条目退回未领取的「撤销」是两回事。
_Avoid_: 勾选、关闭、撤销（撤销是 `reopen`，不是 complete）

**撤销（reopen）**:
把在途条目退回未领取的回退动作：`aligning`/`aligned`/`processing` 一律 → `open`（清 `branch`/`claimedAt`/`alignedAt`，其余字段与历史 notes 原样），notes 追加 `撤销 <UTC 日期>：从 <源状态> 回到未领取`；从 `aligning`/`aligned` 撤销必须带 `--note`，`done` 拒绝，已是 `open` 幂等。陈旧对齐文档先归档为 `todos/align/<名>#<id>.reopened-<UTC 紧凑>.md`（规范路径腾空 ⇒ 重新 claim 必须重写文档）。决策见 ADR-0007。
_Avoid_: 取消、搁置、回退状态机（口语可，但命令名与文档统一用 `reopen`/撤销）

**processing**:
条目五态之一（open / aligning / aligned / processing / done），表示对齐已确认、正式开工；分支引用在 `branch` 字段，从它到 merge/commit 全程无人值守。
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

**依赖（dependsOn）**:
条目对另一条目的开工前提声明，存储形态为规范引用 `文件基名#id`（可跨文件）；被引用条目未 done 时引用方不得开工。
_Avoid_: 关联、前置任务、sub-task

**依赖门**:
`aligned → processing` 之间的开工检查：存在未完成依赖时 `claim` fail-closed、条目留在 aligned。对齐（`align`）与首次领取不受此门约束。
_Avoid_: 阻塞门、前置检查

**阻塞条目（blocked）**:
存在至少一个未完成依赖的未完成条目；`list` 以行尾标记标出，`triage` 在 aligned 段列出。
_Avoid_: 卡住、等待中

**悬空引用（dangling dep）**:
`dependsOn` 指向不存在的条目（跨分支合并后目标 id 未出现等）；写入路径拒绝，`lint` 对全量台账报告。
_Avoid_: 断链、坏引用

**依赖环（dep cycle）**:
依赖闭包回到自身的引用链（含自引用）；写入路径拒绝并回显环路径，`lint` 对合并产物报告。
_Avoid_: 循环依赖（口语可，但报错与文档统一用「依赖环」）

### 工具与位置

**skill 目录（项目级 skill）**:
仓库内的 `.agents/skills/<名>/`（Pi 信任项目后扫描的项目级路径之一）：`SKILL.md` 为命令参考卡，其余文件是该 skill 的资产。todo CLI 的入口、实现与测试就住在 `.agents/skills/todo-cli/todo-cli/`。
_Avoid_: 插件目录（那是 `src/extensions/`）、全局 skill（`~/.pi/agent/skills/`）

**仓库根发现（repo root discovery）**:
CLI 判定「操作哪个仓库的 `todos/`」的规则：`--root <dir>` > `git rev-parse --show-toplevel`（以 cwd 起）> fail-closed 报错。取代了旧日的「脚本位置即仓库根」——工具位置与仓库根已解耦。决策见 ADR-0004。
_Avoid_: REPO_ROOT（已删除的常量名）、仓库定位

### 存储与并发

**方案 C**:
「JSON 唯一权威、CLI 唯一读写入口」的存储架构（ADR-0002）；无 markdown、无 sqlite、无降级路径。
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

### 状态条与 widget 契约（跨插件）

**widget 排序带（widget band）**:
把多个扩展写在编辑器上方的 widget 文本合并到**单一宿主 widget key**、由登记表里 band key 最小的写入者当唯一写者一次写入的协调机制；顺序由契约（band key 升序）保证，不依赖宿主刷新 widget 时的 Map 插入序。与 footer 的 `status-band.ts` 同源（`globalThis` + `Symbol.for` 登记表，每插件一份拷贝），契约见 `docs/cross/status-bar.md`。
_Avoid_: widget 合并、排序补丁、宿主补丁（那是改宿主安装目录，红线 8 禁止）

**变卦语义**:
用户在 run 在途时改变主意：停止该 run，并**只**丢弃属于它的排队对话消息（其他并行 run 的排队消息保留）。`/team:stop` 命令与 `team_stop` 工具共用这一语义。
_Avoid_: 取消、清队列（`/team:clear` 是显式清全部，另一回事）
