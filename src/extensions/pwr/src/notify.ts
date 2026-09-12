/**
 * PWR - runtime notification (JHL-16 goal 5)
 *
 * Final `return` summaries are delivered to the main session ONLY when the
 * run they belong to settles. The runtime (JHL-13) produces the summary via
 * the `onFinalResult` callback of `RuntimeAdapter.start`; this module owns
 * the delivery gate: queue (per runId) -> settle(runId) -> pi.sendMessage.
 *
 * Delivery is strictly runId-scoped: `settle(runId)` flushes exactly that
 * run's pending summary. An `agent_settled` event for run A never flushes
 * run B's pending results.
 *
 * Over-8KB final results (final workflow JSON): the full JSON is written to
 * `<workflowsDir>/results/<runId>.json` and the message carries a JSON-safe
 * preview (parseable, `__pwr_truncated__` marker) + the file path, within
 * MAX_MESSAGE_BUDGET_BYTES. Write failures degrade to preview-only delivery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_FINAL_SUMMARY_SIZE, MAX_MESSAGE_BUDGET_BYTES, PWR_RESULT_CUSTOM_TYPE } from "./types.ts";

export interface PendingResult {
	runId: string;
	scriptName: string;
	summary: string;
}

export type SendMessageFn = (
	message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> },
	options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export interface SettleHooks {
	/**
	 * Registers the per-run settle callback. The JHL-13 runtime calls
	 * handler(runId) exactly when THAT run's final agent settles (it may
	 * deliver both orders: summary-first via onFinalResult, or
	 * settle-first — the notifier handles both).
	 */
	onRunSettled?(handler: (runId: string) => void): void;
}

/** Completion-message header, shared by settle() and the preview budget. */
function completionHeader(scriptName: string, runId: string): string {
	return `**Workflow \`${scriptName}\` completed** (run ${runId.slice(0, 8)})`;
}

/**
 * UTF-8-safe byte truncation: keeps as much of `text` as fits in
 * `maxBytes` (multi-byte characters are never split) and appends
 * `suffix` when truncation happened. Local copy of the persist.ts pattern
 * — src/ must not import runtime/.
 */
function truncateUtf8BytesLocal(text: string, maxBytes: number, suffix: string): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
	let truncated = text.slice(0, budget);
	while (Buffer.byteLength(truncated, "utf8") > budget) truncated = truncated.slice(0, -1);
	return `${truncated}${suffix}`;
}

/**
 * Truncation marker field/element name. Object roots get a marker field;
 * array roots get a marker element appended.
 */
const TRUNCATION_MARKER = '"__pwr_truncated__":true';
const TRUNCATION_SUFFIX = "\n\n[Summary truncated.]";

/**
 * JSON-safe summary truncation. Under `maxBytes` the text passes through
 * unchanged. Structural roots (`{`/`[`) are truncated at the last complete
 * element boundary and closed with a `__pwr_truncated__` marker so the
 * result stays parseable JSON; scalar roots fall back to byte-safe text
 * truncation with the `[Summary truncated.]` marker (no JSON rebuilding —
 * reconstructing a scalar would fabricate data).
 */
export function truncateJsonSummary(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const root = text[0];
	if (root !== "{" && root !== "[") {
		return truncateUtf8BytesLocal(text, maxBytes, TRUNCATION_SUFFIX);
	}
	// Reserve room for the closing brackets + marker injected below.
	const budget = Math.max(1, maxBytes - 64);
	let prefix = text.slice(0, budget);
	while (Buffer.byteLength(prefix, "utf8") > budget) prefix = prefix.slice(0, -1);
	for (const cut of jsonCutCandidates(prefix)) {
		const cand = prefix.slice(0, cut + 1);
		const rebuilt = cand + closeWithMarker(cand, root);
		if (Buffer.byteLength(rebuilt, "utf8") <= maxBytes) {
			try {
				JSON.parse(rebuilt);
				return rebuilt;
			} catch {
				// Not a real boundary; try the next shorter candidate.
			}
		}
	}
	return truncateUtf8BytesLocal(text, maxBytes, TRUNCATION_SUFFIX);
}

