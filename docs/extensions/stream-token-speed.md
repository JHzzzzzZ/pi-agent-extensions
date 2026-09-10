# stream-token-speed — 流式回复 TTFT 与实时 tokens/s 状态显示

> last verified @ 1db39e3

## 职责与边界

在 pi TUI 状态栏显示本轮流式回复的 TTFT（首 token 延迟）与瞬时 tokens/s（EMA 平滑），结束后保留汇总（TTFT / 最后瞬时 / 平均）。计量范围：text / thinking / tool call 三类流式增量，各计 1。**不做**：内容解析与输出（绝不读消息文本）、tool result 与工具执行计时、跨轮累计、持久化任何状态（无 session 条目）。

## 文件地图

- `index.ts` — 入口：注册 `message_start/update/end` 三钩子；`portFor(ctx)` 按事件上下文构建端口（hasUI / mode / theme.fg 判定全在此）。改模式降级逻辑必看。
- `adapter.ts` — pi 事件 → 内部契约映射；按结构识别（输入 unknown），含 outcome（completed/aborted/error）判定。
- `metrics.ts` — 纯函数度量层：滑动窗口 / EMA / 热身 / 结束汇总 / 文案格式化；全部常量与契约注释在此。改速度口径必看。
- `controller.ts` — 编排：轮次匹配 + 收编 responseId、250ms 节流、热身期分支、渲染。
- `status-port.ts` — `ctx.ui.setStatus` 薄封装：可用性检查、dim 样式包装、异常隔离。
- `test/fixtures.ts` — 事件夹具 + `RecordingStatusPort` 替身。

## 核心数据流

1. `message_start` → 适配器识别 assistant 消息 → `createRun` + 显示"TTFT 等待中"。
2. `message_update` → 适配器过滤出三类可计量 delta（各计 1，其余 null）→ 计入 1s 滑动窗口。
3. 距上次渲染 ≥250ms 才是合格刷新点；热身期（首个增量后 1s）瞬时值保持 `—`；满 1s 后以首个完整窗口值为 EMA 种子（α=0.3）开始平滑更新。
4. 渲染经 `status-port.ts` → `ctx.ui.setStatus(STATUS_KEY, 文本)`（异常在端口内吞掉；键为 `50:stream-token-speed`，排序带见 `docs/cross/status-bar.md`，调用点统一用 `STATUS_KEY` 常量）。
5. `message_end` → `computeSummary` 出汇总；无任何样本则显示无数据文案，`run` 置 null 停止刷新。

## 不变量

- **内容零接触**：适配器只读事件 type / 消息身份（role / responseId）/ 时间，绝不解析、复制或输出 text / thinking / tool call 参数（adapter.ts 文件头契约）。
- 计量三类增量各计 1（text_delta / thinking_delta / toolcall_delta）；tool result、用户消息、未知 delta 一律返回 null（adapter.ts）。
- 常量即契约：WINDOW_MS=1000 / THROTTLE_MS=250 / EMA_ALPHA=0.3 / WARMUP_MS=1000（metrics.ts），调用点不写魔法数。
- 状态键固定 `"50:stream-token-speed"`（status-port.ts `STATUS_KEY`；`50:` 为 footer 排序带，不可改回无前缀键）。不接对齐秒节拍：250ms 流式节流是内容驱动的，不是墙钟时间类状态。
- `available()` 为 false 时跳过渲染（print / json 模式静默降级）；setStatus / theme.fg 抛错必须在端口内部捕获，绝不影响 pi 消息流（status-port.ts 契约）。
- 时间必须来自同一单调时钟（默认 performance.now，metrics.ts 文件头）——混用墙钟会让窗口计算错乱。
- 轮次隔离：控制器只保留"当前轮"，新 assistant `message_start` 立即替换上一轮展示（controller.ts，AC-08）。
- 样本数组只保留过去 1s，保证长回复内存有界（metrics.ts）。
- 自包含：运行时零 npm 依赖，仅类型导入 pi 包；目录复制即可加载。

## 已知坑

- **responseId 缺失坑（JHL-10-修复#2）**：真实 provider 的 `message_start` partial 通常没有 responseId（流开始前不可知，pi v0.83.0 行为，adapter.ts 文件头有完整分析）。若按严格 id 匹配会把整轮增量判为跨轮而全部丢弃——因此空串 id 视为"未知/通配"，仅两侧均非空且不同才判跨轮；首个真实 responseId 会被收编进当前 Run（controller.ts `matches`/`adoptId`）。
- **setStatus 只收字符串（JHL-10-修复#1）**：颜色必须由调用方用 `ctx.ui.theme.fg("dim", text)` 预包装（status-port.ts）；且 theme.fg 本身也可能抛错，需与 setStatus 同级隔离。
- **RPC 模式禁 ANSI**：dim 样式仅在 `ctx.mode === "tui"` 应用，否则向 RPC 客户端泄漏转义码（index.ts `portFor`）。
- **热身期放大峰值坑（v4 口径）**：未满 1s 的窗口会把首波突发放大成假峰值，故前 1s 显示 `—` 且不播种 EMA（metrics.ts `isWarmingUp`，JHL-10-Design-v4）。
- **末尾静默坑（v3 口径）**：message_end 时末尾 1s 窗口无输出，"最后"沿用最近一次渲染的非零平滑值并以 `~` 前缀标注（`lastInstantCarried`）；热身期未完成无种子时退回有效时长平均，恒非零（metrics.ts `computeSummary`）。
- `outcome`（aborted/error）字段在 adapter.ts 解析了但控制器未消费——中止/出错轮同样出汇总，是刻意留白，改之前先确认是否真需要区分。
- deps-ports.md 特例：时钟经 `createStreamAdapter(() => t)` 注入，状态上报走 `StatusPort` 接口（status-port.ts）——别按 pwr 模式硬造 deps 对象。

## 改动清单

- 必跑：`cd stream-token-speed && node --experimental-strip-types --test test/*.test.ts`（43 个：adapter 7 + metrics 17 + integration 19）。
- 必看测试：`test/integration.test.ts`（逐条验证 PRD §8 的 AC-01～AC-09 全链路）、`test/metrics.test.ts`（窗口/节流/除零/结束补算口径）。
- fake 模式（参照 docs/cross/deps-ports.md）：无 deps 口——纯逻辑直接测真函数，时钟经 adapter 的 `now` 参数注入可控时钟，状态上报用 `test/fixtures.ts` 的 `RecordingStatusPort` 替身（状态端口 fake 的仓库样板，支持 `throwOnSet` 模拟 UI 崩溃）。
- 改速度口径 / 常量：同步 metrics.ts 文件头的契约注释 + README 效果示意；完成后更新本卡 last verified 行。
