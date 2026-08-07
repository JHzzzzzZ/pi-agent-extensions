/**
 * PWR - saved-workflow arguments (JHL-17 goal 2)
 *
 * `/workflow:<name> <args>` input is turned into a structured `args` global:
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
 * Parses the raw argument text of `/workflow:<name> <args>`.
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
