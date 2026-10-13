/*
 * remote-tools — 远端目标登记表（别名 + strict 白名单，remote-tools-todo#2）。
 *
 * 目的（权威文档：todos/align/remote-tools-todo#2.md）：
 *   - 给「远端目标」一个可发现的具名身份（别名），模型不必每次从零编一个 host；
 *   - strict 默认开时**未登记的目标一律拒绝**——买到的是可发现性 + 审计（每条远端调用都能追到
 *     具名条目与来源），**不是安全边界**（模型可注册，注入内容同样能诱导它注册；用户已知情选择）；
 *   - 登记表是**用户级**文件 `~/.pi/agent/remote-targets.json`（与 auth.json / solo-mode.json 同族），
 *     只存别名/host/user/port，**永不存凭据**（沿用系统密钥 / ssh-agent 的既有不变量）。
 *
 * 边界：
 *   - 零 ssh、零进程、零 UI：纯函数 + 一个注入的文件端口（测试用手写 fake）；
 *   - **本地调用绝不碰登记表**（`hasRemoteIntent` 为假时调用方不 read、不 write、不报错）——
 *     登记表损坏不得弄坏本机工具；
 *   - 任何文案都不插值远端内容；别名清单来自本地文件且经形态校验（无空白、无 `@`），插进
 *     错误消息安全（这是「错误消息全静态模板」的既有口径，不涉及远端回流数据）。
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { ErrorCodes, failure, type RemoteToolsFailure } from "./errors.ts";
import { type SshTarget, type TargetInput, formatTarget, parseTarget } from "./ssh.ts";

/** 登记表路径覆盖（测试接缝；与 PI_SOLO_MODE_FILE 同惯例）。 */
export const TARGETS_FILE_ENV = "PI_REMOTE_TARGETS_FILE";

/** 文件形态版本（只接受 1，遇到别的版本 fail-closed 而不是猜）。 */
export const TARGETS_VERSION = 1;

/** 错误文案里最多回显几个别名（防膨胀；超出只说总数）。 */
export const ALIAS_ECHO_LIMIT = 20;

/** 工具描述里的提示行最多列几个别名。 */
export const HINT_LIMIT = 10;

const NOTE_MAX_LENGTH = 200;

export interface RemoteTargetEntry {
	/** 别名——strict 白名单的键，模型只引用它。 */
	alias: string;
	/** 显式主机名；省略 ⇒ 别名本身当主机名交给 ssh（`~/.ssh/config` 兜底）。 */
	host?: string | undefined;
	user?: string | undefined;
	port?: number | undefined;
	/** 谁写的：human（`/remote:add`）或 agent（`remote_targets` 工具）。 */
	source: "human" | "agent";
	createdAt: string;
	note?: string | undefined;
}

export interface RemoteTargetsFile {
	version: typeof TARGETS_VERSION;
	strict: boolean;
	targets: RemoteTargetEntry[];
}

/** 空登记表（文件不存在时的语义）：strict 开、零目标。 */
export function emptyTargetsFile(): RemoteTargetsFile {
	return { version: TARGETS_VERSION, strict: true, targets: [] };
}

/** 登记表路径：`PI_REMOTE_TARGETS_FILE` > `~/.pi/agent/remote-targets.json`。 */
export function targetsFilePath(env: Record<string, string | undefined>): string {
	const override = env[TARGETS_FILE_ENV]?.trim();
	if (override !== undefined && override.length > 0) return override;
	return path.join(homedir(), ".pi", "agent", "remote-targets.json");
}

// ── 形态校验（fail-closed：字段出现但非法一律报错，绝不静默忽略）──────────────

/** 主机 / 用户 / 别名的公共形态：非空、无空白、不以 `-` 开头、不含 `@` 与 `:`。 */
function plainName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	if (value === "" || value.trim() !== value) return null;
	if (value.startsWith("-")) return null;
	if (/[\s@:]/.test(value)) return null;
	return value;
}

/** 可选名称字段：缺省/空 ⇒ undefined；给了但非法 ⇒ null（调用方据此报错）。 */
function optionalName(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	return plainName(value);
}

/** 可选端口：缺省/空 ⇒ undefined；给了但非法 ⇒ null。 */
function optionalPort(value: unknown): number | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) return null;
	return value;
}

/** 可选备注：缺省/空串 ⇒ undefined；给了但非法 ⇒ null。 */
function optionalNote(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.trim() === "" || value.length > NOTE_MAX_LENGTH) return null;
	return value;
}

