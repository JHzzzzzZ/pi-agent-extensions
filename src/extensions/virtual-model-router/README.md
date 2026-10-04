# virtual-model-router — 虚拟模型路由（按请求 reason 自动选模型）

注册**一个可选中**的虚拟模型（默认 `opencode-go/router`），把「模型选择」从**一次决定用到底**改成**按请求决定**：用户照常 `/model` 选它，之后每次请求由本扩展现场挑物理模型。零额外 LLM 调用、零额外延迟、完全确定性（我自己就是决策器，不喊模型来决策）。

```text
/model             → opencode-go/router         （一个条目，底下是多个物理模型）
footer             → router • high → deepseek-v4-pro • high     （宿主渲染「选中 → 物理」）
/session           → 按物理模型分列成本           （宿主按物理模型记账）
```

## 路由决策表（`config.ts` 是唯一权威）

| `reason` | 含义 | 档位 | 默认物理模型 |
| --- | --- | --- | --- |
| `user` | 用户写下一条消息后的首请求（含 steering / follow-up） | `strong` | `opencode-go/deepseek-v4-pro` |
| `continuation` | agent 循环里其余请求（工具结果、扩展消息之后） | `fast` | `opencode-go/deepseek-v4.1-flash` |
| `retry` | 失败后的自动重试（含上下文溢出压缩后的重试） | 升一档（`fast`/`longContext` → `strong`，已到强档留在原档） | 见左 |
| `retry` + 溢出信号 | `failed.message.stopReason === "length"`，或 `errorMessage` 命中溢出措辞 | `longContext` | `opencode-go/mimo-v2.5-pro` |
| `direct` | agent 循环之外的请求（compaction summary、扩展直调） | `direct` | `opencode-go/deepseek-v4.1-flash` |

思考级别**原样透传**用户的选择（本扩展只换模型）——虚拟模型声明宿主全部级别，所以会话默认 `max` 不会被钳掉。

## 配置

全部策略集中在 `config.ts` 的单一表里，改路由 = 改表（不要在 `routing.ts` 里塞模型 id）：

- `VIRTUAL_MODEL` — 注册身份（`provider` / `id` / 展示名）
- `TIER_MODELS` — 档位 → 物理模型（**唯一映射表**）
- `REASON_TIERS` / `RETRY_ESCALATION` — 判据 → 档位
- `CONTEXT_OVERFLOW_PATTERNS` — 溢出措辞（粗判；见「已知缺口」）

## 不变量与边界

- **注册在用户已有凭据的 provider 下**：`ModelRegistry.hasConfiguredAuth(model)` 实际查的是 `model.provider`。注册到无凭据的自建 provider（如 `router/auto`）会让 agent-team 的 `preflight.ts` 吃「找到但无鉴权」warning（不硬失败，但是噪音）。默认落 `opencode-go`（用户默认 provider）。
- **`id` 不能与该 provider 的物理模型同名**：宿主会让虚拟模型**顶掉**同名物理模型（`docs/virtual-models.md`）。`opencode-go` 下 `router` 目前没有物理模型（`test/config.test.ts` 对真实目录锁定这条）。
- **零运行时依赖**：`index.ts` 只从宿主包导入类型；档位表指向的模型由宿主目录提供。
- **只路由模型，不写会话**：不发消息、不写 entry、不动 UI；`state` 交宿主存进 `pi.virtual-model-state` 条目（随会话分支持久化，`/resume`、`/tree` 各分支各存各的）。
- **`state` 只在换档时回写**：宿主对每个返回的 state 对象都存一条条目；同档位回写只会白涨会话。
- **`direct` 不写 state**：宿主对 `direct` 请求忽略 state，也不传 state——compaction summary 不该受路由历史影响。
- **fail-closed**：表外 `reason`、或档位模型不在目录里 → 抛类型化异常（`RouterRouteError`），宿主以错误响应结束该请求；**绝不**静默回落到别的模型。
- **不声明 `contextWindow` / `maxTokens`**：首个响应前显示未知，比声明一个错的窗口诚实；首个响应后宿主自动改用物理模型的 limits（宿主对 0 窗口视为「未知」，不触发压缩）。
- **代价（有意为之）**：`user` → `continuation` 每次换模型丢一次 prompt 缓存（一支用户回合最多丢一次）。换来的是「首轮强、续跑便宜」。要「粘住上一轮模型、不丢缓存」得改成返回 `previous`——那是另一套策略，不在本期。
- **已知缺口（上游）**：检测虚拟模型只能硬编码 `model.api === "pi-virtual"` —— 上游没从包根导出 `isVirtualModel` / `VIRTUAL_MODEL_API`（`test/index.test.ts` 锁着这条，上游补齐后应改掉）。同理，精确的溢出判定 `isContextOverflow` 只在 `@earendil-works/pi-ai/compat`，本扩展只留四类主流措辞粗判：漏判只是留在强档，误判只是多花一次便宜档位的钱。
- **不做**：Jev 分类器增强版（每请求多一次 classifier 调用换路由质量）。评估结论：本期纯规则版已经吃掉了「按 `reason` 分流」这个免费信号；只有当纯规则版的**模型选择**被证明是瓶颈（而不是「有没有路由」），多一次调用 + 首 token 延迟才值得——继续挂账，不实现。

## 安装与测试

```bash
# 安装：复制本目录到 ~/.pi/agent/extensions/（或受信任项目 .pi/extensions/），Pi 内 /reload
cp -r src/extensions/virtual-model-router ~/.pi/agent/extensions/

cd src/extensions/virtual-model-router
npm install && npm test && npm run typecheck    # 20 个测试（node:test，无 mock 库）
```

测试口径：决策层是纯函数，用宿主**真实** `ModelRuntime` + `ModelRegistry`（静态内置目录、不联网、不读凭据）当 `find` 的接缝——「档位表指到的模型真实存在」「注册进去 `api` 是 `pi-virtual`」「同名物理模型不受影响」这三条只有接真实目录才测得出。

真机验收（`/model` 可见、一次会话里至少两类物理模型被实际使用、`retry` 路径、`/resume` 与 `/tree` 分支状态、agent-team preflight 无 warning）逐步清单见 [`docs/virtual-model-router-checklist.md`](../../../docs/virtual-model-router-checklist.md)。
