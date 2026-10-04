/**
 * virtual-model-router — 决策层（general-todo#22）：纯函数，零 LLM 调用、零额外延迟。
 *
 * 两个入口：
 * - `decideTier(input)` —— 判据（reason / 分支状态 / 失败信号）→ 档位，可单测的决策表；
 * - `planRoute(input, deps)` —— 决策 + 档位表查模型 + state 写回规则 → 宿主 `ModelRoute`。
 *
 * 唯一外部依赖是 `deps.find`（接线到 `ctx.modelRegistry.find`），所以整层脱离宿主类型可测。
 */

import type { ModelRoute } from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_OVERFLOW_PATTERNS,
  REASON_TIERS,
  RETRY_ESCALATION,
  TIERS,
  TIER_MODELS,
  type Tier,
} from "./config.ts";
import { RouterErrorCodes, RouterRouteError } from "./errors.ts";

/** 分支上持久化的路由状态（宿主存 `pi.virtual-model-state` 条目，按 `/tree` 分支各存各的）。 */
export interface RouterState {
  /** 上一次请求实际用的档位（`retry` 升档的判据；`direct` 请求不写）。 */
  tier: Tier;
}

/** 上一次档位未知时 `retry` 的起点：失败后重试直接上强档。 */
const NO_PREVIOUS_TIER: Tier = "strong";

const ROUTE_REASONS = ["user", "continuation", "retry", "direct"] as const;

/** 宿主路由请求的判据字段（宿主请求 → 这里的适配在 index.ts）。 */
export interface RouteInput {
  /** 宿主的原因标签；未校验 —— 表外值 fail-closed。 */
  reason: string;
  /** 选择到的思考级别：本扩展只路由模型，级别原样透传。 */
  thinkingLevel: ModelRoute<RouterState>["thinkingLevel"];
  /** 分支上的状态；未校验的 JSON 值（可能来自旧版本或损坏条目）。 */
  state?: unknown;
  /** `retry` 的失败信号：宿主 `failed.message` 的 `stopReason` / `errorMessage`。 */
  failed?: { stopReason: string; errorMessage?: string };
}

/** 档位 → 物理模型查询（唯一宿主接缝）。 */
export interface RouteDeps {
  find: (provider: string, modelId: string) => ModelRoute<RouterState>["model"] | undefined;
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function readReason(value: string): (typeof ROUTE_REASONS)[number] {
  if ((ROUTE_REASONS as readonly string[]).includes(value)) return value as (typeof ROUTE_REASONS)[number];
  throw new RouterRouteError(RouterErrorCodes.UNKNOWN_REASON, `未知的路由原因：宿主只定义 user / continuation / retry / direct`);
}

/** 认不出来的状态一律当没有（回到首请求策略），不猜、不炸。 */
export function parseRouterState(raw: unknown): RouterState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const tier = (raw as { tier?: unknown }).tier;
  return isTier(tier) ? { tier } : undefined;
}

function isContextOverflow(failed: RouteInput["failed"]): boolean {
  if (failed === undefined) return false;
  // stopReason "length" = 输出/输入顶到上限被截（部分 provider 溢出的唯一痕迹）
  if (failed.stopReason === "length") return true;
  const message = failed.errorMessage;
  return message !== undefined && CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

export function decideTier(input: RouteInput): Tier {
  const reason = readReason(input.reason);
  if (reason === "direct") return "direct";
  if (reason === "retry") return retryTier(input);
  return REASON_TIERS[reason];
}

/** `retry`：上下文溢出 → 换长上下文档；否则按上次档位升一档（已到顶留在原档）。 */
function retryTier(input: RouteInput): Tier {
  if (isContextOverflow(input.failed)) return "longContext";
  const previous = parseRouterState(input.state)?.tier ?? NO_PREVIOUS_TIER;
  return RETRY_ESCALATION[previous] ?? previous;
}

/**
 * 决策 + 落地：查不到档位模型就抛（宿主据此以错误响应结束请求，不回落到别的模型）。
 * state 只在**档位变化**时回写——宿主每个返回的对象都存一条条目，同档位回写会白涨会话。
 */
export function planRoute(input: RouteInput, deps: RouteDeps): ModelRoute<RouterState> {
  const tier = decideTier(input);
  const target = TIER_MODELS[tier];
  const model = deps.find(target.provider, target.id);
  if (model === undefined) {
    throw new RouterRouteError(
      RouterErrorCodes.MODEL_NOT_IN_CATALOG,
      `档位 ${tier} 的 ${target.provider}/${target.id} 不在模型目录里（检查 config.ts 的 TIER_MODELS 与 provider 凭据）`,
    );
  }
  const route: ModelRoute<RouterState> = { model, thinkingLevel: input.thinkingLevel };
  // direct 请求没有 state 语义（宿主忽略它返回的 state），不要凭空写
  if (tier === "direct") return route;
  return parseRouterState(input.state)?.tier === tier ? route : { ...route, state: { tier } };
}