/** 单条目校验：字段非法、或与 ssh 目标形态冲突，一律明确报错（不猜）。 */
export function validateTargetEntry(raw: unknown): { ok: true; value: RemoteTargetEntry } | RemoteToolsFailure {
	if (typeof raw !== "object" || raw === null) {
		return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "登记表条目必须是对象。");
	}
	const record = raw as Record<string, unknown>;
	const known = new Set(["alias", "host", "user", "port", "source", "createdAt", "note"]);
	for (const key of Object.keys(record)) {
		if (!known.has(key)) return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "登记表条目含未知字段（fail-closed，不静默忽略）。");
	}

	const alias = plainName(record.alias);
	if (alias === null) return failure(ErrorCodes.INVALID_REMOTE_TARGET, "别名形态非法：非空、无空白、不以 - 开头、不含 @ 或 :。");
	const host = optionalName(record.host);
	if (host === null) return failure(ErrorCodes.INVALID_REMOTE_TARGET, "host 形态非法：非空、无空白、不以 - 开头、不含 @ 或 :。");
	const user = optionalName(record.user);
	if (user === null) return failure(ErrorCodes.INVALID_REMOTE_TARGET, "user 形态非法：非空、无空白、不以 - 开头、不含 @ 或 :。");
	const port = optionalPort(record.port);
	if (port === null) return failure(ErrorCodes.INVALID_REMOTE_PORT, "port 必须是 1-65535 的整数。");
	const note = optionalNote(record.note);
	if (note === null) return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "note 必须是 1-200 字符的字符串。");

	if (record.source !== "human" && record.source !== "agent") {
		return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "source 必须是 human 或 agent。");
	}
	if (typeof record.createdAt !== "string" || record.createdAt.trim() === "") {
		return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "createdAt 必须是非空字符串。");
	}

	// 与传输层同一口径：别名（或 host）拼出的目标必须能被 parseTarget 接受，否则 ssh 会拿到非法参数。
	const composed = user === undefined ? (host ?? alias) : `${user}@${host ?? alias}`;
	const parsed = parseTarget({ remote: composed, remotePort: port });
	if (!parsed.ok) return parsed;
	if (parsed.target === null || parsed.target.host !== (host ?? alias) || parsed.target.user !== user) {
		return failure(ErrorCodes.INVALID_REMOTE_TARGET, "别名的目标形态与 ssh 口径不一致。");
	}

	return { ok: true, value: buildEntry({ alias, host, user, port, source: record.source, createdAt: record.createdAt, note }) };
}

/** 只写「有值」的可选字段：往返（序列化→解析）后对象逐字段相等，不留 undefined 占位。 */
function buildEntry(input: {
	alias: string;
	host: string | undefined;
	user: string | undefined;
	port: number | undefined;
	source: "human" | "agent";
	createdAt: string;
	note: string | undefined;
}): RemoteTargetEntry {
	const entry: RemoteTargetEntry = { alias: input.alias, source: input.source, createdAt: input.createdAt };
	if (input.host !== undefined) entry.host = input.host;
	if (input.user !== undefined) entry.user = input.user;
	if (input.port !== undefined) entry.port = input.port;
	if (input.note !== undefined) entry.note = input.note;
	return entry;
}

/** 文件解析：非法 JSON / 版本不符 / 未知字段 / 条目非法 / 别名重复一律 fail-closed。 */
export function parseTargetsFile(text: string): { ok: true; value: RemoteTargetsFile } | RemoteToolsFailure {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "登记表不是合法 JSON。");
	}
	if (typeof raw !== "object" || raw === null) return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "登记表根必须是对象。");
	const record = raw as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "version" && key !== "strict" && key !== "targets") {
			return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "登记表含未知字段（fail-closed，不静默忽略）。");
		}
	}
	if (record.version !== TARGETS_VERSION) return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "登记表版本不受支持。");
	if (typeof record.strict !== "boolean") return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "strict 必须是布尔值。");
	if (!Array.isArray(record.targets)) return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "targets 必须是数组。");

	const targets: RemoteTargetEntry[] = [];
	const seen = new Set<string>();
	for (const item of record.targets) {
		const entry = validateTargetEntry(item);
		if (!entry.ok) return entry;
		if (seen.has(entry.value.alias)) return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "登记表里出现重复别名。");
		seen.add(entry.value.alias);
		targets.push(entry.value);
	}
	return { ok: true, value: { version: TARGETS_VERSION, strict: record.strict, targets } };
}

export function serializeTargetsFile(file: RemoteTargetsFile): string {
	return `${JSON.stringify(file, null, 2)}\n`;
}

