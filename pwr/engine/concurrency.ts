/**
 * PWR run-level concurrency control.
 *
 * FIFO counting semaphore shared by agent()/pipeline()/parallel() within one
 * run. The effective capacity never exceeds MAX_CONCURRENCY_HARD_LIMIT (128,
 * Tony Stark 2026-08-05), and the default is configurable.
 */

import { clampConcurrency } from "./spec.ts";

export interface Semaphore {
	readonly capacity: number;
	readonly active: number;
	readonly waiting: number;
	acquire(): Promise<() => void>;
}

/**
 * Create a FIFO semaphore. `requested` is clamped to [1, hard limit].
 * All waiters are resolved on abort via `signal` (releasing them with an
 * error), so a stopped run never deadlocks its interpreter.
 */
export function createSemaphore(requested: number | undefined, signal?: AbortSignal): Semaphore {
	const capacity = clampConcurrency(requested);
	let active = 0;
	const queue: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];

	const release = () => {
		active--;
		const next = queue.shift();
		if (next) {
			active++;
			next.resolve();
		}
	};

	const abortHandler = () => {
		const err = new Error("aborted");
		for (const waiter of queue.splice(0)) waiter.reject(err);
		signal?.removeEventListener("abort", abortHandler);
	};

	if (signal) {
		if (signal.aborted) {
			// fail-fast: never queue anyone
			return {
				capacity,
				get active() {
					return active;
				},
				get waiting() {
					return queue.length;
				},
				acquire() {
					return Promise.reject(new Error("aborted"));
				},
			};
		}
		signal.addEventListener("abort", abortHandler, { once: true });
	}

	return {
		capacity,
		get active() {
			return active;
		},
		get waiting() {
			return queue.length;
		},
		acquire(): Promise<() => void> {
			if (active < capacity) {
				active++;
				return Promise.resolve(release);
			}
			return new Promise<() => void>((resolve, reject) => {
				queue.push({
					resolve: () => resolve(release),
					reject,
				});
			});
		},
	};
}
