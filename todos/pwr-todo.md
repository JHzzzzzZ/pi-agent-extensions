- [x] 根 README 为每个插件增加效果示意图
- [x] devDependencies 安全升级：@earendil-works/pi-coding-agent 等 ^0.83.0 → ^0.85.1，修复 undici/brace-expansion 高危漏洞
- [ ] pwr 接线 `session_shutdown` 钩子调用 `runtime.shutdown()`：pi 0.85.1 已提供该钩子（/new、/resume、/fork、/clone、exit 都触发，见宿主 docs/extensions.md 生命周期图），AGENTS.md 已知怪癖"runtime.shutdown() 从未接线（无 session_shutdown 钩子）"的前提已不成立。接线后 FIFO 队列/缓存/调度器可在会话切换与退出时清理，不残留跨会话状态。TDD：先写伪造 session_shutdown 事件的失败测试再实现。agent-team/loop/goal/provider-quota/run-timer 均已接此钩子，pwr 是唯一缺口。（登记 2026-09-09，来源：定时任务调研 history/2026-09-09.md）
- [ ] pwr 的 TUI 与 pi-agent 同步，代码层级对齐

  pwr 自带无宿主 TUI 层（`src/ui/`：`MemoryRunStore` / `views.ts` / 批准卡 / entry 渲染器 / widget-status），只有 `renderer.ts` 直接碰宿主 `pi-tui`（`Box`/`Text`）；宿主侧一改渲染或主题契约，pwr 的显示就可能悄悄跑偏。对照宿主 pi-agent/pi-tui 的实现逐项对齐，差异只留 PWR 特有语义。
  - [ ] 建对照矩阵：pwr 侧（`src/ui/*` + 快捷键注册表 `keybindings.ts`）逐项对应到 pi-tui/host 侧版本与用法，矩阵落盘（`pwr/DELIVERY.md` 小节或 AGENTS.md）。
  - [ ] 对齐粒度到代码层：`Box`/`Text` 用法、主题取色（`theme.fg`）、widget/status 写入契约、entry 渲染器形态、快捷键注册方式；宿主已有现成组件的不自造轮子。
  - [ ] 约束不变：`@earendil-works/pi-tui` 只作 devDependencies（宿主运行时解析）；测试仍用结构 fake（`as never`），永不实例化真实 pi-tui；每次宿主升级即复核矩阵。
