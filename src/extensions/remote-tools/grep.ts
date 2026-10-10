/*
 * remote-tools — 远程 grep：内置 grep 的 GrepOperations 接缝只覆盖 isDirectory/readFile
 * （真正的搜索由宿主本地 spawn ripgrep，见 dist/core/tools/grep.js），因此这里整份重写，
 * 但**输出形态、限流与截断语义对齐内置实现**：
 *   - 匹配行 `${相对路径}:${行号}: ${文本}`，上下文行 `${相对路径}-${行号}- ${文本}`；
 *   - 长行按 GREP_MAX_LINE_LENGTH 截断、整体按 DEFAULT_MAX_BYTES 截断，`[notices]` 尾部提示；
 *   - `limit` 命中给出 `N matches limit reached...` 提示（与内置同文案）。
 * 远端优先 ripgrep，缺 rg 时**同一次往返内**回退 GNU grep 并在结果里标注降级。
 */

import path from "node:path";

import {
	DEFAULT_MAX_BYTES,
	type GrepToolDetails,
	formatSize,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ErrorCodes, type RemoteToolsErrorCode } from "./errors.ts";
import { DEGRADED_MARKER, type RemoteSession, createRemoteLsOps } from "./ops.ts";
import { assertModelPathInput } from "./paths.ts";
import { runSsh, shellQuote, validateRemotePath } from "./ssh.ts";

const DEFAULT_LIMIT = 100;
/** 与宿主 dist/core/tools/truncate.js 的 GREP_MAX_LINE_LENGTH 对齐（该常量未从包根导出）。 */
const GREP_MAX_LINE_LENGTH = 500;

export const remoteGrepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "远端目录或文件（省略 = 远端 $HOME）" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
	context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
	limit: Type.Optional(Type.Number({ description: `Maximum number of matches to return (default: ${DEFAULT_LIMIT})` })),
});

export type RemoteGrepParams = {
	pattern: string;
	path?: string | undefined;
	glob?: string | undefined;
	ignoreCase?: boolean | undefined;
	literal?: boolean | undefined;
	context?: number | undefined;
	limit?: number | undefined;
};

export type RipgrepEvent =
	| { kind: "match"; filePath: string; lineNumber: number; lineText: string | undefined }
	| { kind: "context"; filePath: string; lineNumber: number; lineText: string | undefined };

/**
 * 解析 `rg --json` 的一行行事件（坏行忽略——rg 可能夹带非 JSON 诊断）。
 */
export function parseRipgrepEvents(stdout: string): RipgrepEvent[] {
	const events: RipgrepEvent[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const event = parsed as { type?: unknown; data?: { path?: { text?: unknown }; line_number?: unknown; lines?: { text?: unknown } } };
		if (event.type !== "match" && event.type !== "context") continue;
		const filePath = event.data?.path?.text;
		const lineNumber = event.data?.line_number;
		if (typeof filePath !== "string" || typeof lineNumber !== "number") continue;
		const lineText = event.data?.lines?.text;
		events.push({
			kind: event.type,
			filePath,
			lineNumber,
			lineText: typeof lineText === "string" ? lineText : undefined,
		});
	}
	return events;
}

function sanitizeLine(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
}

/** 与内置 grep/read 的相对路径口径一致：目录内相对、目录外或文件搜索退回文件名（POSIX 分隔符）。 */
export function relativizeRemotePath(filePath: string, searchPath: string, isDirectory: boolean): string {
	if (isDirectory) {
		const relative = path.posix.relative(searchPath, filePath);
		if (relative !== "" && !relative.startsWith("..")) return relative;
	}
	return path.posix.basename(filePath);
}

export interface RenderLineResult {
	text: string;
	truncated: boolean;
}

export function formatMatchLine(filePath: string, lineNumber: number, text: string): RenderLineResult {
	const { text: truncated, wasTruncated } = truncateLine(sanitizeLine(text));
	return { text: `${filePath}:${lineNumber}: ${truncated}`, truncated: wasTruncated };
}

export function formatContextLine(filePath: string, lineNumber: number, text: string): RenderLineResult {
	const { text: truncated, wasTruncated } = truncateLine(sanitizeLine(text));
	return { text: `${filePath}-${lineNumber}- ${truncated}`, truncated: wasTruncated };
}

