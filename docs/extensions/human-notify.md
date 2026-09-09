# human-notify — 人工介入 Windows Toast 通知

> last verified @ 8d02bf8

## 职责与边界

三类事件把人叫回终端：`ui_prompt_start`（审批/输入弹窗）、`tool_execution_start` 命中等人工具名单、`agent_settled`（完全结束）→ 发系统原生 Toast，正文按触发类型差异化（各带一句话摘要，见核心数据流）。用户主动取消（Esc / Ctrl+C 中断回合）后的 `agent_settled` 不发完成 Toast（取消抑制，见不变量）；已发出的审批/等人工具 Toast 不撤回。**不做**：Linux/macOS 通知（直接 no-op，待后续）、任何会话内交互。

## 文件地图

- `index.ts` — 全部逻辑（310 行单文件，无 package.json，2 空格缩进）：常量区（标题/防抖/上限/名单）→ 纯函数（开关/截断/转义/摘要提取/脚本拼装）→ 扩展工厂。**改文案、名单、防抖、上限必看顶部常量区。**
- `index.test.ts` — 37 个测试，手写 fake（spawn/平台/时钟/pi），无网络、无真实进程。
- 无独立 README；行为说明在 `index.ts` 文件头注释与根 `README.md` 小节。

## 核心数据流

1. 事件进入对应 `pi.on` 处理器 → 先做事件字段校验/名单过滤（非名单工具直接返回，**不消耗**防抖窗口）→ 才调 `fire`。
1. **取消抑制**（照抄 goal 的取消标记模式）：`turn_end` / `agent_end` 记录 `ctx.signal?.aborted` 到 `userInterrupted`，`agent_start` 重置；`agent_settled` 处理器开头守卫——被抑制时在 `fire` **之前**直接返回，不进入 `fire`、不消耗防抖窗口。审批/等人工具通道零改动。
2. **摘要缓存**：`message_end`（仅 `role === "assistant"`）经 `extractAssistantText`（忽略 thinking/toolResult，对齐 goal 的证据提取）提取文本，`truncateTailSummary` 截到 80 码点存入滚动变量 `latestAssistantTail`；`session_start` 重置（防跨会话泄漏）。
3. **正文差异化**（标题不变，摘要空时逐级回退，不出现空段）：审批 `收到确认请求，请回到终端处理：<摘要>`（空 → 事件标题后缀旧模板）；等人工具优先取 `extractWaitingQuestion`（args 的 `questions[0].question`，防御式收窄）→ 回退 assistant 尾部 → 再回退静态模板；结束 `本轮结论：<摘要>`（空 → `DONE_BODY`）。
4. `fire`：平台门控（win32 且 `PI_HUMAN_NOTIFY` ≠ "0"）→ 5s 全局防抖 → `buildToastScript` 截断+转义拼内联 WinRT 脚本 → `spawn powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command <脚本>`，detached + stdio ignore。
5. 派生后立即 `unref` + 挂 noop `error` 监听——Pi 不持有子进程资源，error 事件无人处理会崩会话。
6. 任何一层失败（门控不过/防抖命中/spawn 抛/子进程 error）全部静默吞掉，Toast 不出现也不报错。

## 不变量

