/**
 * PWR ScriptInterpreter — a per-AST-node tree-walking interpreter.
 *
 * The interpreter executes validated PWR scripts directly from their AST. It
 * never hands Node privileges to the script: no `node:vm`, no `eval`, no
 * `Function` constructor. Values created by scripts are plain data; the only
 * globals are the whitelisted APIs (meta/args/agent/pipeline/parallel/sleep/
 * JSON). Property access is filtered at runtime (forbidden key names),
 * loops run under an iteration budget, agent() invocations run under a
 * per-run semaphore (hard cap 128) and a 1,000-invocation hard cap.
 */

import { createSemaphore, type Semaphore } from "./concurrency.ts";
import {
	BreakSignal,
	ContinueSignal,
	ErrorCodes,
	ReturnSignal,
	ScriptError,
	type ScriptEndPosition,
	type ScriptErrorCode,
	type ScriptPosition,
} from "./errors.ts";
import { RunnerError } from "../runner/errors.ts";
import { nodeEnd, nodeStart, parseScript, type AcornNode, type Program } from "./parser.ts";
import { assertPlainData, isPlainObject, sanitizeHostValue } from "./plain.ts";
import {
	DEFAULT_SLEEP_MAX_MS,
	FORBIDDEN_PROPERTY_NAMES,
	clampConcurrency,
	clampLoopIterations,
	clampMaxAgents,
} from "./spec.ts";
import {
	validateScriptStrict,
	type ValidatedScript,
	type WorkflowMeta,
} from "./validator.ts";

/** Agent runner contract (PRD 5.4). The PiAgentRunner adapter implements it. */
export interface AgentRunSpec {
	runId?: string;
	agentId?: string;
	prompt: string;
	label?: string;
	tools?: "readonly" | "write";
	schema?: unknown;
	/** Optional model override for this agent call (definition pin > this > PWR default). */
	model?: string;
	signal?: AbortSignal;
}

export interface AgentRunResult {
	result: unknown;
	summary: string;
	usage?: Record<string, unknown>;
	events?: unknown[];
}

export interface AgentRunner {
	run(spec: AgentRunSpec): Promise<AgentRunResult>;
}

export interface RunOptions {
	/** Agent runner adapter; agent() fails with AGENT_RUNNER_UNAVAILABLE when absent. */
	runner?: AgentRunner;
	/** Structured arguments exposed to the script as the `args` global. */
	args?: Record<string, unknown>;
	/** Effective concurrency for the run. Clamped to [1, 128]. Default 4. */
	concurrency?: number;
	/** Hard cap for agent() invocations in this run. Clamped to [1, 1000]. */
	maxAgents?: number;
	/** Loop iteration budget (infinite-loop guard). Default 100_000. */
	maxLoopIterations?: number;
	/** Upper bound for sleep(ms) (scheduling backoff only). Default 60_000. */
	sleepMaxMs?: number;
	/** AbortSignal for pause/stop. */
	signal?: AbortSignal;
	/** Skip static validation (interpreter stays defensive, but keep validation on unless pre-validated). */
	skipValidation?: boolean;
}

export interface RunStats {
	agentCalls: number;
	loopIterations: number;
	durationMs: number;
	effectiveConcurrency: number;
	effectiveMaxAgents: number;
}

export interface RunResult {
	value: unknown;
	meta: WorkflowMeta | undefined;
	stats: RunStats;
}

/**
 * Script functions are *real* JS functions backed by interpreter metadata.
 * This lets native methods (Array.prototype.map / filter / forEach ...)
 * invoke script callbacks normally, while all execution still goes through
 * the tree-walking interpreter (never through Node's Function semantics).
 */
interface ScriptFnData {
	kind: "script";
	name: string;
	params: AcornNode[];
	body: AcornNode;
	closure: Env;
}

/** Host API functions created by the interpreter (agent/pipeline/parallel/sleep). */
const HOST_FNS = new WeakSet<object>();
/** Script-created functions (real closures delegating to the interpreter). */
const SCRIPT_FNS = new WeakSet<object>();
const SCRIPT_FN_DATA = new WeakMap<object, ScriptFnData>();

/** Array methods that accept callbacks — reimplemented async-safe. */
const CALLBACK_METHODS: ReadonlySet<string> = new Set([
	"map",
	"filter",
	"forEach",
	"some",
	"every",
	"find",
	"findIndex",
	"flatMap",
	"reduce",
	"reduceRight",
	"sort",
]);

function isScriptFn(v: unknown): v is ScriptFnData {
	return typeof v === "function" && SCRIPT_FNS.has(v);
}

class Env {
	private readonly vars = new Map<string, unknown>();
	readonly parent: Env | null;

	constructor(parent: Env | null) {
		this.parent = parent;
	}

	set(name: string, value: unknown): void {
		this.vars.set(name, value);
	}

	hasLocal(name: string): boolean {
		return this.vars.has(name);
	}

	lookup(name: string): unknown {
		for (let e: Env | null = this; e; e = e.parent) {
			if (e.vars.has(name)) return e.vars.get(name);
		}
		return undefined;
	}

	assign(name: string, value: unknown): boolean {
		for (let e: Env | null = this; e; e = e.parent) {
			if (e.vars.has(name)) {
				e.vars.set(name, value);
				return true;
			}
		}
		return false;
	}
}

interface ExecContext {
	runner?: AgentRunner;
	args: unknown;
	signal?: AbortSignal;
	semaphore: Semaphore;
	maxAgents: number;
	agentCalls: number;
	maxLoopIterations: number;
	loopIterations: number;
	sleepMaxMs: number;
}

function normalizeRuntimeError(err: unknown): ScriptError {
	if (err instanceof ScriptError) return err;
	if (err instanceof Error) {
		return new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, `运行时错误：${err.message}`);
	}
	return new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, `运行时错误：${String(err)}`);
}

/**
 * Errors that onError: "continue" must NEVER swallow: run-level abort,
 * budget and loop guards, and a missing runner — these are run-fatal by
 * design, not per-item failures.
 */
function fatal(err: unknown): boolean {
	return (
		err instanceof ScriptError &&
		(err.code === ErrorCodes.SCRIPT_ABORTED ||
			err.code === ErrorCodes.AGENT_LIMIT_EXCEEDED ||
			err.code === ErrorCodes.SCRIPT_LOOP_LIMIT_EXCEEDED ||
			err.code === ErrorCodes.AGENT_RUNNER_UNAVAILABLE)
	);
}

