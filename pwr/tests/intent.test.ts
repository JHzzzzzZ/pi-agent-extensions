import { test } from "node:test";
import assert from "node:assert/strict";
import { firstToken, matchWorkflowPrefix, parseWorkflowCommandArgs, parseWorkflowRunArgs, RETIRED_WORKFLOW_SUBCOMMANDS, WORKFLOW_SUBCOMMANDS } from "../src/intent.ts";

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

// ---------- /workflow 冒号子命令（v2.8.0） ----------

test("/workflow:run args split the saved name from the raw args", () => {
	assert.deepEqual(parseWorkflowRunArgs("audit files=a.js depth=2"), { name: "audit", rawArgs: "files=a.js depth=2" });
	assert.deepEqual(parseWorkflowRunArgs("audit"), { name: "audit", rawArgs: "" });
	assert.deepEqual(parseWorkflowRunArgs("  audit   a=1  "), { name: "audit", rawArgs: "a=1" });
	assert.equal(parseWorkflowRunArgs(""), null);
	assert.equal(parseWorkflowRunArgs("   "), null);
});

test("firstToken returns the first whitespace-delimited token (or empty)", () => {
	assert.equal(firstToken("delete audit"), "delete");
	assert.equal(firstToken("  audit  "), "audit");
	assert.equal(firstToken(""), "");
});

test("retired space-separated words map to the colon sub-commands", () => {
	const expected: Record<string, string> = {
		run: WORKFLOW_SUBCOMMANDS.run,
		delete: WORKFLOW_SUBCOMMANDS.delete,
		model: WORKFLOW_SUBCOMMANDS.model,
	};
	for (const [head, target] of Object.entries(expected)) {
		assert.equal(RETIRED_WORKFLOW_SUBCOMMANDS[head]?.command, target, `retired word ${head}`);
	}
	assert.equal(WORKFLOW_SUBCOMMANDS.run, "workflow:run");
	assert.equal(WORKFLOW_SUBCOMMANDS.delete, "workflow:delete");
	assert.equal(WORKFLOW_SUBCOMMANDS.model, "workflow:model");
});
