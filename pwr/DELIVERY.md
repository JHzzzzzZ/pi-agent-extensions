# DELIVERY — PWR 合并交付包 v2.3.0（JHL-18：/workflows:view 全屏运行查看器 + 脚本结构图）

> 在 v2.2.0 基础上新增 JHL-18「全屏运行状态查看器」：`/workflows:view [runId]` 以捕获式 overlay 打开全屏边框页——第一页是脚本结构树图（agent/pipeline/parallel 嵌套 + 实时状态叠加），随后每个运行时 stage 一页，末尾是最终结果页与脚本源码页。运行中每 800ms 拉取 `runtime.view()` 快照实时刷新；重启后 rehydrated 的 run 以纯 store 快照冻结可看。参考同工作区 agent-team 扩展的 `/team:view` 模式（手绘边框、Component 注入端口、纯函数 key reducer）。

## 本版变更（v2.3.0）

| 模块 | 变更 | 位置 |
| --- | --- | --- |
| 全屏查看器（新功能） | `ctx.ui.custom` 捕获式 overlay（居中 96% 宽、约 82% 终端高、╭─╮│╰─╯ 手绘边框）；页面序列「结构 → 每 stage 一页 → 结果 → 脚本」；按键 h/l/←→/Tab 翻页、j/k/↑↓ 滚动（follow 贴底）、g/G 首末、1-9 直达、`[`/`]` 多 run 切换、q/Esc 关闭；800ms setInterval(unref) 刷新 + render 每帧重载快照 | `src/ui/viewer.ts` |
| 脚本结构图（新功能） | `extractPlan` 增量构建结构树（span 包含关系：父 = 最小包含容器；扁平 stages 不变）；树形渲染 `├─ └─` + 状态图标（▶✓✗⊘⏸⋅）+ kind 徽标（pipeline ×N≈/✎write）+ 实时进度 n/m + ⚡cache；**按 label 精确关联** plan↔运行时 stage，synthesized 节点（未标注调用）只做静态展示、未匹配的运行时 stage 进「未标注/动态派发」尾部分组；容器状态由子节点 rollup（镜像 deriveStageStatus 优先级） | `src/plan.ts`、`src/types.ts`（PlanNode/WorkflowPlan.tree）、`src/ui/diagram.ts` |
| 查看器供数 | `MemoryRunStore.applyRuntimeView()`：全量合并 runtime 富视图（stages 状态/耗时/usage、tasks 摘要/attempt/错误/⚡cacheHit），totals 按 tasks **重算**（事件通道与 apply 路径不双计）；`UiRuntimeAdapter` 增加可选 `view()/list()` 端口（结构化满足，无运行时环）；runtime 不可用或 run 未知（重启后）退化为 store 快照 | `src/ui/run-store.ts`、`src/ui/types.ts` |
| cache 命中可见性 | `AgentTask.cacheHit` 标记：`recordCacheHit` 两个分支置 true（真实重派发时清除）；持久化 entry tasks 与 store 恢复均带该字段 | `runtime/types.ts`、`runtime/index.ts`、`src/ui/types.ts`、`src/ui/run-store.ts` |
| 命令与菜单 | `/workflows:view [runId]`（默认 lastViewed ?? 最近非终态 run；TUI/custom overlay 不可用时 notify 降级）；`/workflows` 详情菜单首项「View live (full-screen)」；help 文本与详情 Actions 补充条目 | `src/ui/index.ts`、`src/ui/commands.ts`、`src/ui/views.ts` |
| 测试（新增 24，共 380） | ui-diagram 7（树提取/合成 label/label 关联/rollup/平铺退化/渲染/未匹配桶）、ui-viewer 13（帧形状正则/页面装配/四类页面体/key reducer 全键/clamp）、ui-run-store +5（applyRuntimeView 合并与幂等/cacheHit 恢复/plan 暴露）、runtime cache 命中标记断言、entry 命令注册 | `tests/ui-*.test.ts`、`runtime/test/runtime.test.ts`、`test/entry.test.ts` |

