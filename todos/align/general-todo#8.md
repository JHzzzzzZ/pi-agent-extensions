# general-todo#8 团队运行工作空间约定（repo-dev）

> 领取：2026-09-15（本会话）· 对齐访谈：2026-09-15 grill-with-docs

## 意图

repo-dev 团队流程（SE→Writer×N→Reviewer→QA）要跑起来，各 run 的留档需要统一结构，避免每单自行其是、事后无法追溯。

## 范围

口径来自访谈 Q8 / Q9。

1. **目录约定**：`history/team-runs/<runId>/` 下七份文档——`00-task` / `10-design` / `20-writer-N` / `30-integration` / `40-review` / `50-acceptance` / `90-run-report`；单作者、头部元数据（runId / 日期 / 参与成员）、定稿后只追加不改写。
2. **落点确认（Q8）**：`history/` 已 gitignored（`.gitignore:9`），run 留档不入库；未来是否恢复入库属于 agent-team-todo#62（归档跨机迁移策略），本单不解决。
3. **文档化**：AGENTS.md「关键目录」与根 README 各补一行说明（七文档命名 + 「定稿只追加」约束）。
4. **首单走通（Q9，用户指定）**：首单 = todo-cli-todo#16（统一全局 id）——repo-dev 团队走完整流程并按本约定在 `history/team-runs/<runId>/` 留齐七文档，以此验证约定可用；todo-cli-todo#15 作第二单验证可复用。

明确不做什么：

- 不做调度器自动生成文档骨架（工具化留待第二个真实案例，rule of three）；不解决 #62 的入库策略；不改 agent-team 扩展代码。

## 验收标准

1. 约定文档化：AGENTS.md + 根 README 各一行，含七文档清单与约束。
2. #16 首单 run 留齐七份文档，头部元数据齐全，全程「定稿后只追加」。
3. `npm run test:all` 全绿（文档改动不破契约自检）。

## 人工确认

确认人：用户 · 日期：2026-09-15 · 方式：本会话 grill-with-docs——Q8 确认 `history/team-runs/<runId>/` 不入库；Q9 用户改指新登记的 todo-cli-todo#16 作首单（替代原推荐的 #15）。用户答复「当前没问题」终确认。
