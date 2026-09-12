/**
 * Performance: static validation must complete in < 300ms (PRD §7),
 * including for large, model-generated scripts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScript } from "../engine/validator.ts";

function buildLargeScript(agentCount: number): string {
	const parts: string[] = [];
	parts.push(`export const meta = { name: 'large', description: 'x', version: 1 }`);
	parts.push(`const chunks = []`);
	for (let i = 0; i < agentCount; i++) {
		parts.push(
			`const c${i} = await agent('discover chunk ${i}', { label: 'c${i}', tools: 'readonly' })`,
			`chunks.push(c${i}.items ?? [])`,
		);
	}
	parts.push(`return { chunks: chunks.length, ok: true }`);
	return parts.join("\n");
}

test("validation of a ~1500-call script stays under 300ms", () => {
	const source = buildLargeScript(1500);
	assert.ok(source.length < 256 * 1024, "fixture must stay under the size cap");
	const startedAt = performance.now();
	const result = validateScript(source);
	const elapsed = performance.now() - startedAt;
	assert.equal(result.ok, true, JSON.stringify(result.errors).slice(0, 400));
	assert.ok(elapsed < 300, `validation took ${elapsed.toFixed(1)}ms (limit 300ms)`);
});

test("validation of a ~64KB script stays under 300ms", () => {
	const source = Array.from(
		{ length: 1200 },
		(_, i) => `const d${i} = { a: 1, b: 'value', list: [1, 2, 3] } // ${i}`,
	).join("\n");
	assert.ok(source.length > 60_000, "fixture should be large");
	const startedAt = performance.now();
	const result = validateScript(source);
	const elapsed = performance.now() - startedAt;
	assert.equal(result.ok, true);
	assert.ok(elapsed < 300, `validation took ${elapsed.toFixed(1)}ms (limit 300ms)`);
});
