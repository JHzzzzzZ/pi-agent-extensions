/**
 * typesafe — credential（typesafe-todo#1）：从哪拿 key、怎么拿，本模块是唯一入口。
 *
 * 解析优先级：`TYPESAFE_API_KEY` 环境变量 → `~/.pi/agent/auth.json` 的 `typesafe`
 * 条目（`/login typesafe` 由 Pi 自己写进去，形状 `{type:"api_key", key}`，与其它
 * provider 同格式同位置）。读文件/解析失败一律返回 `undefined`（fail-closed），
 * 不抛异常、不阻断加载——形状参照 chatanywhere-provider/auth.ts 与 provider-quota。
 *
 * **不变量（红线，见 todos/align/typesafe-todo#1.md 范围 4）**：明文 key 只在本模块
 * 与 client.ts 的请求头拼装之间短暂存在；本模块没有任何打印/日志出口，也不导出
 * 任何「把整个 auth.json 交出去」的读取函数——调用方只能拿到「key 或 undefined」。
 *
 * 零运行时依赖（只用 node 内置），因此可被 `node --experimental-strip-types` 直接单测。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `auth.json` 路径（与 Pi 的 AuthStorage 同源：`PI_CODING_AGENT_DIR` 覆盖 → `~/.pi/agent`）。 */
export function authFilePath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR;
	if (typeof override === "string" && override.trim() !== "") return join(override.trim(), "auth.json");
	return join(homedir(), ".pi", "agent", "auth.json");
}

/** provider id / auth.json 条目键（`/login typesafe` 落盘用的就是它）。 */
export const PROVIDER_ID = "typesafe";

/** 环境变量名（`auth.json` 之外的第二来源，测试与 CI 用）。 */
export const ENV_KEY = "TYPESAFE_API_KEY";

/**
 * 从 auth.json 的内容按 provider id 顺序取第一个非空 key。
 * 结构不认识就返回 `undefined`——不抛异常、不猜测别的字段。
 */
export function apiKeyFromAuth(authJson: unknown, providerIds: readonly string[] = [PROVIDER_ID]): string | undefined {
	if (typeof authJson !== "object" || authJson === null || Array.isArray(authJson)) return undefined;
	const entries = authJson as Record<string, unknown>;
	for (const id of providerIds) {
		const entry = entries[id];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const key = (entry as Record<string, unknown>).key;
		if (typeof key === "string" && key.trim() !== "") return key.trim();
	}
	return undefined;
}

/** 读 auth.json（路径与读取函数可注入以便测试）；任何失败返回 `undefined`。 */
export function readAuthJson(
	file: string = authFilePath(),
	readFn: (path: string, encoding: "utf8") => string = readFileSync,
): unknown {
	try {
		return JSON.parse(readFn(file, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** 完整解析规则：环境变量（去空白）→ auth.json。 */
export function resolveTypeSafeKey(
	envKey: string | undefined,
	authJson: unknown,
	providerIds: readonly string[] = [PROVIDER_ID],
): string | undefined {
	if (envKey !== undefined && envKey.trim() !== "") return envKey.trim();
	return apiKeyFromAuth(authJson, providerIds);
}

/** 按真实来源解析一次 key（工具与 CLI 的唯一取 key 调用点）。 */
export function resolveKeyFromDisk(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return resolveTypeSafeKey(env[ENV_KEY], readAuthJson());
}
