/**
 * ScriptValidator unit tests — subset acceptance, dangerous-construct
 * rejection, unknown-API rejection and error positioning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScript, extractPlan } from "../engine/validator.ts";
import { parseScript } from "../engine/parser.ts";
import { ErrorCodes } from "../engine/errors.ts";
import { PRD_SAMPLE } from "./helpers.ts";

function codes(source: string): string[] {
	return validateScript(source).errors.map((e) => e.code);
}

function firstError(source: string) {
	return validateScript(source).errors[0];
}

/** Extract the source text under a diagnostic position. */
function sourceAt(source: string, offset: number | undefined, length = 24): string {
	if (offset === undefined) return "";
	return source.slice(offset, offset + length);
}

test("PRD §5.1 sample validates and exposes meta + plan", () => {
	const result = validateScript(PRD_SAMPLE);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.deepEqual(result.meta, {
		name: "audit-routes",
		description: "审查路由鉴权并交叉验证",
		version: 1,
	});
	const plan = result.plan ?? [];
	assert.ok(plan.length >= 3);
	assert.equal(plan[0]!.type, "agent");
	assert.equal(plan[0]!.label, "discover");
	assert.equal(plan[1]!.type, "pipeline");
	assert.equal(plan[1]!.concurrency, 8);
	assert.equal(plan[plan.length - 1]!.type, "agent");
	assert.equal(plan[plan.length - 1]!.label, "verify");
});

test("module loading is rejected: require / import / import()", () => {
	for (const src of [
		`const fs = require('fs')`,
		`require('child_process')`,
		`import fs from 'fs'`,
		`import('fs')`,
		`import { readFile } from 'node:fs'`,
	]) {
		const err = firstError(src);
		assert.equal(err?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, src);
		assert.ok(err?.start, `position expected for: ${src}`);
	}
});

test("dangerous globals are rejected with position", () => {
	const cases: Array<[string, string]> = [
		[`process.exit(1)`, "process"],
		[`process.env.HOME`, "process"],
		[`globalThis.x = 1`, "globalThis"],
		[`eval('1+1')`, "eval"],
		[`Function('return 1')`, "Function"],
		[`new Function('x', 'return x')`, "Function"],
		[`const x = require`, "require"],
		[`fetch('http://x')`, "fetch"],
		[`setTimeout(f, 1000)`, "setTimeout"],
		[`child_process.exec('ls')`, "child_process"],
	];
	for (const [src, token] of cases) {
		const err = firstError(src);
		assert.equal(err?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, src);
		assert.ok(err?.start, `position expected for: ${src}`);
		const at = sourceAt(src, err?.start?.offset);
		assert.ok(at.includes(token), `expected '${token}' near error, got: '${at}' (${src})`);
	}
});

test("unknown APIs are rejected with SCRIPT_UNKNOWN_API and precise location", () => {
	const src = `const a = 1\naX(2)\nreturn agentX()`;
	const err = firstError(src);
	assert.equal(err?.code, ErrorCodes.SCRIPT_UNKNOWN_API);
	assert.ok(err?.start);
	const at = sourceAt(src, err?.start?.offset, 5);
	assert.equal(at, "aX(2)");
	assert.equal(err?.start?.line, 2);
});

test("unknown globals in expressions are rejected", () => {
	const err = firstError(`const x = notDeclared + 1`);
	assert.equal(err?.code, ErrorCodes.SCRIPT_UNKNOWN_API);
	assert.ok(err?.start);
	assert.ok(sourceAt(`const x = notDeclared + 1`, err?.start?.offset).includes("notDeclared"));
});

test("prototype / reflection access is rejected", () => {
	const cases: string[] = [
		`const obj = {}\nobj.__proto__`,
		`const obj = {}\nobj.__proto__.x = 1`,
		`const obj = {}\nobj.constructor`,
		`const obj = {}\nobj['constructor']`,
		`const obj = {}\nobj['__proto__']`,
		`const obj = {}\nobj.prototype`,
		`const obj = {}\nobj.constructor.prototype`,
		`Object.prototype.x`, // Object itself is also forbidden
		`{ __proto__: {} }`,
		`{ ['constructor']: 1 }`,
		`const f = () => 1\nf.call(null)`,
		`const f = () => 1\nf.apply(null, [])`,
		`const f = () => 1\nf.bind(null)`,
		`const f = () => 1\nconst obj = {}\nobj.__defineGetter__('x', f)`,
	];
	for (const src of cases) {
		const err = firstError(src);
		assert.equal(err?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, src);
		assert.ok(err?.start, `position expected for: ${src}`);
	}
});

test("dynamic code generation and reflection types are rejected", () => {
	const cases: string[] = [
		`class Foo {}`,
		`new Date()`,
		`new Map()`,
		`Proxy.revocable({}, {})`,
		`Reflect.get({}, 'x')`,
		`Symbol.iterator`,
		`/regex/`,
		`123n`,
	];
	for (const src of cases) {
		assert.equal(firstError(src)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, src);
	}
});

