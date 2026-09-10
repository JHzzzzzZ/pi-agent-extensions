/**
 * PWR - saved-workflow arguments (JHL-17 goal 2)
 *
 * `/workflow run <name> [args]` input is turned into a structured `args` global:
 *  - empty input  -> `undefined` (PRD §5.5: no args is `undefined`)
 *  - non-empty    -> JSON.parse (objects, arrays and scalars are all valid)
 * When the saved script declares `meta.argsSchema`, the parsed value is
 * validated against a JSON-schema subset BEFORE the run is created; an
 * invalid value returns ARGS_INVALID / ARGS_SCHEMA_VIOLATION and the run is
 * never started.
 */

import { ErrorCode, errorMessage, type ErrorCodeValue } from "./errors.ts";

export type ArgsResult = { ok: true; value: unknown } | { ok: false; code: ErrorCodeValue; message: string };

/**
 * Parses the raw argument text of `/workflow run <name> [args]`.
 * Empty text yields `undefined` (no args). Anything else must be valid JSON;
 * otherwise ARGS_INVALID is returned and the workflow is not started.
 * The failure message is the STATIC template — raw input (which may contain
 * tokens/passwords inside unclosed JSON) is never echoed back (PRD §6.2).
 */
export function parseCommandArgs(raw: string | undefined): ArgsResult {
	const text = (raw ?? "").trim();
	if (!text) return { ok: true, value: undefined };
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return {
			ok: false,
			code: ErrorCode.ARGS_INVALID,
			message: errorMessage(ErrorCode.ARGS_INVALID),
		};
	}
}

/** JSON-schema subset the PWR args validator understands. */
interface PwrJsonSchema {
	type?: string | string[];
	properties?: Record<string, PwrJsonSchema>;
	required?: string[];
	items?: PwrJsonSchema;
	enum?: unknown[];
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
	additionalProperties?: boolean;
}

function argsInvalid(): ArgsResult {
	return { ok: false, code: ErrorCode.ARGS_INVALID, message: errorMessage(ErrorCode.ARGS_INVALID) };
}

function declaredTypes(prop: unknown): string[] {
	const s = prop as PwrJsonSchema | undefined;
	if (!s || typeof s !== "object") return [];
	return Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
}

function isBooleanProp(prop: unknown): boolean {
	const types = declaredTypes(prop);
	return types.length > 0 && types.every((t) => t === "boolean");
}

function isArrayProp(prop: unknown): boolean {
	return declaredTypes(prop).includes("array");
}

function itemsSchemaOf(prop: unknown): unknown {
	return (prop as PwrJsonSchema | undefined)?.items;
}

/** Splits on whitespace while honouring "double" and 'single' quotes. */
function tokenizeArgs(text: string): { tokens: string[]; unbalanced: boolean } {
	const tokens: string[] = [];
	let i = 0;
	while (i < text.length) {
		while (i < text.length && /\s/.test(text[i])) i++;
		if (i >= text.length) break;
		let token = "";
		let quote: string | null = null;
		while (i < text.length) {
			const ch = text[i];
			if (quote) {
				if (ch === quote) {
					quote = null;
					i++;
					continue;
				}
				token += ch;
				i++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				i++;
				continue;
			}
			if (/\s/.test(ch)) break;
			token += ch;
			i++;
		}
		if (quote) return { tokens: [], unbalanced: true };
		tokens.push(token);
	}
	return { tokens, unbalanced: false };
}

/** Coerces one scalar token against a property schema (number/boolean; else string). */
function coerceScalar(raw: string, prop: unknown): { ok: true; value: unknown } | { ok: false } {
	const types = declaredTypes(prop);
	if (types.includes("number") || types.includes("integer")) {
		if (raw === "" || !Number.isFinite(Number(raw))) return { ok: false };
		return { ok: true, value: Number(raw) };
	}
	if (types.length > 0 && types.every((t) => t === "boolean")) {
		if (raw === "true") return { ok: true, value: true };
		if (raw === "false") return { ok: true, value: false };
		return { ok: false };
	}
	return { ok: true, value: raw };
}

