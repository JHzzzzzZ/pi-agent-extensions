/**
 * routing.ts 的决策层契约（general-todo#22）：路由决策表 / state 往返与写回规则 /
 * 失败路径 fail-closed。
 *
 * 边界说明：决策层是纯函数，唯一外部依赖是 `find`（宿主 `ctx.modelRegistry.find`）。
 * 这里把它接到宿主**真实** `ModelRegistry` 上（静态目录、不联网、不读凭据），
 * 好让「决策表给出的模型确实存在于目录」这一条也被测到——假 find 测不出打错字。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TIER_MODELS, type Tier } from "../config.ts";
import { RouterErrorCodes, RouterRouteError } from "../errors.ts";
import { decideTier, parseRouterState, planRoute, type RouteInput, type RouteDeps } from "../routing.ts";

async function makeDeps(): Promise<RouteDeps> {
  const registry = new ModelRegistry(await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }));
  return { find: (provider, modelId) => registry.find(provider, modelId) };
}

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return { reason: "user", thinkingLevel: "high", ...overrides };
}

/** 判据字段 → 期望档位（决策表本体）。 */
const DECISION_TABLE: ReadonlyArray<{ scenario: string; route: RouteInput; tier: Tier }> = [
  { scenario: "user（用户回合首请求）", route: input(), tier: "strong" },
  { scenario: "continuation（工具结果/扩展消息续跑）", route: input({ reason: "continuation" }), tier: "fast" },
  { scenario: "direct（compaction summary / 扩展调用）", route: input({ reason: "direct" }), tier: "direct" },
  { scenario: "retry（上一次快档）", route: input({ reason: "retry", state: { tier: "fast" } }), tier: "strong" },
  { scenario: "retry（上一次长上下文档）", route: input({ reason: "retry", state: { tier: "longContext" } }), tier: "strong" },
  { scenario: "retry（已在强档：到顶不再升）", route: input({ reason: "retry", state: { tier: "strong" } }), tier: "strong" },
  { scenario: "retry（无状态：首请求即失败）", route: input({ reason: "retry" }), tier: "strong" },
  {
    scenario: "retry + stopReason length（溢出信号）",
    route: input({ reason: "retry", state: { tier: "fast" }, failed: { stopReason: "length" } }),
    tier: "longContext",
  },
  {
    scenario: "retry + errorMessage 溢出措辞（OpenAI 兼容）",
    route: input({
      reason: "retry",
      state: { tier: "strong" },
      failed: { stopReason: "error", errorMessage: "Your input exceeds the model's maximum context length of 1000000 tokens" },
    }),
    tier: "longContext",
  },
  {
    scenario: "retry + 普通错误（不换档位族，只升档）",
    route: input({ reason: "retry", state: { tier: "fast" }, failed: { stopReason: "error", errorMessage: "rate limit exceeded" } }),
    tier: "strong",
  },
];

test("路由决策表：每个 reason 的典型输入 → 期望档位", async () => {
  const deps = await makeDeps();
  for (const { scenario, route, tier } of DECISION_TABLE) {
    assert.equal(decideTier(route), tier, `decideTier: ${scenario}`);
    const planned = planRoute(route, deps);
    assert.equal(planned.model.provider, TIER_MODELS[tier].provider, `provider: ${scenario}`);
    assert.equal(planned.model.id, TIER_MODELS[tier].id, `model: ${scenario}`);
  }
});

test("思考级别原样透传（本扩展只换模型，不动用户选的级别）", async () => {
  const deps = await makeDeps();
  for (const level of ["off", "high", "max"] as const) {
    assert.equal(planRoute(input({ thinkingLevel: level }), deps).thinkingLevel, level);
    assert.equal(planRoute(input({ reason: "direct", thinkingLevel: level }), deps).thinkingLevel, level);
  }
});

test("state 写回：档位变化才写，档位不变不写（避免每请求落一条条目）", async () => {
  const deps = await makeDeps();
  assert.deepEqual(planRoute(input(), deps).state, { tier: "strong" }, "首请求无状态 → 写");
  assert.equal(planRoute(input({ state: { tier: "strong" } }), deps).state, undefined, "同档位 → 不写");
  assert.deepEqual(planRoute(input({ reason: "continuation", state: { tier: "strong" } }), deps).state, { tier: "fast" }, "换档位 → 写");
  assert.equal(planRoute(input({ reason: "retry", state: { tier: "fast" } }), deps).state?.tier, "strong", "升档 → 写新档位");
});

test("direct 请求不写 state（宿主对 direct 也忽略 state）", async () => {
  const deps = await makeDeps();
  assert.equal(planRoute(input({ reason: "direct" }), deps).state, undefined);
  assert.equal(planRoute(input({ reason: "direct", state: { tier: "strong" } }), deps).state, undefined);
});

test("state 序列化往返：JSON 往返后语义不变（宿主要求 JSON 可序列化）", () => {
  for (const tier of ["strong", "fast", "longContext", "direct"] as const) {
    const roundTrip = JSON.parse(JSON.stringify({ tier })) as unknown;
    assert.deepEqual(parseRouterState(roundTrip), { tier });
  }
});

test("state 认不出来当没有（旧版本/损坏条目 → 回到首请求策略，不炸）", () => {
  for (const raw of [undefined, null, "strong", 42, {}, { tier: "unknown-tier" }, { tier: 42 }, []]) {
    assert.equal(parseRouterState(raw), undefined, `parseRouterState(${JSON.stringify(raw)})`);
    const route = { reason: "retry", state: raw } as RouteInput;
    assert.equal(decideTier(route), "strong", "无有效状态时 retry 直接上强档");
  }
});

test("表外 reason → fail-closed（抛 UNKNOWN_REASON，不静默回落某档）", async () => {
  const deps = await makeDeps();
  for (const reason of ["", "steering", "USER", "tool"]) {
    const route = input({ reason });
    assert.throws(
      () => decideTier(route),
      (error: unknown) => error instanceof RouterRouteError && error.code === RouterErrorCodes.UNKNOWN_REASON,
      `reason=${JSON.stringify(reason)}`,
    );
    assert.throws(() => planRoute(route, deps));
  }
});

test("档位表指向的模型不在目录里 → fail-closed（抛 MODEL_NOT_IN_CATALOG，绝不回落到别的模型）", () => {
  const deps: RouteDeps = { find: () => undefined };
  for (const route of [input(), input({ reason: "continuation" }), input({ reason: "direct" })]) {
    assert.throws(
      () => planRoute(route, deps),
      (error: unknown) =>
        error instanceof RouterRouteError &&
        error.code === RouterErrorCodes.MODEL_NOT_IN_CATALOG &&
        error.message.includes(TIER_MODELS[decideTier(route)].id),
    );
  }
});
