# 跨扩展横切契约：shell 工具能力协商（bash）

> last verified @ f53c85a
>
> 背景：`bash` 是两个扩展共享的名字——timeout-bg 在 `session_start` 重注册它（默认超时 + 超时转后台），
> remote-tools 在加载期重注册它（远端 ssh 后端）。宿主 `pi.registerTool` 对同名工具是
> **按扩展加载顺序 first-wins**（`ExtensionRunner.getAllRegisteredTools()` 遍历扩展先到先得，
> agent-session 的 `_refreshToolRegistry` 再用它覆盖内置），且没有「取回下层定义再包裹」的 API
> （`getAllTools()` 只给 name/description/parameters/promptGuidelines/sourceInfo，**没有 execute**）。
> 所以两个扩展靠覆盖不可能共存，任一方会静默消失（2026-10-10 用户实测：带 `remote` 的 bash 跑在本机）。
>
> 上游根治诉求：`todos/general-todo#30`（请 `registerTool` 对齐自家 `registerMcpServer` 的冲突报错与
> `registerToolRenderer` 的链式 `(name, next) => …` 组合）。本契约是**仓库内的组合方案 B′**：
> 用宿主官方 `pi.events`（`dist/core/event-bus.js`，`emit` 同步派发、无返回值）做一次能力协商。

## 频道与盒子

| 项 | 值 |
| --- | --- |
| 频道名 | `pi-extensions:shell-capability:v1`（形状升级开新频道 `…:v2`，不做版本字段） |
| 收集时机 | owner（timeout-bg）**注册 bash 之前**（`session_start`），每次会话一次 |
| 盒子 | owner 新建的可变对象 `{ bash?: ShellCapability }`，`emit` 出去后同步读回 |
| 填充规则 | 订阅方（remote-tools）在**同步**回调里写 `box.bash`：宿主 `emit` 同步派发订阅回调，**emit 返回时盒子已就绪**是契约成立的前提；槽位已有值不覆盖（先到先得） |
| 缺席语义 | 没有提供方 / 宿主没有 `pi.events` ⇒ owner 按原行为注册，不报错、不阻塞 |

## 载荷（`box.bash`）

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `parameters` | `Record<string, unknown>` | 参数片段（属性名 → TypeBox schema）。owner 合并进自己的 `properties`：**只能新增**；与 owner 既有参数重名 ⇒ 整份载荷判畸形并忽略（防止偷偷覆盖 `command`/`timeout`）。反过来：**owner 自己声明的参数（现为 `run_in_background`）提供方不得再声明**，否则撞名同样整份被拒 |
| `runInBackground` | `boolean` | 远端分支是否支持 `run_in_background`（timeout-bg-todo#5，加法式扩展：缺席/非布尔 = 不支持，不判畸形）。owner 在远端分派前检查，不支持 ⇒ fail-closed |
| `isRemoteCall(params)` | `(unknown) => boolean` | 这次调用是否意图走远端。**目标形态非法也算 `true`**：交给远端分支报结构化错误，绝不因为解析失败就静默在本机执行 |
| `executeRemote(id, params, signal, onUpdate, ctx)` | 与工具 `execute` 同签名 | 远端分支的实现（提供方内部**单一实现**，不允许与自己的 bash 注册各写一份） |
| `guideline` | `string?` | 追加到 owner 的 `promptGuidelines`（非空字符串才生效） |

## 双方义务

- **形状守卫各自实现**（不共享代码、不跨扩展 import）：盒子里的东西来自别的扩展，一律当不可信；
  畸形载荷 ⇒ 当作「没有能力」并按原路径注册 + `notify` 一次，不抛异常。
- **owner 分派的安全口径**：`isRemoteCall` 抛错 ⇒ **fail-closed 报错**（不能确认意图时不猜：
  `local` 常是 `~/.ssh/config` 别名，跑错机器比报错贵）；`executeRemote` 抛错 ⇒ 原样抛（tool call
  以错误结束）+ `notify` 一次，**绝不回退到本机执行**。
- **归属可见性（owner 侧）**：注册**前**若 `bash` 不是内置实现（`getAllTools()` 的 `sourceInfo.path`
  不是 `builtin:bash`）且**确定没有提供方**（盒子空且无协商异常）⇒ `notify` 一次；
  注册**后**自检生效版本（与刚注册的 `description` 比对）不是自己那份 ⇒ `notify` 一次。
  两条共用一个「本会话已提示」标志，绝不静默。
