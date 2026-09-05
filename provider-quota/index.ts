/**
 * provider-quota/index.ts — Pi extension
 *
 * 查询当前 provider 的账户额度/余额，并显示在终端底部（footer status 行）。
 *
 * 行为：
 *  - session 启动后自动查询一次
 *  - 每 5 分钟自动刷新
 *  - 切换 model（/model、Ctrl+P）时自动刷新
 *  - /quota 命令手动刷新
 *
 * 健壮性：
 *  - 同一 provider 的刷新请求自动去重（in-flight 复用，避免并发重复请求）
 *  - 单次请求 10s 超时；超时/网络错误/5xx 指数退避重试最多 3 次
 *  - 维护 session 级 AbortController（session_start 新建、session_shutdown 中止），
 *    每条刷新链路在发起时捕获该 session 信号并与单请求超时信号联动；session 结束后
 *    任何未完成请求都不再回写 footer 状态（ctx.signal 是 turn 级信号，在 session
 *    生命周期事件中常为 undefined，不能作为 session 取消依据）
 *  - 错误状态可辨识：timeout / net err / parse err / HTTP <code>
 *
 * 内置支持：
 *  - openrouter  GET https://openrouter.ai/api/v1/credits   -> total_credits / total_usage（美元）
 *  - deepseek    GET https://api.deepseek.com/user/balance  -> total_balance
 *  - chatanywhere POST https://api.chatanywhere.tech/v1/query/balance
 *                -> balanceTotal - balanceUsed（CA）
 *  - zhipu(GLM Coding Plan) GET {base}/api/monitor/usage/quota/limit
 *                -> data.limits[] 内 TOKENS_LIMIT / TIME_LIMIT 的 percentage；
 *                   响应带刷新时间戳时（实测字段 nextResetTime，毫秒 epoch，
 *                   兼容 nextRefreshTime / next_refresh_time / resetTime / reset_time 变体）
 *                   追加 `→ HH:mm (Xh Ym)` 下次刷新后缀
 *                （base 仅接受 https + 无端口 + 白名单主机 open.bigmodel.cn / dev.bigmodel.cn /
 *                 api.z.ai，取自 ANTHROPIC_BASE_URL；未设置 / 非法时回退到
 *                 https://open.bigmodel.cn/api/monitor/usage/quota/limit 默认地址。
 *                 quota-limit 不附时间窗 query；鉴权用 ZHIPU_API_TOKEN 原始 token，非 Bearer。
 *                 实现参考 zai-coding-plugins/glm-plan-usage）
 *
 * 不在内置列表的 provider（如 anthropic / openai 直连）会静默不显示状态行。
 * 要支持更多 provider，在 QUOTA_ENDPOINTS 里加一条即可。
 *
 * API Key 解析：从 ~/.pi/agent/auth.json 按 provider id 读取 key，不使用环境变量。
 *
 * 安装：把本目录复制到 ~/.pi/agent/extensions/provider-quota/（全局）或 .pi/extensions/provider-quota/（项目级），
 *       然后在 pi 里执行 /reload。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface QuotaInfo {
	text: string;
}

interface QuotaAdapter {
	url: string;
	parse: (body: any) => QuotaInfo | null;
	method?: "GET" | "POST";
	buildUrl?: () => string | null;
	auth?: (apiKey: string) => Record<string, string>;
}

// provider id 别名（小写）-> 内置 adapter 名
const PROVIDER_ALIASES: Record<string, string> = {
	glm: "zhipu",
	bigmodel: "zhipu",
	zai: "zhipu",
	"zai-coding-cn": "zhipu",
	zhipuai: "zhipu",
	"chatanywhere-claude": "chatanywhere",
};

// 智谱原始 token 仅允许发往这些 HTTPS、无显式端口的白名单主机。
// 任何其它基址（http、非标端口、子域伪装、未知 host、无法解析、未设置）
// 都拒绝作为自定义基址，但会回退到 adapter.url 默认白名单地址。
const ZHIPU_ALLOWED_HOSTS = new Set([
	"open.bigmodel.cn",
	"dev.bigmodel.cn",
	"api.z.ai",
]);

function resolveZhipuBase(): string | null {
	const raw = process.env.ANTHROPIC_BASE_URL || "";
	if (!raw) return null; // 未设置：不假定平台，不发请求
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (
		u.protocol !== "https:" ||
		u.port !== "" ||
		!ZHIPU_ALLOWED_HOSTS.has(u.hostname)
	) {
		return null;
	}
	return `${u.protocol}//${u.hostname}`;
}

function zhipuQuotaUrl(): string | null {
	const base = resolveZhipuBase();
	if (!base) return null;
	// 严格遵循参考契约：quota-limit 不附时间窗查询参数（startTime/endTime 仅用于 model/tool usage）
	return `${base}/api/monitor/usage/quota/limit`;
}

// ---- 智谱下次刷新时间解析（纯函数，now 由调用方注入，便于固定时钟测试）----

// 实测 open.bigmodel.cn quota-limit 返回 data.limits[].nextResetTime（毫秒 epoch）；
// 其余为防御式兼容变体。
const REFRESH_FIELD_NAMES = [
	"nextResetTime",
	"nextRefreshTime",
	"next_refresh_time",
	"resetTime",
	"reset_time",
] as const;

// 数值时间戳阈值：>= 1e12 按毫秒，>= 1e9 按秒（1e9 秒 ≈ 2001 年）。
const EPOCH_MS_THRESHOLD = 1e12;
const EPOCH_SEC_THRESHOLD = 1e9;
// 刷新时间早于 now-24h 视为过期垃圾值，不追加后缀。
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000;

type ZhipuLimitEntry = Record<string, unknown>;

function extractZhipuLimits(body: unknown): ZhipuLimitEntry[] {
	const b = body as { data?: { limits?: unknown }; limits?: unknown } | null;
	const raw = b?.data?.limits ?? b?.limits;
	return Array.isArray(raw) ? (raw as ZhipuLimitEntry[]) : [];
}

function findZhipuLimit(
	limits: ZhipuLimitEntry[],
	type: string,
): ZhipuLimitEntry | undefined {
	return limits.find((i) => i?.type === type);
}

function toZhipuRefreshDate(value: unknown): Date | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		if (value >= EPOCH_MS_THRESHOLD) return validDate(new Date(value));
		if (value >= EPOCH_SEC_THRESHOLD) return validDate(new Date(value * 1000));
		return null;
	}
	if (typeof value === "string" && value.trim()) {
		return validDate(new Date(value)); // ISO 字符串
	}
	return null;
}

function validDate(d: Date): Date | null {
	return Number.isNaN(d.getTime()) ? null : d;
}

function readZhipuEntryRefreshTime(entry: ZhipuLimitEntry): Date | null {
	if (!entry || typeof entry !== "object") return null;
	for (const name of REFRESH_FIELD_NAMES) {
		const parsed = toZhipuRefreshDate(entry[name]);
		if (parsed) return parsed;
	}
	return null;
}

// 两个 limit 共用同一个刷新窗口，只显示一次：
// 优先 TOKENS_LIMIT，其次 TIME_LIMIT，再次任意带可解析时间戳的条目。
function pickZhipuRefreshTime(limits: ZhipuLimitEntry[]): Date | null {
	for (const type of ["TOKENS_LIMIT", "TIME_LIMIT"]) {
		const entry = findZhipuLimit(limits, type);
		if (entry) {
			const parsed = readZhipuEntryRefreshTime(entry);
			if (parsed) return parsed;
		}
	}
	for (const entry of limits) {
		const parsed = readZhipuEntryRefreshTime(entry);
		if (parsed) return parsed;
	}
	return null;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

// 绝对时间：本地时区；与 now 同日显示 HH:mm，跨日显示 MM-dd HH:mm。
function formatZhipuRefreshTime(d: Date, now: Date): string {
	const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	return sameDay ? hhmm : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm}`;
}

// 倒计时：向下取整；不足 1 分钟显示 <1m。
function formatZhipuCountdown(diffMs: number): string {
	const totalMinutes = Math.floor(diffMs / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m`;
	return "<1m";
}

// 后缀规则：
//  - 刷新时间在未来 → `→ HH:mm (Xh Ym)`（跨日为 MM-dd HH:mm）
//  - 过去但在 now-24h 内 → 只显示绝对时间（应对 footer 5 分钟轮询的短暂过期窗口）
//  - 早于 now-24h / 无法解析 → null（输出与无时间字段时完全一致）
function formatZhipuRefreshSuffix(
	refresh: Date | null,
	now: Date,
): string | null {
	if (!refresh) return null;
	const diffMs = refresh.getTime() - now.getTime();
	if (diffMs < -STALE_WINDOW_MS) return null;
	const absolute = formatZhipuRefreshTime(refresh, now);
	if (diffMs <= 0) return `→ ${absolute}`;
	return `→ ${absolute} (${formatZhipuCountdown(diffMs)})`;
}

/**
 * 解析智谱 quota-limit 响应为 footer 状态行文本。
 *
 * 输出 `GLM tok X% mcp Y%`，并在能解析出刷新时间时追加 `→ HH:mm (Xh Ym)`。
 * 百分比与刷新时间都缺失时返回 null（沿用 GLM: - 路径）。
 */
