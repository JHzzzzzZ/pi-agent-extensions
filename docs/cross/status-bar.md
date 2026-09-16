# 跨扩展横切契约：状态条刷新节拍与排序（footer + 编辑器上下 widget）

> last verified @ a81ba32
>
> 适用范围：所有往 footer（`ctx.ui.setStatus`）或输入栏上下 widget（`ctx.ui.setWidget`）写「随时间变化」内容的扩展。目标：同一屏多个状态源**同一帧一起刷新**、相对顺序**契约化**，不再靠各自的 `setInterval` 相位碰运气。

## 节拍：对齐同一墙钟秒边界

每个时间类状态源各跑各的定时器时相位互不相关，同一秒内多个段分先后重绘；footer 是一行拼接，先后重绘只影响单帧字面，而 widget 侧曾因宿主保序 bug 表现为「每秒换位 / 互相挤占」（现已由 widget 排序带合并成宿主单键，见下节）。契约：

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

## 段分隔、首段定格与瘦身契约（多源挤占优化）

宿主 `footer.js` 把各扩展状态 `sortedStatuses.join(" ")` 后按宽度右截断：段间只有单空格、按字符硬切、无优先级；`setStatus` 文本里的 `\n` 也会被 `sanitizeStatusText()` 吞成空格——**多行 footer 必须接管 footer 渲染（`ctx.ui.setFooter`），本轮不做**（宿主补丁已禁用，见 `AGENTS.md` 规则红线·仓库边界）。替代约定：

- **首段定格 + 段分隔**：按 key 排序后，**最靠前的可见段不加 `│ `**（行首定格，避免悬空前导竖线），其余段之间以 `│ `（U+2502 + 空格）连接。任一段**出现/消失**（undefined ↔ 有文本）时，所有已登记段立即重算前缀并重渲染（事件驱动，不靠轮询）。
- **协调机制（每插件一份 `status-band.ts`）**：宿主没有「谁在最前」的查询 API（`ExtensionUIContext` 只写不读，`FooterDataProvider` 仅在 `ctx.ui.setFooter` 自定义 footer 时可见）。因此五个写入者各自携带一份 `status-band.ts`：`writeBand(key, text, writer)` 把**逻辑文本（不含前缀）**与真实写 UI 回调交给模块，由模块按同一 `localeCompare` 规则判定最前段、拼前缀后调 `writer`。协调走 `globalThis` 上的 `Symbol.for("pi.status-bar.bands.v1")` 共享登记表——不跨插件 import，单目录仍可复制安装；**局限**：只认识同样使用本模块的写入者（本仓库五个 footer 写入者已覆盖，宿主内置/第三方 status 文本不计入判定）。宿主 `join` 只提供单空格，段边界全靠该前缀；前缀决策在插件样式之前，样式包装的是含前缀的完整文本。
- **瘦身格式**（宽度按终端显示列；goal 目标按 CJK 双宽截到 20 列）：

| 带 | 扩展 | 格式 | 示例（非最前段） |
| --- | --- | --- | --- |
| 10 | goal | `◎ <目标≤20列> · <N>轮 · <时长>` / `⏸ <目标≤20列> · 已暂停 · <时长>` | `│ ◎ 修复全部测试 · 4轮 · 1m05s` |
| 20 | provider-quota | 去 provider 前缀；智谱 `tokX% mcpY%(HH:mm)`、Go `X%/Y%/Z%(HH:mm)` | `│ tok72% mcp40%(14:30)` · `│ 15%/6%/3%(03:41)` |
| 30 | pwr | `pwr <active>▶[ <finished>✓]`（无活跃 run 时清状态） | `│ pwr 2▶ 1✓` |
| 40 | solo-mode | `⚡ solo`（静态） | `│ ⚡ solo` |
| 50 | stream-token-speed | `TTFT <ms>ms · <值>`；汇总 `TTFT <ms>ms · ~<平均> tok/s` | `│ TTFT 412ms · 86.4 tok/s` |

同屏例如（goal 最前，无前导分隔符）：`◎ 修复全部测试 · 4轮 · 1m05s │ tok72% mcp40%(14:30) │ pwr 2▶ 1✓`。

provider-quota 各 adapter 文本（前缀由 `status-band` 统一加）：OpenRouter `$12.50 (used $3.25)`；DeepSeek `10.00 CNY`；ChatAnywhere `60.00`；智谱 `tok72% mcp40%(14:30)`（跨日 `(09-11 00:44)`，时间不可解析/早于 now-24h 则省略括号，只剩时间时输出 `(16:00)`）；OpenCode Go `15%/6%/3%(03:41)`（缺失窗口跳过，重置时间取命中限额窗口 rolling>weekly>monthly，否则 5h 窗口）。智谱/Go 只保留绝对时间，倒计时已删。stream-token-speed 等待态 `TTFT —`、热身 `TTFT 412ms · —`、无流式数据时清除状态（不再显示「无流式速度数据」）。

