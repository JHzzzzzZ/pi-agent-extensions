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
 * 所以宿主形态必须同时满足：
 *   1. 本地 `path` 家族不改写它（绝对路径，带盘符/根斜杠）；
 *   2. 本地 `path`/`fs` 调用给的是 **missing-path 错误**（`ENOENT` / `ENOTDIR`）：`withFileMutationQueue`
 *      只容忍这两个码，`resolveReadPathAsync` 的变体探测会吞掉一切错误再逐条试变体名。
 * 第 2 条曾经靠一条**不可执行的约定**维持（「本机一定不存在 C:\pi-remote」）：本地真有该目录时，变体探测
 * 会用本地文件命中，把远端读取的文件名换成变体名 ⇒ 静默读错文件（2026-10-10 用户复现）。
 *
 * 现在把它变成**结构性事实**：标记根锚在扩展目录里一个已存在的普通文件下面
 * （`<扩展目录>/index.ts/pi-remote`）——只要锚文件还是普通文件，本机就建不出这个目录
 * （实测 Windows：`mkdir -p` 报 ENOTDIR、`realpath` 报 ENOENT；POSIX 同理 ENOTDIR）。
 * `assertMarkerRootUsable` 是配套的运行时守卫，兜住「锚文件被删/被换成目录」这一种破坏方式。
 *
 * 标记段 `pi-remote` 同时是「这条路径经过宿主解析」的凭证：模型自己给的 `C:/…`、相对路径没有标记，
 * ops 层原样返回、由 validateRemotePath 拒绝（fail-closed）。另外**所有**返回给宿主的远端路径
 * （含 find 的 glob 结果）都必须带标记，否则宿主会用自己的 path 语义把它算成乱码。
 */

import { statSync } from "node:fs";
import path from "node:path";

import { ErrorCodes } from "./errors.ts";

/** 宿主侧路径标记段：既避免平台改写，又标明「这来自宿主解析」。 */
export const HOST_PATH_MARKER = "pi-remote";

/** 标记根锚定的普通文件：扩展入口自己（扩展目录里必然存在，且是文件而不是目录）。 */
const MARKER_ANCHOR_FILE = path.join(import.meta.dirname, "index.ts");

/** 交给宿主 path/fs 解析时用的路径前缀（绝对路径，两平台同一形态）。 */
export const HOST_PATH_ROOT = path.join(MARKER_ANCHOR_FILE, HOST_PATH_MARKER);

/** 归一成可比较形态：统一分隔符、折叠重复斜杠、去掉尾分隔符（Windows 盘符/路径大小写无关，比较时降格）。 */
function normalizeForCompare(value: string): string {
	const slashed = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
	return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * 远端调用前的守卫：锚文件必须仍是普通文件。
 * 它被删掉或被换成目录，标记根在本地就真的可能存在 ⇒ 信道前提被破坏，fail-closed 报专码。
 * 本地分支不调用它（不产生额外 fs 操作）。anchorFile 参数是测试接缝，生产用默认值。
 */
export function assertMarkerRootUsable(anchorFile: string = MARKER_ANCHOR_FILE): void {
	let isFile = false;
	try {
		isFile = statSync(anchorFile).isFile();
	} catch {
		isFile = false;
	}
	if (!isFile) {
		throw new Error(`${ErrorCodes.HOST_MARKER_CONFLICT}: 宿主标记锚文件缺失或被替换，远端路径信道不可用；请恢复或重装 remote-tools 扩展。`);
	}
}

/** 远端 POSIX 绝对路径 → 交给宿主 path/fs 解析时用的形态（纯加前缀；输入当作干净的远端路径）。 */
export function toHostPath(remotePath: string): string {
	const remote = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
	return HOST_PATH_ROOT + (process.platform === "win32" ? remote.replace(/\//g, "\\") : remote);
}

/**
 * 缺省值字面量：模型/序列化器把 JSON 的 null/undefined 写成字符串的常见产物（用户实测：`remote: "null"`
 * 被当主机名去 ssh）。这些词与「未提供」同义，大小写无关、trim 后比较。
 * 刻意**不含** `local` / `false` / `true` / `-`：`local` 是常见 `~/.ssh/config` 别名，把它当本机会静默跑错机器。
 */
export const ABSENCE_LITERALS: ReadonlySet<string> = new Set(["null", "undefined", "nil", "none", "n/a", "na"]);

/** 字符串是不是缺省值字面量（非字符串返回 false）。 */
export function isAbsenceLiteral(value: unknown): boolean {
	return typeof value === "string" && ABSENCE_LITERALS.has(value.trim().toLowerCase());
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

/** 剥掉宿主标记根前缀（归一反斜杠与重复斜杠）；没有标记时按原样归一返回。 */
export function stripHostMarker(hostPath: string): string {
	const slashed = hostPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	const root = normalizeForCompare(HOST_PATH_ROOT);
	const head = slashed.slice(0, root.length);
	const matched = process.platform === "win32" ? head.toLowerCase() === root : head === root;
	if (!matched) return slashed;
	const rest = slashed.slice(root.length);
	return rest.startsWith("/") ? rest : `/${rest}`;
}

/** 宿主 path 解析结果 → 远端 POSIX 绝对路径；没有宿主标记的形态原样返回（由调用方校验后拒绝）。 */
export function toRemotePath(hostPath: string): string {
	const stripped = stripHostMarker(hostPath);
	if (!stripped.startsWith("/")) return stripped;
	const trimmed = stripped.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}
