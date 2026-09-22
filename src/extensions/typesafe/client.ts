/**
 * typesafe — client（typesafe-todo#1）：调用 TypeSafe System One 的唯一 core。
 *
 * 工具（index.ts 的 `typesafe_ask`）与 CLI（cli.ts）都只走 `askTypesafe()`，
 * 因此两条路径的请求体、错误分类与答案结构天然一致（test/parity.test.ts 用真实
 * HTTP 边界断言字节级一致）。
 *
 * **安全不变量**（见 todos/align/typesafe-todo#1.md 范围 4）：
 * - key 只在拼 `Authorization` 头时用到，不进入返回值、不进入 details；
 * - 所有失败消息都是静态模板 + 必要数字（HTTP 状态码），绝不插值响应体、请求头、
 *   底层异常文本或 key；
 * - 没有「打印凭据」的参数或开关。
 *
 * 本模块零运行时依赖（只用全局 fetch 与 node 内置类型），保持 `node --test` 直跑。
 */

/** 错误码（仓库约定：`as const` 对象，不用 enum）。 */
export const ErrorCodes = {
	BAD_ARGS: "BAD_ARGS",
	NO_KEY: "NO_KEY",
	HTTP: "HTTP",
	TIMEOUT: "TIMEOUT",
	NETWORK: "NETWORK",
	BAD_RESPONSE: "BAD_RESPONSE",
} as const;

export type TypeSafeErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** 仓库统一的判别联合结果（见 docs/cross/result-unions.md）。 */
export type TypeSafeResult<T> = { ok: true; value: T } | { ok: false; code: TypeSafeErrorCode; message: string };

/** 单个问题的答案：三个原语各自带自己的字段，未知字段原样保留给调用方。 */
export interface TypeSafeAnswer {
	type: "choice" | "score" | "noul";
	[key: string]: unknown;
}

/** 一次调用的完整结果。 */
export interface TypeSafeAskResult {
	model: string;
	answers: Record<string, TypeSafeAnswer>;
	usage?: Record<string, unknown>;
}

/** 可注入的 fetch（进程边界替身；真实链路用全局 fetch）。 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AskInput {
	state: string;
	questions: unknown;
	model?: string;
}

export interface AskDeps {
	state: unknown;
	questions: unknown;
	model?: string;
	/** 覆盖端点（测试/自建网关）；默认 https://api.typesafe.ai */
	baseUrl?: string;
	timeoutMs?: number;
	/** 唯一取 key 口——credential.ts 提供真实实现，测试注入固定值 */
	resolveKey: () => string | undefined;
	fetchFn?: FetchLike;
	signal?: AbortSignal;
}

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const ASK_PATH = "/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_TIMEOUT_MS = 30_000;

const ANSWER_TYPES: readonly string[] = ["choice", "score", "noul"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 构造请求体：键序固定（state → model → questions），便于两条路径做字节级比对。 */
export function buildRequestBody(input: AskInput): string {
	const model = typeof input.model === "string" && input.model.trim() !== "" ? input.model.trim() : DEFAULT_MODEL;
	return JSON.stringify({ state: input.state, model, questions: input.questions });
}

/** 校验并解析响应；形状不认识就是 BAD_RESPONSE，不做字段猜测。 */
export function parseAskResponse(raw: unknown): TypeSafeResult<TypeSafeAskResult> {
	if (!isPlainObject(raw)) {
		return { ok: false, code: ErrorCodes.BAD_RESPONSE, message: "TypeSafe API 响应不是 JSON 对象" };
	}
	const answers = raw.answers;
	if (!isPlainObject(answers) || Object.keys(answers).length === 0) {
		return { ok: false, code: ErrorCodes.BAD_RESPONSE, message: "TypeSafe API 响应缺少 answers" };
	}
	for (const value of Object.values(answers)) {
		if (!isPlainObject(value) || typeof value.type !== "string" || !ANSWER_TYPES.includes(value.type)) {
			return { ok: false, code: ErrorCodes.BAD_RESPONSE, message: "TypeSafe API 响应含未知的答案类型" };
		}
	}
	const result: TypeSafeAskResult = {
		model: typeof raw.model === "string" ? raw.model : DEFAULT_MODEL,
		answers: answers as Record<string, TypeSafeAnswer>,
	};
	if (isPlainObject(raw.usage)) result.usage = raw.usage;
	return { ok: true, value: result };
}

function validateAskInput(deps: AskDeps): TypeSafeResult<AskInput> {
	if (typeof deps.state !== "string" || deps.state.trim() === "") {
		return { ok: false, code: ErrorCodes.BAD_ARGS, message: "state 必须是非空字符串" };
	}
	if (!isPlainObject(deps.questions) || Object.keys(deps.questions).length === 0) {
		return { ok: false, code: ErrorCodes.BAD_ARGS, message: "questions 必须是非空对象（{ <id>: { type, instructions, … } }）" };
	}
	return { ok: true, value: { state: deps.state, questions: deps.questions, model: deps.model } };
}

/** 底层异常只做分类，文本一律不透传（异常消息可能带 URL、请求内容甚至凭据）。 */
function classifyFetchFailure(error: unknown): TypeSafeResult<never> {
	const name = isPlainObject(error) || error instanceof Error ? error.name : "";
	if (name === "TimeoutError") {
		return { ok: false, code: ErrorCodes.TIMEOUT, message: "调用 TypeSafe 超时" };
	}
	return { ok: false, code: ErrorCodes.NETWORK, message: "调用 TypeSafe 失败（网络错误）" };
}

function trimBaseUrl(baseUrl: string | undefined): string {
	if (typeof baseUrl !== "string" || baseUrl.trim() === "") return DEFAULT_BASE_URL;
	return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * 端点的环境覆盖（`TYPESAFE_BASE_URL`）——自建网关与测试指向本地 fake server 的唯一
 * 入口。读的是调用时的环境变量（不缓存），便于测试在同一进程内改 env。
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return trimBaseUrl(env.TYPESAFE_BASE_URL);
}

/**
 * 发起一次 System One 调用。
 *
 * 顺序刻意如此：先校验参数 → 再取 key → 取不到就**不发请求**（fail-closed）→
 * 才构造并发送请求。任何一步失败都返回判别联合，不抛异常。
 */
export async function askTypesafe(deps: AskDeps): Promise<TypeSafeResult<TypeSafeAskResult>> {
	const input = validateAskInput(deps);
	if (!input.ok) return input;

	const key = deps.resolveKey();
	if (key === undefined || key.trim() === "") {
		return {
			ok: false,
			code: ErrorCodes.NO_KEY,
			message: "缺少 TypeSafe API key：先在 pi 里执行 /login typesafe，或设置 TYPESAFE_API_KEY",
		};
	}

	const fetchFn = deps.fetchFn ?? fetch;
	const timeoutMs = typeof deps.timeoutMs === "number" && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = deps.signal === undefined ? timeoutSignal : AbortSignal.any([deps.signal, timeoutSignal]);

	let response: Response;
	try {
		response = await fetchFn(`${trimBaseUrl(deps.baseUrl)}${ASK_PATH}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key.trim()}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: buildRequestBody(input.value),
			signal,
		});
	} catch (error) {
		return classifyFetchFailure(error);
	}

	if (!response.ok) {
		return { ok: false, code: ErrorCodes.HTTP, message: `TypeSafe API 返回 HTTP ${response.status}` };
	}

	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		return { ok: false, code: ErrorCodes.BAD_RESPONSE, message: "TypeSafe API 响应不是合法 JSON" };
	}
	return parseAskResponse(raw);
}
