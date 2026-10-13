/*
 * remote-tools — 7 个内置工具的同名覆盖（remote 非空 = 远端，空 = 原样委托宿主本地实现）。
 *
 * 覆盖机制：`pi.registerTool()` 注册同名工具会替换内置定义（dist/core/agent-session.js
 * 中 built-ins 先入注册表、custom tools 后入覆盖），这是官方 Gondolin 扩展的同一做法。
 * 保真策略：
 *   1. 本地分支直接调 `createXxxToolDefinition(ctx.cwd)` 的原实现，零行为漂移；
 *   2. 远端分支把**同一份**内置定义配上远端 Operations（read/write/edit/ls/find/bash），
 *      因此截断、限流、渲染器、提示词片段全部沿用宿主实现；唯一的后处理是 `withRemotePaths`
 *      ——把宿主原样插进文案/补丁/报错的宿主标记路径换回远端路径（remote-tools#16）；
 *   3. 只有 grep 必须整份重写（GrepOperations 覆盖不到真正的搜索，见 grep.ts）。
 *
 * 顺序不变量：参数校验（目标、端口、远端路径）一律发生在**任何 ssh 进程之前**；
 * 绝对远端路径不需要解析远端 $HOME，因此也就不会为此多发一次 ssh。
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolDetails,
	BashToolInput,
	EditToolDetails,
	EditToolInput,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionToolContext,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	LsToolDetails,
	LsToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	BASH_REMOTE_GUIDELINE,
	type RemoteBashCapability,
	type RemoteJobPort,
	claimRemoteJobHost,
	isRemoteBashCall,
	offerBashCapability,
} from "./capability.ts";
import { ErrorCodes } from "./errors.ts";
import { executeRemoteGrep, remoteGrepSchema, resolveRemoteSearchPath } from "./grep.ts";
import {
	type RemoteSession,
	createRemoteBashOps,
	createRemoteEditOps,
	createRemoteFindOps,
	createRemoteLsOps,
	createRemoteReadOps,
	createRemoteSession,
	createRemoteWriteOps,
} from "./ops.ts";
import { createRemoteContextCapability, offerRemoteContextCapability } from "./context.ts";
import { assertMarkerRootUsable, assertModelPathInput, rewriteHostPathInText, toHostPath } from "./paths.ts";
import { type SshExec, type SshTarget, formatTarget, hasRemoteIntent, parseTarget, validateRemotePath } from "./ssh.ts";
import {
	type RemoteTargetsFile,
	type TargetsStore,
	addTarget,
	emptyTargetsFile,
	formatEntry,
	formatTargetsList,
	removeTarget,
	resolveTarget,
	targetHintLine,
	withStrict,
} from "./targets.ts";

const REMOTE_GUIDELINE =
	"远端工具（remote-tools）：给 read/write/edit/bash/grep/find/ls 传 remote=\"[user@]host\"（可选 remotePort）即在远端主机执行，此时 path 在远端主机解析（省略或相对路径按远端 $HOME，绝对 POSIX 路径直接用）；remote 省略或留空表示本机执行。" +
	"目标是远端主机时**优先传 remote，不要在 bash 里拼 ssh**（拼 ssh 要过一层本地 shell，丢结构化文件工具、路径回写与远端超时托管）；只有连接诊断（ssh -v / ssh-keygen / 端口探测）才用 bash+ssh。" +
	"strict 白名单开着时只能引用已登记目标（remote_targets 工具可查、可登记）。";

const TARGETS_GUIDELINE =
	"远端目标是具名的：用 remote_targets 看已登记目标（别名 → user@host:port），再把它作为内置工具的 remote 参数引用；strict 白名单开着时未登记目标会被拒绝，需要先登记（action=register）。登记表是用户级文件（~/.pi/agent/remote-targets.json），删除只走人工命令 /remote:rm。";

export interface RemoteToolsDeps {
	/** 进程边界端口：生产用 createSpawnExec，测试注入手写 fake。 */
	exec: SshExec;
	/** 本地 cwd（remote 为空且 ctx 无 cwd 时的本地实现基准）。 */
	cwd: string;
	/** 标记根锚定的文件（默认真实扩展目录里的 index.ts；测试接缝）。 */
	markerAnchor?: string | undefined;
	/** 远端目标登记表端口（别名 + strict 白名单）——**本地调用绝不读它**（remote-tools#2）。 */
	targets: TargetsStore;
	/** 时钟（登记时间戳）；测试注入固定值。 */
	now?: (() => string) | undefined;
}