/** 搜索根解析：省略 = 远端 $HOME；绝对 POSIX 路径原样；其余按远端 cwd 相对解析（Windows 盘符形态原样交给上层拒绝）。 */
export function resolveRemoteSearchPath(input: string | undefined, baseDir: string): string {
	if (input === undefined || input.trim() === "") return baseDir;
	const normalized = input.trim().replace(/\\/g, "/");
	if (/^[A-Za-z]:\//.test(normalized)) return normalized;
	if (normalized.startsWith("/")) return normalized.replace(/\/+$/, "") || "/";
	return path.posix.join(baseDir, normalized);
}

/** 截断 + 提示尾注（与内置 grep 的 notices 文案一致）。 */
export function finishGrepOutput(
	lines: string[],
	notices: { matchLimitReached?: number; linesTruncated?: boolean; degraded?: boolean; effectiveLimit: number; extra?: string },
): { text: string; details: GrepToolDetails | undefined } {
	const rawOutput = lines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: GrepToolDetails = {};
	const allNotices: string[] = [];
	if (notices.matchLimitReached !== undefined) {
		allNotices.push(`${notices.matchLimitReached} matches limit reached. Use limit=${notices.matchLimitReached * 2} for more, or refine pattern`);
		details.matchLimitReached = notices.matchLimitReached;
	}
	if (truncation.truncated) {
		allNotices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.linesTruncated === true) {
		allNotices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (notices.degraded === true) {
		allNotices.push("远端缺少 ripgrep，已回退 GNU grep：不遵守 .gitignore，输出格式略有差异");
	}
	if (notices.extra !== undefined) allNotices.push(notices.extra);
	if (allNotices.length > 0) output += `\n\n[${allNotices.join(". ")}]`;
	return { text: output, details: Object.keys(details).length > 0 ? details : undefined };
}

/** 降级输出：GNU grep 的原生 `path:line:text` / `path-line-text` 已经与目标形态同构，只需剥掉搜索根前缀。 */
export function renderDegradedGrepOutput(stdout: string, searchPath: string): string[] {
	const prefix = searchPath.endsWith("/") ? searchPath : `${searchPath}/`;
	return stdout
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
		.filter((line) => line !== "")
		.map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line));
}

export interface RemoteGrepRun {
	stdout: string;
	degraded: boolean;
	exitCode: number | null;
}

