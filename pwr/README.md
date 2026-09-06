# PWR - Pi Workflow Runtime（JHL-14：PiAgentRunner 适配层）

PWR 是 Pi 的本地工作流编排扩展。本目录对应 JHL-14 子任务（P0，Stage 3）：**PiAgentRunner 适配层**（PRD §5.4、§9 子任务 3），并内含全部既有模块。

> 版本：**v2.2.0**（2026-08-06，在 v2.1.1 上修复三处用户反馈：workflow 默认模型、保存命令删除、批准卡缺失）
>
> 依赖说明：本包是 JHL-16 交付（`src/` 触发/批准层）的延续，内置 JHL-12 引擎 v1.1.2（`engine/` + `vendor/`，单次快照安全边界已收敛）。Runtime 未注入 runner 时，保存/加载/参数校验/批准全部可用，仅实际启动返回 `AGENT_RUNNER_UNAVAILABLE`（不隐式回退）。JHL-14 起入口在 session_start 自动构造 PiAgentRunner 注入 runtime。

## 功能

### 子代理执行（JHL-14 PiAgentRunner，`runner/`）
- 按 PRD 5.4 `run()` 契约实现：`{ runId, agentId, prompt, label?, tools, schema?, signal } → { result, summary, usage?, events }`
- **复用本机 `subagent` 扩展的模式**：child `pi --mode json -p --no-session` 进程 + `~/.pi/agent/agents/*.md` agent 定义发现（仅用 pi-coding-agent 公开 API，不耦合 subagent 私有实现）
- **未知 agent id 启动前失败**（`UNKNOWN_AGENT`，不创建子进程）；脚本可用 `agent(prompt, { agent: 'scout' })` 显式选择，缺省用 `worker`
- `tools: 'readonly'` 剥离写工具（bash/write/edit），`write` 保留；与 agent 定义声明取交集
- `schema` 注入结构化输出指令，最终文本尽力解析为 JSON（容忍 ```json 围栏）
- 结果 50KB / 摘要 8KB 截断；usage 归一化为数字计数；events 为脱敏事件流（不含原始工具输出）
- AbortSignal → SIGTERM → 5s 后 SIGKILL；适配器无状态，重启/attempt 审计由 Runtime 负责
- 降级：child 无法启动 → `AGENT_RUNNER_UNAVAILABLE`，绝不隐式回退主 agent

## 功能

### 保存（`workflow_save`）
- 参数 `{ runId, scope: 'user'|'project', name, overwrite? }`
- **自动补齐 `meta.name/description/version`**（已有值保留；引擎占位名 `untitled` 视为缺失，用命令名补齐），重写脚本的 meta 块后**强制重新过引擎校验**，通过才落盘
- 保存位置：
  - 用户范围：`~/.pi/agent/workflows/<name>.js`（当前用户全部项目）
  - 项目范围：`<项目>/.pi/workflows/<name>.js`（**仅可信项目**；未受信任返回 `PROJECT_NOT_TRUSTED` 且不写入）
- 同名冲突：目标文件已存在且未传 `overwrite: true` → `NAME_CONFLICT`；显式确认后可覆盖
- 保存成功后注册 `/workflow:<name>` 命令；**会话启动时扫描两个目录重新注册**，重启后命令仍可用

### 加载与参数（`/workflow:<name> <args>`）
- 加载顺序：项目脚本优先于同名全局脚本（可信项目）；未受信任项目跳过项目目录、回退全局
- 参数解析：空参数 → `args` 为 `undefined`；非空参数必须是合法 JSON（对象/数组/标量），否则 `ARGS_INVALID` 且**不启动**
- 脚本通过 `meta.argsSchema` 声明参数 schema（JSON-schema 子集：type/properties/required/items/enum/min/max），非法参数返回 `ARGS_SCHEMA_VIOLATION` 且**不创建运行**
- 每次调用都会重新加载文件并重新校验（文件被改动后不再通过校验则拒绝运行）

### 批准记忆（复用 JHL-16 ApprovalStore）
- 批准键 = **项目 canonical path + script digest**；保存命令的启动同样走该记忆
- 已记住的脚本被编辑（digest 变化）→ 再次调用 `/workflow:<name>` 时**必须重新批准**（重新展示批准卡），批准记录以新 digest 落库

### 覆盖确认（`NAME_CONFLICT` 处理）
- 重名保存返回 `NAME_CONFLICT`（不覆盖任何现有文件）；工具契约新增可选 `overwrite: boolean`，确认后替换

### 结果回传（主 agent 自动唤起）
- 运行 settle（**成功或失败**）后自动唤起主 agent 汇报结果：以 `pwr-workflow-result` 消息（`triggerTurn: true` + `deliverAs: "followUp"`）发回主会话，与 `/workflow` 生成路径同一语义 —— 空闲时直接开新 turn，流式中排队、当前 turn 结束后排空成新 turn
- 成功：回传最终 `return` 摘要（8KB 截断）；失败：回传错误码 + 错误信息（错误信息已限 8KB，不截断）
- 用户主动取消（`cancelled`）**不唤起**主 agent（避免噪音，UI 已 notify）
- 投递严格按 runId 隔离：一次 settle 一次投递，restart 后的新 settle 是合法的新投递

## 命令

### 工作流默认模型（`/pwr-model`）
- `/pwr-model`（无参数）显示当前配置：`auto (follow main session)` / 固定模型 id / 生效模型
- `/pwr-model auto`：跟随主会话当前模型（`model_select` 事件实时同步，运行中切换也生效）
- `/pwr-model <model-id>`：固定模型 id（需是子 pi 可解析的 id，见 `pi --list-models`）
- **模型优先级**：agent 定义 frontmatter 的 `model:` > 脚本 `agent(..., { model })` 逐调用覆盖 > `/pwr-model` 默认 > 子 pi 自身配置（settings.json）
- 内置 scout/planner/reviewer/worker 定义了 model 钉住（claude-haiku-4-5 / claude-sonnet-4-5），故默认模型对它们不生效；用户自己的 agent 无 model frontmatter 时默认模型生效

### 删除保存的工作流（`/workflow-delete <name>`）
- 删除顺序与加载一致：项目范围文件优先（仅可信项目），否则用户范围；返回 `Deleted workflow "<name>" (project|user scope)`
- 文件不存在或名字非法 → `WORKFLOW_NOT_FOUND`；文件系统错误 → `DELETE_IO_ERROR`
- 已注册的 `/workflow:<name>` 命令在 `/reload` 前仍保留，调用时报告 `WORKFLOW_NOT_FOUND`（pi 无 unregisterCommand API）

### 手动批准（`/workflows:approve <runId>`）
- 对停在 `awaiting_approval` 的运行重新展示批准卡；Run once / Remember 后启动该运行
- 已 remember 或已 once 批准的直接启动（不再弹卡）；Reject 取消运行；Esc 保持等待
- 批准卡在 `workflow_validate` 成功后立即弹出（无需等 agent 调用 `workflow_start`）；生成约束已指示 agent 校验后调用 `workflow_start { runId, approval: 'once' }`

### 全屏运行查看器（`/workflows:view [runId]`）
- 以全屏边框页（捕获式 overlay，约 82% 终端高度）实时查看一个流程的运行状态；不传 runId 时默认查看最近查看过 / 最近活跃的运行
- **第一页「结构」是脚本结构图**：`agent / pipeline / parallel` 调用树（├─ └─ 连接符）+ 每个节点实时状态（▶ 运行 ✓ 完成 ✗ 失败 ⊘ 排队 ⋅ 未开始）+ 进度 `n/m` + 耗时/tokens；带 `label` 的调用与运行时 stage 精确关联，未标注调用静态展示、其实际派发进「未标注/动态派发」分组
- 之后**每个 stage 一页**：任务表（状态 · taskId · attempt · ⚡cache 命中 · tokens · 耗时 · 错误码）+ 失败详情 + 最近结果摘要；末两页为**最终结果**与**脚本源码**（只读；历史会话的 run 不保留源码）
- 按键：`←→/h/l/Tab` 翻页 · `↑↓/j/k` 滚动（贴底自动跟随）· `g/G` 首末 · `1-9` 直达页 · `[ ]` 切换 run · `q/Esc` 关闭
- 运行中每 800ms 拉取 runtime 快照实时刷新；运行结束或重启后仍可查看（冻结快照；重启后的 run 只有元数据，结构图退化为 stage 平铺）

## 目录结构

```
pwr/
├── index.ts               # 扩展入口：命令/事件/工具注册、批准卡 UI 钩子、持久化、保存命令注册、runner 注入
├── engine/                # JHL-12 脚本引擎（validator/parser/spec/plain/...，v1.1.2）
├── vendor/                # acorn 8.18.0（MIT，引擎解析用，零运行时依赖）
├── runner/                # JHL-14 PiAgentRunner 适配层（新增）
│   ├── index.ts           # PiAgentRunner（run() 契约、tools/schema/截断/usage/events、UNKNOWN_AGENT 启动前失败）
│   ├── discover.ts        # agent 发现（user/project scope + 内置 scout/planner/reviewer/worker 兜底）
│   ├── pi.ts              # child pi 进程封装（JSON 事件流、usage 聚合、abort SIGTERM→SIGKILL、临时 system prompt）
│   ├── errors.ts          # RunnerError + 错误码（UNKNOWN_AGENT/AGENT_RUNNER_UNAVAILABLE/AGENT_EXECUTION_ERROR/AGENT_ABORTED）
│   ├── types.ts           # AgentDefinition/RunnerUsage/AgentEvent/工具白名单
│   └── test/              # JHL-14 单测（37 个：mock spawn，无真实进程）
├── runtime/               # JHL-13 Runtime（state/scheduler/cache/persist/index；setRunner 注入点）
├── src/
│   ├── approval.ts        # 批准存储（记住/同一项目 canonical path+digest/APPROVAL_STALE）
│   ├── args.ts            # JHL-17：参数解析（JSON）与 JSON-schema 子集校验
│   ├── constraints.ts     # 脚本生成约束注入文本
│   ├── digest.ts          # SHA-256 digest（CRLF 归一化）
│   ├── engine.ts          # JHL-12 引擎适配器（validateScript + 位置/astVersion 映射；保留 argsSchema）
│   ├── errors.ts          # 错误码 + PwrError + { code, message, ... } 契约（新增 ARGS_INVALID/ARGS_SCHEMA_VIOLATION/WORKFLOW_NOT_FOUND）
│   ├── flow.ts            # workflow_validate/start/control/save 纯逻辑 + RunRegistry（create 支持 args）
│   ├── intent.ts          # /workflow 与 workflow: 前缀解析
│   ├── notify.ts          # 按 runId 隔离的结果回传（RunNotifier；成功/失败 settle 后 followUp 唤起主 agent）
│   ├── plan.ts            # AST 调用节点阶段聚合/预算/写入风险 + 结构树（JHL-18）
│   ├── save.ts            # JHL-17：保存/加载/命令注册扫描/调用编排（saveWorkflowCommand/loadSavedWorkflow/invokeSavedWorkflow）
│   ├── tools.ts           # Pi 工具定义（workflow_save 增加 overwrite 参数）
│   ├── types.ts           # 共享契约类型与常量（WorkflowMeta.argsSchema）
│   └── ui/                # JHL-15/JHL-18 宿主无关 UI 层
│       ├── index.ts       # /workflows* 命令、快捷键、widget/entry renderer 接线（含 /workflows:view）
│       ├── run-store.ts   # MemoryRunStore（事件 reducer + applyRuntimeView 快照合并）
│       ├── views.ts       # 纯文本视图（列表/详情/卡片）
│       ├── diagram.ts     # 脚本结构图（label 关联 + 容器 rollup + 树形渲染）
│       ├── viewer.ts      # /workflows:view 全屏查看器（Component 注入端口 + 纯函数渲染/按键）
│       └── text.ts        # ANSI/CJK 宽度辅助（边框精确填充）
├── test/                  # 引擎/入口契约单测（100 个）+ helpers/perf 门禁
└── tests/                 # 流程/引擎/UI 套件单测（189 个用例）
```

## 运行单测（Windows PowerShell）

```powershell
cd pwr
npm install        # 仅开发依赖（typescript、@types/node、typebox、pi 宿主类型）
npm test           # 380 个单测（test/ 100 + tests/ 189 + runtime/test/ 54 + runner/test/ 37）
npm run typecheck  # tsc --noEmit（strict）
```

要求：Node.js ≥ 22.18（原生 TS type-stripping，无需构建）。

## 使用示例

```text
# 保存：主 agent 完成 workflow_validate 后调用工具
workflow_save { runId, scope: 'user', name: 'audit-routes' }
→ Saved as /workflow:audit-routes (user)

