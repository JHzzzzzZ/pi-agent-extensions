# loop — /loop 会话定时任务（循环 / 提醒 / 后台 agent）

> last verified @ 0241c35

## 职责与边界

`/loop` 与 agent 工具 `loop_create/list/delete` 创建四类定时任务：固定间隔循环、daily 每天定时、window 每日时间窗口、一次性提醒；到期经 followUp 注入当前会话，`--bg` 则拉起独立子 pi 后台执行（会话落盘可 resume；v1.4.0 起 `--bg` 支持可选 `--model <provider/id>` 透传子 pi 模型指定，仅后台模式支持，前台带 model 显式报错——fail-closed 而非静默忽略）。**不做**：跨会话共享任务（任务随会话快照存亡）、补跑错过的触发点、持久化脚本编排（那是 pwr）、provider 层模型预检（未知模型由子 pi 报错、任务标记 failed——引 provider registry 违背零依赖）。

## 文件地图

- `parse.ts` — 命令解析 + 调度推进纯函数（`nextDailyOccurrence`/`nextWindowOccurrence`），nowMs 注入。改语法或跨天语义必看这里。
- `tasks.ts` — 任务状态机与全部上限常量（`MAX_TASKS`/`MAX_TASK_LEN`/`RECURRING_TTL_MS`/`MAX_BG_SUMMARY_LEN`）、`loop-tasks-v1` 快照序列化。改调度语义或快照格式必看。
- `runner.ts` — 后台子 `pi --mode json -p` 契约与超时/强杀策略；`getPiInvocation` 解析 pi 可执行入口。
- `tools.ts` — 三个 agent 工具，经 `LoopToolDeps` 操作 index.ts 注入的任务状态（persist / refreshWidget 回调）。
- `index.ts` — 1 秒 tick 计时器、followUp 送达、widget 渲染、生命周期（session_start / shutdown / 模块级 dispose）。

## 核心数据流

1. `/loop …` 或 `loop_create` → 解析为 CreateSpec → `createTask` 校验上限 → 全量快照写 `loop-tasks-v1` 自定义条目（不进 LLM 上下文）。
2. index.ts 每秒 tick 扫到期任务 → 到期推进 `nextDueAt`（错过的时间点不补跑，只触发一次）。
3. 前台：任务文本以 `loop-task-due` 自定义类型经 `pi.sendMessage(deliverAs: "followUp")` 送达——空闲开新 turn，agent 正在响应则排队到当前 turn 结束。
4. 后台：`runner.ts` 拉起 `pi --mode json -p --name loop-<id>`（**不带 --no-session**）；JSON stdout 首行 session 头捕获会话 id 记入任务，最后一条 assistant 文本截断为摘要。
5. 会话恢复时从快照水合任务（暂停任务恢复后错过的间隔直接跳过）；关闭时终止在途子进程并标记 interrupted。

## 不变量

- 最小间隔 60_000ms（`MIN_INTERVAL_MS`，parse.ts），秒向上取整——小于 1 分钟的循环一律拒绝。
- 上限集中在 tasks.ts：每会话 50 个任务（`MAX_TASKS`）、任务文本 ≤2000 字符、重复任务 7 天过期（到期最后触发一次再删，`RECURRING_TTL_MS`）、后台摘要 ≤500 字符。
- daily/window 的时刻均为"距本地午夜的毫秒数"，跨天推进用本地 Date rollover（parse.ts）——不得改成 UTC 或 epoch 直算。
- window 是闭区间 [start, end]；推进语义是"now 之后**严格大于**的下一个触发点"（tasks.ts 头注释），改比较符会产生边界重复触发。
- 后台任务绝不带 `--no-session`（runner.ts 头注释）：与 PWR runner 唯一关键差异，丢了会话就无法 resume。
- 自包含：只依赖 pi SDK，不引其它扩展目录；快照格式对旧快照向后兼容（schedule 字段缺省即固定间隔模式，tasks.ts）。
- 命令面为子命令式（`/loop list|pause|resume|delete|clear`，v1.4.0）——全仓命令风格统一以本插件为基准（跨插件需求：agent-team/pwr/opencode-bridge 已跟进），本插件无需改动。
- 调度不依赖 UI：session_start 无论 `hasUI` 都启动计时器；widget 走 `hasUI` 守卫且传纯无样式字符串（`ExtensionUIContext` 无 theme 字段）。
- 时钟一律注入 `nowMs`，代码里禁止直接 `Date.now()`（仓库时钟约定，见 docs/cross/deps-ports.md）。

## 已知坑

- **测试必须同时 mock 定时器与 Date.now**：test/index.test.ts 用 before/after 捕获 setInterval 回调 + `fakeNow` 手动推进（BASE = 1_000_000_000_000），只 mock 其一会卡在真实时间上；这是仓库里除 run-timer 外又一个 timer 特例。
- `getPiInvocation`（runner.ts）对 Bun 打包宿主有 `/$bunfs/root/` 虚拟路径特判——换 pi 入口解析策略时必须兼顾 bun 场景，否则打包产物里 spawn 不到 pi。
- 后台任务无并发防护之外的重入：同一任务上一轮未跑完则本次触发直接跳过并告警（index.ts "上一轮后台仍在运行"）；删除/过期清除的任务只剩通知，无运行记录（tasks.ts 序列化处）。
- 会话关闭杀子进程是 SIGTERM → 5s（`KILL_GRACE_MS`）→ SIGKILL，单轮超时 30 分钟（`BG_RUN_TIMEOUT_MS`）；宽限期与 PWR 对齐，改一处需检查 pwr 侧契约。
- 模块级 dispose（index.ts 顶层变量）防 `/reload` 双实例计时器叠加——新增顶层可重入状态必须挂进同一 dispose 链，否则 reload 后 tick 双跑。

## 改动清单

- 必跑：`cd loop && npm install && npm test`（182 个）+ `npm run typecheck`；触碰根 package.json 时同步 bump 版本（loop v1.3.0 → 根 1.3.0 模式）。
- 必看测试：test/index.test.ts（生命周期 + tick 送达 + 后台跳过/interrupted）、test/tasks.test.ts（调度推进与 7 天过期边界）、test/runner.test.ts（子进程契约）、test/parse.test.ts（语法与闭区间窗口）。
- fake 模式：进程边界手写 fake child + fake spawn（runner.test.ts，参照 deps-ports.md fake 选型规则 1）；时钟经 nowMs 注入手动推进，不引 mock 库。
- 改调度语义：parse.ts 与 tasks.ts 的推进逻辑两端同看，并补 parse.test.ts 边界用例（午夜 / 窗口端点 / 已过时刻排明天）。