## v2.2.0 之前版本

# DELIVERY — PWR 合并交付包 v2.2.0（三处用户反馈修复：默认模型 / 删除工作流 / 批准卡）

> 在 v2.1.1（JHL-14 PiAgentRunner 适配层）基础上修复三处用户反馈：① workflow 默认模型不可设置/不可见；② 保存的工作流无法删除；③ 运行停在 awaiting_approval 但批准窗口不出现。

## 本版变更（v2.2.0）

| 模块 | 变更 | 位置 |
| --- | --- | --- |
| 逐调用模型（新功能） | `agent(prompt, { model })` DSL 选项接线：解释器校验并透传 `AgentRunSpec.model`，runner 单点解析 `agent.model ?? spec.model ?? defaultModel`（定义钉 > 逐调用 > PWR 默认 > 子 pi 默认），`--model` 仅在非空时下发 | `engine/interpreter.ts`、`runner/index.ts` |
| 删除保存的工作流（新命令） | `deleteSavedWorkflow()`（项目范围优先、可信门控、用户范围兜底，镜像 load 解析）；新增错误码 `DELETE_IO_ERROR`；`/workflow-delete <name>` 命令；已注册命令在 `/reload` 前保留并报 `WORKFLOW_NOT_FOUND`（pi 无 unregisterCommand API，不实现） | `src/save.ts`、`src/errors.ts`、`index.ts` |
| 批准卡即时弹出（修复） | `tool_result` 钩子在 `workflow_validate` 成功后立即弹卡（per-run `approvalCards` map），决策（once/remember/reject）记录供 `workflow_start` 复用——agent 不调 `workflow_start` 也必有卡；`workflow_start` 钩子先等同一 pending 决策再兜底新卡；生成约束改为「校验后调用 workflow_start」 | `index.ts`、`src/constraints.ts` |
| 手动批准（新命令） | `/workflows:approve <runId>`：对 awaiting_approval 运行弹卡（已 remember/once 直接启动），Reject 取消、Esc 保持等待；帮助文本补充 approve/delete 条目 | `src/ui/commands.ts`、`src/ui/index.ts` |
| 文档 | README 新增命令章节（/pwr-model 用法与模型优先级、/workflow-delete、/workflows:approve） | `README.md` |
| 测试（新增 13） | runner 模型优先级（3 断言组）、解释器 model 透传/校验、删除 4 例、入口批准卡即时弹出、approve 命令 6 例；另将 runner「child args」与 discover「builtin scout」两例改为 hermetic（不再依赖本机真实 agent 发现） | `runner/test/`、`test/`、`tests/` |

## v2.1.1 审查修复内容（对应 Reviewer 2 Major + 1 Minor）

## 本版变更（v2.1.0）

> 在 v2.0.0 最终合并交付包（已通过 QA 端到端验收 11/11）基础上新增 **JHL-14「PiAgentRunner 适配层」**（PRD §5.4、§9 子任务 3），并完成接线：入口 session_start 自动构造适配器注入 Runtime。

| 模块 | 变更 | 位置 |
| --- | --- | --- |
| PiAgentRunner 适配层（新增） | 按 PRD 5.4 `run()` 契约实现子代理执行 | `runner/`（index/discover/pi/errors/types） |
| 技术验证（只读调研） | 本机 `subagent` 扩展 agent 定义与 child Pi 进程模式确认；PWR 自有契约隔离私有实现 | 见交付评论 |
| Runtime 接线 | 新增 `setRunner()` 注入点；`errorCodeOf` 识别 RunnerError；dispatch 透传脚本选择的 agent id | `runtime/index.ts` |
| 引擎增量 | `agent(prompt, { agent })` 可选 agent id，RunnerError 透传 | `engine/interpreter.ts` |
| 入口接线 | session_start 构造 PiAgentRunner；不可用时保持 `AGENT_RUNNER_UNAVAILABLE`（不隐式回退） | `index.ts` |
| 测试（新增 30） | mock spawn 单测 + Runtime 集成测试，无真实子进程 | `runner/test/` |

