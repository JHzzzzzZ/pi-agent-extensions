import { test } from "node:test";
import assert from "node:assert/strict";
import { matchWorkflowPrefix, parseWorkflowCommandArgs } from "../src/intent.ts";

test("/workflow command args parse to a generation request", () => {
	const req = parseWorkflowCommandArgs("audit src/routes auth");
	assert.ok(req);
	assert.equal(req.task, "audit src/routes auth");
	assert.ok(req.requestedAt);
});

test("/workflow with empty args is invalid", () => {
	assert.equal(parseWorkflowCommandArgs(""), null);
	assert.equal(parseWorkflowCommandArgs("   "), null);
});

test("workflow: prefix is recognized (case-insensitive)", () => {
	const req = matchWorkflowPrefix("workflow: audit routes");
	assert.ok(req);
	assert.equal(req.task, "audit routes");
	const upper = matchWorkflowPrefix("Workflow: 审计");
	assert.ok(upper);
	assert.equal(upper.task, "审计");
});

test("workflow: prefix with no task is ignored", () => {
	assert.equal(matchWorkflowPrefix("workflow:"), null);
	assert.equal(matchWorkflowPrefix("workflow:   "), null);
});

test("non-workflow input passes through", () => {
	assert.equal(matchWorkflowPrefix("help me fix this bug"), null);
	assert.equal(matchWorkflowPrefix("my workflow: is broken"), null);
});
