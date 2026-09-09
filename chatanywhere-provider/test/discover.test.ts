/**
 * ChatAnywhere Provider 运行时探测（discover.ts）与模型目录（catalog.ts）测试
 *
 * 覆盖 v1.1.0 的探测→归并→注册链路：
 *  - 目录完整性（六组恢复、无空行残留、id 唯一、与家族线自洽）
 *  - probeModels / parseProbeResponse / buildProbeRequest（纯函数，fake fetch）
 *  - classifyId（家族线 + 版本/日期/渠道解析）
 *  - collapse（同种取最新、每线 ≤3 档、元数据解析、未知模型兜底）
 *  - selectForRegistration（失败探测 fail-closed：两个 provider 均空模型）
 *
 * 探测的是进程边界（HTTP）——经注入的 fetchFn 手写 fake 隔离；其余为纯函数。
 * 运行：node --experimental-strip-types --test test/discover.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG_GROUPS, MODEL_DEFS, MODEL_LINES } from "../catalog.ts";
import {
	buildProbeRequest,
	claudeApiRoot,
	classifyId,
	collapse,
	parseProbeResponse,
	probeModels,
	selectForRegistration,
} from "../discover.ts";
import type { ProbedModel } from "../discover.ts";

// ---------------------------------------------------------------------------
// 目录完整性
// ---------------------------------------------------------------------------

test("目录：13 组齐全、六组已恢复、id 无重复、无空行/空元素残留", () => {
	assert.equal(CATALOG_GROUPS.length, 13);
	for (const group of CATALOG_GROUPS) {
		// [...group] 让稀疏数组空洞暴露出来（.every 会跳过空洞）
		assert.ok([...group].every((m) => m && typeof m.id === "string" && m.id.length > 0), "存在空洞或空元素");
	}
	const ids = MODEL_DEFS.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length, "id 重复");
	// 85 = 当前目录（含恢复的六组）；曾删除的模型不恢复、也不新增
	assert.equal(ids.length, 85);
});

test("目录：恢复的六组代表模型在位，删除的模型未回归", () => {
	const ids = new Set(MODEL_DEFS.map((m) => m.id));
	// gpt5Models / documentedOpenAIModels / gpt5CAModels / gpt4Models / gpt4CAModels / qwenModels
	for (const id of [
		"gpt-5.5",
		"gpt-5.2-pro",
		"o3-2025-04-16",
		"gpt-3.5-turbo",
		"gpt-4",
		"gpt-5.4-ca",
		"gpt-5.2-codex-ca",
		"gpt-4.1",
		"gpt-4.1-ca",
		"gpt-4o",
		"qwen3.5-plus",
		"qwen3-coder-plus",
	]) {
		assert.ok(ids.has(id), `缺 ${id}`);
	}
});

test("目录：每个定义都能被家族线解析（目录与 MODEL_LINES 自洽）", () => {
	for (const m of MODEL_DEFS) {
		const r = classifyId(m.id, MODEL_LINES);
		assert.ok(r.ok, `无法解析 ${m.id}`);
	}
});

// ---------------------------------------------------------------------------
// classifyId：家族线/版本/日期/渠道解析
// ---------------------------------------------------------------------------

test("classifyId：dot 版本（gpt-5.6-sol、gpt-5.5）、日期快照与 -ca 渠道", () => {
	const sol = classifyId("gpt-5.6-sol", MODEL_LINES);
	assert.ok(sol.ok);
	assert.deepEqual(sol.parsed, { line: "gpt-5", tier: "sol", version: [5, 6], date: null, channel: "std" });

	const ca = classifyId("gpt-5.6-sol-ca", MODEL_LINES);
	assert.ok(ca.ok);
	assert.equal(ca.parsed.tier, "sol");
	assert.equal(ca.parsed.channel, "ca");

	const base = classifyId("gpt-5.5", MODEL_LINES);
	assert.ok(base.ok);
	assert.equal(base.parsed.tier, "");
	assert.deepEqual(base.parsed.version, [5, 5]);

	const snap = classifyId("gpt-5.4-2026-03-05", MODEL_LINES);
	assert.ok(snap.ok);
	assert.deepEqual(snap.parsed.version, [5, 4]);
	assert.equal(snap.parsed.date, "2026-03-05");
});

test("classifyId：dash 版本（claude）、8 位日期与 YYMM/旧版 4 位编号", () => {
	const opus = classifyId("claude-opus-4-8", MODEL_LINES);
	assert.ok(opus.ok);
	assert.equal(opus.parsed.line, "claude-opus");
	assert.deepEqual(opus.parsed.version, [4, 8]);

	const haiku = classifyId("claude-haiku-4-5-20251001", MODEL_LINES);
	assert.ok(haiku.ok);
	assert.equal(haiku.parsed.line, "claude-haiku");
	assert.deepEqual(haiku.parsed.version, [4, 5]);
	assert.equal(haiku.parsed.date, "20251001");

	const old4 = classifyId("gpt-4-0613", MODEL_LINES);
	assert.ok(old4.ok);
	assert.equal(old4.parsed.line, "gpt-4");
	assert.equal(old4.parsed.date, "0613");

	const turbo = classifyId("gpt-3.5-turbo-1106", MODEL_LINES);
	assert.ok(turbo.ok);
	assert.equal(turbo.parsed.tier, "turbo");
	assert.equal(turbo.parsed.date, "1106");

	const qwen = classifyId("qwen3-max-2026-01-23", MODEL_LINES);
	assert.ok(qwen.ok);
	assert.equal(qwen.parsed.tier, "max");
	assert.equal(qwen.parsed.date, "2026-01-23");
});

test("classifyId：长前缀优先（gpt-4o / gpt-4.1 不误入 gpt-4、qwen3.5 不误入 qwen3）", () => {
	const o = classifyId("gpt-4o-mini", MODEL_LINES);
	assert.ok(o.ok);
	assert.equal(o.parsed.line, "gpt-4o");
	const mini = classifyId("gpt-4.1-mini", MODEL_LINES);
	assert.ok(mini.ok);
	assert.equal(mini.parsed.line, "gpt-4.1");
	const q = classifyId("qwen3.5-plus", MODEL_LINES);
	assert.ok(q.ok);
	assert.equal(q.parsed.line, "qwen3.5");
});

test("classifyId：多词档位整词匹配（search-preview / chat-latest / code）", () => {
	const s = classifyId("gpt-4o-mini-search-preview-2025-03-11", MODEL_LINES);
	assert.ok(s.ok);
	assert.equal(s.parsed.tier, "mini-search-preview");

	const c = classifyId("gpt-5-chat-latest", MODEL_LINES);
	assert.ok(c.ok);
	assert.equal(c.parsed.tier, "chat-latest");

	const k = classifyId("kimi-k2.7-code", MODEL_LINES);
	assert.ok(k.ok);
	assert.equal(k.parsed.tier, "code");
});

test("classifyId：无前缀/档位不可识别的 id 返回 lineName（未知模型归线依据）", () => {
	const no = classifyId("brand-new-xl", MODEL_LINES);
	assert.deepEqual(no, { ok: false, lineName: null });

	const unknown = classifyId("qwen3.5-ultra", MODEL_LINES);
	assert.deepEqual(unknown, { ok: false, lineName: "qwen3.5" });
});

// ---------------------------------------------------------------------------
// buildProbeRequest / probeModels / parseProbeResponse
// ---------------------------------------------------------------------------

test("探测请求：URL 与 Bearer 头拼接；无 key 不带 Authorization", () => {
	const withKey = buildProbeRequest("https://api.chatanywhere.tech/v1", "sk-abc");
	assert.equal(withKey.url, "https://api.chatanywhere.tech/v1/models");
	assert.deepEqual(withKey.headers, { Authorization: "Bearer sk-abc" });

	const noKey = buildProbeRequest("https://api.chatanywhere.tech/v1/", "");
	assert.deepEqual(noKey.headers, {});

	const noV1 = buildProbeRequest("https://gateway.example.com", "k");
	assert.equal(noV1.url, "https://gateway.example.com/models");
});

test("探测：成功解析 data 列表；context_window/max_tokens 与 camelCase 均读取", async () => {
	const seen: unknown[] = [];
	const fetchFn = async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
		seen.push({ url, init });
		return {
			ok: true,
			json: async () => ({
				data: [
					{ id: "m-a" },
					{ id: "m-b", context_window: 800000, max_tokens: 60000 },
					{ id: "m-c", contextWindow: 100000, maxTokens: 32000 },
				],
			}),
		};
	};
	const r = await probeModels("https://api.chatanywhere.tech/v1", "sk-1", fetchFn as never);
	assert.ok(r.ok);
	assert.deepEqual(r.models, [
		{ id: "m-a" },
		{ id: "m-b", contextWindow: 800000, maxTokens: 60000 },
		{ id: "m-c", contextWindow: 100000, maxTokens: 32000 },
	]);
	const call = seen[0] as { url: string; init: { headers: Record<string, string>; signal: AbortSignal } };
	assert.equal(call.url, "https://api.chatanywhere.tech/v1/models");
	assert.equal(call.init.headers.Authorization, "Bearer sk-1");
	assert.ok(call.init.signal instanceof AbortSignal, "超时信号");
});

test("claudeApiRoot：去掉 /v1 后缀（anthropic-messages 内部会重新拼 /v1/messages）", () => {
	assert.equal(claudeApiRoot("https://api.chatanywhere.tech/v1"), "https://api.chatanywhere.tech");
	assert.equal(claudeApiRoot("https://api.chatanywhere.tech/v1/"), "https://api.chatanywhere.tech");
	assert.equal(claudeApiRoot("https://gateway.example.com"), "https://gateway.example.com");
});

test("探测：空 data 列表成功返回空（注册结果为空 = fail-closed 的等价行为）", async () => {
	const r = await probeModels("https://x/v1", "k", (async () => ({ ok: true, json: async () => ({ data: [] }) })) as never);
	assert.deepEqual(r, { ok: true, models: [] });
});

test("探测：非 2xx / 网络异常 / 非法 JSON / data 非数组 / 非法条目 → {ok:false}", async () => {
	const cases = [
		{ ok: false, json: async () => ({ data: [] }) }, // HTTP 500
		{ ok: true, json: async () => null }, // 非对象
		{ ok: true, json: async () => ({}) }, // 缺 data
		{ ok: true, json: async () => ({ data: "x" }) }, // data 非数组
		{ ok: true, json: async () => ({ data: [{ id: 5 }] }) }, // 条目非法
	];
	for (const body of cases) {
		const r = await probeModels("https://x/v1", "", (async () => body) as never);
		assert.deepEqual(r, { ok: false });
	}
	const network = await probeModels("https://x/v1", "", (async () => {
		throw new TypeError("boom");
	}) as never);
	assert.deepEqual(network, { ok: false });
	const badJson = await probeModels("https://x/v1", "", (async () => ({ ok: true, json: async () => { throw new SyntaxError("bad"); } })) as never);
	assert.deepEqual(badJson, { ok: false });
});

// ---------------------------------------------------------------------------
// collapse：归并、元数据解析、兜底
// ---------------------------------------------------------------------------

const pm = (ids: (string | ProbedModel)[]): ProbedModel[] => ids.map((x) => (typeof x === "string" ? { id: x } : x));
const defById = new Map(MODEL_DEFS.map((d) => [d.id, d]));

test("claude 族：同种取最新（探测 opus-4-8 + opus-5 → 只注册 opus-5，附目录价与 Claude 适配）", () => {
	const r = collapse(pm(["claude-opus-4-8", "claude-opus-5"]), MODEL_DEFS, MODEL_LINES);
	assert.deepEqual(r.openai, []);
	assert.equal(r.claude.length, 1);
	const opus = r.claude[0];
	const def = defById.get("claude-opus-5")!;
	assert.equal(opus.id, "claude-opus-5");
	assert.equal(opus.name, "Claude Opus 5");
	assert.equal(opus.reasoning, true);
	assert.deepEqual(opus.input, def.input);
	assert.equal(opus.cost.input, def.cost.input); // 25（目录价，非 0）
	assert.equal(opus.cost.output, def.cost.output);
	assert.equal(opus.contextWindow, def.contextWindow);
	assert.equal(opus.maxTokens, def.maxTokens);
	assert.deepEqual(opus.thinkingLevelMap, { minimal: null, low: null, medium: "default", high: "default", xhigh: null, max: null });
	assert.deepEqual(opus.compat, { forceAdaptiveThinking: true });
});

test("gpt-5：别名胜日期快照（探测顺序无关，只留 gpt-5.4）", () => {
	const r = collapse(pm(["gpt-5.4-2026-03-05", "gpt-5.4"]), MODEL_DEFS, MODEL_LINES);
	assert.equal(r.openai.length, 1);
	assert.equal(r.openai[0].id, "gpt-5.4");
	assert.equal(r.openai[0].name, "GPT-5.4");
	assert.equal(r.openai[0].cost.input, 17.5);
	assert.deepEqual(r.claude, []);
});

test("gpt-5：探测含最新代全套 + 旧档 → 只留 std 渠道最新代三档（sol/terra/luna，价格降序）", () => {
	const r = collapse(
		pm([
			"gpt-5.6-sol", "gpt-5.6-sol-ca", "gpt-5.6-terra", "gpt-5.6-terra-ca",
			"gpt-5.6-luna", "gpt-5.6-luna-ca", "gpt-5.5", "gpt-5.4-mini",
			"gpt-5.4-mini-ca", "gpt-5-nano", "gpt-5.4-nano", "gpt-5.2-codex",
		]),
		MODEL_DEFS,
		MODEL_LINES,
	);
	assert.deepEqual(r.openai.map((m) => m.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
	assert.deepEqual(r.openai.map((m) => m.cost.input), [35, 17.5, 7]);
	assert.deepEqual(r.claude, []);
});

test("gpt-5：跨档排序版本优先于价格（5.4-mini 在 5.2-pro 之前；价格 0 的兜底档位不挤占）", () => {
	const r = collapse(pm(["gpt-5.2-pro", "gpt-5.4-mini", "gpt-5.5", "gpt-5-nano"]), MODEL_DEFS, MODEL_LINES);
	assert.deepEqual(r.openai.map((m) => m.id), ["gpt-5.5", "gpt-5.4-mini", "gpt-5.2-pro"]);
});

test("gpt-5：标准渠道缺失时保留 -ca 变体（目录价）", () => {
	const r = collapse(pm(["gpt-5.6-sol-ca"]), MODEL_DEFS, MODEL_LINES);
	assert.equal(r.openai.length, 1);
	assert.equal(r.openai[0].id, "gpt-5.6-sol-ca");
	assert.equal(r.openai[0].name, "GPT-5.6 Sol (CA)");
	assert.equal(r.openai[0].cost.input, 20);
	assert.equal(r.openai[0].reasoning, true);
});

test("gpt-5：只探测日期快照 → 以快照 id 注册、取同版本别名目录价并标注日期", () => {
	// gpt-5.2-codex-2025-12-11 无目录定义（目录只有别名 gpt-5.2-codex）
	const r = collapse(pm(["gpt-5.2-codex-2025-12-11"]), MODEL_DEFS, MODEL_LINES);
	assert.equal(r.openai.length, 1);
	const m = r.openai[0];
	assert.equal(m.id, "gpt-5.2-codex-2025-12-11");
	assert.equal(m.name, "GPT-5.2 Codex (2025-12-11)");
	assert.equal(m.cost.input, defById.get("gpt-5.2-codex")!.cost.input); // 12.25
	assert.equal(m.reasoning, defById.get("gpt-5.2-codex")!.reasoning);
});

test("claude：老版本快照（无对应版本目录定义）→ 兜底注册（未定价，无 thinkingLevelMap）", () => {
	const r = collapse(pm(["claude-opus-4-8"]), MODEL_DEFS, MODEL_LINES);
	assert.equal(r.claude.length, 1);
	const m = r.claude[0];
	assert.equal(m.id, "claude-opus-4-8");
	assert.equal(m.name, "claude-opus-4-8（未定价）");
	assert.equal(m.reasoning, false);
	assert.equal(m.cost.input, 0);
	assert.equal(m.contextWindow, 128000);
	assert.equal(m.maxTokens, 16384);
	assert.deepEqual(m.input, ["text"]);
	assert.ok(!("thinkingLevelMap" in m) && !("compat" in m));
});

test("未知模型兜底：默认规格注册（未定价）；接口窗口值优先；claude-* 前缀归 Claude provider", () => {
	const r = collapse(
		pm(["brand-new-xl", { id: "qwen3.5-ultra" }, { id: "claude-mystery-7", contextWindow: 888888, maxTokens: 60000 }]),
		MODEL_DEFS,
		MODEL_LINES,
	);
	// qwen3.5-ultra 归 qwen3.5 线未知段（位于线顺序位置）；brand-new-xl 无前缀归“其他”（最后）
	assert.deepEqual(r.openai.map((m) => m.id), ["qwen3.5-ultra", "brand-new-xl"]);
	for (const m of r.openai) {
		assert.equal(m.name, `${m.id}（未定价）`);
		assert.equal(m.reasoning, false);
		assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(m.input, ["text"]);
		assert.equal(m.contextWindow, 128000);
		assert.equal(m.maxTokens, 16384);
	}
	assert.equal(r.claude.length, 1);
	const c = r.claude[0];
	assert.equal(c.id, "claude-mystery-7");
	assert.equal(c.contextWindow, 888888);
	assert.equal(c.maxTokens, 60000);
	assert.equal(c.reasoning, false);
	assert.ok(!("compat" in c));
});

test("多家族线：按 MODEL_LINES 顺序输出；claude-* 全部分派到 Claude provider", () => {
	const r = collapse(pm(["claude-sonnet-5", "gpt-5.6-luna", "deepseek-v4-flash", "glm-5.2"]), MODEL_DEFS, MODEL_LINES);
	assert.deepEqual(r.openai.map((m) => m.id), ["gpt-5.6-luna", "deepseek-v4-flash", "glm-5.2"]);
	assert.deepEqual(r.claude.map((m) => m.id), ["claude-sonnet-5"]);
	// 推理模型（openai 侧）带思考等级映射
	const gpt = r.openai[0];
	assert.equal(gpt.reasoning, true);
	assert.deepEqual(gpt.thinkingLevelMap, { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: null, max: null });
	assert.equal(r.claude[0].reasoning, true);
});

test("空探测/失败探测 → selectForRegistration fail-closed（两 provider 均空模型）", () => {
	assert.deepEqual(selectForRegistration({ ok: true, models: [] }, MODEL_DEFS, MODEL_LINES), { openai: [], claude: [] });
	assert.deepEqual(selectForRegistration({ ok: false }, MODEL_DEFS, MODEL_LINES), { openai: [], claude: [] });
});

test("探测失败不会注册任何模型（含 Claude provider）", async () => {
	const fail = await probeModels("https://x/v1", "", (async () => ({ ok: false, json: async () => ({}) })) as never);
	assert.equal(fail.ok, false);
	const reg = selectForRegistration(fail, MODEL_DEFS, MODEL_LINES);
	assert.equal(reg.openai.length, 0);
	assert.equal(reg.claude.length, 0);
});
