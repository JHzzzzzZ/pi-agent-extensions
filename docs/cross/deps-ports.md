# 跨扩展横切契约：注入端口（Deps）与测试 fake 模式

> last verified @ 775638d
>
> 仓库统一模式：**依赖注入经 deps 对象**，不用 mock 库、无全局注入。fake 只替进程/IO/时钟边界，不做被测行为的"纸面替身"。

## 端口清单（按扩展）

| 扩展 | 端口 | 替代的真实边界 |
| --- | --- | --- |
| pwr | `FlowDeps` / `ToolDeps`（src/flow.ts, src/tools.ts）、`SaveAdapter` / `SaveLibDeps`（src/save.ts，save.test.ts 实际注入口）、`SaveFlowDeps`、`UiRuntimeAdapter`、`RunPersister`（runtime/persist.ts） | 流程编排、保存加载、UI、持久化 |
| agent-team | `CoordinatorDeps` / `DispatchDeps`（续跑别名 `worktreeRunId?: string`）/ `ManageDeps` / `ChatCoordinatorDeps`（chat.ts：resolveTeam/startRun/contextTail/notify 全注入，纯逻辑层）；`TeamRunCoordinator.start({ resume? })` 注入续跑上下文（`{ parentRunId, parentStatus, sessionFile, modelOverrides? }`）；入口接受 `{ spawn }` | 子进程 spawn、调度、团队文件管理、viewer 发消息队列、续跑上下文 |
| loop | `LoopToolDeps`（tools.ts）；runner.ts 派生边界 | 工具依赖、后台 pi 派生 |
| goal | `GoalDeps`（index.ts） | 评估器调用、时钟 |
| opencode-bridge | `BridgeDeps`（bridge.ts，探测/派生/fs/sleep/shutdown）、`ProxySyncDeps`（settings + 端口配置读写，plan/apply 两阶段）、`BridgeExtensionDeps`（入口） | socket / 文件系统 / 进程生命周期 |
| deep-init | `DeepInitDeps`（`DirScanner` / `gitInfo` / `nowIso`） | 目录扫描、git、时钟 |
| human-notify | `HumanNotifyDeps`（派生 / 平台 / 时钟 / 环境） | 进程派生、平台探测 |
| run-timer | 无显式 deps 口——`aligned-ticker` 的 `now` 可注入，工厂测试经 before/after mock `setTimeout` + `fireTick()` | 时钟（特例：timer 直接 mock） |
| stream-token-speed | `StatusPort`（status-port.ts，状态上报端口；`createStatusPort()` 工厂） | 测试用 `RecordingStatusPort` 实现该接口（test/fixtures.ts） |

## 时钟约定

- 时钟注入 `now: () => string` / `nowMs`，测试固定 `2026-08-05T12:00:00Z`。**已知例外：loop** —— 调度/倒计时直接用 `Date.now()`（src/extensions/loop/index.ts 多处），`LoopToolDeps` 无时钟口；测试经双 mock（setTimeout + Date.now）覆盖，新插件勿模仿。
- run-timer/loop/goal/agent-team 的节拍器（`aligned-ticker.ts`）同样是 mock `setTimeout` 的特例（timer 本身就是被测行为）；节拍对齐语义在 `aligned-ticker.test.ts` 用注入 `now` 覆盖。跨插件契约见 `docs/cross/status-bar.md`。

## fake 选型规则

1. 进程边界（spawn 子 pi / helper）→ 手写 fake（pwr：`test/helpers.ts` 的 `makeFakeRunner`、`runner/test/helpers.ts` 的 `FakeChild` + `makeFakeSpawn` + `waitForChild`；agent-team：入口 `{ spawn }`）。
2. 宿主交互（TUI 渲染、终端输入）→ **实例化真实组件，只 fake 终端**（agent-team `viewer-host.test.ts`）；结构 fake（`as never`）仅用于宿主交互确实不在测试范围的情形。
3. 纯逻辑 → 不 fake，直接测真函数；文件头注明边界与动机。
4. 集成 → 接线真实模块链，只 mock 最外层 spawn（pwr `runner/test/integration.test.ts` 模式）。

## 何时新增端口

只有当 fake 是测试必需的**进程/IO 边界**时才立接口（deps/port 模式）；只有一个实现且无测试需求的"策略/插件层"禁止（YAGNI）。第三次出现重复才提取抽象（rule of three）。
