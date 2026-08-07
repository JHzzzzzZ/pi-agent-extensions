/**
 * PWR - script engine integration point (JHL-16 goal 2)
 *
 * JHL-16 *calls* the script engine's static validation; the engine itself
 * (ScriptValidator / ScriptInterpreter) is delivered by JHL-12. This module
 * adapts JHL-12's named exports (`validateScript` / `SCRIPT_VERSION`) into
 * the `ScriptEngine` contract and maps diagnostics (line/column) plus
 * `astVersion` into the JHL-16 result shape.
 *
 * The engine is the ONLY source of script approval in the validate flow:
 * when the JHL-12 module cannot be resolved, `getValidationEngine()` returns
 * `null` and the flow must fail with ENGINE_UNAVAILABLE — the structural
 * gate below is a test/UI helper only and is NEVER used to approve scripts.
 */

import { ErrorCode } from "./errors.ts";
import { MAX_SCRIPT_SIZE } from "./types.ts";
import type { ScriptEngine, ScriptValidationResult, WorkflowMeta } from "./types.ts";

/**
 * Expected locations of the JHL-12 validator module (delivered by the
 * JHL-12 script-engine subtask, same `pwr/` package). Both export the named
 * functions `validateScript` / `extractPlan`; `engine/index.ts` also
 * re-exports `SCRIPT_VERSION`.
 */
const ENGINE_MODULE_PATHS = ["../engine/validator.ts", "../engine/index.ts"];

/** JHL-12 validation diagnostic shape (subset of its ScriptDiagnostic). */
interface Jhl12Diagnostic {
	code: string;
	message: string;
	start?: { line: number; column: number; offset: number };
}

interface Jhl12Module {
	validateScript?: (source: string) => {
		ok: boolean;
		errors: Jhl12Diagnostic[];
		meta?: Jhl12Meta;
	};
	SCRIPT_VERSION?: string;
}

interface Jhl12Meta {
	name?: string;
	description?: string;
	version?: number | string;
	/** JHL-17: preserved so saved scripts can declare meta.argsSchema. */
	argsSchema?: unknown;
}

let cachedEngine: ScriptEngine | null | undefined;
let cachedAstVersion = "engine-1";

function mapMeta(meta: Jhl12Meta | undefined): WorkflowMeta | undefined {
	if (!meta) return undefined;
	const mapped: WorkflowMeta = {
		name: typeof meta.name === "string" ? meta.name : "untitled",
		description: meta.description,
		version: meta.version,
	};
	if (meta.argsSchema !== undefined) mapped.argsSchema = meta.argsSchema;
	return mapped;
}

/** Adapts JHL-12's `validateScript` (non-throwing) into the ScriptEngine contract. */
function createAdapter(mod: Jhl12Module, astVersion: string): ScriptEngine {
	const validate = mod.validateScript;
	if (typeof validate !== "function") {
		throw new Error("JHL-12 module does not export validateScript");
	}
	return {
		validate(source: string): ScriptValidationResult {
			if (typeof source !== "string" || source.trim().length === 0) {
				return {
					ok: false,
					astVersion,
					errors: [{ code: ErrorCode.SCRIPT_GENERATION_INVALID, message: "Empty script source." }],
				};
			}
			if (Buffer.byteLength(source, "utf8") > MAX_SCRIPT_SIZE) {
				return {
					ok: false,
					astVersion,
					errors: [{ code: ErrorCode.SCRIPT_GENERATION_INVALID, message: "Script source is too large." }],
				};
			}
			let result;
			try {
				result = validate(source);
			} catch {
				return {
					ok: false,
					astVersion,
					errors: [{ code: ErrorCode.SCRIPT_GENERATION_INVALID, message: "Script validation failed unexpectedly." }],
				};
			}
			if (!result.ok) {
				return {
					ok: false,
					astVersion,
					meta: mapMeta(result.meta),
					errors: result.errors.map((e) => ({
						code: e.code,
						message: e.message,
						line: e.start?.line,
						column: e.start?.column,
					})),
				};
			}
			return { ok: true, astVersion, meta: mapMeta(result.meta), errors: [] };
		},
	};
}

