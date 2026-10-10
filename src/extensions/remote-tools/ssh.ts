/*
 * remote-tools — SSH 传输层：目标解析、ssh 参数构造、远端命令执行、失败分类。
 *
 * 边界：本模块只做**传输与策略**，不认识任何内置工具的语义；真实进程经 `SshExec`
 * 端口注入（测试用手写 fake，生产用 createSpawnExec 的 node:child_process）。
 * 安全不变量：
 *   - 远端命令始终作为**单个 argv 元素**交给 ssh（不经过本地 shell），路径必须经 shellQuote 转义；
 *   - 非交互（BatchMode）且拒绝未知主机指纹（StrictHostKeyChecking=yes）⇒ 首次连接失败报错，
 *     由人工先手工 ssh 一次把指纹写进 known_hosts（不自动 accept-new）；
 *   - 不存任何凭据，复用系统密钥 / ssh-agent。
 */

import { spawn } from "node:child_process";

import { ErrorCodes, failure, type RemoteToolsFailure, type RemoteToolsErrorCode } from "./errors.ts";
import { isAbsenceLiteral } from "./paths.ts";

/** 远端连接目标（remote 为空 = 本地模式，不用本类型表达）。 */
export interface SshTarget {
	host: string;
	user: string | undefined;
	port: number | undefined;
}

export interface TargetInput {
	/** 任意类型：非字符串（含 null/数字）一律视为未提供（宿主 strict 采样器会给可选字段填噪声）。 */
	remote?: unknown;
	remotePort?: unknown;
}

export type TargetParse = { ok: true; target: SshTarget | null } | RemoteToolsFailure;

/** 连接超时（秒）：只作用于 ssh 建连阶段。 */
export const CONNECT_TIMEOUT_SECONDS = 10;

/** 命令默认超时（毫秒）：远端文件类操作无显式 timeout 时的上限。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * 端口归一（容忍宿主 strict 采样器填的噪声）：非 number / NaN / <= 0 ⇒ 未提供；
 * 正数但非整数或 >65535 ⇒ "invalid"（那是真的写错了，值得报错）。
 */
function normalizePort(value: unknown): number | undefined | "invalid" {
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return undefined;
	if (!Number.isInteger(value) || value > 65535) return "invalid";
	return value;
}

/**
 * 解析 remote / remotePort。空串、非字符串与纯空白都视为本地模式（返回 target: null）；
 * **本地模式完全忽略 remotePort**——没有远端意图的字段不得让调用失败。
 * 其余非法形态一律 fail-closed（目标形态、正数越界端口），绝不猜测。
 */
export function parseTarget(input: TargetInput): TargetParse {
	const remote = typeof input.remote === "string" ? input.remote.trim() : "";

	// 空串、纯空白与缺省值字面量（"null"/"undefined"/"nil"…）都是「没给」——不尝试 ssh。
	if (remote === "" || isAbsenceLiteral(remote)) return { ok: true, target: null };

	const port = normalizePort(input.remotePort);
	if (port === "invalid") {
		return failure(ErrorCodes.INVALID_REMOTE_PORT, "remotePort 必须是 1-65535 的整数（不指定端口请省略该参数）。");
	}

	if (remote.startsWith("-") || /\s/.test(remote) || remote.includes(":")) {
		return failure(ErrorCodes.INVALID_REMOTE_TARGET, "remote 形态非法：应为 \"[user@]host\"，端口请用 remotePort 指定。");
	}

	const at = remote.indexOf("@");
	if (at < 0) {
		return { ok: true, target: { host: remote, user: undefined, port } };
	}

	const user = remote.slice(0, at);
	const host = remote.slice(at + 1);
	if (user === "" || host === "" || host.includes("@")) {
		return failure(ErrorCodes.INVALID_REMOTE_TARGET, "remote 形态非法：应为 \"[user@]host\"，user 与 host 都不得为空。");
	}

	return { ok: true, target: { host, user, port } };
}

/** 「[user@]host」的展示形态（错误消息与状态展示共用）。 */
export function formatTarget(target: SshTarget): string {
	return target.user === undefined ? target.host : `${target.user}@${target.host}`;
}

/**
 * 构造 ssh argv：远端命令是最后一个参数（由 ssh 交给远端登录 shell 执行）。
 */