- **扩展加载顺序**：合并生效的前提是 **timeout-bg 先于 remote-tools 加载**（本仓库根 `package.json`
  的 `pi.extensions` 顺序即如此：`timeout-bg` 在 `remote-tools` 之前）。顺序相反时 remote-tools 的
  bash 生效、timeout-bg 语义不生效——此时注册后自检会提示。这是有意接受的上游限制（`general-todo#30`），
  不是本契约要求用户手工保证的隐式前提：**错了会响**。

## 远端超时与 job 托管（v1 频道 `pi-extensions:shell-job-host:v1`）

远端 bash 命中超时后要与本地同语义：**不杀 ssh**、输出继续写 job 日志、进统一 job 面（`/bg`、`/bg:kill`、
`/bg:clear`、footer 状态条段），跑完发与本地同格式的完成通知。执行在 remote-tools、job 注册表在 timeout-bg，
所以再开一条频道传「托管端口」——方向与上方能力频道**相反**：**索取方 emit 空盒子，owner 在同步回调里填
`box.host`**（盒子先到先得、形状守卫各自实现）。提供方在首次需要托管时索取一次并缓存；拿不到 = 没装
timeout-bg ⇒ 远端超时沿用宿主 kill 语义，行为与今天逐字一致。

| 方法 | 语义 |
| --- | --- |
| `allocate()` | 命令**开始前**发号 + 给本地日志路径（远端要先把 pid 写进文件供 `/bg:kill` 用、输出要全量落盘）；只有真的超时才 `register` |
| `register(job)` | 登记为运行中的 job（`id` / `logPath` / 命令 / `target` 展示 / `terminate` 钩子），**返回本次 tool call 应抛出的超时结果文本**——模板由 owner 单源持有，提供方不自己拼一份 |
| `settle(id, exitCode)` | 命令自然结束：更新退出码并触发完成通知；已被 `/bg:kill` 或未登记的 id 忽略（幂等，不报错） |
| `registerBackground(job)` | 调用方**主动要求后台**（timeout-bg-todo#5）：登记 + 返回「⏸ 已直接转入后台」结果文本（同由 owner 单源持有）。载荷与 `register` 同形但没有 `timeoutSeconds`（后台任务不受超时约束） |

**加法式扩展（不开 v2 频道）**：`registerBackground` 是 v1 频道上的**新方法**。双向都安全——旧提供方根本不会调用它；
新提供方探测不到该方法就 fail-closed（`REMOTE_BACKGROUND_UNSUPPORTED`），不静默退化成前台等待。
旧 owner 收不到这个请求、新 owner 收得到，所以没有「版本字段」也无歧义。

双方义务：

- **owner 的超时策略在同一数字下转交**：远端调用未显式给 `timeout` 时，owner 在把参数交给远端分支**之前**填上默认秒数
  （`PI_TIMEOUT_BG_DEFAULT`，默认 300；`0` = 不施加）；显式值原样透传（非法值由远端按宿主同一句文案拒绝）。
- **订阅生命周期**：owner 在 `session_start` 登记这个频道的应答、在 `session_shutdown` 退订（`offerRemoteJobPort` 返回退订函数）——
  盒子是**先到先得**，退订可以避免 `/reload` 后旧实例的回调把提供方的索取填成旧注册表里的死端口。
- **owner 侧（timeout-bg）**：`register` 前清洗跨扩展载荷（`command` 剔控制字符后取首行 400 字符、`target` 剔控制字符、
  `tail` 剔控制字符 + 尾部限长 2000 字符——与本地 job 进 `/bg` 的口径一致）；发给模型的超时文本与本地同源；
  `terminate` 不是函数就当没有；远端 job 在列表/通知里用 `remote <target>` 展示（没有本地 pid）；
  footer 段 `80:timeout-bg` 由注册表变化驱动，只在运行中的任务数 > 0 时出现。
- **提供方侧（remote-tools）**：`allocate` 后自己开日志写盘（`<logRoot>/<pi pid>/<id>.log`，与本地 job 同布局）；
  托管路径**不把超时交给传输层**（那会杀 ssh），本地自己计时；转后台后输出只进日志（不再回灌已结束的 tool call）；
  `terminate` = 先发一条 ssh 按 pid 文件**尽力杀远端进程组**（TERM → KILL），随后断开本地 ssh（失败退化路径）。
