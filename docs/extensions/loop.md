# loop — /loop 会话定时任务（循环 / 提醒 / 后台 agent）

> last verified @ a81ba32

## 职责与边界

`/loop` 与 agent 工具 `loop_create/list/delete` 创建四类定时任务：固定间隔循环、daily 每天定时、window 每日时间窗口、一次性提醒；到期经 followUp 注入当前会话，`--bg` 则拉起独立子 pi 后台执行（会话落盘可 resume；v1.4.0 起 `--bg` 支持可选 `--model <provider/id>` 透传子 pi 模型指定，仅后台模式支持，前台带 model 显式报错——fail-closed 而非静默忽略）。**v1.8.0 起同一任务的后台轮次允许重叠、不设并发上限**（曾为「上一轮在跑就跳过」）。**不做**：跨会话共享任务与轮次历史（任务随会话快照存亡，轮次条目随会话文件存亡）、补跑错过的触发点、持久化脚本编排（那是 pwr）、provider 层模型预检（未知模型由子 pi 报错、任务标记 failed——引 provider registry 违背零依赖）。

## 文件地图

- `parse.ts` — 命令解析 + 调度推进纯函数（`nextDailyOccurrence`/`nextWindowOccurrence`），nowMs 注入。改语法或跨天语义必看这里。
- `tasks.ts` — 任务状态机与全部上限常量（`MAX_TASKS`/`MAX_TASK_LEN`/`RECURRING_TTL_MS`/`MAX_BG_SUMMARY_LEN`/`BG_HISTORY_DISPLAY`）、白名单快照序列化（`loop-tasks-v1`，只装运行中轮次）。改调度语义或快照格式必看。
- `runner.ts` — 后台子 `pi --mode json -p` 契约与超时/强杀策略；`getPiInvocation` 解析 pi 可执行入口（`piEntry` 覆盖供真机冒烟在 node 下直接调用）。
- `tools.ts` — 三个 agent 工具，经 `LoopToolDeps` 操作 index.ts 注入的任务状态（persist / refreshWidget 回调）。
- `index.ts` — 对齐秒节拍刷新（`aligned-ticker.ts`）、followUp 送达、widget 渲染、生命周期（session_start / shutdown / 模块级 dispose）。
- `aligned-ticker.ts` — 对齐秒边界节拍器（每插件一份，跨插件契约见 `docs/cross/status-bar.md`）。
- `widget-band.ts` — widget 排序带（每插件一份，跨插件契约同上卡）：只登记 band key `30:loop` 的逻辑行，由 band key 最小的可见段当 owner 一次写宿主单键 `widget-band`（宿主每次 setWidget 都 delete+set，各写各键会逐秒换位）。`test/widget-band.test.ts` 锁本拷贝的语义（合并顺序 / owner 移交 / 卸载 / 文本指纹 / 异常隔离）。

## 核心数据流

1. `/loop …` 或 `loop_create` → 解析为 CreateSpec → `createTask` 校验上限 → 全量快照写 `loop-tasks-v1` 自定义条目（不进 LLM 上下文）。
2. index.ts 按对齐秒节拍扫到期任务 → 到期推进 `nextDueAt`（错过的时间点不补跑，只触发一次）。widget 倒计时文本指纹未变时跳过写 widget（>1h 时 formatCountdown 只到分钟，每秒若无变化就不重绘），写入走 `writeWidgetBand(30:loop, …)`（宿主键 `widget-band`；无任务时清本段登记 → 全空时宿主键卸载）。
3. 前台：任务文本以 `loop-task-due` 自定义类型经 `pi.sendMessage(deliverAs: "followUp")` 送达——空闲开新 turn，agent 正在响应则排队到当前 turn 结束。
4. 后台：`runner.ts` 拉起 `pi --mode json -p --name loop-<id>-<HHMM>`（**不带 --no-session**；任务带 model 时附 `--model <provider/id>`）；JSON stdout 首行 session 头捕获会话 id（运行中即回调写进轮次记录，`/loop:list` 的运行中行可直接 resume），最后一条 assistant 文本截断为摘要。
5. 轮次记录（v1.8）：任务内存态 `runs` 装本会话全部轮次；**快照只持久化 `status==="running"` 的轮次**（`activeRuns`），已结束轮次逐条写 append-only 会话条目 `loop-run-v1`。`session_start` 回放条目重建历史，并把快照里恢复出的轮次（旧 `lastRun` / 宿主中途退出留下的在途轮次）补写为条目——不补写则重启即丢。
6. 会话恢复时从快照水合任务（暂停任务恢复后错过的间隔直接跳过）；关闭时终止全部在途轮次并逐轮写 `interrupted` 条目。

