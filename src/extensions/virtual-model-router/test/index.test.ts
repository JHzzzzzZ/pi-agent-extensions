/**
 * index.ts 接线契约（general-todo#22）：注册身份 / route 装配 / 与宿主真实注册表的接缝。
 *
 * 边界说明：接线这层没得选，只能假 pi API 表面（事件/注册记录），但「注册进去会变成
 * 什么」用宿主**真实**的 `ModelRegistry.registerVirtualModel` 验——本扩展唯一的
 * 上游契约风险（`api === "pi-virtual"` 检测、同名物理模型被顶掉、state 走的 entry 类型）
 * 都在那里，纸面替身测不出。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as host from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelRuntime, VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionVirtualModel, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, VIRTUAL_MODEL } from "../config.ts";
import virtualModelRouter from "../index.ts";
import type { RouterState } from "../routing.ts";

/** 假 pi 台账：只记录 registerVirtualModel 的入参（扩展对宿主 API 的全部用法就这一处）。 */
function registerThroughFakePi(): ExtensionVirtualModel<RouterState> {
  let registered: ExtensionVirtualModel<RouterState> | undefined;
  const pi = {
    registerVirtualModel: (definition: ExtensionVirtualModel<RouterState>) => {
      registered = definition;
    },
  } as unknown as ExtensionAPI;
  virtualModelRouter(pi);
  assert.ok(registered !== undefined, "index.ts 必须注册虚拟模型");
  return registered;
}

async function makeRegistry(): Promise<ModelRegistry> {
  return new ModelRegistry(await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }));
}

/** route() 只读 ctx.modelRegistry，其余宿主字段不参与（结构替身，非行为替身）。 */
function makeHostContext(registry: ModelRegistry): ExtensionContext {
  return { modelRegistry: registry } as unknown as ExtensionContext;
}

/** 宿主路由请求的等价构造：选中项取真实目录里的物理模型（route 不读它，只作占位）。 */
function makeRequest(registry: ModelRegistry, overrides: Partial<ModelRouteRequest<RouterState>> = {}): ModelRouteRequest<RouterState> {
  const selected = registry.find("opencode-go", "deepseek-v4.1-flash");
  assert.ok(selected !== undefined);
  return { model: selected, thinkingLevel: "high", reason: "user", messages: [], ...overrides };
}

test("注册身份：provider/id 取自配置表，级别声明宿主全集（用户默认 max 不被钳掉）", () => {
  const definition = registerThroughFakePi();
  assert.equal(definition.provider, VIRTUAL_MODEL.provider);
  assert.equal(definition.id, VIRTUAL_MODEL.id);
  assert.equal(definition.name, VIRTUAL_MODEL.name);
  assert.deepEqual([...(definition.thinkingLevels ?? [])].sort(), [...THINKING_LEVELS].sort());
  for (const level of ["off", "low", "max"]) assert.ok((definition.thinkingLevels ?? []).includes(level as never));
  assert.equal(definition.contextWindow, undefined, "不声明窗口：声明了会在首个响应前显示错的 limits");
});

test("route 装配：user 请求经真实目录落到强档物理模型，state 回写新档位", async () => {
  const definition = registerThroughFakePi();
  const registry = await makeRegistry();
  const route = await definition.route(makeRequest(registry), makeHostContext(registry));
  assert.equal(route.model.provider, "opencode-go");
  assert.equal(route.model.id, "deepseek-v4-pro");
  assert.equal(route.model.api === "pi-virtual", false, "路由结果必须是物理模型");
  assert.equal(route.thinkingLevel, "high");
  assert.deepEqual(route.state, { tier: "strong" });
});

test("route 装配：state 回喂后按新档位走、只在换档时写 state", async () => {
  const definition = registerThroughFakePi();
  const registry = await makeRegistry();
  const first = await definition.route(makeRequest(registry), makeHostContext(registry));
  const second = await definition.route(
    makeRequest(registry, { reason: "continuation", state: first.state }),
    makeHostContext(registry),
  );
  assert.equal(second.model.id, "deepseek-v4.1-flash", "续跑落到便宜快档");
  assert.deepEqual(second.state, { tier: "fast" }, "换档位 → 写新档位");
  const third = await definition.route(
    makeRequest(registry, { reason: "continuation", state: second.state }),
    makeHostContext(registry),
  );
  assert.equal(third.state, undefined, "同档位续跑 → 不写（不给会话白涨条目）");
});

test("route 装配：目录里查不到档位模型时抛错（宿主据此以错误响应结束请求）", async () => {
  const definition = registerThroughFakePi();
  const registry = await makeRegistry();
  const broken = { find: () => undefined } as unknown as ModelRegistry;
  assert.throws(() => definition.route(makeRequest(registry), makeHostContext(broken)));
});

test("宿主真实注册：虚拟模型进目录、api 为 pi-virtual、同名物理模型不受影响", async () => {
  const definition = registerThroughFakePi();
  const registry = await makeRegistry();
  const before = registry.getAll().filter((model) => model.provider === VIRTUAL_MODEL.provider);
  // 宿主 `ModelRegistry.registerVirtualModel` 对 state 不是泛型，这里只验注册形态（route 行为上面已验）
  registry.registerVirtualModel({
    provider: definition.provider,
    id: definition.id,
    name: definition.name,
    thinkingLevels: definition.thinkingLevels,
    route: () => {
      throw new Error("注册形态测试不调 route");
    },
  });
  const after = registry.getAll().filter((model) => model.provider === VIRTUAL_MODEL.provider);
  assert.equal(after.length, before.length + 1, "注册只新增一条目录项");
  const catalogEntry = registry.find(VIRTUAL_MODEL.provider, VIRTUAL_MODEL.id);
  assert.ok(catalogEntry !== undefined);
  assert.equal(catalogEntry.api, "pi-virtual", "检测虚拟模型只能靠这个字面量（上游未导出 isVirtualModel）");
  assert.equal(catalogEntry.name, VIRTUAL_MODEL.name);
});

test("上游导出面：isVirtualModel / VIRTUAL_MODEL_API 仍未从包根导出，state entry 类型已导出", () => {
  // 这条是「硬编码 model.api === "pi-virtual"」的依据，也是上游补齐导出后的提醒器：
  // 上游一旦导出这两个名字，就该改掉 config/routing 里的字面量与本条测试。
  assert.equal(Object.hasOwn(host, "isVirtualModel"), false);
  assert.equal(Object.hasOwn(host, "VIRTUAL_MODEL_API"), false);
  assert.equal(VIRTUAL_MODEL_STATE_ENTRY, "pi.virtual-model-state");
});
