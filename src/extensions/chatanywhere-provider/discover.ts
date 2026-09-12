/**
 * ChatAnywhere 运行时探测与家族线归并（discover.ts）
 *
 * 纯函数层（无副作用）：入口 index.ts 在加载时调用 probeModels 拉取
 * GET {base}/models（OpenAI 兼容 data 列表），再经 collapse 按“家族线 +
 * 档位”归并去重为可注册模型列表。
 *
 * 归并规则（与 catalog.ts MODEL_LINES 配合）：
 *  1. 准入过滤：非 chat 模型（embedding/tts/whisper/生图/transcribe/斜杠重复 id，
 *     见 catalog.ts NON_CHAT_ID_PATTERNS）与旧代（家族版本低于 GENERATION_FLOORS，
 *     如 GPT-4.x/o3/gemini-2.x）直接不参与注册——每家族仅保留最新代。
 *  2. classifyId：最长前缀命中家族线；版本 = 前缀内版本 + 后缀版本（dot/dash），
 *     尾部日期（YYYY-MM-DD | 8 位 | 4 位）与 -thinking/-nothinking 变体尾缀
 *     （可交替出现）剥除，剩余档位词整词匹配 tiers，仅 "-ca" 允许作为渠道后缀。
 *  3. 同种（同线同档位）取最新：版本 → 别名胜快照 → 日期新 → 标准渠道 → 变体
 *     （thinking > plain > nothinking）→ id。未知模型按去变体尾缀的基名去重、
 *     thinking 优先——同系列同版本最多注册 1 个。
 *  4. 每条线 ≤ cap 档：标准渠道 → 版本新 → 价格高 → id；未知档位不占位。
 *  5. 元数据解析：命中目录定义 → 直接用；同种同版本无此 id → 借同版本定义并
 *     在名称上标注日期/(CA)/变体后缀；都没有 → 兜底注册（“（未定价）”，接口窗口值优先，
 *     其余默认）。绝不借用跨版本定价（避免给新模型编造价格）。
 *
 * 探测失败（网络/非 2xx/解析失败）一律 {ok:false} —— fail-closed，两个
 * provider 都注册空 models，绝不回退到静态目录。
 *
 * 注：GET /models 响应形状（data 数组 + context_window/max_tokens 等可选字段）
 * 按 OpenAI 兼容规范解析并做防御性读取（camelCase 亦接受）；2026-09-09 实测
 * 分组切换后返回 146 个模型、无窗口字段。
 */
import type { ModelDef, ModelLine } from "./catalog.ts";
import { GENERATION_FLOORS, isNonChatId, MODEL_DEFS, MODEL_LINES } from "./catalog.ts";
import type { GenerationFloor } from "./catalog.ts";

export const PROBE_TIMEOUT_MS = 10_000;
/** 未知模型（目录外）的兜底规格 */
export const UNKNOWN_CONTEXT_WINDOW = 128_000;
export const UNKNOWN_MAX_TOKENS = 16_384;

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

export interface ProbedModel {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
}

export type ProbeResult = { ok: true; models: ProbedModel[] } | { ok: false };

interface ProbeResponseLike {
	ok: boolean;
	json(): Promise<unknown>;
}

type ProbeFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<ProbeResponseLike>;

export interface ProbeRequest {
	url: string;
	headers: Record<string, string>;
}

export function buildProbeRequest(baseUrl: string, apiKey: string): ProbeRequest {
	return {
		url: `${baseUrl.replace(/\/+$/, "")}/models`,
		// 无 key 时不带 Authorization（让代理/网关侧决定鉴权），探测结果仍可用
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
	};
}

/** 防御性数值读取：返回第一个为正的有限数值，否则 undefined */
function positiveNumber(...values: unknown[]): number | undefined {
	for (const v of values) {
		if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
	}
	return undefined;
}

