/**
 * JHL-17: /workflow:run <name> args parsing and JSON-schema subset validation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ErrorCode } from "../src/errors.ts";
import { argsSchemaHint, parseCommandArgs, parseCommandArgsSmart, validateArgsAgainstSchema } from "../src/args.ts";

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

// ------------------------------------------------------------------
// parseCommandArgsSmart (v2.4): schema-guided key=value input, JSON unchanged
// ------------------------------------------------------------------

const FILES_SCHEMA = {
	type: "object",
	required: ["files"],
	properties: {
		files: { type: "array", items: { type: "string" } },
		depth: { type: "integer", minimum: 1 },
		verbose: { type: "boolean" },
		note: { type: "string" },
	},
	additionalProperties: false,
};

test("smart args: empty stays undefined, JSON path unchanged", () => {
	const empty = parseCommandArgsSmart("", FILES_SCHEMA);
	assert.ok(empty.ok && empty.value === undefined);

	const json = parseCommandArgsSmart('{"files":["a.ts"],"depth":2}', FILES_SCHEMA);
	assert.ok(json.ok);
	if (json.ok) assert.deepEqual(json.value, { files: ["a.ts"], depth: 2 });

	const bad = parseCommandArgsSmart("{not json", FILES_SCHEMA);
	assert.ok(!bad.ok && bad.code === ErrorCode.ARGS_INVALID);
});

test("smart args: key=value coerces numbers/booleans by schema", () => {
	const r = parseCommandArgsSmart("files=src/a.ts depth=2 verbose=true", FILES_SCHEMA);
	assert.ok(r.ok);
	if (r.ok) assert.deepEqual(r.value, { files: ["src/a.ts"], depth: 2, verbose: true });

	const badNumber = parseCommandArgsSmart("files=a depth=two", FILES_SCHEMA);
	assert.ok(!badNumber.ok && badNumber.code === ErrorCode.ARGS_INVALID);

	const badBoolean = parseCommandArgsSmart("files=a verbose=maybe", FILES_SCHEMA);
	assert.ok(!badBoolean.ok);
});

test("smart args: repeated keys and comma lists accumulate arrays", () => {
	const repeated = parseCommandArgsSmart("files=a.ts files=b.ts depth=1", FILES_SCHEMA);
	assert.ok(repeated.ok);
	if (repeated.ok) assert.deepEqual(repeated.value, { files: ["a.ts", "b.ts"], depth: 1 });

	const comma = parseCommandArgsSmart('files="a b.ts",c.ts depth=3', FILES_SCHEMA);
	assert.ok(comma.ok);
	if (comma.ok) assert.deepEqual(comma.value, { files: ["a b.ts", "c.ts"], depth: 3 });
});

test("smart args: bare key means true on a boolean property; quoted values keep spaces", () => {
	const flag = parseCommandArgsSmart("files=a.ts verbose note='hello world'", FILES_SCHEMA);
	assert.ok(flag.ok);
	if (flag.ok) assert.deepEqual(flag.value, { files: ["a.ts"], verbose: true, note: "hello world" });

	const bare = parseCommandArgsSmart("files=a.ts note", FILES_SCHEMA);
	assert.ok(!bare.ok, "bare non-boolean key is rejected");
});

test("smart args: positional input fills the single required property", () => {
	const schema = {
		type: "object",
		required: ["query"],
		properties: { query: { type: "string" } },
	};
	const pos = parseCommandArgsSmart("find all TODO comments", schema);
	assert.ok(pos.ok);
	if (pos.ok) assert.deepEqual(pos.value, { query: "find all TODO comments" });

	const arraySchema = {
		type: "object",
		required: ["files"],
		properties: { files: { type: "array", items: { type: "string" } } },
	};
	const split = parseCommandArgsSmart("src test docs", arraySchema);
	assert.ok(split.ok);
	if (split.ok) assert.deepEqual(split.value, { files: ["src", "test", "docs"] });

	// FILES_SCHEMA's single required files (array<string>) DOES get positional
	// sugar; a schema whose sole required property is not string/array does not.
	const objectSchema = {
		type: "object",
		required: ["config"],
		properties: { config: { type: "object" } },
	};
	const two = parseCommandArgsSmart("just text", objectSchema);
	assert.ok(!two.ok);
});

test("smart args: additionalProperties=false rejects unknown keys; input is never echoed", () => {
	const r = parseCommandArgsSmart("files=a.txt secret=password123", FILES_SCHEMA);
	assert.ok(!r.ok && r.code === ErrorCode.ARGS_INVALID);
	assert.ok(!r.message.includes("secret"), "static error template never echoes raw input");
});

test("smart args: no schema still accepts key=value string pairs", () => {
	const r = parseCommandArgsSmart("foo=bar count=3", undefined);
	assert.ok(r.ok);
	if (r.ok) assert.deepEqual(r.value, { foo: "bar", count: "3" });
});

test("argsSchemaHint renders property=type with optional markers", () => {
	assert.equal(argsSchemaHint(FILES_SCHEMA), "files=string[] depth?=integer verbose?=boolean note?=string");
	assert.equal(argsSchemaHint(undefined), undefined);
	assert.equal(argsSchemaHint({ type: "string" }), undefined);
});
