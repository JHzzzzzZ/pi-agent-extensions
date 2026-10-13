# ADR-0014：远端目标登记表（别名 + strict 白名单）

Status: accepted（2026-10-13，remote-tools-todo#2；用户逐条确认见 [`todos/align/remote-tools-todo#2.md`](../../todos/align/remote-tools-todo#2.md)）

`remote` 参数自 v1 起是**自由字符串**（`"[user@]host"`），当时明确把"主机白名单/别名"列为范围外。两个月后的实际用法暴露三件事：模型不倾向用这条信道（远端任务它常写 `bash{command:"ssh …"}`，丢掉结构化文件工具、路径回写与远端超时托管）；模型**不知道有什么目标可用**（`~/.ssh/config` 它反而能用 bash 读到）；以及**没有白名单**——命令输出可诱导模型连任意主机。本 ADR 记录把"目标"变成一等公民的决策与代价。

## 决定

1. **登记表是用户级文件** `~/.pi/agent/remote-targets.json`（与 `auth.json` / `solo-mode.json` 同族；`PI_REMOTE_TARGETS_FILE` 可覆盖）。形态 `{version: 1, strict, targets[{alias, host?, user?, port?, source, createdAt, note?}]}`，**只存 alias/host/user/port，不存凭据**（沿用"只复用系统密钥 / ssh-agent"的既有不变量；不做密码登录）。
2. **解析只有一个接缝**：`resolveTarget` 在 `parseTarget` **之前**展开别名，展开结果仍喂给原有链路（校验 / session 缓存 / ssh 参数构造 / `#16` 路径回写零改动）。**命中按展开后的三元组**（`host` 相等且入参给了的 `user`/`port` 必须相等；条目补齐入参没给的部分；显式 `remotePort` 优先于条目默认端口）。条目**不给 `host`** ⇒ 别名本身当主机名交给 ssh（`~/.ssh/config` 兜底，`/remote:add lab` 即这种）。
3. **strict 默认走开**：未命中 ⇒ `UNKNOWN_REMOTE_TARGET`（静态模板 + 列已登记别名 + 两个登记入口）。`/remote:strict off` 回到自由填写，行为逐字等于今天。**本地调用绝不读登记表**（`hasRemoteIntent` 为假时不 read、不 write、不报错）；有远端意图但读表失败 ⇒ fail-closed `REMOTE_TARGETS_UNREADABLE`（不静默当空表——静默在 strict 下等于静默全拒）。
4. **模型可登记、不可删除**：`remote_targets` 工具给模型 `list` + `register`（落盘 `source: "agent"`、同名拒绝、无 `force`、无删除）；人工面 `/remote:add`（含 `--force` 覆盖）/ `/remote:list` / `/remote:rm` / `/remote:strict`。条目带 `source` 供审计。
5. **模型面偏好文案**（吸收 `remote-tools-todo#18`）：7 个工具的 guideline 写明"目标是远端主机时**优先传 `remote`，不要在 bash 里拼 ssh**；只有连接诊断（`ssh -v` / `ssh-keygen` / 端口探测）才用 bash+ssh"；7 个工具的 `remote` 参数描述带**加载期快照**的「已登记目标：…」提示行（空表/读不出 ⇒ 不加，`/reload` 刷新；实时清单以 `remote_targets` 为唯一权威）。

## Considered Options