export function parseProbeResponse(body: unknown): ProbeResult {
	if (typeof body !== "object" || body === null) return { ok: false };
	const data = (body as { data?: unknown }).data;
	if (!Array.isArray(data)) return { ok: false };
	const models: ProbedModel[] = [];
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null) return { ok: false };
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== "string" || id === "") return { ok: false };
		const contextWindow = positiveNumber(
			(entry as { context_window?: unknown }).context_window,
			(entry as { contextWindow?: unknown }).contextWindow,
		);
		const maxTokens = positiveNumber(
			(entry as { max_tokens?: unknown }).max_tokens,
			(entry as { maxTokens?: unknown }).maxTokens,
		);
		models.push(contextWindow !== undefined || maxTokens !== undefined ? { id, ...(contextWindow !== undefined && { contextWindow }), ...(maxTokens !== undefined && { maxTokens }) } : { id });
	}
	return { ok: true, models };
}

/** Claude（Anthropic Messages API）的 baseUrl：去掉 OpenAI 兼容后缀 /v1 */
export function claudeApiRoot(baseUrl: string): string {
	return baseUrl.replace(/\/v1\/?$/, "");
}

export async function probeModels(baseUrl: string, apiKey: string, fetchFn: ProbeFetch = fetch as unknown as ProbeFetch): Promise<ProbeResult> {
	const { url, headers } = buildProbeRequest(baseUrl, apiKey);
	let res: ProbeResponseLike;
	try {
		res = await fetchFn(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	} catch {
		return { ok: false };
	}
	if (!res.ok) return { ok: false };
	try {
		return parseProbeResponse(await res.json());
	} catch {
		return { ok: false };
	}
}

// ---------------------------------------------------------------------------
// 家族线分类
// ---------------------------------------------------------------------------

export interface ParsedId {
	line: string;
	tier: string; // "" = base（无档位后缀）
	version: number[];
	date: string | null; // YYYY-MM-DD | 8 位 | 4 位，均原样保留
	channel: "std" | "ca";
	variant: "thinking" | "nothinking" | null; // 渠道商的思考模式变体（如 claude-haiku-4-5-20251001-thinking）
}

export type ClassifyResult = { ok: true; parsed: ParsedId } | { ok: false; lineName: string | null };

const VARIANT_TAIL = /-(thinking|nothinking)$/;

export const variantOf = (id: string): "thinking" | "nothinking" | null => {
	const m = VARIANT_TAIL.exec(id);
	return m ? (m[1] as "thinking" | "nothinking") : null;
};

/** 前缀内版本：如 "gpt-5"→[5]、"qwen3.5"→[3,5]、"gpt-4o"→[] */
function prefixVersion(prefix: string): number[] {
	const m = /(\d+(?:\.\d+)*)$/.exec(prefix);
	return m ? m[1].split(".").map(Number) : [];
}

const DATE_TAIL = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;

function popDate(rest: string): { rest: string; date: string | null } {
	const m = DATE_TAIL.exec(rest);
	return m ? { rest: rest.slice(0, rest.length - m[0].length), date: m[1] } : { rest, date: null };
}

export function classifyId(id: string, lines: readonly ModelLine[]): ClassifyResult {
	// 最长前缀命中；同长取字典序更大者（"gpt-4o" 覆盖 "gpt-4"）
	let line: ModelLine | null = null;
	for (const candidate of lines) {
		if (!id.startsWith(candidate.prefix)) continue;
		if (line === null || candidate.prefix.length > line.prefix.length || (candidate.prefix.length === line.prefix.length && candidate.prefix > line.prefix)) {
			line = candidate;
		}
	}
	if (line === null) return { ok: false, lineName: null };

	let version = prefixVersion(line.prefix);
	let rest = id.slice(line.prefix.length);
	// 变体尾缀（-thinking/-nothinking）与日期可交替出现（…-thinking-2507 或 …-20251101-thinking），循环剥离直到无标记
	let variant: "thinking" | "nothinking" | null = null;
	let date: string | null = null;
	for (let i = 0; i < 2; i++) {
		const v = VARIANT_TAIL.exec(rest);
		if (v) {
			variant = v[1] as "thinking" | "nothinking";
			rest = rest.slice(0, rest.length - v[0].length);
			continue;
		}
		const d = popDate(rest);
		if (d.date !== null) {
			date = d.date;
			rest = d.rest;
		}
	}
	if (line.version === "dot") {
		const m = /^\.(\d+(?:\.\d+)*)(.*)$/.exec(rest);
		if (m) {
			version = [...version, ...m[1].split(".").map(Number)];
			rest = m[2];
		}
	}
	if (line.version === "dash") {
		const m = /^-(\d+(?:-\d+)*)(.*)$/.exec(rest);
		if (m) {
			version = [...version, ...m[1].split("-").map(Number)];
			rest = m[2];
		}
	}
	const tokens = rest === "" ? [] : rest.split("-").filter((t) => t !== "");

	let tier: string | null = null;
	let channel: "std" | "ca" = "std";
	if (tokens.length === 0) {
		tier = ""; // base：版本消费后无剩余词
	} else if (tokens.length === 1 && tokens[0] === "ca") {
		tier = "";
		channel = "ca";
	} else {
		// 档位词整词匹配：从最长前缀词串往下试
		for (let n = tokens.length; n >= 1 && tier === null; n--) {
			const joined = tokens.slice(0, n).join("-");
			if (line.tiers.includes(joined)) tier = joined;
		}
		if (tier !== null) {
			const leftover = tokens.slice(tier === "" ? 0 : tier.split("-").length);
			if (leftover.length === 1 && leftover[0] === "ca") channel = "ca";
			else if (leftover.length > 0) return { ok: false, lineName: line.name };
		}
	}
	if (tier === null) return { ok: false, lineName: line.name };
	return { ok: true, parsed: { line: line.name, tier, version, date, channel, variant } };
}

// ---------------------------------------------------------------------------
// 归并（collapse）与注册模型构造
// ---------------------------------------------------------------------------

export interface ProviderModelSpec {
	id: string;
	name: string;
	reasoning: boolean;
	input: readonly ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: { forceAdaptiveThinking: boolean };
}

interface KindMember {
	id: string;
	probed: ProbedModel;
	parsed: ParsedId;
}

/** 比较版本数组：无该位按 -∞（[5,4] > [5]） */
function compareVersion(a: readonly number[], b: readonly number[]): number {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const av = i < a.length ? a[i] : -Infinity;
		const bv = i < b.length ? b[i] : -Infinity;
		if (av !== bv) return av < bv ? -1 : 1;
	}
	return 0;
}

