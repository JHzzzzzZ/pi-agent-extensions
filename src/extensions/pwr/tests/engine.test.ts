/**
 * Real JHL-12 engine integration tests: the adapter in src/engine.ts must
 * resolve the actual `../engine/validator.ts` module (delivered by JHL-12)
 * and map its diagnostics (position + astVersion) into the JHL-16 contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getValidationEngine, resolveEngine, resetEngineCache, structuralGate } from "../src/engine.ts";
import { ErrorCode } from "../src/errors.ts";

const VALID = `
export const meta = { name: 'audit', description: 'audit routes', version: 1 };
const files = await agent('List route files', { label: 'discover', tools: 'readonly' });
const audits = await pipeline(files.files, file =>
  agent(\`Audit \${file}\`, { label: 'audit', tools: 'readonly' }),
  { concurrency: 8 },
);
return await agent('Summarize', { label: 'verify' });
`;

test("resolveEngine() resolves the real JHL-12 validateScript module", async () => {
	resetEngineCache();
	const engine = await resolveEngine();
	assert.ok(engine, "JHL-12 engine module (../engine/validator.ts) must resolve");
	assert.notEqual(engine, structuralGate, "must be the real engine, not the structural gate");
});

test("getValidationEngine(): valid script passes with meta and astVersion mapped", async () => {
	resetEngineCache();
	const engine = await getValidationEngine();
	assert.ok(engine, "engine must be available when JHL-12 is present");
	const result = await engine!.validate(VALID);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.equal(result.errors.length, 0);
	assert.equal(result.meta?.name, "audit");
	assert.equal(result.meta?.description, "audit routes");
	assert.equal(result.meta?.version, 1);
	assert.ok(result.astVersion.length > 0, "astVersion must be mapped from the engine");
});

test("engine adapter rejects forbidden syntax with mapped line/column", async () => {
	resetEngineCache();
	const engine = await getValidationEngine();
	const bad = await engine!.validate(`export const meta = { name: 'x' };\nprocess.exit(1)`);
	assert.equal(bad.ok, false);
	const first = bad.errors[0];
	assert.equal(first?.code, ErrorCode.SCRIPT_FORBIDDEN_SYNTAX);
	assert.ok((first?.line ?? 0) >= 1, `expected a source line, got ${first?.line}`);
	assert.ok((first?.column ?? 0) >= 0);
});

test("engine adapter maps unknown-API diagnostics with position", async () => {
	resetEngineCache();
	const engine = await getValidationEngine();
	const bad = await engine!.validate(`export const meta = { name: 'x' };\nagentX()`);
	assert.equal(bad.ok, false);
	const first = bad.errors[0];
	assert.equal(first?.code, ErrorCode.SCRIPT_UNKNOWN_API);
	assert.ok((first?.line ?? 0) >= 1);
	assert.ok((first?.column ?? 0) >= 0);
});

test("engine adapter: structural gate is never returned for approval paths", async () => {
	resetEngineCache();
	const engine = await getValidationEngine();
	assert.ok(engine && engine !== structuralGate);
	// The gate must reject what the real engine rejects.
	const probe = `export const meta = { name: 'x' };\nawait agent('x');\nprocess.exit(1)`;
	const gate = await structuralGate.validate(probe);
	const real = await engine!.validate(probe);
	assert.equal(gate.ok, true, "structural gate does NOT catch forbidden syntax");
	assert.equal(real.ok, false, "real engine catches forbidden syntax");
});