type RemoteTargetParams = { remote?: string | undefined; remotePort?: number | undefined };

interface RemotePlan {
	session: RemoteSession;
	/** 远端 $HOME（session 内缓存，同目标只解析一次）。 */
	home: () => Promise<string>;
}

type SessionPlan = { kind: "local" } | ({ kind: "remote" } & RemotePlan);

/**
 * remote 参数片段：模型面把已登记别名烘进描述（对齐文档 Q5 方案 a——加载期读一次登记表，
 * 零额外上下文；空表/读不出 ⇒ 不加提示行。`/reload` 刷新）。
 */
function remoteTargetProperties(hint: string) {
	const tail = hint === "" ? "" : ` ${hint}`;
	return {
		remote: Type.Optional(
			Type.String({
				description: `远端 SSH 目标 "[user@]host"（可选 remotePort）；省略或留空 = 在本机执行。给值时 path 在远端主机解析（相对路径按远端 $HOME）。${tail}`,
			}),
		),
		remotePort: Type.Optional(Type.Number({ description: "远端 SSH 端口（1-65535，省略用 ssh 默认或 ~/.ssh/config）" })),
	};
}

/** bash 的远端参数片段：自己的注册与跨扩展能力载荷共用同一份 schema（不许两份）。 */
function remoteBashProperties(targetProperties: ReturnType<typeof remoteTargetProperties>) {
	return {
		remoteCwd: Type.Optional(Type.String({ description: "远端工作目录（省略或相对路径 = 远端 $HOME）" })),
		...targetProperties,
	};
}

/** 同名同端口共享一个 session：远端 $HOME 只解析一次，不给每次调用都加一轮 ssh。 */
export function createSessionCache(exec: SshExec): (target: SshTarget) => RemoteSession {
	const sessions = new Map<string, RemoteSession>();
	return (target) => {
		const key = `${formatTarget(target)}:${target.port ?? ""}`;
		const existing = sessions.get(key);
		if (existing !== undefined) return existing;
		const created = createRemoteSession({ target, exec });
		sessions.set(key, created);
		return created;
	};
}

function assertRemotePath(remotePath: string): string {
	const checked = validateRemotePath(remotePath);
	if (!checked.ok) throw new Error(`${checked.code}: ${checked.message}`);
	return remotePath;
}

/** 已经是绝对形态（含 Windows 盘符形态——它要被拒绝，所以也算「绝对候选」）。 */
function isRemoteAbsoluteCandidate(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed);
}

export interface ResolvedToolPath {
	/** 远端绝对路径（已校验）。 */
	remotePath: string;
	/** 内置定义的基准目录：省略/相对路径时是远端 $HOME，绝对路径时用 "/"（省掉一次 $HOME 探测）。 */
	baseDir: string;
}

/** 路径校验先于 ssh；只有省略或相对路径才需要解析远端 $HOME。非字符串输入（schema 外噪声）当未提供。 */
export function resolveToolPath(plan: RemotePlan, input: unknown): Promise<ResolvedToolPath>;
export async function resolveToolPath(plan: RemotePlan, input: unknown): Promise<ResolvedToolPath> {
	if (typeof input === "string") assertModelPathInput(input);
	const candidate = typeof input === "string" ? input : undefined;
	if (candidate !== undefined && isRemoteAbsoluteCandidate(candidate)) {
		return { remotePath: assertRemotePath(resolveRemoteSearchPath(candidate, "/")), baseDir: "/" };
	}
	const home = await plan.home();
	return { remotePath: assertRemotePath(resolveRemoteSearchPath(candidate, home)), baseDir: home };
}