- **远端进程怎么被定位**：命令前缀把登录 shell 的 `$$` 写进远端 `/tmp/pi-remote-job-<uuid>.pid`
  （随机名：不需解析远端 `$HOME`、也无法被预置符号链接命中），并挂 `EXIT` / `TERM` / `HUP` trap 自清理。
  **TERM/HUP 的 trap 必须显式 `exit`**——只挂清理 trap 会让 shell 吞掉信号、继续跑下一条命令
  （真机验收抓到过：`sleep N; printf ALIVE > marker` 在 `/bg:kill` 之后仍写出了标记文件）。
- **失败口径**：端口畸形/缺席 ⇒ 当「没有 owner」按原路径工作；`allocate` 返回畸形句柄或 `register` 抛错 ⇒
  提供方断开本地 ssh 并按结构化错误结束（绝不静默当作「已杀」）；日志文件建不出来 ⇒ 当场回退旧路径（远端命令照跑）。
- **主动后台的失败口径（两边都不静默）**：`run_in_background: true` 时**不能**回退——owner 侧对端不支持 ⇒ 报错且不转交；
  提供方侧无端口 / 端口缺 `registerBackground` / 后台日志建不出来 ⇒ 报错且**不 spawn**（拒绝执行，也不在本机跑远端意图的命令）。
  两端都不得把「让路」默默变成前台等待。
- **参数归属与本地一致**：`run_in_background` 由 owner 单源声明（不装 owner 时该参数不存在——不给假装支持的空承诺）；
  远端分派的默认超时注入对后台调用**跳过**（后台不受超时约束）；显式 `timeout` 仍按宿主同文案校验，但后台模式不装计时器。

## 谁在哪实现（改任一侧先读本卡）

- 提供方（能力载荷）：`src/extensions/remote-tools/capability.ts` — `SHELL_CAPABILITY_CHANNEL` / `RemoteBashCapability` /
  `isRemoteBashCall` / `offerBashCapability`
- 提供方（job 托管）：同一文件 — `SHELL_JOB_HOST_CHANNEL` / `RemoteJobPort` / `claimRemoteJobHost`；
  `src/extensions/remote-tools/ops.ts` — `createRemoteBashOps(session, { jobHost, notify })` 的托管路径、
  `buildRemotePidFilePrologue` / `buildRemoteKillCommand`
- owner（能力收集）：`src/extensions/timeout-bg/shell-capability.ts` — `collectBashCapability` / `mergeBashParameters` /
  `createBashDispatch`（含默认超时注入）/ `describeForeignBash` / `describeLostBashRegistration`
- owner（参数面）：`src/extensions/timeout-bg/params.ts` — `run_in_background` 的读取/剥离/描述注入/按模式分派
  （宿主 `execute` 只把 `command`/`timeout`/`env` 交给 ops，新参数到不了那里，所以按模式各持一份工具定义）
- owner（job 托管）：`src/extensions/timeout-bg/shell-job-host.ts` — `SHELL_JOB_HOST_CHANNEL` / `RemoteJobPort` /
  `createRemoteJobPort` / `offerRemoteJobPort`；注册表侧的 `terminate`/`target`/`origin` 在 `jobs.ts`，展示文本在 `text.ts`
- 测试：`src/extensions/remote-tools/test/capability.test.ts`（载荷、订阅与托管端口索取，真 event bus）、
  `src/extensions/timeout-bg/test/shell-capability.test.ts`（收集/守卫/合并/冲突描述）、
  `src/extensions/timeout-bg/test/shell-job-host.test.ts`（托管端口：发号/登记/完成/畸形载荷守卫）、
  `src/extensions/timeout-bg/test/index.test.ts`（真实注册的 bash：合并 schema、分派、默认超时注入、
  job 托管与状态条段、回退与可见性）、
  `src/extensions/remote-tools/test/bash-timeout.test.ts`（托管路径的进程边界：不断连、日志、settle、
  terminate 杀远端 + 断 ssh、无端口时的旧行为）、
  `src/extensions/remote-tools/test/shell-composition.test.ts`（**真实加载两个扩展 + 真实 event bus +
  真实 ExtensionRunner**，覆盖正常顺序、job 托管频道与反向顺序两种加载）、
  `src/extensions/remote-tools/test/remote-live.test.ts`（opt-in 真机：超时不断连 + 远端进程组真的被杀）
