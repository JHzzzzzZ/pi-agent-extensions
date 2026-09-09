# TODO（工作区级 · docs/ 知识库）

> 非插件条目：`docs/` 是工作区级 agent 知识库，不对应任何 `pi.extensions` 插件，单独建档。

- [x] 建立工作区 `docs/` agent 知识库，减少开发时的代码通读。（完成：11 张卡 + INDEX + 3 份 cross + incidents 全部落盘，主代理硬校审 + subagent 交叉校对通过）

  组织形式：一张路由表 + 每扩展一张卡，agent 两跳到达答案。
  - [x] `docs/INDEX.md` — 路由表：问题类型 → 该读哪个文件（agent 入口）。
  - [x] 样板卡 × 2：`docs/extensions/pwr.md`、`docs/extensions/agent-team.md`（六节 + last verified @ 0142e14）。
  - [x] `docs/incidents.md` — 事故与教训（TUI 堆叠三轮、亮块残影、超宽行断言、同步派单阻塞、taskkill 全杀 node、/reload 后工具消失、GBK 编码坑、无超时命令挂起）。
  - [x] `docs/cross/` — `result-unions.md`（四层错误码全景）、`deps-ports.md`（注入端口与 fake 模式）、`messages-entries.md`（自定义消息/entry 常量、session 持久化键全景）。
  - [x] AGENTS.md「关键目录」加 `docs/` 入口一行，并在「交付与文档同步」节挂同步规则（动手前先读卡、改完同步卡 + last verified 行、新增插件同变更建卡）。
  - [x] `docs/extensions/` 其余 9 张卡（chatanywhere-provider / deep-init / goal / human-notify / loop / opencode-bridge / provider-quota / run-timer / stream-token-speed），阶段 B subagent 并行产出 + 主代理硬校审（每张 ≤100 行、六节齐全、无代码围栏、last verified 齐全）。
  - [x] 阶段 B 收尾：cross/ 三份经独立 reviewer 子代理逐事实校对（错误码名单/键值/端口名全部属实，修正 SaveLibDeps 漏列、StatusPort 说法、loop 时钟例外、--no-session 契约 4 处）；INDEX 已含全部 11 行摘要。
  - 硬原则：只写代码读不出来的知识（决策原因/不变量/契约/坑），不抄代码、不列 API；每份 ≤100 行、bullet 为主。
  - 实施步骤：先搭骨架 + agent-team、pwr 两张样板卡给用户过目，认可后再铺满其余 9 个插件。
