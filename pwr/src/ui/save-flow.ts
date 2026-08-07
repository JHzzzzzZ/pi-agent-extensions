/**
 * PWR UI - save-as-command flow (JHL-15 goal 4, PRD 3.2 Should-have)
 *
 * Detail view entry "保存为命令" → name + scope → `SaveAdapter.save`
 * (workflow_save contract, PRD 6.2). On `NAME_CONFLICT` the user is asked to
 * confirm overwrite and the save retries with `overwrite: true` (JHL-17
 * adapter honors the flag; the tool contract itself stays unchanged).
 *
 * The interactive parts are injected via `SaveFlowActions` so the whole flow
 * is unit-testable without a pi host.
 */

import type { SaveAdapter } from "../flow.ts";
import type { PwrErrorResult } from "../types.ts";
import type { OverwritableSaveAdapter, RunStore } from "./types.ts";

export interface SaveFlowActions {
	askName(defaultName: string): Promise<string | undefined>;
	askScope(): Promise<"user" | "project" | undefined>;
	confirmOverwrite(name: string, scope: "user" | "project"): Promise<boolean>;
	notify(text: string, type?: "info" | "warning" | "error"): void;
}

export interface SaveFlowDeps {
	store: RunStore;
	saveAdapter?: SaveAdapter & Partial<OverwritableSaveAdapter>;
}

export type SaveFlowOutcome =
	| { ok: true; commandName: string; pathScope: "user" | "project"; overwritten: boolean }
	| { ok: false; cancelled?: boolean; text?: string };

/** Command-name default from a script meta.name (lowercase, dashes only). */
export function defaultSaveName(scriptName: string): string {
	const slug = scriptName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "workflow";
}

/** Validate a user-provided command name (must match /^[a-z0-9][a-z0-9-]*$/i). */
export function normalizeSaveName(raw: string): string | undefined {
	const name = raw.trim();
	if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return undefined;
	return name;
}

function isError(r: unknown): r is PwrErrorResult {
	return typeof r === "object" && r !== null && "code" in r && "message" in r;
}

export async function runSaveFlow(deps: SaveFlowDeps, actions: SaveFlowActions, ref: string): Promise<SaveFlowOutcome> {
	const { store, saveAdapter } = deps;
	const runId = store.listRuns().find((r) => r.runId === ref || r.runId.startsWith(ref.toLowerCase()))?.runId;
	if (!runId) {
		return { ok: false, text: `Error: run "${ref}" not found (RUN_NOT_FOUND).` };
	}
	const detail = store.getDetail(runId);
	if (!detail) return { ok: false, text: `Error: run "${ref}" not found (RUN_NOT_FOUND).` };

	const name = await actions.askName(defaultSaveName(detail.scriptName));
	if (!name) return { ok: false, cancelled: true };
	const normalized = normalizeSaveName(name);
	if (!normalized) {
		actions.notify("Workflow name may only contain letters, digits and dashes.", "error");
		return { ok: false, text: "Invalid name: letters, digits and dashes only." };
	}

	const scope = await actions.askScope();
	if (!scope) return { ok: false, cancelled: true };
	if (!saveAdapter) {
		actions.notify("Saving is not available yet (JHL-17).", "warning");
		return { ok: false, text: "Save adapter unavailable." };
	}

	let overwritten = false;
	let result = await saveAdapter.save({ runId, scope, name: normalized });
	if (isError(result) && result.code === "NAME_CONFLICT") {
		const overwrite = await actions.confirmOverwrite(normalized, scope);
		if (!overwrite) {
			actions.notify(`Not saved — "${normalized}" already exists.`, "info");
			return { ok: false, cancelled: true, text: "Overwrite declined." };
		}
		overwritten = true;
		result = await saveAdapter.save({ runId, scope, name: normalized, overwrite: true });
	}

	if (isError(result)) {
		actions.notify(`Save failed: ${result.code} — ${result.message}`, "error");
		return { ok: false, text: `${result.code}: ${result.message}` };
	}

	actions.notify(
		`Saved as /workflow:${result.commandName} (${result.pathScope === "user" ? "user scope" : "project scope"})${overwritten ? ", overwrote existing file" : ""}.`,
		"info",
	);
	return { ok: true, commandName: result.commandName, pathScope: result.pathScope, overwritten };
}
