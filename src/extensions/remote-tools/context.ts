/*
 * remote-tools — 「远端目录的上下文」能力提供方（dir-context-todo#6，契约卡 docs/cross/remote-context-capability.md）。
 *
 * 背景：dir-context 补的是「按需注入目录作用域上下文」，但它不会 ssh、也解不了远端路径。
 * 远端调用的 `path` 在**远端**解析（省略/相对按远端 $HOME），本机解不了 —— 所以要自动注入
 * 远端目录的 AGENTS.md，必须由**能 ssh 的这一侧**把文件取回来。
 *
 * 方案（B：宿主官方 `pi.events` 能力协商，与 shell 能力同构）：消费方（dir-context）在
 * `session_start` 广播一个**可变盒子**，本扩展在同步回调里把 `fetchRemoteContext` 放进去。
 * 双方不互相 import、各自实现形状守卫；本扩展缺席时消费方退回「一行提示」。
 *
 * 分工：本侧只负责**取**（解析远端路径 + 一趟 ssh 拿回祖先链内容），
 * 注入（去重/预算/截断/块格式）全部留在 dir-context —— 规则只有一份。
 */

import { posix } from "node:path";
import type { EventBus } from "@earendil-works/pi-coding-agent";

import { ErrorCodes } from "./errors.ts";
import { type SshExec, type SshTarget, classifySshFailure, runSsh, shellQuote } from "./ssh.ts";

/** 收集频道（跨扩展契约；升级形状用新频道 v2，不做版本字段）。 */
export const REMOTE_CONTEXT_CHANNEL = "pi-extensions:dir-context-remote-context:v1";

/**
 * 每个目录按优先级取一个 —— 与 dir-context 的本地发现口径逐字一致
 * （`AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`）。
 */
export const CONTEXT_FILE_NAMES: readonly string[] = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** 祖先链深度上限：命令长度与内存有界；被 $HOME 或 `/` 截断时远到不了顶。 */
export const MAX_CONTEXT_CHAIN_DEPTH = 16;

/** 消费方的请求（形状由契约固定；本模块是提供方，字段一律当不可信输入校验）。 */
export interface RemoteContextRequest {
	remote: string;
	remotePort?: number | undefined;
	path?: string | undefined;
	/** 触碰类型：目录类把该路径自身当锚点，文件类退到父目录（与本地 resolveAnchor 同语义）。 */
	kind: "file" | "directory";
}

export interface RemoteContextFile {
	/** 远端绝对路径。 */
	path: string;
	content: string;
}

export type RemoteContextOutcome =
	| { ok: true; dir: string; files: RemoteContextFile[] }
	| { ok: false; code: string; message: string };

/** 解析结果（本侧自己声明形状，不从 tools.ts 引类型——避免模块环）。 */
export interface RemoteContextTarget {
	/** 远端绝对路径（已过 validateRemotePath）。 */
	remotePath: string;
	/** 远端解析基准：相对/省略路径是远端 $HOME，绝对路径是 `/`。 */
	baseDir: string;
	/** ssh 目标（复用工具分支同一个 session 缓存里的那个）。 */
	target: SshTarget;
}

export interface RemoteContextCapability {
	fetchRemoteContext(request: RemoteContextRequest): Promise<RemoteContextOutcome>;
}

/** 该路径是否在基准之内（含自身）。`/` 作基准时任何绝对路径都算在内。 */
function isWithinBase(path: string, base: string): boolean {
	if (base === "/") return path.startsWith("/");
	return path === base || path.startsWith(`${base}/`);
}

/**
 * 祖先链（**由外向内**）：从锚点目录向上走到远端基准（$HOME 或 `/`）为止，两端都含。
 *
 * 与本地不同的一点：本地在 cwd 处停（cwd 自己的上下文文件 pi 已加载），远端没有这个概念，
 * 所以**基准自身也算一级**（用户决定：远端侧走到 $HOME 或最外层）。
 * 锚点不在基准之内（`..` 逃逸出 $HOME）⇒ 返回空链，零注入（fail-closed）。
 */
export function contextChainDirs(anchorDir: string, baseDir: string): string[] {
	if (!isWithinBase(anchorDir, baseDir)) return [];
	const chain: string[] = [];
	let current = anchorDir;
	for (let depth = 0; depth < MAX_CONTEXT_CHAIN_DEPTH; depth += 1) {
		chain.push(current);
		if (current === baseDir) break;
		const parent = posix.dirname(current);
		if (parent === current || !isWithinBase(parent, baseDir)) break;
		current = parent;
	}
	return chain.reverse();
}

/**
 * 一趟 ssh 的远端命令：逐级、逐候选名探一个存在的文件，命中即把「路径 + 内容」以 **NUL 分帧**吐出来
 * （NUL 不可能出现在文本内容里 ⇒ 不需要转义、不会与内容撞车）。
 * `-f` 而不是 `-e`：目录也叫 AGENTS.md 时不当文件读。
 */
export function buildContextCommand(dirs: readonly string[]): string {
	const names = CONTEXT_FILE_NAMES.join(" ");
	return dirs
		.map((dir) => `for n in ${names}; do f=${quoteDir(dir)}/$n; if [ -f "$f" ]; then printf '%s\\000' "$f"; cat "$f"; printf '\\000'; break; fi; done`)
		.join("; ");
}

/** 拼目录时不把根写成 `'/'`：否则得到 `//AGENTS.md`，而 POSIX 对 `//` 前缀是实现自定义（Cygwin 会当 UNC）。 */
function quoteDir(dir: string): string {
	return dir === "/" ? "''" : shellQuote(dir);
}