## 技术验证结论（只读调研，未改 subagent 源码）

1. **agent 定义**：`~/.pi/agent/agents/*.md`（YAML frontmatter：name/description/tools/model + 正文 system prompt）；subagent 用 `getAgentDir()`/`parseFrontmatter()`（pi-coding-agent 公开 API）。PWR 复刻同一位置与格式，并内置 scout/planner/reviewer/worker 四份默认定义兜底。
2. **child Pi 进程模式**：`pi --mode json -p --no-session [--model M] [--tools t] [--append-system-prompt <file>] Task: <task>`；stdout 逐行 JSON 事件（`message_end`/`tool_result_end`），usage 聚合（input/output/cacheRead/cacheWrite/cost.total/totalTokens），AbortSignal → SIGTERM → 5s SIGKILL。`pi --help` 实测确认参数存在。
3. **可用接口**：`pi` 命令可从 PATH 解析（`pi.ps1`/`pi.cmd` → `node .../pi-coding-agent/dist/cli.js`）。适配器完全自持实现，仅用 pi-coding-agent 公开 API，不 import subagent 代码。

## 适配器契约（PRD 5.4）

```ts
run({ runId?, agentId?, prompt, label?, tools: 'readonly'|'write', schema?, signal })
  → Promise<{ result, summary, usage?, events }>
```

- **未知 agent id 启动前失败**：`UNKNOWN_AGENT`（不创建子进程）；脚本 `agent(prompt, { agent: 'scout' })` 显式选择，缺省 `worker`
- **tools 映射**：readonly = read/grep/find/ls/glob；write = +bash/write/edit；与 agent 定义声明取交集
- **schema**：注入结构化输出指令；最终文本尽力解析 JSON（容忍 ```json 围栏），失败回退原文
- **截断**：result 50KB、summary 8KB（UTF-8 安全）；**usage 归一化**为数字计数；**events** 为脱敏流（无原始工具输出）
- **取消**：AbortSignal → SIGTERM → SIGKILL；`AGENT_ABORTED`
- **重启**：适配器无状态；attempt 审计与缓存失效由 Runtime 层负责（restart_agent），不覆盖历史
- **降级**：child 无法启动 → `AGENT_RUNNER_UNAVAILABLE`；脚本校验/查看/保存始终可用；绝不隐式回退主 agent

## 测试结果（本机 Node 22.23.1 / Windows PowerShell）

```
npm install && npm test
# tests 309
# pass 309
# fail 0

npm run typecheck   # tsc --noEmit（strict + erasableSyntaxOnly）：0 错误
```

组成：v2.0.0 基线 279 + runner 30（runner 单测 24 + discover 6 → 其中 pi/runner/discover 单测 26 + 集成 2 等，合计 30）。runner 测试全部基于 mock spawn 工厂（无真实子进程、无网络、无模型调用）。

覆盖点：UNKNOWN_AGENT 启动前失败（0 进程）、工具映射、schema 注入与 JSON 解析、50KB/8KB 截断、abort 前后置、退出码/stopReason 错误映射、spawn 失败降级、重启无状态（两次 run 独立）、事件脱敏、discover 三 scope 优先级与内置兜底、Runtime+适配器集成（成功完成、缓存回放不 spawn、终态 restart_agent 拒绝、运行中 restart 后重跑经适配器重执行且 attempt 保留）。

## 安装与部署（按 Tony Stark「先不安装」决议，仅文档说明）

1. 将 `pwr/` 的**运行必需部分**复制到 `C:\Users\<user>\.pi\agent\extensions\pwr\`（全局）或可信项目 `.pi/extensions/pwr/`：`index.ts` + `src/` + `engine/` + `runner/` + `runtime/` + `vendor/`（不含 `test/`、`tests/`、`tsconfig.json`、`package.json`、文档 —— 目录由 `index.ts` 自动发现，package.json 无 `pi.extensions` 清单时非必需；workspace 副本保持完整含测试）；
2. 重启 pi 或 `/reload`；
3. 使用：`/workflow <任务>` 生成 → 批准卡 → 后台运行（runner 自动注入，child pi 执行 agent）→ `/workflows` 查看/控制 → `/workflow:<name> <args>` 复用已保存命令；
4. 前置：本机 `pi` 命令可解析（PATH 含 pi），`~/.pi/agent/agents` 有 agent 定义（无则用内置 scout/planner/reviewer/worker）。

## 安全要点（历轮审查收敛 + 本版）

- 引擎：无 `node:vm`/`eval`/`Function`；单次快照；数组原型/索引/访问器检查。
- 参数：`ARGS_INVALID` 静态模板不回显；`argsSchema` 单次捕获；违例参数不创建运行。
- 持久化：entry 白名单（无 source/prompt/raw output/args/凭证）；usage 仅数字；摘要 8KB 截断。
- Runtime：状态机迁移强制合法；暂停/恢复竞态世代隔离；终态仅 view/save/run_again；1,000 agent 双保险；并发 ≤128。
- **Runner（本版）**：临时 system prompt 文件 0600 权限且用后即删；events 不含原始工具输出；错误信息截断且不泄露密钥；`pwr-tmp://` 标记只在进程内展开，不落盘。

