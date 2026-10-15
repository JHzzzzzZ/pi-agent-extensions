# btw-todo#1 旁路对话插件 btw（类 Claude Code /btw）

## 意图

主对话跑长任务时（多轮工具调用、流式输出中），用户想随时问「现在在干啥 / 为什么这么改 / 进度如何」，但不想打断主 run，也不想让这些问答进入主上下文——现状下唯一通道是把问题作为 steer/followUp 插进主对话（how-pi-works.md：steering 在当前助手回合后进入、followUp 等 agent 停下才送达），必然写进主上下文，可能污染主对话、烧主模型 token、干扰主 agent 判断。

需要一条**只读主会话、零写入**的旁路问答通道：主 agent 跑着时可用，问答落在一个独立面板里，主会话文件与下一轮主请求都无痕。参考形态：Claude Code 的 `/btw`。

已核实的两条宿主事实（决定方案可行）：

- 扩展命令**在 agent 流式运行中立即执行**，不经 steering/followUp 队列（`docs/rpc-commands.md:31`）——`/btw` 运行中可用。
- `ctx.modelRegistry.streamSimple()` 是官方「直调模型、不写会话」接缝（宿主负责路由/鉴权/虚拟模型/sessionId 会话头），goal 评估器已用并有真机对照（`todos/align/goal-todo#10.md`）。

## 范围

做什么（v1）：

1. **触发**：`/btw <问题>` 扩展命令（`pi.registerCommand`），空闲与运行中都可用；无参数时给用法提示。
2. **上下文取材**：读当前分支尾部（`ctx.sessionManager.getBranch()`），按字符预算截断（默认约 3 万字符）：用户消息 + 助手文本 + 工具调用名/参数头 + 工具结果截断。不含正在流式、尚未落盘的内容（MVP 限制，写进 README）。
3. **侧调用**：`ctx.modelRegistry.streamSimple(model, { messages }, { maxTokens, signal, sessionId })`，单条 user 消息 = 侧角色说明 + 上下文 + 本轮问题 + 侧线程前文；**无工具**（纯文本问答）；超时与 `maxTokens` 为有界常量（集中在扩展的规范文件，调用点不写魔法数）。
4. **展示**：`ctx.ui.custom()` 只读可滚动覆盖面板（文本答案，丢弃 thinking）；不用 `notify`（会截断）。面板关闭键不与编辑器抢键（承 agent-team「不偷编辑器按键」教训）。
5. **侧线程**：同一会话内保留追问记忆（扩展内存），`/btw:clear` 重置；**不落盘**（重启即失）。
6. **模型**：默认跟随主模型（`ctx.model`）；`/btw:model <provider/id>` 会话内切换，`/btw:model` 显示当前值。
7. **硬不变量（零写入）**：侧对话不 `pi.appendEntry`、不 `pi.sendMessage`、不碰主 run（无事件拦截、无上下文注入、无 steer/followUp 介入）。
8. **并发**：同一时刻只允许一个侧调用；重复触发直接提示「上一个侧问答还在跑」，不排队。

明确不做什么（v1）：

- 不做面板内输入框（v2 再评估；TUI 自绘输入框成本高，agent-team 踩过一组坑）。
- 不做 `/btw:send`（把答案送回主对话的手动出口）——真需要再单独登记。
- 不给侧模型工具（不读文件、不跑命令）、不做多侧线程/命名线程管理。
- 不持久化侧线程（不 `appendEntry`）。
- 不加用户可配开关/配置项（常量集中在规范文件，YAGNI；真用出需求再加）。
- 不改主会话任何行为（本插件对主对话的存在感为零，除了命令名）。

## 验收标准

1. **运行中可用（真机）**：主 agent 流式运行中执行 `/btw 现在在干啥` 能出答案，主 run 不中断、主会话不新增条目。
2. **零写入**：`/btw` 前后 session JSONL 无新增条目；下轮主请求上下文不含侧问答（真机对照 + 单测锁定代码路径不调用 `appendEntry`/`sendMessage`）。
3. **上下文取材**：单测覆盖预算截断、工具结果截断、空分支/无消息降级（提示不崩）；宿主事件路径测试接真实 `discoverAndLoadExtensions` + 真实 `ExtensionRunner`（承 dir-context / jev-safe-gate 模式，只 fake `modelRegistry`/`sessionManager` 等本扩展不读的面）。
4. **模型接缝**：单测锁定经 `ctx.modelRegistry.streamSimple` 调用；物理模型与虚拟模型（`api=pi-virtual` 路由）两路对照（fake registry 复刻宿主路由行为，同 goal 测试装置）。
5. **UI 守卫**：`ctx.hasUI` 守卫；无 UI 模式（print/json）报明确错误不静默、不崩；面板组件若自绘，接真实 TUI headless 渲染测试（承 agent-team viewer-host 教训：纸面单测不够）。
6. **侧线程**：同会话两轮追问，第二轮注入第一轮问答（单测锁定）；`/btw:clear` 后不再注入。
7. **文档四处同步**：根 README（功能 + 实测测试数）、`docs/extensions/btw.md` 卡片 + INDEX 登记、根 `package.json`（`pi.extensions` 注册 + version bump）、`docs/cross/composition-surfaces.md` 占用声明（命令名/潜在状态键）。
8. 全量测试绿 + `npm run typecheck` 零错误。

## 人工确认

- 确认人：用户（本会话）
- 日期：2026-10-15
- 方式：会话内 5 问逐条对齐（Q1 交互形态 / Q2 上下文取材 / Q3 侧线程记忆 / Q4 模型选择 / Q5 零写入不变量），用户回复「按推荐」→ 本档落盘后用户回复「确认」
- 结论：全部决策按本档执行——`/btw` 命令 + 只读覆盖面板；分支尾部约 3 万字符预算；会话内侧线程记忆不落盘；默认跟随主模型 + `/btw:model` 切换；零写入为硬不变量、v1 不做手动出口。
