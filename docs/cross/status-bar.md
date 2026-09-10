# 跨扩展横切契约：状态条刷新节拍与排序（footer + 编辑器上下 widget）

> last verified @ 1db39e3
>
> 适用范围：所有往 footer（`ctx.ui.setStatus`）或输入栏上下 widget（`ctx.ui.setWidget`）写「随时间变化」内容的扩展。目标：同一屏多个状态源**同一帧一起刷新**、相对顺序**契约化**，不再靠各自的 `setInterval` 相位碰运气。

## 节拍：对齐同一墙钟秒边界

每个时间类状态源各跑各的定时器时相位互不相关，同一秒内多个段分先后重绘；宿主 widget 保序 bug 下看起来就是「每秒换位 / 互相挤占」。契约：

- 时间类刷新一律用**插件目录内自带的** `aligned-ticker.ts`（`startAlignedTicker(fn, { intervalMs = 1000 })`）驱动；
- 首跳延迟 `intervalMs - (now() % intervalMs)`，此后每次回调按实际时钟重算（自校正、不累积漂移）；`stop()` 幂等；回调异常吞掉并继续排跳；内部 `unref()`，不阻止宿主退出；
- 写入前做**文本指纹比对**，与上一帧相同就跳过 `setStatus`/`setWidget`（静态内容不踢宿主重绘）；
- 事件驱动的立即写入保留（内容变化时照常即时刷新）；
- **非时间类刷新不受约束**：stream-token-speed 的 250ms 流式节流、provider-quota 的 5 分钟轮询、pwr 的推送式刷新、solo-mode 的静态写入照旧；
- 节拍助手**每插件一份**（复制文件，不做跨插件共享模块）——每个扩展必须保持单目录可复制安装。

接入步骤（新增时间类状态源）：复制任一 `aligned-ticker.ts` 到插件目录 → `session_start` 起节拍、停止条件（idle / 无 UI / `session_shutdown`）处 `stop()` → 写状态前指纹比对。

## footer 排序带（`setStatus` 键）

宿主 `footer.js` 把各扩展状态放进 Map，按 **key `localeCompare` 排序**后空格拼一行、超宽右截断。键即排序契约：

| 带 | 扩展 | 键 |
| --- | --- | --- |
| 10 | goal | `10:goal` |
| 20 | provider-quota | `20:provider-quota` |
| 30 | pwr | `30:pwr` |
| 40 | solo-mode | `40:solo-mode` |
| 50 | stream-token-speed | `50:stream-token-speed` |

规则：两位数字带 + `:`，留 10 的间隔供未来插入；新增插件按语义带编号，并同步 `test/status-bar-contract.test.ts` 的 bands 表（该测试同时校验键字面量确实出现在对应源码）。排序带键只是内部键，用户不可见。

## widget 栈顺序

- **编辑器上方**（`setWidget(key, lines)` 无 placement）顺序（**首次挂载**）= 扩展注册顺序 = 根 `package.json` `pi.extensions` 数组顺序：宿主 `session_start` 按注册顺序逐个 `await` 派发，首个 `setWidget` 决定 widget Map 插入序。当前契约：`pwr-runs → run-timer → loop`（loop 无任务时懒挂载，首次出现位于当时栈底）。
- **编辑器下方**（`placement: "belowEditor"`）只有 agent-team，无冲突。
- 刷新阶段**不保序**：宿主 `setExtensionWidget` 每次 `setWidget` 都 delete+set，会把该 key 移到栈底（周期性刷新 widget 因此逐秒换位）。这是宿主行为，本仓库不打宿主补丁（`AGENTS.md`「仓库边界」）；问题走上游，见 `docs/pi-widget-order-issue.md`（issue 草稿）与各插件的 route A 待办。
- 接入步骤（新增上方 widget）：把扩展注册进根 `package.json` `pi.extensions` 的正确位置，并在 `test/status-bar-contract.test.ts` 锁定相对顺序。

## 非目标

- 不做跨插件聚合状态条扩展、不引入 `pi.events` 通信；
- 不为排序做语义重排（带序 = 现有顺序）；
- 不约束 widget 的「出现/消失」高度变化（语义行为），只约束同屏时的相对顺序与刷新节拍。
