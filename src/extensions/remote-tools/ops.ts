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
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RemoteJobPort } from "./capability.ts";
import { ErrorCodes, type RemoteToolsErrorCode } from "./errors.ts";
import { toRemotePath } from "./paths.ts";
import {
	type SshExec,
	type SshExecResult,
	type SshTarget,
	buildSshArgs,
	classifySshFailure,
	describeFailure,
	formatTarget,
	runSsh,
	shellQuote,
	validateRemotePath,
} from "./ssh.ts";

/** 远端降级标记：远端命令在 stderr 上打这个标记表示走了 POSIX 回退路径。 */
export const DEGRADED_MARKER = "PI_REMOTE_TOOLS_DEGRADED";

/** 远端 shell 在 cd 失败时的专用退出码（与普通命令失败区分）。 */
const EXIT_CWD_MISSING = 201;
/** 内部探测退出码：路径不存在 / 路径是目录。 */
const EXIT_NOT_FOUND = 3;
const EXIT_IS_DIRECTORY = 4;

/**
 * 宿主 read 的图片嗅探上限（宿主 dist/utils/mime.js 的 IMAGE_TYPE_SNIFF_BYTES = 4100）。
 * 这里取 8192 ≥ 它：把整段样本交给宿主同一份检测实现，宿主将来调大上限也不会嗅到截断样本。
 */
const IMAGE_SNIFF_BYTES = 8192;

function fail(code: RemoteToolsErrorCode, message: string): never {
	throw new Error(`${code}: ${message}`);
}

/**
 * 读探针：一次往返同时拿到「可读吗」与「前 8192 字节样本」（base64 文本，二进制安全）。
 * 目录不做样本（由 readFile 报「是目录」，错误归因与本地实现一致）；嗅探本身失败不算访问失败
 * （`|| true`：远端缺 base64 之类退化成「不是图片」，与不实现该端口时的行为一致）。
 */
function buildReadProbeCommand(remotePath: string): string {
	const quoted = shellQuote(remotePath);
	return (
		`if [ ! -e ${quoted} ]; then exit ${EXIT_NOT_FOUND}; ` +
		`elif [ -d ${quoted} ]; then exit 0; ` +
		`elif [ ! -r ${quoted} ]; then exit 1; ` +
		`else head -c ${IMAGE_SNIFF_BYTES} ${quoted} | base64 || true; fi`
	);
}

/** base64 文本 → 样本字节（远端换行/包装差异一律忽略）。 */
function decodeBase64Sample(stdout: Buffer): Buffer {
	return Buffer.from(stdout.toString("utf8").replace(/\s+/g, ""), "base64");
}

/**
 * 交给**宿主同一份**实现判定：包根只导出 detectSupportedImageMimeTypeFromFile（纯 buffer 版未导出，
 * 深路径 import 被包 exports 封死），所以样本先落到本地临时文件再喂给它——魔数/动图/BMP 规则零复制，
 * 宿主升级自动跟上。空样本（目录、空文件）宿主也判 null，提前返回省掉临时文件。
 */
