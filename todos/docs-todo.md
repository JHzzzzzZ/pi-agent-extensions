# TODO（工作区级 · docs/ 知识库）

> 非插件条目：`docs/` 是工作区级 agent 知识库，不对应任何 `pi.extensions` 插件，单独建档。

- [ ] 建立工作区 `docs/` agent 知识库，减少开发时的代码通读。（processing：方案已与用户确认，待实施）

  组织形式：一张路由表 + 每扩展一张卡，agent 两跳到达答案。
  - [ ] `docs/INDEX.md` — 路由表：问题类型 → 该读哪个文件（agent 入口）。
  - [ ] `docs/extensions/<插件名>.md` × 11 — 每插件一卡，≤100 行：职责与边界 / 文件地图（改 X 必看 Y）/ 核心数据流（3-5 步）/ 不变量 / 已知坑 / 改动清单（必跑命令 + fake 模式）；头部带 `last verified @ <commit>`，改代码后必须同步更新。pwr 卡从薄，链到现有 `pwr/DELIVERY.md` 不重复。
  - [ ] `docs/cross/` — 跨扩展横切契约：`result-unions.md`（四层错误码全景）、`deps-ports.md`（注入端口与 fake 模式）、`messages-entries.md`（自定义消息/entry 常量、session 持久化键全景）。
  - [ ] `docs/incidents.md` — 事故与教训（TUI 堆叠三轮、taskkill 全杀 node、/reload 后工具消失等），纯增量知识，防重复踩坑。
  - [ ] AGENTS.md「关键目录」加 `docs/` 入口一行，并在「交付与文档同步」节挂同步规则："动手前先读对应卡片，改完同步卡片（含 last verified 行）"。
  - 硬原则：只写代码读不出来的知识（决策原因/不变量/契约/坑），不抄代码、不列 API；每份 ≤100 行、bullet 为主。
  - 实施步骤：先搭骨架 + agent-team、pwr 两张样板卡给用户过目，认可后再铺满其余 9 个插件。