# 调用（args 为 JSON；脚本内以 args 全局读取）
/workflow:audit-routes {"files": ["src/routes"], "depth": 2}

# 重名保存需确认
workflow_save { runId, scope: 'project', name: 'audit-routes' }   # NAME_CONFLICT
workflow_save { runId, scope: 'project', name: 'audit-routes', overwrite: true }
```

脚本内声明参数 schema（引擎白名单值，随 meta 校验）：

```js
export const meta = {
  name: 'audit-routes',
  description: '审查路由鉴权',
  version: 1,
  argsSchema: {
    type: 'object',
    required: ['files'],
    properties: { files: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  },
};
```

## 安全边界

- 脚本本身无 FS/shell/network/process 直连（JHL-12 引擎白名单执行，单次快照边界）
- 保存前强制引擎校验（引擎不可用 → `ENGINE_UNAVAILABLE`，不保存）；调用时重新加载并重新校验
- 项目范围保存/加载受信任门控；错误信息为静态模板，不泄露文件内容/密钥
- 批准记忆 = 项目 canonical path + digest；脚本修改后必须重新批准
- 会话 entry 只持久化运行元数据（不写脚本源码、args 原文、凭证）

## 集成接口（供 JHL-13/14/15 对齐）

| 接口 | 位置 | 说明 |
| --- | --- | --- |
| `SaveAdapter.save({ runId, scope, name, overwrite? })` | `src/flow.ts` | 由 index.ts 接 `saveWorkflowCommand`（自动补齐 meta + 校验 + 注册命令） |
| `invokeSavedWorkflow(deps, { name, rawArgs }, approve)` | `src/save.ts` | `/workflow:<name>` 调用编排；approve 回调由 index.ts 接批准卡 |
| `listSavedWorkflows(deps)` | `src/save.ts` | session_start 扫描注册命令 |
| `RuntimeAdapter.start({ runId, script, args?, onFinalResult })` | `src/types.ts` | args 经 run 传入解释器 `args` 全局 |
| `ApprovalStore`（canonical path + digest） | `src/approval.ts` | 保存命令复用同一批准记忆 |


