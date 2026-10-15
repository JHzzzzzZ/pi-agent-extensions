# timeout-bg — shell 工具超时转后台 + 默认超时

> last verified @ 174d351

一句话：覆盖内置 `bash` / `powershell` 工具，把「超时即 `killProcessTree` 整树杀」改成「超时转后台继续跑」，
并在未显式传 `timeout` 时施加默认 300 秒（`PI_TIMEOUT_BG_DEFAULT` 覆盖，`0` = 关闭）。
另提供 `run_in_background: true`（`#5`）：**不等超时**，进程一启动就转后台（远端同语义）。

## 为什么这么做

宿主 `dist/core/tools/bash.js` 的 `resolveTimeoutMs`：`timeout === undefined` → 返回 undefined，**不传超时就能无限挂住会话**；
传了超时则计时到点 `killProcessTree(child.pid)` 整树杀，长任务（构建 / 全量测试 / 下载）已完成的工作全丢。
插件侧唯一公开接缝是 `createBashTool(cwd, { operations })` / `createPowerShellTool(...)` 的 `BashOperations.exec`，
所以本插件走「同名工具覆盖 + 自定义 operations」，不改宿主（红线 8）。

## 不变量（改代码前必须知道）

- **超时 ≠ 取消**：abort（Esc）仍然 `killTree`；只有计时器命中（或主动后台）才转后台。
- **主动后台（`#5`）靠模式、不靠哨兵值**：宿主 `execute` 只把 `command`/`timeout`/`env` 交给 `operations.exec`，
  新参数到不了 ops ⇒ 注册时按模式各建一份宿主工具定义（`timeout` / `background`），`params.ts` 的
  `createRunInBackgroundDispatch` 按参数选一份（**不用**共享可变状态，**不用** `timeout: 0/-1`——
  `PI_TIMEOUT_BG_DEFAULT=0` 在本插件里已是「关闭默认超时」，同词反义）。
- **两种转后台的差别只有「何时登记」**：超时路径在定时器命中时登记，主动后台在 spawn 成功后同一 tick 登记；
  之后日志流、`registry.markExited`、结束通知、`/bg` 面、状态条段全部是同一条路径。
  主动后台**不装计时器**（`timeout` 被忽略；显式非法值仍按宿主同句文案拒绝）；
  登记始终早于任何 exit 分发（wire 完才登记，同 tick 安全），否则 job 会永久停在 `running`。
- **结束通知必须用 `deliverAs: "steer"`（timeout-bg#6）**：宿主 agent loop 只在**外层循环「agent 本来要停」
  的检查点**消费 followUp 队列，而 steer 在内层循环每轮工具批结束后取——agent 连着干活（一直在出 tool call）
  时 followUp 通知会一直压在队列里、transcript 里无痕迹，直到它收工才弹出（用户的报障）。改 steer 后通知在
  「当前工具批结束」就进上下文；空闲（非流式）时分支等价：`triggerTurn: true` 直接起一轮。
  代价（有意接受）：通知会中途插话，可能改变 agent 当前计划；别改回 followUp（`test/delivery-semantics.test.ts`
  用宿主真实 `Agent` + faux provider 锁的就是这个时机差）。
- **来源标记 `origin`**：`timeout`（缺省）/ `background`，只影响 `/bg` 行的 `[超时]` / `[后台]`。
- **主动后台的结果文本不复用超时文案**（「⏸ 已直接转入后台」）：说自己“超时”会把主动行为读成事故；
  同样以**错误**结束（`resolve` 会让结构化结果谎报 `exit_code: 0` + `wall_time_seconds: ~0`）。
- **转后台 = 本次 tool call 以错误结束**：宿主 `exec` 契约只有 resolve/reject，我们以 `Error(超时结果文本)` 结束调用。
  宿主的 OutputAccumulator 会丢弃非 `timeout:` 前缀错误的累积文本，所以结果里的「最近输出」取自 ops 自己的内存尾部缓冲
  （`TIMEOUT_TAIL_BYTES`），**不能**现读日志文件（写入流可能尚未 flush）。