/** a 是否优于 b（同种内选最新；变体优先级 thinking > plain > nothinking） */
const VARIANT_RANK = { thinking: 2, nothinking: 0 } as const;

const variantRank = (v: "thinking" | "nothinking" | null): number => (v === null ? 1 : VARIANT_RANK[v]);

function isNewer(a: KindMember, b: KindMember): boolean {
	const v = compareVersion(a.parsed.version, b.parsed.version);
	if (v !== 0) return v > 0;
	// 别名（无日期）视作最新
	if (a.parsed.date === null && b.parsed.date !== null) return true;
	if (b.parsed.date === null && a.parsed.date !== null) return false;
	if (a.parsed.date !== null && b.parsed.date !== null && a.parsed.date !== b.parsed.date) return a.parsed.date > b.parsed.date;
	if (a.parsed.channel !== b.parsed.channel) return a.parsed.channel === "std";
	const ar = variantRank(a.parsed.variant);
	const br = variantRank(b.parsed.variant);
	if (ar !== br) return ar > br;
	return a.id < b.id;
}

/** 家族版本低于代际下限 → 旧代整代删除（未知模型同样适用） */
export function belowGenerationFloor(id: string, floors: readonly GenerationFloor[] = GENERATION_FLOORS): boolean {
	for (const f of floors) {
		const m = f.versionRe.exec(id);
		if (m) return compareVersion(m[1].split(".").map(Number), f.min) < 0;
		if (f.bare && f.bare.test(id)) return true; // 家族名下无版本号的命名（deepseek-chat）也按旧代处理
	}
	return false;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** 未知模型兜底：名称标注“（未定价）”，窗口/上限取接口值或默认 */
function unknownSpec(probed: ProbedModel): ProviderModelSpec {
	return {
		id: probed.id,
		name: `${probed.id}（未定价）`,
		reasoning: false,
		input: ["text"],
		cost: { ...ZERO_COST },
		contextWindow: probed.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
		maxTokens: probed.maxTokens ?? UNKNOWN_MAX_TOKENS,
	};
}

/** 由目录定义构造 spec；名称按需补日期/渠道/变体标注（仅当定义 id ≠ 命中 id 时） */
function specFromDef(def: ModelDef, winnerId: string, date: string | null, channel: "std" | "ca", variant: "thinking" | "nothinking" | null): ProviderModelSpec {
	let name = def.name;
	if (def.id !== winnerId) {
		if (date !== null && !name.includes(date)) name += ` (${date})`;
		if (channel === "ca" && !name.includes("CA")) name += " (CA)";
		if (variant !== null) name += ` (${variant})`;
	}
	return {
		id: winnerId,
		name,
		reasoning: def.reasoning,
		input: [...def.input],
		cost: { ...def.cost },
		contextWindow: def.contextWindow,
		maxTokens: def.maxTokens,
	};
}

interface KindBucket {
	key: string;
	line: string;
	members: KindMember[];
}

export interface RegistrationModels {
	openai: ProviderModelSpec[];
	claude: ProviderModelSpec[];
}

const OPENAI_THINKING_LEVEL_MAP = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: null, max: null } as const;
const CLAUDE_THINKING_LEVEL_MAP = { minimal: null, low: null, medium: "default", high: "default", xhigh: null, max: null } as const;

