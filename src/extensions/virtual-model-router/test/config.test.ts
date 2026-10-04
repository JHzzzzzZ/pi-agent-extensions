/**
 * config.ts 单一配置表的契约（general-todo#22）。
 *
 * 边界说明：本扩展的宿主风险面恰好就两件事——① 档位表指到的模型必须真实存在
 * （typo 只能在会话里炸）；② 注册身份不能顶掉物理模型。因此这里用宿主**真实**的
 * `ModelRuntime` + `ModelRegistry`（静态内置目录、`refreshOnCreate:false` → 不联网、
 * 不读凭据，实测 ~6ms），而不是纸面假替身。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { REASON_TIERS, TIERS, TIER_MODELS, VIRTUAL_MODEL } from "../config.ts";

async function makeRegistry(): Promise<ModelRegistry> {
  return new ModelRegistry(await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }));
}

test("档位表覆盖全部档位，每项都是 provider/id", () => {
  for (const tier of TIERS) {
    const target = TIER_MODELS[tier];
    assert.ok(target.provider.length > 0 && target.id.length > 0, `档位 ${tier} 缺 provider/id`);
  }
});

test("档位表指向的模型都在真实目录里（改表打错字当场红）", async () => {
  const registry = await makeRegistry();
  for (const tier of TIERS) {
    const target = TIER_MODELS[tier];
    const model = registry.find(target.provider, target.id);
    assert.ok(model !== undefined, `档位 ${tier} 的 ${target.provider}/${target.id} 不在模型目录里`);
    assert.equal(model.api === "pi-virtual", false, `档位 ${tier} 指向了虚拟模型`);
  }
});

test("默认档位表口径：strong=deepseek-v4-pro / fast=deepseek-v4.1-flash / longContext=mimo-v2.5-pro / direct=deepseek-v4.1-flash", () => {
  assert.deepEqual(TIER_MODELS.strong, { provider: "opencode-go", id: "deepseek-v4-pro" });
  assert.deepEqual(TIER_MODELS.fast, { provider: "opencode-go", id: "deepseek-v4.1-flash" });
  assert.deepEqual(TIER_MODELS.longContext, { provider: "opencode-go", id: "mimo-v2.5-pro" });
  assert.deepEqual(TIER_MODELS.direct, { provider: "opencode-go", id: "deepseek-v4.1-flash" });
});

test("注册 provider 是目录里已有的 provider（不是自建 provider —— preflight 无鉴权 warning 的根因）", async () => {
  const registry = await makeRegistry();
  assert.ok(registry.getProvider(VIRTUAL_MODEL.provider) !== undefined, `${VIRTUAL_MODEL.provider} 不在目录里`);
  assert.ok(registry.getAll().some((model) => model.provider === VIRTUAL_MODEL.provider), "provider 名下没有物理模型");
});

test("虚拟模型 id 不与 provider 的物理模型撞名（同名会把物理模型顶掉）", async () => {
  const registry = await makeRegistry();
  const collides = registry
    .getAll()
    .some((model) => model.provider === VIRTUAL_MODEL.provider && model.id === VIRTUAL_MODEL.id);
  assert.equal(collides, false, `${VIRTUAL_MODEL.provider}/${VIRTUAL_MODEL.id} 已是物理模型`);
});

test("reason → 档位表只覆盖 user / continuation / direct（retry 走升档表）", () => {
  assert.deepEqual(Object.keys(REASON_TIERS).sort(), ["continuation", "direct", "user"]);
  assert.equal(REASON_TIERS.user, "strong");
  assert.equal(REASON_TIERS.continuation, "fast");
  assert.equal(REASON_TIERS.direct, "direct");
});