- **只有超时转后台的任务进注册表**：正常结束的命令不进——`/bg` 列表的语义就是「转后台的任务」。
- **退出必须等日志 flush**：`logStream.end(cb)` 回调后才 settle；否则调用方读到半截日志。
- **只有 active 里的 shell 工具被覆盖**：`session_start` 读 `pi.getActiveTools()` 后按需注册；无条件注册会把用户关掉的工具重新启用。
- **提示词元数据不继承**：覆盖工具时宿主不继承内置 `promptSnippet` / `promptGuidelines`，本插件显式拼上 `promptGuidelines`，
  并改写 `description` 与 `timeout` 参数说明（宿主原文写着 "no default timeout"，与新语义冲突）。
- **日志布局与编号**：`<PI_TIMEOUT_BG_DIR | ~/.pi/agent/bg-jobs>/<pi pid>/<jobId>.log`；**每条命令（含前台）都落一份**，换来「超时那刻已有完整历史」。
  编号**接着现有日志的最大号续**（`nextJobSeq`，timeout-bg#7）：计数器是实例内状态，`/reload` 后从 1 重排，
  而日志是 append 打开的——不续号就会把新 job 追加进同名旧日志（实测：通知的「末尾输出」混了两条命令）。
  不用 `flags: "wx"` + 重试：同一 pid 目录只属一个进程、实例内编号顺序分配，扫一次即无竞争；`wx` 只会在文件
  意外存在时把命令直接打挂。
- **保留策略分两类**（timeout-bg#7）：别的会话目录按 7 天 / 50 个清（名次只数非豁免文件，否则活会话会把死目录挤光）；
  **活着的会话目录只按 7 天清、不吃数量上限**——豁免必须按「目录名的 pid 还在不在」判（`isProcessAlive`），
  不能只看「是不是自己的目录」：并发的第二个 pi（另一终端 / `pi --print` / 子 agent）在自己 session_start 里
  看到的我们同样是「别家目录」（首轮评审的 P1）。理由：通知/`/bg` 里的路径只有在会话还活着时才有人用，
  而 50 个上限会被「一条命令一个文件」迅速吃满，一次 `/reload` 就清掉整段历史（实测：`bg-37` 的通知 16:05 到达、16:10 被删）。prune 仍在 `session_start` 跑。
- **会话级生命周期**：`session_shutdown` 杀光本会话遗留的后台任务；不做跨会话守护、不写 pid 文件。
  含义在 headless（`pi --print`）里最直观：pi 一退后台任务即被杀，日志停在被杀那一刻——验收这类链路必须**在同一会话内**等它结束（先转后台，再用前台命令等一会儿），跨进程等待永远看不到尾部输出。
- **killTree 自实现**：宿主的 `killProcessTree` 不在包导出面。Windows 用 `taskkill /pid <pid> /T /F`；
  其余平台 `process.kill(-pid)`（spawn 时 `detached: true` 建进程组，与宿主一致）。
- **结构化结果靠「spread 宿主工具」天然对齐（timeout-bg#2）**：注册的工具是宿主 `createBashTool(cwd, { operations })` 的返回值
  加覆盖 `description` / `parameters` / `promptGuidelines`，`outputSchema` 与 `structuredContent`（codemode 脚本视角的
  `output` / `truncated` / `full_output_path` / `exit_code` / `wall_time_seconds`）全由宿主工具层生成。
  **动哪里会破**：一旦改成自己拼返回值（`defineTool` / 自定义 `execute`）而不再 spread 宿主工具，就必须自己声明等价的
  `outputSchema` 并回填 `structuredContent`，否则脚本侧静默退化（拿不到 1 MiB 输出与落盘路径）——`test/index.test.ts` 的
  两条「codemode 视角」测试锁的就是这个（devDependency 因此要求 `^1.0.0`：0.85.x 既无 codemode 也无 outputSchema）。