/** Coerces one `key=value` value against a property (array props accept comma lists). */
function coerceTokenValue(raw: string, prop: unknown): { ok: true; value: unknown } | { ok: false } {
	if (isArrayProp(prop)) {
		const parts = raw === "" ? [] : raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
		const values: unknown[] = [];
		for (const part of parts) {
			const coerced = coerceScalar(part, itemsSchemaOf(prop));
			if (!coerced.ok) return { ok: false };
			values.push(coerced.value);
		}
		return { ok: true, value: values };
	}
	return coerceScalar(raw, prop);
}

function assignValue(out: Record<string, unknown>, key: string, value: unknown, prop: unknown): void {
	if (isArrayProp(prop)) {
		const arr = Array.isArray(out[key]) ? (out[key] as unknown[]) : [];
		if (Array.isArray(value)) arr.push(...value);
		else arr.push(value);
		out[key] = arr;
	} else {
		out[key] = value;
	}
}

/**
 * Positional sugar: exactly one required property, of type string or
 * array<string> — the whole input (no `=` anywhere) becomes that property.
 */
function findPositionalProp(objSchema: PwrJsonSchema | undefined): string | undefined {
	if (!objSchema || objSchema.type !== "object") return undefined;
	const required = objSchema.required ?? [];
	if (required.length !== 1) return undefined;
	const prop = objSchema.properties?.[required[0]];
	if (!prop) return undefined;
	const types = declaredTypes(prop);
	if (types.length === 0 || !types.every((t) => t === "string" || t === "array")) return undefined;
	if (types.includes("array")) {
		const itemTypes = declaredTypes(itemsSchemaOf(prop));
		if (itemTypes.length > 0 && !itemTypes.every((t) => t === "string")) return undefined;
	}
	return required[0];
}

/**
 * Parses raw args with schema-guided ergonomics (JSON stays fully
 * compatible):
 *  - empty               -> `undefined`
 *  - starts with `{`/`[` -> JSON (unchanged behaviour, ARGS_INVALID on error)
 *  - otherwise           -> `key=value` tokens: numbers/booleans coerced by
 *     the declared schema, repeated keys accumulate into arrays, array
 *     properties accept `key=a,b` comma lists, a bare key on a boolean
 *     property means `true`, quoted values keep whitespace. With exactly
 *     one required string/array<string> property, bare text is positional.
 * Raw input is never echoed back (PRD §6.2); the result still goes through
 * validateArgsAgainstSchema in the caller.
 */
export function parseCommandArgsSmart(raw: string | undefined, schema: unknown): ArgsResult {
	const text = (raw ?? "").trim();
	if (!text) return { ok: true, value: undefined };
	if (text.startsWith("{") || text.startsWith("[")) return parseCommandArgs(raw);

	const objSchema = schema !== null && typeof schema === "object" ? (schema as PwrJsonSchema) : undefined;
	const props = objSchema?.properties ?? {};

	const { tokens, unbalanced } = tokenizeArgs(text);
	if (unbalanced) return argsInvalid();

	if (tokens.every((t) => !t.includes("="))) {
		const positional = findPositionalProp(objSchema);
		if (!positional) return argsInvalid();
		const prop = props[positional];
		const types = declaredTypes(prop);
		const value = types.includes("array") && !types.includes("string") ? text.split(/\s+/).filter(Boolean) : text;
		return { ok: true, value: { [positional]: value } };
	}

	const out: Record<string, unknown> = {};
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq <= 0) {
			if (token in props && isBooleanProp(props[token])) {
				out[token] = true;
				continue;
			}
			return argsInvalid();
		}
		const key = token.slice(0, eq);
		const rawValue = token.slice(eq + 1);
		if (!(key in props)) {
			if (objSchema?.additionalProperties === false) return argsInvalid();
			assignValue(out, key, rawValue, undefined);
			continue;
		}
		const coerced = coerceTokenValue(rawValue, props[key]);
		if (!coerced.ok) return argsInvalid();
		assignValue(out, key, coerced.value, props[key]);
	}
	return { ok: true, value: out };
}

function itemTypeText(prop: unknown): string {
	const itemTypes = declaredTypes(itemsSchemaOf(prop));
	return itemTypes.join("|") || "any";
}

/**
 * One-line usage hint derived from a declared args schema, e.g.
 * `files=string[] depth?=number` (`?` marks optional properties). Undefined
 * when the schema is absent or not an object schema.
 */
