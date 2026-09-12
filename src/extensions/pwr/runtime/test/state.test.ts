/**
 * PWR runtime — state machine unit tests (PRD 5.3)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_OPERATIONS, TRANSITIONS, assertTransition, canTransition, isTerminal } from "../state.ts";
import { RUN_STATUSES, type RunStatus } from "../types.ts";

test("transition table covers every status and target", () => {
	for (const from of RUN_STATUSES) {
		assert.ok(Array.isArray(TRANSITIONS[from]), `missing transitions from ${from}`);
		for (const to of TRANSITIONS[from]) {
			assert.ok(RUN_STATUSES.includes(to), `unknown target ${to} from ${from}`);
			assert.ok(!TRANSITIONS[from].includes(to) || canTransition(from, to), "canTransition mirrors table");
		}
	}
});

test("legal transitions per PRD 5.3", () => {
	assert.equal(canTransition("draft", "awaiting_approval"), true);
	assert.equal(canTransition("draft", "cancelled"), true);
	assert.equal(canTransition("awaiting_approval", "queued"), true);
	assert.equal(canTransition("awaiting_approval", "cancelled"), true);
	assert.equal(canTransition("queued", "running"), true);
	assert.equal(canTransition("queued", "paused"), true);
	assert.equal(canTransition("queued", "cancelled"), true);
	assert.equal(canTransition("running", "paused"), true);
	assert.equal(canTransition("running", "completed"), true);
	assert.equal(canTransition("running", "failed"), true);
	assert.equal(canTransition("running", "cancelled"), true);
	assert.equal(canTransition("paused", "queued"), true); // resume through FIFO
	assert.equal(canTransition("paused", "cancelled"), true);
	assert.equal(canTransition("completed", "queued"), true); // run again
	assert.equal(canTransition("failed", "queued"), true);
	assert.equal(canTransition("cancelled", "queued"), true);
});

test("illegal transitions are rejected", () => {
	assert.equal(canTransition("draft", "running"), false);
	assert.equal(canTransition("paused", "running"), false); // must resume via queued
	assert.equal(canTransition("draft", "completed"), false);
	assert.equal(canTransition("awaiting_approval", "running"), false);
	assert.equal(canTransition("completed", "paused"), false);
	assert.equal(canTransition("running", "queued"), false);
	assert.equal(canTransition("queued", "completed"), false);
	assert.equal(canTransition("completed", "running"), false, "re-run re-enters the queue, never directly running");
	assert.throws(() => assertTransition("draft", "running"), (err: Error) => {
		assert.match(err.message, /ILLEGAL_STATE_TRANSITION|state transition/i);
		return true;
	});
});

test("assertTransition passes legal moves without throwing", () => {
	assert.doesNotThrow(() => assertTransition("running", "paused"));
	assert.doesNotThrow(() => assertTransition("paused", "queued"));
	assert.doesNotThrow(() => assertTransition("queued", "running"));
});

test("terminal statuses", () => {
	for (const status of ["completed", "failed", "cancelled"] as const) {
		assert.equal(isTerminal(status), true, status);
	}
	for (const status of ["draft", "awaiting_approval", "queued", "running", "paused"] as const) {
		assert.equal(isTerminal(status), false, status);
	}
});

test("allowed operations per state match PRD 5.3", () => {
	assert.deepEqual(ALLOWED_OPERATIONS.draft, ["view", "discard"]);
	assert.deepEqual(ALLOWED_OPERATIONS.awaiting_approval, ["run_once", "remember_and_run", "view", "reject"]);
	assert.ok(ALLOWED_OPERATIONS.running.includes("pause"));
	assert.ok(ALLOWED_OPERATIONS.running.includes("stop"));
	assert.ok(ALLOWED_OPERATIONS.running.includes("restart_agent"));
	assert.ok(ALLOWED_OPERATIONS.queued.includes("pause"));
	assert.deepEqual(ALLOWED_OPERATIONS.paused, ["resume", "stop"]);
	assert.ok(ALLOWED_OPERATIONS.completed.includes("save"));
	assert.ok(ALLOWED_OPERATIONS.completed.includes("run_again"));
	assert.ok(ALLOWED_OPERATIONS.failed.includes("run_again"));
	assert.ok(ALLOWED_OPERATIONS.cancelled.includes("run_again"));
});

test("every status has a transition list and allowed operations", () => {
	for (const status of RUN_STATUSES as RunStatus[]) {
		assert.ok(TRANSITIONS[status].length >= 0);
		assert.ok(Array.isArray(ALLOWED_OPERATIONS[status]));
	}
});