- **bash 是两扩展共享的名字（timeout-bg#3）**：remote-tools 也在加载期重注册 `bash`（远端 ssh 后端），而宿主对同名工具
  按**扩展加载顺序 first-wins**（`getAllTools()` 只给 schema/sourceInfo、无 execute ⇒ 无法包裹下层）。所以本扩展在注册前
  经 `pi.events` 广播 `{ bash? }` 盒子收集能力，合并参数片段并按参数分派：本地走自己的超时→后台 ops，远端转交能力
  （契约卡 `docs/cross/shell-tool-capability.md`）。
  - **合并生效前提是 timeout-bg 先于 remote-tools 加载**（根 `package.json` 的 `pi.extensions` 顺序）；顺序相反时
    remote-tools 的 bash 生效，**注册后自检**会把「加载顺序更早的扩展覆盖了本扩展」notify 一次（不静默）。
  - **分派安全口径**：`isRemoteCall` 抛错 ⇒ fail-closed 报错（不猜、不落本机）；`executeRemote` 抛错 ⇒ 原样抛 + notify，
    **绝不回退到本机执行**（远端意图的命令在本机跑是安全事故）。
  - **没有对端 / 没有事件总线 / 载荷畸形 ⇒ 行为与今天逐字一致**（畸形载荷额外 notify 一次）；注册前发现 bash 不是内置实现
    且确定没有提供方 ⇒ notify 一次（未知接管者可见）。
- **远端 job 托管（timeout-bg#4）**：远端 bash 超时后也要「不断连 + 输出落盘 + 进统一 job 面」，而远端执行在 remote-tools
  手里——本扩展在 `pi.events` 的**托管频道上应答索取**（`shell-job-host.ts` 的 `createRemoteJobPort`/`offerRemoteJobPort`，
  频道与端口形状见契约卡）。
  - 号段与本地 job 共用（`bg-N` 连续）；`register` 返回的**超时结果文本由本扩展单源持有**（提供方不自己拼一份），
    跨扩展载荷先剔控制字符 + 尾部限长 2000 字符。
  - 远端 job 在 `/bg` 与通知里用 `remote <host>` 展示（没有本地 pid）；`terminate` 钩子（提供方自带：杀远端进程组 + 断 ssh）
    优先于 `killTree(pid)`；`settle` 幂等（已被 `/bg:kill` 的忽略）。
  - **默认超时在同一数字下转交**：分派转发参数前把缺省的 `timeout` 填成 `PI_TIMEOUT_BG_DEFAULT`（默认 300）——用户只记一个数字；
    `0` = 不施加（显式值原样透传）。
  - footer 状态条段 `80:timeout-bg`（`⏱ <N> bg`，只在有运行中的任务时出现）由注册表 `onChange` 驱动；`session_shutdown` 清段登记。
  - 远端超时不断连/落盘/杀远端进程组都在 remote-tools 侧实现（含远端 pid 文件与 kill 脚本）；本扩展只负责登记、展示与通知。

## codemode 结构化结果（timeout-bg#2 实测，pi 1.0.1）

差异表（本扩展返回值 vs 上游 `docs/codemode.md`「Call tools」声明），逐字段全对齐：

| 字段 | 上游声明 | 实测（真机 codemode 脚本） | 差异 |
|---|---|---|---|
| `output` | 上限 1 MiB；超长保首尾各 512 KiB + 省略标记；空输出为 `""` | 1.6 MB 输入 → `len 1048611`（1 MiB + `[... N bytes omitted ...]`，首 `AAAA` 尾 `A==\n`）；空输出 `""`（非 `(no output)`）；`seq 1 5000` → 23.9 KB 全量返回（`startsWith: "1\n2\n"`，首行也在），不被模型侧 2000 行口径截断 | 无 |
| `truncated` | boolean | `false`（小 / 空输出）、`true`（>1 MiB） | 无 |
| `full_output_path` | 可选，仅截断时给 | 仅截断时出现，指向宿主 `pi-bash-*.log`（`details.fullOutputPath` 同值） | 无 |
| `exit_code` | number；非零退出仍返回结构值而非 reject | `exit 3` → `{ output: "boom\n", exit_code: 3 }` | 无 |
| `wall_time_seconds` | number | `0.1` / `0.2` | 无 |

