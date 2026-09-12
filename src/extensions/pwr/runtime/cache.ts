/**
 * PWR runtime — private result cache (PRD 5.3)
 *
 * Completed agents are cached session-privately under
 * `sha256(scriptDigest + normalized input)` — the PRD cache key
 * ("normalized input + script digest"). A pause/resume or a re-run of an
 * identical script in the same session replays cached results instead of
 * re-executing agents; only unfinished items dispatch new executions.
 *
 * The cache holds full results in run-private memory. What is exposed to
 * persistence / the main session is limited to the summary index
 * (persist.ts) — never raw tool output.
 */

import { createHash } from "node:crypto";
import { sanitizeUsage } from "./persist.ts";

/** The normalized agent input that participates in the cache key. */
export interface NormalizedAgentInput {
	prompt: string;
	label?: string;
	tools?: "readonly" | "write";
	schema?: unknown;
}

/**
 * Stable, key-order-sorted canonical JSON. Two inputs that differ only in
 * key insertion order (or undefined vs omitted) normalize to the same
 * string, so equivalent calls share one cache entry.
 */
export function normalizeInput(input: NormalizedAgentInput): string {
	return stableStringify({
		prompt: input.prompt,
		label: input.label ?? null,
		tools: input.tools ?? null,
		schema: input.schema ?? null,
	});
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return `{${keys
		.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
		.join(",")}}`;
}

/** PRD cache key: script digest + normalized agent input. */
export function cacheKey(scriptDigest: string, input: NormalizedAgentInput): string {
	return createHash("sha256")
		.update(`${scriptDigest}\n${normalizeInput(input)}`, "utf8")
		.digest("hex");
}

export interface CacheEntry {
	/** Cache key (script digest + normalized input). */
	key: string;
	scriptDigest: string;
	/** Task id of the execution that produced this entry. */
	taskId: string;
	/** Full result — run-private memory only, never persisted. */
	result: unknown;
	summary: string;
	usage?: Record<string, number>;
	createdAt: string;
}

/** Index item exposed to persistence; never carries the full result. */
export interface CacheIndexItem {
	key: string;
	taskId: string;
	summary: string;
	usage?: Record<string, number>;
}

export class RunCache {
	private readonly entries = new Map<string, CacheEntry>();

	has(key: string): boolean {
		return this.entries.has(key);
	}

	get(key: string): CacheEntry | undefined {
		return this.entries.get(key);
	}

	set(entry: CacheEntry): void {
		this.entries.set(entry.key, entry);
	}

	delete(key: string): boolean {
		return this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	/** Index only — summaries and usage numbers, never full results. */
	index(): CacheIndexItem[] {
		const items: CacheIndexItem[] = [];
		for (const entry of this.entries.values()) {
			items.push({
				key: entry.key,
				taskId: entry.taskId,
				summary: entry.summary,
				usage: sanitizeUsage(entry.usage),
			});
		}
		return items;
	}

	get size(): number {
		return this.entries.size;
	}
}
