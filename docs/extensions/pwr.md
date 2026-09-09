# pwr — Pi Workflow Runtime

> last verified @ 0142e14

## 职责与边界

用户写受约束的 ECMAScript 工作流脚本（并行派多个 sub-agent），PWR 校验 → 批准卡 → 派子 `pi` 进程执行并回传结果。**不做**：任意代码执行（白名单沙箱）、持久化脚本源码/args、隐式降级回主 agent。

## 文件地图

- `engine/spec.ts` — DSL 唯一事实来源（白名单、上限 128 并发 / 1000 agent / 100k 循环 / 256KB 脚本、SCRIPT_VERSION）。**改 DSL 语义必看这里。**
- `engine/` — vendor/acorn.mjs（内置解析器，勿改）→ parser → validator → interpreter（树遍历，无 vm/eval）→ concurrency。
- `runner/pi.ts` — 子 `pi --mode json -p --no-session` 契约；SIGTERM → 5s 后 SIGKILL。改进程契约必看。
- `runner/discover.ts` — .md agent 发现（用户 > 项目 > 内置，trust 门控）。
- `runtime/` — 状态机（state.ts 迁移表）、FIFO 调度器、RunCache（digest 缓存回放）、仅元数据持久化。
- `src/errors.ts`（20 码）/ `src/types.ts`（共享契约中枢 + 上限值）。**上限值改动三处同步：src/types.ts、engine/spec.ts、runtime/types.ts。**
- `src/ui/` — 无宿主 TUI 层；`renderer.ts` 是唯一引 pi-tui 组件的文件。

## 核心数据流

1. `/workflow <任务>` → `input` 钩子 → `pwr-generation-request` 自定义消息。
2. 主 agent 调 `workflow_validate` → `tool_result` 上弹批准卡（once / remember / 拒绝）。
3. `workflow_start`（批准门控，键 = 项目路径|digest，改脚本即 `APPROVAL_STALE`）→ `WorkflowRuntime.start`。
4. 调度器 → 解释器逐节点执行 → 派发：缓存命中直接回放（不派进程不占预算）| `PiAgentRunner.run` 子 pi。
5. 完成：`RunNotifier`（runId 作用域，被取消的运行不唤醒）→ `pi.sendMessage(pwr-workflow-result)`。

## 不变量

- fail-closed：缺 engine / runner ⇒ 类型化错误（`ENGINE_UNAVAILABLE` / `AGENT_RUNNER_UNAVAILABLE`），绝不隐式回退主 agent。
- 错误消息静态模板，绝不插值用户输入；脚本源码 / args 永不写盘；结果 ≤50KB（`RESULT_TOO_LARGE`）、summary ≤8KB。
- trace 文本（v2.4.0）单行 + 尾部截断，绝不透传原始工具输出。
- 工具交集：readonly = read/grep/find/ls/glob；write = +bash/write/edit。
- pwr 无 `agent_settled` 处理器（settle 经 `onFinalResult` 按 runId 作用域）；`runtime.shutdown()` 未接线。

## 已知坑

- engine ↔ runner 相互引用（interpreter 导出 `runner/errors.ts` 的 RunnerError），改循环依赖需两端同时动。
- `vendor/acorn.mjs` 是生成文件（内置 acorn 8.18.0 + 手写 d.mts），**勿手改**。
- pwr 无 init/onLoad 钩子，全部在 `index.ts` 加载时注册；`session_start` 动态 import runtime/runner 并水合 `pwr-approval-v1` / `pi-workflow-run-v1` 条目。
- `engine/validate-tool.ts` 的 `runWorkflowValidate` 仅被测试消费，别当成生产入口。
- 缩进用 tab（与多数卫星扩展的 2 空格不同）。

## 改动清单

- 必跑：`cd pwr && npm test`（405 个）+ `npm run typecheck`；性能门：`test/perf.test.ts`（1500-agent 脚本校验 ≤300ms）。
- DSL 语义变更 ⇒ 同步 `engine/spec.ts` + `SCRIPT_VERSION` + `pwr/DELIVERY.md` 版本历史。
- 测试 fake：`test/helpers.ts` 的 `makeFakeRunner`（fake AgentRunner）、`runner/test/helpers.ts` 的 `FakeChild` + `makeFakeSpawn`（fake 子进程）。集成模式见 `runner/test/integration.test.ts`。
- 完整架构 / 安全文档 / 版本历史 → `pwr/DELIVERY.md`（权威，勿在别处重复）。
