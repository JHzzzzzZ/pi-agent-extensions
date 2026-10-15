/*
 * timeout-bg — 与 remote-tools 的 shell 能力协商（timeout-bg-todo#3，B′ 方案的 owner 一侧）
 *
 * 背景：`bash`/`powershell` 的生命周期在本扩展手里（session_start 重注册拿超时→后台语义），
 * 但 remote-tools 也覆盖同名 `bash` 提供 remote 参数，而宿主 registerTool 对同名工具按
 * **扩展加载顺序 first-wins**、没有「取回下层定义再包裹」的 API ⇒ 必有一方静默消失。
 *
 * 方案（B′）：注册前用宿主官方 `pi.events` 广播一个**可变盒子**收集「shell 能力」，
 * 订阅方（remote-tools）同步把远端 bash 能力放进来；本扩展合并参数片段并按参数分派。
 * 没有提供方（没装 remote-tools）时行为与今天逐字一致；载荷形状与频道是横切契约
 * （权威卡：docs/cross/shell-tool-capability.md），两侧各自实现形状守卫、不共享代码。
 */

import type { EventBus, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requestsRunInBackground } from "./params.ts";

/** 收集频道（跨扩展契约；形状升级用新频道 v2，不做版本字段）。 */
export const SHELL_CAPABILITY_CHANNEL = "pi-extensions:shell-capability:v1";

