/**
 * PWR script specification — the single source of truth for the DSL.
 *
 * PRD JHL-11 v2.0 §5.1/§5.2 and Tony Stark's 2026-08-05 concurrency decision:
 * hard concurrency cap 128 (replacing the PRD's "max 16"), 1,000 agents per
 * run unchanged, default concurrency configurable.
 */

/** Engine version. */
export const SCRIPT_VERSION = "1.1.2";

/** Hard limit on the raw script size (DoS guard for parse/validate). */
export const MAX_SCRIPT_BYTES = 256 * 1024;

/** Concurrency hard cap per run (Tony Stark 2026-08-05 approved). */
export const MAX_CONCURRENCY_HARD_LIMIT = 128;

/** Total agent() invocations hard cap per run (unchanged from PRD v2.0). */
export const MAX_AGENTS_HARD_LIMIT = 1000;

/** Default effective concurrency; configurable via RunOptions. */
export const DEFAULT_CONCURRENCY = 4;

/** Default loop iteration budget per run (infinite-loop guard). */
export const DEFAULT_MAX_LOOP_ITERATIONS = 100_000;

/** sleep() is only for scheduling backoff; this clamps its argument. */
export const DEFAULT_SLEEP_MAX_MS = 60_000;

/**
 * Globals a script may reference. `JSON` is required by the PRD sample
 * (`JSON.stringify`); it is a read-only value namespace with no host access.
 */
export const WHITELISTED_GLOBALS = [
	"meta",
	"args",
	"agent",
	"pipeline",
	"parallel",
	"sleep",
	"JSON",
] as const;

/** APIs that may be awaited. */
export const ASYNC_APIS: ReadonlySet<string> = new Set(["agent", "pipeline", "parallel", "sleep"]);

/**
 * Identifiers that are *explicitly* forbidden (reported as
 * SCRIPT_FORBIDDEN_SYNTAX). Includes Node built-ins, module systems,
 * dynamic code generation, reflection and host globals.
 */
export const FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set([
	// Node core globals / module system
	"process",
	"require",
	"module",
	"exports",
	"global",
	"globalThis",
	"Buffer",
	"queueMicrotask",
	"setImmediate",
	"clearImmediate",
	"structuredClone",
	"performance",
	// Node built-in modules (standalone identifiers are rejected too)
	"fs",
	"path",
	"os",
	"http",
	"https",
	"net",
	"tls",
	"dns",
	"dgram",
	"child_process",
	"worker_threads",
	"crypto",
	"zlib",
	"stream",
	"buffer",
	"events",
	"util",
	"url",
	"querystring",
	"readline",
	"string_decoder",
	"timers",
	"v8",
	"vm",
	"tty",
	"assert",
	"async_hooks",
	"cluster",
	"constants",
	"console",
	"punycode",
	"repl",
	"trace_events",
	"wasi",
	// dynamic code generation / reflection
	"eval",
	"Function",
	"Reflect",
	"Proxy",
	"Symbol",
	"Object",
	"Array",
	"String",
	"Number",
	"Boolean",
	"BigInt",
	"Date",
	"Math",
	"RegExp",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"Promise",
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"EvalError",
	"URIError",
	"AggregateError",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"escape",
	"unescape",
	"atob",
	"btoa",
	"TextEncoder",
	"TextDecoder",
	// timers / scheduling
	"setTimeout",
	"setInterval",
	"clearTimeout",
	"clearInterval",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	// web / network / storage globals
	"window",
	"document",
	"navigator",
	"location",
	"history",
	"fetch",
	"XMLHttpRequest",
	"WebSocket",
	"EventSource",
	"AbortController",
	"AbortSignal",
	"Event",
	"CustomEvent",
	"Blob",
	"File",
	"FileReader",
	"FormData",
	"Headers",
	"Request",
	"Response",
	"URL",
	"URLSearchParams",
	"URLPattern",
	"localStorage",
	"sessionStorage",
	"indexedDB",
	"caches",
	"Worker",
	"SharedWorker",
	"ServiceWorker",
	"Notification",
	// function-scope hazards
	"arguments",
	"caller",
	"callee",
]);

/**
 * Property names that may never be read/written on any value, statically
 * (literal keys) or at runtime (computed keys). Blocks prototype walking,
 * constructor reflection and function self-inspection.
 */
export const FORBIDDEN_PROPERTY_NAMES: ReadonlySet<string> = new Set([
	"__proto__",
	"prototype",
	"constructor",
	"caller",
	"callee",
	"arguments",
	"eval",
	"bind",
	"apply",
	"call",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
]);

/** Assignment / update targets that may not be mutated (API globals). */
export const IMMUTABLE_GLOBALS: ReadonlySet<string> = new Set([
	"meta",
	"args",
	"agent",
	"pipeline",
	"parallel",
	"sleep",
	"JSON",
]);

/** ACORN parse configuration used by the engine. */
export const PARSE_OPTIONS = {
	ecmaVersion: "latest",
	sourceType: "module",
	locations: true,
	allowHashBang: false,
	allowAwaitOutsideFunction: true,
	// PRD §5.1 sample ends with a top-level `return await agent(...)`; the
	// interpreter treats a top-level return as the run's final value.
	allowReturnOutsideFunction: true,
} as const;

/** Clamp a requested concurrency into the valid range [1, hard cap]. */
export function clampConcurrency(requested: number | undefined): number {
	if (requested === undefined) return DEFAULT_CONCURRENCY;
	if (!Number.isFinite(requested)) return DEFAULT_CONCURRENCY;
	if (requested < 1) return 1;
	if (requested > MAX_CONCURRENCY_HARD_LIMIT) return MAX_CONCURRENCY_HARD_LIMIT;
	return Math.floor(requested);
}

/** Clamp a requested agent cap into [1, hard cap]. */
export function clampMaxAgents(requested: number | undefined): number {
	if (requested === undefined) return MAX_AGENTS_HARD_LIMIT;
	if (!Number.isFinite(requested)) return MAX_AGENTS_HARD_LIMIT;
	if (requested < 1) return 1;
	if (requested > MAX_AGENTS_HARD_LIMIT) return MAX_AGENTS_HARD_LIMIT;
	return Math.floor(requested);
}

/** Clamp a loop budget into [1, +inf). */
export function clampLoopIterations(requested: number | undefined): number {
	if (requested === undefined) return DEFAULT_MAX_LOOP_ITERATIONS;
	if (!Number.isFinite(requested)) return DEFAULT_MAX_LOOP_ITERATIONS;
	if (requested < 1) return 1;
	return Math.floor(requested);
}