export function parseZhipuQuotaLimit(body: unknown, now: Date): string | null {
	const limits = extractZhipuLimits(body);
	if (limits.length === 0) return null;

	const tok = findZhipuLimit(limits, "TOKENS_LIMIT");
	const time = findZhipuLimit(limits, "TIME_LIMIT");
	const parts: string[] = [];
	if (tok && typeof tok.percentage === "number")
		parts.push(`tok ${tok.percentage}%`);
	if (time && typeof time.percentage === "number")
		parts.push(`mcp ${time.percentage}%`);

	const suffix = formatZhipuRefreshSuffix(pickZhipuRefreshTime(limits), now);
	if (!parts.length && !suffix) return null;
	return `GLM ${[...parts, ...(suffix ? [suffix] : [])].join(" ")}`;
}

export const QUOTA_ENDPOINTS: Record<string, QuotaAdapter> = {
	openrouter: {
		url: "https://openrouter.ai/api/v1/credits",
		parse: (b) => {
			const d = b?.data;
			if (!d) return null;
			const total = Number(d.total_credits ?? 0);
			const used = Number(d.total_usage ?? 0);
			return { text: `OR $${total.toFixed(2)} (used $${used.toFixed(2)})` };
		},
	},
	deepseek: {
		url: "https://api.deepseek.com/user/balance",
		parse: (b) => {
			const info = b?.balance_infos?.[0];
			if (!info) return null;
			const bal = info.total_balance ?? "?";
			const cur = info.currency ?? "";
			return { text: `DS ${bal} ${cur}`.trim() };
		},
	},
	chatanywhere: {
		url: "https://api.chatanywhere.tech/v1/query/balance",
		method: "POST",
		auth: (apiKey) => ({
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": "cc-switch/1.0",
		}),
		parse: (b) => {
			const total = Number(b?.balanceTotal);
			const used = Number(b?.balanceUsed);
			if (!Number.isFinite(total) || !Number.isFinite(used)) return null;
			return { text: `CA ${(total - used).toFixed(2)}` };
		},
	},
	zhipu: {
		url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
		buildUrl: zhipuQuotaUrl,
		auth: (token) => ({ Authorization: token }),
		parse: (b) => {
			const text = parseZhipuQuotaLimit(b, new Date());
			return text ? { text } : null;
		},
	},
};