// ── 别名解析（唯一接缝：解析结果仍喂给既有链路，传输层零改动）────────────────

export type TargetResolution =
	| { ok: true; kind: "local" }
	| { ok: true; kind: "resolved"; target: SshTarget; entry: RemoteTargetEntry | null }
	| RemoteToolsFailure;

function entryHost(entry: RemoteTargetEntry): string {
	return entry.host ?? entry.alias;
}

function entryTarget(entry: RemoteTargetEntry): SshTarget {
	return { host: entryHost(entry), user: entry.user, port: entry.port };
}

/** 条目展示形态（含端口）。 */
export function formatEntry(entry: RemoteTargetEntry): string {
	const target = entryTarget(entry);
	const port = target.port === undefined ? "" : `:${target.port}`;
	return `${formatTarget(target)}${port}`;
}

/** 命中口径（对齐文档 Q3）：host 相等，且入参给了 user/port 时必须相等。 */
function matchesEntry(entry: RemoteTargetEntry, target: SshTarget): boolean {
	if (entryHost(entry) !== target.host) return false;
	if (target.user !== undefined && entry.user !== target.user) return false;
	if (target.port !== undefined && entry.port !== target.port) return false;
	return true;
}

/** strict 拒绝文案：静态模板 + 本地登记表的别名清单（本地内容，非远端回流）。 */
export function strictRejectionMessage(file: RemoteTargetsFile | null): string {
	const all = file?.targets ?? [];
	const shown = all.slice(0, ALIAS_ECHO_LIMIT).map((entry) => entry.alias);
	const suffix = all.length > shown.length ? ` …（共 ${all.length} 个，用 remote_targets 看全部）` : "";
	const list = shown.length === 0 ? "（空）" : `${shown.join(", ")}${suffix}`;
	return (
		`远端目标未登记，strict 白名单已开启：只接受已登记目标。已登记：${list}。` +
		"登记入口：/remote:add <别名> [user@host] [--port N]，或 remote_targets 工具（action=register）；" +
		"也可以用 /remote:strict off 关闭白名单。"
	);
}

/**
 * 解析远端目标：本地模式原样返回；远端模式先按别名精确匹配，再按展开后的三元组匹配；
 * strict 且未命中 ⇒ 结构化拒绝，非 strict 且未命中 ⇒ 回落成今天的自由填写（逐字不变）。
 *
 * 调用方保证：`hasRemoteIntent(input)` 为假时不读登记表（本地分支零影响不变量）。
 */
export function resolveTarget(input: TargetInput, file: RemoteTargetsFile | null): TargetResolution {
	const literal = parseTarget(input);
	if (!literal.ok) return literal;
	const target = literal.target;
	if (target === null) return { ok: true, kind: "local" };

	const byAlias = target.user === undefined ? (file?.targets.find((entry) => entry.alias === target.host) ?? null) : null;
	const match = byAlias ?? file?.targets.find((entry) => matchesEntry(entry, target)) ?? null;
	if (match === null) {
		if (file?.strict === true) return failure(ErrorCodes.UNKNOWN_REMOTE_TARGET, strictRejectionMessage(file));
		return { ok: true, kind: "resolved", target, entry: null };
	}
	const resolved = entryTarget(match);
	// 显式给出的 remotePort 优先于条目里的端口（条目端口是默认值，不是强制值）。
	return { ok: true, kind: "resolved", target: { ...resolved, port: target.port ?? resolved.port }, entry: match };
}

// ── 登记 / 删除 / 开关（纯函数；落盘由调用方经 store 完成）──────────────────

export interface TargetDraft {
	alias: unknown;
	host?: unknown;
	user?: unknown;
	port?: unknown;
	note?: unknown;
	source: "human" | "agent";
}

export interface AddTargetOptions {
	nowIso: string;
	/** 同名覆盖（人工 `/remote:add --force`）；模型侧永远 false。 */
	force: boolean;
}

export function addTarget(
	file: RemoteTargetsFile | null,
	draft: TargetDraft,
	options: AddTargetOptions,
): { ok: true; value: RemoteTargetsFile; entry: RemoteTargetEntry } | RemoteToolsFailure {
	const checked = validateTargetEntry({ ...draft, createdAt: options.nowIso });
	if (!checked.ok) return checked;
	const entry = checked.value;
	const base = file ?? emptyTargetsFile();
	const index = base.targets.findIndex((existing) => existing.alias === entry.alias);
	if (index >= 0 && !options.force) {
		return failure(ErrorCodes.REMOTE_TARGET_EXISTS, `别名 ${entry.alias} 已登记；要覆盖请用 /remote:add --force（模型侧不支持覆盖）。`);
	}
	const targets = index >= 0 ? base.targets.map((existing, i) => (i === index ? entry : existing)) : [...base.targets, entry];
	return { ok: true, value: { ...base, targets }, entry };
}

