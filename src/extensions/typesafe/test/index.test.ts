/**
 * typesafe/index.test.ts — provider / 工具注册形状与鉴权路径（typesafe-todo#1）
 *
 * 用假 ExtensionAPI 只截获注册调用：断言的是「交给宿主的东西长什么样」——provider 有
 * `auth.apiKey`（这条决定了它能否出现在 `/login` 菜单，见 docs/specs/typesafe-login.md
 * 的源码证据）、`models` 为空、登录走遮罩 prompt 且拒绝空 key；工具名与必填参数。
 * 宿主的真实登录流程不在本测试范围（真机探针是验收标准 1）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";

import typesafeExtension, { PROVIDER_ID, TOOL_NAME, formatAnswers } from "../index.ts";
import { DEFAULT_BASE_URL } from "../client.ts";

interface Captured {
	providers: Provider[];
	tools: { name: string; description: string; parameters: Record<string, unknown> }[];
}

function capture(): Captured {
	const captured: Captured = { providers: [], tools: [] };
	typesafeExtension({
		registerProvider: (provider: Provider) => {
			captured.providers.push(provider);
		},
		registerTool: (tool: Captured["tools"][number]) => {
			captured.tools.push(tool);
		},
	} as unknown as ExtensionAPI);
	return captured;
}

function interaction(promptReply: string | Error): ProviderAuthInteraction {
	return {
		signal: new AbortController().signal,
		async prompt() {
			if (promptReply instanceof Error) throw promptReply;
			return promptReply;
		},
		notify() {},
	};
}

test("index: 注册一个零模型的 typesafe provider，带 apiKey 鉴权（/login 可见的前提）", () => {
	const captured = capture();
	assert.equal(captured.providers.length, 1);
	const provider = captured.providers[0];
	assert.equal(provider.id, PROVIDER_ID);
	assert.equal(provider.name, "TypeSafe");
	assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
	assert.deepEqual(provider.getModels(), [], "TypeSafe 不提供聊天模型");
	assert.ok(provider.auth.apiKey, "必须用 apiKey 鉴权形态（oauth 形态语义不对）");
	assert.equal(provider.auth.apiKey?.name, "TypeSafe API key");
});

test("index: 误把 typesafe 当聊天模型用时 fail-closed 抛错", () => {
	const provider = capture().providers[0];
	assert.throws(() => provider.stream({} as never, {} as never), /不提供聊天模型/);
	assert.throws(() => provider.streamSimple({} as never, {} as never), /不提供聊天模型/);
});

test("index: login 走遮罩 prompt、裁剪空白、拒绝空 key", async () => {
	const login = capture().providers[0].auth.apiKey?.login;
	assert.ok(login, "必须提供 login（否则 /login 不会走我们的采集流程）");

	const credential = await login(interaction("  sk-typesafe-from-login  "));
	assert.deepEqual(credential, { type: "api_key", key: "sk-typesafe-from-login" });

	await assert.rejects(() => login(interaction("   ")), /不能为空/);
	await assert.rejects(() => login(interaction(new Error("cancelled"))), /cancelled/);
});

test("index: resolve 优先用已存凭据，其次环境变量，都缺则 undefined", async () => {
	const resolve = capture().providers[0].auth.apiKey?.resolve;
	assert.ok(resolve);
	const signal = new AbortController().signal;

	const stored = await resolve({
		ctx: { env: async () => "from-env", fileExists: async () => false },
		credential: { type: "api_key", key: "  from-store " },
		signal,
	});
	assert.deepEqual(stored, { auth: { apiKey: "from-store" }, source: "stored API key" });

	const fromEnv = await resolve({
		ctx: { env: async () => "from-env", fileExists: async () => false },
		credential: undefined,
		signal,
	});
	assert.deepEqual(fromEnv, { auth: { apiKey: "from-env" }, source: "TYPESAFE_API_KEY" });

	const missing = await resolve({
		ctx: { env: async () => undefined, fileExists: async () => false },
		credential: undefined,
		signal,
	});
	assert.equal(missing, undefined);
});

test("index: 工具名、必填参数与说明齐备", () => {
	const captured = capture();
	assert.equal(captured.tools.length, 1);
	const tool = captured.tools[0];
	assert.equal(tool.name, TOOL_NAME);
	assert.match(tool.description, /\/login typesafe/);
	const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
	assert.deepEqual(Object.keys(properties).sort(), ["model", "questions", "state"]);
	assert.deepEqual((((tool.parameters as { required?: string[] }).required ?? []).slice().sort()), ["questions", "state"]);
});

test("index: formatAnswers 覆盖三原语并对缺字段容错", () => {
	const text = formatAnswers({
		model: "jev-1.13.0",
		answers: {
			department: { type: "choice", choice: "technical", confidence: 0.78, probabilities: { technical: 0.85 } },
			frustration: { type: "score", score: 1 },
			urgency: { type: "noul", noul: 1 },
		},
		usage: { input_tokens: 12 },
	});
	assert.match(text, /model: jev-1\.13\.0/);
	assert.match(text, /department: type=choice choice=technical confidence=0\.78/);
	assert.match(text, /probabilities: \{"technical":0\.85\}/);
	assert.match(text, /frustration: type=score score=1/);
	assert.match(text, /urgency: type=noul noul=1/);
	assert.match(text, /usage: \{"input_tokens":12\}/);
});
