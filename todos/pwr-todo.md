- [x] 根 README 为每个插件增加效果示意图
- [x] devDependencies 安全升级：@earendil-works/pi-coding-agent 等 ^0.83.0 → ^0.85.1，修复 undici/brace-expansion 高危漏洞
- [x] pwr 接线 `session_shutdown` 钩子调用 `runtime.shutdown()`：pi 0.85.1 已提供该钩子（/new、/resume、/fork、/clone、exit 都触发，见宿主 docs/extensions.md 生命周期图），AGENTS.md 已知怪癖的前提已不成立。接线后 FIFO 队列/缓存/调度器可在会话切换与退出时清理，不残留跨会话状态。（完成 2026-09-10：TDD 新增生命周期接线测试；发现并修复配套缺口——runtime 是模块级单例，shutdown 后无复位路径，新增 `revive()` 在 session_start 复位 SESSION_SHUTDOWN 闩锁，否则 /new 一次后 start() 永久抛错；`RuntimeAdapter` 增加可选 `shutdown?()/revive?()` 契约。406 测试 + typecheck 绿；agent-team/loop/goal/provider-quota/run-timer 均已接此钩子，pwr 补齐为最后一个）
- [ ] 命令风格统一（跨插件）：冒号命名空间式命令面（`/workflows:list|view|open|pause|resume|stop|restart|save|saved|script|approve|help` 及 `/workflow-delete`、`/pwr-model`）与统一基准（loop 的子命令式）不一致。跨插件需求，已在 agent-team-todo.md 同步登记。（processing 2026-09-10 @ feat/commands-subcommand-style：13 个 `/workflows:*` 合并为单 `/workflows` + 子命令；`/workflow run|delete|model` 子命令；动态 `/workflow:<name>` 注册退役，saved 调用运行时读盘）。跨插件需求：pwr 条目为命令风格统一任务的一部分
- [x] 采纳 solo 审批门（跨插件，solo-mode 条目一部分）：`/solo` 开启时 workflow_validate 不弹批准卡（按 once 自动批准）、workflow_start 强制降级 once、已保存命令 approveSavedCommand 返回 once；绝不写 remembered 批准。（完成 2026-09-11 @ 9e2c15d：`pwr/src/solo-gate.ts` + index.ts 三处接线 + entry.test 集成用例，410 测试全绿）
- [ ] pwr 的 TUI 与 pi-agent 同步，代码层级对齐

  pwr 自带无宿主 TUI 层（`src/ui/`：`MemoryRunStore` / `views.ts` / 批准卡 / entry 渲染器 / widget-status），只有 `renderer.ts` 直接碰宿主 `pi-tui`（`Box`/`Text`）；宿主侧一改渲染或主题契约，pwr 的显示就可能悄悄跑偏。对照宿主 pi-agent/pi-tui 的实现逐项对齐，差异只留 PWR 特有语义。
  - [x] 建对照矩阵：pwr 侧（`src/ui/*` + 快捷键注册表 `keybindings.ts`）逐项对应到 pi-tui/host 侧版本与用法，矩阵落盘（pwr/DELIVERY.md 小节或 AGENTS.md）。（完成 2026-09-10 @ feat/pwr-tui-sync-matrix：落盘 `pwr/docs/tui-sync.md`——沿 agent-team/docs/tui-sync.md 先例选独立文件而非 DELIVERY 小节（DELIVERY 为受损的版本历史文档，矩阵需要独立复核生命周期）；含文件映射/对齐维度/行动项 A1-A5（A1 按键匹配换 matchesKey 有 kitty 协议正确性风险，A2 text.ts 换宿主 truncateToWidth/wrapTextWithAnsi 删自写轮子）/宿主升级复核流程，基线 pi-tui 0.85.1）
  - [ ] 对齐粒度到代码层：`Box`/`Text` 用法、主题取色（`theme.fg`）、widget/status 写入契约、entry 渲染器形态、快捷键注册方式；宿主已有现成组件的不自造轮子。
  - [ ] 约束不变：`@earendil-works/pi-tui` 只作 devDependencies（宿主运行时解析）；测试仍用结构 fake（`as never`），永不实例化真实 pi-tui；每次宿主升级即复核矩阵。
