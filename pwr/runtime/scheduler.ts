/**
 * PWR runtime — run scheduler (PRD 5.3)
 *
 * FIFO queue of runs plus a per-run semaphore. The per-run concurrency
 * semaphore (hard cap 128) is enforced by the script interpreter; this
 * module owns the FIFO start order and an optional cap on concurrently
 * active runs (`maxActiveRuns`, unlimited by default). Runs that are
 * paused while queued are withdrawn from the queue; resume re-inserts at
 * the head (the run already passed the gate once).
 */

export class RunScheduler {
	private readonly queue: string[] = [];
	private readonly executors = new Map<string, () => Promise<void>>();
	private readonly activeRuns = new Set<string>();
	/**
	 * Resumes requested while the run's previous executor is still winding
	 * down (e.g. a runner that ignored the abort signal). The run is
	 * re-inserted at the head the moment the old executor settles, so a
	 * resume is never lost and the old executor can never leave the run
	 * stuck in `queued`.
	 */
	private readonly pendingResumes = new Map<string, () => Promise<void>>();
	private readonly maxActiveRuns: number;

	constructor(maxActiveRuns = Number.POSITIVE_INFINITY) {
		this.maxActiveRuns =
			Number.isFinite(maxActiveRuns) && maxActiveRuns > 0 ? Math.floor(maxActiveRuns) : Number.POSITIVE_INFINITY;
	}

	/** FIFO: append at the tail. */
	enqueue(runId: string, executor: () => Promise<void>): void {
		this.executors.set(runId, executor);
		if (this.activeRuns.has(runId)) return;
		if (!this.queue.includes(runId)) this.queue.push(runId);
		this.pump();
	}

	/** Resume: re-insert at the head so an already-started run is re-dispatched first. */
	enqueueFront(runId: string, executor: () => Promise<void>): void {
		this.executors.set(runId, executor);
		if (this.activeRuns.has(runId)) {
			// The old executor is still active; remember the resume and
			// re-insert the run the moment it settles.
			this.pendingResumes.set(runId, executor);
			return;
		}
		this.pendingResumes.delete(runId);
		const idx = this.queue.indexOf(runId);
		if (idx > 0) this.queue.splice(idx, 1);
		if (idx !== 0) this.queue.unshift(runId);
		this.pump();
	}

	/** Withdraw a queued (not yet started) run, e.g. pause/stop while queued. */
	dequeue(runId: string): void {
		this.pendingResumes.delete(runId);
		const idx = this.queue.indexOf(runId);
		if (idx >= 0) this.queue.splice(idx, 1);
		this.executors.delete(runId);
	}

	isQueued(runId: string): boolean {
		return this.queue.includes(runId);
	}

	isActive(runId: string): boolean {
		return this.activeRuns.has(runId);
	}

	get activeCount(): number {
		return this.activeRuns.size;
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	private pump(): void {
		while (this.queue.length > 0 && this.activeRuns.size < this.maxActiveRuns) {
			const runId = this.queue.shift()!;
			const executor = this.executors.get(runId);
			if (!executor) continue;
			this.activeRuns.add(runId);
			void executor().finally(() => {
				this.activeRuns.delete(runId);
				this.executors.delete(runId);
				const pending = this.pendingResumes.get(runId);
				this.pendingResumes.delete(runId);
				if (pending) {
					this.executors.set(runId, pending);
					this.queue.unshift(runId);
				}
				this.pump();
			});
		}
	}
}