export function collapse(probed: readonly ProbedModel[], defs: readonly ModelDef[], lines: readonly ModelLine[]): RegistrationModels {
	const defById = new Map<string, ModelDef>();
	const kindDefs = new Map<string, { def: ModelDef; parsed: ParsedId }[]>();
	for (const def of defs) {
		defById.set(def.id, def);
		const r = classifyId(def.id, lines);
		if (!r.ok) continue; // 目录定义与家族线不一致时仅失去该条元数据
		const entry = { def, parsed: r.parsed };
		const key = `${r.parsed.line}|${r.parsed.tier}`;
		const list = kindDefs.get(key);
		if (list) list.push(entry);
		else kindDefs.set(key, [entry]);
	}

	const kinds = new Map<string, KindBucket>();
	const unknowns = new Map<string | null, Map<string, ProbedModel>>();
	for (const p of probed) {
		// 非 chat 模型（embedding/tts/生图等）与旧代（低于代际下限）直接不参与注册
		if (isNonChatId(p.id) || belowGenerationFloor(p.id)) continue;
		const r = classifyId(p.id, lines);
		if (r.ok) {
			const key = `${r.parsed.line}|${r.parsed.tier}`;
			let bucket = kinds.get(key);
			if (!bucket) {
				bucket = { key, line: r.parsed.line, members: [] };
				kinds.set(key, bucket);
			}
			bucket.members.push({ id: p.id, probed: p, parsed: r.parsed });
		} else {
			// 未知模型按（所属线/null=其他）归桶；同系列去变体尾缀去重，thinking 优先
			const base = p.id.replace(/-(thinking|nothinking)$/, "");
			let bucket = unknowns.get(r.lineName ?? null);
			if (!bucket) {
				bucket = new Map();
				unknowns.set(r.lineName ?? null, bucket);
			}
			const exist = bucket.get(base);
			if (!exist || variantRank(variantOf(p.id)) > variantRank(variantOf(exist.id))) bucket.set(base, p);
		}
		}
	const unknownList = (key: string | null): ProbedModel[] =>
		[...(unknowns.get(key) ?? new Map()).values()].sort((a, b) => (a.id < b.id ? -1 : 1));

	const openai: ProviderModelSpec[] = [];
	const claude: ProviderModelSpec[] = [];
	const pushSpec = (spec: ProviderModelSpec) => {
		if (spec.id.startsWith("claude-")) {
			claude.push(spec.reasoning ? { ...spec, thinkingLevelMap: CLAUDE_THINKING_LEVEL_MAP, compat: { forceAdaptiveThinking: true } } : spec);
		} else {
			openai.push(spec.reasoning ? { ...spec, thinkingLevelMap: OPENAI_THINKING_LEVEL_MAP } : spec);
		}
	};

	const lineWinners = new Map<string, { member: KindMember; spec: ProviderModelSpec; version: number[] }[]>();
	for (const bucket of kinds.values()) {
		const winner = bucket.members.reduce((a, b) => (isNewer(a, b) ? a : b));
		const def = defById.get(winner.id);
		const spec = def
			? specFromDef(def, winner.id, winner.parsed.date, winner.parsed.channel, winner.parsed.variant)
			: resolveFallback(winner, kindDefs.get(bucket.key) ?? []) ?? unknownSpec(winner.probed);
		const list = lineWinners.get(bucket.line);
		const entry = { member: winner, spec, version: winner.parsed.version };
		if (list) list.push(entry);
		else lineWinners.set(bucket.line, [entry]);
	}

	for (const line of lines) {
		const winners = [...(lineWinners.get(line.name) ?? [])];
		// 档位排序：标准渠道 → 版本新 → 价格高 → id（未知兜底价格 0 自然殿后）
		winners.sort((a, b) => {
			const ch = (b.member.parsed.channel === "std" ? 1 : 0) - (a.member.parsed.channel === "std" ? 1 : 0);
			if (ch !== 0) return ch;
			const v = compareVersion(b.version, a.version);
			if (v !== 0) return v;
			if (a.spec.cost.input !== b.spec.cost.input) return b.spec.cost.input - a.spec.cost.input;
			return a.member.id < b.member.id ? -1 : 1;
		});
		for (const w of winners.slice(0, line.cap)) pushSpec(w.spec);
		// 未知档位（探测到的线内新档）不占位，按 id 附在线尾
		for (const p of unknownList(line.name)) pushSpec(unknownSpec(p));
	}
	// 无前缀的模型归“其他”（最后，按 id 排序）
	for (const p of unknownList(null)) pushSpec(unknownSpec(p));
	return { openai, claude };
}

/** 同种同版本（无该 id 定义）时借同版本定义；优先同渠道，其次别名 */
function resolveFallback(winner: KindMember, candidates: { def: ModelDef; parsed: ParsedId }[]): ProviderModelSpec | null {
	const sameVersion = candidates.filter((c) => compareVersion(c.parsed.version, winner.parsed.version) === 0);
	if (sameVersion.length === 0) return null;
	const best = sameVersion.find((c) => c.parsed.channel === winner.parsed.channel) ?? sameVersion.find((c) => c.parsed.date === null) ?? sameVersion[0];
	return specFromDef(best.def, winner.id, winner.parsed.date, winner.parsed.channel, winner.parsed.variant);
}

/** 探测结果 → 注册数据；探测失败 fail-closed：两个 provider 均空 */
export function selectForRegistration(probe: ProbeResult, defs: readonly ModelDef[] = MODEL_DEFS, lines: readonly ModelLine[] = MODEL_LINES): RegistrationModels {
	if (!probe.ok) return { openai: [], claude: [] };
	return collapse(probe.models, defs, lines);
}
