/**
 * Plain-data boundary unit tests — the sanitizer must never invoke methods
 * on input values (shadowed `map`/iterators), must reject non-standard array
 * prototypes, array accessors and non-index own properties, and must accept
 * standard arrays with a deep, isolated clone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assertPlainData,
	isArrayIndexKey,
	isPlainArray,
	sanitizeHostValue,
	snapshotPlain,
} from "../engine/plain.ts";
import { ErrorCodes } from "../engine/errors.ts";

function expectReject(fn: () => unknown): { code?: string; message?: string } {
	try {
		fn();
	} catch (err) {
		return err as { code?: string; message?: string };
	}
	assert.fail("expected rejection");
}

test("sanitizeHostValue: array with own map override is rejected (no host leak)", () => {
	const hostile: unknown[] = [];
	(hostile as { map?: unknown }).map = () => process;
	const err = expectReject(() => sanitizeHostValue(hostile));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err.message ?? "", /非索引/);
});

test("sanitizeHostValue: array with own non-index property is rejected", () => {
	const hostile: unknown[] = [1];
	(hostile as { owner?: unknown }).owner = { secret: 1 };
	const err = expectReject(() => sanitizeHostValue(hostile));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err.message ?? "", /非索引/);
});

test("sanitizeHostValue: array accessor element is rejected", () => {
	const arr: unknown[] = [1];
	Object.defineProperty(arr, "1", { enumerable: true, configurable: true, get: () => process });
	const err = expectReject(() => sanitizeHostValue(arr));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err.message ?? "", /访问器/);
});

test("sanitizeHostValue: custom array subclass is rejected", () => {
	class EvilArray extends Array<unknown> {}
	(EvilArray.prototype as { map?: unknown }).map = () => [process];
	const err = expectReject(() => sanitizeHostValue(new EvilArray(1, 2)));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err.message ?? "", /数组原型/);
});

test("sanitizeHostValue: overridden Symbol.iterator is never invoked (no leak)", () => {
	let called = false;
	const hostile: unknown[] = [1, 2];
	hostile[Symbol.iterator] = function* (): Generator<unknown, undefined, unknown> {
		called = true;
		yield process;
		return undefined;
	};
	const copy = sanitizeHostValue(hostile) as unknown[];
	assert.deepEqual(copy, [1, 2]);
	assert.equal(called, false, "the array's own iterator must never be invoked");
});

test("sanitizeHostValue: plain arrays pass and are deep-cloned without method calls", () => {
	const original = [1, { a: [2, 3] }, "x", null, true];
	const copy = sanitizeHostValue(original) as unknown[];
	assert.deepEqual(copy, original);
	assert.notEqual(copy, original);
	(copy[1] as { a: number[] }).a.push(9);
	assert.deepEqual(original[1], { a: [2, 3] }, "clone must isolate the caller's array");
	assert.equal(isPlainArray(original), true);
});

test("sanitizeHostValue: null-prototype array is accepted and cloned", () => {
	const arr: unknown[] = [1, { b: 2 }];
	Object.setPrototypeOf(arr, null);
	assert.equal(isPlainArray(arr), true);
	const copy = sanitizeHostValue(arr) as unknown[];
	assert.deepEqual(copy, [1, { b: 2 }]);
});

test("snapshotPlain: array with shadowed map is rejected (non-index own property)", () => {
	const hostile: unknown[] = [1, 2];
	(hostile as { map?: unknown }).map = () => [process];
	const err = expectReject(() => snapshotPlain(hostile));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err.message ?? "", /非索引/);
});

test("snapshotPlain defensive backstop: non-standard array prototype throws", () => {
	class Weird extends Array<unknown> {}
	assert.throws(() => snapshotPlain(new Weird(1)), (err: unknown) => {
		assert.ok(err instanceof Error);
		assert.match(err.message, /数组原型/);
		return true;
	});
});

test("sanitizeHostValue: Proxy TOCTOU (different value per read) is not exploitable", () => {
	// The gopd trap returns a plain value on the first read (Object.keys
	// enumerability probe) and a function-bearing object on the second read
	// (the snapshot capture). The single-pass snapshot must reject the
	// second-phase value instead of persisting it.
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
	const err = expectReject(() => sanitizeHostValue(proxy));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err.message ?? "", /function/);
});

test("sanitizeHostValue: never reads values back through the proxy after capture", () => {
	const target = [{ a: 1 }, 2];
	const proxy = new Proxy(target, {
		get(_t, prop) {
			// The snapshot must NEVER read element values via the get trap —
			// values come exclusively from own-property descriptors.
			throw new Error(`get trap must not be invoked: ${String(prop)}`);
		},
	});
	const out = sanitizeHostValue(proxy) as unknown[];
	assert.deepEqual(out, [{ a: 1 }, 2]);
});

test("sanitizeHostValue: proxy object returning a function on every read is rejected", () => {
	const target = [{ a: 1 }];
	const proxy = new Proxy(target, {
		getOwnPropertyDescriptor(t, prop) {
			if (prop === "0") {
				return { value: () => process, enumerable: true, configurable: true };
			}
			return Reflect.getOwnPropertyDescriptor(t, prop);
		},
	});
	const err = expectReject(() => sanitizeHostValue(proxy));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err.message ?? "", /function/);
});

test("isArrayIndexKey canonical index semantics", () => {
	for (const ok of ["0", "1", "99", "4294967294"]) {
		assert.equal(isArrayIndexKey(ok), true, ok);
	}
	for (const bad of ["", "01", "-1", "1e2", "1.5", "4294967295", "length", "map", "foo"]) {
		assert.equal(isArrayIndexKey(bad), false, bad);
	}
});

test("object branch: own method values are rejected (functions) and no input method is called", () => {
	const obj: Record<string, unknown> = { a: 1 };
	obj.toJSON = () => process;
	const err = expectReject(() => sanitizeHostValue(obj));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err.message ?? "", /function/);
});

test("object branch: accessors are rejected before any read", () => {
	const obj: Record<string, unknown> = {};
	Object.defineProperty(obj, "secret", { enumerable: true, get: () => process });
	const err = expectReject(() => sanitizeHostValue(obj));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
	assert.match(err.message ?? "", /访问器/);
});

test("assertPlainData: nested hostile arrays inside objects are rejected", () => {
	const hostile: unknown[] = [];
	(hostile as { map?: unknown }).map = () => process;
	const err = expectReject(() => assertPlainData({ list: hostile }));
	assert.equal(err.code, ErrorCodes.SCRIPT_RUNTIME_ERROR);
});