export function buildSshArgs(target: SshTarget, remoteCommand: string): string[] {
	const args = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`];
	if (target.port !== undefined) args.push("-p", String(target.port));
	args.push(formatTarget(target), remoteCommand);
	return args;
}

/** 单引号包裹 + `'\''` 转义：远端命令里拼路径的唯一允许方式。 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 远端路径必须是绝对 POSIX 路径（本地路径不翻译，映射由模型显式给出）。 */
export function validateRemotePath(value: string): { ok: true } | RemoteToolsFailure {
	if (value.startsWith("/")) return { ok: true };
	return failure(ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE, "远端路径必须是绝对 POSIX 路径（例如 /srv/app/src/index.ts）。");
}

export interface SshExecRequest {
	file: string;
	args: string[];
	stdin: Buffer | undefined;
	timeoutMs: number | undefined;
	signal: AbortSignal | undefined;
	/** stdout 与 stderr 的**合并**流式回调（与内置本地 bash 后端的 onData 同语义）。 */
	onData?: ((chunk: Buffer) => void) | undefined;
}

export interface SshExecResult {
	exitCode: number | null;
	stdout: Buffer;
	stderr: string;
	timedOut: boolean;
	spawnFailed: boolean;
	aborted?: boolean;
}

/** 进程边界端口：生产走 createSpawnExec，测试注入手写 fake。 */
export type SshExec = (request: SshExecRequest) => Promise<SshExecResult>;

/** 流式回调异常隔离：观察者抛错不破坏命令执行（与内置本地后端一致）。 */
function emit(request: SshExecRequest, chunk: Buffer): void {
	if (request.onData === undefined) return;
	try {
		request.onData(Buffer.from(chunk));
	} catch {
		/* 忽略：onData 只是观察者 */
	}
}

/** 生产实现：spawn ssh，收集 stdout（二进制安全）/ stderr，支持超时与中止。 */
export function createSpawnExec(): SshExec {
	return (request) =>
		new Promise<SshExecResult>((resolve) => {
			const chunks: Buffer[] = [];
			let stderr = "";
			let timedOut = false;
			let aborted = false;
			let settled = false;

			const finish = (result: SshExecResult): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				request.signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};

			const child = (() => {
				try {
					return spawn(request.file, request.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
				} catch {
					return null;
				}
			})();

			if (child === null) {
				resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, spawnFailed: true });
				return;
			}

			const onAbort = (): void => {
				aborted = true;
				child.kill("SIGKILL");
			};

			const timer =
				request.timeoutMs === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							child.kill("SIGKILL");
						}, request.timeoutMs);

			child.stdout?.on("data", (chunk: Buffer) => {
				chunks.push(Buffer.from(chunk));
				emit(request, chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += Buffer.from(chunk).toString("utf8");
				emit(request, chunk);
			});
			child.on("error", () => finish({ exitCode: null, stdout: Buffer.alloc(0), stderr, timedOut, spawnFailed: true }));
			child.on("close", (code) =>
				finish({ exitCode: code, stdout: Buffer.concat(chunks), stderr, timedOut, spawnFailed: false, aborted }),
			);

			if (request.signal !== undefined) {
				request.signal.addEventListener("abort", onAbort, { once: true });
			}
			if (request.stdin !== undefined) child.stdin?.end(request.stdin);
			else child.stdin?.end();
		});
}

export interface SshRunOptions {
	stdin?: Buffer | undefined;
	timeoutMs?: number | undefined;
	signal?: AbortSignal | undefined;
	onData?: ((chunk: Buffer) => void) | undefined;
}

/** 执行一条远端命令（纯传输：非零退出码透传，由调用方决定语义）。 */
export function runSsh(exec: SshExec, target: SshTarget, remoteCommand: string, options: SshRunOptions = {}): Promise<SshExecResult> {
	return exec({
		file: "ssh",
		args: buildSshArgs(target, remoteCommand),
		stdin: options.stdin,
		timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
		signal: options.signal,
		onData: options.onData,
	});
}

type SshFailureInput = Pick<SshExecResult, "exitCode" | "stdout" | "stderr" | "timedOut" | "spawnFailed">;

/**
 * 分类传输层失败（不是命令的业务退出码）：超时 / ssh 客户端或连接失败。
 * 返回 null 表示「传输成功」，退出码语义由调用方处理。
 */
export function classifySshFailure(result: SshFailureInput): RemoteToolsFailure | null {
	if (result.timedOut) {
		return failure(ErrorCodes.SSH_TIMEOUT, `ssh 调用超过 ${CONNECT_TIMEOUT_SECONDS * 3} 秒未返回，已终止。`);
	}
	if (result.spawnFailed) {
		return failure(ErrorCodes.SSH_CONNECT_FAILED, "无法启动 ssh 客户端：请确认系统 PATH 里有 ssh。");
	}
	if (result.exitCode === 255 && /ssh:|Host key verification failed|Permission denied|Connection (refused|timed out|closed)/i.test(result.stderr)) {
		return failure(
			ErrorCodes.SSH_CONNECT_FAILED,
			"ssh 连接失败（未知主机指纹、认证失败或网络不可达）：请先在终端手工执行一次 ssh 完成确认与排错，再重试。",
		);
	}
	return null;
}

/** 传输失败时的模型可见文本：静态模板 + 错误码。 */
export function describeFailure(failed: RemoteToolsFailure): string {
	return `${failed.code}: ${failed.message}`;
}

/** 便于上层统一构造失败结果类型（错误码来自本模块的分类）。 */
export type SshFailureCode = Extract<RemoteToolsErrorCode, "SSH_CONNECT_FAILED" | "SSH_TIMEOUT">;