## 密钥清单

无。本包不读取/存储任何密钥/凭证/环境变量；无 `.env`。运行时使用用户既有的 pi 凭据（auth.json 由 pi 宿主管理，本包不触碰）。


## v2.1.1 审查修复内容（对应 Reviewer 2 Major + 1 Minor）

### Major 1 — schema 结构化结果 50KB 截断绕过（
unner/index.ts）

- 原实现 50KB 上限仅对字符串 result 生效；声明 schema 后超大 JSON 被解析为对象/数组原样返回并进入 Runtime 缓存。
- 修复：结构化结果解析后**序列化统一字节预算**——JSON.stringify 后字节数超过 MAX_RESULT_BYTES（50KB）即以受控错误 **RESULT_TOO_LARGE**（新增 RunnerErrorCodes）拒绝，绝不进入缓存；文本结果仍按 50KB 截断。
- 回归测试：schema 数组 >50KB、schema 对象 >50KB 均返回 RESULT_TOO_LARGE；预算内结构化结果正常保留。

### Major 2 — agent 发现优先级错误（
unner/discover.ts、index.ts）

- 根因 1：生产注入恒为 gentScope: "user"，项目 .pi/agents 从未纳入发现。
- 根因 2：discoverAgentsFrom "both" 分支先写 user 再写 project，同名的 project 覆盖 user，与声明 user > project > builtin 相反。
- 修复：
  - **发现写入顺序**：project 先写、user 后写覆盖 → 重名时 **user 胜出**（user > project > builtin）。
  - **生产策略接线**：入口 
esolveAgentRunner(projectTrusted) 显式传 { agentScope: projectTrusted ? "both" : "user" }——**受信任项目纳入项目定义（both），未受信任项目仅 user + builtin（与 JHL-17 项目工作流加载门禁一致）**。
  - 回归测试：新增同名的 user/project shared 定义，断言 both 范围下 shared.source === "user"（user 胜出）；project-only scout 仍胜过 builtin。

### Minor — Abort SIGKILL 定时器泄漏（
unner/pi.ts）

- 原实现 5s SIGKILL 定时器在子进程 close 后未取消、abort listener 未移除，计时器保留到超时且可能对旧 child 发信号（违反 PRD §7 清理要求）。
- 修复：保存 timer + listener，**close/finally 中 clearTimeout + 
emoveEventListener**（幂等）；导出 KILL_GRACE_MS。
- 回归测试（node:test mock timers）：abort → SIGTERM → 立即 close → 拨过宽限期断言 **SIGKILL 从未触发**，且再次 abort 无任何 kill（listener 已移除）。
