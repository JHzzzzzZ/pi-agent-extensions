/*
 * shell-capability — 能力协商的纯逻辑单测（收集 / 形状守卫 / 参数合并 / 归属冲突描述）。
 *
 * 边界与动机：事件总线用**宿主真实的 createEventBus**（「emit 同步派发、订阅方在返回前填充盒子」
 * 是契约的一部分），其余都是纯函数；分派的两条安全口径（失败不回退本机）在 index.test.ts 里
 * 通过真实注册的 bash 验。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SHELL_CAPABILITY_CHANNEL,
  collectBashCapability,
  describeForeignBash,
  describeLostBashRegistration,
  mergeBashParameters,
} from "../shell-capability.ts";

/** 真事件总线 + 固定载荷（模拟 remote-tools 同步填盒子）。 */
function busFilling(value: unknown): EventBus {
  const bus = createEventBus();
  bus.on(SHELL_CAPABILITY_CHANNEL, (box) => {
    (box as { bash?: unknown }).bash = value;
  });
  return bus;
}

function piWithTools(tools: Array<{ name: string; description?: string; path?: string }>): ExtensionAPI {
  return {
    getAllTools: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: {},
        promptGuidelines: [],
        sourceInfo: { path: tool.path ?? "<seeded:test>" },
      })),
  } as unknown as ExtensionAPI;
}

test("collectBashCapability：无提供方/畸形载荷/总线抛错都不抛异常，且各自给出正确的回退信号", () => {
  const empty = collectBashCapability(createEventBus());
  assert.deepEqual(empty, { capability: null, warning: null });
  assert.deepEqual(collectBashCapability(undefined), { capability: null, warning: null });

  const malformed = [
    null,
    "capability",
    42,
    { parameters: {}, isRemoteCall: () => false }, // 缺 executeRemote
    { parameters: null, isRemoteCall: () => false, executeRemote: () => Promise.resolve() },
    { parameters: {}, isRemoteCall: "nope", executeRemote: () => Promise.resolve() },
    { parameters: {}, isRemoteCall: () => false, executeRemote: () => Promise.resolve(), guideline: 42 },
  ];
  for (const value of malformed) {
    const offer = collectBashCapability(busFilling(value));
    assert.equal(offer.capability, null, `应拒绝：${JSON.stringify(value)}`);
    assert.match(offer.warning ?? "", /畸形/);
  }

  const throwingBus = {
    emit: () => {
      throw new Error("bus down");
    },
  } as unknown as EventBus;
  const thrown = collectBashCapability(throwingBus);
  assert.equal(thrown.capability, null);
  assert.match(thrown.warning ?? "", /事件总线调用出错/);
});

test("collectBashCapability：合法载荷只保留契约字段，isRemoteCall 严格取 true", () => {
  const capability = {
    parameters: { remote: { type: "string" }, remoteCwd: { type: "string" } },
    isRemoteCall: (params: unknown) => (params as { remote?: unknown }).remote !== undefined,
    executeRemote: () => Promise.resolve({ content: [] }),
    guideline: "远端指南",
  };
  const offer = collectBashCapability(busFilling(capability));
  assert.ok(offer.capability);
  assert.equal(offer.warning, null);
  assert.deepEqual(offer.capability?.parameters, capability.parameters);
  assert.equal(offer.capability?.guideline, "远端指南");
  assert.equal(offer.capability?.isRemoteCall({ remote: "x" }), true);
  assert.equal(offer.capability?.isRemoteCall({}), false, "非布尔真值不当 true");

  const withoutGuideline = collectBashCapability(busFilling({ ...capability, guideline: undefined }));
  assert.equal(withoutGuideline.capability?.guideline, undefined);
});

test("mergeBashParameters：能力只能新增参数；与 owner 参数重名 ⇒ 整份拒绝（防偷偷覆盖 command）", () => {
  const base = { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } };
  const merged = mergeBashParameters(base, { remote: { type: "string" } }) as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(merged.properties).sort(), ["command", "remote", "timeout"]);
  assert.equal(merged.properties.timeout, base.properties.timeout, "owner 的参数定义原样保留");

  assert.equal(mergeBashParameters(base, { command: { type: "string" } }), null, "撞名必须整份拒绝");
  assert.equal(mergeBashParameters(base, { timeout: { type: "number" } }), null);
  assert.equal(mergeBashParameters(null, { remote: {} }), null);
  assert.equal(mergeBashParameters({ type: "object" }, { remote: {} }), null, "base 没有 properties 也判畸形");
});

test("describeForeignBash / describeLostBashRegistration：内置不算接管，描述不一致算本次注册被丢掉", () => {
  assert.equal(describeForeignBash(piWithTools([])), null);
  assert.equal(describeForeignBash(piWithTools([{ name: "bash", path: "builtin:bash" }])), null);
  assert.match(describeForeignBash(piWithTools([{ name: "bash", path: "/other/ext/index.ts" }])) ?? "", /接管/);
  assert.equal(describeForeignBash(piWithTools([{ name: "ls", path: "/other/ext/index.ts" }])), null, "别的工具名不影响");

  assert.equal(describeLostBashRegistration(piWithTools([]), "ours"), null);
  assert.equal(describeLostBashRegistration(piWithTools([{ name: "bash", description: "ours" }]), "ours"), null);
  assert.match(describeLostBashRegistration(piWithTools([{ name: "bash", description: "theirs" }]), "ours") ?? "", /加载顺序更早/);

  const noGetAllTools = {} as ExtensionAPI;
  assert.equal(describeForeignBash(noGetAllTools), null, "拿不到工具表时按无信息处理（旧宿主/结构 fake）");
  assert.equal(describeLostBashRegistration(noGetAllTools, "ours"), null);
});
