# human-notify TODO

- [x] pi-agent 需要人工介入时发送 Windows 通知，Linux 与 Mac 待后续支持

  触发场景（两类都要通知）：
  - [x] 需要人工审批/输入时通知：监听 `ui_prompt_start`（kind = confirm / select / input / editor / custom），Toast 标题如“Pi 等待你确认”，用户回到终端处理审批或输入。
  - [x] agent 处理结束后通知：监听 `agent_settled`（已完全 settle、无自动重试/压缩/续跑），Toast 标题如“Pi 任务完成”，用户回到终端查看结果。

  实现要点：
  - [x] 仅 Windows 生效（`process.platform === "win32"`），Linux / macOS 直接 no-op（后续支持）。
  - [x] Windows Toast 经 PowerShell + 系统原生 Toast 通道发送，零 npm 依赖；经 `child_process` 派生、不阻塞会话，失败静默（异常隔离，绝不破坏会话）。
  - [x] 文案用静态模板 + 截断摘要，不透传工具原始输出与密钥；通知失败不抛错、不写敏感信息落盘。
  - [x] 防抖：短时间内重复事件只发一次（避免审批 + settle 连发刷屏）；可选 `PI_HUMAN_NOTIFY=0` 一键关闭。
  - [x] 测试：`node:test` + fake spawn（覆盖 win32 触发 / 非 win32 no-op / spawn 失败不破坏会话 / 防抖）。
  - [x] 交付同步：新增 `human-notify/` 扩展目录（`index.ts` 入口）、根 `README.md`、根 `package.json` 的 `pi.extensions` 注册、`todos/` 状态更新（同一变更内完成）。

  交付备注（feat/human-notify → dev-laptop，根 2.8.0）：
  - 单测 15 个全绿 + `tsc --noEmit`（strict + erasableSyntaxOnly，0 错误）+ strip-types 加载正常。
  - Windows 真机程序化验证通过：`buildToastScript` 产物经真实 `powershell.exe` 执行，审批/完成两条 Toast 均 `status=0` 且 stderr 为空（Show() 已实际调用）。视觉目检：请在通知中心确认两条 Toast 的标题正文。
  - 真机调试修出的形态已固化进单测：WinRT 双程序集显式加载 + `[ToastNotification]::new($xml)`（Windows PowerShell 5.1 下 `New-Object` 无法绑定该构造）。

## 后续需求（方案 1：特判等人工具，用户 2026-09-09 确认）

- [x] `plan_mode_question` 这类等人工具调用时也发 Toast

  背景：`ui_prompt_start` 只在扩展调 `ctx.ui.*` 弹窗时触发；`plan_mode_question` 等是 harness 侧工具调用，走 `tool_execution_start`，宿主实测确认盲区。
  - [x] 监听 `tool_execution_start`，仅当 `toolName` 在 `WAITING_TOOL_NAMES` 名单（首批：`plan_mode_question`）时触发；非名单工具不得消耗防抖窗口。
  - [x] 复用既有 `fire` 通道（平台门控 + 5s 全局防抖 + detached 派生 + 异常隔离）；标题复用 `PROMPT_TITLE`，正文用静态模板 + 工具标签映射，不透传工具参数原文。
  - [x] 单测：名单命中触发 / 非名单零 spawn 且不占防抖窗口 / 非 win32 与 `PI_HUMAN_NOTIFY=0` 照常 no-op。
  - [x] 交付同步：`human-notify/` 代码 + 单测、根 `README.md` 小节更新、`AGENTS.md` 计数、根版本 patch bump（同一变更内完成）。

  交付备注（feat/human-notify-waiting → dev-laptop，根 2.8.2）：单测 18 个全绿 + `tsc --noEmit` 0 错误 + strip-types 加载正常；真机 Toast 通道沿用上一轮已验证形态，未改脚本拼装。

## 个性化提醒（待排期）

- [x] 不同对话发送差异化通知，不再统一用 ready for input（待验收）

  现状：审批等待 / agent 结束 / 等人工具全部共用固定标题 + 静态模板，用户看到的都是同一句“等你处理”，分不清是哪件事。
  - [x] 按触发类型出差异化文案：审批→待确认事项一句话摘要；结束→本轮结论一句话；等人工具→具体要问的问题。
  - [x] 摘要来源只取回合尾部 assistant 文本（类似 goal 的证据提取思路），截断后拼入正文；绝不透传工具原始输出与密钥。
  - [x] 现有约束保留：平台门控、防抖、`PI_HUMAN_NOTIFY=0`、失败静默；Linux / macOS 仍 no-op（如届时还没支持）。

  交付备注（feat/human-notify-personalized → dev-laptop，根 2.11.3）：
  - 三类正文差异化：审批 `收到确认请求，请回到终端处理：<摘要>`；等人工具 `收到问题，请回到终端处理：<args 问题文本>`；结束 `本轮结论：<摘要>`；标题不变，摘要空时逐级回退（args 问题 → assistant 尾部 → 现静态模板）。
  - 实现：`message_end`（assistant）滚动缓存尾部文本 `latestAssistantTail`（80 码点 `truncateTailSummary`），`session_start` 重置防跨会话泄漏；`extractAssistantText` / `extractWaitingQuestion` / `truncateTailSummary` 导出纯函数；`MAX_SUMMARY_TAIL = 80`，正文整体仍受 `MAX_SUMMARY = 120` 约束。
  - 单测 32 个全绿（原 18 + 新增 14）+ strict tsc --noEmit 0 错误 + strip-types 加载正常；Windows Toast 通道沿用已验证形态，未改脚本拼装。

## 取消抑制（待排期）

- [x] 人类主动取消的对话不弹框

  用户按 Esc / Ctrl+C 中断当前回合后，其后的 `agent_settled` 不得再发“任务完成”Toast（人都走了还喊人回来看，纯打扰）。
  - [x] 信号沿用 goal 的现成模式：`turn_end` / `agent_end` 时记录 `ctx.signal?.aborted`，`agent_settled` 触发前检查该标记。
  - [x] 被抑制的事件不得消耗防抖窗口（与非名单工具不占窗口的既有语义一致）；已发出的审批 Toast 不撤回（发了收不回），取消后不再补发。
  - [x] 单测：abort 后 settle 零 spawn；正常完成仍照常通知。

  交付备注（feat/human-notify-cancel-suppress → dev-laptop，根 2.13.1）：
  - `userInterrupted` 标记：`agent_start` 重置（照抄 goal/index.ts 模式），`turn_end` / `agent_end` 记录 `ctx.signal?.aborted`（防御式可选链，宿主缺字段视为未取消）；`agent_settled` 处理器开头守卫，在 `fire` 之前返回——不消耗 5s 防抖窗口。
  - 抑制仅作用于 done 通道；审批 / 等人工具通道零改动。
  - 单测 32 → 37（turn_end abort / agent_end abort / 正常完成不误伤 / 抑制不占防抖窗口 / agent_start 重置标记）+ strict `tsc --noEmit` 0 错误；fake 补充 `agent_start` / `turn_end` / `agent_end` 触发器与 `{ signal: { aborted } }` ctx 形态。