- 模型侧零回归：`content[0].text` 仍是宿主 2000 行 / 50 KB 尾部快照（`>1 MiB` 样本的模型文本 < 60 KB 且带 `[Showing lines …]`）。
- **唯一形态差异是设计使然**：超时转后台那次 call 以 reject 结束（脚本 catch 到 jobId / 日志路径文本），不是结构化值——超时≠完成，见上节不变量。
- 复现命令（脚本里 `tools.bash` 打 JSON 即可）：
  `pi --print --mode json --no-session --no-extensions -e builtin:codemode -e <本目录>/index.ts --tools codemode,bash --model <任意模型> -- "<让模型跑一段 codemode 脚本的提示词>"`

## 文件地图

- `index.ts` — 接线：工具覆盖、`/bg` 命令面、`session_start`/`session_shutdown`、结束通知送达（steer）、默认 deps、bash 归属自检
- `shell-capability.ts` — 与 remote-tools 的能力协商：`collectBashCapability`（广播盒子 + 形状守卫）、
  `mergeBashParameters`（只能新增参数，撞名整份拒绝）、`createBashDispatch`（按参数分派 + 两条安全口径 + notify）、
  `describeForeignBash`/`describeLostBashRegistration`（归属冲突可见性）
- `shell-ops.ts` — `BashOperations.exec` 实现：spawn → 计时 → 输出落盘 → 退出/超时/abort 分流
- `shell-job-host.ts` — 远端 job 托管端口（频道常量、`allocate/register/registerBackground/settle`、应答索取与形状守卫）
- `status-band.ts` — footer 段前缀协调（跨插件契约的本地拷贝；本扩展那份不跨插件 import）
- `jobs.ts` — 后台任务注册表（`running` → `exited` / `killed`，注入 `now` / `killTree` / `onExit` / `onChange`；远端 job 另有 `target`、`origin` 与 `terminate`）
- `logs.ts` — 日志尾部读取、控制字符剔除、编号续号（`nextJobSeq`）、会话日志目录（`sessionLogDir`）、进程存活探测（`isProcessAlive`）、保留策略（7 天 / 50 个，活会话目录豁免数量上限）
- `config.ts` — 默认超时解析（env）与 timeout 毫秒校验（非法文案与宿主逐字一致）
- `params.ts` — `run_in_background` 的读取/剥离/schema 描述注入/按模式分派（`#5`；与宿主参数面的唯一翻译点）
- `text.ts` — 面向模型/人的静态文本模板（超时结果 / 结束通知 / `/bg` 列表）

## 坑

- 测试里调宿主 `createBashTool(...).execute` 必须给 fake ctx 提供 `sessionManager.getSessionId/getSessionFile` 与 `model`——
  宿主用它们注入 `PI_*` 环境变量，缺了就报 `Cannot read properties of undefined (reading 'getSessionId')`。
- 覆盖内置工具会让 pi 启动时打印「工具被覆盖」提示：预期行为，不是故障。
- Windows 上 `detached` 不生效（宿主同款写法）；进程能活下来是因为没有 job object 关联，退出时靠 `session_shutdown` 主动杀。
- `tools/install-smoke.mjs` 的 `EXTENSION_EXPECTATIONS` 必须同步加条目（命令 `bg` / `bg:kill` / `bg:clear`，无 uiKeys），
  `test/install-smoke.test.ts` 的 manifest 漂移测试会锁定；`tools/test-all.mjs` 的 `DEFAULT_SUITES` 同理被 `test/test-all.test.ts` 锁定。
- 后台任务输出会**无条件**落盘（正常结束的命令也留日志，直到保留策略清理）——换来「超时那一刻已有完整历史」，
  代价是磁盘占用，这是有意取舍。

## 测试与验证