function stripRemoteFields<P extends RemoteTargetParams & { remoteCwd?: string | undefined }>(params: P) {
	const { remote, remotePort, remoteCwd, ...rest } = params;
	void remote;
	void remotePort;
	void remoteCwd;
	return rest;
}

function appendNotice<D>(result: AgentToolResult<D>, notice: string): AgentToolResult<D> {
	const first = result.content[0];
	if (first === undefined || first.type !== "text") return result;
	return { ...result, content: [{ ...first, text: `${first.text}\n\n[${notice}]` }, ...result.content.slice(1)] };
}

interface RemotePathPair {
	/** 交给内置定义的宿主标记形态路径（宿主把它原样插进文案与补丁头）。 */
	hostPath: string;
	/** 远端真实绝对路径（展示用）。 */
	remotePath: string;
}

/** details 里只有 patch/diff 会带路径（edit 的 `generateUnifiedPatch(path, path, …)`）；其余字段原样。 */
function rewriteHostPathInDetails<D>(details: D, paths: RemotePathPair): D {
	if (typeof details !== "object" || details === null) return details;
	const record = details as Record<string, unknown>;
	const next: Record<string, unknown> = { ...record };
	let changed = false;
	for (const key of ["patch", "diff"]) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const rewritten = rewriteHostPathInText(value, paths.hostPath, paths.remotePath);
		if (rewritten === value) continue;
		next[key] = rewritten;
		changed = true;
	}
	return changed ? (next as D) : details;
}

/**
 * 远端分支的统一出口：跑内置定义，并把**宿主标记形态路径**换回远端真实路径（remote-tools#16）。
 * 宿主把自己的入参 path 原样插进成功文案、补丁头与报错模板（见 paths.ts 的说明），
 * 不换就会让模型以为改动落在了本机。本地分支不走这里（零行为漂移）。
 */
async function withRemotePaths<D>(paths: RemotePathPair, run: () => Promise<AgentToolResult<D>> | AgentToolResult<D>): Promise<AgentToolResult<D>> {
	let result: AgentToolResult<D>;
	try {
		result = await run();
	} catch (error) {
		if (error instanceof Error) error.message = rewriteHostPathInText(error.message, paths.hostPath, paths.remotePath);
		throw error;
	}
	const content = result.content.map((part) => (part.type === "text" ? { ...part, text: rewriteHostPathInText(part.text, paths.hostPath, paths.remotePath) } : part));
	const details = rewriteHostPathInDetails(result.details, paths);
	// structuredContent 不在公开类型面里（宿主 read 在 read.js 末尾从**改写前**的 content 派生它，`:178`），
	// 但它会透传给 codemode 消费方 ⇒ 不重写就等于给假路径留了第二个出口（第 1 轮评审建议 2）。
	const structured = (result as { structuredContent?: unknown }).structuredContent;
	const rewritten = rewriteHostPathInStructured(structured, paths);
	if (rewritten === structured) return { ...result, content, details };
	return { ...result, content, details, structuredContent: rewritten } as AgentToolResult<D> & { structuredContent?: unknown };
}

/** structuredContent 只有两种形状（read.js 的 `toReadOutput`）：文本串，或图片对象（附 `note` 文本）。 */
function rewriteHostPathInStructured(structured: unknown, paths: RemotePathPair): unknown {
	if (typeof structured === "string") return rewriteHostPathInText(structured, paths.hostPath, paths.remotePath);
	if (typeof structured !== "object" || structured === null) return structured;
	const record = structured as Record<string, unknown>;
	if (typeof record.note !== "string") return structured;
	const note = rewriteHostPathInText(record.note, paths.hostPath, paths.remotePath);
	return note === record.note ? structured : { ...record, note };
}

/**
 * 远端分支要给内置定义一个「cwd 在远端」的 ctx：宿主 ctx 的 cwd 是本机项目目录，
 * bash 拿它当工作目录、其余工具用它解析路径，直接用会把本机路径当成远端路径。
 * 用 Object.create 保留原型链上的 getter（sessionManager / model 等），只覆盖 cwd。
 */
