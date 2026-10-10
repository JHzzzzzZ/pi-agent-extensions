/*
 * remote-tools — 本地宿主路径空间 ↔ 远端 POSIX 路径空间的换算。
 *
 * 为什么需要这层：内置工具在**本地**用 node:path 解析路径，Windows 上会把远端 POSIX 路径改写掉：
 *   - `normalizeWindowsShellPath` 会把首段是单个字母的路径当 Git-Bash 盘符（"/s/x" → "S:\x"）；
 *   - `path.resolve` 会给其余绝对路径注入进程盘符（"/srv" → "C:\srv"），单段路径尤其明显。
 *
 * 解法：交给内置工具的路径一律带 `//pi-remote` 前缀（三个以上路径段的 UNC 形态，命中
 * normalizeWindowsShellPath 的「已是 UNC」早退分支，既不注入盘符也不动大小写），
 * 工具执行完由 ops 层用 toRemotePath 剥掉标记还原。副产物是防线更硬：
 * **没有这个标记的路径一律不是「宿主解析过」的路径**，模型自己给的 "C:/x" 或相对路径
 * 会在 toRemotePath 里原样返回，再由 validateRemotePath 拒绝（fail-closed）。
 */

/** 宿主侧路径标记：保证 Windows 上 `path.resolve` 走 UNC 分支、原样保留。 */
export const HOST_PATH_MARKER = "/pi-remote";

/**
 * 根目录的占位段：Windows 上「`//` 后只有一个路径段」不构成 UNC（实测 "//pi-remote/" →
 * "C:\\pi-remote"，仍会被注入盘符），所以远端 "/" 用一段占位补齐到两段，还原时再去掉。
 */
const ROOT_SEGMENT = "__root__";

/** 远端 POSIX 绝对路径 → 交给宿主 path 解析时用的形态。 */
export function toHostPath(remotePath: string): string {
	const stripped = stripHostMarker(remotePath);
	const remote = stripped.startsWith("/") ? stripped : `/${stripped}`;
	const body = remote === "/" ? `/${ROOT_SEGMENT}` : remote;
	return `//${HOST_PATH_MARKER.slice(1)}${body}`;
}

/** 剥掉宿主标记（顺带把反斜杠与重复斜杠归一），便于比较与调试；没有标记时按原样归一返回。 */
export function stripHostMarker(hostPath: string): string {
	const collapsed = hostPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	return collapsed.startsWith(`${HOST_PATH_MARKER}/`) ? collapsed.slice(HOST_PATH_MARKER.length) : collapsed;
}

/** 宿主 path 解析结果 → 远端 POSIX 绝对路径；没有宿主标记的形态原样返回（由调用方校验后拒绝）。 */
export function toRemotePath(hostPath: string): string {
	const stripped = stripHostMarker(hostPath);
	if (!stripped.startsWith("/")) return stripped;
	const withoutRootSegment = stripped.replace(new RegExp(`^/${ROOT_SEGMENT}(?=/|$)`), "");
	const trimmed = withoutRootSegment.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}