export function removeTarget(file: RemoteTargetsFile, alias: string): { ok: true; value: RemoteTargetsFile } | RemoteToolsFailure {
	const targets = file.targets.filter((entry) => entry.alias !== alias);
	if (targets.length === file.targets.length) {
		return failure(ErrorCodes.REMOTE_TARGET_UNKNOWN, `没有登记名为 ${alias} 的目标（用 /remote:list 看全部）。`);
	}
	return { ok: true, value: { ...file, targets } };
}

export function withStrict(file: RemoteTargetsFile | null, strict: boolean): RemoteTargetsFile {
	return { ...(file ?? emptyTargetsFile()), strict };
}

// ── 展示（模型面工具与命令面共用同一份格式化，不许两份）────────────────────

/** 工具描述里的「已登记目标」提示行：空表或读不出 ⇒ 空串（绝不因此阻断注册）。 */
export function targetHintLine(file: RemoteTargetsFile | null): string {
	const targets = file?.targets ?? [];
	if (targets.length === 0) return "";
	const shown = targets.slice(0, HINT_LIMIT).map((entry) => entry.alias);
	const suffix = targets.length > shown.length ? ` 等 ${targets.length} 个` : "";
	return `已登记目标：${shown.join(", ")}${suffix}（详情用 remote_targets 工具查）。`;
}

/** 人读清单（`/remote:list` 与 `remote_targets` 的 list 动作共用）。 */
export function formatTargetsList(file: RemoteTargetsFile | null, filePath: string): string {
	const targets = file?.targets ?? [];
	const head = `远端目标（strict 白名单：${file?.strict === true ? "开" : "关"}）`;
	if (targets.length === 0) {
		return `${head}\n（没有任何已登记目标）\n登记表：${filePath}\n登记：/remote:add <别名> [user@host] [--port N]`;
	}
	const lines = targets.map((entry) => {
		const where = entry.host === undefined ? `${entry.alias}（ssh_config 兜底）` : formatEntry(entry);
		return `- ${entry.alias} → ${where}（${entry.source}，${entry.createdAt}）`;
	});
	return `${head}\n${lines.join("\n")}\n登记表：${filePath}`;
}

// ── 文件端口（进程边界：生产走真实文件系统，测试注入手写 fake）──────────────

export type TargetsRead = { ok: true; value: RemoteTargetsFile | null } | RemoteToolsFailure;

export interface TargetsStore {
	/** 登记表路径（清单里回显）。 */
	path: string;
	/** 读：文件不存在 ⇒ `value: null`（不是错误）；读不出/损坏 ⇒ fail-closed 类型化错误。 */
	read(): Promise<TargetsRead>;
	/** 原子落盘（temp + rename）。 */
	write(file: RemoteTargetsFile): Promise<{ ok: true } | RemoteToolsFailure>;
	/** 加载期同步读（只为工具描述的提示行）：任何失败都当「没有登记表」，绝不阻断注册。 */
	readAtLoad(): RemoteTargetsFile | null;
}

export function createTargetsStore(filePath: string): TargetsStore {
	return {
		path: filePath,
		async read(): Promise<TargetsRead> {
			let text: string;
			try {
				text = await readFile(filePath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: null };
				return failure(ErrorCodes.REMOTE_TARGETS_UNREADABLE, "登记表读取失败（检查文件权限）。");
			}
			return parseTargetsFile(text);
		},
		async write(file: RemoteTargetsFile): Promise<{ ok: true } | RemoteToolsFailure> {
			try {
				await mkdir(path.dirname(filePath), { recursive: true });
				const temporary = `${filePath}.tmp-${process.pid}`;
				await writeFile(temporary, serializeTargetsFile(file), "utf8");
				await rename(temporary, filePath);
				return { ok: true };
			} catch {
				return failure(ErrorCodes.REMOTE_TARGETS_WRITE_FAILED, "登记表写入失败（检查目录权限）。");
			}
		},
		readAtLoad(): RemoteTargetsFile | null {
			try {
				const parsed = parseTargetsFile(readFileSync(filePath, "utf8"));
				return parsed.ok ? parsed.value : null;
			} catch {
				return null;
			}
		},
	};
}
