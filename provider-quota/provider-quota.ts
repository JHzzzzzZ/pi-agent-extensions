/**
 * provider-quota.ts — Pi extension
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
 *                -> data.limits[] 内 TOKENS_LIMIT / TIME_LIMIT 的 percentage
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
 * 安装：把本文件放到 ~/.pi/agent/extensions/provider-quota.ts（全局）或 .pi/extensions/ 下（项目级），
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

const QUOTA_ENDPOINTS: Record<string, QuotaAdapter> = {
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
			const limits: any[] = b?.data?.limits ?? b?.limits ?? [];
			if (!Array.isArray(limits) || limits.length === 0) return null;
			const tok = limits.find((i: any) => i?.type === "TOKENS_LIMIT");
			const time = limits.find((i: any) => i?.type === "TIME_LIMIT");
			const parts: string[] = [];
			if (tok && typeof tok.percentage === "number")
				parts.push(`tok ${tok.percentage}%`);
			if (time && typeof time.percentage === "number")
				parts.push(`mcp ${time.percentage}%`);
			if (!parts.length) return null;
			return { text: `GLM ${parts.join(" ")}` };
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
