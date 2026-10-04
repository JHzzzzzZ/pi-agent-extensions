# virtual-model-router — 按请求 reason 路由到物理模型的虚拟模型

> last verified @ cd25833

一句话：注册虚拟模型 `opencode-go/router`（`pi.registerVirtualModel`），每次请求按宿主的 `reason`
选物理模型——`user` → 强档 / `continuation` → 便宜快档 / `retry` → 升档（溢出则换长上下文档）/
`direct` → 固定档。零 LLM 调用、零额外延迟，策略全在 `config.ts` 一张表里。需求与验收见 `todos/align/general-todo#22.md`。

## 为什么这么做（决策原因）

- **粒度错配**：宿主原来的模型选择粒度是「一次决定用到底」（`/model` 会话级、agent-team `team_resume` run 级）。
  宿主 1.0 的虚拟模型给了「按请求决定」的接缝，而 `reason` 是免费且强的信号（不需要分类器、无延迟）。
- **注册位置的硬约束**：`ModelRegistry.hasConfiguredAuth(model)` 实现是 `runtime.hasConfiguredAuth(model.provider)`
  ——**查 provider 不查 model**。注册到自建 provider（`router/auto`）会让 agent-team `preflight.ts` 吃
  「找到但无鉴权」warning。所以落在用户已有凭据的 `opencode-go` 下（验收 7）。
- **`id` 不能与物理模型同名**：宿主文档明说虚拟模型会**顶掉**同名物理模型。`opencode-go` 下 `router` 无物理同名项
  （`test/config.test.ts` 对真实目录锁定），改 `VIRTUAL_MODEL.id` 前先跑那条测试。
- **不声明 limits**：宿主 `createVirtualModel` 把未声明的 `contextWindow`/`maxTokens` 记为 0，而
  `AgentSession._exceedsCompactionThreshold` 对 `contextWindow <= 0` 直接返回 false（= 未知，不压缩），
  首个响应后自动改用物理模型的 limits——所以「不声明」是安全的，声明一个错的窗口才有害。

## 不变量（改代码前必须知道）

- **state 只在换档时回写**：宿主对 `route()` 返回的每个 state 对象都在分支上存一条 `pi.virtual-model-state` 条目
  （即使与当前相同），所以同档位必须返回 `undefined`（文档："Return a new object only when the state changes"）。
- **`direct` 既不读也不写 state**：宿主对 `direct` 请求不传 state、且忽略返回的 state——`direct` 档必须是与选择和
  历史无关的常数映射（compaction summary 不该被路由历史影响）。
- **state 是 JSON 往返的不可信输入**：可能来自旧版本或被外部改坏，`parseRouterState` 认不出来一律当没有
  （回到首请求策略），不猜、不炸。
- **fail-closed**：表外 `reason`、档位模型不在目录里 → 抛 `RouterRouteError`，宿主以错误响应结束该请求；
  不回落、不重试别的档位（`route()` 抛错是宿主唯一的失败通道，没有结果联合可用）。
- **思考级别是透传，不是策略**：本扩展只换模型；虚拟模型声明宿主全部级别，否则用户会话默认级别（如 `max`）
  会被宿主按声明列表钳掉。
- **换模型 = 丢 prompt 缓存**（有意为之）：`user` → `continuation` 换模型时宿主无法复用缓存，一支用户回合
  最多丢一次；换来「首轮强、续跑便宜」。想要「粘住、不丢缓存」得改成返回 `previous`（宿主示例 jev-router 的路子），
  那是另一套策略。
- **检测虚拟模型只能硬编码 `model.api === "pi-virtual"`**：上游 `isVirtualModel` / `VIRTUAL_MODEL_API` 未从包根导出
  （`test/index.test.ts` 断言 `Object.hasOwn(host, ...)` 为 false —— 上游一旦导出，这条测试就红，提醒改掉字面量）。

## 文件地图

- `index.ts` — 接线：`pi.registerVirtualModel` + 宿主请求 → 决策输入（`toRouteInput`）
- `routing.ts` — 决策层（纯函数）：`decideTier`（决策表）/ `planRoute`（查模型 + state 写回规则）/ `parseRouterState`
- `config.ts` — **唯一配置表**：注册身份、`TIER_MODELS`、`REASON_TIERS`、`RETRY_ESCALATION`、溢出措辞
- `errors.ts` — 失败码 `UNKNOWN_REASON` / `MODEL_NOT_IN_CATALOG`（静态消息模板）
- `test/` — `config.test.ts`（表 × 真实目录）/ `routing.test.ts`（决策表 + state）/ `index.test.ts`（接线 + 真实注册）

## 测试口径（为什么这么测）

宿主风险面恰好是「档位表指到的模型真存在」与「注册进去长什么样」，纸面假 `find` 测不出来——所以测试用宿主**真实**
`ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })` + `ModelRegistry`（静态内置目录、不联网、不读凭据，
实测 ~6ms）。只有 `index.ts` 的 pi API 表面与 `route(request, ctx)` 的 ctx 是结构替身（宿主对 route 的调用点在
AgentSession 深处，需要真会话 + 网络，不在单测范围）。

## 坑

- **`ModelRegistry.registerVirtualModel` 对 state 不是泛型**（`VirtualModelDefinition<TState = unknown>`），
  而扩展面 `pi.registerVirtualModel<TState>` 是泛型；测试里往注册表塞带 state 的 route 要自己对齐参数个数。
- **溢出判定是粗判**：宿主完整的 `isContextOverflow`（30+ provider 模式）在 `@earendil-works/pi-ai/compat`，
  未从包根导出；`CONTEXT_OVERFLOW_PATTERNS` 只留四类主流措辞。漏判 = 留在强档（不会更糟），误判 = 多花一次便宜档位的钱。
- **`opencode-go` 多数模型窗口都是 1M**（deepseek/qwen/mimo 系），所以 `longContext` 档的意义是「窗口不小于溢出方 + 便宜」，
  不是「窗口大得多」；真要更大窗口得手工把该档指到别的模型。
- 清单同步：`tools/install-smoke.mjs` 的 `EXTENSION_EXPECTATIONS`（本扩展无命令无 uiKeys）与 `tools/test-all.mjs` 的
  `DEFAULT_SUITES`（`install: true`）都必须登记，否则 `test/install-smoke.test.ts` / `test/test-all.test.ts` 的漂移测试红。