/** 构造并执行远端搜索命令：优先 rg --json，缺 rg 时回退 GNU grep（stderr 上打降级标记）。 */
export async function runRemoteGrep(
	session: RemoteSession,
	params: RemoteGrepParams,
	searchPath: string,
	signal: AbortSignal | undefined,
): Promise<RemoteGrepRun> {
	const contextValue = params.context !== undefined && params.context > 0 ? Math.floor(params.context) : 0;
	const rgArgs = ["--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase === true) rgArgs.push("--ignore-case");
	if (params.literal === true) rgArgs.push("--fixed-strings");
	if (params.glob !== undefined && params.glob !== "") rgArgs.push("--glob", params.glob);
	rgArgs.push("--", params.pattern, searchPath);

	const grepArgs = ["-rn", "--color=never"];
	if (params.ignoreCase === true) grepArgs.push("-i");
	if (params.literal === true) grepArgs.push("-F");
	if (contextValue > 0) grepArgs.push("-C", String(contextValue));
	if (params.glob !== undefined && params.glob !== "") grepArgs.push(`--include=${params.glob}`);
	grepArgs.push("--", params.pattern, searchPath);

	const command = [
		`if command -v rg >/dev/null 2>&1; then rg ${rgArgs.map(shellQuote).join(" ")};`,
		`else printf '%s\\n' ${shellQuote(DEGRADED_MARKER)} >&2; grep ${grepArgs.map(shellQuote).join(" ")}; fi`,
	].join(" ");

	const result = await runSsh(session.exec, session.target, command, { signal, timeoutMs: 60_000 });
	if (result.spawnFailed || result.timedOut) {
		throw new Error(`${result.timedOut ? ErrorCodes.SSH_TIMEOUT : ErrorCodes.SSH_CONNECT_FAILED}: ssh 调用失败（grep）。`);
	}
	if (result.exitCode === 255) {
		throw new Error(`${ErrorCodes.SSH_CONNECT_FAILED}: ssh 连接失败（grep）。`);
	}
	const degraded = result.stderr.includes(DEGRADED_MARKER);
	if (result.exitCode !== 0 && result.exitCode !== 1 && !degraded) {
		throw new Error(`${ErrorCodes.REMOTE_COMMAND_FAILED}: 远端搜索命令失败（ripgrep/grep 返回非零退出码）。`);
	}
	return { stdout: result.stdout.toString("utf8"), degraded, exitCode: result.exitCode };
}

export interface RemoteGrepDeps {
	session: RemoteSession;
	/** 省略 path 时的远端搜索根（远端 $HOME）。 */
	baseDir: string;
	/** 读远端文件取上下文行（默认用 session 的 read ops；测试可注入）。 */
	readRemoteFile?: ((remotePath: string) => Promise<Buffer>) | undefined;
}

function failGrep(code: RemoteToolsErrorCode, message: string): never {
	throw new Error(`${code}: ${message}`);
}

/** 远程 grep 的完整定义（工具名仍是 `grep`，远程分支由 tools.ts 分派进来）。 */
export function executeRemoteGrep(deps: RemoteGrepDeps, params: RemoteGrepParams, signal: AbortSignal | undefined) {
	return (async () => {
		if (params.path !== undefined) assertModelPathInput(params.path);
		const searchPath = resolveRemoteSearchPath(params.path, deps.baseDir);
		const checked = validateRemotePath(searchPath);
		if (!checked.ok) failGrep(checked.code, checked.message);

		let isDirectory: boolean;
		try {
			isDirectory = (await createRemoteLsOps(deps.session).stat(searchPath)).isDirectory();
		} catch {
			failGrep(ErrorCodes.REMOTE_NOT_FOUND, "远端搜索路径不存在或不可访问。");
		}

		const contextValue = params.context !== undefined && params.context > 0 ? Math.floor(params.context) : 0;
		const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_LIMIT);
		const run = await runRemoteGrep(deps.session, params, searchPath, signal);

		if (run.degraded) {
			const output = renderDegradedGrepOutput(run.stdout, searchPath);
			if (output.length === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
			const { text, details } = finishGrepOutput(output, { degraded: true, effectiveLimit });
			return { content: [{ type: "text" as const, text }], details };
		}

		const events = parseRipgrepEvents(run.stdout);
		const matches = events.filter((event) => event.kind === "match");
		if (matches.length === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };

		const readRemoteFile = deps.readRemoteFile ?? defaultRemoteFileReader(deps.session);
		const fileCache = new Map<string, string[]>();
		const getFileLines = async (filePath: string): Promise<string[]> => {
			const cached = fileCache.get(filePath);
			if (cached !== undefined) return cached;
			let lines: string[] = [];
			try {
				const content = await readRemoteFile(filePath);
				lines = content.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			} catch {
				lines = [];
			}
			fileCache.set(filePath, lines);
			return lines;
		};

		const outputLines: string[] = [];
		let linesTruncated = false;
		let matchCount = 0;
		for (const event of events) {
			if (event.kind === "match" && matchCount >= effectiveLimit) break;
			if (event.kind === "match") matchCount++;
			const displayPath = relativizeRemotePath(event.filePath, searchPath, isDirectory);

			if (contextValue === 0 && event.lineText !== undefined) {
				const rendered = formatMatchLine(displayPath, event.lineNumber, event.lineText);
				if (rendered.truncated) linesTruncated = true;
				outputLines.push(rendered.text);
				continue;
			}

			const lines = await getFileLines(event.filePath);
			if (lines.length === 0) {
				outputLines.push(`${displayPath}:${event.lineNumber}: (unable to read file)`);
				continue;
			}
			const start = contextValue > 0 ? Math.max(1, event.lineNumber - contextValue) : event.lineNumber;
			const end = contextValue > 0 ? Math.min(lines.length, event.lineNumber + contextValue) : event.lineNumber;
			for (let current = start; current <= end; current++) {
				const lineText = lines[current - 1] ?? "";
				const rendered =
					current === event.lineNumber
						? formatMatchLine(displayPath, current, lineText)
						: formatContextLine(displayPath, current, lineText);
				if (rendered.truncated) linesTruncated = true;
				outputLines.push(rendered.text);
			}
		}

		const matchLimitReached = matchCount >= effectiveLimit ? effectiveLimit : undefined;
		const { text, details } = finishGrepOutput(outputLines, { matchLimitReached, linesTruncated, effectiveLimit });
		return { content: [{ type: "text" as const, text }], details };
	})();
}

function defaultRemoteFileReader(session: RemoteSession): (remotePath: string) => Promise<Buffer> {
	return async (remotePath: string) => {
		const result = await runSsh(session.exec, session.target, `LC_ALL=C cat ${shellQuote(remotePath)}`);
		if (result.exitCode !== 0) throw new Error("read failed");
		return result.stdout;
	};
}