/** 收集来的能力载荷（只保留契约字段，函数用薄包装隔离 `this`/返回值形状）。 */
export interface ShellCapability {
	/** 参数片段：属性名 → TypeBox schema（owner 合并进自己的 properties）。 */
	parameters: Record<string, unknown>;
	/** 这次调用是否意图走远端。 */
	isRemoteCall(params: unknown): boolean;
	/** 远端执行（与本扩展自己的 execute 同签名）。 */
	executeRemote(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
	/** 远端分支是否支持 `run_in_background`（timeout-bg-todo#5；缺席/非布尔 = 不支持）。 */
	runInBackground: boolean;
	/** 附给模型的远端指南。 */
	guideline?: string | undefined;
}

export interface ShellCapabilityOffer {
	/** 收集到的能力；null = 没有提供方或载荷不可用。 */
	capability: ShellCapability | null;
	/** 需要 notify 一次的问题（畸形载荷 / 总线抛错）；正常为 null。 */
	warning: string | null;
}

/**
 * 广播收集请求并校验收回来的载荷。盒子里外都是别的扩展的对象：形状不对就当「没有能力」，
 * 总线抛错就当「没装对端」——两条路都回退到本扩展原行为，绝不因协商失败破坏会话。
 */
export function collectBashCapability(events: EventBus | undefined): ShellCapabilityOffer {
	if (events === undefined) return { capability: null, warning: null };
	const box: { bash?: unknown } = {};
	try {
		events.emit(SHELL_CAPABILITY_CHANNEL, box);
	} catch {
		return { capability: null, warning: "shell 能力协商失败（事件总线调用出错）：bash 按本扩展原行为注册。" };
	}
	if (box.bash === undefined) return { capability: null, warning: null };
	const capability = toShellCapability(box.bash);
	if (capability === null) {
		return { capability: null, warning: "忽略畸形 shell 能力载荷（形状不符合跨扩展契约）：bash 按本扩展原行为注册。" };
	}
	return { capability, warning: null };
}

function toShellCapability(value: unknown): ShellCapability | null {
	if (typeof value !== "object" || value === null) return null;
	const { parameters, isRemoteCall, executeRemote, guideline, runInBackground } = value as Record<string, unknown>;
	if (typeof parameters !== "object" || parameters === null) return null;
	if (typeof isRemoteCall !== "function" || typeof executeRemote !== "function") return null;
	if (guideline !== undefined && typeof guideline !== "string") return null;
	return {
		parameters: parameters as Record<string, unknown>,
		isRemoteCall: (params: unknown) => isRemoteCall(params) === true,
		executeRemote: (id, params, signal, onUpdate, ctx) => executeRemote(id, params, signal, onUpdate, ctx),
		// 加法式扩展：缺席或非布尔一律当「不支持」（不因新字段判整份载荷畸形——旧提供方照常可用）。
		runInBackground: runInBackground === true,
		guideline: typeof guideline === "string" && guideline.length > 0 ? guideline : undefined,
	};
}

/**
 * 合并参数：owner 自己的属性优先，能力片段只能**新增**参数——与 owner 既有参数重名
 * （例如偷偷覆盖 `command`）视为畸形载荷，整份忽略（返回 null）。
 */
export function mergeBashParameters(base: unknown, fragment: Record<string, unknown>): unknown | null {
	if (typeof base !== "object" || base === null) return null;
	const properties = (base as { properties?: unknown }).properties;
	if (typeof properties !== "object" || properties === null) return null;
	const own = properties as Record<string, unknown>;
	for (const key of Object.keys(fragment)) {
		if (Object.prototype.hasOwnProperty.call(own, key)) return null;
	}
	return { ...(base as object), properties: { ...own, ...fragment } };
}

export interface BashDispatchDeps {
	/** 本扩展自己的执行路径（超时→后台 ops）。 */
	local: ToolDefinition["execute"];
	capability: ShellCapability;
	/** 异常/回退的可见性通知（notify 内部自带异常隔离与 UI 守卫）。 */
	notify: (ctx: ExtensionContext, message: string) => void;
	/**
	 * 远端调用未显式给 `timeout` 时的默认秒数（本扩展的超时策略，在同一数字下转交）。
	 * undefined = 不施加默认超时（`PI_TIMEOUT_BG_DEFAULT=0`）。
	 */
	defaultTimeoutSeconds: number | undefined;
}

/**
 * 把本扩展的默认超时套用到远端参数上：只补缺省，**不碰模型显式给的值**
 * （哪怕它非法——合法性由远端分支按宿主同一句文案拒绝）。
 *
 * `run_in_background: true` 时**不注入**：后台任务不受超时约束，注入只会让远端多一个
 * 永远不会响的定时器（timeout-bg-todo#5）。
 */
export function applyDefaultTimeout(params: unknown, defaultSeconds: number | undefined): unknown {
	if (defaultSeconds === undefined) return params;
	if (typeof params !== "object" || params === null) return params;
	if (requestsRunInBackground(params)) return params;
	const source = params as { timeout?: unknown };
	if (source.timeout !== undefined) return params;
	return { ...(source as object), timeout: defaultSeconds };
}

/**
 * 分派的两个安全口径（与对齐文档「回退」措辞的偏差：**回退绝不在本机跑远端意图的命令**）：
 *   - `isRemoteCall` 抛错 ⇒ fail-closed 报错（不能确认意图时不猜：`local` 常是 ssh 别名，跑错机器更贵）；
 *   - `executeRemote` 抛错 ⇒ notify 后原样抛（tool call 以错误结束），不回退到本机。
 */
export function createBashDispatch(deps: BashDispatchDeps): ToolDefinition["execute"] {
	return async function dispatchBash(id, params, signal, onUpdate, ctx) {
		let remote: boolean;
		try {
			remote = deps.capability.isRemoteCall(params) === true;
		} catch {
			deps.notify(ctx, "远端 shell 能力判定失败：为避免远端命令在本机执行，本次调用按错误结束（请检查 remote-tools 版本）。");
			throw new Error("远端 shell 能力判定失败：本次调用已拒绝执行。");
		}
		if (!remote) return deps.local(id, params, signal, onUpdate, ctx);
		// 远端分支不支持主动后台时 fail-closed（timeout-bg-todo#5）：静默按前台等待跑，
		// 模型只会以为「它自己没转后台」，而用户要的让路没有发生。
		if (requestsRunInBackground(params) && !deps.capability.runInBackground) {
			deps.notify(ctx, "远端 shell 不支持直接转后台（对端版本不支持该参数）：本次调用按错误结束。");
			throw new Error("远端 shell 不支持直接转后台：为避免悄悄退化成前台等待，本次调用已拒绝。");
		}
		const forwarded = applyDefaultTimeout(params, deps.defaultTimeoutSeconds);
		try {
			const result = await deps.capability.executeRemote(id, forwarded, signal, onUpdate, ctx);
			return result as Awaited<ReturnType<ToolDefinition["execute"]>>;
		} catch (error) {
			deps.notify(ctx, "远端 shell 能力执行出错：本次调用以错误结束（未在本机重跑）。");
			throw error;
		}
	};
}

/** 内置 shell 工具的 sourceInfo.path（宿主 agent-session 的建法：`builtin:<name>`）。 */
const BUILTIN_SHELL_PATHS: ReadonlySet<string> = new Set(["builtin:bash", "builtin:powershell"]);

interface ToolSummary {
	name?: unknown;
	description?: unknown;
	sourceInfo?: { path?: unknown } | undefined;
}

/** `pi.getAllTools()` 拿不到（旧宿主 / 结构 fake）时返回 null，调用方按「无信息」处理。 */
function listToolSummaries(pi: ExtensionAPI): ToolSummary[] | null {
	try {
		const tools: unknown = pi.getAllTools();
		return Array.isArray(tools) ? (tools as ToolSummary[]) : null;
	} catch {
		return null;
	}
}

function findToolSummary(pi: ExtensionAPI, kind: string): ToolSummary | undefined {
	return listToolSummaries(pi)?.find((tool) => tool.name === kind);
}

/** 注册**前**的冲突可见性：当前 bash 不是内置实现（已被别的扩展接管）⇒ 说一声，不静默。 */
export function describeForeignBash(pi: ExtensionAPI, kind = "bash"): string | null {
	const current = findToolSummary(pi, kind);
	if (current === undefined) return null;
	const path = current.sourceInfo?.path;
	if (typeof path === "string" && BUILTIN_SHELL_PATHS.has(path)) return null;
	return `${kind} 已被另一个扩展接管（不是宿主内置实现）：本扩展的默认超时与超时转后台不会生效，请检查扩展加载顺序与冲突。`;
}

/** 注册**后**的自检：宿主对同名工具按扩展加载顺序 first-wins，顺序不对时本次注册会被丢掉。 */
export function describeLostBashRegistration(pi: ExtensionAPI, expectedDescription: string, kind = "bash"): string | null {
	const current = findToolSummary(pi, kind);
	if (current === undefined || current.description === expectedDescription) return null;
	return `${kind} 实际生效的是加载顺序更早的扩展注册的版本：本扩展的默认超时与超时转后台被覆盖、不会生效；请把 timeout-bg 排在接管 ${kind} 的扩展之前（本仓库 package.json 的 pi.extensions 顺序）。`;
}