/**
 * Candidate cut positions (longest first): positions where `prefix` ends a
 * complete top-level element — closing brackets that leave the suffix
 * bracket-balanced, plus closing quotes of complete strings. String-aware
 * in both directions (escaped quotes never toggle).
 */
function jsonCutCandidates(prefix: string): number[] {
	// Forward pass: string boundary quotes (escape-aware).
	const quotes: number[] = [];
	let inString = false;
	for (let i = 0; i < prefix.length; i++) {
		const ch = prefix[i];
		if (inString) {
			if (ch === "\\") {
				i++; // escaped char (quote or backslash) inside a string
				continue;
			}
			if (ch === '"') {
				inString = false;
				quotes.push(i);
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			quotes.push(i);
		}
	}
	const endsInString = inString;
	// Backward pass: closing brackets bringing net depth to 0, and closing
	// quotes (toggle false -> true going backward) of complete strings.
	const candidates: number[] = [];
	let depth = 0;
	let q = quotes.length - 1;
	let inStr = endsInString;
	for (let i = prefix.length - 1; i >= 0 && candidates.length < 64; i--) {
		if (q >= 0 && quotes[q] === i) {
			// Closing quote of a complete string VALUE (keys are followed by
			// ":" and never end an element).
			if (!inStr && prefix[i + 1] !== ":") candidates.push(i);
			inStr = !inStr;
			q--;
		}
		if (inStr) continue;
		const ch = prefix[i];
		if (ch === "}" || ch === "]") {
			depth++;
			if (depth === 0) candidates.push(i);
		} else if (ch === "{" || ch === "[") {
			depth--;
		}
	}
	return candidates;
}

/**
 * Closes the still-open brackets of a truncated JSON prefix and injects the
 * truncation marker at the ROOT level: object roots gain a marker field,
 * array roots a marker element.
 */
function closeWithMarker(cand: string, root: string): string {
	const stack: string[] = [];
	let inString = false;
	for (let i = 0; i < cand.length; i++) {
		const ch = cand[i];
		if (inString) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") stack.push(ch);
		else if (ch === "}" || ch === "]") stack.pop();
	}
	if (stack.length === 0) {
		// Defensive: cand is already a complete document (never happens for
		// proper prefixes of JSON.stringify output — the root closes beyond
		// the budget). Inject the marker by replacing the root's close.
		const last = cand[cand.length - 1];
		if (root === "{" && last === "}") return `,${TRUNCATION_MARKER}}`;
		if (root === "[" && last === "]") return `,{${TRUNCATION_MARKER}}]`;
		return "";
	}
	let out = "";
	for (let k = stack.length - 1; k >= 1; k--) out += stack[k] === "{" ? "}" : "]";
	if (stack[0] === "{") out += `,${TRUNCATION_MARKER}}`;
	else out += `,{${TRUNCATION_MARKER}}]`;
	return out;
}

/** Truncate a summary to MAX_FINAL_SUMMARY_SIZE bytes (JSON-safe when possible). */
export function truncateSummary(summary: string): string {
	return truncateJsonSummary(summary, MAX_FINAL_SUMMARY_SIZE);
}

export class RunNotifier {
	private pending = new Map<string, PendingResult>();
	/** Runs whose settle arrived before their summary was queued. */
	private settledRuns = new Set<string>();
	private readonly send: SendMessageFn;
	private readonly hooks?: SettleHooks;
	private readonly resultDir?: string;

	constructor(send: SendMessageFn, hooks?: SettleHooks, options?: { resultDir?: string }) {
		this.send = send;
		this.hooks = hooks;
		this.resultDir = options?.resultDir;
		this.hooks?.onRunSettled?.((runId) => {
			void this.settle(runId);
		});
	}

	/**
	 * Queues a final summary for delivery when THIS run settles. Summaries
	 * within MAX_FINAL_SUMMARY_SIZE are delivered inline unchanged; larger
	 * ones are written in full to `<resultDir>/<runId>.json` (when a results
	 * dir is configured) and the message carries a JSON-safe preview plus
	 * the file path, bounded by MAX_MESSAGE_BUDGET_BYTES.
	 */
	queue(runId: string, scriptName: string, summary: string): void {
		const full = summary;
		const payload =
			Buffer.byteLength(full, "utf8") <= MAX_FINAL_SUMMARY_SIZE
				? full
				: this.buildLargeSummary(runId, scriptName, full);
		this.pending.set(runId, {
			runId,
			scriptName,
			summary: payload,
		});
		// The run may have settled before the summary arrived; deliver now.
		if (this.settledRuns.delete(runId)) {
			void this.settle(runId);
		}
	}

	/**
	 * Over-8KB payload: persist the full JSON, then build the preview +
	 * path-line within the message budget.
	 */
	private buildLargeSummary(runId: string, scriptName: string, full: string): string {
		const header = completionHeader(scriptName, runId);
		const resultPath = this.resultDir ? this.writeResultFile(runId, full) : undefined;
		const pathLine = resultPath ? `\n\n完整结果: ${resultPath}` : "";
		const preview = truncateJsonSummary(
			full,
			MAX_MESSAGE_BUDGET_BYTES - Buffer.byteLength(header, "utf8") - Buffer.byteLength(pathLine, "utf8"),
		);
		return `${preview}${pathLine}`;
	}

	/**
	 * Writes the full result JSON to `<resultDir>/<runId>.json`. Synchronous
	 * (results are ≤ 50KB — milliseconds); failures degrade to
	 * preview-only delivery, never to a lost message.
	 */
	private writeResultFile(runId: string, full: string): string | undefined {
		try {
			fs.mkdirSync(this.resultDir!, { recursive: true });
			const filePath = path.join(this.resultDir!, `${runId}.json`);
			fs.writeFileSync(filePath, full, "utf8");
			return filePath;
		} catch {
			return undefined;
		}
	}

	/**
	 * Queues a failure result for delivery when THIS run settles (wakes the
	 * main agent). Failed runs produce no final summary (the runtime's
	 * onFinalResult only fires on completion); the recorded error fields
	 * are the payload. Cancelled runs are user-initiated and never queued
	 * here.
	 */
	queueFailure(runId: string, scriptName: string, errorCode?: string, errorMessage?: string): void {
		const detail =
			[errorCode, errorMessage].filter((p): p is string => typeof p === "string" && p.length > 0).join(": ") ||
			"unknown error";
		this.pending.set(runId, {
			runId,
			scriptName,
			summary: `**Workflow \`${scriptName}\` failed** (run ${runId.slice(0, 8)})\n\n${detail}`,
		});
		// The run may have settled before the failure was recorded; deliver now.
		if (this.settledRuns.delete(runId)) {
			void this.settle(runId);
		}
	}

	/**
	 * Delivers the pending final summary for exactly this run. Other runs'
	 * pending results are left untouched. When nothing is pending yet, the
	 * run is remembered so a later `queue()` delivers immediately.
	 */
	async settle(runId: string): Promise<void> {
		const result = this.pending.get(runId);
		if (!result) {
			this.settledRuns.add(runId);
			return;
		}
		this.pending.delete(runId);
		this.send(
			{
				customType: PWR_RESULT_CUSTOM_TYPE,
				content: `${completionHeader(result.scriptName, result.runId)}\n\n${result.summary}`,
				display: true,
				details: { runId: result.runId },
			},
			// Wake the main agent: deliverAs "followUp" matches the
			// /workflow generation path — idle sessions open a new turn,
			// streaming sessions queue the message and drain it into a new
			// turn when the current one stops. "steer" would interrupt an
			// in-flight turn; "nextTurn" only waits for user input.
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	hasPending(): boolean {
		return this.pending.size > 0;
	}

	/** Number of settled-but-not-yet-delivered runs (diagnostics/tests). */
	hasSettled(runId: string): boolean {
		return this.settledRuns.has(runId);
	}
}