/** Loads the JHL-12 engine's SCRIPT_VERSION (best-effort, cached with the engine). */
async function tryLoadScriptVersion(): Promise<string> {
	try {
		const spec = (await import("../engine/spec.ts")) as { SCRIPT_VERSION?: string };
		return spec.SCRIPT_VERSION ?? "engine-1";
	} catch {
		return "engine-1";
	}
}

export async function resolveEngine(): Promise<ScriptEngine | null> {
	if (cachedEngine !== undefined) return cachedEngine;

	for (const mod of ENGINE_MODULE_PATHS) {
		try {
			const imported = (await import(mod)) as Jhl12Module;
			if (typeof imported?.validateScript === "function") {
				const astVersion = imported.SCRIPT_VERSION ?? (await tryLoadScriptVersion());
				cachedAstVersion = astVersion;
				cachedEngine = createAdapter(imported, astVersion);
				return cachedEngine;
			}
		} catch {
			// module not present yet - try next candidate
		}
	}
	cachedEngine = null;
	return null;
}

/** Resets the cached engine reference (used by tests). */
export function resetEngineCache(): void {
	cachedEngine = undefined;
}

/** The engine's astVersion for the last resolved module (used by diagnostics). */
export function engineAstVersion(): string {
	return cachedAstVersion;
}

const META_PATTERN = /export\s+const\s+meta\s*=\s*\{/;
const META_NAME_PATTERN = /name\s*:\s*(['"`])([^'"`]+)\1/;
const TOP_LEVEL_AWAIT = /\bawait\s+\w+\s*\(/;

/**
 * Minimal structural shape check (meta export + top-level await + size cap).
 * TEST / UI-PREVIEW HELPER ONLY — it checks neither the PWR whitelist nor
 * forbidden syntax, so it must never be used to approve scripts. The
 * production path resolves the JHL-12 engine and fails with
 * ENGINE_UNAVAILABLE when it is missing (see `getValidationEngine`).
 */
export const structuralGate: ScriptEngine = {
	validate(source: string): ScriptValidationResult {
		if (typeof source !== "string" || source.trim().length === 0) {
			return { ok: false, astVersion: "gate-1", errors: [{ code: ErrorCode.SCRIPT_GENERATION_INVALID, message: "Empty script source." }] };
		}
		if (Buffer.byteLength(source, "utf8") > MAX_SCRIPT_SIZE) {
			return { ok: false, astVersion: "gate-1", errors: [{ code: ErrorCode.SCRIPT_GENERATION_INVALID, message: "Script source is too large." }] };
		}

		const errors: ScriptValidationResult["errors"] = [];
		if (!META_PATTERN.test(source)) {
			errors.push({ code: ErrorCode.SCRIPT_GENERATION_INVALID, message: "Missing `export const meta = { ... }`." });
		}
		if (!TOP_LEVEL_AWAIT.test(source)) {
			errors.push({ code: ErrorCode.SCRIPT_GENERATION_INVALID, message: "Missing top-level `await` usage." });
		}

		let meta: WorkflowMeta | undefined;
		const metaName = source.match(META_NAME_PATTERN);
		if (metaName) meta = { name: metaName[2] };

		if (errors.length > 0) return { ok: false, astVersion: "gate-1", meta, errors };
		return { ok: true, astVersion: "gate-1", meta, errors: [] };
	},
};

/**
 * Returns the JHL-12-backed engine, or `null` when it cannot be resolved.
 * A `null` engine means validation CANNOT run: callers must fail with
 * ENGINE_UNAVAILABLE instead of falling back to a weaker gate.
 */
export async function getValidationEngine(): Promise<ScriptEngine | null> {
	return (await resolveEngine()) ?? null;
}
