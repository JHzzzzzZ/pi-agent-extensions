# docs/ 知识库索引（agent 入口）

> last verified @ ee7f29d
>
> 用途：开发前两跳到达答案——先按"问题类型"查本表，再读对应卡片。
> 硬原则：卡片只写**代码读不出来**的知识（决策原因 / 不变量 / 契约 / 坑），不抄 API。
> 规则：动手前先读对应卡片；改完代码必须同步卡片并更新其 `last verified @` 行。

## 问题类型 → 该读哪个文件

| 问题类型 | 读这个 |
| --- | --- |
| 各扩展职责边界、文件地图、数据流、坑 | `extensions/<插件名>.md`（下表逐张列出） |
| 错误码 / result union 属于哪一层、四层全景 | `cross/result-unions.md` |
| 注入端口（Deps）有哪些、测试 fake 怎么选 | `cross/deps-ports.md` |
| 自定义消息 / entry 常量 / session 持久化键 | `cross/messages-entries.md` |
| solo 免审批模式的跨扩展契约（状态文件 / 采纳方 / fail-closed） | `cross/solo-approval-gate.md` |
| 状态条刷新节拍 / footer 排序带 / 段分隔与首段定格 / widget 栈顺序契约 | `cross/status-bar.md` |
| widget 刷新重排问题与上游 issue 稿（本地不打补丁） | `pi-widget-order-issue.md` |
| 历史事故与教训（渲染堆叠、误杀进程、编码坑） | `incidents.md` |
| PWR DSL 白名单 / 上限 / 脚本版本权威定义 | `pwr/engine/spec.ts`（代码即真相）+ `extensions/pwr.md` |
| PWR 完整架构 / 安全不变量 / 版本历史 | `pwr/DELIVERY.md`（pwr 卡从薄，不重复它） |
| agent-manager 独立工具（会话/agent 进程管理，非扩展）的边界、数据流、不变量、坑 | `tools/agent-manager.md` |

## 扩展卡一览（一行摘要）

| 卡 | 一句话 |
| --- | --- |
| [pwr](extensions/pwr.md) | 工作流运行时：受约束脚本 → 校验/批准 → 子 pi 并行执行；单一 `/workflow:*` 冒号命令面（裸 `/workflow` 生成/帮助 + 15 条子命令） |
| [agent-team](extensions/agent-team.md) | 多 agent 团队：leader 子进程调度成员子进程，报告 followUp 送达；team_stop 按 runId 中止；viewer 内 m 发消息直接对话（派单语义）；run 落盘/reconcile、budget 预算块、model 预检；裸 /team + 冒号子命令 `/team:list|:run|:status|:stop|:view|:clear|:doctor`（派单统一 `/team:run <名> <任务>`）；TUI 对照 pi-subagents 矩阵同步（docs/tui-sync.md） |
| chatanywhere-provider | 双 provider 运行时自动发现：探测 /models 按家族线归并注册，探测失败 fail-closed |
| deep-init | `/deep-init` 提示词驱动四阶段深度初始化 |
| goal | `/goal` 会话目标循环：agent 跨回合自动推进至评估器判定达成；清除非阻塞项走 `/goal:clear|:stop|:off|:reset|:none|:cancel`，恢复 `/goal:resume` |
| human-notify | Windows Toast 人工介入通知（审批/等人工具/结束，正文带差异化摘要） |
| loop | `/loop` 定时任务：固定间隔 / 每日定时 / 每日窗口 / 一次性 / 后台 agent；创建走裸 `/loop`，管理走 `/loop:list|:pause|:resume|:delete|:clear` 冒号子命令 |
| opencode-bridge | 本地 HTTP CONNECT → SOCKS5 桥（裸 `/opencode-bridge` 状态 + 冒号子命令 `:sync`/`:restore`/`:status`），让 Pi 的 httpProxy 走 v2rayN |
| provider-quota | 余额/额度状态 widget + `/quota`，多供应商适配 |
| run-timer | 会话/任务/回合计时 widget |
| solo-mode | `/solo` 免审批模式：审批摩擦门自动按批准路径通过（仅当前会话）；开关/状态走 `/solo:on|:off|:status`；`pi --solo` 启动即开启 |
| todo-cli | `todos/` 工作流原子操作：agent 工具 `todos` + 冒号命令面；`core.ts` 与仓库 CLI 共用，triage 只读扫描 worktree↔条目 |
| stream-token-speed | TTFT + 实时 tokens/s 状态 widget |

## 收录与淘汰

- 新增插件：同变更内建卡 + 本表登记（见 AGENTS.md 规则红线·交付四处同步）。
- 新增独立工具（非插件）：同变更在 `docs/tools/<名>.md` 建卡 + 路由表登记；不计入「扩展卡一览」。
- 卡片超过 100 行 → 说明在抄代码，砍掉；有价值的长内容放扩展自身 README 并从卡里链过去。
- 发现卡片与代码不符：先改代码或改卡对齐，再更新 last verified 行，不留矛盾。
