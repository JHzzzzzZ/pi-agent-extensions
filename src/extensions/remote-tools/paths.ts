/*
 * remote-tools — 本地宿主路径空间 ↔ 远端 POSIX 路径空间的换算。
 *
 * 为什么需要这层：内置工具在**本地**用 node:path / node:fs 处理路径，Windows 上会把远端路径改写掉：
 *   - `normalizeWindowsShellPath` 会把首段是单个字母的路径当 Git-Bash 盘符（"/s/x" → "S:\x"）；
 *   - `path.resolve` 会给绝对路径注入进程盘符（"/srv" → "C:\srv"，单段 "//srv" 也退化）；
 *   - `withFileMutationQueue`（write/edit 用）在**本地**做 `fs.realpath`，而 UNC 形态
 *     "\\\\pi-remote\\…" 在 Windows 上抛 `UNKNOWN: unknown error`（只容忍 ENOENT/ENOTDIR）⇒ write/edit 直接失败；
 *   - `relativizeFindResultPath`（find 用）在本机 path 空间里求相对路径，未标记的远端绝对路径会被算成
 *     "../../../srv/…" 乱码。
 *
 * 所以宿主形态是**平台相关**的，两条不变式同时满足：
 *   1. 本地 `path` 家族不改写它（Windows：带盘符的 `C:\pi-remote\…`；POSIX：`//pi-remote/…`）；
 *   2. 本地 `realpath` 以 ENOENT 失败（Windows 上不能用 UNC，否则错误码是 UNKNOWN）。
 * 标记 `pi-remote` 同时是「这条路径经过宿主解析」的凭证：模型自己给的 `C:/…`、相对路径没有标记，
 * ops 层原样返回、由 validateRemotePath 拒绝（fail-closed）。另外**所有**返回给宿主的远端路径
 * （含 find 的 glob 结果）都必须带标记，否则宿主会用自己的 path 语义把它算成乱码。
 */

import path from "node:path";

import { ErrorCodes } from "./errors.ts";

/** 宿主侧路径标记：既避免平台改写，又标明「这来自宿主解析」。 */
export const HOST_PATH_MARKER = "pi-remote";

/** 宿主盘符（Windows 专用）：取当前工作目录所在盘，避免硬编码 "C:"。 */
function hostDrive(): string {
	const root = path.parse(process.cwd()).root.replace(/[\\/]+$/, "");
	return /^[A-Za-z]:$/.test(root) ? root : "C:";
}

/** 远端 POSIX 绝对路径 → 交给宿主 path/fs 解析时用的形态（纯加前缀；输入当作干净的远端路径）。 */
export function toHostPath(remotePath: string): string {
	const remote = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
	if (process.platform === "win32") {
		return `${hostDrive()}\\${HOST_PATH_MARKER}${remote.replace(/\//g, "\\")}`;
	}
	return `//${HOST_PATH_MARKER}${remote}`;
}

/**
 * 模型给的远端路径输入护栏（在任何 ssh 进程之前跑）：
 *   - 首段不得是宿主标记 `pi-remote`（可能是回灌的宿主形态，也可能撞上真实目录，两种都 fail-closed）；
 *   - 不做 `~` 展开（展开要在远端做，本扩展不加额外往返），拼成 `$HOME/~/x` 是错的，直接拒。
 */
export function assertModelPathInput(input: unknown): void {
	if (typeof input !== "string") return; // 非字符串是 schema 外的噪声 ⇒ 当未提供（与 remotePort 同口径）
	const normalized = input.trim().replace(/\\/g, "/");
	if (normalized.startsWith("~")) {
		throw new Error(`${ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE}: 远端路径不支持 ~ 展开，请写绝对路径。`);
	}
	if (new RegExp(`^([A-Za-z]:)?/*${HOST_PATH_MARKER}(/|$)`).test(normalized)) {
		throw new Error(`${ErrorCodes.REMOTE_PATH_NOT_ABSOLUTE}: 远端路径首段不能是 "${HOST_PATH_MARKER}"（与宿主内部标记冲突），请改用其它路径。`);
	}
}

/** 剥掉宿主标记（顺带归一反斜杠与重复斜杠）；没有标记时按原样归一返回。 */
export function stripHostMarker(hostPath: string): string {
	const slashed = hostPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	if (slashed === `/${HOST_PATH_MARKER}`) return "/";
	if (slashed.startsWith(`/${HOST_PATH_MARKER}/`)) return slashed.slice(HOST_PATH_MARKER.length + 1);
	const driveMarked = new RegExp(`^[A-Za-z]:/${HOST_PATH_MARKER}(?:/(.*))?$`).exec(slashed);
	if (driveMarked !== null) {
		const rest = driveMarked[1] ?? "";
		return rest === "" ? "/" : `/${rest}`;
	}
	return slashed;
}

/** 宿主 path 解析结果 → 远端 POSIX 绝对路径；没有宿主标记的形态原样返回（由调用方校验后拒绝）。 */
export function toRemotePath(hostPath: string): string {
	const stripped = stripHostMarker(hostPath);
	if (!stripped.startsWith("/")) return stripped;
	const trimmed = stripped.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}
