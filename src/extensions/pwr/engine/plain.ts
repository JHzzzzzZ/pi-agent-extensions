/**
 * Plain-data utilities for host boundaries.
 *
 * Anything crossing a host/script boundary (caller args, agent() results,
 * tool params) must be inert JSON-ish data: plain objects (prototype is
 * exactly Object.prototype or null), standard arrays (prototype is exactly
 * Array.prototype or null) and primitives — no functions, symbols, bigints,
 * accessors, cycles, inherited properties, forbidden property names or
 * shadowed built-in methods.
 *
 * SINGLE-PASS SNAPSHOT SEMANTICS (TOCTOU-hard):
 * `sanitizeHostValue` validates AND clones in ONE traversal. Every own
 * property is captured exactly once, from its own-property descriptor's
 * `value` field, and that captured value is recursively validated at capture
 * time. The original host value is NEVER re-read afterwards — no `value[i]`,
 * no `value[key]`, no iterators, no method calls. A hostile Proxy that
 * returns different values on different reads therefore cannot smuggle
 * anything through: whatever is captured is what is checked, and whatever is
 * checked is the only thing that survives.
 */

import { ErrorCodes, ScriptError } from "./errors.ts";
import { FORBIDDEN_PROPERTY_NAMES } from "./spec.ts";

/** True for objects whose prototype is exactly `Object.prototype` or `null`. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

/** True for arrays whose prototype is exactly `Array.prototype` or `null`. */
export function isPlainArray(value: unknown): value is unknown[] {
	if (!Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Array.prototype || proto === null;
}

/**
 * True when `key` is a canonical array index ("0".."4294967294").
 * Rejects "01", "1e2", "-0", "4294967295" and any other non-index spelling.
 */
export function isArrayIndexKey(key: string): boolean {
	if (key.length === 0 || key === "4294967295") return false;
	const n = Number(key);
	return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === key;
}

/**
 * Single-pass validate-and-clone. Each own enumerable property is captured
 * once via `Object.getOwnPropertyDescriptor(value, key).value` and validated
 * recursively at capture; the output is built exclusively from those captured
 * values. Never reads the input again after capture.
 */
export function snapshotPlain(value: unknown, seen?: Set<unknown>): unknown {
	if (value === null) return null;
	switch (typeof value) {
		case "undefined":
		case "boolean":
		case "number":
		case "string":
			return value;
		case "function":
		case "symbol":
		case "bigint":
			throw new ScriptError(
				ErrorCodes.SCRIPT_RUNTIME_ERROR,
				`返回值必须是纯数据（发现 ${typeof value}）`,
			);
		default:
			break;
	}
	if (seen?.has(value)) {
		throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, "返回值包含循环引用");
	}
	const nextSeen = seen ?? new Set<unknown>();
	nextSeen.add(value);

	if (isPlainArray(value)) {
		// Capture own enumerable keys ONCE, then snapshot each descriptor's
		// value. No `value[i]` reads and no `value.length` — the output size
		// is derived from the captured keys, so shadowed/lying proxies cannot
		// steer allocation or smuggle values.
		const keys = Object.keys(value);
		let maxIndex = -1;
		for (const key of keys) {
			if (!isArrayIndexKey(key)) {
				throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, `返回值包含非索引属性 "${key}"`);
			}
			const n = Number(key);
			if (n > maxIndex) maxIndex = n;
		}
		const out: unknown[] = new Array(maxIndex + 1);
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor) continue; // hole / phantom key
			if (descriptor.get !== undefined || descriptor.set !== undefined) {
				throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, `返回值包含访问器属性 "${key}"`);
			}
			out[Number(key)] = snapshotPlain(descriptor.value, nextSeen);
		}
		return out;
	}
	if (Array.isArray(value)) {
		// Non-standard array prototypes are rejected.
		throw new ScriptError(
			ErrorCodes.SCRIPT_RUNTIME_ERROR,
			"返回值必须是纯数据（数组原型必须是 Array.prototype 或 null）",
		);
	}
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			if (FORBIDDEN_PROPERTY_NAMES.has(key)) {
				throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, `返回值包含禁止的属性 "${key}"`);
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor) continue;
			if (descriptor.get !== undefined || descriptor.set !== undefined) {
				throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, `返回值包含访问器属性 "${key}"`);
			}
			out[key] = snapshotPlain(descriptor.value, nextSeen);
		}
		return out;
	}
	throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, "返回值必须是纯数据（对象/数组/基本类型）");
}

/**
 * Validation-only check (no clone). Implemented as a snapshot whose result is
 * discarded: the traversal rules, capture semantics and error codes are
 * identical to `snapshotPlain`.
 */
export function assertPlainData(value: unknown, seen?: Set<unknown>): void {
	snapshotPlain(value, seen);
}

/**
 * Validate + deep-clone a value crossing a host boundary (args, agent
 * results). Single-pass: the input is read exactly once per property, so
 * hostile Proxies cannot play validation and cloning against each other.
 */
export function sanitizeHostValue(value: unknown): unknown {
	return snapshotPlain(value);
}
