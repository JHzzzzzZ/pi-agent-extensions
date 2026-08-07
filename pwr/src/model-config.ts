/**
 * PWR — workflow default model configuration (/pwr-model command).
 *
 * The workflow default model answers "which `--model` should child pi
 * agents use when the agent definition does NOT pin one".
 *
 *   auto          (default) follow the CURRENT main session model live:
 *                 main session switches ds→gpt, workflow agents follow.
 *   <model-id>    fixed model id used for all workflow agents.
 *
 * Persisted as a small JSON file (~/.pi/agent/pwr-model.json) so the
 * setting survives restarts. The live session model id is tracked from
 * session_start (`ctx.model`) and model_select events.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Sentinel value: workflow agents follow the main session model. */
export const AUTO_MODEL = "auto";

export const PWR_MODEL_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "pwr-model.json");

export interface PwrModelConfigData {
	/** "auto" (follow main session) or an explicit model id. */
	defaultModel: string;
	updatedAt?: string;
}

export class PwrModelConfig {
	private readonly file: string;
	private mode: string = AUTO_MODEL;
	private sessionModel: string | undefined;

	constructor(file: string = PWR_MODEL_CONFIG_FILE) {
		this.file = file;
	}

	/** Load persisted setting (silently falls back to auto). */
	load(): void {
		try {
			const data = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<PwrModelConfigData>;
			if (typeof data.defaultModel === "string" && data.defaultModel.trim()) {
				this.mode = data.defaultModel.trim();
			}
		} catch {
			this.mode = AUTO_MODEL;
		}
	}

	/** Persist a new default: "auto" or a concrete model id. */
	set(model: string): void {
		this.mode = model.trim() || AUTO_MODEL;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const data: PwrModelConfigData = { defaultModel: this.mode, updatedAt: new Date().toISOString() };
			fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
		} catch {
			// Persistence failures must never break the session.
		}
	}

	/** Track the live main-session model id (session_start / model_select). */
	setSessionModel(id: string | undefined): void {
		this.sessionModel = id;
	}

	/** Configured mode: "auto" or an explicit model id. */
	get(): string {
		return this.mode;
	}

	/** The model id child pi agents should run with right now. */
	effectiveModel(): string | undefined {
		if (this.mode !== AUTO_MODEL) return this.mode;
		return this.sessionModel;
	}

	/** Human-readable status for the command's "show" form. */
	describe(): { mode: string; sessionModel: string | undefined; effective: string | undefined } {
		return { mode: this.mode, sessionModel: this.sessionModel, effective: this.effectiveModel() };
	}
}