## 不变量

- 最小间隔 60_000ms（`MIN_INTERVAL_MS`，parse.ts），秒向上取整——小于 1 分钟的循环一律拒绝。
- 上限集中在 tasks.ts：每会话 50 个任务（`MAX_TASKS`）、任务文本 ≤2000 字符、重复任务 7 天过期（到期最后触发一次再删，`RECURRING_TTL_MS`）、后台摘要 ≤500 字符。
- daily/window 的时刻均为"距本地午夜的毫秒数"，跨天推进用本地 Date rollover（parse.ts）——不得改成 UTC 或 epoch 直算。
- window 是闭区间 [start, end]；推进语义是"now 之后**严格大于**的下一个触发点"（tasks.ts 头注释），改比较符会产生边界重复触发。
- 后台任务绝不带 `--no-session`（runner.ts 头注释）：与 PWR runner 唯一关键差异，丢了会话就无法 resume。
- **v1.8：同一任务的后台轮次允许重叠，不设并发上限**（用户 2026-09-15 决策：宁可吃并发成本也不丢轮次）。早于 v1.8 的「上一轮在跑就跳过」守卫及其告警不回填。并发下的确定语义：启动通知只在 0→1 发；同任务在途轮次首次 ≥3 发一次 info 提示（回落到 <3 重新武装）；完成通知每轮一条（带轮次起始时刻）；删除 / 暂停 / 7 天过期**不杀在途轮次**（只影响后续触发，跑完只通知不写回）；仅 `session_shutdown` 杀全部在途并逐轮标 `interrupted`。
- **快照只装运行中的轮次**（`serializeTasks` 白名单 → `activeRuns`），全量轮次在 `loop-run-v1` 条目里。曾提过「全量轮次塞进快照」的方案，被否：`persist()` 每次追加全量快照，轮次体积会 O(n²) 累积（15m 巡检跑满 7 天 ≈ 672 轮 → 会话文件 ~100MB 量级；1m 任务可到 GB）。同理 `/loop:list` 只展示运行中全部 + 最近 `BG_HISTORY_DISPLAY`（10）条已完成，更早的折成一行计数。
- **水合出的轮次必须补写为条目**（`session_start` 里 `for (const record of restored) appendRunEntry(...)`）：旧 `lastRun` / 中断的在途轮次只在快照里，不补写就永远不在历史里（下次快照重写后就丢了）。
- 任务 model 必须从任务一路透传到 spawn：`startBgRun` → `runBg` → runner 的 `--model`（index.ts）。v1.4.0 曾只接通解析 / 任务存储 / 列表展示三段，调度调用漏传 `t.model`——`--bg --model` 静默失效、子 pi 落回默认模型（2026-09-11 真机定时任务 13 轮实测，v1.6.1 修复）。改 `startBgRun` 时这是回归红线。
- 自包含：只依赖 pi SDK，不引其它扩展目录；快照格式对旧快照向后兼容（schedule 字段缺省即固定间隔模式，tasks.ts）。
- 命令面为冒号式（v1.6.0）：裸 `/loop` 只管创建与用法（无子命令）；管理走独立静态命令 `/loop:list|:pause|:resume|:delete|:clear`，旧空格管理词只提示改名（parse.ts 只解析 create/usage，看不得命令词）。2026-09 曾以「空格子命令式为全仓基准」同步过文档口径，v1.12.0 全仓改回冒号后本条恢复本插件自身的冒号面。
- 调度不依赖 UI：session_start 无论 `hasUI` 都启动计时器；widget 走 `hasUI` 守卫且传纯无样式字符串（`ExtensionUIContext` 无 theme 字段），写入经 `widget-band.ts`（本插件不写自己的宿主键）。
- 时钟一律注入 `nowMs`，代码里禁止直接 `Date.now()`（仓库时钟约定，见 docs/cross/deps-ports.md）。

