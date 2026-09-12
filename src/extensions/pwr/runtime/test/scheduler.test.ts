/**
 * PWR runtime — FIFO scheduler unit tests (PRD 5.3)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunScheduler } from "../scheduler.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("FIFO: runs start in enqueue order when capacity is 1", async () => {
	const scheduler = new RunScheduler(1);
	const order: string[] = [];
	const gate = deferred();

	const first = deferred();
	await scheduler.enqueue("a", async () => {
		order.push("a");
		await first.promise;
	});
	await tick();
	assert.deepEqual(order, ["a"], "first run started immediately");
	assert.equal(scheduler.isQueued("b"), false);

	await scheduler.enqueue("b", async () => {
		order.push("b");
		gate.resolve();
	});
	await tick();
	assert.equal(scheduler.isQueued("b"), true, "second run waits in the FIFO queue");
	assert.deepEqual(order, ["a"], "second run has not started yet");

	first.resolve();
	await gate.promise;
	await tick();
	assert.deepEqual(order, ["a", "b"], "strict FIFO start order");
	assert.equal(scheduler.activeCount, 0);
});

test("maxActiveRuns caps concurrent executions", async () => {
	const scheduler = new RunScheduler(2);
	let active = 0;
	let maxActive = 0;
	const gates = [deferred(), deferred(), deferred()];
	let gateIndex = 0;

	const run = async (id: string) => {
		active++;
		maxActive = Math.max(maxActive, active);
		await gates[gateIndex++]!.promise;
		active--;
	};

	const p1 = scheduler.enqueue("a", () => run("a"));
	const p2 = scheduler.enqueue("b", () => run("b"));
	const p3 = scheduler.enqueue("c", () => run("c"));
	await tick();
	assert.equal(maxActive, 2, "never exceeds the active cap");
	assert.equal(scheduler.isQueued("c"), true, "third run is queued");
	gates[0]!.resolve();
	gates[1]!.resolve();
	await tick();
	assert.equal(scheduler.isActive("c"), true, "third run starts once capacity frees");
	gates[2]!.resolve();
	await Promise.all([p1, p2, p3]);
	assert.equal(scheduler.activeCount, 0);
});

test("enqueueFront resumes an already-started run ahead of the queue", async () => {
	const scheduler = new RunScheduler(1);
	const order: string[] = [];
	const gate = deferred();

	await scheduler.enqueue("a", async () => {
		order.push("a");
		await gate.promise;
	});
	await tick();
	await scheduler.enqueue("b", async () => {
		order.push("b");
	});
	await tick();
	// "a" is active; "c" (resume) must be dispatched before queued "b".
	await scheduler.enqueueFront("c", async () => {
		order.push("c");
	});
	await tick();
	gate.resolve();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(order, ["a", "c", "b"]);
});

test("enqueueFront while the run is active re-inserts it after the old executor settles", async () => {
	const scheduler = new RunScheduler(1);
	const order: string[] = [];
	const gate = deferred();

	await scheduler.enqueue("a", async () => {
		order.push("a-start");
		await gate.promise;
		order.push("a-end");
	});
	await tick();
	// resume while "a" is still active (runner ignores abort, finishes late)
	await scheduler.enqueueFront("a", async () => {
		order.push("a-resumed");
	});
	await tick();
	assert.deepEqual(order, ["a-start"], "resume stays pending while the old executor runs");
	gate.resolve();
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(order, ["a-start", "a-end", "a-resumed"], "resume re-inserted after the old executor settled");
	assert.equal(scheduler.activeCount, 0);
});

test("dequeue cancels a pending resume so a paused run never re-starts", async () => {
	const scheduler = new RunScheduler(1);
	const order: string[] = [];
	const gate = deferred();

	await scheduler.enqueue("a", async () => {
		order.push("a-start");
		await gate.promise;
		order.push("a-end");
	});
	await tick();
	await scheduler.enqueueFront("a", async () => {
		order.push("a-resumed");
	});
	await tick();
	// pause again while pending -> the pending resume is withdrawn
	scheduler.dequeue("a");
	gate.resolve();
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(order, ["a-start", "a-end"], "pending resume cancelled by dequeue");
});

test("dequeue withdraws a queued run so it never executes", async () => {
	const scheduler = new RunScheduler(1);
	const order: string[] = [];
	const gate = deferred();

	await scheduler.enqueue("a", async () => {
		order.push("a");
		await gate.promise;
	});
	await tick();
	await scheduler.enqueue("b", async () => {
		order.push("b");
	});
	await scheduler.enqueue("c", async () => {
		order.push("c");
	});
	await tick();
	assert.equal(scheduler.isQueued("c"), true);
	scheduler.dequeue("c");
	assert.equal(scheduler.isQueued("c"), false);
	gate.resolve();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(order, ["a", "b"], "dequeued run never executed");
});

test("unlimited capacity starts all queued runs concurrently", async () => {
	const scheduler = new RunScheduler();
	let started = 0;
	const gate = deferred();
	for (let i = 0; i < 5; i++) {
		await scheduler.enqueue(`r${i}`, async () => {
			started++;
			await gate.promise;
		});
	}
	await tick();
	assert.equal(started, 5, "all runs active with unlimited capacity");
	gate.resolve();
	await tick();
	assert.equal(scheduler.activeCount, 0);
});