function remoteContext(ctx: ExtensionToolContext | undefined, remoteBase: string): ExtensionToolContext {
	const base = ctx ?? (EMPTY_HOST_CONTEXT as unknown as ExtensionToolContext);
	return Object.create(base as object, { cwd: { value: toHostPath(remoteBase), enumerable: true } }) as ExtensionToolContext;
}

/** 工具上下文可见性通知（远端超时转后台失败等），异常隔离在本地。 */
function notifyTool(ctx: ExtensionToolContext | undefined, message: string): void {
	try {
		if (ctx?.hasUI === true) ctx.ui.notify(message, "warning");
	} catch {
		/* UI 异常不破坏工具调用 */
	}
}

/** 宿主理论上总是给 ctx（codemode 嵌套调用也可能给）；缺失时用最小形状兜住 bash 的会话环境读取。 */
const EMPTY_HOST_CONTEXT = {
	sessionManager: { getSessionId: () => "", getSessionFile: () => undefined },
	model: undefined,
	thinkingLevel: undefined,
};

/** 命令面名字（与 /bg:kill、/team:run 同惯例）。 */
export const REMOTE_COMMANDS = { add: "remote:add", list: "remote:list", remove: "remote:rm", strict: "remote:strict" } as const;

export interface AddTargetArgs {
	alias: string;
	/** `[user@]host`；省略 = 用 ssh_config 里的同名别名。 */
	target: string | undefined;
	port: number | undefined;
	force: boolean;
}

/** `/remote:add <别名> [user@host] [--port N] [--force]` 的解析（纯函数，越界与未知选项明确报错）。 */
export function parseAddTargetArgs(args: string): { ok: true; value: AddTargetArgs } | { ok: false; message: string } {
	const tokens = args.trim().split(/\s+/).filter((token) => token !== "");
	if (tokens.length === 0) return { ok: false, message: "用法：/remote:add <别名> [user@host] [--port N] [--force]" };
	const positional: string[] = [];
	let port: number | undefined;
	let force = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--force") {
			force = true;
			continue;
		}
		if (token === "--port") {
			const raw = tokens[index + 1];
			const parsed = raw === undefined ? Number.NaN : Number(raw);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return { ok: false, message: "--port 必须是 1-65535 的整数" };
			port = parsed;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) return { ok: false, message: `不认识的选项：${token}（支持 --port / --force）` };
		positional.push(token);
	}
	if (positional.length === 0) return { ok: false, message: "缺少别名。用法：/remote:add <别名> [user@host] [--port N] [--force]" };
	if (positional.length > 2) return { ok: false, message: "位置参数只接受 <别名> [user@host]" };
	return { ok: true, value: { alias: positional[0], target: positional[1], port, force } };
}

/** 模型面工具与命令面共用的最小文本结果。 */
function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

/** 命令面通知（异常隔离：UI 异常不破坏会话）。 */
function notifyCommand(ctx: ExtensionCommandContext, message: string): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, "info");
	} catch {
		/* UI 异常不破坏会话 */
	}
}

