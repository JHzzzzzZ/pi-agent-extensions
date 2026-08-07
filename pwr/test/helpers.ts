/**
 * Shared test helpers: a fake AgentRunner that records calls and measures
 * observed concurrency, plus the PRD sample script fixture.
 */

import type { AgentRunResult, AgentRunner, AgentRunSpec } from "../engine/interpreter.ts";

export interface FakeRunnerHandle {
	runner: AgentRunner;
	calls: Array<AgentRunSpec & { index: number }>;
	started: number;
	finished: number;
	maxConcurrent: number;
	current: number;
}

export interface FakeRunnerOptions {
	/** Per-call result factory. Defaults to { ok: true, index: <n> }. */
	result?: (prompt: string, label: string | undefined, index: number) => unknown;
	/** Simulated per-agent latency in ms. */
	delayMs?: number;
	/** If set, calls whose prompt contains this substring reject. */
	failOn?: string;
	/** Reject with this error when failOn matches. */
	failError?: Error;
	/** Abort-aware: while waiting, honor the run's signal. */
	respectSignal?: boolean;
}

export function makeFakeRunner(options: FakeRunnerOptions = {}): FakeRunnerHandle {
	const handle: FakeRunnerHandle = {
		runner: {
			async run(spec: AgentRunSpec): Promise<AgentRunResult> {
				handle.started++;
				handle.current++;
				if (handle.current > handle.maxConcurrent) handle.maxConcurrent = handle.current;
				const callIndex = handle.calls.length;
				handle.calls.push({ ...spec, index: callIndex });
				if (options.delayMs) {
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => {
							spec.signal?.removeEventListener("abort", onAbort);
							resolve();
						}, options.delayMs);
						const onAbort = () => {
							clearTimeout(timer);
							reject(new Error("aborted by signal"));
						};
						if (spec.signal?.aborted) {
							clearTimeout(timer);
							reject(new Error("aborted by signal"));
							return;
						}
						spec.signal?.addEventListener("abort", onAbort, { once: true });
					});
				}
				if (options.failOn && spec.prompt.includes(options.failOn)) {
					handle.current--;
					handle.finished++;
					throw options.failError ?? new Error(`runner failure on: ${spec.prompt.slice(0, 40)}`);
				}
				const result =
					options.result?.(spec.prompt, spec.label, callIndex) ?? {
						ok: true,
						index: callIndex,
						label: spec.label ?? null,
					};
				handle.current--;
				handle.finished++;
				return { result, summary: "ok" };
			},
		},
		calls: [],
		started: 0,
		finished: 0,
		maxConcurrent: 0,
		current: 0,
	};
	return handle;
}

/** The PRD v2.0 §5.1 sample script (audit-routes). */
export const PRD_SAMPLE = `
export const meta = {
  name: 'audit-routes',
  description: '审查路由鉴权并交叉验证',
  version: 1,
}

const files = await agent('列出 src/routes 下的 TypeScript 路由文件。', {
  label: 'discover', schema: { type: 'object', required: ['files'] }, tools: 'readonly',
})
const audits = await pipeline(files.files, file =>
  agent(\`审查 \${file} 是否缺少鉴权；返回结构化发现。\`, { label: file, tools: 'readonly' }),
  { concurrency: 8 },
)
return await agent('汇总、去重并交叉检查下列发现：' + JSON.stringify(audits), {
  label: 'verify', tools: 'readonly',
})
`;
