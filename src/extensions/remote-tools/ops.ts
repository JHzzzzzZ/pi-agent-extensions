/*
 * remote-tools — 把内置工具的 Operations 接缝接到远端：session + 7 类后端原语。
 *
 * 设计不变量：
 *   - 每次操作 = 一条远端命令（一次 ssh 往返），不带交互、不带凭据；
 *   - 路径先过 validateRemotePath（相对路径 / Windows 路径在**发 ssh 之前**就 fail-closed）；
 *   - 错误一律以 `CODE: 静态消息` 抛出（不插值远端路径或远端输出，防远端内容回灌模型）；
 *   - 「远端没有 ripgrep」用 stderr 上的 DEGRADED_MARKER 在**同一次往返**里上报，不额外探测轮次。
 */

import type {
	BashOperations,
	EditOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";

import { ErrorCodes, type RemoteToolsErrorCode } from "./errors.ts";
import { toRemotePath } from "./paths.ts";
import { type SshExec, type SshTarget, buildSshArgs, classifySshFailure, runSsh, shellQuote, validateRemotePath } from "./ssh.ts";

/** 远端降级标记：远端命令在 stderr 上打这个标记表示走了 POSIX 回退路径。 */
export const DEGRADED_MARKER = "PI_REMOTE_TOOLS_DEGRADED";

/** 远端 shell 在 cd 失败时的专用退出码（与普通命令失败区分）。 */
const EXIT_CWD_MISSING = 201;
/** 内部探测退出码：路径不存在 / 路径是目录。 */
const EXIT_NOT_FOUND = 3;
const EXIT_IS_DIRECTORY = 4;

function fail(code: RemoteToolsErrorCode, message: string): never {
	throw new Error(`${code}: ${message}`);
}

/** 宿主解析后的路径 → 远端绝对路径；不可还原或不是绝对 POSIX 路径就 fail-closed。 */
function requireRemotePath(hostPath: string): string {
	const remotePath = toRemotePath(hostPath);
	const checked = validateRemotePath(remotePath);
	if (!checked.ok) fail(checked.code, checked.message);
	return remotePath;
}

export interface RemoteSession {
	target: SshTarget;
	exec: SshExec;
	/** 远端 $HOME（懒解析一次并缓存；`ls`/`find`/`grep` 省略 path 与 bash 缺省 cwd 都用它）。 */
	home(): Promise<string>;
}

export interface RemoteSessionOptions {
	target: SshTarget;
	exec: SshExec;
	/** 预置 $HOME（测试与调用方已知时用），省略则第一次 home() 时经 ssh 解析。 */
	homeDir?: string | undefined;
}

export function createRemoteSession(options: RemoteSessionOptions): RemoteSession {
	let homePromise: Promise<string> | undefined;
	return {
		target: options.target,
		exec: options.exec,
		home(): Promise<string> {
			homePromise ??= options.homeDir === undefined ? resolveRemoteHome(options.target, options.exec) : Promise.resolve(options.homeDir);
			return homePromise;
		},
	};
}

async function resolveRemoteHome(target: SshTarget, exec: SshExec): Promise<string> {
	const result = await runSsh(exec, target, `printf '%s\\n' "\${HOME:-}"`);
	const transport = classifySshFailure(result);
	if (transport !== null) fail(transport.code, transport.message);
	const home = result.stdout.toString("utf8").trim();
	if (result.exitCode !== 0 || home === "" || !home.startsWith("/")) {
		fail(ErrorCodes.REMOTE_NOT_FOUND, "无法解析远端 $HOME：请确认远端账号有可用的家目录。");
	}
	return home;
}

export interface RemoteRunOptions {
	stdin?: Buffer | undefined;
	timeoutMs?: number | undefined;
	signal?: AbortSignal | undefined;
}

/** 跑一条远端命令并把传输层失败转成结构化错误（退出码语义留给调用方）。 */
async function runChecked(session: RemoteSession, command: string, options: RemoteRunOptions = {}) {
	const result = await runSsh(session.exec, session.target, command, options);
	const transport = classifySshFailure(result);
	if (transport !== null) fail(transport.code, transport.message);
	return result;
}

function lines(buffer: Buffer): string[] {
	return buffer
		.toString("utf8")
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
		.filter((line) => line !== "");
}

async function testAccess(session: RemoteSession, hostPath: string, testFlags: string, code: RemoteToolsErrorCode, message: string): Promise<void> {
	const remotePath = requireRemotePath(hostPath);
	const quoted = shellQuote(remotePath);
	// 多个标志必须拆成多条 test 用 && 连接：`test -r -w <path>` 是非法表达式（POSIX test 三参数形态），
	// 实机上会以非零退出码失败、把可写文件误报成不可写（真机验收抓到过）。
	const checks = testFlags
		.split(/\s+/)
		.filter((flag) => flag !== "")
		.map((flag) => `test ${flag} ${quoted}`)
		.join(" && ");
	// 一次往返里区分「不存在」与「权限不足」：与本地实现的错误语义对齐（fail-closed）。
	const result = await runChecked(session, `if [ -e ${quoted} ]; then ${checks}; else exit ${EXIT_NOT_FOUND}; fi`);
	if (result.exitCode === EXIT_NOT_FOUND) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端路径不存在。");
	if (result.exitCode !== 0) fail(code, message);
}

export function createRemoteReadOps(session: RemoteSession): ReadOperations {
	return {
		async readFile(absolutePath: string): Promise<Buffer> {
			const remotePath = requireRemotePath(absolutePath);
			const quoted = shellQuote(remotePath);
			const result = await runChecked(session, `if [ -e ${quoted} ]; then LC_ALL=C cat ${quoted}; elif [ -d ${quoted} ]; then exit ${EXIT_IS_DIRECTORY}; else exit ${EXIT_NOT_FOUND}; fi`);
			if (result.exitCode === EXIT_NOT_FOUND) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端路径不存在。");
			if (result.exitCode === EXIT_IS_DIRECTORY) fail(ErrorCodes.REMOTE_NOT_READABLE, "远端路径是目录，无法按文件读取。");
			if (result.exitCode !== 0) fail(ErrorCodes.REMOTE_NOT_READABLE, "远端文件不可读（权限不足）。");
			return result.stdout;
		},
		async access(absolutePath: string): Promise<void> {
			await testAccess(session, absolutePath, "-r", ErrorCodes.REMOTE_NOT_READABLE, "远端文件不可读（权限不足）。");
		},
	};
}

export interface RemoteWriteOperations extends WriteOperations {
	access(absolutePath: string): Promise<void>;
}

export function createRemoteWriteOps(session: RemoteSession): RemoteWriteOperations {
	return {
		async writeFile(absolutePath: string, content: string): Promise<void> {
			const remotePath = requireRemotePath(absolutePath);
			const result = await runChecked(session, `LC_ALL=C cat > ${shellQuote(remotePath)}`, { stdin: Buffer.from(content, "utf8") });
			if (result.exitCode !== 0) fail(ErrorCodes.REMOTE_WRITE_FAILED, "远端文件写入失败（目录不存在或权限不足）。");
		},
		async mkdir(dir: string): Promise<void> {
			const remoteDir = requireRemotePath(dir);
			const result = await runChecked(session, `mkdir -p ${shellQuote(remoteDir)}`);
			if (result.exitCode !== 0) fail(ErrorCodes.REMOTE_WRITE_FAILED, "远端目录创建失败。");
		},
		async access(absolutePath: string): Promise<void> {
			await testAccess(session, absolutePath, "-w", ErrorCodes.REMOTE_NOT_WRITABLE, "远端文件不可写（权限不足）。");
		},
	};
}

export function createRemoteEditOps(session: RemoteSession): EditOperations {
	const reader = createRemoteReadOps(session);
	const writer = createRemoteWriteOps(session);
	return {
		readFile: reader.readFile,
		writeFile: writer.writeFile,
		async access(absolutePath: string): Promise<void> {
			await testAccess(session, absolutePath, "-r -w", ErrorCodes.REMOTE_NOT_WRITABLE, "远端文件不可读写（权限不足）。");
		},
	};
}

export function createRemoteLsOps(session: RemoteSession): LsOperations {
	return {
		async exists(absolutePath: string): Promise<boolean> {
			const remotePath = requireRemotePath(absolutePath);
			const result = await runChecked(session, `test -e ${shellQuote(remotePath)}`);
			return result.exitCode === 0;
		},
		async stat(absolutePath: string): Promise<{ isDirectory: () => boolean }> {
			const remotePath = requireRemotePath(absolutePath);
			const quoted = shellQuote(remotePath);
			const result = await runChecked(session, `if [ -d ${quoted} ]; then printf 'd'; elif [ -e ${quoted} ]; then printf 'f'; else exit ${EXIT_NOT_FOUND}; fi`);
			if (result.exitCode === EXIT_NOT_FOUND) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端路径不存在。");
			if (result.exitCode !== 0) fail(ErrorCodes.REMOTE_NOT_READABLE, "远端路径不可访问（权限不足）。");
			const isDirectory = result.stdout.toString("utf8").startsWith("d");
			return { isDirectory: () => isDirectory };
		},
		async readdir(absolutePath: string): Promise<string[]> {
			const remotePath = requireRemotePath(absolutePath);
			const result = await runChecked(session, `ls -A1 ${shellQuote(remotePath)}`);
			if (result.exitCode === 2) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端目录不存在。");
			if (result.exitCode !== 0) fail(ErrorCodes.REMOTE_NOT_READABLE, "远端目录不可读（权限不足）。");
			return lines(result.stdout);
		},
	};
}

export interface RemoteGlobResult {
	entries: string[];
	/** true = 远端缺 ripgrep，走了 POSIX `find` 回退（忽略规则退化为目录名匹配）。 */
	degraded: boolean;
}

export interface RemoteGlobOptions {
	ignore: string[];
	limit: number;
}

/** 从 `**\/name\/**` 形态的忽略规则里取出目录名（回退路径用 find -prune 近似）。 */
export function ignoreDirNames(ignore: string[]): string[] {
	const names = new Set<string>();
	for (const pattern of ignore) {
		const match = /\*\*\/([^/*]+)\/\*\*/.exec(pattern);
		if (match !== null) names.add(match[1]);
	}
	return [...names].sort();
}

/** 从 glob pattern 里取文件名部分（回退路径用 find -name）。 */
export function globBasename(pattern: string): string {
	const segments = pattern.split("/");
	return segments[segments.length - 1] ?? pattern;
}

function buildFindCommand(pattern: string, cwd: string, options: RemoteGlobOptions): string {
	const dirNames = ignoreDirNames(options.ignore);
	const quotedCwd = shellQuote(cwd);
	const basename = globBasename(pattern);
	const nameTest = pattern.includes("/") ? `-path ${shellQuote(pattern)}` : `-name ${shellQuote(basename)}`;
	const prune =
		dirNames.length === 0 ? "" : `\\( ${dirNames.map((name) => `-name ${shellQuote(name)}`).join(" -o ")} \\) -prune -o `;
	return `find ${quotedCwd} ${prune}-type f ${nameTest} -print | head -n ${options.limit}`;
}

function buildRipgrepFilesCommand(pattern: string, cwd: string, options: RemoteGlobOptions): string {
	const globs = [`--glob ${shellQuote(pattern)}`, ...options.ignore.map((ignore) => `--glob ${shellQuote(`!${ignore}`)}`)];
	return `rg --files ${globs.join(" ")} -- ${shellQuote(cwd)} | head -n ${options.limit}`;
}

export interface RemoteFindOperations {
	exists(absolutePath: string): Promise<boolean>;
	glob(pattern: string, cwd: string, options: RemoteGlobOptions): Promise<RemoteGlobResult>;
}

export function createRemoteFindOps(session: RemoteSession): RemoteFindOperations {
	return {
		async exists(absolutePath: string): Promise<boolean> {
			const remotePath = requireRemotePath(absolutePath);
			const result = await runChecked(session, `test -e ${shellQuote(remotePath)}`);
			return result.exitCode === 0;
		},
		async glob(pattern: string, cwd: string, options: RemoteGlobOptions): Promise<RemoteGlobResult> {
			const remoteCwd = requireRemotePath(cwd);
			// 一次往返里完成「有没有 rg」的分支，降级经 stderr 标记上报。
			const command = [
				`if command -v rg >/dev/null 2>&1; then ${buildRipgrepFilesCommand(pattern, remoteCwd, options)};`,
				`else printf '%s\\n' ${shellQuote(DEGRADED_MARKER)} >&2; ${buildFindCommand(pattern, remoteCwd, options)}; fi`,
			].join(" ");
			const result = await runChecked(session, command);
			const degraded = result.stderr.includes(DEGRADED_MARKER);
			if (result.exitCode !== 0 && !degraded) {
				fail(ErrorCodes.REMOTE_COMMAND_FAILED, "远端文件搜索失败。");
			}
			if (result.exitCode !== 0 && degraded && result.stdout.length === 0) {
				fail(ErrorCodes.REMOTE_COMMAND_FAILED, "远端回退搜索（find）失败。");
			}
			return { entries: lines(result.stdout), degraded };
		},
	};
}

/**
 * 允许转发到远端的会话环境变量：与宿主 bash 自己维护的那五个一一对应（见 dist/core/tools/bash.js
 * 的 resolveSpawnContext）。**白名单而非 PI_ 前缀**——环境里可能同时存在宿主的敏感变量
 * （实测本机就有 PI_WEB_TOKEN），前缀匹配会把它们一起送到远端，这是安全不变量。
 */
export const FORWARDED_REMOTE_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const;

/** 只把白名单里的会话变量转发到远端（其余远端自带环境），键名做 shell 标识符校验。 */
export function formatEnvPrefix(env: NodeJS.ProcessEnv | undefined): string {
	if (env === undefined) return "";
	const allowed = new Set<string>(FORWARDED_REMOTE_ENV_KEYS);
	const assignments: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (!allowed.has(key) || value === undefined) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		assignments.push(`${key}=${shellQuote(value)}`);
	}
	return assignments.length === 0 ? "" : `${assignments.join(" ")} `;
}

export function createRemoteBashOps(session: RemoteSession): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }): Promise<{ exitCode: number }> {
			const remoteCwd = requireRemotePath(cwd);
			if (signal?.aborted === true) throw new Error("aborted");

			const remoteCommand = `cd ${shellQuote(remoteCwd)} || exit ${EXIT_CWD_MISSING}; ${formatEnvPrefix(env)}${command}`;
			const result = await session.exec({
				file: "ssh",
				args: buildSshArgs(session.target, remoteCommand),
				stdin: undefined,
				timeoutMs: timeout === undefined ? undefined : Math.max(1, Math.ceil(timeout * 1000)),
				signal,
				onData,
			});

			if (timeout !== undefined && result.timedOut === true) {
				// 与内置本地后端同形态：bash 工具自己的 timeout 参数超时 → 抛 `timeout:<秒>`。
				throw new Error(`timeout:${timeout}`);
			}
			const transport = classifySshFailure(result);
			if (transport !== null) fail(transport.code, transport.message);
			if (result.aborted === true || signal?.aborted) throw new Error("aborted");
			if (result.exitCode === EXIT_CWD_MISSING) {
				fail(ErrorCodes.REMOTE_NOT_FOUND, "不存在的远端目录：请先确认远端工作目录路径。");
			}
			if (result.exitCode === null) fail(ErrorCodes.SSH_CONNECT_FAILED, "ssh 连接在命令执行期间中断。");
			return { exitCode: result.exitCode };
		},
	};
}