- **宽度账**（120 列、五段全亮最坏）：goal 段 38（含 20 列 CJK 目标，最前段无前缀）+ 其余四段含各自 `│ ` 前缀（GLM 22 + pwr 11 + solo 9 + stream 汇总 26）+ 宿主 join 4 空格 ≈ **108 列**。
- 生命周期：各写入者 `session_shutdown` 必须经 `writeBand(key, undefined, …)` 清登记（避免 `/reload` / 会话切换后残留文本影响首段判定）；stream-token-speed 自 v 2.x 起在 shutdown 清上一轮汇总。
- 非目标：不做字段轮播、不做跨插件聚合、不改宿主排序/截断行为。

## widget 排序带（编辑器上方，宿主键 `widget-band`）

宿主 `InteractiveMode.setExtensionWidget` 每次 `setWidget` 都先对**两个** widget Map `Map.delete(key)` 再 `Map.set(key, component)`；JS Map 按插入序迭代 ⇒ **被刷新的 widget 沉到所在栈底部**。编辑器上方的三段周期性刷新 widget（`pwr-runs` / `run-timer` / `loop`）因此曾逐秒换位（可见症状：输入栏上方灰色区域「抽搐」，纯观感、无数据风险）。这是宿主行为，本仓库不打宿主补丁（`AGENTS.md` 规则红线·仓库边界），上游 issue 稿见 `docs/pi-widget-order-issue.md`；插件侧的自愈办法就是本节契约。

协调机制：每插件目录一份 `widget-band.ts`（同 `status-band.ts` 模式，`globalThis` + `Symbol.for("pi.widget-band.v1")` 共享登记表，不跨插件 import，单目录仍可复制安装）。band key = 两位数字带 + `:`：

| 带 | 扩展 | band key |
| --- | --- | --- |
| 10 | pwr | `10:pwr-runs` |
| 20 | run-timer | `20:run-timer` |
| 30 | loop | `30:loop` |

规则：

- 写入者**不写自己的宿主键**，只把「本段逻辑行 + 本插件 ui 上下文」交给 `writeWidgetBand(bandKey, lines, ui)`；`lines` 为空（`undefined` / 空数组）表示本段不显示。
- **单一写者**：登记表中 band key 最小的**可见**段当 owner，由它一次写宿主键 `widget-band`（`{ placement: "aboveEditor" }`）；顺序 = band key 升序（`localeCompare`，与宿主 footer 判定同源），**段间不加分隔符**（widget 是多行块，不是 footer 那种一行拼接）。
- owner 段清空（本段不显示 / 会话关停清登记）即自动移交给下一个可见段；全段不显示 → 写 `setWidget("widget-band", undefined)` 卸载（不留残行）。
- 写宿主前有指纹比对（owner + 行内容 + **ui 身份**）：相同内容不踢重绘；ui 身份计入指纹是为了让会话重绑 / `/reload`（宿主清 widget 并换新 ui 上下文）后必然重写一次。
- 生命周期：各写入者 `session_shutdown`（或「已无任务」态）必须清登记（`writeWidgetBand(bandKey, undefined, ui)`），否则 owner 位会留在登记表里——与 footer 排序带的清登记纪律相同。
- **旧契约作废**：「首次挂载顺序 = 扩展注册顺序 = 根 `package.json` `pi.extensions` 顺序」不再成立，也不再需要——宿主只有一个合并键可挪，段间顺序由登记表保证。
- **编辑器下方**（`placement: "belowEditor"`）只有 agent-team 亮块，单占无冲突，**不纳入**排序带（登记表预留 placement 维度供日后扩展，本轮 YAGNI 不做）。
- 接入步骤（新增上方 widget）：复制任一 `widget-band.ts` 到插件目录 → 取一个空出的两位数字带 → 写入改走 `writeWidgetBand` → `session_shutdown` 清登记 → 同步 `test/status-bar-contract.test.ts` 的 bands 表与 `tools/install-smoke.mjs` 的启动期 TUI 键（`widget-band`）。
- 局限：只认识同样使用本模块的写入者；宿主若在其它时机清 widget 而内容未变，指纹会跳过重写（与各写入者自有的文本指纹同源的局限）。
- 验证：`test/status-bar-contract.test.ts` 锁三份拷贝同源 + band key 顺序 + 不绕过排序带；`pwr/tests/ui-widget-band-host.test.ts` 接真实 `InteractiveMode.setExtensionWidget` + 真实 pi-tui 容器，复现旧的三键换位并验证单键 N 帧保序；`tools/install-smoke.mjs` 在真 pi 进程里核验启动期只写 `widget-band`。

## 非目标

- 不做跨插件聚合状态条扩展、不引入 `pi.events` 通信；
- 不为排序做语义重排（带序 = 现有顺序）；
- 不约束 widget 的「出现/消失」高度变化（语义行为），只约束同屏时的相对顺序与刷新节拍。