export function argsSchemaHint(schema: unknown): string | undefined {
	const s = schema as PwrJsonSchema | undefined;
	if (!s || typeof s !== "object" || s.type !== "object" || !s.properties) return undefined;
	const required = new Set(s.required ?? []);
	const parts: string[] = [];
	for (const [name, prop] of Object.entries(s.properties)) {
		const types = declaredTypes(prop);
		const typeText = types.includes("array") ? `${itemTypeText(prop)}[]` : types.join("|") || "any";
		parts.push(`${name}${required.has(name) ? "" : "?"}=${typeText}`);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}

const TYPE_OF_ARRAY = "array";

function typeName(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return TYPE_OF_ARRAY;
	return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case TYPE_OF_ARRAY:
			return Array.isArray(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
			return typeof value === "number";
		case "string":
			return typeof value === "string";
		case "boolean":
			return typeof value === "boolean";
		case "null":
			return value === null;
		default:
			// Unknown declared type: no constraint (schema author error, not a run blocker).
			return true;
	}
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function validateValue(value: unknown, schema: PwrJsonSchema | undefined, pointer: string): string | null {
	if (!schema || typeof schema !== "object") return null;

	if (schema.enum !== undefined && Array.isArray(schema.enum)) {
		if (!schema.enum.some((candidate) => deepEqual(candidate, value))) {
			return `Value at ${pointer} is not one of the allowed enum values.`;
		}
	}

	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	if (types.length > 0) {
		if (types.includes("integer") && types.includes("number") && typeof value === "number" && !Number.isInteger(value)) {
			return `Value at ${pointer} must be an integer.`;
		}
		if (!types.some((t) => matchesType(value, t))) {
			return `Value at ${pointer} must be of type ${types.join(" or ")}; got ${typeName(value)}.`;
		}
	}

	if (schema.type === "object" || (types.includes("object") && typeName(value) === "object")) {
		const obj = value as Record<string, unknown>;
		for (const requiredKey of schema.required ?? []) {
			if (!Object.prototype.hasOwnProperty.call(obj, requiredKey)) {
				return `Missing required property "${requiredKey}" at ${pointer}.`;
			}
		}
		const props = schema.properties ?? {};
		for (const key of Object.keys(obj)) {
			if (key in props) {
				const err = validateValue(obj[key], props[key], `${pointer}.${key}`);
				if (err) return err;
			} else if (schema.additionalProperties === false) {
				return `Unexpected property "${key}" at ${pointer} (additionalProperties is false).`;
			}
		}
	}

	if ((schema.type === TYPE_OF_ARRAY || (types.includes(TYPE_OF_ARRAY) && Array.isArray(value))) && Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			return `Value at ${pointer} must have at least ${schema.minItems} item(s).`;
		}
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			return `Value at ${pointer} must have at most ${schema.maxItems} item(s).`;
		}
		if (schema.items) {
			for (let i = 0; i < value.length; i++) {
				const err = validateValue(value[i], schema.items, `${pointer}[${i}]`);
				if (err) return err;
			}
		}
	}

	if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
		return `Value at ${pointer} must be at least ${schema.minLength} character(s) long.`;
	}
	if (typeof value === "string" && typeof schema.maxLength === "number" && value.length > schema.maxLength) {
		return `Value at ${pointer} must be at most ${schema.maxLength} character(s) long.`;
	}

	if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
		return `Value at ${pointer} must be >= ${schema.minimum}.`;
	}
	if (typeof value === "number" && typeof schema.maximum === "number" && value > schema.maximum) {
		return `Value at ${pointer} must be <= ${schema.maximum}.`;
	}

	return null;
}

/**
 * Validates parsed args against the saved script's `meta.argsSchema`.
 * Returns the value on success; on failure ARGS_SCHEMA_VIOLATION with a
 * pointer into the offending value (never the full value, so no script/arg
 * content is echoed into error messages beyond a property name).
 */
export function validateArgsAgainstSchema(value: unknown, schema: unknown): ArgsResult {
	if (schema === undefined || schema === null) return { ok: true, value };
	const error = validateValue(value, schema as PwrJsonSchema, "$");
	if (error) {
		return { ok: false, code: ErrorCode.ARGS_SCHEMA_VIOLATION, message: error };
	}
	return { ok: true, value };
}
