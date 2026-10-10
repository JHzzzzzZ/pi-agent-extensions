/*
 * remote-tools — 本地宿主路径空间 ↔ 远端 POSIX 路径空间的换算。
 *
 * 为什么需要这层：内置工具在**本地**用 node:path / node:fs 处理路径，Windows 上会把远端路径改写掉：
 *   - `normalizeWindowsShellPath` 会把首段是单个字母的路径当 Git-Bash 盘符（"/s/x" → "S:\x"）；
 *   - `path.resolve` 会给绝对路径注入进程盘符（"/srv" → "C:\srv"，单段 "//srv" 也退化）；
 *   - `withFileMutationQueue`（write/edit 用）在**本地**做 `fs.realpath`，而 UNC 形态
 *     "\\\\pi-remote\\…" 在 Windows 上抛 `UNKNOWN: unknown error`（只容忍 ENOENT/ENOTDIR）⇒ write/edit 直接失败。
 *
 * 所以宿主形态是**平台相关**的，两条不变式同时满足：
 *   1. 本地 `path.resolve` 不改写它（Windows：带盘符的 `C:\pi-remote\…`；POSIX：`//pi-remote/…`）；
 *   2. 本地 `realpath` 以 ENOENT 失败（Windows 上不能用 UNC，否则错误码是 UNKNOWN）。
 * 标记 `pi-remote` 同时是「这条路径经过宿主解析」的凭证：模型自己给的 `C:/…`、相对路径没有标记，
 * ops 层原样返回、由 validateRemotePath 拒绝（fail-closed）。
 */

import path from "node:path";

/** 宿主侧路径标记：既避免平台改写，又标明「这来自宿主解析」。 */
export const HOST_PATH_MARKER = "pi-remote";

/**
 * 根目录的占位段：Windows 上「`//` 后只有一个路径段」不构成 UNC（实测 "//pi-remote/" → "C:\\pi-remote"），
 * POSIX 形态下补齐到两段；还原时再去掉。（Windows 用盘符形态，本身不需要占位，保留以统一往返口径。）
 */
const ROOT_SEGMENT = "__root__";

/** 宿主盘符（Windows 专用）：取当前工作目录所在盘，避免硬编码 "C:"。 */
function hostDrive(): string {
	const root = path.parse(process.cwd()).root.replace(/[\\/]+$/, "");
	return /^[A-Za-z]:$/.test(root) ? root : "C:";
}

/** 远端 POSIX 绝对路径 → 交给宿主 path/fs 解析时用的形态。 */
export function toHostPath(remotePath: string): string {
	const stripped = stripHostMarker(remotePath);
	const remote = stripped.startsWith("/") ? stripped : `/${stripped}`;
	const body = remote === "/" ? `/${ROOT_SEGMENT}` : remote;
	if (process.platform === "win32") {
		return `${hostDrive()}\\${HOST_PATH_MARKER}${body.replace(/\//g, "\\")}`;
	}
	return `//${HOST_PATH_MARKER}${body}`;
}

/** 剥掉宿主标记（顺带归一反斜杠与重复斜杠）；没有标记时按原样归一返回。 */
export function stripHostMarker(hostPath: string): string {
	const slashed = hostPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	if (slashed === `/${HOST_PATH_MARKER}`) return "/";
	if (slashed.startsWith(`/${HOST_PATH_MARKER}/`)) return slashed.slice(HOST_PATH_MARKER.length + 1);
	const driveMarked = new RegExp(`^[A-Za-z]:/${HOST_PATH_MARKER}(/|$)`).exec(slashed);
	if (driveMarked !== null) {
		const rest = slashed.slice(driveMarked[0].length - 1);
		return rest === "" ? "/" : rest;
	}
	return slashed;
}

/** 宿主 path 解析结果 → 远端 POSIX 绝对路径；没有宿主标记的形态原样返回（由调用方校验后拒绝）。 */
export function toRemotePath(hostPath: string): string {
	const stripped = stripHostMarker(hostPath);
	if (!stripped.startsWith("/")) return stripped;
	const withoutRootSegment = stripped.replace(new RegExp(`^/${ROOT_SEGMENT}(?=/|$)`), "");
	const trimmed = withoutRootSegment.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}
