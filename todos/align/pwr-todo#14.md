# pwr-todo#14 pwr 工具面升级到 pi 1.0 契约

## 意图

codemode 打开后，pwr 的 4 个 `workflow_*` 工具**全部变成脚本可调**（`exposure` 默认 `direct` = active 时别人也能调）。其中两个有明确危害：

1. `workflow_validate` 会在 tool_result 上**弹批准卡**——脚本调进去会卡在等人批准上（脚本没有 UI，用户可能根本没在看）。
2. `workflow_start` **起子 pi 进程**——从脚本里发起等于产生无人监管的 run，而 pwr 的批准门（digest 键控）本来假设调用者是主 agent。

同时脚本调工具**拿到的是文本**：`details` 是内部结构，对 codemode 脚本不可见（pi 文档：「Tools without `outputSchema` are passed to scripts as their text content」）。这等于 pwr 的运行态对脚本永远不可读。

本条目把 pwr 工具面升级到 pi 1.0 契约：分层 `exposure` + 查询口径的 `outputSchema`。

## 范围

**做什么**

1. **exposure 分级**（4 个工具全部 `model-only`）：
   - `workflow_validate` / `workflow_start` / `workflow_control` / `workflow_save` → `exposure: "model-only"`
   - 理由：全部是编排型（起进程 / 写盘 / 弹卡）。`model-only` 的语义是「声明给模型，永不从其它工具调用」，正是这个场景。
2. **`outputSchema` + `structuredContent`**：仅给**查询口径**的结果设计**稳定契约**（不镜像内部 `details`）：
   - `workflow_control` 的 `list` 动作 → `{ runs: [{ runId, status, stage, startedAt, finishedAt? }] }`
   - `workflow_control` 的 `status`/`pause`/`resume`/`stop`/`restart` 结果 → `{ runId, ok, status }`
   - `workflow_validate` / `workflow_start` / `workflow_save` → 结构化结果随本条一并给出（脚本不可调，但 `details` 语义边界仍应明确）
   - `details` **保持内部结构**，继续作为渲染/状态重建来源，不进契约。
3. **annotations**（`general-todo#21` 的 pwr 部分）：`workflow_validate` = `readOnlyHint`；其余三个 = `destructiveHint`；`workflow_start` 另加 `openWorldHint`（派出去的 agent 会碰世界）。
4. **namespace**（`general-todo#20` 的 pwr 部分）：4 个工具归入 `namespace: { name: "pwr", description: "Pi Workflow Runtime 工作流编排" }`。

**不做什么**

- 不改 DSL / `engine/spec.ts` / `SCRIPT_VERSION`（本条目不碰脚本语义）
- 不改批准门语义（digest 键控、solo 门契约均不动）
- 不改命令面（`/workflow:*` 15 条不变）
- 不动 runner / runtime / UI

## 验收标准

1. `cd src/extensions/pwr && npm test` 全绿（现有 443 个 + 本条新增），`npm run typecheck` 零错误。
2. 4 个工具的 `exposure` 均为 `model-only`；测试断言 `pi.getAllTools()` 里读得到。
3. `outputSchema` 存在且 `structuredContent` 与之匹配；**脚本路径实测**：codemode 里 `tools.workflow_control({action:"list"})` 返回结构化数组（不是文本）。
4. `annotations` 与 `namespace` 逐条可读。
5. 既有 `details` 消费方（UI 渲染、状态重建）零回归。
6. 仓库级：`npm run test:all` 本套件绿（pwr 标 serial，独占运行）。
7. 文档同步：`docs/extensions/pwr.md` 卡 + `src/extensions/pwr/DELIVERY.md` 版本历史 + 根 README 测试数。

## 人工确认

用户 2026-10-04 本会话确认：

- **Q1 `outputSchema` 契约形态** → 选项 **2**：只给查询型工具新设计**稳定契约**，`details` 保持内部结构，不镜像。
- **Q2 exposure 清单** → 通过（`workflow_validate`/`start`/`control`/`save` → `model-only`）。
- **Q5 并行与合并** → 并行开 worktree；`general-todo#21`（annotations）与 `general-todo#20`（namespace）**并入本条一起改**（同一批 `registerTool` 调用，分两次做会重复碰同一文件）。这两条 general 条目在三个扩展 worktree 全部合并后统一收口。
- 背景事实：pi 1.0.0 typings 已核实 `exposure` / `outputSchema` / `annotations` / `namespace` 四个字段均存在于工具定义。
- **Q6（2026-10-04 评审 P2-2 改判）验收 #2 / #3 的实测口径** → 原文两条在「范围第 1 条：4 个工具全部 `model-only`」前提下不可执行，按主会话决定调整，验收请按调整后的口径对：
  - 验收 #3 原要求「脚本路径实测 `tools.workflow_control({action:"list"})` 返回结构化数组」，与范围第 1 条自相矛盾——`model-only` 的语义就是「声明给模型、永不从其它工具可调」，codemode 脚本根本调不到这 4 个工具，这条脚本路径不存在。改为**单元级实测**：直接调工具的 `execute`（`workflow_control` 的 `list`/`status`/控制动作 + `workflow_validate`/`start`/`save`），断言 `structuredContent` 与 `outputSchema` 一致（TypeBox `Value.Check`）。
  - 验收 #2 原要求「测试断言 `pi.getAllTools()` 里读得到」同理在单测里无法发生（没有运行的宿主会话）；改为断言**捕获到的 `registerTool` 注册定义**——宿主 `getAllTools()` 报告的正是这份定义字段（`agent-session` 透传），两者等价；同时用该断言覆盖「4 个工具 `exposure === "model-only"`」。
  - 原因：原验收步骤在 model-only 前提下不可执行，不补记会导致验收时对不上；「脚本读不到 pwr 运行态」这一缺口已如实记录在 `docs/extensions/pwr.md` 卡与 `DELIVERY.md`。