/** Stable error code for a thrown value (ScriptError/RunnerError carry theirs). */
function codeOf(err: unknown): string {
	return err instanceof ScriptError || err instanceof RunnerError ? err.code : "SCRIPT_RUNTIME_ERROR";
}

export class ScriptInterpreter {
	private ctx: ExecContext | null = null;

	async execute(source: string, options: RunOptions = {}): Promise<RunResult> {
		const startedAt = Date.now();
		const validated: ValidatedScript = options.skipValidation
			? ({ source, ast: parseScript(source) } as ValidatedScript)
			: validateScriptStrict(source);

		const ctx: ExecContext = {
			runner: options.runner,
			args:
				options.args === undefined
					? undefined
					: sanitizeHostValue(options.args),
			signal: options.signal,
			semaphore: createSemaphore(options.concurrency, options.signal),
			maxAgents: clampMaxAgents(options.maxAgents),
			agentCalls: 0,
			maxLoopIterations: clampLoopIterations(options.maxLoopIterations),
			loopIterations: 0,
			sleepMaxMs:
				typeof options.sleepMaxMs === "number" && Number.isFinite(options.sleepMaxMs)
					? Math.max(0, options.sleepMaxMs)
					: DEFAULT_SLEEP_MAX_MS,
		};
		this.ctx = ctx;

		const globalEnv = new Env(null);
		this.seedGlobals(globalEnv, ctx);

		// `meta` is always bound (undefined when the script has no export).
		globalEnv.set("meta", validated.meta);
		globalEnv.set("args", ctx.args);

		let value: unknown;
		try {
			await this.evalStatements(validated.ast.body as AcornNode[], globalEnv);
			value = undefined;
		} catch (err) {
			if (err instanceof ReturnSignal) value = err.value;
			else throw normalizeRuntimeError(err);
		}

		assertPlainData(value);
		return {
			value,
			meta: validated.meta,
			stats: {
				agentCalls: ctx.agentCalls,
				loopIterations: ctx.loopIterations,
				durationMs: Date.now() - startedAt,
				effectiveConcurrency: ctx.semaphore.capacity,
				effectiveMaxAgents: ctx.maxAgents,
			},
		};
	}

	private seedGlobals(env: Env, ctx: ExecContext): void {
		const interp = this;
		const agent = async (...args: unknown[]) => interp.hostAgent(ctx, args);
		const pipeline = async (...args: unknown[]) => interp.hostPipeline(ctx, args);
		const parallel = async (...args: unknown[]) => interp.hostParallel(ctx, args);
		const sleep = async (...args: unknown[]) => interp.hostSleep(ctx, args);
		for (const fn of [agent, pipeline, parallel, sleep]) HOST_FNS.add(fn);
		env.set("agent", agent);
		env.set("pipeline", pipeline);
		env.set("parallel", parallel);
		env.set("sleep", sleep);
		env.set("JSON", JSON);
	}

	// ------------------------------------------------------------------
	// Host APIs
	// ------------------------------------------------------------------