test("for...in is rejected; for/while/for-of accepted", () => {
	assert.equal(firstError(`const obj = {}\nfor (const k in obj) {}`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	for (const src of [
		`for (let i = 0; i < 3; i++) {}`,
		`let x = 0\nwhile (x < 3) { x++ }`,
		`let x = 0\ndo { x++ } while (x < 3)`,
		`const items = []\nfor (const item of items) {}`,
		`const items = []\nfor (const { a } of items) {}`,
	]) {
		assert.equal(validateScript(src).ok, true, src);
	}
});

test("await is only allowed on whitelisted APIs", () => {
	assert.equal(firstError(`await (1 + 1)`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(firstError(`await localFn()`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(firstError(`async function f() { await Promise.resolve() }`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	for (const src of [
		`await agent('x')`,
		`const items = []\nconst f = () => 1\nconst a = await pipeline(items, f, { concurrency: 2 })`,
		`await parallel([() => agent('x')])`,
		`await sleep(100)`,
		`async function f() { return await agent('x') }`,
	]) {
		assert.equal(validateScript(src).ok, true, src);
	}
});

test("shadowing whitelisted / forbidden names is rejected", () => {
	for (const src of [
		`const agent = 1`,
		`let meta = 1`,
		`const process = 1`,
		`function sleep() {}`,
		`const args = {}`,
	]) {
		assert.equal(firstError(src)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, src);
	}
});

test("this / super / generators / switch / labels / delete / void are rejected", () => {
	const cases: string[] = [
		`function f() { return this }`,
		`const f = () => this`,
		`class A { m() { return super.x } }`,
		`function* g() { yield 1 }`,
		`switch (x) { case 1: break }`,
		`loop: for (;;) { break loop }`,
		`delete obj.x`,
		`void 0`,
		`x instanceof Array`,
		`'a' in obj`,
		`const f = () => { const [a, b] = [1, 2]; return a }`, // sanity: destructuring is fine
	];
	for (const src of cases.slice(0, -1)) {
		assert.equal(firstError(src)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, src);
	}
	assert.equal(validateScript(cases[cases.length - 1]!).ok, true);
});

test("meta must be a literal object; export forms restricted", () => {
	assert.equal(firstError(`export const meta = { name: notALiteral }`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(firstError(`export const meta = 1`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(firstError(`export { meta }`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(firstError(`export default 1`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(firstError(`export const other = 1`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(firstError(`export const meta = { ...spread }`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(validateScript(`export const meta = { name: 'a', nested: { ok: true }, tags: [1, 'x'] }`).ok, true);
});

test("break/continue outside loops are rejected", () => {
	assert.equal(firstError(`if (x) { break }`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(firstError(`continue`)?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.equal(validateScript(`for (const i of [1,2]) { if (i > 1) break; continue }`).ok, true);
});

test("a rich valid script is accepted", () => {
	const src = `
export const meta = { name: 'rich', description: 'x', version: 2 }
const opts = { concurrency: 4, label: 'main' }
const items = [1, 2, 3, 4]
const doubled = items.map((x, i) => x * 2 + i)
const filtered = doubled.filter(x => x > 3)
const first = filtered[0] ?? -1
const name = args?.name ?? 'default'
const note = \`got \${first} items from \${items.length} (${'ok'})\`
let total = 0
for (let i = 0; i < filtered.length; i++) { total += filtered[i] }
let whileCount = 0
while (whileCount < 3) { whileCount++ }
const viaForOf = []
for (const item of items) { viaForOf.push(item) }
function helper(a, b = 10, ...rest) { return a + b + rest.length }
const obj = { total, note, [name]: helper(1) }
const { total: t2, note: n2 = 'none' } = obj
const [head, ...tail] = viaForOf
const merged = { ...obj, extra: true }
let arr2 = [0]
arr2 = [1, ...arr2]
try {
  if (obj.total > 0) throw 'boom'
} catch (e) {
  total = 0
} finally { total = total + 0 }
if (obj.total > 0) { obj.total = obj.total + 1 } else { obj.total = -1 }
const str = 'hello'.toUpperCase().toLowerCase().trim()
const parts = str.split('')
const json = JSON.stringify(obj)
const parsed = JSON.parse(json)
const chained = parsed?.total ?? parsed?.['total'] ?? 0
const result = { t2, n2, head, tail, merged, str, parts, json, chained, whileCount, viaForOf, name, note, first, doubled, filtered }
return result
`;
	const result = validateScript(src);
	assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});

test("multiple violations are all reported", () => {
	const result = validateScript(`eval('1')\nagentX()\nobj.__proto__`);
	assert.equal(result.ok, false);
	assert.equal(result.errors.length, 4);
	const codes = result.errors.map((e) => e.code);
	assert.ok(codes.includes(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX));
	assert.ok(codes.includes(ErrorCodes.SCRIPT_UNKNOWN_API));
});

test("syntax errors carry position", () => {
	const err = firstError(`const x = = 1`);
	assert.equal(err?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.ok((err?.start?.line ?? 0) > 0);
});

test("oversized scripts are rejected", () => {
	const big = `const x = 1\n`.repeat(40_000); // ~400 KB
	const err = firstError(big);
	assert.equal(err?.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
});

test("JSON is available; meta/args readable", () => {
	assert.equal(
		validateScript(`export const meta = { name: 'a' }\nreturn JSON.stringify(meta)`).ok,
		true,
	);
	assert.equal(validateScript(`return args.foo`).ok, true);
});

test("extractPlan works on raw AST", () => {
	const ast = parseScript(
		`await agent('a', { label: 'first' })\nawait pipeline(x, f, { concurrency: 3 })\nawait parallel([() => agent('b')])`,
	);
	const plan = extractPlan(ast);
	assert.deepEqual(
		plan.map((p) => [p.type, p.label ?? null, p.concurrency ?? null]),
		[
			["agent", "first", null],
			["pipeline", null, 3],
			["parallel", null, null],
			["agent", null, null],
		],
	);
});
