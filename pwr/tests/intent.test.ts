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

// ---------- 统一冒号子命令表（v2.9.0：单一 /workflow:* 命名空间） ----------

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

test("unified subcommand table: 15 keys, each mapping to /workflow:<key>", () => {
	const expected = ["run", "delete", "model", "list", "view", "open", "pause", "resume", "stop", "restart", "save", "saved", "script", "approve", "help"];
	assert.deepEqual(Object.keys(WORKFLOW_SUBCOMMANDS).sort(), [...expected].sort());
	for (const [word, command] of Object.entries(WORKFLOW_SUBCOMMANDS)) {
		assert.equal(command, `workflow:${word}`, `subcommand ${word}`);
	}
});

test("retired words: exactly the 14 non-help subcommands, help stays bare", () => {
	const words = Object.keys(RETIRED_WORKFLOW_SUBCOMMANDS).sort();
	assert.equal(words.length, 14, "14 retired words (help excluded)");
	assert.equal(RETIRED_WORKFLOW_SUBCOMMANDS.help, undefined, "bare 'help' shows help, not a rename hint");
	for (const word of words) {
		const entry = RETIRED_WORKFLOW_SUBCOMMANDS[word]!;
		assert.equal(entry.command, `workflow:${word}`, `retired word ${word}`);
		assert.ok(entry.usage.startsWith(`/workflow:${word}`), `usage for ${word} uses the new command`);
	}
});
