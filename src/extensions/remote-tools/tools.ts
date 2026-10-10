/*
 * remote-tools — 7 个内置工具的同名覆盖（remote 非空 = 远端，空 = 原样委托宿主本地实现）。
 *
 * 覆盖机制：`pi.registerTool()` 注册同名工具会替换内置定义（dist/core/agent-session.js
 * 中 built-ins 先入注册表、custom tools 后入覆盖），这是官方 Gondolin 扩展的同一做法。
 * 保真策略：
 *   1. 本地分支直接调 `createXxxToolDefinition(ctx.cwd)` 的原实现，零行为漂移；
 *   2. 远端分支把**同一份**内置定义配上远端 Operations（read/write/edit/ls/find/bash），
 *      因此截断、限流、渲染器、提示词片段全部沿用宿主实现；
 *   3. 只有 grep 必须整份重写（GrepOperations 覆盖不到真正的搜索，见 grep.ts）。
 *
 * 顺序不变量：参数校验（目标、端口、远端路径）一律发生在**任何 ssh 进程之前**；
 * 绝对远端路径不需要解析远端 $HOME，因此也就不会为此多发一次 ssh。
 */

import type {
	AgentToolResult,
	BashToolDetails,
	BashToolInput,
	EditToolDetails,
	EditToolInput,
	ExtensionAPI,
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
import { stripHostMarker, toHostPath } from "./paths.ts";
import { type SshExec, type SshTarget, formatTarget, parseTarget, validateRemotePath } from "./ssh.ts";

const REMOTE_GUIDELINE =
	"远端工具（remote-tools）：给 read/write/edit/bash/grep/find/ls 传 remote=\"[user@]host\"（可选 remotePort）即在远端主机执行，此时 path 必须是远端绝对 POSIX 路径；remote 省略或留空表示本机执行。";

export interface RemoteToolsDeps {
	/** 进程边界端口：生产用 createSpawnExec，测试注入手写 fake。 */
	exec: SshExec;
	/** 本地 cwd（remote 为空且 ctx 无 cwd 时的本地实现基准）。 */
	cwd: string;
}

type RemoteTargetParams = { remote?: string | undefined; remotePort?: number | undefined };

interface RemotePlan {
	session: RemoteSession;
	/** 远端 $HOME（session 内缓存，同目标只解析一次）。 */
	home: () => Promise<string>;
}

type SessionPlan = { kind: "local" } | ({ kind: "remote" } & RemotePlan);

const remoteTargetProperties = {
	remote: Type.Optional(
		Type.String({
			description: '远端 SSH 目标 "[user@]host"（可选 remotePort）；省略或留空 = 在本机执行。给值时 path 必须是远端绝对 POSIX 路径。',
		}),
	),
	remotePort: Type.Optional(Type.Number({ description: "远端 SSH 端口（1-65535，省略用 ssh 默认或 ~/.ssh/config）" })),
};

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

/** 路径校验先于 ssh；只有省略或相对路径才需要解析远端 $HOME。 */
export function resolveToolPath(plan: RemotePlan, input: string | undefined): Promise<ResolvedToolPath>;
export async function resolveToolPath(plan: RemotePlan, input: string | undefined): Promise<ResolvedToolPath> {
	const candidate = input === undefined ? undefined : stripHostMarker(input);
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

/**
 * 远端分支要给内置定义一个「cwd 在远端」的 ctx：宿主 ctx 的 cwd 是本机项目目录，
 * bash 拿它当工作目录、其余工具用它解析路径，直接用会把本机路径当成远端路径。
 * 用 Object.create 保留原型链上的 getter（sessionManager / model 等），只覆盖 cwd。
 */
function remoteContext(ctx: ExtensionToolContext | undefined, remoteBase: string): ExtensionToolContext {
	const base = ctx ?? (EMPTY_HOST_CONTEXT as unknown as ExtensionToolContext);
	return Object.create(base as object, { cwd: { value: toHostPath(remoteBase), enumerable: true } }) as ExtensionToolContext;
}

/** 宿主理论上总是给 ctx（codemode 嵌套调用也可能给）；缺失时用最小形状兜住 bash 的会话环境读取。 */
const EMPTY_HOST_CONTEXT = {
	sessionManager: { getSessionId: () => "", getSessionFile: () => undefined },
	model: undefined,
	thinkingLevel: undefined,
};

export function registerRemoteTools(pi: ExtensionAPI, deps: RemoteToolsDeps): void {
	const sessionFor = createSessionCache(deps.exec);

	async function planSession(params: RemoteTargetParams): Promise<SessionPlan> {
		const parsed = parseTarget({ remote: params.remote, remotePort: params.remotePort });
		if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
		if (parsed.target === null) return { kind: "local" };
		const session = sessionFor(parsed.target);
		return { kind: "remote", session, home: () => session.home() };
	}

	// ── read ────────────────────────────────────────────────────────────────
	const readBase = createReadToolDefinition(deps.cwd);
	pi.registerTool({
		...readBase,
		description: `${readBase.description} 传 remote 时改在远端主机读取（path 为远端绝对 POSIX 路径）。`,
		promptGuidelines: [...(readBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...readBase.parameters.properties, ...remoteTargetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<ReadToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<ReadToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createReadToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const definition = createReadToolDefinition(toHostPath(path.baseDir), { operations: createRemoteReadOps(plan.session) });
			return definition.execute(id, { ...rest, path: toHostPath(path.remotePath) }, signal, onUpdate, remoteContext(ctx, path.baseDir));
		},
	});

	// ── write ───────────────────────────────────────────────────────────────
	const writeBase = createWriteToolDefinition(deps.cwd);
	pi.registerTool({
		...writeBase,
		description: `${writeBase.description} 传 remote 时改在远端主机写入（path 为远端绝对 POSIX 路径）。`,
		promptGuidelines: [...(writeBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...writeBase.parameters.properties, ...remoteTargetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<WriteToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createWriteToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const definition = createWriteToolDefinition(toHostPath(path.baseDir), { operations: createRemoteWriteOps(plan.session) });
			return definition.execute(id, { ...rest, path: toHostPath(path.remotePath) }, signal, onUpdate, remoteContext(ctx, path.baseDir));
		},
	});

	// ── edit ────────────────────────────────────────────────────────────────
	const editBase = createEditToolDefinition(deps.cwd);
	pi.registerTool({
		...editBase,
		description: `${editBase.description} 传 remote 时改在远端主机编辑（path 为远端绝对 POSIX 路径）。`,
		promptGuidelines: [...(editBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...editBase.parameters.properties, ...remoteTargetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<EditToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<EditToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createEditToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const definition = createEditToolDefinition(toHostPath(path.baseDir), { operations: createRemoteEditOps(plan.session) });
			return definition.execute(id, { ...rest, path: toHostPath(path.remotePath) }, signal, onUpdate, remoteContext(ctx, path.baseDir));
		},
	});

	// ── ls ──────────────────────────────────────────────────────────────────
	const lsBase = createLsToolDefinition(deps.cwd);
	pi.registerTool({
		...lsBase,
		description: `${lsBase.description} 传 remote 时改列远端主机目录（path 为远端绝对 POSIX 路径，省略 = 远端 $HOME）。`,
		promptGuidelines: [...(lsBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...lsBase.parameters.properties, ...remoteTargetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<LsToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<LsToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createLsToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const definition = createLsToolDefinition(toHostPath(path.baseDir), { operations: createRemoteLsOps(plan.session) });
			return definition.execute(id, { ...rest, path: toHostPath(path.remotePath) }, signal, onUpdate, remoteContext(ctx, path.baseDir));
		},
	});

	// ── find ────────────────────────────────────────────────────────────────
	const findBase = createFindToolDefinition(deps.cwd);
	pi.registerTool({
		...findBase,
		description: `${findBase.description} 传 remote 时改在远端主机搜索（path 为远端绝对 POSIX 路径，省略 = 远端 $HOME）。`,
		promptGuidelines: [...(findBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({ ...findBase.parameters.properties, ...remoteTargetProperties }),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<FindToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<FindToolInput & RemoteTargetParams>(params);
			if (plan.kind === "local") {
				return createFindToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const path = await resolveToolPath(plan, rest.path);
			const rich = createRemoteFindOps(plan.session);
			const sink = { degraded: false };
			const definition = createFindToolDefinition(toHostPath(path.baseDir), {
				operations: {
					exists: rich.exists,
					glob: async (pattern, cwd, options) => {
						const result = await rich.glob(pattern, cwd, options);
						sink.degraded = result.degraded;
						return result.entries;
					},
				},
			});
			const result = await definition.execute(id, { ...rest, path: toHostPath(path.remotePath) }, signal, onUpdate, remoteContext(ctx, path.baseDir));
			return sink.degraded ? appendNotice(result, "远端缺少 ripgrep，已回退 POSIX find：忽略规则退化为目录名匹配") : result;
		},
	});

	// ── bash ────────────────────────────────────────────────────────────────
	const bashBase = createBashToolDefinition(deps.cwd);
	pi.registerTool({
		...bashBase,
		description: `${bashBase.description} 传 remote 时改在远端主机执行（cwd = remoteCwd 或远端 $HOME）。`,
		promptGuidelines: [...(bashBase.promptGuidelines ?? []), REMOTE_GUIDELINE],
		parameters: Type.Object({
			...bashBase.parameters.properties,
			remoteCwd: Type.Optional(Type.String({ description: "远端工作目录（绝对 POSIX 路径）；省略 = 远端 $HOME" })),
			...remoteTargetProperties,
		}),
		async execute(id, params, signal, onUpdate, ctx): Promise<AgentToolResult<BashToolDetails | undefined>> {
			const plan = await planSession(params);
			const rest = stripRemoteFields<BashToolInput & RemoteTargetParams & { remoteCwd?: string | undefined }>(params);
			if (plan.kind === "local") {
				return createBashToolDefinition(ctx?.cwd ?? deps.cwd).execute(id, rest, signal, onUpdate, ctx);
			}
			const cwd = await resolveToolPath(plan, params.remoteCwd);
			const definition = createBashToolDefinition(toHostPath(cwd.remotePath), { operations: createRemoteBashOps(plan.session) });
			return definition.execute(id, rest, signal, onUpdate, remoteContext(ctx, cwd.remotePath));
		},
	});

	// ── grep（整份重写，见 grep.ts 顶部说明）────────────────────────────────
	pi.registerTool({
		name: "grep",
		label: "grep",
		description:
			"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. 传 remote 时改在远端主机搜索（path 为远端绝对 POSIX 路径，省略 = 远端 $HOME）；远端缺 ripgrep 时回退 GNU grep 并在结果里标注降级。",
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		promptGuidelines: [REMOTE_GUIDELINE],
		parameters: Type.Object({ ...remoteGrepSchema.properties, ...remoteTargetProperties }),
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
}
