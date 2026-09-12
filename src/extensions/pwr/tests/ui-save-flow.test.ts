/**
 * JHL-15 - save-as-command flow tests: happy path, NAME_CONFLICT ->
 * overwrite confirmation -> retry with overwrite:true, decline, invalid
 * names, unknown run, unavailable adapter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSaveName, normalizeSaveName, runSaveFlow, type SaveFlowActions } from "../src/ui/save-flow.ts";
import { MemoryRunStore } from "../src/ui/run-store.ts";
import { RunRegistry, type SaveAdapter } from "../src/flow.ts";
import type { OverwritableSaveAdapter } from "../src/ui/types.ts";

function makeStore(scriptName = "Audit Routes!"): { store: MemoryRunStore; runId: string } {
	const store = new MemoryRunStore({ nowMs: () => Date.parse("2026-08-05T12:00:00Z") });
	const registry = new RunRegistry();
	const plan = {
		stages: [{ stageId: "s1", label: "discover", kind: "agent" as const, agentCount: 1, writeRisk: false }],
		budget: { agentCalls: 1, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 1, writeRisk: false, warnLargeRun: false },
	};
	const run = registry.create("export const meta={name:'audit'};", { name: scriptName, version: 1 }, plan, "2026-08-05T12:00:00Z");
	store.hydrateRun(run, registry.getScript(run.runId)!, registry.getPlan(run.runId)!);
	return { store, runId: run.runId };
}

interface Calls {
	saves: Array<{ runId: string; scope: string; name: string; overwrite?: boolean }>;
}

function makeActions(
	answers: {
		name?: string | undefined;
		scope?: "user" | "project" | undefined;
		overwrite?: boolean;
	},
): SaveFlowActions {
	return {
		askName: async () => answers.name,
		askScope: async () => answers.scope,
		confirmOverwrite: async () => answers.overwrite ?? false,
		notify: () => {},
	};
}

function makeAdapter(calls: Calls, firstResult?: unknown): SaveAdapter & Partial<OverwritableSaveAdapter> {
	return {
		async save(input: { runId: string; scope: string; name: string; overwrite?: boolean }): Promise<
			{ commandName: string; pathScope: "user" | "project" } | { code: string; message: string }
		> {
			calls.saves.push({ runId: input.runId, scope: input.scope, name: input.name, overwrite: input.overwrite });
			if (calls.saves.length === 1 && firstResult) return firstResult as { code: string; message: string };
			return { commandName: input.name, pathScope: input.scope as "user" | "project" };
		},
	};
}

test("defaultSaveName slugifies script names", () => {
	assert.equal(defaultSaveName("Audit Routes!"), "audit-routes");
	assert.equal(defaultSaveName("  fix-until-green "), "fix-until-green");
	assert.equal(defaultSaveName("!!!"), "workflow");
});

test("normalizeSaveName enforces letters/digits/dashes", () => {
	assert.equal(normalizeSaveName("audit-routes"), "audit-routes");
	assert.equal(normalizeSaveName("audit1"), "audit1");
	assert.equal(normalizeSaveName("Audit1"), "Audit1");
	assert.equal(normalizeSaveName("bad name"), undefined);
	assert.equal(normalizeSaveName("bad_name"), undefined);
	assert.equal(normalizeSaveName("-leading"), undefined);
	assert.equal(normalizeSaveName("1starts-with-digit"), "1starts-with-digit");
});

test("save flow happy path", async () => {
	const { store, runId } = makeStore();
	const calls: Calls = { saves: [] };
	const out = await runSaveFlow(
		{ store, saveAdapter: makeAdapter(calls) },
		makeActions({ name: "audit-routes", scope: "user" }),
		runId,
	);
	assert.equal(out.ok, true);
	assert.deepEqual(calls.saves, [{ runId, scope: "user", name: "audit-routes", overwrite: undefined }]);
});

test("save flow: NAME_CONFLICT -> confirm overwrite -> retry with overwrite:true", async () => {
	const { store, runId } = makeStore();
	const calls: Calls = { saves: [] };
	const out = await runSaveFlow(
		{ store, saveAdapter: makeAdapter(calls, { code: "NAME_CONFLICT", message: "already exists" }) },
		makeActions({ name: "audit", scope: "project", overwrite: true }),
		runId,
	);
	assert.equal(out.ok, true);
	assert.equal(out.overwritten, true);
	assert.deepEqual(calls.saves, [
		{ runId, scope: "project", name: "audit", overwrite: undefined },
		{ runId, scope: "project", name: "audit", overwrite: true },
	]);
});

test("save flow: overwrite declined -> cancelled, no second save", async () => {
	const { store, runId } = makeStore();
	const calls: Calls = { saves: [] };
	const out = await runSaveFlow(
		{ store, saveAdapter: makeAdapter(calls, { code: "NAME_CONFLICT", message: "exists" }) },
		makeActions({ name: "audit", scope: "user", overwrite: false }),
		runId,
	);
	assert.equal(out.ok, false);
	assert.equal(out.cancelled, true);
	assert.equal(calls.saves.length, 1);
});

test("save flow: unknown run", async () => {
	const { store } = makeStore();
	const out = await runSaveFlow({ store, saveAdapter: makeAdapter({ saves: [] }) }, makeActions({ name: "x", scope: "user" }), "nope");
	assert.equal(out.ok, false);
	assert.ok(out.text!.includes("RUN_NOT_FOUND"));
});

test("save flow: invalid name is rejected before saving", async () => {
	const { store, runId } = makeStore();
	const calls: Calls = { saves: [] };
	const out = await runSaveFlow(
		{ store, saveAdapter: makeAdapter(calls) },
		makeActions({ name: "bad name!", scope: "user" }),
		runId,
	);
	assert.equal(out.ok, false);
	assert.equal(calls.saves.length, 0);
});

test("save flow: no adapter -> unavailable error", async () => {
	const { store, runId } = makeStore();
	const out = await runSaveFlow({ store, saveAdapter: undefined }, makeActions({ name: "audit", scope: "user" }), runId);
	assert.equal(out.ok, false);
	assert.ok(out.text!.includes("unavailable"));
});

test("save flow: PROJECT_NOT_TRUSTED surfaces the contract code", async () => {
	const { store, runId } = makeStore();
	const out = await runSaveFlow(
		{ store, saveAdapter: makeAdapter({ saves: [] }, { code: "PROJECT_NOT_TRUSTED", message: "not trusted" }) },
		makeActions({ name: "audit", scope: "project" }),
		runId,
	);
	assert.equal(out.ok, false);
	assert.ok(out.text!.includes("PROJECT_NOT_TRUSTED"));
});
