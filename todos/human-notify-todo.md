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