- **评审记录（`#7`，2026-12-12，T2 单轮 + 行为面加评）**：reviewer = `zai-coding-cn/glm-5.3`（跨厂商；
  当时 `kimi-coding/k3*` 全 404、`glm-5.3-highspeed` 无套餐权限，故改用同厂商主力档）。
- 第 1 轮 = OK with notes（1 P1 / 0 P2 / 5 P3）；reviewer 显式回答「**有**本轮未覆盖的行为面疑虑」⇒ 按 P1 处理并加评一轮。
  P1：`keepDir` 只豁免「调用方自己的目录」——并发的第二个 pi（另一终端 / `pi --print` / 子 agent，共享同一个
  `bg-jobs`）在自己的 `session_start` 里仍会把活着的会话目录当「别家」按 50 上限删 ⇒ 改成按 `isProcessAlive(pid)` 判活
  （活目录只吃 7 天保留期、不吃上限；死目录照旧）。P3：头注释失实、`nextJobSeq` 读目录失败口径、`createWriteStream`
  异步打开的毫秒级窗口、超长数字名——前三条已随手补正/补注，末条记录不改。
- 第 2 轮（加评轮，终轮）= **无 P1/P2**；两条 warning（注释承诺 EACCES 而实现只认 EPERM、文档未提交且计数不符）
  与两条测试加固建议已在 `174d351` 收口（认 EACCES + 补「真实接线」用例 + 伪 reload 用例让 FakeChild 发输出，
  使内容断言不依赖「append 不写就不脏」的巧合）。T2 两轮上限到。
- **评审记录（`#6`，2026-12-12，T2 单轮 + 行为面加评）**：reviewer = `kimi-coding/k3-256k`（跨厂商）。
- 第 1 轮 = OK with notes（0 阻断 / 1 P1 / 2 P2 / 4 P3）；reviewer 显式回答「**有**本轮未覆盖的行为面疑虑」⇒ 按 P1 处理并加评一轮。
  P1（测试停在裸 `Agent` 层，未锁「模型真看到通知」与会话映射层）已改：测试改接宿主真品 `convertToLlm`（custom → user）
  + 包装 `streamFn` 抓每次请求载荷，断言「steer ⇒ 第 2 次请求就带通知 / followUp ⇒ 第 3 次才带」；
  会话映射层按「未锁」注记（见上节）。P2 ①`docs/INDEX.md` 旧口径已改；②`deliverExit` 吞异步拒绝**驳回**——
  `ExtensionAPI.sendMessage` 在扩展面就是同步 `void`（`extensions/types.d.ts`；返回 `Promise<void>` 的是
  `ReplacedSessionContext.sendMessage`，我们不用那个对象），加 `.catch()` 反而破假 pi 契约。
  P3：测试 2 补长度断言 + 注释改「当前这一步结束」（已改）；三件套锁步归 `general-todo` 既有条目；
  `docs/specs/direct-background.md` 为 #5 时点文档（不改）。`docs/cross/composition-surfaces.md:326` 的旧口径**不在本轮改**：
  该文件是契约面，改它要从严取档 T3，已开新条目（`docs-todo`）单独走。
- 第 2 轮（加评轮，终轮）= **无 P1**；新 P2 一条（称 docs-todo 登记不存在）经核对为视角差异——条目开在主工作区的
  `todos/docs-todo.json`（未提交时 worktree 里看不到），随记账提交落主干后自洽；新 P3 一条（扩展 README 测试数 68 → 70）已改。
  reviewer 复核结论：P1 整改真闭环（注入宿主真 `convertToLlm`、抓的是转换后的请求载荷，且反证过断言恒真的两条路径），
  P2② 驳回成立且证据更硬（宿主绑定点自己 `sendCustomMessage(...).catch(emitError)`，扩展侧拿到的闭包就是 `undefined`）；
  行为面未再发现压住/丢失/重复路径，改名无遗漏。
