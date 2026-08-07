/**
 * JHL-17: /workflow:<name> args parsing and JSON-schema subset validation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ErrorCode } from "../src/errors.ts";
import { parseCommandArgs, validateArgsAgainstSchema } from "../src/args.ts";

test("args: empty input is undefined (no args)", () => {
	const r = parseCommandArgs("");
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.value, undefined);

	const blank = parseCommandArgs("   ");
	assert.equal(blank.ok, true);
	if (blank.ok) assert.equal(blank.value, undefined);

	const absent = parseCommandArgs(undefined);
	assert.equal(absent.ok, true);
	if (absent.ok) assert.equal(absent.value, undefined);
});

test("args: valid JSON object/array/scalar parse to structured values", () => {
	const obj = parseCommandArgs('{"files": ["src/a.ts"], "depth": 2}');
	assert.equal(obj.ok, true);
	if (obj.ok) assert.deepEqual(obj.value, { files: ["src/a.ts"], depth: 2 });

	const arr = parseCommandArgs('["a", "b"]');
	assert.equal(arr.ok, true);
	if (arr.ok) assert.deepEqual(arr.value, ["a", "b"]);

	const num = parseCommandArgs("42");
	assert.equal(num.ok, true);
	if (num.ok) assert.equal(num.value, 42);

	const str = parseCommandArgs('"hello"');
	assert.equal(str.ok, true);
	if (str.ok) assert.equal(str.value, "hello");

	const bool = parseCommandArgs("false");
	assert.equal(bool.ok, true);
	if (bool.ok) assert.equal(bool.value, false);
});

test("args: non-JSON input returns ARGS_INVALID", () => {
	const r = parseCommandArgs("hello world");
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.code, ErrorCode.ARGS_INVALID);

	const broken = parseCommandArgs('{"a": }');
	assert.equal(broken.ok, false);
	if (!broken.ok) assert.equal(broken.code, ErrorCode.ARGS_INVALID);
});

test("args: ARGS_INVALID message is a static template — never echoes raw input (no credential leak)", () => {
	// Unclosed JSON carrying a mock credential: the raw text must NOT appear
	// in the error message (PRD §6.2 / src/errors.ts no-secret-leak rule).
	const secret = "sk-live-0123456789abcdefSECRET";
	const raw = `{"token": "${secret}", "a": `;
	const r = parseCommandArgs(raw);
	assert.equal(r.ok, false);
	if (r.ok) return;
	assert.equal(r.code, ErrorCode.ARGS_INVALID);
	assert.ok(!r.message.includes(secret), "raw args must not be echoed into the message");
	assert.ok(!r.message.includes("sk-live"), "no fragment of the raw input either");
	assert.ok(!r.message.includes('"token"'), "no field names from the raw input");
	assert.ok(!r.message.includes(raw.slice(0, 10)), "no prefix of the raw input");
});

test("args schema: no schema accepts any structured value", () => {
	for (const value of [{ a: 1 }, [1, 2], "x", 5, null]) {
		const r = validateArgsAgainstSchema(value, undefined);
		assert.equal(r.ok, true);
	}
});

test("args schema: object type + required + properties", () => {
	const schema = {
		type: "object",
		required: ["files"],
		properties: { files: { type: "array", items: { type: "string" } }, depth: { type: "integer", minimum: 1 } },
		additionalProperties: false,
	};

	const ok = validateArgsAgainstSchema({ files: ["a.ts"], depth: 2 }, schema);
	assert.equal(ok.ok, true);

	const missing = validateArgsAgainstSchema({ depth: 2 }, schema);
	assert.equal(missing.ok, false);
	if (!missing.ok) {
		assert.equal(missing.code, ErrorCode.ARGS_SCHEMA_VIOLATION);
		assert.ok(missing.message.includes("files"), "error names the offending property");
	}

	const wrongType = validateArgsAgainstSchema({ files: "a.ts" }, schema);
	assert.equal(wrongType.ok, false);
	if (!wrongType.ok) assert.equal(wrongType.code, ErrorCode.ARGS_SCHEMA_VIOLATION);

	const unexpected = validateArgsAgainstSchema({ files: [], extra: 1 }, schema);
	assert.equal(unexpected.ok, false);
	if (!unexpected.ok) assert.ok(unexpected.message.includes("extra"));

	const nonInteger = validateArgsAgainstSchema({ files: [], depth: 1.5 }, schema);
	assert.equal(nonInteger.ok, false);
	if (!nonInteger.ok) assert.ok(nonInteger.message.includes("integer"));

	const tooSmall = validateArgsAgainstSchema({ files: [], depth: 0 }, schema);
	assert.equal(tooSmall.ok, false);
});

test("args schema: array items, minItems/maxItems, enum, string length", () => {
	const arraySchema = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 };
	assert.equal(validateArgsAgainstSchema(["x"], arraySchema).ok, true);
	assert.equal(validateArgsAgainstSchema([], arraySchema).ok, false);
	assert.equal(validateArgsAgainstSchema(["a", "b", "c", "d"], arraySchema).ok, false);
	assert.equal(validateArgsAgainstSchema([1], arraySchema).ok, false);

	const enumSchema = { enum: ["fast", "slow"] };
	assert.equal(validateArgsAgainstSchema("fast", enumSchema).ok, true);
	assert.equal(validateArgsAgainstSchema("medium", enumSchema).ok, false);

	const lenSchema = { type: "string", minLength: 2, maxLength: 4 };
	assert.equal(validateArgsAgainstSchema("ab", lenSchema).ok, true);
	assert.equal(validateArgsAgainstSchema("a", lenSchema).ok, false);
	assert.equal(validateArgsAgainstSchema("abcde", lenSchema).ok, false);
});

test("args schema: nested objects are validated recursively", () => {
	const schema = {
		type: "object",
		required: ["run"],
		properties: {
			run: {
				type: "object",
				required: ["mode"],
				properties: { mode: { enum: ["dry", "live"] } },
			},
		},
	};
	assert.equal(validateArgsAgainstSchema({ run: { mode: "dry" } }, schema).ok, true);
	const bad = validateArgsAgainstSchema({ run: { mode: "other" } }, schema);
	assert.equal(bad.ok, false);
	if (!bad.ok) assert.ok(bad.message.includes("$.run.mode"), "error points into the nested value");
});