async function detectMimeFromSample(sampleBytes: Buffer): Promise<string | null> {
	if (sampleBytes.length === 0) return null;
	const dir = await mkdtemp(join(tmpdir(), "pi-remote-sniff-"));
	try {
		const file = join(dir, "sample.bin");
		await writeFile(file, sampleBytes);
		return await detectSupportedImageMimeTypeFromFile(file);
	} finally {
		// 清理失败不该把一次成功的读取变成错误（临时目录残留无害）。
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
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
			if (homePromise === undefined) {
				const attempt =
					options.homeDir === undefined ? resolveRemoteHome(options.target, options.exec) : Promise.resolve(options.homeDir);
				// 失败就清缓存：session 本身被 tools.ts 按目标永久缓存，瞬时网络抖动不能把 $HOME 永久钉死（
				// 否则该目标所有相对路径调用要到 /reload 才能恢复）。
				homePromise = attempt.catch((error: unknown) => {
					homePromise = undefined;
					throw error;
				});
			}
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

/** 一次往返判定远端路径形态（目录/文件）；不存在返回 null。ls/find 的探针与 stat 共用。 */
async function probePathKind(session: RemoteSession, remotePath: string): Promise<"directory" | "file" | null> {
	const quoted = shellQuote(remotePath);
	const result = await runChecked(session, `if [ -d ${quoted} ]; then printf 'd'; elif [ -e ${quoted} ]; then printf 'f'; else exit ${EXIT_NOT_FOUND}; fi`);
	if (result.exitCode === EXIT_NOT_FOUND) return null;
	if (result.exitCode !== 0) fail(ErrorCodes.REMOTE_NOT_READABLE, "远端路径不可访问（权限不足）。");
	return result.stdout.toString("utf8").startsWith("d") ? "directory" : "file";
}

export function createRemoteReadOps(session: RemoteSession): ReadOperations {
	/** 本次 read 的嗅探样本：access 顺带取回、detectImageMimeType 消费（一次 read 只针对一个路径）。 */
	let sample: { remotePath: string; bytes: Buffer } | undefined;

	async function probe(remotePath: string): Promise<Buffer> {
		const result = await runChecked(session, buildReadProbeCommand(remotePath));
		if (result.exitCode === EXIT_NOT_FOUND) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端路径不存在。");
		if (result.exitCode !== 0) fail(ErrorCodes.REMOTE_NOT_READABLE, "远端文件不可读（权限不足）。");
		return decodeBase64Sample(result.stdout);
	}

	return {
		async readFile(absolutePath: string): Promise<Buffer> {
			const remotePath = requireRemotePath(absolutePath);
			const quoted = shellQuote(remotePath);
			// 目录判断必须排在 -e 之前：`-e` 对目录同样成立，先 cat 会把「是目录」误报成「权限不足」（跨厂商评审备注 1）。
			const result = await runChecked(session, `if [ -d ${quoted} ]; then exit ${EXIT_IS_DIRECTORY}; elif [ -e ${quoted} ]; then LC_ALL=C cat ${quoted}; else exit ${EXIT_NOT_FOUND}; fi`);
			if (result.exitCode === EXIT_NOT_FOUND) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端路径不存在。");
			if (result.exitCode === EXIT_IS_DIRECTORY) fail(ErrorCodes.REMOTE_NOT_READABLE, "远端路径是目录，无法按文件读取。");
			if (result.exitCode !== 0) fail(ErrorCodes.REMOTE_NOT_READABLE, "远端文件不可读（权限不足）。");
			return result.stdout;
		},
		/** 可读性检查 + 顺带取回图片嗅探样本（同一条 ssh）。 */
		async access(absolutePath: string): Promise<void> {
			const remotePath = requireRemotePath(absolutePath);
			sample = { remotePath, bytes: await probe(remotePath) };
		},
		/**
		 * 宿主 read 只在提供该端口时才走图片管线（read.js 的 `ops.detectImageMimeType ? … : undefined`），
		 * 没有它就是「PNG 当文本读」。样本已由 access 取回时不触网；否则补一条嗅探命令（不应发生）。
		 */
		async detectImageMimeType(absolutePath: string): Promise<string | null> {
			const remotePath = requireRemotePath(absolutePath);
			if (sample?.remotePath !== remotePath) sample = { remotePath, bytes: await probe(remotePath) };
			return detectMimeFromSample(sample.bytes);
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

export interface RemoteLsOperations extends LsOperations {
	/**
	 * fail-closed 目录探针（remote-tools#10）：远端 ls 在**进宿主校验之前**调用。
	 * 不存在报 REMOTE_NOT_FOUND、存在但不是目录报 REMOTE_NOT_DIRECTORY，错误消息全静态
	 * （宿主自己的 ls.js 会把宿主标记路径插进错误文本回灌给模型）。答案同时缓存给随后的
	 * `exists`/`stat` ⇒ 宿主三次调用变一次 ssh（探针 1 次 + readdir 1 次）。
	 */
	probeDirectory(absolutePath: string): Promise<void>;
}

export function createRemoteLsOps(session: RemoteSession): RemoteLsOperations {
	// 宿主 ls 会先 readdir、再对**每一条** entry 调 stat（dist/core/tools/ls.js），
	// 直接实现 stat 就是 N+1 次 ssh 往返（无 ControlMaster 时每轮都是完整握手）。
	// 所以 readdir 用 `ls -A1p`（目录带尾斜杠）一次性把类型拿回来，缓存给随后的 stat 用，0 额外往返。
	const entryTypes = new Map<string, boolean>();
	// 目录探针答过的路径：宿主随后的 exists/stat 直接命中，不额外 ssh（探针只缓存「是目录」这一种答案）。
	const probedDirectories = new Set<string>();
	return {
		async probeDirectory(absolutePath: string): Promise<void> {
			const remotePath = requireRemotePath(absolutePath);
			const kind = await probePathKind(session, remotePath);
			if (kind === null) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端路径不存在。");
			if (kind === "file") fail(ErrorCodes.REMOTE_NOT_DIRECTORY, "远端路径存在但不是目录。");
			probedDirectories.add(remotePath);
		},
		async exists(absolutePath: string): Promise<boolean> {
			const remotePath = requireRemotePath(absolutePath);
			if (probedDirectories.has(remotePath)) return true;
			const result = await runChecked(session, `test -e ${shellQuote(remotePath)}`);
			return result.exitCode === 0;
		},
		async stat(absolutePath: string): Promise<{ isDirectory: () => boolean }> {
			const remotePath = requireRemotePath(absolutePath);
			if (probedDirectories.has(remotePath)) return { isDirectory: () => true };
			const cached = entryTypes.get(remotePath);
			if (cached !== undefined) return { isDirectory: () => cached };
			const kind = await probePathKind(session, remotePath);
			if (kind === null) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端路径不存在。");
			return { isDirectory: () => kind === "directory" };
		},
		async readdir(absolutePath: string): Promise<string[]> {
			const remotePath = requireRemotePath(absolutePath);
			const result = await runChecked(session, `ls -A1p ${shellQuote(remotePath)}`);
			if (result.exitCode === 2) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端目录不存在。");
			if (result.exitCode !== 0) fail(ErrorCodes.REMOTE_NOT_READABLE, "远端目录不可读（权限不足）。");
			const raw = lines(result.stdout);
			entryTypes.clear();
			for (const entry of raw) {
				const isDirectory = entry.endsWith("/");
				const name = isDirectory ? entry.slice(0, -1) : entry;
				if (name === "") continue;
				entryTypes.set(`${remotePath === "/" ? "" : remotePath}/${name}`, isDirectory);
			}
			return raw.map((entry) => (entry.endsWith("/") ? entry.slice(0, -1) : entry)).filter((name) => name !== "");
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
	/** 同 ls：进宿主校验前的 fail-closed 目录探针，答案缓存给宿主随后的 exists（find 只查 exists）。 */
	probeDirectory(absolutePath: string): Promise<void>;
}

export function createRemoteFindOps(session: RemoteSession): RemoteFindOperations {
	const probedDirectories = new Set<string>();
	return {
		async probeDirectory(absolutePath: string): Promise<void> {
			const remotePath = requireRemotePath(absolutePath);
			const kind = await probePathKind(session, remotePath);
			if (kind === null) fail(ErrorCodes.REMOTE_NOT_FOUND, "远端路径不存在。");
			if (kind === "file") fail(ErrorCodes.REMOTE_NOT_DIRECTORY, "远端路径存在但不是目录。");
			probedDirectories.add(remotePath);
		},
		async exists(absolutePath: string): Promise<boolean> {
			const remotePath = requireRemotePath(absolutePath);
			if (probedDirectories.has(remotePath)) return true;
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

/** bash 执行选项（与宿主 `BashOperations.exec` 的第三参同形）。 */
type BashExecOptions = { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv };

/** 远端 job 托管依赖（remote-tools#12）：没有它时远端 bash 与今天逐字一致。 */
export interface RemoteBashJobDeps {
	/** job 托管端口（懒索取；null = 没装 timeout-bg，远端超时沿用宿主 kill 语义）。 */
	jobHost: () => RemoteJobPort | null;
	/** 转后台不可用/失败时的可见性通知（异常隔离由调用方保证）。 */
	notify?: ((message: string) => void) | undefined;
	/**
	 * 本次调用是否要求「直接转后台」（remote-tools#19，参数 `run_in_background`）。
	 * 为真时必须拿得到带 `registerBackground` 的托管端口，否则 fail-closed
	 * （`REMOTE_BACKGROUND_UNSUPPORTED`）——静默按前台跑等于把「让路」吞掉。
	 */
	runInBackground?: boolean | undefined;
}

/** 远端超时结果里附带的最近输出上限（字符；与 timeout-bg 本地口径一致）。 */
export const REMOTE_TIMEOUT_TAIL_CHARS = 2000;

/** 远端 pid 文件前缀：/tmp + 随机名（不需解析远端 $HOME，也无法被预置符号链接命中）。 */
export const REMOTE_PID_FILE_PREFIX = "/tmp/pi-remote-job-";

/** /bg:kill 的远端终止命令超时（尽力而为，不阻断命令面交互）。 */
export const REMOTE_KILL_TIMEOUT_MS = 15_000;

/** 转后台失败的静态文案（notify 用；tool error 另加错误码前缀）。 */
export const REMOTE_BACKGROUND_FAILED = "远端超时转后台失败：已断开本地 ssh（远端命令可能仍在运行）。";

/** 同上，但归因是「主动要求的后台」而不是超时（timeout-bg-todo#5 / remote-tools#19）。 */
export const REMOTE_BACKGROUND_REQUEST_FAILED = "远端直接转后台失败：已断开本地 ssh（远端命令可能仍在运行）。";

/**
 * 显式 timeout 的校验：与宿主 `resolveTimeoutMs` 同一句文案（托管路径下计时器在本地，
 * 宿主的计时逻辑够不着这里，校验得自己做）。
 */
function resolveRemoteTimeoutMs(seconds: number | undefined): number | undefined {
	if (seconds === undefined) return undefined;
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
	return seconds * 1000;
}

/**
 * 远端命令前缀：把登录 shell 的 pid 写进 pid 文件供 `/bg:kill` 定位远端进程组，
 * 并留一个 EXIT trap 在正常结束时清掉（不额外花一次 ssh）。
 * 多个前置命令还顺带挡住 shell 的「最后一条命令直接 exec」优化 ⇒ `$$` 一定是命令的父 shell。
 */
export function buildRemotePidFilePrologue(pidFile: string): string {
	const quoted = shellQuote(pidFile);
	const cleanup = `rm -f "$pi_remote_job_pidfile"`;
	return [
		`pi_remote_job_pidfile=${quoted}`,
		`printf '%s\\n' "$$" > "$pi_remote_job_pidfile" 2>/dev/null || true`,
		// TERM/HUP **必须显式 exit**：只挂一个清理 trap 会让 shell 吞掉信号、继续跑下一条命令。
		// 真机验收抓到过：`sleep 987654; printf ALIVE > marker` 在 /bg:kill 之后仍然写出了标记文件。
		`trap '${cleanup}; exit 143' TERM`,
		`trap '${cleanup}; exit 129' HUP`,
		`trap '${cleanup}' EXIT`,
	].join("; ");
}

/**
 * `/bg:kill` 的远端终止脚本：pid 文件 → 进程组（仅在 shell 是组长时）/ 直接子进程 / 本体，
 * TERM → KILL，最后清掉 pid 文件。全部 `|| true`：尽力而为，单步失败不阻断后续步骤。
 */
export function buildRemoteKillCommand(pidFile: string): string {
	const quoted = shellQuote(pidFile);
	return [
		`pid=$(cat ${quoted} 2>/dev/null) || exit 0`,
		`pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')`,
		`if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi`,
		`pkill -TERM -P "$pid" 2>/dev/null || true`,
		`kill -TERM "$pid" 2>/dev/null || true`,
		`sleep 1`,
		`if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then kill -KILL -- "-$pid" 2>/dev/null || true; fi`,
		`pkill -KILL -P "$pid" 2>/dev/null || true`,
		`kill -KILL "$pid" 2>/dev/null || true`,
		`rm -f ${quoted}`,
	].join("; ");
}

/** 后台日志落盘（超时那一刻之前的输出也在里面）；建不出文件时返回 null，调用方回退旧路径。 */
function openJobLog(logPath: string): WriteStream | null {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		const stream = createWriteStream(logPath, { flags: "a" });
		// 写盘失败（磁盘满 / 权限）只让日志变不完整，绝不能变成未捕获的 'error' 事件把会话炸掉。
		stream.on("error", () => undefined);
		return stream;
	} catch {
		return null;
	}
}

/** 后台任务结束时应记的退出码：传输层中断记「未知」（不把 ssh 的 255 当成命令退出码）。 */
function jobExitCode(result: SshExecResult): number | null {
	return classifySshFailure(result) === null ? result.exitCode : null;
}

/** 尽力终止远端 job：新开一条 ssh 读 pid 文件杀进程组；失败就只剩「断开本地 ssh」兜底。 */
async function killRemoteJob(session: RemoteSession, pidFile: string): Promise<void> {
	try {
		await runSsh(session.exec, session.target, buildRemoteKillCommand(pidFile), { timeoutMs: REMOTE_KILL_TIMEOUT_MS });
	} catch {
		/* 尽力而为：杀不掉不影响后续断开本地 ssh */
	}
}

/**
 * bash 的远端执行接缝。
 *
 * 三条路径：
 *   - **旧路径**（没有 job 托管端口，即只装了 remote-tools）：超时交给传输层杀 ssh，
 *     与宿主同文案 `timeout:<秒>`——行为与今天逐字一致。
 *   - **托管路径**（与 timeout-bg 组合）：自己计时，命中超时**不断连**——本地继续持有同一 ssh、
 *     输出继续写 job 日志，命令登记进统一 job 面（/bg:kill 走 pid 文件杀远端进程组）；
 *     本次 tool call 以超时结果文本结束，跑完由 owner 发完成通知。
 *   - **主动后台**（remote-tools#19）：`run_in_background: true` 时不等超时，ssh 一启动就登记 job，
 *     工具本次调用立刻结束；拿不到托管端口就 fail-closed（不走旧路径）。
 */
export function createRemoteBashOps(session: RemoteSession, jobDeps?: RemoteBashJobDeps): BashOperations {
	/** 旧路径：传输层 timeout → `timeout:<秒>`，宿主 bash 会渲染成原生超时文案。 */
	async function execLegacy(command: string, remoteCwd: string, { onData, signal, timeout, env }: BashExecOptions): Promise<{ exitCode: number }> {
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
	}

	/** 托管路径：超时不断连，转后台 + 登记 job；主动后台时不等超时、启动即登记。 */
	async function execHosted(command: string, remoteCwd: string, options: BashExecOptions, host: RemoteJobPort): Promise<{ exitCode: number }> {
		const { onData, signal, timeout, env } = options;
		const backgroundNow = jobDeps?.runInBackground === true;
		// 显式 timeout 仍然校验（非法值不静默吞掉）；主动后台只是**不装计时器**。
		const requestedTimeoutMs = timeout === undefined ? undefined : resolveRemoteTimeoutMs(timeout);
		const timeoutMs = backgroundNow ? undefined : requestedTimeoutMs;
		const ticket = host.allocate();
		const logStream = openJobLog(ticket.logPath);
		if (logStream === null) {
			// 主动后台不能退回旧路径：那会变成前台等待，用户要的「让路」被默默吞掉 ⇒ fail-closed。
			if (backgroundNow) {
				fail(ErrorCodes.REMOTE_BACKGROUND_UNSUPPORTED, "远端直接转后台失败：无法创建后台日志，已拒绝执行（未前台等待）。");
			}
			jobDeps?.notify?.(`无法创建远端后台日志（${ticket.logPath}）：本次远端调用按原有超时语义执行。`);
			return execLegacy(command, remoteCwd, options);
		}

		const controller = new AbortController();
		const onAbort = () => controller.abort();
		// 开日志流是有开销的：期间被 abort 就不要再 spawn（abort 后再挂监听器不会再触发）。
		if (signal?.aborted === true) {
			logStream.end();
			throw new Error("aborted");
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		const detachAbort = () => signal?.removeEventListener("abort", onAbort);

		const pidFile = `${REMOTE_PID_FILE_PREFIX}${randomUUID()}.pid`;
		const remoteCommand = `cd ${shellQuote(remoteCwd)} || exit ${EXIT_CWD_MISSING}; ${buildRemotePidFilePrologue(pidFile)}; ${formatEnvPrefix(env)}${command}`;

		let backgrounded = false;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let recentTail = "";

		const running = session.exec({
			file: "ssh",
			args: buildSshArgs(session.target, remoteCommand),
			stdin: undefined,
			// 自己计时：托管语义要求「超时不断连」，所以不能把 timeout 交给传输层去杀 ssh。
			timeoutMs: undefined,
			signal: controller.signal,
			onData: (chunk) => {
				// 内存里保留尾部：超时那一刻日志流可能还没 flush，结果文本不能等 IO（与本地同口径）。
				recentTail = (recentTail + chunk.toString("utf8")).slice(-REMOTE_TIMEOUT_TAIL_CHARS);
				logStream.write(chunk);
				if (!backgrounded) onData(chunk);
			},
		});

		return await new Promise<{ exitCode: number }>((resolve, reject) => {
			const settleOnce = (finish: () => void): void => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				detachAbort();
				finish();
			};

			/**
			 * 转后台登记（超时与主动后台共用）：登记给 owner，本次 tool call 以 owner 返回的文本结束。
			 * 登记失败一律 fail-closed：复位 backgrounded（ssh 退出时不再对未登记的 id settle）、
			 * 断开 ssh 并 notify 一次。
			 */
			const registerJob = (registration: { reason: "timeout"; timeoutSeconds: number } | { reason: "background" }): void => {
				backgrounded = true;
				// 本次 tool call 到此结束：之后的外部 abort（Esc）不再波及后台任务（与本地一致）。
				detachAbort();
				let text: string;
				try {
					const payload = {
						id: ticket.id,
						logPath: ticket.logPath,
						command,
						target: formatTarget(session.target),
						tail: recentTail,
						terminate: () => {
							// 先尽力杀远端进程组，再断开本地 ssh（失败时的退化路径）。
							void killRemoteJob(session, pidFile);
							controller.abort();
						},
					};
					if (registration.reason === "timeout") {
						text = host.register({ ...payload, timeoutSeconds: registration.timeoutSeconds });
					} else {
						// 探测不到新方法就不登记（调用入口已挡，这里只是类型收窄 + 双保险）。
						if (typeof host.registerBackground !== "function") {
							throw new Error(`${ErrorCodes.REMOTE_BACKGROUND_UNSUPPORTED}: job 托管端口缺 registerBackground。`);
						}
						text = host.registerBackground(payload);
					}
				} catch (error) {
					// 登记失败：本次 tool call 已结束（backgrounded 复位，ssh 退出时不再对未登记的 id settle）。
					backgrounded = false;
					controller.abort();
					jobDeps?.notify?.(registration.reason === "background" ? REMOTE_BACKGROUND_REQUEST_FAILED : REMOTE_BACKGROUND_FAILED);
					// 错误自己带了错误码（端口形状 / 能力不支持）时原样保留，不把归因吞掉。
					const own =
						error instanceof Error &&
						(error.message.includes(ErrorCodes.REMOTE_JOB_PORT_INVALID) || error.message.includes(ErrorCodes.REMOTE_BACKGROUND_UNSUPPORTED));
					const message = own ? (error as Error).message : `${ErrorCodes.REMOTE_BACKGROUND_FAILED}: ${REMOTE_BACKGROUND_FAILED}`;
					settleOnce(() => reject(new Error(message)));
					return;
				}
				settleOnce(() => reject(new Error(text)));
			};

			running.then(
				(result) => {
					// 日志先落盘再收尾：通知/结果不能读到半截日志（与本地同口径）。
					logStream.end(() => {
						try {
							if (backgrounded) {
								host.settle(ticket.id, jobExitCode(result));
								return;
							}
							const transport = classifySshFailure(result);
							if (transport !== null) return settleOnce(() => reject(new Error(describeFailure(transport))));
							if (result.aborted === true || controller.signal.aborted) return settleOnce(() => reject(new Error("aborted")));
							if (result.exitCode === EXIT_CWD_MISSING) {
								return settleOnce(() => reject(new Error(`${ErrorCodes.REMOTE_NOT_FOUND}: 不存在的远端目录：请先确认远端工作目录路径。`)));
							}
							const exitCode = result.exitCode;
							if (exitCode === null) {
								return settleOnce(() => reject(new Error(`${ErrorCodes.SSH_CONNECT_FAILED}: ssh 连接在命令执行期间中断。`)));
							}
							settleOnce(() => resolve({ exitCode }));
						} catch {
							/* 收尾观察者异常不破坏会话 */
						}
					});
				},
				(error: unknown) => {
					logStream.end();
					// 已转后台时本次 tool call 早已结束（settleOnce 是 no-op）：必须收口，
					// 否则 job 停在 running。生产传送层（createSpawnExec）不会 reject，这是与本地同型的防御。
					if (backgrounded) {
						try {
							host.settle(ticket.id, null);
						} catch {
							/* 收尾观察者异常不破坏会话 */
						}
						return;
					}
					settleOnce(() => reject(error instanceof Error ? error : new Error(String(error))));
				},
			);

			if (backgroundNow) {
				registerJob({ reason: "background" });
				return;
			}

			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					if (settled || backgrounded) return;
					registerJob({ reason: "timeout", timeoutSeconds: timeoutMs / 1000 });
				}, timeoutMs);
			}
		});
	}

	/**
	 * 主动后台入口（remote-tools#19）：spawn **之前**就把「有没有托管能力」判掉——
	 * 拿不到端口 / 端口是旧版（没有 registerBackground）都 fail-closed，绝不静默退回旧路径
	 *（那是前台等待，用户要的让路会被吞掉；也不在本机跑远端意图的命令）。
	 */
	async function execBackground(
		command: string,
		remoteCwd: string,
		options: BashExecOptions,
		host: RemoteJobPort | null,
	): Promise<{ exitCode: number }> {
		if (host === null) {
			fail(ErrorCodes.REMOTE_BACKGROUND_UNSUPPORTED, "远端直接转后台需要 timeout-bg（未取到 job 托管端口）：已拒绝执行。");
		}
		if (typeof host.registerBackground !== "function") {
			fail(ErrorCodes.REMOTE_BACKGROUND_UNSUPPORTED, "timeout-bg 版本不支持远端直接转后台（托管端口缺 registerBackground）：已拒绝执行。");
		}
		return execHosted(command, remoteCwd, options, host);
	}

	return {
		async exec(command, cwd, options): Promise<{ exitCode: number }> {
			const remoteCwd = requireRemotePath(cwd);
			if (options.signal?.aborted === true) throw new Error("aborted");
			const host = jobDeps === undefined ? null : jobDeps.jobHost();
			if (jobDeps?.runInBackground === true) return execBackground(command, remoteCwd, options, host);
			if (host === null) return execLegacy(command, remoteCwd, options);
			return execHosted(command, remoteCwd, options, host);
		},
	};
}
