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
- [x] AGENTS.md「交付与文档同步」新增任务收尾核对规则：结束前核对 AGENTS.md / README.md / package.json / docs/ 四处同步；docs/ 不再成立的删，仍成立的更新 last verified 行。
  - 硬原则：只写代码读不出来的知识（决策原因/不变量/契约/坑），不抄代码、不列 API；每份 ≤100 行、bullet 为主。
  - 实施步骤：先搭骨架 + agent-team、pwr 两张样板卡给用户过目，认可后再铺满其余 9 个插件。
- [x] team_stop（agent-team 1.2.0）落地后同步 docs/ 知识库：agent-team 卡（职责/数据流/不变量/改动清单 109→137 + last verified）与 INDEX 摘要行。
- [x] 根 README 增加「5 分钟上手」章节：对标 Claude Code / OpenCode / Gemini CLI 的 onboarding 结构（编号旅程 + 每步可验证成功判据），补齐外部用户"从零装到跑通"缺口：Step 0 前置条件（pi 本体安装命令 + /login 认证）、装后验证判据、第一个真实任务（loop 提醒 → agent-team 建团派单 → pwr 工作流）、排障 FAQ（扩展没加载 /reload、pi list 自检、human-notify 仅 Windows）。（完成 @ 5c217ab，2026-09-09，来源：定时任务调研 history/2026-09-09.md）
- [ ] 根 README 顶部增加真机截图：对标 OpenCode/Gemini CLI"TUI 截图放开头"模式——现有 ASCII 效果示意不能替代真实截图（GOAL.md §2 "真机截图齐全"是"别人这把"尺子的明确要求）。候选：agent-team 亮块+查看器、pwr 运行查看器、/workflow:list 列表。落盘 `docs/assets/`（或根 `assets/`），需要真机运行时抓取（可探索 headless 渲染或人工协助）。（2026-09-11 进展：headless 截图管线已落地——`agent-team/tools/capture-screens.mjs` 用真实 `TuiMainScreen` + 真实 viewer 组件无头重放、输出 SVG 并挂进 README agent-team 节；自检 + 确定性 + 6 个测试锁定。2026-09-11 第二轮：同一管线新增 pwr `RunViewer` 场景（真实 `pwr/src/ui/viewer.ts`，锚点自检 + 确定性），产物 `docs/assets/pwr-viewer.svg` 已挂进根 README pwr 节，测试 8 个锁定。仍缺：widget/亮块场景（宿主 footer/widget 层不在 pi-tui 内、需模拟宿主布局，待定）、`/workflow:list` 列表、以及"真机终端抓屏"这一最终形态的人工核验。）
- [x] AGENTS.md 瘦身重构：①删「重要文件」「架构与数据流」两章；②项目概览自「pwr/ — 主项目」起两大段删除（agent-team 细节经核对已被 docs/extensions/agent-team.md 卡完整覆盖，pwr 版本历史在 DELIVERY.md、数据流在 pwr 卡——无信息净丢失）；③关键目录删 pwr 全部条目与卫星扩展中 agent-team 清单，留指引行；④新增「规则红线（强制）」7 条，集中原仓库边界/todos 登记/worktree/命令超时/TDD/docs 卡同步/交付四处同步各散落强制项；⑤跨文件引用同步（incidents ×2、INDEX ×1 →「规则红线·条目名」）。188→122 行。（完成 @ 84636e8/merge 25d5d10，2026-09-10，用户直接指令；登记补录于收尾门）
