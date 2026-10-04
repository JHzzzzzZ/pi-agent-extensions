/**
 * virtual-model-router — 单一配置表（general-todo#22）
 *
 * 本扩展的全部策略都在这个文件里：注册身份 + 档位 → 物理模型映射 + 判据表。
 * 改路由行为 = 改这里的表，不要在 routing.ts 里塞模型 id。
 *
 * 注册身份的两条硬约束（都能在真实目录里查证）：
 * ① 必须注册在**用户已有凭据的 provider** 下——`ModelRegistry.hasConfiguredAuth(model)`
 *    实际查的是 `model.provider`；注册到无凭据的新 provider（如 `router/auto`）会让
 *    agent-team 的 `preflight.ts` 吃「找到但无鉴权」warning（general-todo#22 验收 7）。
 * ② `id` 不能是该 provider 下已有的物理模型 id——宿主会让虚拟模型**顶掉**同名物理模型
 *    （`docs/virtual-models.md`："A virtual model hides a physical chat model with the same id"）。
 */

import type { ModelRouteReason } from "@earendil-works/pi-coding-agent";

/** 虚拟模型的注册身份（`/model` 里显示为 `<provider>/<id>`）。 */
export const VIRTUAL_MODEL = {
  provider: "opencode-go",
  id: "router",
  name: "Router (按请求自动选模型)",
} as const;

/**
 * 虚拟模型提供的思考级别 —— 声明宿主全集：本扩展只路由**模型**，级别原样透传
 * （用户会话默认级别是 `max`，少声明一个就会被宿主钳掉）。
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 路由档位。 */
export const TIERS = ["strong", "fast", "longContext", "direct"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * 档位 → 物理模型（**唯一映射表**，改这里即可换成别的模型）。
 *
 * - `strong`：用户回合（`reason: "user"`）——要质量。
 * - `fast`：续跑（`continuation`，工具结果之后那些请求）——要便宜快；代价是每换一次
 *   模型丢一次 prompt 缓存（一支用户回合最多丢一次，见 docs/extensions 卡）。
 * - `longContext`：`retry` 且判定为上下文溢出——要的是「窗口不小于溢出方 + 便宜」，
 *   不是「更强」（opencode-go 上 `mimo-v2.5-pro` 1,048,576 窗口 / 0.435·0.87 单价）。
 * - `direct`：agent 循环之外的请求（compaction summary、扩展直调）——与选择和状态无关的
 *   固定档；默认与 `fast` 同模型，单列一项是为了能独立指向别的模型。
 */
export const TIER_MODELS: Record<Tier, { provider: string; id: string }> = {
  strong: { provider: "opencode-go", id: "deepseek-v4-pro" },
  fast: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  longContext: { provider: "opencode-go", id: "mimo-v2.5-pro" },
  direct: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
};

/** `reason` → 档位（`retry` 不在表里：它要按上次档位升档，见 `RETRY_ESCALATION`）。 */
export const REASON_TIERS: Record<Exclude<ModelRouteReason, "retry">, Tier> = {
  user: "strong",
  continuation: "fast",
  direct: "direct",
};

/**
 * `retry` 升档表：上一次的档位 → 这次升到哪一档。缺项 = 已到顶，留在原档。
 * `direct` 不可能进这里（direct 请求不写 state）。
 */
export const RETRY_ESCALATION: Partial<Record<Tier, Tier>> = {
  fast: "strong",
  longContext: "strong",
};

/**
 * 上下文溢出的错误措辞（粗判，`errorMessage` 是小写不敏感匹配）。
 *
 * 宿主有完整的 `isContextOverflow`（30+ provider 模式，`@earendil-works/pi-ai/compat`），
 * 但**未从包根导出**，也不该把那张表抄一遍——这里只留四类主流措辞：命中就换长上下文档，
 * 漏判只是留在强档（不会更糟），误判只是多花一次长上下文模型的便宜价。
 */
export const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /exceeds? (?:the )?(?:model'?s )?maximum context length/i, // OpenAI 兼容（deepseek / qwen / LiteLLM 等）
  /prompt (?:is )?too long/i, // Anthropic / z.ai / Ollama
  /exceeded model token limit/i, // Kimi For Coding
  /context (?:window|length)[^.]*exceed/i, // MiniMax / 通用兜底
];