- **异常隔离**：通知链路任何异常绝不破坏会话——每个 hook try/catch + `fire` 防御性兜底（`index.ts` 的 `fire` 与三个 `pi.on`）。改代码不得把错误抛回宿主。
- **防抖窗口 5s 全局共享**（`DEBOUNCE_MS = 5000`，`index.ts` 常量区）：窗口内只发第一次；但“进窗口”的资格只属于通过过滤的事件——名单外工具/未启用平台/被取消抑制的 settle 不消耗窗口。删改这条语义会破坏“审批+settle 连发刷屏”的原始动机。
- **取消标记生命周期**（8d02bf8）：`userInterrupted` 只在 `agent_start` 重置（与 goal 完全一致），不在 `session_start` 重置；`turn_end` / `agent_end` 任一带 `ctx.signal?.aborted` 即置位。信号采集是防御式可选链（`ctx.signal?.aborted`），宿主缺该字段视为未取消、行为与无抑制时一致。抑制只作用于 done 通道——审批/等人工具 Toast 在中断前已发出且不撤回，取消后也不补发。
- **文案安全**：摘要先 `truncateTailSummary` 截 80 码点（`MAX_SUMMARY_TAIL`）再拼入正文，标题正文再经 `truncateSummary`（压单行 + 按码点截 120，`MAX_SUMMARY`）与 `escapeXml`；args 中的问题文本是用户可读问题、仍走同一截断+转义链，绝不透传工具原始输出/换行/XML 元字符（`index.ts` 纯函数区）。
- **XML 转义链不可断**：正文经 `XmlDocument.LoadXml` 解析，必须先 `escapeXml`；转义后单引号已变 `&apos;`，`buildToastScript` 再做一层 PowerShell 单引号双写兜底（`index.ts`）。跳过任一层都会拼出坏脚本。
- **平台开关 fail-closed**：`shouldNotify` 仅 `win32` 且 `PI_HUMAN_NOTIFY !== "0"`（精确匹配、大小写敏感）才发，其余一律 no-op（`index.ts`）。
- **真机验证过的 Toast 形态**：WinRT 双程序集显式加载 + `[ToastNotification]::new($xml)`——Windows PowerShell 5.1 下 `New-Object` 无法绑定该构造，此形态已固化进单测（d0eda4c），不得改回 `New-Object`。

## 已知坑

- **`ui_prompt_start` 有宿主盲区**：它只在扩展调 `ctx.ui.*` 弹窗时触发；`plan_mode_question` 这类 harness 侧等人工具走 `tool_execution_start`，宿主实测确认收不到 `ui_prompt_start`——只能按工具名特判（`WAITING_TOOL_NAMES` 名单，`index.ts`，78c0d88）。新出现"等人但没通知"的现象，先怀疑是名单盲区而非防抖。
- **失败全静默，真机坏了没日志**：spawn 失败/子进程 error/脚本出错都不抛不写盘。诊断只能靠 `index.test.ts` 的 fake spawn 单测（断言 calls 参数）+ Windows 真机跑 `buildToastScript` 产物看 `status=0`、stderr 为空（d0eda4c 交付备注的做法）。
- **审批与 settle 在 5s 内只到一条 Toast**：全局防抖是有意设计（防刷屏），不是 bug；被取消抑制的 settle 同样不消耗窗口（守卫在 `fire` 之前返回）。
- **`PI_HUMAN_NOTIFY=0` 只认精确的 "0"**：`PI_HUMAN_NOTIFY=false`、`FALSE` 均无效，不会关闭通知。
- 无 package.json：测试必须从仓库根用 `node --experimental-strip-types --test human-notify/index.test.ts` 跑，不能 `cd human-notify` 后 npm test。

## 改动清单

- 必跑：`node --experimental-strip-types --test human-notify/index.test.ts`（37 个，仓库根执行）+ `tsc --noEmit`（strict + erasableSyntaxOnly）。
- 改脚本拼装（`buildToastScript`/转义/程序集加载）时：除单测外必须在 Windows 真机执行一次产物验证 Show() 实际调用成功（单测只验字符串，验不出 WinRT 绑定问题——d0eda4c 的教训）。
- 新增等人工具：只动 `WAITING_TOOL_NAMES` + `WAITING_TOOL_LABELS`（`index.ts`）；若该工具 args 携带用户可读问题，扩展 `extractWaitingQuestion` 提取，并按既有模式补“名单命中/args 提取/回退链/非名单零 spawn 且不占窗口”单测。
- fake 模式（参照 `docs/cross/deps-ports.md` 的 `HumanNotifyDeps`）：注入 `spawn` / `platform` / `nowMs` / `env` 四端口，手写 fake（`makeFakeSpawn` + `makeClock` + `makeFakePi`），不用 mock 库、不派真实进程。
