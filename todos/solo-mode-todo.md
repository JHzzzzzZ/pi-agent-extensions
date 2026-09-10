# solo-mode-todo

- [x] 提供一个开关或快捷键激活 pi agent 的 solo 模式（完成 2026-09-11 @ 9e2c15d / feat-solo-mode-approval-gate）
  - 交付：新增 `solo-mode/` 扩展（11 测试）+ pwr 410 / opencode-bridge 113 / deep-init 37 全绿 + 三处 typecheck 零错误；文档同步（`docs/extensions/solo-mode.md`、`docs/cross/solo-approval-gate.md`、docs/INDEX、三张扩展卡 last verified）与版本 bump（根 2.16.0 / pwr 2.5.0 / bridge 1.5.0 / deep-init 1.2.0）。
  - 语义定案（2026-09-11，用户确认）：solo 模式 ＝ **无需审批，危险操作自动批准**（审批摩擦豁免），非"禁用委派"亦非"精简运行"。
  - v1 形态：独立卫星扩展 `solo-mode/`，仅 `/solo` 命令（`/solo` 切换、`/solo on|off|status`，未知参数提示用法）；不做快捷键。
  - v1 范围（审批摩擦门）：PWR 批准卡（自动按 once）、opencode-bridge sync / 端口切换 / restore 确认（restore 自动选最新备份）、deep-init `--create-new` 二次确认。**不含**误触保护类确认（agent-team viewer `D` 停止、`/team:clear`、pwr 删除选择）。
  - 生命周期：仅当前会话（`/reload`、`/new`、`/resume`、`/fork`、进程退出即复位）；开启需一次确认，无 UI 环境拒绝激活。
  - 跨扩展契约：状态文件 `${PI_SOLO_MODE_FILE:-~/.pi/agent/solo-mode.json}` = `{pid, activatedAt}`，读者校验 `pid === process.pid`（fail-closed），故子 pi 进程不继承 solo；契约卡 `docs/cross/solo-approval-gate.md`。
  - 非目标：不禁用委派工具、不自动处理 pi `project_trust` 提示、不做跨会话持久化。
  - 实现注意：与其它卫星扩展形态一致（目录 + `index.ts` 入口，复制进 `extensions/` 后 `/reload` 生效）；TUI 写入前 `ctx.hasUI` 守卫；新增插件需在同一变更内同步 docs/ 卡片、README、根 package.json 与本 todo 文件。
