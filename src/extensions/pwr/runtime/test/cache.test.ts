/**
 * PWR runtime — private cache unit tests (PRD 5.3 cache key semantics)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunCache, cacheKey, normalizeInput } from "../cache.ts";

const DIGEST_A = "digest-a";
const DIGEST_B = "digest-b";

test("cache key is stable across key insertion order and undefined vs omitted", () => {
	const a = cacheKey(DIGEST_A, { prompt: "p", label: "l", tools: "readonly", schema: { type: "object" } });
	const b = cacheKey(DIGEST_A, { label: "l", tools: "readonly", schema: { type: "object" }, prompt: "p" });
	assert.equal(a, b);
	const withUndefined = cacheKey(DIGEST_A, { prompt: "p", label: undefined });
	const withoutLabel = cacheKey(DIGEST_A, { prompt: "p" });
	assert.equal(withUndefined, withoutLabel);
});

test("cache key changes when any input dimension changes", () => {
	const base = { prompt: "p", label: "l", tools: "readonly" as const };
	assert.notEqual(cacheKey(DIGEST_A, base), cacheKey(DIGEST_A, { ...base, prompt: "p2" }));
	assert.notEqual(cacheKey(DIGEST_A, base), cacheKey(DIGEST_A, { ...base, label: "l2" }));
	assert.notEqual(cacheKey(DIGEST_A, base), cacheKey(DIGEST_A, { ...base, tools: "write" }));
	assert.notEqual(cacheKey(DIGEST_A, base), cacheKey(DIGEST_A, { ...base, schema: { type: "object" } }));
	assert.notEqual(cacheKey(DIGEST_A, base), cacheKey(DIGEST_B, base), "script digest participates");
});

test("normalizeInput is deterministic and JSON-stable", () => {
	const a = normalizeInput({ prompt: "p", schema: { b: 1, a: 2 }, label: "l" });
	const b = normalizeInput({ schema: { a: 2, b: 1 }, prompt: "p", label: "l" });
	assert.equal(a, b);
});

test("RunCache set/get/has/delete/clear", () => {
	const cache = new RunCache();
	const entry = {
		key: "k1",
		scriptDigest: DIGEST_A,
		taskId: "t1",
		result: { rows: [1, 2, 3] },
		summary: "3 rows",
		createdAt: "2026-08-05T00:00:00.000Z",
	};
	assert.equal(cache.has("k1"), false);
	cache.set(entry);
	assert.equal(cache.has("k1"), true);
	const stored = cache.get("k1")!;
	assert.equal((stored.result as { rows: number[] }).rows.length, 3);
	assert.equal(cache.delete("k1"), true);
	assert.equal(cache.has("k1"), false);
	cache.set(entry);
	cache.clear();
	assert.equal(cache.size, 0);
});

test("cache index exposes summaries only — never full results", () => {
	const cache = new RunCache();
	cache.set({
		key: "k1",
		scriptDigest: DIGEST_A,
		taskId: "t1",
		result: { secret: "raw tool output that must never be persisted" },
		summary: "ok",
		usage: { inputTokens: 10, nested: { nope: true } } as unknown as Record<string, number>,
		createdAt: "2026-08-05T00:00:00.000Z",
	});
	const index = cache.index();
	assert.equal(index.length, 1);
	assert.equal(index[0]?.key, "k1");
	assert.equal(index[0]?.summary, "ok");
	assert.deepEqual(index[0]?.usage, { inputTokens: 10 }, "non-numeric usage is dropped");
	assert.ok(!("result" in index[0]!), "index item never carries the full result");
	const serialized = JSON.stringify(index);
	assert.ok(!serialized.includes("raw tool output"), "raw output never enters the index");
});
