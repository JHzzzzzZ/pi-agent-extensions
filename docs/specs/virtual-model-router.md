# virtual-model-router 虚拟模型路由 — 规格

> 来源：todos/general-todo#22（对齐文档 `todos/align/general-todo#22.md`，2026-10-04 人工确认）。硬前置 `goal-todo#10` 已 done。

## 问题陈述

pi 的模型选择粒度是「一次决定用到底」：`/model` 定整个会话、agent-team 的 `team_resume` 定一次 run。用户想换只能手工切，且切了就一直背着——贵的模型在续跑（工具结果之后那些请求）上也贵，便宜的模型在需要质量的用户回合上又不够。

pi 1.0 提供 `pi.registerVirtualModel()`：注册一个可选中的目录条目，每次请求由 `route(request)` 挑物理模型。它给了「按请求决定」的能力，但没有任何策略——本扩展补的就是策略。

## 方案

注册一个虚拟模型（默认 `opencode-go/router`），`route` 按宿主的 `reason` 标签纯规则路由：零额外 LLM 调用、零额外延迟、完全确定性。

| reason | 何时出现 | 档位 | 默认模型 |
| --- | --- | --- | --- |
| `user` | 用户回合 | `strong` | `opencode-go/deepseek-v4-pro` |
| `continuation` | 工具结果之后的续跑 | `fast` | `opencode-go/deepseek-v4.1-flash` |
| `retry` | 失败重试 | 判定溢出 → `longContext`；否则按上次档位升一档 | `opencode-go/mimo-v2.5-pro`（1,048,576 窗口）/ 升档表 |
| `direct` | compaction summary、扩展直调 | `direct` | `opencode-go/deepseek-v4.1-flash` |

档位 → 物理模型的映射集中在 `config.ts` 的 `TIER_MODELS`（唯一映射表）；换模型 = 改那一张表。

## 用户故事

1. 作为使用者，我只选一次 `opencode-go/router`：需要质量的用户回合自动走强模型，续跑自动走便宜快的——不用手工切。
2. 作为使用者，上下文溢出导致的重试自动换到窗口更大的模型，而不是原地再撞一次。
3. 作为使用者，`/tree` 切分支、`/resume` 回来之后，重试升档仍从上一次**实际**档位继续（状态随分支各自持久化）。
4. 作为维护者，我能在一张表里改档位映射与溢出判据，不必翻决策逻辑。

## 实现决策

- **注册身份（两条硬约束）**：必须挂在**用户已有凭据的 provider** 下——`ModelRegistry.hasConfiguredAuth(model)` 实际查的是 `model.provider`，注册到无凭据的新 provider（如 `router/auto`）会让 agent-team 的 `preflight` 吃「找到但无鉴权」warning（验收 7）；`id` 不能顶掉该 provider 下已有的物理模型 id（宿主语义：同名虚拟模型会**隐藏**物理模型）。
- **检测虚拟模型只能硬编码** `model.api === "pi-virtual"`：上游没有从包根导出 `isVirtualModel` / `VIRTUAL_MODEL_API`；`test/index.test.ts` 锁着这条导出缺口，上游补齐后应改掉。
- **思考级别原样透传**：`thinkingLevels` 声明宿主全集（少声明一个就会被宿主钳掉级别），本扩展只路由**模型**。
- **不声明 `contextWindow` / `maxTokens`**：首位响应前显示未知，比声明一个错的窗口诚实；宿主会在首个响应后改用物理模型的实际 limits（0 在宿主语义里等于未知，不触发压缩）。
- **state 只在档位变化时回写**：宿主对每个返回对象都写一条 `pi.virtual-model-state` 条目，同档回写只会白涨会话；`direct` 请求没有 state 语义，不写。认不出来的 state（旧版本 / 损坏条目）一律当没有，回到首请求策略——不猜、不炸。
- **溢出判据是粗判**：宿主有完整的 `isContextOverflow`（30+ provider 模式，`@earendil-works/pi-ai/compat`），但未从包根导出，也不该把那张表抄一遍——这里只留四类主流措辞 + `stopReason === "length"`（部分 provider 溢出的唯一痕迹）。漏判只是留在强档（不会更糟），误判只是多花一次长上下文模型的便宜价。
- **fail-closed**：表外 `reason` 抛 `UNKNOWN_REASON`；档位指向目录里没有的模型抛 `MODEL_NOT_IN_CATALOG`——两者都以错误响应结束请求，**绝不静默回落到别的模型**。
- **分层**：`config.ts`（策略表）/ `routing.ts`（纯决策，唯一外部接缝是 `deps.find`）/ `index.ts`（宿主接线）/ `errors.ts`（错误码 `as const`）。
- **与其它扩展零耦合**：只注册一个虚拟模型，不写 entry、不发消息、不动 UI（footer 的「选中 → 物理」由宿主渲染）；goal / agent-team / pwr 均不改。

## 测试决策

先红后绿（20 例，`node:test` + `node:assert/strict`，无 mock 库）：

- **决策表逐 reason**：`user` / `continuation` / `direct` 直查表；`retry` 分「溢出 → longContext」「按上次档位升档」「已到顶留在原档」「上次档位未知 → 强档」。
- **溢出判据**：`stopReason === "length"`、四类措辞逐条命中、非溢出错误不误判。
- **state 往返**：跨档写 state、同档不写、损坏/未知 state 当没有、`direct` 不写。
- **fail-closed**：表外 reason 抛 `UNKNOWN_REASON`；档位模型不在目录抛 `MODEL_NOT_IN_CATALOG` 且不回落。
- **接缝用真实宿主对象**：用真实 `ModelRegistry` / `ModelRuntime` 验「档位表里的模型真实存在」与「注册后该条目 `api === "pi-virtual"`」——这两条是纸面替身测不出来的（档位表写错 provider/id 时，纸上永远是对的）。

## 范围外

- **Jev 分类增强版**：在 `reason` 纯规则之上叠 Jev 分类（任务难度/类型）本轮只评估不实现；判据是「每请求多一次 classifier 调用的成本与延迟，是否换得回路由质量」。
- 不改 goal 评估器（虚拟模型下评估器可用是硬前置，属 `goal-todo#10`，已 done）。
- 不改 agent-team 的模型预检语义；不改 pwr 的 `--model` 透传。
- **真机验收（本次未跑）**：`/model` 列表里可见、一次会话里至少两类物理模型被实际使用、`retry` 路径的 `failed.message` 可用性证据、`/resume` 与 `/tree` 分支 state、agent-team 不再吃「无鉴权」warning——分步清单见 `docs/virtual-model-router-checklist.md`。
