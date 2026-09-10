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
import {
	QUOTA_ENDPOINTS,
	STATUS_ID,
	parseZhipuQuotaLimit,
	parseOpencodeGoUsage,
} from "./index.ts";

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

// ---- opencode-go：实测响应 https://opencode.ai/zen/go/v1/usage（2026-09）----

function goBody(rolling: unknown, weekly: unknown, monthly: unknown): unknown {
	return { usage: { rolling, weekly, monthly } };
}

// rolling 重置时刻固定为本地 2026-09-08 19:41:10，now 比它早 2h28m；
// resetsAt 用 ISO 字符串，跨时区解析回同一时刻后按本地字段格式化。
test("opencode-go: 实测响应，输出 5h/周/月百分比 + rolling 下次重置后缀", () => {
	const resets = new Date(2026, 8, 8, 19, 41, 10);
	const now = new Date(2026, 8, 8, 17, 13, 10);
	assert.equal(
		parseOpencodeGoUsage(
			goBody(
				{ status: "ok", percent: 14, resetsAt: resets.toISOString() },
				{ status: "ok", percent: 5, resetsAt: "2026-09-14T00:00:00.080Z" },
				{ status: "ok", percent: 2, resetsAt: "2026-10-08T14:35:13.080Z" },
			),
			now,
		),
		"GO 5h 14% 周 5% 月 2% → 19:41 (2h28m)",
	);
});

test("opencode-go: 跨日重置时间显示 MM-dd HH:mm（同 zhipu 规则）", () => {
	const resets = new Date(2026, 8, 9, 0, 30, 0);
	const now = new Date(2026, 8, 8, 22, 0, 0);
	assert.equal(
		parseOpencodeGoUsage(
			goBody({ percent: 90, resetsAt: resets.toISOString() }, undefined, undefined),
			now,
		),
		"GO 5h 90% → 09-09 00:30 (2h30m)",
	);
});

test("opencode-go: rolling 缺 resetsAt 时后缀回退 weekly，再回退 monthly", () => {
	const now = new Date(2026, 8, 8, 17, 13, 10);
	const weekly = new Date(2026, 8, 9, 10, 0, 0);
	assert.equal(
		parseOpencodeGoUsage(
			goBody(
				{ percent: 1 },
				{ percent: 2, resetsAt: weekly.toISOString() },
				{ percent: 3, resetsAt: new Date(2026, 8, 10, 10, 0, 0).toISOString() },
			),
			now,
		),
		"GO 5h 1% 周 2% 月 3% → 09-09 10:00 (16h46m)",
	);
});

test("opencode-go: 百分比非数字的窗口跳过，全部缺失返回 null", () => {
	const now = new Date(2026, 8, 8, 17, 13, 10);
	assert.equal(
		parseOpencodeGoUsage(
			goBody({ percent: "x" }, { resetsAt: "2026-09-14T00:00:00.080Z" }, undefined),
			now,
		),
		"GO → 09-14 08:00 (134h46m)",
	);
	assert.equal(parseOpencodeGoUsage(goBody({}, {}, {}), now), null);
	assert.equal(parseOpencodeGoUsage({ usage: null }, now), null);
	assert.equal(parseOpencodeGoUsage(null, now), null);
	assert.equal(parseOpencodeGoUsage({}, now), null);
});

test("opencode-go: rolling 达到限额时，后缀显示 5h 窗口重置时间（优先于未限额窗口）", () => {
	// rolling 已限额但重置更晚、weekly 未限额且重置更早 → 仍取 rolling 的重置时间
	const rollingReset = new Date(2026, 8, 8, 21, 0, 0);
	const weeklyReset = new Date(2026, 8, 8, 18, 0, 0);
	const now = new Date(2026, 8, 8, 17, 0, 0);
	assert.equal(
		parseOpencodeGoUsage(
			goBody(
				{ status: "limited", percent: 100, resetsAt: rollingReset.toISOString() },
				{ status: "ok", percent: 5, resetsAt: weeklyReset.toISOString() },
				{ status: "ok", percent: 2, resetsAt: "2026-10-08T14:35:13.080Z" },
			),
			now,
		),
		"GO 5h 100% 周 5% 月 2% → 21:00 (4h0m)",
	);
});

test("opencode-go: weekly 达到限额时后缀显示周重置时间，rolling 未限额不抢占", () => {
	const weeklyReset = new Date(2026, 8, 14, 8, 0, 0);
	const rollingReset = new Date(2026, 8, 8, 18, 30, 0);
	const now = new Date(2026, 8, 8, 17, 0, 0);
	assert.equal(
		parseOpencodeGoUsage(
			goBody(
				{ status: "ok", percent: 40, resetsAt: rollingReset.toISOString() },
				{ status: "limited", percent: 100, resetsAt: weeklyReset.toISOString() },
				{ status: "ok", percent: 3, resetsAt: "2026-10-08T14:35:13.080Z" },
			),
			now,
		),
		"GO 5h 40% 周 100% 月 3% → 09-14 08:00 (135h0m)",
	);
});

test("opencode-go: monthly 达到限额（rolling/weekly 未限额）时后缀显示月重置时间", () => {
	const monthlyReset = new Date(2026, 9, 1, 0, 0, 0);
	const rollingReset = new Date(2026, 8, 8, 18, 30, 0);
	const now = new Date(2026, 8, 8, 17, 0, 0);
	assert.equal(
		parseOpencodeGoUsage(
			goBody(
				{ status: "ok", percent: 10, resetsAt: rollingReset.toISOString() },
				{ status: "ok", percent: 4 },
				{ status: "exceeded", percent: 100, resetsAt: monthlyReset.toISOString() },
			),
			now,
		),
		"GO 5h 10% 周 4% 月 100% → 10-01 00:00 (535h0m)",
	);
});

test("opencode-go: 多窗口同时限额按 rolling > weekly > monthly 取第一个", () => {
	const now = new Date(2026, 8, 8, 17, 0, 0);
	const monthlyReset = new Date(2026, 9, 1, 0, 0, 0);
	const rollingReset = new Date(2026, 8, 8, 19, 0, 0);
	assert.equal(
		parseOpencodeGoUsage(
			goBody(
				{ status: "limited", percent: 100, resetsAt: rollingReset.toISOString() },
				undefined,
				{ status: "limited", percent: 100, resetsAt: monthlyReset.toISOString() },
			),
			now,
		),
		"GO 5h 100% 月 100% → 19:00 (2h0m)",
	);
});

test("opencode-go adapter: parse 委托 parseOpencodeGoUsage（走 adapter 默认 Bearer 鉴权）", () => {
	assert.equal(
		QUOTA_ENDPOINTS["opencode-go"].parse({
			usage: { rolling: { percent: 7, resetsAt: "2020-01-01T00:00:00.000Z" } },
		})?.text,
		"GO 5h 7%",
	);
	assert.equal(QUOTA_ENDPOINTS["opencode-go"].parse(null), null);
	assert.equal(QUOTA_ENDPOINTS["opencode-go"].url, "https://opencode.ai/zen/go/v1/usage");
});

// ---- footer 排序带键（docs/cross/status-bar.md） ----

test("STATUS_ID 带排序带前缀（20:provider-quota）", () => {
	assert.equal(STATUS_ID, "20:provider-quota");
});
