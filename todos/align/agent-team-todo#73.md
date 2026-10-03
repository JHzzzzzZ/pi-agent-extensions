# agent-team-todo#73 agent-team 工具面升级到 pi 1.0 契约

## 意图

codemode 打开后，agent-team 的 9 个工具**全部变成脚本可调**（`exposure` 默认 `direct`）。其中两类有明确危害：

1. **`team_ask` 会阻塞等人回答**——它把 leader 的问题转发到主会话弹对话框并等待（`AskChannel` + 超时 backstop，默认 10 分钟）。脚本调进去：对话框可能盖在 codemode 结果之上、用户看不到，脚本则卡满整个超时窗口。
2. **`team_run` / `team_resume` 起 leader 子进程**——从脚本里派单等于产生无人监管的后台 run；`team_stop` 杀进程、`team_create` 写团队文件同理。

同时脚本调工具**拿到的是文本**：`details`（run 列表、预算、成员状态）对 codemode 脚本不可见。agent-team 的 run 状态是最适合被脚本聚合的数据——现在聚合不了。

本条目把 agent-team 工具面升级到 pi 1.0 契约。

## 范围

**做什么**

1. **exposure 分级**：
   - `team_ask` / `team_run` / `team_resume` / `team_stop` / `team_create` / `team_dispatch` → `exposure: "model-only"`
     - `team_ask` 的理由是**阻塞**（annotations 没有阻塞语义，`model-only` 是唯一可用的护栏，见下文缺口）
     - 其余是编排型（起子进程 / 杀进程 / 写盘）
   - `team_status` / `team_list` / `team_transcript` / `team_models` → 保持 `direct`（脚本可调，这正是 outputSchema 的用途）
2. **`outputSchema` + `structuredContent`**：只给查询型的**稳定契约**（不镜像内部 `details`）：
   - `team_status`（单 run）→ `{ runId, team, status, startedAt, elapsedMs?, parentRunId?, members: [{ name, status, warning? }], budget?: {…} }`
   - `team_status`（无 runId 汇总）→ `{ active: [...], recent: [...] }`
   - `team_list` → `{ teams: [{ name, source, members, leader? }] }`
   - `team_transcript` → `{ actor, lines: [...] }`（截断口径与现在一致）
   - `team_models` → `{ models: [{ provider, id, name }] }`
   - `details` **保持内部结构**（viewer/widget/status 渲染与状态重建照旧）。
3. **annotations**（`general-todo#21` 的 agent-team 部分）：`team_status`/`list`/`transcript`/`models` = `readOnlyHint`；`team_stop`/`team_create` = `destructiveHint`；`team_run`/`team_resume`/`team_dispatch` = `destructiveHint` + `openWorldHint`（派出去的 agent 会碰世界）；`team_ask` 无副作用标注（阻塞语义缺失，已在缺口登记）。
4. **namespace**（`general-todo#20` 的 agent-team 部分）：9 个工具归入 `namespace: { name: "agent-team", description: "多 agent 团队派单与查询" }`。

**不做什么**

- 不改 run 生命周期 / 预算 / worktree / 终态判定（ADR-0006 等全部不动）
- 不改命令面（`/team:*` 不变）
- 不改 viewer / widget / askview 的渲染与键位
- 不引入 `ctx.executeTool`（成员是子进程，不走同进程工具管线）

## 验收标准

1. `cd src/extensions/agent-team && npm test` 全绿（现有 719 个 + 本条新增），`npm run typecheck` 零错误。
2. `team_ask` / `team_run` / `team_resume` / `team_stop` / `team_create` / `team_dispatch` 的 `exposure` 为 `model-only`；查询型四个保持 `direct`，测试断言 `pi.getAllTools()` 可读。
3. 查询型工具的 `outputSchema` 存在且 `structuredContent` 匹配；**脚本路径实测**：codemode 里 `tools.team_status({})` 返回结构化对象。
4. `annotations` 与 `namespace` 逐条可读。
5. 既有 `details` 消费方（viewer / widget / `/team:status` / doctor）零回归。
6. 仓库级：`npm run test:all` 本套件绿。
7. 文档同步：`docs/extensions/agent-team.md` 卡 + 根 README 测试数 + `docs/tui-sync.md`（若涉及展示口径变化，预期不涉及）。

## 人工确认

用户 2026-10-04 本会话确认：

- **Q1 `outputSchema` 契约形态** → 选项 **2**：只给查询型工具新设计**稳定契约**，`details` 保持内部结构。
- **Q2 exposure 清单** → 通过。`team_create` 按建议给 `model-only`（写盘类），用户未提出异议。
- **已知缺口**：`ToolAnnotations` 没有「阻塞」字段，`team_ask` 的等人语义只能靠 `exposure: "model-only"` 兜——已在 `general-todo#21` 记录。
- **Q5 并行与合并** → 并行开 worktree；`general-todo#21`（annotations）与 `general-todo#20`（namespace）**并入本条一起改**，这两条 general 条目在三个扩展 worktree 全部合并后统一收口。