- **评审记录（`#5`/`#19`，2026-10-15，T3）**：reviewer = `kimi-coding/k3-256k`（跨厂商，三轮上限）。
- 第 1 轮 = OK with notes（0 阻断 / 2 P2 / 4 组 P3）：P2 逐条处理 —— ① 本地主动后台遇 spawn 异步失败（只发 `error`、不保证发 `exit`）会留下永久 running 的僵尸 job（状态条卡住 + 无通知）⇒ `error` handler 在 `backgrounded && !exitSeen` 时自己 `markExited(id, null)`（远端 rejection 分支加对称加固），补「只发 error 不发 exit」单测；② 对齐承诺的 opt-in 真机用例补齐（`timeout-bg/test/live.test.ts` 2 条 + `remote-tools/test/remote-live.test.ts` 主动后台 1 条）。P3：`/bg` 命令描述、远端主动后台失败的归因文案、规格名词与分文件计数。修复 `2b99263`。
- 第 2 轮 = OK with notes（0 P1/P2 / 5 条新 P3）：归因分流同时落到 notify 与工具错误文本并加断言；两处新收口路径改到 `logStream.end` 回调里（与 exit 分支的「日志先落盘再收尾」同口径）；卡片去重与计数同步。修复 `35e043f`。
- 第 3 轮（终轮）= OK with notes（0 P1/P2；唯一 note 是删重复条目留下的空行，已删 `484ff8b`）；reviewer 显式回答「**无**本轮未覆盖的行为面疑虑」（并实证 `logStream` 写失败时 `end` 回调仍触发、`markExited` 对未知 id 幂等）。三轮全轮无 P0/P1，交付 merge `5613957`。
- **已知有意保留**：远端真机用例在本机无可用 ssh 目标（`127.0.0.1:22` 拒绝连接），只能 opt-in 待跑；本地真机层（`live.test.ts`）与真实 `pi --print` 进程内模型面调用已实跑通过。
- `cd src/extensions/timeout-bg && npm install && npm test && npm run typecheck`（75 个：config(6) / params(4) / jobs(9) / logs(10) /
  shell-ops(11) / shell-capability(8) / shell-job-host(11) / index 接线(14) / delivery-semantics(2)，其中 2 条锁 codemode 视角的结构化结果、
  4 条锁跨扩展组合（合并 schema + 分派、远端不支持主动后台时 fail-closed、畸形/抛错回退可见、未知接管与顺序覆盖 notify）、
  2 条锁远端侧（默认超时注入、托管端口 → /bg + 状态条段 + 结束通知）、10 条锁托管端口与注册表语义（发号/登记/主动后台登记/完成/畸形载荷/terminate/onChange））
- `delivery-semantics.test.ts` 接的是**宿主真实实现**：pi-agent-core 的 `Agent` + pi-ai 的 faux provider（官方测试用假模型流），
  只把模型输出换成脚本化假流——锁「steer 在下一轮助手响应之前注入 / followUp 排在第 2 轮助手响应之后」的时机差（纯断言 `deliverAs` 字面量挡不住宿主改消费点）。
  - **未锁的一层（读码核实，不假装已锁）**：`AgentSession.sendCustomMessage` 的 6 行映射——流式中 + `triggerTurn ≠ false`
    ⇒ `agent.steer`；非流式 + `triggerTurn` ⇒ `_runAgentPrompt` 起一轮（与 deliverAs 无关）。搭 AgentSession 脚手架
    （model runtime / session manager / resource loader）成本远超本条改动；宿主改这层时测试不会红，靠本注記提醒复查。
  代价：新增两个**测试专用** devDependencies（`@earendil-works/pi-agent-core` / `pi-ai`，`^1.2.0` = 当时 pi 运行时同版）——
  宿主升级到别的版本时这两个要一起核对，否则测的是另一个 loop。