/**
 * NUL 分帧的输出 → 文件列表（奇数项是路径、偶数项是内容；尾部空段丢弃）。
 *
 * 路径帧必须长得像绝对 POSIX 路径且不含换行：远端登录 rc/banner 往 stdout 吐的东西会被扇进
 * 首帧，不做校验就会以垃圾标题注入（内容不可信，不往上下文里编）。
 */
export function parseContextFiles(stdout: Buffer): RemoteContextFile[] {
	const parts = stdout.toString("utf8").split("\u0000");
	const files: RemoteContextFile[] = [];
	for (let index = 0; index + 1 < parts.length; index += 2) {
		const path = parts[index];
		const content = parts[index + 1];
		if (path === undefined || content === undefined) continue;
		if (!path.startsWith("/") || /[\r\n]/.test(path)) continue;
		files.push({ path, content });
	}
	return files;
}

export interface RemoteContextDeps {
	/** 解析远端路径（复用工具分支的同一个 session 缓存与 $HOME 解析）；本地或非法 ⇒ null。 */
	resolve: (request: RemoteContextRequest) => Promise<RemoteContextTarget | null>;
	/** 进程边界端口：生产用 createSpawnExec，测试注入手写 fake。 */
	exec: SshExec;
}

/**
 * 取远端上下文。**永不抛**：所有失败都收敛成 `{ ok: false }`，消费方据此退回一行提示
 * （契约要求「失败不改坏工具结果、不打断会话」）。
 */
export function createRemoteContextCapability(deps: RemoteContextDeps): RemoteContextCapability {
	return {
		async fetchRemoteContext(request): Promise<RemoteContextOutcome> {
			let resolved: RemoteContextTarget | null;
			try {
				resolved = await deps.resolve(request);
			} catch {
				return { ok: false, code: ErrorCodes.REMOTE_CONTEXT_FAILED, message: "远端上下文：目标解析失败，本次跳过。" };
			}
			if (resolved === null) {
				return { ok: false, code: ErrorCodes.REMOTE_CONTEXT_FAILED, message: "远端上下文：目标不可用，本次跳过。" };
			}
			const anchorDir = request.kind === "directory" ? resolved.remotePath : posix.dirname(resolved.remotePath);
			const dirs = contextChainDirs(anchorDir, resolved.baseDir);
			if (dirs.length === 0) return { ok: true, dir: anchorDir, files: [] };

			const result = await runSsh(deps.exec, resolved.target, buildContextCommand(dirs));
			const transport = classifySshFailure(result);
			if (transport !== null) return { ok: false, code: transport.code, message: transport.message };
			if (result.exitCode !== 0) {
				return { ok: false, code: ErrorCodes.REMOTE_CONTEXT_FAILED, message: "远端上下文：远端命令非零退出，本次跳过。" };
			}
			return { ok: true, dir: anchorDir, files: parseContextFiles(result.stdout) };
		},
	};
}

/** 消费方请求里的字段一律当不可信输入：形状不对 ⇒ 当作「没有能力」，绝不因协商破坏会话。 */
function toRemoteContextRequest(value: unknown): RemoteContextRequest | null {
	if (typeof value !== "object" || value === null) return null;
	const { remote, remotePort, path, kind } = value as Record<string, unknown>;
	if (typeof remote !== "string" || remote.length === 0) return null;
	if (kind !== "file" && kind !== "directory") return null;
	if (remotePort !== undefined && typeof remotePort !== "number") return null;
	if (path !== undefined && typeof path !== "string") return null;
	return { remote, remotePort: remotePort as number | undefined, path: path as string | undefined, kind };
}

/** 薄包装：把消费方的调用参数校验收在这里，能力实现只面对已校验的形状。 */
function guardCapability(capability: RemoteContextCapability): RemoteContextCapability {
	return {
		fetchRemoteContext: (request) => {
			const checked = toRemoteContextRequest(request);
			if (checked === null) {
				return Promise.resolve({ ok: false, code: ErrorCodes.REMOTE_CONTEXT_FAILED, message: "远端上下文：请求形状非法，本次跳过。" });
			}
			try {
				return Promise.resolve(capability.fetchRemoteContext(checked)).catch(() => ({
					ok: false as const,
					code: ErrorCodes.REMOTE_CONTEXT_FAILED,
					message: "远端上下文：能力调用失败，本次跳过。",
				}));
			} catch {
				return Promise.resolve({ ok: false as const, code: ErrorCodes.REMOTE_CONTEXT_FAILED, message: "远端上下文：能力调用失败，本次跳过。" });
			}
		},
	};
}

/**
 * 订阅收集频道并填槽。盒子不是对象 ⇒ 忽略；槽位已有主 ⇒ 先到先得；订阅本身失败
 * （宿主没有事件总线 / 旧版本）⇒ 静默跳过，本扩展自己的工具注册照常工作。
 */
export function offerRemoteContextCapability(events: EventBus | undefined, capability: RemoteContextCapability): void {
	if (events === undefined) return;
	const offer = guardCapability(capability);
	try {
		events.on(REMOTE_CONTEXT_CHANNEL, (box) => {
			try {
				if (typeof box !== "object" || box === null) return;
				const slot = box as { remoteContext?: unknown };
				if (slot.remoteContext !== undefined) return;
				slot.remoteContext = offer;
			} catch {
				/* 盒子不可写：当作没提供能力 */
			}
		});
	} catch {
		/* 没有事件总线：协商不可用，行为退回「一行提示」 */
	}
}

