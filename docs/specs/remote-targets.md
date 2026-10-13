# 规格：远端目标登记表（别名 + strict 白名单）

> 需求与验收权威：[`todos/align/remote-tools-todo#2.md`](../../todos/align/remote-tools-todo#2.md)（含人工确认记录）。
> 条目：[`todos/remote-tools-todo.json`](../../todos/remote-tools-todo.json) 的 `remote-tools-todo#2`（吸收 `#18`；`#17` 依赖本规格）。
> 决策：[`docs/adr/0014-remote-target-registry.md`](../adr/0014-remote-target-registry.md)。

## 问题陈述

1. **模型偏 bash+ssh**：目标是远端主机时，模型倾向 `bash{command:"ssh host …"}` 而不是给内置工具传 `remote`。ssh 层是同一个 bin，所以"连不上"不是问题——丢的是本扩展为这条信道建的保证：远端命令原本作为**单个 argv** 交给 ssh（不过本地 shell、无双层转义），拼 ssh 要过本地 shell 再拼一遍；结构化 `edit`/`write`、图片嗅探、`read` 截断限流、`#16` 的路径回写、远端目录的 AGENTS.md 注入、`#12` 的远端超时转后台（kill 能杀远端进程组）全部拿不到。
2. **目标名不可发现**：`remote` 是自由字符串，模型不知道有什么目标可用（`~/.ssh/config` 它反而能用 bash 读到），于是每次从零编一个 host。缺的不是能力，是**登记表 + 一次可查的工具**。
3. **没有白名单**：命令输出可诱导模型连任意主机（v1 自由填写，见 `todos/align/remote-tools-todo#1.md` 的范围外声明）。

## 方案

把"目标"变成一等公民：

1. **登记表**（用户级 `~/.pi/agent/remote-targets.json`，`PI_REMOTE_TARGETS_FILE` 可覆盖）：`{version, strict, targets[{alias, host?, user?, port?, source, createdAt, note?}]}`。只存 alias/host/user/port，**不存凭据**。
2. **解析接缝**：`resolveTarget` 在 `parseTarget` 之前展开别名——命中按 `host` 相等且入参给了的 `user`/`port` 必须相等；条目补齐入参没给的部分；显式 `remotePort` 优先；条目不给 `host` ⇒ 别名交给 ssh（`~/.ssh/config` 兜底）。
3. **strict 默认开**：未命中 ⇒ `UNKNOWN_REMOTE_TARGET`，文案列已登记别名 + 两个登记入口；`/remote:strict off` 回落成自由填写（逐字不变）。
4. **两个面**：模型面 `remote_targets` 工具（`list` / `register`，落盘 `source: agent`，同名拒绝、无删除）；人工面 `/remote:add|list|rm|strict` 命令（`--force` 覆盖、`/remote:rm` 删除）。
5. **模型面偏好**（吸收 `#18`）：7 个工具的 `REMOTE_GUIDELINE` 追加"目标是远端主机时优先传 `remote`，不要在 bash 里拼 ssh；只有连接诊断才用 bash+ssh"；7 个工具的 `remote` 参数描述追加**加载期快照**的「已登记目标：…」提示行。

## 用户故事

- 作为**人**：我想 `ssh` 到一个新机器后只登记一次，之后对 agent 说"去那台机器看看"，agent 直接用别名调结构化工具，而不是我每次解释 host 与端口。
- 作为**人**：我想在 `/remote:list` 里看到**谁**登记了什么（`human` / `agent`），以便发现异常条目。
- 作为**模型**：我不知道有什么目标可连时，用 `remote_targets` 查；被 strict 拒绝时，错误里直接告诉我可用别名与登记入口。
- 作为**模型**：我排障时（`ssh -v`、端口探测、`ssh-keygen`）仍然可以用 bash+ssh，这不该被拦住。

## 实现决策

- **单一接缝**：别名展开在 `parseTarget` 之前完成，展开结果仍喂给原有链路 ⇒ 校验、`session` 缓存、`ssh` 参数构造、`#16` 路径回写全部零改动。session 缓存键是**展开后**的目标 ⇒ 别名与字面写法共用同一份 `$HOME` 缓存。
- **本地调用绝不读登记表**：`hasRemoteIntent(input)`（与 `parseTarget` 同源）为假时不 read、不 write、不报错——登记表损坏不得弄坏本机工具。远端调用读表失败 ⇒ fail-closed `REMOTE_TARGETS_UNREADABLE`（不静默当空表：静默在 strict 下等于静默全拒）。
- **fail-closed 的形态校验**：登记表/条目出现未知字段、非法形态、重复别名一律报错（不静默忽略 typo——`"strictt": false` 这类恰恰最危险）。条目与 ssh 目标形态口径共用 `parseTarget`。
- **不把 strict 当安全边界**（用户已知情选择）：模型可登记 ⇒ 注入内容也能诱导它登记。白名单买的是**可发现性 + 审计**（具名条目、`source` 标记）。要真边界就得加人工确认门（本规格范围外）。
- **模型不可删除/覆盖**：`force` 只存在于人工命令；删除只走 `/remote:rm`。
- **提示行是加载期快照**：`targetHintLine(readAtLoad())` 进 7 个工具的 `remote` 描述；空表/读不出 ⇒ 不加此行，且**绝不因此阻断注册**；`/reload` 刷新，实时清单以 `remote_targets` 为唯一权威。
- **错误码进 `errors.ts`**（不用临时字符串）：`UNKNOWN_REMOTE_TARGET` / `REMOTE_TARGETS_UNREADABLE` / `REMOTE_TARGET_EXISTS` / `REMOTE_TARGET_UNKNOWN` / `REMOTE_TARGETS_WRITE_FAILED`。
- **文件写入**：temp + rename 原子落盘；`readAtLoad` 用同步读（只为提示行，失败静默当无表）。

## 测试决策

- **纯函数直接测真函数**：解析与匹配口径（别名命中、三元组命中、端口补齐与显式覆盖、`ssh_config` 兜底、大小写敏感、`user` 不匹配即不命中）、strict 两态、形态非法优先于登记表、本地模式不参与解析。
- **文件端口用真实临时目录**：不存在 ⇒ `null`；写读往返；写后不留 `.tmp-*`；损坏 ⇒ `REMOTE_TARGETS_UNREADABLE`；写不可达路径 ⇒ `REMOTE_TARGETS_WRITE_FAILED`；`readAtLoad` 遇损坏静默 `null`。
- **注册面走真实 `registerRemoteTools`**（只有宿主 `ExtensionAPI` / ctx 是结构 fake）：提示行在/不在、guideline 文案、`remote_targets` 两个动作、四个命令的行为与非法输入不写盘。
- **关键不变量单测锁死**：用 `readFailure` 的假 store + `reads` 计数证明「本地调用 0 次读表」「远端调用才读表」。
- **回归口径**：既有 127 个纯本地用例全部保持绿（测试改动的唯一形态是注入隔离的假登记表端口 + 注册面新增工具/命令的清单更新）。

## 范围外

- **不做 bash 里 ssh 的检测/软提示/硬拦**（硬拦会打断 `git over ssh`、端口转发、ansible）。
- **不做系统提示词注入**（`before_agent_start` 只能注入消息，不采用）。
- **不做人工审批门**（`pending → /remote:approve` 留作将来加真安全边界时的选项）。
- **不做远端只读模式**（`remote-tools-todo#3`）、**不做本地↔远端路径映射**（`remote-tools-todo#4`）。
- **`/remote:setup` 引导配置**（`remote-tools-todo#17`）依赖本规格，另案实现。
- 不动 `ssh.ts` 的传输策略（TOFU / `BatchMode` / 连接超时逐字不变），不引入凭据存储。
