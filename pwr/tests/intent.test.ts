import { test } from "node:test";
import assert from "node:assert/strict";
import { matchWorkflowPrefix, parseWorkflowCommandArgs, parseWorkflowCommandRoute } from "../src/intent.ts";

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

// ---------- /workflow sub-command routing (命令风格统一) ----------

test("/workflow run <已保存名> [args] routes to the saved workflow", () => {
	const has = (name: string) => name === "audit";
	assert.deepEqual(parseWorkflowCommandRoute("run audit files=a.js depth=2", has), {
		kind: "run",
		name: "audit",
		rawArgs: "files=a.js depth=2",
	});
	assert.deepEqual(parseWorkflowCommandRoute("run audit", has), { kind: "run", name: "audit", rawArgs: "" });
});

test("/workflow run <未保存名> falls back to generation with the whole input as task", () => {
	const has = (name: string) => name === "audit";
	assert.deepEqual(parseWorkflowCommandRoute("run nope audit the routes", has), {
		kind: "generate",
		task: "run nope audit the routes",
	});
});

test("/workflow delete|model are sub-commands; other input stays a generation task", () => {
	assert.deepEqual(parseWorkflowCommandRoute("delete audit"), { kind: "delete", name: "audit" });
	assert.deepEqual(parseWorkflowCommandRoute("delete"), { kind: "delete", name: "" });
	assert.deepEqual(parseWorkflowCommandRoute("model --auto"), { kind: "model", arg: "--auto" });
	assert.deepEqual(parseWorkflowCommandRoute("model"), { kind: "model", arg: "" });
	// "run" without a name is not the run sub-command — it is a plain task.
	assert.deepEqual(parseWorkflowCommandRoute("run"), { kind: "generate", task: "run" });
	assert.deepEqual(parseWorkflowCommandRoute("audit src/routes"), { kind: "generate", task: "audit src/routes" });
	assert.deepEqual(parseWorkflowCommandRoute("  "), { kind: "generate", task: "" });
});