## 已知坑

- **测试必须同时 mock `setTimeout` 与 Date.now**：test/index.test.ts 用 before/after 捕获节拍回调 + `fakeNow` 手动推进（BASE = 1_000_000_000_000），只 mock 其一会卡在真实时间上；`flush()` 用 installMocks 捕获的真实 setTimeout（模块体可能在 hook 之后才执行，勿在模块顶层捕）。这是仓库里除 run-timer 外又一个 timer 特例。
- `getPiInvocation`（runner.ts）对 Bun 打包宿主有 `/$bunfs/root/` 虚拟路径特判——换 pi 入口解析策略时必须兼顾 bun 场景，否则打包产物里 spawn 不到 pi。
- 后台任务无并发防护之外的重入：**已由 v1.8 删除**（旧守卫：同一任务上一轮未跑完则本次触发直接跳过并告警，index.ts "上一轮后台仍在运行"）。现只有：删除/过期清除的任务跑完只剩通知，不写回任务。
- 真机冒烟脚本（`test/bg-overlap-smoke.mjs`）必须传 `piEntry`：`getPiInvocation` 靠宿主 `argv[1]` 认 pi 入口，在 node 下直调会把调用方脚本当入口**递归拉起自己**（2026-09-15 实测撞到一次进程风暴）。脚本另有 `--mode/-p` 参数自检保险。
- 会话关闭杀子进程是 SIGTERM → 5s（`KILL_GRACE_MS`）→ SIGKILL；单轮超时 **3 小时**（`BG_RUN_TIMEOUT_MS`，v1.7.0）。这个值必须**大于 headless 子 pi 在 `agent_end` 的 auto-drain 上限**（pi-subagents `DEFAULT_AUTO_DRAIN_TIMEOUT_MS` = 30 分钟）：两者各从自己的起点计时，loop 从 spawn 起算、天然早 20~30 秒到点，取 30 分钟时派单类任务每轮都在子 agent 收尾前被杀（round 记 timeout + 子 run 被 stale-run 误标 failed，真机见 `todos/align/loop-todo#10.md`）。宽限期与 PWR 对齐，改一处需检查 pwr 侧契约。
- 模块级 dispose（index.ts 顶层变量）防 `/reload` 双实例计时器叠加——新增顶层可重入状态必须挂进同一 dispose 链，否则 reload 后 tick 双跑。

## 改动清单

- 必跑：`cd src/extensions/loop && npm install && npm test`（213 个）+ `npm run typecheck`；触碰根 package.json 时同步 bump 版本（loop v1.7.0 → 根 2.49.0 模式）。仓库级：`npm run test:all`（本套件已登记，见 docs/tools/test-all.md）。
- opt-in 真机冒烟（需鉴权 + 网络，不进 npm test）：`node src/extensions/loop/test/bg-overlap-smoke.mjs`——真实 pi 子进程两轮并发，校对各自 session id/会话文件与并发峰值。
- 必看测试：test/index.test.ts（生命周期 + tick 送达 + 后台并发重叠/阈值提示/interrupted；widget 断言按宿主键 `widget-band`）、test/widget-band.test.ts（排序带语义）、test/tasks.test.ts（调度推进、7 天过期边界与轮次快照/回放）、test/runner.test.ts（子进程契约 + label/onSessionId/piEntry）、test/parse.test.ts（语法与闭区间窗口）。
- fake 模式：进程边界手写 fake child + fake spawn（runner.test.ts，参照 deps-ports.md fake 选型规则 1）；时钟经 nowMs 注入手动推进，不引 mock 库。
- 改调度语义：parse.ts 与 tasks.ts 的推进逻辑两端同看，并补 parse.test.ts 边界用例（午夜 / 窗口端点 / 已过时刻排明天）。
