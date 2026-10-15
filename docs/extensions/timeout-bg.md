# timeout-bg — shell 工具超时转后台 + 默认超时

> last verified @ f53c85a

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
  之后日志流、`registry.markExited`、followUp 通知、`/bg` 面、状态条段全部是同一条路径。
  主动后台**不装计时器**（`timeout` 被忽略；显式非法值仍按宿主同句文案拒绝）；
  登记始终早于任何 exit 分发（wire 完才登记，同 tick 安全），否则 job 会永久停在 `running`。
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
- **日志布局**：`<PI_TIMEOUT_BG_DIR | ~/.pi/agent/bg-jobs>/<pi pid>/<jobId>.log`；保留最近 50 个 / 7 天，`session_start` 时清理。
- **会话级生命周期**：`session_shutdown` 杀光本会话遗留的后台任务；不做跨会话守护、不写 pid 文件。
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

- `index.ts` — 接线：工具覆盖、`/bg` 命令面、`session_start`/`session_shutdown`、followUp 送达、默认 deps、bash 归属自检
- `shell-capability.ts` — 与 remote-tools 的能力协商：`collectBashCapability`（广播盒子 + 形状守卫）、
  `mergeBashParameters`（只能新增参数，撞名整份拒绝）、`createBashDispatch`（按参数分派 + 两条安全口径 + notify）、
  `describeForeignBash`/`describeLostBashRegistration`（归属冲突可见性）
- `shell-ops.ts` — `BashOperations.exec` 实现：spawn → 计时 → 输出落盘 → 退出/超时/abort 分流
- `shell-job-host.ts` — 远端 job 托管端口（频道常量、`allocate/register/registerBackground/settle`、应答索取与形状守卫）
- `status-band.ts` — footer 段前缀协调（跨插件契约的本地拷贝；本扩展那份不跨插件 import）
- `jobs.ts` — 后台任务注册表（`running` → `exited` / `killed`，注入 `now` / `killTree` / `onExit` / `onChange`；远端 job 另有 `target`、`origin` 与 `terminate`）
- `logs.ts` — 日志尾部读取、控制字符剔除、保留策略（7 天 / 50 个）
- `config.ts` — 默认超时解析（env）与 timeout 毫秒校验（非法文案与宿主逐字一致）
- `params.ts` — `run_in_background` 的读取/剥离/schema 描述注入/按模式分派（`#5`；与宿主参数面的唯一翻译点）
- `text.ts` — 面向模型/人的静态文本模板（超时结果 / followUp / `/bg` 列表）

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

- `cd src/extensions/timeout-bg && npm install && npm test && npm run typecheck`（68 个：config(6) / params(4) / jobs(9) / logs(6) /
  shell-ops(11) / shell-capability(8) / shell-job-host(11) / index 接线(13)，其中 2 条锁 codemode 视角的结构化结果、
  4 条锁跨扩展组合（合并 schema + 分派、远端不支持主动后台时 fail-closed、畸形/抛错回退可见、未知接管与顺序覆盖 notify）、
  2 条锁远端侧（默认超时注入、托管端口 → /bg + 状态条段 + followUp）、10 条锁托管端口与注册表语义（发号/登记/主动后台登记/完成/畸形载荷/terminate/onChange））
- 进程边界测试只 fake `spawn` 与 `killTree`，真实读写临时目录日志、真实毫秒级计时器；工具本体用宿主真实 `createBashTool`。
- **真机 opt-in**：`test/live.test.ts`（2 个，`PI_TIMEOUT_BG_TEST_LIVE=1` 才跑）用真实 spawn + 真实计时器验「立即返回 / 进程续跑 / 日志续长 / 通知一次」与超时路径同链路；远端那半在 `remote-tools/test/remote-live.test.ts`。

- **评审记录（`#4`，2026-10-11）**：第 1 轮（kimi-coding/k3-256k）= OK with notes（0 阻断 / 5 建议 / 6 备注）：涉及本卡的建议 ②（`shell-job-host.ts` 注释与契约都声称 register 前清洗 command，实现只洗了 tail）已修——现在 `command` 经 `firstLine(stripControlChars(...), 400)`、`target` 也剔控制字符（与本地 job 进 `/bg` 的口径一致），并补了单测；建议 ④（`/bg:kill` 对远端 job 打印 `pid ?`）已改为按 `jobPlace` 展示 `remote <host>`（与 `/bg` 列表、通知同源）。备注（记录不改）与 remote-tools 卡同轮：旧实例订阅残留（已用会话级登记/退订缓解）、`terminate` 缺失、未超时也烧号落盘、异步建不出日志、shutdown 的 terminate fire-and-forget。
- **评审记录（`#4`，2026-10-11）**：第 2 轮（复核第 1 轮 5 条修复）= OK with notes（0 阻断 / 2 新建议 P2 / 3 备注）：5 条全部核实为已修；建议 ①（三张卡的 `last verified` 应指向动过代码的修复提交）已处理；建议 ②（契约卡漏记「会话启动登记 / 关闭退订」）已在 `docs/cross/shell-tool-capability.md` 补「订阅生命周期」一节，并把 `settle` 的幂等口径写成「kill 过或未登记的 id」。备注中两条顺手改掉：`register` 失败路径复位 `backgrounded`（不再对未登记的 id 调 settle，并加断言）；端口守卫的 `REMOTE_JOB_PORT_INVALID` 原样保留给失败文本（不再被统一改成转后台失败码）；`formatJobLine` 与 `jobPlace` 的位置逻辑重复记录不改。
- **评审记录（`#4`，2026-10-11）**：第 3 轮（终轮）= **无新意见**（0 阻断 / 0 建议 / 1 非阻断备注）：第 2 轮的 2 建议 + 3 备注均复核通过，merge `dev-laptop` 后测试数口径（本卡 53 / remote-tools 91 本地 + 9 真机 / dir-context 97）与 `pi.extensions` 顺序自洽；唯一备注（端口错误码透传无测试）已在 remote-tools 侧补用例。三轮上限到，全轮无 P0/P1。
- **评审记录（`#3`，2026-10-11）**：第 1 轮（kimi-coding/k3-256k）= OK with notes（0 阻断 / 0 建议 / 5 备注，两份扩展卡共用）：涉及本卡的 ① `negotiateBash` 的 `base` 死参数（已删）、② `last verified` 指向（驳回，理由=仓库惯例指向被验证的代码提交；本轮统一为 `846213e`）。组合的四条安全断言（`pi.events` 同步填充、载荷撞名拒绝、两条失败路径不落本机、宿主 first-wins 顺序）在宿主 dist 源码层面逐条核实通过。第 2 轮 = OK with notes（0 阻断；①④⑤ 确认修复，②③ 驳回成立）→ 第 3 轮（终轮）= OK with notes（0 阻断，唯一新意见是 ADR 注记的写法，已收口）。三轮无 P0/P1。
- 真机验证（2026-09-22，Windows + Node 24）：真实 spawn + 真实计时器跑 `for i in 1..6; do echo tick-$i; sleep 1; done`，
  `timeout: 2` → 2.3s 转后台、进程存活且日志持续增长 → 7.3s 自然结束，注册表转 `exited(0)` 且 `onExit` 恰好一次。
- 真机验证 codemode 契约（2026-10-04，Windows + pi 1.0.1）：见上节差异表；模型侧 2000 行 / 50 KB 口径与超时转后台路径均无回归。