const STATUS_ID = "provider-quota";
const REFRESH_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

async function readApiKey(providerId: string): Promise<string | undefined> {
	let contents: string;
	try {
		contents = await readFile(AUTH_FILE, "utf8");
	} catch (error) {
		console.debug(`[provider-quota] unable to read ${AUTH_FILE}`, error);
		return undefined;
	}

	let auth: unknown;
	try {
		auth = JSON.parse(contents);
	} catch (error) {
		console.debug(`[provider-quota] unable to parse ${AUTH_FILE}`, error);
		return undefined;
	}
	if (!auth || typeof auth !== "object" || Array.isArray(auth))
		return undefined;

	const entries = auth as Record<string, unknown>;
	const entry = entries[providerId];
	if (!entry || typeof entry !== "object") return undefined;

	const key = (entry as Record<string, unknown>).key;
	return typeof key === "string" && key.trim() ? key : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const onAbort = () => {
			clearTimeout(handle);
			resolve();
		};
		const handle = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

type FetchResult =
	| { kind: "success"; info: QuotaInfo | null }
	| { kind: "failure"; retryable: boolean; label: string }
	| { kind: "aborted" };

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	// session 级取消控制器：session_start 新建，session_shutdown 中止。
	// ctx.signal 是 turn 级信号，在 session_start / session_shutdown / 空闲命令等
	// 非 turn 上下文中通常为 undefined，因此需要独立的 session 级控制器来中止未完成请求。
	let session: AbortController | undefined;
	const inFlight = new Map<string, Promise<void>>();

	async function fetchOnce(
		url: string,
		adapter: QuotaAdapter,
		apiKey: string,
		ctx: ExtensionContext,
		sessionSignal: AbortSignal | undefined,
	): Promise<FetchResult> {
		let timedOut = false;
		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, FETCH_TIMEOUT_MS);

		// 将 session 级与 turn 级（ctx.signal）中止信号联动到本次请求的 controller。
		const unlink: Array<() => void> = [];
		for (const s of [sessionSignal, ctx.signal]) {
			if (!s) continue;
			if (s.aborted) {
				controller.abort();
				break;
			}
			const fn = () => controller.abort();
			s.addEventListener("abort", fn, { once: true });
			unlink.push(() => s.removeEventListener("abort", fn));
		}

		try {
			const headers = adapter.auth
				? adapter.auth(apiKey)
				: { Authorization: `Bearer ${apiKey}` };
			const res = await fetch(url, {
				method: adapter.method ?? "GET",
				headers,
				signal: controller.signal,
			});
			if (!res.ok) {
				return {
					kind: "failure",
					retryable: res.status >= 500,
					label: `HTTP ${res.status}`,
				};
			}
			let body: unknown;
			try {
				body = await res.json();
			} catch {
				return { kind: "failure", retryable: false, label: "parse err" };
			}
			return { kind: "success", info: adapter.parse(body) };
		} catch (e) {
			if (sessionSignal?.aborted || ctx.signal?.aborted)
				return { kind: "aborted" };
			if (timedOut)
				return { kind: "failure", retryable: true, label: "timeout" };
			const isParse = e instanceof SyntaxError;
			return {
				kind: "failure",
				retryable: !isParse,
				label: isParse ? "parse err" : "net err",
			};
		} finally {
			clearTimeout(timeoutHandle);
			for (const fn of unlink) fn();
		}
	}

	async function doRefresh(
		ctx: ExtensionContext,
		providerId: string,
		adapter: QuotaAdapter,
		sessionSignal: AbortSignal | undefined,
	): Promise<void> {
		// 绑定本次刷新所属的 session；任何写状态前先确认该 session 未被中止，
		// 保证 session_shutdown 之后未完成请求不会回写已清除的 footer 状态。
		const write = (value: string | undefined): void => {
			if (sessionSignal?.aborted) return;
			ctx.ui.setStatus(
				STATUS_ID,
				value === undefined ? undefined : ctx.ui.theme.fg("dim", value),
			);
		};

		const apiKey = await readApiKey(providerId);
		if (!apiKey) {
			write(`${providerId}: no key`);
			return;
		}

		// 解析并校验目标地址：adapter 带 buildUrl 时（如 zhipu）用 ANTHROPIC_BASE_URL
		// 构造基址；若该环境变量未设置或非法，回退到 adapter.url 默认值。
		// 不回退到其他平台、不外泄 token。
		let url: string;
		if (adapter.buildUrl) {
			url = adapter.buildUrl() || adapter.url;
		} else {
			url = adapter.url;
		}

		let label = "err";
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (sessionSignal?.aborted || ctx.signal?.aborted) return;
			const result = await fetchOnce(url, adapter, apiKey, ctx, sessionSignal);
			if (result.kind === "aborted") return;
			if (result.kind === "success") {
				write(result.info ? result.info.text : `${providerId}: -`);
				return;
			}
			label = result.label;
			if (!result.retryable || attempt === MAX_RETRIES) break;
			await sleep(BASE_BACKOFF_MS * 2 ** attempt, sessionSignal);
			if (sessionSignal?.aborted || ctx.signal?.aborted) return;
		}
		write(`${providerId}: ${label}`);
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		// 捕获当前 session 信号，整条刷新链路绑定到它；session 中止后即可统一短路。
		const sessionSignal = session?.signal;
		const providerId = ctx.model?.provider;
		const norm = providerId ? String(providerId).toLowerCase() : "";
		const key = PROVIDER_ALIASES[norm] ?? norm;
		const adapter = key ? QUOTA_ENDPOINTS[key] : undefined;
		if (!providerId || !adapter) {
			if (!sessionSignal?.aborted) ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		const existing = inFlight.get(providerId);
		if (existing) return existing;
		const p = doRefresh(ctx, providerId, adapter, sessionSignal).finally(
			() => inFlight.delete(providerId),
		);
		inFlight.set(providerId, p);
		return p;
	}

	pi.on("session_start", async (_e, ctx) => {
		session = new AbortController();
		await refresh(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			void refresh(ctx);
		}, REFRESH_MS);
	});

	pi.on("model_select", async (_e, ctx) => {
		await refresh(ctx);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		// 中止当前 session 的所有未完成请求；保留 session 指向已中止的控制器，
		// 使 shutdown 之后任何残留刷新立即判定为已中止而不再回写状态。
		session?.abort();
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		ctx.ui.setStatus(STATUS_ID, undefined);
	});

	pi.registerCommand("quota", {
		description: "立即刷新 provider 额度显示",
		handler: async (_args, ctx) => {
			await refresh(ctx);
		},
	});
}
