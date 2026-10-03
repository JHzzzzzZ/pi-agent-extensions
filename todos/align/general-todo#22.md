# general-todo#22 虚拟模型路由

## 意图

pi 1.0 提供 `pi.registerVirtualModel()`：注册一个**可选中的目录条目**，每次请求由 router 挑一个物理模型。用户只选一个模型（`/model`、`--model`、scoped models 都照常），路由在底下发生。

对本仓库的价值：**模型选择从"一次决定用到底"变成"按请求决定"**。目前用户只能靠 agent-team 的 `team_resume` 模型覆盖、或手工切 `/model`，粒度是"一次 run"或"整个会话"。

已核实的 API 事实（pi 1.0.0 typings）：

- `route(request, ctx)` 收到 `{ model, thinkingLevel, reason, previous?, failed?, state?, messages, signal }`
- `reason` 是 `"user" | "continuation" | "retry" | "direct"` —— **免费且强的信号**：`retry` 时还带 `failed.message`（含 `stopReason` / `errorMessage`）
- 返回 `{ model, thinkingLevel, state? }`；`state` 必须 JSON 可序列化，经 `pi.virtual-model-state` 条目**随会话分支持久化**（`/tree` 各分支各存各的）
- 会话恢复时从最新 `model_change` 条目恢复虚拟选择；虚拟模型消失则回退到上次答过的物理模型
- footer 显示 `auto • high → gpt-5.6-luna • medium`；`/session` 按物理模型列成本

## 范围

**做什么**

1. **路由策略：先做纯规则版（选项 1）**
   - `reason === "user"` → 强模型（可配）
   - `reason === "continuation"` → 便宜/快模型
   - `reason === "retry"` → **升级**到更强档位（或按 `failed.message.stopReason` 区分：context overflow → 换长上下文模型；其它 → 升档）
   - `reason === "direct"` → 固定用一个（compaction summary / 扩展调用，不该被路由策略影响）
   - 零 LLM 成本、零额外延迟、完全确定性——这是打底版本
2. **注册在用户已有凭据的 provider 下**（关键实现约束）
   - `ModelRegistry.hasConfiguredAuth(model)` 的实现是 `runtime.hasConfiguredAuth(model.provider)` —— **查的是 provider，不是 model**
   - 注册到无凭据的新 provider（如 `router/auto`）会让 agent-team 的 `preflight.ts` 吃 "找到但无鉴权" warning（不硬失败，但噪音）
   - 因此注册在 `opencode-go`（用户默认 provider，凭据已在 `auth.json`）之下，例如 `opencode-go/auto`
3. **检测虚拟模型只能用 `model.api === "pi-virtual"`**
   - `isVirtualModel` 与 `VIRTUAL_MODEL_API` **未从包根导出**（index.d.ts 只导出 `ModelRoute`/`ModelRouteReason`/`ModelRouteRequest`/`VirtualModelDefinition`/`VirtualModelStateData`/`VIRTUAL_MODEL_STATE_ENTRY`）
   - 硬编码字面量 + 注释说明来源；这是上游导出缺口，值得在上游 issue 稿里记一笔（仓库已有 `docs/pi-*.md` issue 稿先例）
4. **落点**：新扩展目录 `src/extensions/<名>/`（与其余 13 个扩展同形态、可单独开关）——具体名与是否新建，在实现前由本期对齐确认。**不并进 goal/agent-team**，因为它是横切的模型选择层。
5. **与 Jev 族的关系（选项 2，本次只评估不实现）**：`reason` 纯规则之上可以叠 Jev 分类（任务难度/类型）。评审判据：每请求多一次 classifier 调用的成本与延迟是否换得回路由质量。评估结论写进本条 notes，需要实现则另立条目。

**不做什么**

- **不在本期实现 Jev 增强版**（选项 2）：先验证纯规则版是否有用
- 不改 goal 的评估器调用路径（**那是 `goal-todo#10`，且它是本条的硬前置**——虚拟模型上线前 `goal` 必须先在 `pi-virtual` 下能工作，否则目标循环会静默卡住）
- 不改 agent-team 的模型预检语义（只要注册在已有凭据 provider 下就零改动）
- 不改 pwr 的 `--model` 透传（子 pi 进程会各自加载扩展，虚拟模型在子进程里同样可解析——待实测确认）

## 验收标准

1. **硬前置**：`goal-todo#10` 已 `done`（虚拟模型下评估器可用）。未满足不得开工——否则上线即产生"目标循环静默卡住"的新故障。
2. 虚拟模型出现在 `/model` 可选列表，`/model` 选它后 footer 显示 `选中 → 物理` 的对应关系。
3. **路由实测**：一次会话里观察到至少两类物理模型被实际使用（例如首轮用强模型、后续 continuation 用便宜模型），并可在 `/session` 里看到按物理模型分列的成本。
4. **`retry` 路径实测**：构造一次失败重试，确认 router 收到 `reason: "retry"` 且 `failed.message` 可用（这条最容易写错，必须有真机证据）。
5. **`direct` 路径不被打乱**：compaction summary 等 `direct` 请求路由到固定模型。
6. **恢复语义**：`/resume` 后虚拟选择从最新 `model_change` 恢复；`/tree` 切分支后 `state` 各自独立。
7. **agent-team 兼容**：`team_run` 用该虚拟模型时 `preflight` 不产生 "无鉴权" warning（验证"注册在已有凭据 provider 下"这一约束确实成立）。
8. 新扩展的常规交付面：README + `docs/extensions/<名>.md` 卡 + `docs/INDEX.md` 登记 + 根 `package.json` `pi.extensions` + `tools/install-smoke.mjs` 期望表 + `tools/test-all.mjs` 套件表 + 根 README 测试数（红线 7 的四处同步）。
9. 仓库级 `npm run test:all` 全绿 + 新扩展 typecheck 零错误。

## 人工确认

用户 2026-10-04 本会话确认：

- **Q3 路由策略** → **选项 1（按 `reason` 纯规则）打底 + 选项 2（Jev 分类）作可选增强**。用户对推荐「没问题」。
- **注册位置约束**（用户已有凭据的 provider 下，避免 agent-team preflight warning）由提出方给出，用户未提出异议。
- **检测手段**（`model.api === "pi-virtual"`）：因上游未导出 `isVirtualModel`，只能硬编码；已记录为上游导出缺口。
- 本条登记为 **p5**；**与 `agent-team-todo#71`（派单路由）、`goal-todo#8`（评估器换 Jev）同族**——三者都涉及"用分类器改善决策"，实现顺序需协调。
- **Q5**：并行开 worktree + subagent 实现，主会话仅追踪；本条 worktree 完成后派 subagent 做 code-review（**不同模型**）。
