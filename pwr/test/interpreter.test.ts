/**
 * ScriptInterpreter unit tests — execution semantics, concurrency caps
 * (hard limit 128), agent hard cap (1000), loop budget, abort, isolation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ScriptInterpreter, runScript } from "../engine/interpreter.ts";
import { ErrorCodes } from "../engine/errors.ts";
import { MAX_CONCURRENCY_HARD_LIMIT, MAX_AGENTS_HARD_LIMIT, DEFAULT_CONCURRENCY } from "../engine/spec.ts";
import { makeFakeRunner, PRD_SAMPLE } from "./helpers.ts";

async function run(source: string, options: Record<string, unknown> = {}) {
	return runScript(source, options as never);
}

async function failure(source: string, options: Record<string, unknown> = {}) {
	try {
		await run(source, options);
	} catch (err) {
		return err as { code?: string; message?: string; start?: { line?: number; column?: number } };
	}
	assert.fail(`expected failure for: ${source.slice(0, 80)}`);
}

test("PRD §5.1 sample executes end-to-end with the fake runner", async () => {
	const handle = makeFakeRunner({
		result: (prompt, label) => {
			if (label === "discover") return { files: ["a.ts", "b.ts", "c.ts"] };
			if (label === "verify") return { verdict: "ok", count: 3 };
			return { file: label, findings: [] };
		},
	});
	const result = await run(PRD_SAMPLE, { runner: handle.runner });
	assert.deepEqual(result.value, { verdict: "ok", count: 3 });
	assert.equal(result.meta?.name, "audit-routes");
	assert.equal(result.stats.agentCalls, 5);
	assert.equal(handle.calls.length, 5);
	assert.equal(handle.calls[0]!.label, "discover");
	assert.equal(handle.calls[1]!.label, "a.ts");
	assert.ok(result.stats.durationMs >= 0);
});

test("pipeline results keep input order and respect per-pipeline concurrency", async () => {
	const handle = makeFakeRunner({ delayMs: 5 });
	const result = await run(
		`
const items = [0,1,2,3,4,5,6,7,8,9]
const out = await pipeline(items, (x) => agent('t' + x), { concurrency: 3 })
return out.map(r => r.index)
`,
		{ runner: handle.runner },
	);
	assert.deepEqual(result.value, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	assert.ok(handle.maxConcurrent <= 3, `maxConcurrent=${handle.maxConcurrent}`);
});

test("pipeline never exceeds the run's global concurrency cap", async () => {
	const handle = makeFakeRunner({ delayMs: 5 });
	const result = await run(
		`
const items = [0,1,2,3,4,5,6,7,8,9]
const out = await pipeline(items, (x) => agent('t' + x), { concurrency: 50 })
return out.length
`,
		{ runner: handle.runner, concurrency: 2 },
	);
	assert.equal(result.value, 10);
	assert.ok(handle.maxConcurrent <= 2, `maxConcurrent=${handle.maxConcurrent}`);
	assert.equal(result.stats.effectiveConcurrency, 2);
});

test("default concurrency applies when unspecified", async () => {
	const handle = makeFakeRunner({ delayMs: 5 });
	await run(`await pipeline([0,1,2,3,4,5,6,7], (x) => agent('t' + x))`, { runner: handle.runner });
	assert.ok(handle.maxConcurrent <= DEFAULT_CONCURRENCY, `maxConcurrent=${handle.maxConcurrent}`);
	assert.equal(handle.maxConcurrent, DEFAULT_CONCURRENCY);
});

test("concurrency hard cap is 128 and clamping works", async () => {
	assert.equal(MAX_CONCURRENCY_HARD_LIMIT, 128);
	const handle = makeFakeRunner({ delayMs: 5 });
	const result = await run(
		`await pipeline([0,1,2,3,4,5,6,7,8,9], (x) => agent('t' + x), { concurrency: 1000 })`,
		{ runner: handle.runner, concurrency: 1000 },
	);
	assert.equal(result.stats.effectiveConcurrency, MAX_CONCURRENCY_HARD_LIMIT);
	assert.ok(handle.maxConcurrent <= MAX_CONCURRENCY_HARD_LIMIT);
});

test("agent hard cap: AGENT_LIMIT_EXCEEDED after maxAgents calls", async () => {
	assert.equal(MAX_AGENTS_HARD_LIMIT, 1000);
	const handle = makeFakeRunner();
	const result = await run(
		`
let count = 0
try {
  for (let i = 0; i < 1001; i++) { await agent('x') ; count++ }
} catch (e) { return { code: e.code, count } }
`,
		{ runner: handle.runner },
	);
	assert.equal((result.value as { code: string }).code, ErrorCodes.AGENT_LIMIT_EXCEEDED);
	assert.equal((result.value as { count: number }).count, 1000);
});

test("AGENT_RUNNER_UNAVAILABLE when no runner is injected", async () => {
	const err = await failure(`await agent('x')`);
	assert.equal(err?.code, ErrorCodes.AGENT_RUNNER_UNAVAILABLE);
});

test("infinite loops hit the loop budget", async () => {
	const err = await failure(`while (true) {}`, { maxLoopIterations: 1000 });
	assert.equal(err?.code, ErrorCodes.SCRIPT_LOOP_LIMIT_EXCEEDED);

	const err2 = await failure(`for (;;) {}`, { maxLoopIterations: 10 });
	assert.equal(err2?.code, ErrorCodes.SCRIPT_LOOP_LIMIT_EXCEEDED);

	const err3 = await failure(`const a = [1,2,3]\nfor (const x of a) { while (true) {} }`, { maxLoopIterations: 5 });
	assert.equal(err3?.code, ErrorCodes.SCRIPT_LOOP_LIMIT_EXCEEDED);
});

test("sleep works, validates input and is clamped", async () => {
	const t0 = Date.now();
	await run(`await sleep(10)`);
	assert.ok(Date.now() - t0 >= 9, "sleep(10) should wait");

	const err = await failure(`await sleep('x')`);
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);

	const t1 = Date.now();
	await run(`await sleep(1e9)`, { sleepMaxMs: 50 }); // clamped to configured max
	assert.ok(Date.now() - t1 >= 40, "sleep should respect the configured max");
	assert.ok(Date.now() - t1 < 2000, "oversized sleep must be clamped");
});

test("runtime errors carry position in the original script", async () => {
	const err = await failure(`const a = {}\nconst b = a.missing.deep`);
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.ok((err?.start?.line ?? 0) > 0);
});

test("computed keys are filtered at runtime too", async () => {
	const err = await failure(`const k = 'con' + 'structor'\nconst obj = { a: 1 }\nreturn obj[k]`);
	assert.equal(err?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
});

test("try/catch/finally semantics", async () => {
	const result = await run(
		`
let log = []
try {
  const obj = {}
  const x = obj.missing.deep
} catch (e) {
  log.push(e.code)
} finally {
  log.push('finally')
}
log.push('after')
return log
`,
	);
	assert.deepEqual(result.value, ["SCRIPT_RUNTIME_ERROR", "finally", "after"]);
});

test("throw of plain values becomes a runtime error", async () => {
	const err = await failure(`throw 'boom'`);
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err?.message ?? "", /boom/);
});

test("top-level return and implicit undefined", async () => {
	assert.equal((await run(`return 42`)).value, 42);
	assert.equal((await run(`const x = 1`)).value, undefined);
});

test("args global is provided and isolated (deep clone)", async () => {
	const original = { name: "audit", tags: ["a"] };
	const result = await run(`args.tags.push('x')\nreturn args`, { args: original });
	assert.deepEqual(result.value, { name: "audit", tags: ["a", "x"] });
	assert.deepEqual(original, { name: "audit", tags: ["a"] }, "caller args must not mutate");
	assert.equal((await run(`return args`)).value, undefined, "no args -> undefined");
});

test("meta is visible inside the script", async () => {
	const result = await run(`export const meta = { name: 'n1' }\nreturn meta.name`);
	assert.equal(result.value, "n1");
});

test("destructuring: object, array, rest, defaults, assignment", async () => {
	const src = `
const data = { a: 1, b: { c: 2 }, d: [3, 4] }
const { a, b: { c }, ...rest } = data
const [head, ...tail] = data.d
const { missing = 'def' } = data
let x, y
;({ x, y } = { x: 5, y: 6 })
let m, n
;[m, n] = [7, 8]
return { a, c, rest, head, tail, missing, x, y, m, n }
`;
	const result = await run(src);
	assert.deepEqual(result.value, {
		a: 1,
		c: 2,
		rest: { d: [3, 4] },
		head: 3,
		tail: [4],
		missing: "def",
		x: 5,
		y: 6,
		m: 7,
		n: 8,
	});
});

test("function params: defaults and rest", async () => {
	const result = await run(`
const f = (a, b = 10, ...rest) => a + b + rest.length
return [f(1), f(1, 2, 3, 4), (() => 99)()]
`);
	assert.deepEqual(result.value, [11, 5, 99]);
});

test("break/continue in loops", async () => {
	const result = await run(`
let out = []
for (let i = 0; i < 10; i++) {
  if (i === 2) continue
  if (i === 5) break
  out.push(i)
}
return out
`);
	assert.deepEqual(result.value, [0, 1, 3, 4]);
});

test("for...of over strings", async () => {
	const result = await run(`const out = []\nfor (const ch of 'abc') { out.push(ch) }\nreturn out`);
	assert.deepEqual(result.value, ["a", "b", "c"]);
});

test("template literals, spread, JSON, array/string methods", async () => {
	const result = await run(`
const a = [1, 2]
const b = [...a, 3]
const obj = { x: 1, ...{ y: 2 } }
const s = \`sum=\${a.length} json=\${JSON.stringify(obj)}\`
const joined = ['a', 'b'].map(x => x.toUpperCase()).join('-')
const parsed = JSON.parse('{"ok":true}')
const fixed = '  hi  '.trim().split('').reverse().join('')
return { b, s, joined, parsed, fixed }
`);
	assert.deepEqual(result.value, {
		b: [1, 2, 3],
		s: 'sum=2 json={"x":1,"y":2}',
		joined: "A-B",
		parsed: { ok: true },
		fixed: "ih",
	});
});

test("optional chaining", async () => {
	const result = await run(`const a = { b: { c: 1 } }\nreturn [a?.b?.c, a?.x?.y, a?.x?.y?.z]`);
	assert.deepEqual(result.value, [1, undefined, undefined]);
});

test("typeof on whitelisted globals", async () => {
	const result = await run(`return [typeof agent, typeof pipeline, typeof JSON, typeof meta, typeof args]`);
	assert.deepEqual(result.value, ["function", "function", "object", "undefined", "undefined"]);
});

test("abort signal stops execution", async () => {
	const ac = new AbortController();
	const p = run(`await sleep(5000)\nreturn 1`, { signal: ac.signal });
	setTimeout(() => ac.abort(), 50);
	const err = await p.then(
		() => null,
		(e: unknown) => e as { code?: string },
	);
	assert.equal(err?.code, ErrorCodes.SCRIPT_ABORTED);
});

test("final value must be plain data", async () => {
	const fnErr = await failure(`const f = () => 1\nreturn f`);
	assert.equal(fnErr?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);

	const cycleErr = await failure(`const a = []\na.push(a)\nreturn a`);
	assert.equal(cycleErr?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);

	const nestedErr = await failure(`const f = () => 1\nreturn { inner: [f] }`);
	assert.equal(nestedErr?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("interpreter is defensively isolated even with skipValidation", async () => {
	const err = await failure(`return typeof process`, { skipValidation: true });
	assert.equal(err?.code, ErrorCodes.SCRIPT_UNKNOWN_API);
});

test("parallel runs tasks concurrently within the cap", async () => {
	const handle = makeFakeRunner({ delayMs: 5 });
	const result = await run(
		`
const out = await parallel([() => agent('a'), () => agent('b'), () => agent('c')])
return out.map(r => r.index)
`,
		{ runner: handle.runner },
	);
	assert.deepEqual(result.value, [0, 1, 2]);
	assert.ok(handle.maxConcurrent >= 2, "parallel should overlap");
	assert.ok(handle.maxConcurrent <= DEFAULT_CONCURRENCY);
});

test("pipeline onError continue: 失败项收集，其余完成", async () => {
	const handle = makeFakeRunner({ failOn: "t1" });
	const result = await run(
		`
const out = await pipeline([0,1,2], (i) => agent(\`t\${i}\`), { onError: 'continue' })
return out
`,
		{ runner: handle.runner },
	);
	const out = result.value as { results: unknown[]; failures: Array<{ index: number; code: string; message: string }> };
	assert.deepEqual(out.results[0], { ok: true, index: 0, label: null });
	assert.equal(out.results[1], undefined, "failed item keeps an empty slot");
	assert.deepEqual(out.results[2], { ok: true, index: 2, label: null });
	assert.equal(out.failures.length, 1);
	assert.equal(out.failures[0]!.index, 1);
	assert.equal(out.failures[0]!.code, "SCRIPT_RUNTIME_ERROR");
	assert.ok(out.failures[0]!.message.includes("runner failure on"), "failure carries the wrapped message");
	assert.equal(handle.calls.length, 3, "all items executed despite the failure");
});

test("pipeline onError 缺省 fail 保持 abort 语义", async () => {
	const handle = makeFakeRunner({ failOn: "t1" });
	const err = await failure(
		`const out = await pipeline([0,1,2], (i) => agent(\`t\${i}\`))\nreturn out`,
		{ runner: handle.runner },
	);
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("pipeline onError continue 不吞中止", async () => {
	const ac = new AbortController();
	const p = run(
		`const out = await pipeline([0,1], (i) => sleep(5000), { onError: 'continue' })\nreturn out`,
		{ signal: ac.signal },
	);
	setTimeout(() => ac.abort(), 50);
	const err = await p.then(
		() => null,
		(e: unknown) => e as { code?: string },
	);
	assert.equal(err?.code, ErrorCodes.SCRIPT_ABORTED, "continue must not swallow run-level aborts");
});

test("pipeline onError 非法值拒绝", async () => {
	const handle = makeFakeRunner();
	const err = await failure(`await pipeline([0], (i) => agent('t'), { onError: 'bogus' })`, { runner: handle.runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.equal(handle.calls.length, 0, "runner must not be invoked with invalid options");
});

test("parallel onError continue: 失败收集、成功保留", async () => {
	const handle = makeFakeRunner({ failOn: "boom" });
	const result = await run(
		`
const out = await parallel([() => agent('a'), () => agent('boom')], { onError: 'continue' })
return out
`,
		{ runner: handle.runner },
	);
	const out = result.value as { results: unknown[]; failures: Array<{ index: number; code: string; message: string }> };
	assert.deepEqual(out.results[0], { ok: true, index: 0, label: null });
	assert.equal(out.results[1], undefined);
	assert.equal(out.failures.length, 1);
	assert.equal(out.failures[0]!.index, 1);
	assert.equal(out.failures[0]!.code, "SCRIPT_RUNTIME_ERROR");
	assert.ok(out.failures[0]!.message.includes("runner failure on"));
	assert.equal(handle.calls.length, 2);
});

test("parallel onError 非法值拒绝", async () => {
	const handle = makeFakeRunner();
	const err = await failure(`await parallel([() => agent('a')], { onError: 'bogus' })`, { runner: handle.runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.equal(handle.calls.length, 0, "runner must not be invoked with invalid options");
});

test("loop budget counts across nested loops", async () => {
	const err = await failure(
		`for (let i = 0; i < 100; i++) { for (let j = 0; j < 100; j++) {} }`,
		{ maxLoopIterations: 500 },
	);
	assert.equal(err?.code, ErrorCodes.SCRIPT_LOOP_LIMIT_EXCEEDED);
});

test("interpreter does not leak host objects into results", async () => {
	const result = await run(`const o = { a: 1 }\nreturn JSON.stringify(o)`);
	assert.equal(result.value, '{"a":1}');
});

test("agent() results are sanitized: host objects / inherited methods / accessors rejected", async () => {
	// runner returns the real Node `process` object → rejected at the boundary
	const processRunner = { run: async () => ({ result: process, summary: "ok" }) } as never;
	const err = await failure(`const host = await agent('probe')\nreturn host.cwd()`, { runner: processRunner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);

	// runner returns an object whose prototype carries methods → rejected
	const withMethod = Object.create({ cwd() { return "LEAK"; } });
	withMethod.foo = 1;
	const protoRunner = { run: async () => ({ result: withMethod, summary: "ok" }) } as never;
	const err2 = await failure(`const host = await agent('probe')\nreturn host.cwd()`, { runner: protoRunner });
	assert.equal(err2?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);

	// runner returns an object with a getter property → rejected
	const getterObj = { get secret() { return "LEAK"; } };
	const getterRunner = { run: async () => ({ result: getterObj, summary: "ok" }) } as never;
	const err3 = await failure(`const h = await agent('probe')\nreturn h.secret`, { runner: getterRunner });
	assert.equal(err3?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("agent() results are deep-cloned: script mutation cannot reach the runner's object", async () => {
	const original = { tags: ["a"], nested: { n: 1 } };
	const runner = { run: async () => ({ result: original, summary: "ok" }) } as never;
	const result = await run(
		`const r = await agent('probe')\nr.tags.push('x')\nr.nested.n = 99\nreturn r`,
		{ runner },
	);
	assert.deepEqual(result.value, { tags: ["a", "x"], nested: { n: 99 } });
	assert.deepEqual(original, { tags: ["a"], nested: { n: 1 } }, "runner object must not be mutated");
});

test("plain agent() results still flow through after sanitization", async () => {
	const handle = makeFakeRunner({ result: () => ({ files: ["a.ts"], ok: true }) });
	const result = await run(`const r = await agent('list')\nreturn r.files`, { runner: handle.runner });
	assert.deepEqual(result.value, ["a.ts"]);
});

test("agent() results: array with own map override cannot leak host objects", async () => {
	// Reviewer repro: empty array with shadowed map -> clonePlain must not
	// call the input's own map, and the non-index own property must be
	// rejected at the boundary.
	const hostile: unknown[] = [];
	(hostile as { map?: unknown }).map = () => process;
	const runner = { run: async () => ({ result: hostile, summary: "ok" }) } as never;
	const err = await failure(`const host = await agent('probe')\nreturn host.cwd()`, { runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("agent() results: custom array subclass cannot leak host objects", async () => {
	class EvilArray extends Array<unknown> {}
	(EvilArray.prototype as { map?: unknown }).map = () => [process];
	const runner = { run: async () => ({ result: new EvilArray(1), summary: "ok" }) } as never;
	const err = await failure(`const host = await agent('probe')\nreturn host.cwd()`, { runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("agent() results: array with accessor element cannot leak host objects", async () => {
	const arr: unknown[] = [1];
	Object.defineProperty(arr, "1", { enumerable: true, configurable: true, get: () => process });
	const runner = { run: async () => ({ result: arr, summary: "ok" }) } as never;
	const err = await failure(`const h = await agent('probe')\nreturn h[1]`, { runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("agent() results: array with overridden iterator is copied by index (no leak)", async () => {
	let called = false;
	const hostile: unknown[] = [1, 2];
	hostile[Symbol.iterator] = function* (): Generator<unknown, undefined, unknown> {
		called = true;
		yield process;
		return undefined;
	};
	const runner = { run: async () => ({ result: hostile, summary: "ok" }) } as never;
	const result = await run(`const h = await agent('probe')\nreturn h`, { runner });
	assert.deepEqual(result.value, [1, 2]);
	assert.equal(called, false, "the array's own iterator must never be invoked");
});

test("agent() results: Proxy TOCTOU (validate vs clone phases) cannot leak host objects", async () => {
	// Reviewer repro: the proxy answers the first read with a plain value and
	// the second read with { leak: () => process }. The single-pass snapshot
	// rejects the captured function value — h[0].leak().cwd() must fail.
	let reads = 0;
	const target = [0];
	const proxy = new Proxy(target, {
		getOwnPropertyDescriptor(t, prop) {
			reads++;
			if (prop === "0") {
				return reads === 1
					? { value: 1, enumerable: true, configurable: true }
					: { value: { leak: () => process }, enumerable: true, configurable: true };
			}
			return Reflect.getOwnPropertyDescriptor(t, prop);
		},
	});
	const runner = { run: async () => ({ result: proxy, summary: "ok" }) } as never;
	const err = await failure(`const h = await agent('probe')\nreturn h[0].leak().cwd()`, { runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("agent() results: proxy whose values are never read via the get trap", async () => {
	const target = [{ a: 1 }, 2];
	const proxy = new Proxy(target, {
		get(_t, prop) {
			throw new Error(`get trap must not be invoked: ${String(prop)}`);
		},
	});
	const runner = { run: async () => ({ result: proxy, summary: "ok" }) } as never;
	const result = await run(`const h = await agent('probe')\nreturn h`, { runner });
	assert.deepEqual(result.value, [{ a: 1 }, 2]);
});

test("args boundary: proxy with function values cannot smuggle into the script", async () => {
	const target = [0];
	const proxy = new Proxy(target, {
		getOwnPropertyDescriptor(t, prop) {
			if (prop === "0") {
				return { value: () => process, enumerable: true, configurable: true };
			}
			return Reflect.getOwnPropertyDescriptor(t, prop);
		},
	});
	const err = await failure(`return args[0]`, { args: proxy as never });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("agent() options are snapshotted once at the boundary (no re-read)", async () => {
	const handle = makeFakeRunner();
	const result = await run(
		`
const opts = { label: 'l1', tools: 'readonly', schema: { type: 'object' } }
const r = await agent('x', opts)
opts.label = 'mutated'
opts.schema.nested = 1
return r
`,
		{ runner: handle.runner },
	);
	assert.equal(handle.calls[0]?.label, "l1");
	assert.deepEqual(handle.calls[0]?.schema, { type: "object" }, "runner must see the captured snapshot");
	assert.ok(result.value !== undefined);
});

test("agent() options: non-plain values inside options are rejected at the boundary", async () => {
	const handle = makeFakeRunner();
	const err = await failure(`await agent('x', { label: 1, fn: () => 1 })`, { runner: handle.runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.equal(handle.calls.length, 0, "runner must not be invoked with invalid options");
});

test("agent() options.model passes through to the runner; non-string model rejected", async () => {
	const handle = makeFakeRunner();
	const result = await run(`const r = await agent('probe', { model: 'm1' })\nreturn r.ok`, { runner: handle.runner });
	assert.deepEqual(result.value, true);
	assert.equal(handle.calls.length, 1);
	assert.equal(handle.calls[0]!.model, "m1", "spec.model must reach the runner");

	// absent model stays undefined (runner falls back to PWR default)
	const h2 = makeFakeRunner();
	await run(`await agent('probe')`, { runner: h2.runner });
	assert.equal(h2.calls[0]!.model, undefined);

	// non-string model is rejected before the runner is invoked
	const h3 = makeFakeRunner();
	const err = await failure(`await agent('probe', { model: 42 })`, { runner: h3.runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.equal(h3.calls.length, 0, "runner must not be invoked with an invalid model");
});

test("try/finally without catch propagates agent failures", async () => {
	const handle = makeFakeRunner({ failOn: "boom" });
	const err = await failure(`try { await agent('boom') } finally { await sleep(0) }`, { runner: handle.runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("agent failures propagate through nested finally blocks", async () => {
	const handle = makeFakeRunner({ failOn: "boom" });
	const err = await failure(
		`try { try { await agent('boom') } finally { await sleep(0) } } finally { await sleep(0) }`,
		{ runner: handle.runner },
	);
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});

test("finally runs exactly once for return/break/continue/throw control flows", async () => {
	// return
	const h1 = makeFakeRunner();
	const r1 = await run(`try { return 'done' } finally { await agent('cleanup') }`, { runner: h1.runner });
	assert.equal(r1.value, "done");
	assert.equal(h1.calls.length, 1, "return: finally must run exactly once");
	assert.equal(h1.calls[0]!.prompt, "cleanup");

	// break
	const h2 = makeFakeRunner();
	const r2 = await run(
		`for (let i = 0; i < 3; i++) { try { break } finally { await agent('break-cleanup') } }\nreturn 'after'`,
		{ runner: h2.runner },
	);
	assert.equal(r2.value, "after");
	assert.equal(h2.calls.length, 1, "break: finally must run exactly once");

	// continue (two loop iterations → exactly one finalizer run each)
	const h3 = makeFakeRunner();
	const r3 = await run(
		`let n = 0\nfor (let i = 0; i < 2; i++) { try { continue } finally { n++; await agent('cont-cleanup') } }\nreturn n`,
		{ runner: h3.runner },
	);
	assert.equal(r3.value, 2);
	assert.equal(h3.calls.length, 2, "continue: finally runs exactly once per iteration");

	// throw
	const h4 = makeFakeRunner();
	const err = await failure(`try { throw 'boom' } finally { await agent('throw-cleanup') }`, { runner: h4.runner });
	assert.equal(err?.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.equal(h4.calls.length, 1, "throw: finally must run exactly once");
});
