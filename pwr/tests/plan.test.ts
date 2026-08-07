import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPlan } from "../src/plan.ts";

const VALID_SCRIPT = `
export const meta = { name: 'audit-routes', description: 'audit auth', version: 1 };

const files = await agent('List route files', { label: 'discover', schema: { type: 'object' }, tools: 'readonly' });
const audits = await pipeline(files.files, file =>
  agent(\`Audit \${file}\`, { label: 'audit', tools: 'readonly' }),
  { concurrency: 8 },
);
return await agent('Summarize', { label: 'verify', tools: 'readonly' });
`;

test("extracts stages from labels in order", () => {
	const plan = extractPlan(VALID_SCRIPT);
	const labels = plan.stages.map((s) => s.label);
	// AST-based: the pipeline has no own label -> ordinal; the nested
	// agent's "audit" label stays with its own (non-direct) call.
	assert.deepEqual(labels, ["discover", "pipeline #1", "verify"]);
	assert.equal(plan.stages[0].kind, "agent");
	assert.equal(plan.stages[1].kind, "pipeline");
});

test("budget counts agent/pipeline/parallel calls", () => {
	const plan = extractPlan(VALID_SCRIPT);
	assert.equal(plan.budget.agentCalls, 2); // discover + verify
	assert.equal(plan.budget.pipelineCalls, 1);
	assert.equal(plan.budget.parallelCalls, 0);
	assert.ok(plan.budget.estimatedAgents >= 2);
});

test("write risk is flagged when tools: 'write' appears", () => {
	const plan = extractPlan(
		`export const meta = { name: 'w' };
		 const r = await agent('edit', { label: 'apply', tools: 'write' });`,
	);
	assert.equal(plan.budget.writeRisk, true);
	assert.equal(plan.stages[0].writeRisk, true);
});

test("unlabeled calls get ordinal labels", () => {
	const plan = extractPlan(
		`export const meta = { name: 'w' };
		 const a = await agent('one');
		 const b = await agent('two');`,
	);
	assert.deepEqual(
		plan.stages.map((s) => s.label),
		["agent #1", "agent #2"],
	);
});

test("large runs warn", () => {
	const many = Array.from({ length: 30 }, (_, i) => `await agent('task ${i}', { label: 'l${i}' });`).join("\n");
	const plan = extractPlan(`export const meta = { name: 'big' };\n${many}`);
	assert.equal(plan.budget.warnLargeRun, true);
});

test("budget estimate is RAW (unclamped): 1001 direct agents -> 1001", () => {
	const many = Array.from({ length: 1001 }, (_, i) => `await agent('task ${i}', { label: 'l${i}' });`).join("\n");
	const plan = extractPlan(`export const meta = { name: 'big' };\n${many}`);
	assert.equal(plan.budget.agentCalls, 1001);
	assert.equal(plan.budget.estimatedAgents, 1001, "estimate must not be clamped below the hard cap");
});

test("strings, comments and template text never count as calls", () => {
	const plan = extractPlan(
		[
			`export const meta = { name: 't' };`,
			`const s = 'agent(fake) and pipeline(also-fake)';`,
			`// agent('commented')`,
			`/* pipeline('blocked') parallel('blocked') */`,
			"const t = `template agent(${1}) label: 'x'`;",
			`return s + t`,
		].join("\n"),
	);
	assert.equal(plan.budget.agentCalls, 0);
	assert.equal(plan.budget.pipelineCalls, 0);
	assert.equal(plan.budget.parallelCalls, 0);
	assert.equal(plan.budget.estimatedAgents, 0);
	assert.equal(plan.stages.length, 0);
});

test("nested agent calls inside pipeline/parallel callbacks are not direct agents", () => {
	const plan = extractPlan(
		[
			`export const meta = { name: 'n' };`,
			`const a = await agent('direct1', { label: 'd1' });`,
			`const b = await pipeline([1, 2], x => agent('nested ' + x, { label: 'nested' }), { concurrency: 2, label: 'fan' });`,
			`const c = await parallel([() => agent('p1', { label: 'par-a' }), () => agent('p2', { label: 'par-b' })]);`,
			`const d = await agent('direct2', { label: 'd2' });`,
			`return [a, b, c, d]`,
		].join("\n"),
	);
	// direct agents only; nested ones belong to the fan-out
	assert.equal(plan.budget.agentCalls, 2);
	assert.equal(plan.budget.pipelineCalls, 1);
	assert.equal(plan.budget.parallelCalls, 1);
	// estimate = 2 direct + (1 pipeline + 1 parallel) * fanout
	assert.equal(plan.budget.estimatedAgents, 2 + 2 * 3);
	// labels of the *container* stages come from their own options
	assert.deepEqual(
		plan.stages.map((s) => s.label),
		["d1", "fan", "parallel #1", "d2"],
	);
});

test("pipeline/parallel options label and write risk come from their own options object", () => {
	const plan = extractPlan(
		[
			`export const meta = { name: 'w' };`,
			`await pipeline([1], x => agent('n', { tools: 'write' }), { concurrency: 4, label: 'apply-all', tools: 'write' });`,
		].join("\n"),
	);
	assert.equal(plan.stages[0]?.label, "apply-all");
	assert.equal(plan.stages[0]?.writeRisk, true);
	assert.equal(plan.budget.writeRisk, true);
});

test("pipeline 非字面量 items 标记 dynamic", () => {
	const dynamic = extractPlan(
		`export const meta = { name: 'd' };
		 const items = [1, 2];
		 await pipeline(items, (i) => agent('x', { label: 'a' }), { concurrency: 2 });`,
	);
	const stage = dynamic.stages.find((s) => s.kind === "pipeline")!;
	assert.equal(stage.dynamic, true);

	const literal = extractPlan(
		`export const meta = { name: 'l' };
		 await pipeline([1, 2], (i) => agent('x', { label: 'a' }), { concurrency: 2 });`,
	);
	const literalStage = literal.stages.find((s) => s.kind === "pipeline")!;
	assert.equal(literalStage.dynamic, undefined, "literal array is not dynamic");

	const parDynamic = extractPlan(
		`export const meta = { name: 'p' };
		 const tasks = [() => agent('a', { label: 'x' })];
		 await parallel(tasks);`,
	);
	assert.equal(parDynamic.stages.find((s) => s.kind === "parallel")!.dynamic, true);

	const parLiteral = extractPlan(
		`export const meta = { name: 'p' };
		 await parallel([() => agent('a', { label: 'x' })]);`,
	);
	assert.equal(parLiteral.stages.find((s) => s.kind === "parallel")!.dynamic, undefined);

	// aggregation: same label used once literal + once dynamic -> dynamic wins
	const mixed = extractPlan(
		`export const meta = { name: 'm' };
		 await pipeline([1], (i) => agent('x', { label: 'a' }), { label: 'fan' });
		 await pipeline(items, (i) => agent('x', { label: 'a' }), { label: 'fan' });`,
	);
	const fan = mixed.stages.find((s) => s.kind === "pipeline")!;
	assert.equal(fan.dynamic, true);
	assert.equal(fan.agentCount, 6, "repeated labels aggregate the fan-out estimate");
});