/** `error` 可能是非 Error（跨边界抛），统一成可展示文本。 */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerRemoteTools(pi: ExtensionAPI, deps: RemoteToolsDeps): void {
	const sessionFor = createSessionCache(deps.exec);
	const now = deps.now ?? (() => new Date().toISOString());
	// 模型面：已登记别名烘进 7 个工具的 remote 参数描述（加载期一次，零额外上下文）。
	const targetProperties = remoteTargetProperties(targetHintLine(deps.targets.readAtLoad()));
	const bashProperties = remoteBashProperties(targetProperties);
	// job 托管端口懒索取（首次要用时 emit 一次并缓存）：
	//   - 索取放在首次使用而不是加载期，是因为加载顺序不保证 owner 的订阅已就位；
	//   - 拿不到（没装 timeout-bg）就永远是 null ⇒ 远端超时沿用宿主 kill 语义（今天的行为）。
	let claimedJobHost: RemoteJobPort | null | undefined;
	const currentJobHost = (): RemoteJobPort | null => {
		if (claimedJobHost === undefined) claimedJobHost = claimRemoteJobHost(pi.events);
		return claimedJobHost;
	};

	/**
	 * 读登记表（只在有远端意图时调用）。读不出/损坏 ⇒ 抛出类型化错误（fail-closed），
	 * 因为此时按“空表 + strict”继续会把事情说得更糟（静默全拒）。
	 */
	async function loadTargets(): Promise<RemoteTargetsFile | null> {
		const read = await deps.targets.read();
		if (!read.ok) throw new Error(`${read.code}: ${read.message}`);
		return read.value;
	}

	async function planSession(params: RemoteTargetParams): Promise<SessionPlan> {
		// 零影响不变量：本地调用**不读登记表**（登记表损坏不得弄坏本机工具）。
		const file = hasRemoteIntent(params) ? await loadTargets() : null;
		const resolution = resolveTarget({ remote: params.remote, remotePort: params.remotePort }, file);
		if (!resolution.ok) throw new Error(`${resolution.code}: ${resolution.message}`);
		if (resolution.kind === "local") return { kind: "local" };
		// 信道前提的运行时守卫：锚文件不是普通文件时本地就可能真的存在标记根，先 fail-closed（在发 ssh 之前）。
		assertMarkerRootUsable(deps.markerAnchor);
		const session = sessionFor(resolution.target);
		return { kind: "remote", session, home: () => session.home() };
	}

	// ── read ────────────────────────────────────────────────────────────────
	const readBase = createReadToolDefinition(deps.cwd);
	pi.registerTool({
		...readBase,
		description: `${readBase.description} 传 remote 时改在远端主机读取（path 在远端主机解析，相对路径按远端 $HOME）。`,
		promptGuidelines: [...(readBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...readBase.parameters.properties, ...targetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<ReadToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<ReadToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createReadToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const hostPath = toHostPath(path.remotePath);
			const definition = createReadToolDefinition(toHostPath(path.baseDir), { operations: createRemoteReadOps(plan.session) });
			return withRemotePaths({ hostPath, remotePath: path.remotePath }, () =>
				definition.execute(id, { ...rest, path: hostPath }, signal, onUpdate, remoteContext(ctx, path.baseDir)),
			);
		},
	});

	// ── write ───────────────────────────────────────────────────────────────
	const writeBase = createWriteToolDefinition(deps.cwd);
	pi.registerTool({
		...writeBase,
		description: `${writeBase.description} 传 remote 时改在远端主机写入（path 在远端主机解析，相对路径按远端 $HOME）。`,
		promptGuidelines: [...(writeBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...writeBase.parameters.properties, ...targetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<WriteToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createWriteToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const hostPath = toHostPath(path.remotePath);
			const definition = createWriteToolDefinition(toHostPath(path.baseDir), { operations: createRemoteWriteOps(plan.session) });
			return withRemotePaths({ hostPath, remotePath: path.remotePath }, () =>
				definition.execute(id, { ...rest, path: hostPath }, signal, onUpdate, remoteContext(ctx, path.baseDir)),
			);
		},
	});

	// ── edit ────────────────────────────────────────────────────────────────
	const editBase = createEditToolDefinition(deps.cwd);
	pi.registerTool({
		...editBase,
		description: `${editBase.description} 传 remote 时改在远端主机编辑（path 在远端主机解析，相对路径按远端 $HOME）。`,
		promptGuidelines: [...(editBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...editBase.parameters.properties, ...targetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<EditToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<EditToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createEditToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const hostPath = toHostPath(path.remotePath);
			const definition = createEditToolDefinition(toHostPath(path.baseDir), { operations: createRemoteEditOps(plan.session) });
			return withRemotePaths({ hostPath, remotePath: path.remotePath }, () =>
				definition.execute(id, { ...rest, path: hostPath }, signal, onUpdate, remoteContext(ctx, path.baseDir)),
			);
		},
	});

	// ── ls ──────────────────────────────────────────────────────────────────
	const lsBase = createLsToolDefinition(deps.cwd);
	pi.registerTool({
		...lsBase,
		description: `${lsBase.description} 传 remote 时改列远端主机目录（path 省略或相对路径 = 远端 $HOME）。`,
		promptGuidelines: [...(lsBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...lsBase.parameters.properties, ...targetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<LsToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<LsToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createLsToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const rich = createRemoteLsOps(plan.session);
			// fail-closed 目录探针：宿主 ls 自己的错误模板会把宿主标记形态的路径插进消息（remote-tools#10）。
			// 探针答案缓存进同一个 ops 实例 ⇒ 宿主随后的 exists/stat 不再触网。
			await rich.probeDirectory(path.remotePath);
			const definition = createLsToolDefinition(toHostPath(path.baseDir), { operations: rich });
			return definition.execute(id, { ...rest, path: toHostPath(path.remotePath) }, signal, onUpdate, remoteContext(ctx, path.baseDir));
		},
	});

	// ── find ────────────────────────────────────────────────────────────────
	const findBase = createFindToolDefinition(deps.cwd);
	pi.registerTool({
		...findBase,
		description: `${findBase.description} 传 remote 时改在远端主机搜索（path 省略或相对路径 = 远端 $HOME）。`,
		promptGuidelines: [...(findBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...findBase.parameters.properties, ...targetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<FindToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<FindToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createFindToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const rich = createRemoteFindOps(plan.session);
			// 同 ls：宿主 find 的「Path not found」也会回灌宿主标记路径，探针顺带把 exists 缓存掉。
			await rich.probeDirectory(path.remotePath);
			const sink = { degraded: false };
			const definition = createFindToolDefinition(toHostPath(path.baseDir), {
				operations: {
					exists: rich.exists,
					glob: async (pattern, cwd, options) => {
						const result = await rich.glob(pattern, cwd, options);
						sink.degraded = result.degraded;
						// 必须返回**宿主标记形态**：宿主 find 用本机 path.relative(searchPath, entry) 求相对，
						// 未标记的远端绝对路径会被算成 "../../../srv/…" 乱码（真机与评审都拓到过）。
						return result.entries.map((entry) => toHostPath(entry));
					},
				},
			});
			const result = await definition.execute(id, { ...rest, path: toHostPath(path.remotePath) }, signal, onUpdate, remoteContext(ctx, path.baseDir));
			return sink.degraded ? appendNotice(result, "远端缺少 ripgrep，已回退 POSIX find：忽略规则退化为目录名匹配") : result;
		},
	});

	// ── bash ────────────────────────────────────────────────────────────────
	const bashBase = createBashToolDefinition(deps.cwd);

	/** 远端分支的**单一实现**：本扩展自己的 bash 与跨扩展能力载荷共用它（不允许两份）。 */
	async function executeRemoteBash(
		id: string,
		params: BashToolInput & RemoteTargetParams & { remoteCwd?: string | undefined },
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
		ctx: ExtensionToolContext | undefined,
	): Promise<AgentToolResult<BashToolDetails | undefined>> {
		const plan = await planSession(params);
		if (plan.kind === "local") {
			// 调用方（跨扩展 owner）只在 isRemoteCall 为真时才进这里；走到本支说明分派契约被违反。
			throw new Error(`${ErrorCodes.INVALID_REMOTE_TARGET}: 参数未表达远端意图，却被当作远端调用。`);
		}
		const rest = stripRemoteFields(params);
		const cwd = await resolveToolPath(plan, params.remoteCwd);
		const definition = createBashToolDefinition(toHostPath(cwd.remotePath), {
			operations: createRemoteBashOps(plan.session, {
				jobHost: currentJobHost,
				notify: (message) => notifyTool(ctx, message),
			}),
		});
		return definition.execute(id, rest, signal, onUpdate, remoteContext(ctx, cwd.remotePath));
	}

	// 跨扩展能力协商（remote-tools-todo#9）：timeout-bg 若在 session_start 重注册 bash，会把这份能力并进去。
	offerBashCapability(pi.events, {
		parameters: bashProperties,
		isRemoteCall: isRemoteBashCall,
		executeRemote: executeRemoteBash,
		guideline: BASH_REMOTE_GUIDELINE,
	});

	// 跨扩展能力协商（dir-context-todo#6）：dir-context 自动注入远端目录上下文时要取文件，
	// 而 ssh 只在这一侧 —— 把「取」的能力放上收集频道，注入规则（去重/预算/块格式）仍全在 dir-context。
	offerRemoteContextCapability(
		pi.events,
		createRemoteContextCapability({
			resolve: async (request) => {
				const plan = await planSession({ remote: request.remote, remotePort: request.remotePort });
				if (plan.kind === "local") return null;
				const path = await resolveToolPath(plan, request.path);
				return { remotePath: path.remotePath, baseDir: path.baseDir, target: plan.session.target };
			},
			exec: deps.exec,
		}),
	);

	pi.registerTool({
		...bashBase,
		description: `${bashBase.description} 传 remote 时改在远端主机执行（cwd = remoteCwd 或远端 $HOME）。`,
		promptGuidelines: [...(bashBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...bashBase.parameters.properties, ...bashProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<BashToolDetails | undefined>> {
			const rest = stripRemoteFields<BashToolInput & RemoteTargetParams & { remoteCwd?: string | undefined }>(params);
			if (!isRemoteBashCall(params)) {
				return createBashToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			return executeRemoteBash(id, params, signal, onUpdate, ctx);
		},
	});

	// ── grep（整份重写，见 grep.ts 顶部说明）────────────────────────────────
	pi.registerTool({
		name: "grep",
		label: "grep",
		description:
			"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars. 传 remote 时改在远端主机搜索（path 省略或相对路径 = 远端 $HOME）；远端缺 ripgrep 时回退 GNU grep 并在结果里标注降级。",
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		promptGuidelines: [REMOTE_GUIDELINE],
		parameters: Type.Object({ ...remoteGrepSchema.properties, ...targetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<GrepToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<Parameters<typeof executeRemoteGrep>[1] & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createGrepToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			return executeRemoteGrep({ session: plan.session, baseDir: path.baseDir }, { ...rest, path: path.remotePath }, signal);
		},
	});

	// ── remote_targets（登记表的模型面：可查、可登记；删除与覆盖只走人工命令）───
	async function targetsText(): Promise<string> {
		return formatTargetsList(await loadTargets(), deps.targets.path);
	}

	pi.registerTool({
		name: "remote_targets",
		label: "remote_targets",
		description:
			"远端目标登记表（别名白名单）：列出已登记目标，或登记一个新目标。远端调用时把别名传给内置工具的 remote 参数即可。",
		promptSnippet: "List or register named remote SSH targets (aliases for the `remote` parameter)",
		promptGuidelines: [TARGETS_GUIDELINE],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("register")], {
				description: "list = 查看已登记目标；register = 登记新别名",
			}),
			alias: Type.Optional(Type.String({ description: "register 必填：别名（非空、无空白、不含 @ 或 :）" })),
			host: Type.Optional(Type.String({ description: "可选主机名；省略 = 别名本身当主机名（交给 ~/.ssh/config 解析）" })),
			user: Type.Optional(Type.String({ description: "可选 SSH 用户" })),
			port: Type.Optional(Type.Number({ description: "可选 SSH 端口（1-65535）" })),
			note: Type.Optional(Type.String({ description: "可选备注（≤200 字符）" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
			if (params.action !== "register") return textResult(await targetsText());
			const read = await deps.targets.read();
			if (!read.ok) throw new Error(`${read.code}: ${read.message}`);
			// 模型侧永远 force=false（同名拒绝）：删除/覆盖只留给人工命令（对齐文档 Q2）。
			const added = addTarget(
				read.value,
				{ alias: params.alias, host: params.host, user: params.user, port: params.port, note: params.note, source: "agent" },
				{ nowIso: now(), force: false },
			);
			if (!added.ok) throw new Error(`${added.code}: ${added.message}`);
			const written = await deps.targets.write(added.value);
			if (!written.ok) throw new Error(`${written.code}: ${written.message}`);
			notifyTool(ctx, `已登记远端目标 ${added.entry.alias} → ${formatEntry(added.entry)}（来源 agent）`);
			return textResult(`已登记 ${added.entry.alias} → ${formatEntry(added.entry)}（source=agent）\n${formatTargetsList(added.value, deps.targets.path)}`);
		},
	});

	// ── /remote:*（人工面：登记 / 清单 / 删除 / 白名单开关）───────────────────
	pi.registerCommand(REMOTE_COMMANDS.list, {
		description: "列出已登记的远端目标（别名白名单）",
		handler: async (_args, ctx) => {
			try {
				notifyCommand(ctx, await targetsText());
			} catch (error) {
				notifyCommand(ctx, describeError(error));
			}
		},
	});

	pi.registerCommand(REMOTE_COMMANDS.add, {
		description: "登记远端目标：/remote:add <别名> [user@host] [--port N] [--force]",
		handler: async (args, ctx) => {
			const parsed = parseAddTargetArgs(args);
			if (!parsed.ok) {
				notifyCommand(ctx, parsed.message);
				return;
			}
			try {
				const file = await loadTargets();
				let host: string | undefined;
				let user: string | undefined;
				let port = parsed.value.port;
				if (parsed.value.target !== undefined) {
					const literal = parseTarget({ remote: parsed.value.target, remotePort: parsed.value.port });
					if (!literal.ok) {
						notifyCommand(ctx, `${literal.code}: ${literal.message}`);
						return;
					}
					if (literal.target === null) {
						notifyCommand(ctx, "目标不能为空（省略 user@host 时用别名当主机名）");
						return;
					}
					host = literal.target.host;
					user = literal.target.user;
					port = literal.target.port ?? parsed.value.port;
				}
				const added = addTarget(
					file,
					{ alias: parsed.value.alias, host, user, port, source: "human" },
					{ nowIso: now(), force: parsed.value.force },
				);
				if (!added.ok) {
					notifyCommand(ctx, `${added.code}: ${added.message}`);
					return;
				}
				const written = await deps.targets.write(added.value);
				notifyCommand(ctx, written.ok ? `已登记 ${added.entry.alias} → ${formatEntry(added.entry)}` : `${written.code}: ${written.message}`);
			} catch (error) {
				notifyCommand(ctx, describeError(error));
			}
		},
	});

	pi.registerCommand(REMOTE_COMMANDS.remove, {
		description: "删除一个已登记的远端目标：/remote:rm <别名>",
		handler: async (args, ctx) => {
			const alias = args.trim();
			if (alias === "") {
				notifyCommand(ctx, "用法：/remote:rm <别名>");
				return;
			}
			try {
				const removed = removeTarget((await loadTargets()) ?? emptyTargetsFile(), alias);
				if (!removed.ok) {
					notifyCommand(ctx, `${removed.code}: ${removed.message}`);
					return;
				}
				const written = await deps.targets.write(removed.value);
				notifyCommand(ctx, written.ok ? `已删除远端目标 ${alias}` : `${written.code}: ${written.message}`);
			} catch (error) {
				notifyCommand(ctx, describeError(error));
			}
		},
	});

	pi.registerCommand(REMOTE_COMMANDS.strict, {
		description: "开关 strict 白名单（只接受已登记目标）：/remote:strict on|off",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value !== "on" && value !== "off") {
				notifyCommand(ctx, "用法：/remote:strict on|off");
				return;
			}
			try {
				const written = await deps.targets.write(withStrict(await loadTargets(), value === "on"));
				notifyCommand(ctx, written.ok ? `strict 白名单已${value === "on" ? "开启（只接受已登记目标）" : "关闭（自由填写恢复可用）"}` : `${written.code}: ${written.message}`);
			} catch (error) {
				notifyCommand(ctx, describeError(error));
			}
		},
	});
}