	private async hostAgent(ctx: ExecContext, args: unknown[]): Promise<unknown> {
		const callNode: AcornNode | undefined = undefined;
		if (args.length === 0 || typeof args[0] !== "string") {
			throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "agent(prompt, options?) 第一个参数必须是字符串", callNode);
		}
		const prompt = args[0] as string;
		let label: string | undefined;
		let agent: string | undefined;
		let tools: "readonly" | "write" | undefined;
		let schema: unknown;
		let model: string | undefined;
		if (args[1] !== undefined) {
			if (!isPlainObject(args[1])) {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "agent() 的 options 必须是对象", callNode);
			}
			// Single-pass snapshot: options (incl. schema) are captured and
			// validated exactly once at the boundary; the argument object is
			// never re-read afterwards.
			const opts = sanitizeHostValue(args[1]) as Record<string, unknown>;
			if (opts.label !== undefined && typeof opts.label !== "string") {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "agent() 的 options.label 必须是字符串", callNode);
			}
			// JHL-14: optional agent id (e.g. scout/planner/reviewer/worker).
			// Unknown ids fail in the runner adapter BEFORE any process starts.
			if (opts.agent !== undefined && typeof opts.agent !== "string") {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "agent() 的 options.agent 必须是字符串", callNode);
			}
			if (opts.tools !== undefined && opts.tools !== "readonly" && opts.tools !== "write") {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "agent() 的 options.tools 必须是 'readonly' 或 'write'", callNode);
			}
			if (opts.schema !== undefined && !isPlainObject(opts.schema)) {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "agent() 的 options.schema 必须是对象", callNode);
			}
			if (opts.model !== undefined && typeof opts.model !== "string") {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "agent() 的 options.model 必须是字符串", callNode);
			}
			label = opts.label as string | undefined;
			agent = opts.agent as string | undefined;
			tools = opts.tools as "readonly" | "write" | undefined;
			schema = opts.schema;
			model = opts.model as string | undefined;
		}

		this.checkAborted();
		ctx.agentCalls++;
		if (ctx.agentCalls > ctx.maxAgents) {
			throw this.rt(
				ErrorCodes.AGENT_LIMIT_EXCEEDED,
				`单次运行 agent() 调用超过硬上限 ${ctx.maxAgents}`,
			);
		}
		if (!ctx.runner) {
			throw this.rt(ErrorCodes.AGENT_RUNNER_UNAVAILABLE, "Agent runner 不可用（未注入 runner）");
		}

		let release: () => void;
		try {
			release = await ctx.semaphore.acquire();
		} catch {
			throw this.rt(ErrorCodes.SCRIPT_ABORTED, "运行已中止");
		}
		try {
			const result = await ctx.runner.run({
				agentId: agent,
				prompt,
				label,
				tools,
				schema,
				model,
				signal: ctx.signal,
			});
			// Host boundary: agent() results are strictly validated as plain
			// data and deep-cloned, so host objects (and their methods) never
			// become callable from the script.
			return sanitizeHostValue(result.result);
		} catch (err) {
			if (err instanceof ScriptError) throw err;
			// JHL-14: adapter errors (UNKNOWN_AGENT / AGENT_EXECUTION_ERROR /
			// AGENT_ABORTED / AGENT_RUNNER_UNAVAILABLE) pass through so the
			// runtime records the precise task error code.
			if (err instanceof RunnerError) throw err;
			if (err instanceof Error) {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, `agent() 执行失败：${err.message}`);
			}
			throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "agent() 执行失败");
		} finally {
			release();
		}
	}

	private async hostPipeline(ctx: ExecContext, args: unknown[]): Promise<unknown> {
		if (!Array.isArray(args[0])) {
			throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "pipeline(items, fn, options?) 第一个参数必须是数组");
		}
		const items = args[0] as unknown[];
		const fn = args[1];
		if (!this.isCallable(fn)) {
			throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "pipeline() 第二个参数必须是函数");
		}
		let requested: number | undefined;
		let onError: "fail" | "continue" = "fail";
		if (args[2] !== undefined) {
			if (!isPlainObject(args[2])) {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "pipeline() 的 options 必须是对象");
			}
			// Single-pass snapshot: options are captured and validated exactly
			// once at the boundary; the argument object is never re-read.
			const opts = sanitizeHostValue(args[2]) as Record<string, unknown>;
			if (opts.concurrency !== undefined && typeof opts.concurrency !== "number") {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "pipeline() 的 options.concurrency 必须是数字");
			}
			requested = opts.concurrency as number | undefined;
			if (opts.onError !== undefined && opts.onError !== "fail" && opts.onError !== "continue") {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "pipeline() 的 options.onError 必须是 'fail' 或 'continue'");
			}
			onError = opts.onError === "continue" ? "continue" : "fail";
		}

		const runCap = ctx.semaphore.capacity;
		const capacity = Math.min(clampConcurrency(requested ?? runCap), runCap);
		const results: unknown[] = new Array(items.length);
		const failures: Array<{ index: number; code: string; message: string }> = [];
		let next = 0;
		let failure: unknown = null;

		const worker = async (): Promise<void> => {
			for (;;) {
				this.checkAborted();
				if (failure !== null) return;
				if (next >= items.length) return;
				const i = next;
				next++;
				try {
					results[i] = await this.callValue(fn, [items[i], i]);
				} catch (err) {
					if (onError === "continue" && !fatal(err)) {
						failures.push({ index: i, code: codeOf(err), message: err instanceof Error ? err.message : String(err) });
						continue;
					}
					failure = err;
					throw err;
				}
			}
		};

		await Promise.all(Array.from({ length: capacity }, () => worker()));
		return onError === "continue" ? { results, failures } : results;
	}

	private async hostParallel(ctx: ExecContext, args: unknown[]): Promise<unknown> {
		if (!Array.isArray(args[0])) {
			throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "parallel(tasks, options?) 第一个参数必须是函数数组");
		}
		const tasks = args[0] as unknown[];
		let onError: "fail" | "continue" = "fail";
		if (args[1] !== undefined) {
			if (!isPlainObject(args[1])) {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "parallel() 的 options 必须是对象");
			}
			const opts = sanitizeHostValue(args[1]) as Record<string, unknown>;
			if (opts.onError !== undefined && opts.onError !== "fail" && opts.onError !== "continue") {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "parallel() 的 options.onError 必须是 'fail' 或 'continue'");
			}
			onError = opts.onError === "continue" ? "continue" : "fail";
		}
		this.checkAborted();
		if (onError === "continue") {
			const results: unknown[] = new Array(tasks.length);
			const failures: Array<{ index: number; code: string; message: string }> = [];
			await Promise.all(
				tasks.map(async (task, index) => {
					if (!this.isCallable(task)) {
						failures.push({ index, code: ErrorCodes.SCRIPT_RUNTIME_ERROR, message: `parallel() 第 ${index} 项不是函数` });
						return;
					}
					try {
						results[index] = await this.callValue(task, [index]);
					} catch (err) {
						if (!fatal(err)) {
							failures.push({ index, code: codeOf(err), message: err instanceof Error ? err.message : String(err) });
							return;
						}
						throw err;
					}
				}),
			);
			return { results, failures };
		}
		const results = await Promise.all(
			tasks.map(async (task, index) => {
				if (!this.isCallable(task)) {
					throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, `parallel() 第 ${index} 项不是函数`);
				}
				return this.callValue(task, [index]);
			}),
		);
		return results;
	}

	private async hostSleep(ctx: ExecContext, args: unknown[]): Promise<unknown> {
		if (typeof args[0] !== "number" || !Number.isFinite(args[0])) {
			throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "sleep(ms) 参数必须是有限数字");
		}
		const ms = Math.min(Math.max(0, args[0]), ctx.sleepMaxMs);
		await new Promise<void>((resolve, reject) => {
			if (ctx.signal?.aborted) {
				reject(new ScriptError(ErrorCodes.SCRIPT_ABORTED, "运行已中止"));
				return;
			}
			const timer = setTimeout(() => {
				ctx.signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				reject(new ScriptError(ErrorCodes.SCRIPT_ABORTED, "运行已中止"));
			};
			ctx.signal?.addEventListener("abort", onAbort, { once: true });
		});
		return undefined;
	}

	private isCallable(v: unknown): boolean {
		return typeof v === "function";
	}

	// ------------------------------------------------------------------
	// Core evaluation
	// ------------------------------------------------------------------

	private rt(code: ScriptErrorCode, message: string, node?: AcornNode | null): ScriptError {
		const start: ScriptPosition | undefined = node ? nodeStart(node) : undefined;
		const end: ScriptEndPosition | undefined = node ? nodeEnd(node) : undefined;
		return new ScriptError(code, message, start, end);
	}

	private checkAborted(node?: AcornNode | null): void {
		if (this.ctx?.signal?.aborted) {
			throw this.rt(ErrorCodes.SCRIPT_ABORTED, "运行已中止", node);
		}
	}

	private tickLoop(node: AcornNode): void {
		this.checkAborted(node);
		if (this.ctx) {
			this.ctx.loopIterations++;
			if (this.ctx.loopIterations > this.ctx.maxLoopIterations) {
				throw this.rt(
					ErrorCodes.SCRIPT_LOOP_LIMIT_EXCEEDED,
					`循环迭代预算超限（>${this.ctx.maxLoopIterations}）`,
					node,
				);
			}
		}
	}

	/** Invoke any callable value. Native functions (e.g. JSON.stringify, arr.push) are invoked with `thisArg`. */
	private async callValue(
		callee: unknown,
		args: unknown[],
		thisArg?: unknown,
	): Promise<unknown> {
		if (typeof callee === "function") {
			if (HOST_FNS.has(callee)) return callee(...args);
			if (SCRIPT_FNS.has(callee)) {
				const data = SCRIPT_FN_DATA.get(callee);
				if (data) return this.invokeScriptFn(data, args);
			}
			// Native functions can't await our script callbacks (they are
			// async), so callback-taking Array methods are reimplemented here.
			if (Array.isArray(thisArg) && CALLBACK_METHODS.has(callee.name)) {
				return this.invokeCallbackMethod(callee.name, thisArg, args);
			}
			return Reflect.apply(callee, thisArg ?? undefined, args);
		}
		throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, "目标不可调用");
	}

	/**
	 * Async-safe reimplementations of Array.prototype methods that take
	 * callbacks, so `arr.map(x => agent(...))` works with script functions.
	 * Non-callback Array methods (push/join/slice/...) run natively.
	 */
	private async invokeCallbackMethod(
		name: string,
		array: unknown[],
		args: unknown[],
	): Promise<unknown> {
		const callback = args[0];
		if (!this.isCallable(callback)) {
			throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, `${name}() 的回调必须是函数`);
		}
		const cb = (item: unknown, index: number) => this.callValue(callback, [item, index, array]);
		switch (name) {
			case "map": {
				const out: unknown[] = new Array(array.length);
				for (let i = 0; i < array.length; i++) out[i] = await cb(array[i], i);
				return out;
			}
			case "filter": {
				const out: unknown[] = [];
				for (let i = 0; i < array.length; i++) {
					if (await cb(array[i], i)) out.push(array[i]);
				}
				return out;
			}
			case "forEach": {
				for (let i = 0; i < array.length; i++) await cb(array[i], i);
				return undefined;
			}
			case "some": {
				for (let i = 0; i < array.length; i++) {
					if (await cb(array[i], i)) return true;
				}
				return false;
			}
			case "every": {
				for (let i = 0; i < array.length; i++) {
					if (!(await cb(array[i], i))) return false;
				}
				return true;
			}
			case "find": {
				for (let i = 0; i < array.length; i++) {
					if (await cb(array[i], i)) return array[i];
				}
				return undefined;
			}
			case "findIndex": {
				for (let i = 0; i < array.length; i++) {
					if (await cb(array[i], i)) return i;
				}
				return -1;
			}
			case "flatMap": {
				const out: unknown[] = [];
				for (let i = 0; i < array.length; i++) {
					const v = await cb(array[i], i);
					if (Array.isArray(v)) out.push(...v);
					else out.push(v);
				}
				return out;
			}
			case "reduce": {
				const hasInitial = args.length > 1;
				let acc = hasInitial ? args[1] : array[0];
				let start = hasInitial ? 0 : 1;
				if (!hasInitial && array.length === 0) {
					throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, "reduce() 空数组需要初始值");
				}
				for (let i = start; i < array.length; i++) {
					acc = await this.callValue(callback, [acc, array[i], i, array]);
				}
				return acc;
			}
			case "reduceRight": {
				const hasInitial = args.length > 1;
				let acc = hasInitial ? args[1] : array[array.length - 1];
				let start = hasInitial ? array.length - 1 : array.length - 2;
				if (!hasInitial && array.length === 0) {
					throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, "reduceRight() 空数组需要初始值");
				}
				for (let i = start; i >= 0; i--) {
					acc = await this.callValue(callback, [acc, array[i], i, array]);
				}
				return acc;
			}
			case "sort": {
				// stable insertion sort with an async comparator
				const out = array.slice();
				for (let i = 1; i < out.length; i++) {
					const key = out[i];
					let j = i - 1;
					while (j >= 0) {
						const cmp = (await this.callValue(callback, [out[j], key])) as number;
						if (cmp <= 0) break;
						out[j + 1] = out[j];
						j--;
					}
					out[j + 1] = key;
				}
				if (array.length === out.length) {
					for (let i = 0; i < out.length; i++) array[i] = out[i];
					return array;
				}
				return out;
			}
			default:
				throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, `不支持的方法 ${name}()`);
		}
	}

	private async invokeScriptFn(fn: ScriptFnData, args: unknown[]): Promise<unknown> {
		const fnEnv = new Env(fn.closure);
		for (let i = 0; i < fn.params.length; i++) {
			const param = fn.params[i]!;
			if (param.type === "RestElement") {
				await this.bindPattern((param as { argument?: AcornNode }).argument as AcornNode, args.slice(i), fnEnv, param);
				break;
			}
			if (param.type === "AssignmentPattern") {
				const left = (param as { left?: AcornNode }).left;
				const right = (param as { right?: AcornNode }).right;
				let value = i < args.length ? args[i] : undefined;
				if (value === undefined) {
					value = await this.evalExpr(right as AcornNode, fnEnv);
				}
				await this.bindPattern(left as AcornNode, value, fnEnv, param);
				continue;
			}
			await this.bindPattern(param, i < args.length ? args[i] : undefined, fnEnv, param);
		}
		try {
			if (fn.body.type === "BlockStatement") {
				await this.evalStatements((fn.body as { body?: AcornNode[] }).body ?? [], fnEnv);
				return undefined;
			}
			return await this.evalExpr(fn.body, fnEnv);
		} catch (err) {
			if (err instanceof ReturnSignal) return err.value;
			throw err;
		}
	}

	private async bindPattern(pattern: AcornNode, value: unknown, env: Env, at: AcornNode): Promise<void> {
		switch (pattern.type) {
			case "Identifier":
				env.set((pattern as any).name, value);
				return;
			case "AssignmentPattern": {
				const left = (pattern as { left?: AcornNode }).left;
				const right = (pattern as { right?: AcornNode }).right;
				let v = value;
				if (v === undefined) v = await this.evalExpr(right as AcornNode, env);
				await this.bindPattern(left as AcornNode, v, env, at);
				return;
			}
			case "ObjectPattern": {
				if (value === null || typeof value !== "object") {
					throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "解构目标不是对象", pattern);
				}
				const obj = value as Record<string, unknown>;
				const props = (pattern as { properties?: AcornNode[] }).properties ?? [];
				const restProps = props.filter(
					(p) => p?.type === "RestElement",
				);
				const restTarget: Record<string, unknown> = {};
				if (restProps.length > 0) {
					for (const key of Object.keys(obj)) {
						if (FORBIDDEN_PROPERTY_NAMES.has(key)) continue;
						if (!this.patternKeyTaken(pattern, key)) restTarget[key] = obj[key];
					}
				}
				for (const prop of props) {
					const p = prop as AcornNode;
					if (p.type === "RestElement") {
						await this.bindPattern((p as { argument?: AcornNode }).argument as AcornNode, restTarget, env, at);
						continue;
					}
					if (p.type !== "Property") continue;
					const key = await this.propertyKey(p, env);
					await this.checkKey(key, p);
					await this.bindPattern((p as { value?: AcornNode }).value as AcornNode, obj[key], env, at);
				}
				return;
			}
			case "ArrayPattern": {
				if (!Array.isArray(value)) {
					throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "解构目标不是数组", pattern);
				}
				const arr = value as unknown[];
				let index = 0;
				for (const el of (pattern as { elements?: Array<AcornNode | null> }).elements ?? []) {
					if (!el) {
						index++;
						continue;
					}
					if (el.type === "RestElement") {
						await this.bindPattern((el as { argument?: AcornNode }).argument as AcornNode, arr.slice(index), env, at);
						return;
					}
					await this.bindPattern(el, arr[index], env, at);
					index++;
				}
				return;
			}
			default:
				throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `不支持的解构形式（${pattern.type}）`, pattern);
		}
	}

	private patternKeyTaken(pattern: AcornNode, key: string): boolean {
		for (const prop of (pattern as { properties?: AcornNode[] }).properties ?? []) {
			const p = prop as AcornNode;
			if (!p || p.type !== "Property") continue;
			if ((p as { computed?: boolean }).computed) continue;
			const keyNode = (p as { key?: AcornNode }).key;
			if (!keyNode) continue;
			if (keyNode.type === "Identifier" && (keyNode as any).name === key) return true;
			if (keyNode.type === "Literal" && (keyNode as { value?: unknown }).value === key) return true;
		}
		return false;
	}

	private async propertyKey(prop: AcornNode, env: Env): Promise<string> {
		const computed = Boolean((prop as { computed?: boolean }).computed);
		const keyNode = (prop as { key?: AcornNode }).key as AcornNode;
		if (!computed) {
			if (keyNode.type === "Identifier") return (keyNode as any).name;
			if (keyNode.type === "Literal") return String((keyNode as { value?: unknown }).value);
		}
		const v = await this.evalExpr(keyNode, env);
		if (v === null || v === undefined) {
			throw new ScriptError(ErrorCodes.SCRIPT_RUNTIME_ERROR, "属性键不能为 null/undefined");
		}
		return String(v);
	}

	private async checkKey(key: string, node?: AcornNode): Promise<string> {
		if (FORBIDDEN_PROPERTY_NAMES.has(key)) {
			throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止访问/定义属性 "${key}"`, node);
		}
		return key;
	}

	private async evalExpr(expr: AcornNode, env: Env): Promise<unknown> {
		switch (expr.type) {
			case "Identifier": {
				const name = (expr as any).name;
				if (!this.hasBinding(env, name)) {
					throw this.rt(ErrorCodes.SCRIPT_UNKNOWN_API, `未知的全局/API：${name}`, expr);
				}
				return env.lookup(name);
			}
			case "Literal":
				return (expr as { value?: unknown }).value;
			case "TemplateLiteral": {
				const quasis = (expr as { quasis?: AcornNode[] }).quasis ?? [];
				const expressions = (expr as { expressions?: AcornNode[] }).expressions ?? [];
				let out = "";
				for (let i = 0; i < quasis.length; i++) {
					out += (quasis[i] as { value?: { cooked?: string } }).value?.cooked ?? "";
					if (i < expressions.length) {
						out += String(await this.evalExpr(expressions[i]!, env));
					}
				}
				return out;
			}
			case "ObjectExpression":
				return this.evalObject(expr, env);
			case "ArrayExpression": {
				const out: unknown[] = [];
				for (const el of (expr as { elements?: Array<AcornNode | null> }).elements ?? []) {
					if (!el) {
						out.push(undefined);
						continue;
					}
					if (el.type === "SpreadElement") {
						const v = await this.evalExpr((el as { argument?: AcornNode }).argument as AcornNode, env);
						if (!Array.isArray(v)) {
							throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "数组展开目标必须是数组", el);
						}
						out.push(...v);
						continue;
					}
					out.push(await this.evalExpr(el, env));
				}
				return out;
			}
			case "CallExpression":
			case "OptionalCallExpression":
				return this.evalCall(expr as AcornNode & { optional?: boolean }, env);
			case "MemberExpression":
			case "OptionalMemberExpression":
				return this.evalMember(expr as AcornNode & { optional?: boolean }, env);
			case "ChainExpression":
				return this.evalExpr((expr as { expression?: AcornNode }).expression as AcornNode, env);
			case "UnaryExpression": {
				const arg = await this.evalExpr((expr as { argument?: AcornNode }).argument as AcornNode, env);
				switch ((expr as { operator?: string }).operator) {
					case "!":
						return !arg;
					case "-":
						return -(arg as number);
					case "+":
						return +(arg as number);
					case "~":
						return ~(arg as number);
					case "typeof":
						return typeof arg;
					default:
						throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "禁止的一元操作符", expr);
				}
			}
			case "BinaryExpression":
			case "LogicalExpression":
				return this.evalBinary(expr as AcornNode & { operator?: string }, env);
			case "AssignmentExpression":
				return this.evalAssignment(expr, env);
			case "UpdateExpression":
				return this.evalUpdate(expr, env);
			case "ConditionalExpression": {
				const cond = expr as { test?: AcornNode; consequent?: AcornNode; alternate?: AcornNode };
				const test = await this.evalExpr(cond.test as AcornNode, env);
				return test
					? await this.evalExpr(cond.consequent as AcornNode, env)
					: await this.evalExpr(cond.alternate as AcornNode, env);
			}
			case "AwaitExpression": {
				this.checkAborted(expr);
				const arg = (expr as { argument?: AcornNode }).argument as AcornNode;
				return await this.evalExpr(arg, env);
			}
			case "ArrowFunctionExpression":
			case "FunctionExpression":
			case "FunctionDeclaration": {
				const fnNode = expr as { id?: AcornNode | null; params?: AcornNode[]; body?: AcornNode };
				const data: ScriptFnData = {
					kind: "script",
					name: (fnNode.id as { name?: string } | null)?.name ?? "(anonymous)",
					params: fnNode.params ?? [],
					body: fnNode.body as AcornNode,
					closure: env,
				};
				const fn = async (...fnArgs: unknown[]) => this.invokeScriptFn(data, fnArgs);
				SCRIPT_FNS.add(fn);
				SCRIPT_FN_DATA.set(fn, data);
				return fn;
			}
			case "ThisExpression":
			case "Super":
			case "NewExpression":
			case "TaggedTemplateExpression":
			case "SequenceExpression":
			case "YieldExpression":
			case "ClassExpression":
			case "ClassDeclaration":
			case "ImportExpression":
			case "MetaProperty":
				throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止的语法（${expr.type}）`, expr);
			default:
				throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `不支持的表达式（${expr.type}）`, expr);
		}
	}

	private hasBinding(env: Env, name: string): boolean {
		for (let e: Env | null = env; e; e = e.parent) {
			if (e.hasLocal(name)) return true;
		}
		return false;
	}

	private async evalObject(expr: AcornNode, env: Env): Promise<unknown> {
		const target: Record<string, unknown> = {};
		for (const prop of (expr as { properties?: AcornNode[] }).properties ?? []) {
			const p = prop as AcornNode;
			if (p.type === "SpreadElement") {
				const v = await this.evalExpr((p as { argument?: AcornNode }).argument as AcornNode, env);
				if (v === null || typeof v !== "object") {
					throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "展开目标必须是对象/数组", p);
				}
				for (const key of Object.keys(v as object)) {
					await this.checkKey(key, p);
					target[key] = (v as Record<string, unknown>)[key];
				}
				continue;
			}
			if (p.type !== "Property") continue;
			const key = await this.propertyKey(p, env);
			await this.checkKey(key, p);
			target[key] = await this.evalExpr((p as { value?: AcornNode }).value as AcornNode, env);
		}
		return target;
	}

	private async evalBinary(expr: AcornNode & { operator?: string }, env: Env): Promise<unknown> {
		const bin = expr as { operator?: string; left?: AcornNode; right?: AcornNode };
		const op = bin.operator ?? "";
		if (op === "&&" || op === "||" || op === "??") {
			const left = await this.evalExpr(bin.left as AcornNode, env);
			if (op === "&&") return left ? await this.evalExpr(bin.right as AcornNode, env) : left;
			if (op === "||") return left ? left : await this.evalExpr(bin.right as AcornNode, env);
			return left === null || left === undefined
				? await this.evalExpr(bin.right as AcornNode, env)
				: left;
		}
		const left = await this.evalExpr(bin.left as AcornNode, env);
		const right = await this.evalExpr(bin.right as AcornNode, env);
		const a = left as number;
		const b = right as number;
		switch (op) {
			case "==":
				return left == right;
			case "!=":
				return left != right;
			case "===":
				return left === right;
			case "!==":
				return left !== right;
			case "<":
				return a < b;
			case "<=":
				return a <= b;
			case ">":
				return a > b;
			case ">=":
				return a >= b;
			case "+":
				return (left as any) + (right as any);
			case "-":
				return a - b;
			case "*":
				return a * b;
			case "/":
				return a / b;
			case "%":
				return a % b;
			case "**":
				return a ** b;
			case "&":
				return a & b;
			case "|":
				return a | b;
			case "^":
				return a ^ b;
			case "<<":
				return a << b;
			case ">>":
				return a >> b;
			case ">>>":
				return a >>> b;
			default:
				throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止的操作符 ${op}`, expr);
		}
	}

	private async evalAssignment(expr: AcornNode, env: Env): Promise<unknown> {
		const asg = expr as { operator?: string; left?: AcornNode; right?: AcornNode };
		const op = asg.operator ?? "=";
		const left = asg.left as AcornNode;

		if (left.type === "ObjectPattern" || left.type === "ArrayPattern") {
			if (op !== "=") {
				throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "解构赋值仅支持 =", expr);
			}
			const v = await this.evalExpr(asg.right as AcornNode, env);
			await this.bindPattern(left, v, env, expr);
			return v;
		}

		if (left.type === "Identifier") {
			const name = (left as any).name;
			if (!this.hasBinding(env, name)) {
				throw this.rt(ErrorCodes.SCRIPT_UNKNOWN_API, `未知的全局/API：${name}`, expr);
			}
			const cur = env.lookup(name);
			if (op === "=") {
				const v = await this.evalExpr(asg.right as AcornNode, env);
				env.assign(name, v);
				return v;
			}
			const v = await this.evalExpr(asg.right as AcornNode, env);
			const next = this.applyCompound(op, cur, v, expr);
			env.assign(name, next);
			return next;
		}

		if (left.type === "MemberExpression") {
			const { object, key } = await this.evalMemberRef(left as AcornNode, env);
			if (typeof object !== "object" || object === null) {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "无法给 null/基本类型赋值", expr);
			}
			if (op === "=") {
				const v = await this.evalExpr(asg.right as AcornNode, env);
				(object as Record<string, unknown>)[key] = v;
				return v;
			}
			const cur = (object as Record<string, unknown>)[key];
			const v = await this.evalExpr(asg.right as AcornNode, env);
			const next = this.applyCompound(op, cur, v, expr);
			(object as Record<string, unknown>)[key] = next;
			return next;
		}

		throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "不允许的赋值目标", expr);
	}

	private async evalUpdate(expr: AcornNode, env: Env): Promise<unknown> {
		const upd = expr as { operator?: string; argument?: AcornNode; prefix?: boolean };
		const isPrefix = Boolean(upd.prefix);
		const delta = upd.operator === "++" ? 1 : -1;
		const target = upd.argument as AcornNode;
		if (target.type === "Identifier") {
			const name = (target as any).name;
			if (!this.hasBinding(env, name)) {
				throw this.rt(ErrorCodes.SCRIPT_UNKNOWN_API, `未知的全局/API：${name}`, expr);
			}
			const cur = env.lookup(name) as number;
			const next = cur + delta;
			env.assign(name, next);
			return isPrefix ? next : cur;
		}
		if (target.type === "MemberExpression") {
			const { object, key } = await this.evalMemberRef(target as AcornNode, env);
			if (typeof object !== "object" || object === null) {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "无法给 null/基本类型赋值", expr);
			}
			const cur = (object as Record<string, unknown>)[key] as number;
			const next = cur + delta;
			(object as Record<string, unknown>)[key] = next;
			return isPrefix ? next : cur;
		}
		throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, "不允许的 ++/-- 目标", expr);
	}

	private applyCompound(op: string, left: unknown, right: unknown, at: AcornNode): unknown {
		const a = left as number;
		const b = right as number;
		switch (op) {
			case "+=":
				return (left as any) + (right as any);
			case "-=":
				return a - b;
			case "*=":
				return a * b;
			case "/=":
				return a / b;
			case "%=":
				return a % b;
			case "**=":
				return a ** b;
			case "&=":
				return a & b;
			case "|=":
				return a | b;
			case "^=":
				return a ^ b;
			case "<<=":
				return a << b;
			case ">>=":
				return a >> b;
			case ">>>=":
				return a >>> b;
			case "&&=":
				return left ? b : left;
			case "||=":
				return left ? left : b;
			case "??=":
				return left === null || left === undefined ? b : left;
			default:
				throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `禁止的赋值操作符 ${op}`, at);
		}
	}

	/** Resolve an (object, key) pair with runtime key checks. */
	private async evalMemberRef(
		mem: AcornNode & { optional?: boolean },
		env: Env,
	): Promise<{ object: unknown; key: string }> {
		const object = await this.evalExpr((mem as { object?: AcornNode }).object as AcornNode, env);
		const computed = Boolean((mem as { computed?: boolean }).computed);
		let key: string;
		if (computed) {
			const keyValue = await this.evalExpr((mem as { property?: AcornNode }).property as AcornNode, env);
			if (keyValue === null || keyValue === undefined) {
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "属性键不能为 null/undefined", mem);
			}
			key = String(keyValue);
		} else {
			const prop = (mem as { property?: AcornNode }).property as AcornNode;
			key =
				prop.type === "Identifier"
					? (prop as any).name
					: String((prop as { value?: unknown }).value);
		}
		await this.checkKey(key, mem);
		if (object === null || object === undefined) {
			if (mem.optional) return { object: undefined, key };
			throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, `无法读取 ${key}：目标为 null/undefined`, mem);
		}
		if (typeof object !== "object" && typeof object !== "function") {
			if (typeof object === "string") return { object, key };
			const primAllow =
				key === "toString" ||
				key === "valueOf" ||
				key === "toFixed" ||
				key === "toPrecision" ||
				key === "toExponential" ||
				/^\d+$/.test(key);
			if (primAllow) return { object, key };
			throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, `无法读取基本类型属性 "${key}"`, mem);
		}
		return { object, key };
	}

	private async evalMember(mem: AcornNode & { optional?: boolean }, env: Env): Promise<unknown> {
		const { object, key } = await this.evalMemberRef(mem, env);
		if (object === undefined && mem.optional) return undefined;
		return (object as Record<string, unknown>)[key];
	}

	private async evalCall(call: AcornNode & { optional?: boolean }, env: Env): Promise<unknown> {
		const calleeNode = (call as { callee?: AcornNode }).callee as AcornNode;
		this.checkAborted(call);
		let callee: unknown;
		let thisArg: unknown;
		if (calleeNode.type === "Identifier") {
			if (!this.hasBinding(env, (calleeNode as any).name)) {
				throw this.rt(
					ErrorCodes.SCRIPT_UNKNOWN_API,
					`未知的全局/API：${(calleeNode as any).name}`,
					call,
				);
			}
			callee = env.lookup((calleeNode as any).name);
			thisArg = undefined;
		} else if (
			calleeNode.type === "MemberExpression" ||
			calleeNode.type === "OptionalMemberExpression"
		) {
			const ref = await this.evalMemberRef(calleeNode as AcornNode & { optional?: boolean }, env);
			if (ref.object === undefined && (calleeNode as { optional?: boolean }).optional) {
				return undefined;
			}
			callee = (ref.object as Record<string, unknown>)[ref.key];
			thisArg = ref.object;
		} else {
			callee = await this.evalExpr(calleeNode, env);
			thisArg = undefined;
		}
		if (call.optional && (callee === null || callee === undefined)) {
			return undefined;
		}
		const args: unknown[] = [];
		for (const arg of (call as { arguments?: AcornNode[] }).arguments ?? []) {
			if (arg.type === "SpreadElement") {
				const v = await this.evalExpr((arg as { argument?: AcornNode }).argument as AcornNode, env);
				if (!Array.isArray(v)) {
					throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "调用参数展开目标必须是数组", arg);
				}
				args.push(...v);
				continue;
			}
			args.push(await this.evalExpr(arg, env));
		}
		try {
			return await this.callValue(callee, args, thisArg);
		} catch (err) {
			if (err instanceof ScriptError && !err.start) {
				throw this.rt(err.code, err.message, call);
			}
			throw err;
		}
	}

	private async evalStatements(stmts: AcornNode[], env: Env): Promise<void> {
		for (const stmt of stmts) {
			await this.evalStatement(stmt, env);
		}
	}

	private async evalStatement(stmt: AcornNode, env: Env): Promise<void> {
		switch (stmt.type) {
			case "ExpressionStatement": {
				await this.evalExpr((stmt as { expression?: AcornNode }).expression as AcornNode, env);
				return;
			}
			case "BlockStatement": {
				const blockEnv = new Env(env);
				await this.evalStatements((stmt as { body?: AcornNode[] }).body ?? [], blockEnv);
				return;
			}
			case "VariableDeclaration": {
				for (const d of (stmt as { declarations?: AcornNode[] }).declarations ?? []) {
					const declarator = d as { id?: AcornNode; init?: AcornNode | null };
					const initValue = declarator.init
						? await this.evalExpr(declarator.init, env)
						: undefined;
					await this.bindPattern(declarator.id as AcornNode, initValue, env, stmt);
				}
				return;
			}
			case "FunctionDeclaration": {
				const fn = await this.evalExpr(stmt, env);
				const name = (stmt as { id?: { name: string } }).id?.name;
				if (name) env.set(name, fn);
				return;
			}
			case "IfStatement": {
				const ifs = stmt as { test?: AcornNode; consequent?: AcornNode; alternate?: AcornNode | null };
				const test = await this.evalExpr(ifs.test as AcornNode, env);
				if (test) {
					await this.evalStatement(ifs.consequent as AcornNode, env);
				} else if (ifs.alternate) {
					await this.evalStatement(ifs.alternate, env);
				}
				return;
			}
			case "WhileStatement": {
				const ws = stmt as { test?: AcornNode; body?: AcornNode };
				while (await this.evalExpr(ws.test as AcornNode, env)) {
					this.tickLoop(stmt);
					try {
						await this.evalStatement(ws.body as AcornNode, env);
					} catch (err) {
						if (err instanceof BreakSignal) break;
						if (err instanceof ContinueSignal) continue;
						throw err;
					}
				}
				return;
			}
			case "DoWhileStatement": {
				const ds = stmt as { test?: AcornNode; body?: AcornNode };
				do {
					this.tickLoop(stmt);
					try {
						await this.evalStatement(ds.body as AcornNode, env);
					} catch (err) {
						if (err instanceof BreakSignal) break;
						if (err instanceof ContinueSignal) continue;
						throw err;
					}
				} while (await this.evalExpr(ds.test as AcornNode, env));
				return;
			}
			case "ForStatement": {
				const fs = stmt as {
					init?: AcornNode | null;
					test?: AcornNode | null;
					update?: AcornNode | null;
					body?: AcornNode;
				};
				const loopEnv = new Env(env);
				if (fs.init) {
					if (fs.init.type === "VariableDeclaration") {
						await this.evalStatement(fs.init, loopEnv);
					} else {
						await this.evalExpr(fs.init, loopEnv);
					}
				}
				for (;;) {
					if (fs.test && !(await this.evalExpr(fs.test, loopEnv))) break;
					this.tickLoop(stmt);
					let didContinue = false;
					try {
						await this.evalStatement(fs.body as AcornNode, loopEnv);
					} catch (err) {
						if (err instanceof BreakSignal) break;
						if (err instanceof ContinueSignal) didContinue = true;
						else throw err;
					}
					// `continue` still runs the update expression (JS semantics)
					if (fs.update) await this.evalExpr(fs.update, loopEnv);
					if (didContinue) continue;
				}
				return;
			}
			case "ForOfStatement": {
				const fos = stmt as { left?: AcornNode; right?: AcornNode; body?: AcornNode };
				const iterable = await this.evalExpr(fos.right as AcornNode, env);
				if (!Array.isArray(iterable) && typeof iterable !== "string") {
					throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, "for...of 仅可迭代数组或字符串", stmt);
				}
				const items: unknown[] = Array.isArray(iterable) ? iterable : Array.from(iterable as string);
				const left = fos.left as AcornNode;
				const patternNode =
					left.type === "VariableDeclaration"
						? ((left as { declarations?: AcornNode[] }).declarations?.[0]?.id as AcornNode)
						: left;
				for (const item of items) {
					this.tickLoop(stmt);
					const iterEnv = new Env(env);
					try {
						await this.bindPattern(patternNode, item, iterEnv, stmt);
						await this.evalStatement(fos.body as AcornNode, iterEnv);
					} catch (err) {
						if (err instanceof BreakSignal) break;
						if (err instanceof ContinueSignal) continue;
						throw err;
					}
				}
				return;
			}
			case "ReturnStatement": {
				const arg = (stmt as { argument?: AcornNode | null }).argument;
				const value = arg ? await this.evalExpr(arg, env) : undefined;
				throw new ReturnSignal(value);
			}
			case "ThrowStatement": {
				const value = await this.evalExpr((stmt as { argument?: AcornNode }).argument as AcornNode, env);
				if (value instanceof ScriptError) throw value;
				throw this.rt(ErrorCodes.SCRIPT_RUNTIME_ERROR, `脚本抛出错误：${String(value)}`, stmt);
			}
			case "TryStatement": {
				const ts = stmt as {
					block?: AcornNode;
					handler?: AcornNode | null;
					finalizer?: AcornNode | null;
				};
				try {
					await this.evalStatement(ts.block as AcornNode, env);
				} catch (err) {
					// Control-flow signals (return/break/continue) propagate
					// without touching the finalizer here — the single
					// `finally` below runs it exactly once.
					if (err instanceof BreakSignal || err instanceof ContinueSignal || err instanceof ReturnSignal) {
						throw err;
					}
					if (ts.handler) {
						const h = ts.handler as { param?: AcornNode | null; body?: AcornNode };
						const catchEnv = new Env(env);
						if (h.param) {
							await this.bindPattern(h.param, err, catchEnv, ts.handler);
						}
						await this.evalStatement(h.body as AcornNode, catchEnv);
					} else {
						// try/finally without a catch must not swallow errors.
						throw err;
					}
				} finally {
					if (ts.finalizer) await this.evalStatement(ts.finalizer, env);
				}
				return;
			}
			case "BreakStatement":
				throw new BreakSignal(undefined);
			case "ContinueStatement":
				throw new ContinueSignal(undefined);
			case "EmptyStatement":
				return;
			case "ExportNamedDeclaration":
				// `export const meta = ...` is pre-bound from the validated script.
				return;
			default:
				throw this.rt(ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX, `不支持的语句（${stmt.type}）`, stmt);
		}
	}
}

/** Run a script in one call. Convenience wrapper over ScriptInterpreter. */
export async function runScript(source: string, options: RunOptions = {}): Promise<RunResult> {
	return new ScriptInterpreter().execute(source, options);
}

export type { Program };
