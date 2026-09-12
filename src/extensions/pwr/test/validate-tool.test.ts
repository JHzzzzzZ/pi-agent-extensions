/**
 * workflow_validate entry contract tests (PRD §6.2).
 *
 * Params:  { source, argsSchema? }
 * Success: { script, plan, budgetEstimate }
 * Failure: { code, message, line, column, errors }
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflowValidate } from "../engine/validate-tool.ts";
import { ErrorCodes } from "../engine/errors.ts";
import { PRD_SAMPLE } from "./helpers.ts";

test("workflow_validate contract: accepts { source, argsSchema? } and returns { script, plan, budgetEstimate }", () => {
	const argsSchema = {
		type: "object",
		required: ["root"],
		properties: { root: { type: "string" } },
	};
	const outcome = runWorkflowValidate({ source: PRD_SAMPLE, argsSchema });
	assert.equal(outcome.valid, true);
	if (!outcome.valid) return;

	assert.deepEqual(Object.keys(outcome).sort(), ["budgetEstimate", "plan", "script", "valid"]);
	assert.equal(outcome.script.source, PRD_SAMPLE);
	assert.deepEqual(outcome.script.argsSchema, argsSchema);
	assert.equal(outcome.script.meta?.name, "audit-routes");
	assert.ok(outcome.plan.length >= 3);
	assert.equal(outcome.plan[0]!.type, "agent");
	assert.equal(outcome.plan[0]!.label, "discover");
	assert.equal(
		outcome.budgetEstimate.agentCalls,
		outcome.plan.filter((p) => p.type === "agent").length,
	);
	assert.equal(outcome.budgetEstimate.stages, outcome.plan.length);
});

test("workflow_validate contract: argsSchema is optional and omitted from the result when absent", () => {
	const outcome = runWorkflowValidate({ source: `export const meta = { name: 'n' }\nreturn 1` });
	assert.equal(outcome.valid, true);
	if (!outcome.valid) return;
	assert.equal(Object.hasOwn(outcome.script, "argsSchema"), false);
	assert.deepEqual(outcome.script.meta, { name: "n" });
	assert.equal(outcome.budgetEstimate.agentCalls, 0);
	assert.equal(outcome.budgetEstimate.stages, 0);
});

test("workflow_validate contract: invalid source returns structured failure with contract codes", () => {
	const forbidden = runWorkflowValidate({ source: `process.exit(1)` });
	assert.equal(forbidden.valid, false);
	if (forbidden.valid) return;
	assert.equal(forbidden.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.ok((forbidden.line ?? 0) >= 1);
	assert.ok(Array.isArray(forbidden.errors) && forbidden.errors.length > 0);

	const unknown = runWorkflowValidate({ source: `agentX()` });
	assert.equal(unknown.valid, false);
	if (unknown.valid) return;
	assert.equal(unknown.code, ErrorCodes.SCRIPT_UNKNOWN_API);
	assert.equal(unknown.line, 1);
});

test("workflow_validate contract: non-plain argsSchema is rejected", () => {
	// object carrying a function property
	const fnProp = runWorkflowValidate({ source: `return 1`, argsSchema: { type: "object", x() { return 1; } } });
	assert.equal(fnProp.valid, false);
	if (fnProp.valid) return;
	assert.equal(fnProp.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);

	// non-object root (Date instance)
	const date = runWorkflowValidate({ source: `return 1`, argsSchema: new Date() });
	assert.equal(date.valid, false);
	if (date.valid) return;
	assert.equal(date.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);

	// primitive root
	const prim = runWorkflowValidate({ source: `return 1`, argsSchema: "object" });
	assert.equal(prim.valid, false);
});

test("workflow_validate contract: source must be a string", () => {
	const outcome = runWorkflowValidate({ source: 42 as unknown as string });
	assert.equal(outcome.valid, false);
	if (outcome.valid) return;
	assert.equal(outcome.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
});

test("P3: argsSchema Proxy TOCTOU — values are captured once (single snapshot), never re-read", () => {
	// The gopd trap answers the first read with a plain value and later reads
	// with a function-bearing object. The single-pass snapshot captures each
	// property exactly once, so the second-phase function is rejected at
	// capture time — it can never survive into the returned schema.
	let reads = 0;
	const target = { type: "object" };
	const proxy = new Proxy(target, {
		getOwnPropertyDescriptor(t, prop) {
			reads++;
			if (prop === "type") {
				return reads === 1
					? { value: "object", enumerable: true, configurable: true }
					: { value: { bad: () => process }, enumerable: true, configurable: true };
			}
			return Reflect.getOwnPropertyDescriptor(t, prop);
		},
	});
	const outcome = runWorkflowValidate({ source: `return 1`, argsSchema: proxy as never });
	assert.equal(outcome.valid, false, "second-phase function value must be rejected during the snapshot");
	if (outcome.valid) return;
	assert.equal(outcome.code, ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX);
	assert.ok(!outcome.message.includes("object"), "failure message stays a static template");
});

test("P3: argsSchema proxy with consistent plain data is snapshotted once and preserved", () => {
	const target = { type: "object", required: ["files"], properties: { files: { type: "array" } } };
	const proxy = new Proxy(target, {
		getOwnPropertyDescriptor(t, prop) {
			return Reflect.getOwnPropertyDescriptor(t, prop);
		},
	});
	const outcome = runWorkflowValidate({ source: `return 1`, argsSchema: proxy as never });
	assert.equal(outcome.valid, true);
	if (!outcome.valid) return;
	assert.deepEqual(outcome.script.argsSchema, {
		type: "object",
		required: ["files"],
		properties: { files: { type: "array" } },
	});
});
