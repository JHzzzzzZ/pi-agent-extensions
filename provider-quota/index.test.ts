/**
 * provider-quota/index.test.ts — node:test 单元测试（无 pi 宿主依赖）
 *
 * index.ts 顶部仅 import type（类型擦除后零外部依赖），可直接被
 * node --experimental-strip-types --test 加载。
 *
 * 运行：node --experimental-strip-types --test provider-quota/index.test.ts
 *
 * 时钟约定：全部用「本地时间」Date 构造固定 now / 刷新时刻，
 * 断言不依赖运行机器的时区。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { QUOTA_ENDPOINTS, parseZhipuQuotaLimit } from "./index.ts";

// 固定本地时钟：2026-08-05 11:47:00 本地时间
const NOW = new Date(2026, 7, 5, 11, 47, 0);
// 同日 14:00 → 距 now 恰好 2h13m
const REFRESH = new Date(2026, 7, 5, 14, 0, 0);

function limitsBody(limits: unknown): unknown {
	return {
		code: 200,
		msg: "操作成功",
		data: { limits, level: "lite" },
		success: true,
	};
}

function tokTimeBody(extra: Record<string, unknown> = {}): unknown {
	return limitsBody([
		{ type: "TOKENS_LIMIT", percentage: 32, ...extra },
		{ type: "TIME_LIMIT", percentage: 5 },
	]);
}

// ---- zhipu：下次刷新时间后缀 ----

test("zhipu: 仅百分比、无时间字段，输出与现状一致（回归）", () => {
	assert.equal(
		parseZhipuQuotaLimit(
			limitsBody([
				{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 32 },
				{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 5 },
			]),
			NOW,
		),
		"GLM tok 32% mcp 5%",
	);
});

test("zhipu: nextResetTime 毫秒/秒/ISO 字符串三种格式输出一致", () => {
	const expected = "GLM tok 32% → 14:00 (2h13m)";
	assert.equal(
		parseZhipuQuotaLimit(
			limitsBody([
				{ type: "TOKENS_LIMIT", percentage: 32, nextResetTime: REFRESH.getTime() },
			]),
			NOW,
		),
		expected,
		"毫秒 epoch",
	);
	assert.equal(
		parseZhipuQuotaLimit(
			limitsBody([
				{
					type: "TOKENS_LIMIT",
					percentage: 32,
					nextResetTime: REFRESH.getTime() / 1000,
				},
			]),
			NOW,
		),
		expected,
		"秒 epoch",
	);
	assert.equal(
		parseZhipuQuotaLimit(
			limitsBody([
				{
					type: "TOKENS_LIMIT",
					percentage: 32,
					nextResetTime: REFRESH.toISOString(),
				},
			]),
			NOW,
		),
		expected,
		"ISO 字符串",
	);
});

test("zhipu: 真实响应结构 smoke（实测 nextResetTime 毫秒 epoch）", () => {
	const body = {
		code: 200,
		msg: "操作成功",
		data: {
			limits: [
				{
					type: "TIME_LIMIT",
					unit: 5,
					number: 1,
					usage: 100,
					currentValue: 0,
					remaining: 100,
					percentage: 0,
					nextResetTime: REFRESH.getTime(),
					usageDetails: [{ modelCode: "search-prime", usage: 0 }],
				},
				{
					type: "TOKENS_LIMIT",
					unit: 3,
					number: 5,
					percentage: 6,
					nextResetTime: REFRESH.getTime(),
				},
			],
			level: "lite",
		},
		success: true,
	};
	assert.equal(
		parseZhipuQuotaLimit(body, NOW),
		"GLM tok 6% mcp 0% → 14:00 (2h13m)",
	);
});

test("zhipu: 同日显示 HH:mm，跨日显示 MM-dd HH:mm", () => {
	const now = new Date(2026, 7, 5, 23, 50, 0); // 23:50
	const nextDay = new Date(2026, 7, 6, 0, 10, 0); // 次日 00:10，差 20m
	const body = limitsBody([
		{ type: "TOKENS_LIMIT", percentage: 50, nextResetTime: nextDay.getTime() },
	]);
	assert.equal(
		parseZhipuQuotaLimit(body, now),
		"GLM tok 50% → 08-06 00:10 (20m)",
	);
});

test("zhipu: 刚过去的刷新时间（now-24h 内）只显示绝对时间、无倒计时", () => {
	const body = limitsBody([
		{
			type: "TOKENS_LIMIT",
			percentage: 32,
			nextResetTime: new Date(2026, 7, 5, 11, 0, 0).getTime(),
		},
		{ type: "TIME_LIMIT", percentage: 5 },
	]);
	assert.equal(parseZhipuQuotaLimit(body, NOW), "GLM tok 32% mcp 5% → 11:00");
});

test("zhipu: 早于 now-24h 的垃圾时间不追加后缀", () => {
	const body = tokTimeBody({
		nextResetTime: new Date(2026, 7, 4, 10, 0, 0).getTime(), // now-25h47m
	});
	assert.equal(parseZhipuQuotaLimit(body, NOW), "GLM tok 32% mcp 5%");
});

test("zhipu: 未来不足 1 小时显示 Ym，不足 1 分钟显示 <1m", () => {
	const in20min = new Date(NOW.getTime() + 20 * 60_000);
	const body20 = limitsBody([
		{ type: "TOKENS_LIMIT", percentage: 32, nextResetTime: in20min.getTime() },
	]);
	assert.equal(
		parseZhipuQuotaLimit(body20, NOW),
		"GLM tok 32% → 12:07 (20m)",
	);
	const in30s = new Date(NOW.getTime() + 30_000);
	const body30s = limitsBody([
		{ type: "TOKENS_LIMIT", percentage: 32, nextResetTime: in30s.getTime() },
	]);
	assert.equal(parseZhipuQuotaLimit(body30s, NOW), "GLM tok 32% → 11:47 (<1m)");
});

test("zhipu: 刷新时间取值优先级 TOKENS_LIMIT > TIME_LIMIT > 任意条目", () => {
	const t1 = new Date(2026, 7, 5, 14, 0, 0).getTime();
	const t2 = new Date(2026, 7, 5, 15, 0, 0).getTime();
	const t3 = new Date(2026, 7, 5, 16, 0, 0).getTime();
	// 两条都有 → 取 TOKENS_LIMIT
	const both = limitsBody([
		{ type: "TIME_LIMIT", percentage: 2, nextResetTime: t2 },
		{ type: "TOKENS_LIMIT", percentage: 1, nextResetTime: t1 },
	]);
	assert.equal(
		parseZhipuQuotaLimit(both, NOW),
		"GLM tok 1% mcp 2% → 14:00 (2h13m)",
	);
	// 仅 TIME_LIMIT 有 → 取 TIME_LIMIT
	const onlyTime = limitsBody([
		{ type: "TIME_LIMIT", percentage: 2, nextResetTime: t2 },
	]);
	assert.equal(
		parseZhipuQuotaLimit(onlyTime, NOW),
		"GLM mcp 2% → 15:00 (3h13m)",
	);
	// 两者皆无、任意条目有 → 取任意条目（无百分比时仅显示后缀）
	const anyEntry = limitsBody([
		{ type: "OTHER", percentage: 9, nextResetTime: t3 },
	]);
	assert.equal(parseZhipuQuotaLimit(anyEntry, NOW), "GLM → 16:00 (4h13m)");
});

test("zhipu: 防御式兼容 nextRefreshTime / next_refresh_time / resetTime / reset_time", () => {
	const variants = [
		"nextRefreshTime",
		"next_refresh_time",
		"resetTime",
		"reset_time",
	];
	for (const name of variants) {
		const body = tokTimeBody({ [name]: REFRESH.getTime() });
		assert.equal(
			parseZhipuQuotaLimit(body, NOW),
			"GLM tok 32% mcp 5% → 14:00 (2h13m)",
			`字段 ${name}`,
		);
	}
});

test("zhipu: 过小的时间戳（< 1e9）视为解析失败，不追加后缀", () => {
	assert.equal(
		parseZhipuQuotaLimit(tokTimeBody({ nextResetTime: 12345 }), NOW),
		"GLM tok 32% mcp 5%",
	);
});

test("zhipu: limits 缺失/空/无有效字段时返回 null", () => {
	assert.equal(parseZhipuQuotaLimit(null, NOW), null);
	assert.equal(parseZhipuQuotaLimit(undefined, NOW), null);
	assert.equal(parseZhipuQuotaLimit({}, NOW), null);
	assert.equal(parseZhipuQuotaLimit(limitsBody([]), NOW), null);
	assert.equal(
		parseZhipuQuotaLimit(limitsBody([{ type: "TOKENS_LIMIT" }]), NOW),
		null,
	);
	assert.equal(
		parseZhipuQuotaLimit(limitsBody([{ type: "TOKENS_LIMIT", percentage: "x" }]), NOW),
		null,
	);
});

// ---- 其余 adapter parse（此前零测试覆盖的基础回归）----

test("openrouter: 正常额度与缺 data 返回 null", () => {
	assert.equal(
		QUOTA_ENDPOINTS.openrouter.parse({
			data: { total_credits: 12.5, total_usage: 3.25 },
		})?.text,
		"OR $12.50 (used $3.25)",
	);
	assert.equal(QUOTA_ENDPOINTS.openrouter.parse({}), null);
	assert.equal(QUOTA_ENDPOINTS.openrouter.parse(null), null);
});

test("deepseek: 正常余额与缺 balance_infos 返回 null", () => {
	assert.equal(
		QUOTA_ENDPOINTS.deepseek.parse({
			balance_infos: [{ total_balance: "10.00", currency: "CNY" }],
		})?.text,
		"DS 10.00 CNY",
	);
	assert.equal(QUOTA_ENDPOINTS.deepseek.parse({}), null);
	assert.equal(QUOTA_ENDPOINTS.deepseek.parse(null), null);
});

test("chatanywhere: 余额差值与非法输入返回 null", () => {
	assert.equal(
		QUOTA_ENDPOINTS.chatanywhere.parse({ balanceTotal: 100, balanceUsed: 40 })
			?.text,
		"CA 60.00",
	);
	assert.equal(
		QUOTA_ENDPOINTS.chatanywhere.parse({ balanceTotal: "not-a-number" }),
		null,
	);
	assert.equal(QUOTA_ENDPOINTS.chatanywhere.parse({}), null);
});

test("zhipu adapter: parse 委托 parseZhipuQuotaLimit", () => {
	assert.equal(
		QUOTA_ENDPOINTS.zhipu.parse(
			limitsBody([
				{ type: "TOKENS_LIMIT", percentage: 32 },
				{ type: "TIME_LIMIT", percentage: 5 },
			]),
		)?.text,
		"GLM tok 32% mcp 5%",
	);
	assert.equal(QUOTA_ENDPOINTS.zhipu.parse(null), null);
});