- 进程边界测试只 fake `spawn` 与 `killTree`，真实读写临时目录日志、真实毫秒级计时器；工具本体用宿主真实 `createBashTool`。
- **真机 opt-in**：`test/live.test.ts`（2 个，`PI_TIMEOUT_BG_TEST_LIVE=1` 才跑）用真实 spawn + 真实计时器验「立即返回 / 进程续跑 / 日志续长 / 通知一次」与超时路径同链路；远端那半在 `remote-tools/test/remote-live.test.ts`。
- **评审记录（`#4`，2026-10-11）**：第 1 轮（kimi-coding/k3-256k）= OK with notes（0 阻断 / 5 建议 / 6 备注）：涉及本卡的建议 ②（`shell-job-host.ts` 注释与契约都声称 register 前清洗 command，实现只洗了 tail）已修——现在 `command` 经 `firstLine(stripControlChars(...), 400)`、`target` 也剔控制字符（与本地 job 进 `/bg` 的口径一致），并补了单测；建议 ④（`/bg:kill` 对远端 job 打印 `pid ?`）已改为按 `jobPlace` 展示 `remote <host>`（与 `/bg` 列表、通知同源）。备注（记录不改）与 remote-tools 卡同轮：旧实例订阅残留（已用会话级登记/退订缓解）、`terminate` 缺失、未超时也烧号落盘、异步建不出日志、shutdown 的 terminate fire-and-forget。
- **评审记录（`#4`，2026-10-11）**：第 2 轮（复核第 1 轮 5 条修复）= OK with notes（0 阻断 / 2 新建议 P2 / 3 备注）：5 条全部核实为已修；建议 ①（三张卡的 `last verified` 应指向动过代码的修复提交）已处理；建议 ②（契约卡漏记「会话启动登记 / 关闭退订」）已在 `docs/cross/shell-tool-capability.md` 补「订阅生命周期」一节，并把 `settle` 的幂等口径写成「kill 过或未登记的 id」。备注中两条顺手改掉：`register` 失败路径复位 `backgrounded`（不再对未登记的 id 调 settle，并加断言）；端口守卫的 `REMOTE_JOB_PORT_INVALID` 原样保留给失败文本（不再被统一改成转后台失败码）；`formatJobLine` 与 `jobPlace` 的位置逻辑重复记录不改。
- **评审记录（`#4`，2026-10-11）**：第 3 轮（终轮）= **无新意见**（0 阻断 / 0 建议 / 1 非阻断备注）：第 2 轮的 2 建议 + 3 备注均复核通过，merge `dev-laptop` 后测试数口径（本卡 53 / remote-tools 91 本地 + 9 真机 / dir-context 97）与 `pi.extensions` 顺序自洽；唯一备注（端口错误码透传无测试）已在 remote-tools 侧补用例。三轮上限到，全轮无 P0/P1。
- **评审记录（`#3`，2026-10-11）**：第 1 轮（kimi-coding/k3-256k）= OK with notes（0 阻断 / 0 建议 / 5 备注，两份扩展卡共用）：涉及本卡的 ① `negotiateBash` 的 `base` 死参数（已删）、② `last verified` 指向（驳回，理由=仓库惯例指向被验证的代码提交；本轮统一为 `846213e`）。组合的四条安全断言（`pi.events` 同步填充、载荷撞名拒绝、两条失败路径不落本机、宿主 first-wins 顺序）在宿主 dist 源码层面逐条核实通过。第 2 轮 = OK with notes（0 阻断；①④⑤ 确认修复，②③ 驳回成立）→ 第 3 轮（终轮）= OK with notes（0 阻断，唯一新意见是 ADR 注记的写法，已收口）。三轮无 P0/P1。
- 真机验证（2026-09-22，Windows + Node 24）：真实 spawn + 真实计时器跑 `for i in 1..6; do echo tick-$i; sleep 1; done`，
  `timeout: 2` → 2.3s 转后台、进程存活且日志持续增长 → 7.3s 自然结束，注册表转 `exited(0)` 且 `onExit` 恰好一次。
- 真机验证 codemode 契约（2026-10-04，Windows + pi 1.0.1）：见上节差异表；模型侧 2000 行 / 50 KB 口径与超时转后台路径均无回归。
