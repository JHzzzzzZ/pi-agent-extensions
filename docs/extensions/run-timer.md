# run-timer — 会话/任务/回合计时 widget

> last verified @ 775638d

## 职责与边界

监听 6 个生命周期事件（session_start / agent_start / turn_start / turn_end / agent_settled / session_shutdown），在输入栏上方渲染一行 dim 计时：任务进行时长、本轮时长、本会话累计，按**对齐墙钟秒边界**的节拍刷新（`aligned-ticker.ts`，跨插件契约见 `docs/cross/status-bar.md`）。**不做**：持久化（纯内存状态）、命令/工具（无 `/` 命令）、告警或超时逻辑。

## 文件地图

- `index.ts` — 全部生产代码（约 200 行）：上半是纯函数（formatDuration / isCJK / visualLen / truncateVisual / buildDisplayLine），下半是工厂（事件注册 + 节拍器 + 状态机）。改计时语义只动这半。
- `aligned-ticker.ts` — 对齐秒边界节拍器（每插件一份，不跨插件共享；只依赖全局 `setTimeout` 与可注入 `now`）。
- `run-timer.test.ts` — 50 个 it：前段纯函数表格测试，后段真实工厂 + 假 pi 事件接线测试（含节拍驱动与指纹跳过）。**timer 单例与计账幂等契约都写在这**。
- `aligned-ticker.test.ts` — 9 个 it：首跳对齐、跨跳自校正、stop 幂等、回调抛错后继续排跳。
- 无 package.json / 无 tsconfig —— 刻意的：纯目录复制即可被 pi 自动发现（`extensions/*/index.ts`）。

## 核心数据流

1. `session_start` → 重置全部状态 + 记 savedCtx + hasUI 时起对齐秒节拍（`startAlignedTicker`，默认 1s）。
2. `agent_start` → 无进行中任务才开新任务（randomUUID + performance.now 起点）；`turn_start/turn_end` 只管本轮段。
3. `agent_settled` → settleTask：任务耗时入账 `sessionTotalMs`、记 `lastTask`、id 进 `accountedTaskIds`。
4. 每次事件都立即 flushWidget 一次；节拍只是事件间隙的连续刷新。flushWidget 先比对纯文本指纹，与上一帧相同则跳过 `setWidget`（静态内容不再每秒踢宿主重绘）。窄终端时先保「本会话」段，再截断前缀。

## 不变量

- **恰好一个节拍器**：双 session_start、UI→无 UI 重启、双工厂调用、A/B/A 交错关停，任何时序下 timer 数收敛到 1（`index.ts` stopWidget + 模块级 dispose 单例）。
- **计账幂等**：同一任务 id 只入账一次，settle 后再 shutdown 不得双计（`index.ts` 的 accountedTaskIds Set；测试 dedup accounting）。
- **本会话段永不丢**：宽度截断时保底显示会话总时长，超窄终端只显示它（`index.ts` buildDisplayLine 收尾分支）。
- **hasUI 门控**：无 UI 不建 widget 不建 timer；每处 `setWidget` 均 try/catch 异常隔离，渲染抛错则整个 widget 自拆（`index.ts` flushWidget/stopWidget）。
- 时钟统一 `performance.now()`，负时长钳到 00:00（formatDuration 首行）。

## 已知坑

- 入口文件名必须是 `index.ts`（commit a33ebde 从旧名统一改名换 auto-discovery），复制目录时改名即失效。
- 测试时钟是特例：文件级 before/after 全局替换 `setTimeout`/`clearTimeout`，`fireTick()` 手动触发（节拍器 `now` 可注入，跨跳自校正在 `aligned-ticker.test.ts` 单测）。新增测试勿给它立 deps 口，按 docs/cross/deps-ports.md 的特例约定直接 mock timer。
- `index.ts` 的 widget 传 `theme.fg("dim", …)` 样式字符串——与 loop 的纯字符串约定不同源（那是 `ExtensionUIContext` 的限制），照抄 loop 模式会丢样式。
- 模块级 dispose 是进程级单例：同进程第二个会话工厂会抢走清理权（测试 A/B/old A shutdown/C 用例），多实例场景改这里必须重跑 timer lifecycle 组。

## 改动清单

- 必跑（仓库根，目录无 package.json 不能 cd 进去跑）：node --experimental-strip-types --test src/extensions/run-timer/run-timer.test.ts src/extensions/run-timer/aligned-ticker.test.ts（59 个 it）。
- 必看测试：run-timer.test.ts 的 describe "real factory — timer lifecycle"（节拍单例契约）、"aligned ticker + fingerprint skip" 与 "dedup accounting"（计账幂等）。
- fake 模式（按 docs/cross/deps-ports.md）：纯函数直接测不 fake；工厂测试用真实工厂 + 假 pi 对象（createFakeAPI）fire 事件；时钟按特例约定直接 mock `setTimeout`，不立端口。
