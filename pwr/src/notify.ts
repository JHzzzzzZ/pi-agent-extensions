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
 */

import { MAX_FINAL_SUMMARY_SIZE, PWR_RESULT_CUSTOM_TYPE } from "./types.ts";

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

export class RunNotifier {
	private pending = new Map<string, PendingResult>();
	/** Runs whose settle arrived before their summary was queued. */
	private settledRuns = new Set<string>();
	private readonly send: SendMessageFn;
	private readonly hooks?: SettleHooks;

	constructor(send: SendMessageFn, hooks?: SettleHooks) {
		this.send = send;
		this.hooks = hooks;
		this.hooks?.onRunSettled?.((runId) => {
			void this.settle(runId);
		});
	}

	/** Queues a final summary for delivery when THIS run settles. */
	queue(runId: string, scriptName: string, summary: string): void {
		this.pending.set(runId, {
			runId,
			scriptName,
			summary: truncateSummary(summary),
		});
		// The run may have settled before the summary arrived; deliver now.
		if (this.settledRuns.delete(runId)) {
			void this.settle(runId);
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
				content: `**Workflow \`${result.scriptName}\` completed** (run ${result.runId.slice(0, 8)})\n\n${result.summary}`,
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

export function truncateSummary(summary: string): string {
	if (Buffer.byteLength(summary, "utf8") <= MAX_FINAL_SUMMARY_SIZE) return summary;
	let truncated = summary.slice(0, MAX_FINAL_SUMMARY_SIZE);
	while (Buffer.byteLength(truncated, "utf8") > MAX_FINAL_SUMMARY_SIZE) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Summary truncated.]`;
}