- **不做登记表，只加提示词偏好**：最便宜，但"模型不知道有什么目标"这条没解——它还是会从零编 host，且白名单仍然缺位 —— 否决。
- **复用 `~/.ssh/config` 当登记表**（只读它的 `Host` 段当别名清单）：零新文件，但**不可写**（模型/人登记要改用户全局 ssh 配置，影响 ssh 本身）、拿不到 `source`/`createdAt` 审计、也无法表达"登记过但暂不启用" —— 否决；改成"登记表可**引用** ssh_config 别名"（条目不给 host）拿到两者的好处。
- **strict 默认关（opt-in）**：向后兼容最好，但会与"白名单真正生效"的意图相反（用户明确要 strict），且会保留"模型自由编 host"的旧路径 —— 否决；代价是**行为变更**：今天所有字面 host 的临时用法必须先登记（或用 `/remote:strict off`）。
- **模型不可登记（只读）**：安全面更干净（白名单至少挡住"模型自己放行自己"），但用户选择"能"（工作流上希望 agent 发现新目标就记下来，人再复核）—— 否决只读方案，并**显式接受**下述后果。
- **登记需人工确认（`pending → /remote:approve`）**：这才让白名单成为真安全边界，但每加一台机器都要人工往返一次 —— v1 不做，留作将来加真边界时的选项（见 Consequences）。
- **把 strict 做成"命令/环境变量开关"而非文件字段**：多一个状态源、且 `/remote:list` 无法回显 —— 否决。
- **`remote_targets` 提供 delete**：模型能删除人的登记会造成"看不见的降级"（人以为登记在、实际被删） —— 否决，删除只在人工命令。

## Consequences

- **第 1/2 轮跨厂商评审（`kimi-coding/k3-256k`）后的加固**（同一变更内落地）：① 命中次序改为**主机优先、别名兜底**——否则一个与常用字面 IP/主名同名的别名能把该字面调用劫持到别的机器（评审用探针坐实：`{alias:"10.0.0.7",host:"10.0.0.9"}` 会让 `remote:"10.0.0.7"` 连到 `10.0.0.9`）；② 登记期拒绝两种命名空间相撞：「点分别名 + 指向另一个 host」与「新条目 host 与已登记别名同名」；③ 同一主机多命中时优先级为「入参自身的别名 → 没写 user 的通用条目 → fail-closed（`AMBIGUOUS_REMOTE_TARGET`）」，绝不按数组序静默换 user；④ **登记表文件不存在 = 空表（strict 开）**——全新机器上未登记目标也被拒（`emptyTargetsFile` 的语义在解析路径同样成立，否则会出现「首次写入后才突然开始拒绝」的行为悬崖）。**残余风险**：单标签别名（如 `lab`）按别名语义生效——如果库里同时有「别名 `lab`」与「host 为 `lab` 的另一个条目」，解析优先取**入参自身的别名**（新的优先级层），不会静默换 user；要改掉某个别名的含义只能 `--force` 重登记或 `/remote:rm`，`/remote:list` 能看到全部条目。

- **白名单不是安全边界**（用户已知情选择）：模型能登记 ⇒ 注入内容同样能诱导它登记后连上。白名单买到的是**可发现性 + 审计**：每条远端调用都能追到一个具名条目、条目来源可区分 `human`/`agent`、`/remote:list` 与工具都能列出。要真边界需加人工确认门（登记 v1 的 `source`/`createdAt` 字段已经为那条路留好审计位）。
- **行为变更**：strict 默认开 ⇒ 未登记目标一律拒绝，老用法（自由填字面 host）需要 `/remote:add` 一次或 `/remote:strict off`。仓库内既有 127 个本地用例通过"注入隔离的假登记表端口"保持绿（测试不该受开发机用户配置影响）。
- **模型面提示行是加载期快照**：会话内新登记的别名不会出现在 7 个工具的 `remote` 描述里（要 `/reload`）；实时清单走 `remote_targets` 工具——这条取舍的代价是"提示行可能过期"，收益是零额外上下文（每次请求都注入动态清单会持续烧 token）。
- **错误文案破例插值本地内容**：`UNKNOWN_REMOTE_TARGET` 与 `/remote:list` 会插值**本地登记表**的别名（经形态校验：无空白、无 `@`）。原口径"错误消息全静态模板"针对的是**远端回流内容**，此处的数据源是本机文件 —— 口径不变，只是在 ADR 里写明这条边界。
- **文件形态严格 fail-closed**：未知字段、非法形态、重复别名都报错（不静默忽略 typo——`"strictt": false` 这类恰恰最危险）。
- 条目字段刻意最小：默认 `remoteCwd`（`#4` 路径映射域）、只读模式（`#3`）、`/remote:setup` 引导（`#17`）都不进本表单。
