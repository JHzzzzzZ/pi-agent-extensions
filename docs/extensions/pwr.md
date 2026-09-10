# pwr — Pi Workflow Runtime

> last verified @ 8bee163

## 职责与边界

用户写受约束的 ECMAScript 工作流脚本（并行派多个 sub-agent），PWR 校验 → 批准卡 → 派子 `pi` 进程执行并回传结果。**不做**：任意代码执行（白名单沙箱）、持久化脚本源码/args、隐式降级回主 agent。批准卡受 solo 审批门影响（`/solo` 开启时按 once 自动批准，见 `docs/cross/solo-approval-gate.md`）。

## 文件地图

- `engine/spec.ts` — DSL 唯一事实来源（白名单、上限 128 并发 / 1000 agent / 100k 循环 / 256KB 脚本、SCRIPT_VERSION）。**改 DSL 语义必看这里。**
- `docs/tui-sync.md` — TUI ↔ 宿主对照矩阵（宿主升级必复核）。
- `engine/` — vendor/acorn.mjs（内置解析器，勿改）→ parser → validator → interpreter（树遍历，无 vm/eval）→ concurrency。
- `runner/pi.ts` — 子 `pi --mode json -p --no-session` 契约；SIGTERM → 5s 后 SIGKILL。改进程契约必看。
- `runner/discover.ts` — .md agent 发现（用户 > 项目 > 内置，trust 门控）。
- `runtime/` — 状态机（state.ts 迁移表）、FIFO 调度器、RunCache（digest 缓存回放）、仅元数据持久化。
- `src/errors.ts`（20 码）/ `src/types.ts`（共享契约中枢 + 上限值）。**上限值改动三处同步：src/types.ts、engine/spec.ts、runtime/types.ts。**
- `src/ui/` — 无宿主 TUI 层；`renderer.ts` 引 pi-tui 组件（Box/Text）并写 footer 状态键 `30:pwr`（排序带，见 `docs/cross/status-bar.md`；widget 键 `pwr-runs` 不带前缀），`viewer.ts` 引宿主文本工具（truncateToWidth/wrapTextWithAnsi/visibleWidth）与 matchesKey。
- `tests/ui-viewer-host.test.ts` — 唯一实例化真实 pi-tui（TuiMainScreen + 假终端仿真器）的测试：overlay 堆叠只存在于真实合成/diff 路径。

## 核心数据流

1. `/workflow <任务>` → `input` 钩子 → `pwr-generation-request` 自定义消息。
2. 主 agent 调 `workflow_validate` → `tool_result` 上弹批准卡（once / remember / 拒绝）；solo 激活时跳过弹卡并按 once 自动批准。
3. `workflow_start`（批准门控，键 = 项目路径|digest，改脚本即 `APPROVAL_STALE`）→ `WorkflowRuntime.start`。
4. 调度器 → 解释器逐节点执行 → 派发：缓存命中直接回放（不派进程不占预算）| `PiAgentRunner.run` 子 pi。
5. 完成：`RunNotifier`（runId 作用域，被取消的运行不唤醒）→ `pi.sendMessage(pwr-workflow-result)`。
6. saved 复用：`/workflow:run <name> [args]` → 运行时现读盘 `loadSavedWorkflow` → 重新校验 → args 按 schema 校验 → digest 门控批准 → start。

## 不变量

- fail-closed：缺 engine / runner ⇒ 类型化错误（`ENGINE_UNAVAILABLE` / `AGENT_RUNNER_UNAVAILABLE`），绝不隐式回退主 agent。
- 错误消息静态模板，绝不插值用户输入；脚本源码 / args 永不写盘；结果 ≤50KB（`RESULT_TOO_LARGE`）、summary ≤8KB。
- 命令面为单一 `/workflow:*` 命名空间（v2.9.0）：裸 `/workflow` 只做生成入口（`<任务>`；空参或 `help|--help|-h`=完整分组帮助；14 个旧子命令词只提示改名、绝不生成）；15 条独立冒号子命令 `/workflow:run|delete|model|list|view|open|pause|resume|stop|restart|save|saved|script|approve|help`。旧 `/workflows` 根与 `/workflows:*` 硬切不注册（无墓碑）；saved 名由 `/workflow:run` 调用时现读盘，与保存/删除无命令同步问题。`:list` 非法状态 warning + 有效状态集合（不静默列空表）。
- trace 文本（v2.4.0）单行 + 尾部截断，绝不透传原始工具输出。
- `/workflow:view`（v2.7.0）是 fleet 式分栏 overlay：左 roster（结构/stage/结果/脚本，选中钉 itemId 跨刷新）右 detail（三行元信息头 + 可滚动正文）；chrome 区零每秒文本（elapsed 只在正文），750ms 刷新经指纹门控（忽略 elapsed 纯时钟变化）+ 帧高消抖；`D` 两步停止（Enter/Y 确认，Esc/ctrl+c/N/backspace 取消不关查看器），停止复用 `runControlAction("stop")` 路径。
- 工具交集：readonly = read/grep/find/ls/glob；write = +bash/write/edit。
- pwr 无 `agent_settled` 处理器（settle 经 `onFinalResult` 按 runId 作用域）；会话生命周期已接线：`session_shutdown` → `runtime.shutdown()` 中止在途 run，`session_start` → `revive()` 复位闩锁（单例跨会话复用，不复位则 /new 后 start 永久抛 SESSION_SHUTDOWN）。
- solo 审批门（`src/solo-gate.ts`）：只产生 once 批准，绝不写 remembered 记录；solo 关闭后既有 remembered 批准不受影响（契约见 `docs/cross/solo-approval-gate.md`）。
- footer 状态键 `30:pwr` 带排序带前缀（宿主按 key localeCompare 拼接，不可改回 `pwr`）；状态刷新是推送式（store 事件驱动），不跑周期 ticker。

## 已知坑

- engine ↔ runner 相互引用（interpreter 导出 `runner/errors.ts` 的 RunnerError），改循环依赖需两端同时动。
- `vendor/acorn.mjs` 是生成文件（内置 acorn 8.18.0 + 手写 d.mts），**勿手改**。
- pwr 无 init/onLoad 钩子，全部在 `index.ts` 加载时注册；`session_start` 动态 import runtime/runner 并水合 `pwr-approval-v1` / `pi-workflow-run-v1` 条目。
- `engine/validate-tool.ts` 的 `runWorkflowValidate` 仅被测试消费，别当成生产入口。
- 缩进用 tab（与多数卫星扩展的 2 空格不同）。

## 改动清单

- 必跑：`cd pwr && npm test`（439 个）+ `npm run typecheck`；性能门：`test/perf.test.ts`（1500-agent 脚本校验 ≤300ms）。viewer 改动跑 `tests/ui-viewer.test.ts`（纯函数）+ `tests/ui-viewer-host.test.ts`（真实宿主，防 overlay 堆叠）。
- DSL 语义变更 ⇒ 同步 `engine/spec.ts` + `SCRIPT_VERSION` + `pwr/DELIVERY.md` 版本历史。
- 测试 fake：`test/helpers.ts` 的 `makeFakeRunner`（fake AgentRunner）、`runner/test/helpers.ts` 的 `FakeChild` + `makeFakeSpawn`（fake 子进程）。集成模式见 `runner/test/integration.test.ts`。
- 完整架构 / 安全文档 / 版本历史 → `pwr/DELIVERY.md`（权威，勿在别处重复）。
