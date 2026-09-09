/**
 * ChatAnywhere API key 解析（auth.ts）
 *
 * 探测/注册用 key 的解析优先级：CHATANYWHERE_API_KEY 环境变量 →
 * ~/.pi/agent/auth.json（按 provider id，chatanywhere → chatanywhere-claude
 * 顺序尝试）。注册的 apiKey 仍写 "$CHATANYWHERE_API_KEY"（Pi 侧自己的
 * env/auth 解析），本模块只解决扩展加载时探测拿不到 key 的问题。
 *
 * 读文件/解析失败都返回 undefined（探测失败已 fail-closed，不阻断加载）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

/** 从 auth.json 内容按 provider id 顺序取第一个非空 key（结构校验，不抛异常） */
export function apiKeyFromAuth(authJson: unknown, providerIds: readonly string[]): string | undefined {
	if (typeof authJson !== "object" || authJson === null || Array.isArray(authJson)) return undefined;
	const entries = authJson as Record<string, unknown>;
	for (const id of providerIds) {
		const entry = entries[id];
		if (typeof entry !== "object" || entry === null) continue;
		const key = (entry as Record<string, unknown>).key;
		if (typeof key === "string" && key.trim() !== "") return key.trim();
	}
	return undefined;
}

/** 读 auth.json（路径与读取函数可注入以便测试）；失败返回 undefined */
export function readAuthJson(file: string = AUTH_FILE, readFn: (path: string, encoding: "utf8") => string = readFileSync): unknown {
	try {
		return JSON.parse(readFn(file, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** key 解析完整规则：环境变量（去空白）→ auth.json */
export function resolveApiKey(envKey: string | undefined, authJson: unknown, providerIds: readonly string[]): string | undefined {
	if (envKey !== undefined && envKey.trim() !== "") return envKey.trim();
	return apiKeyFromAuth(authJson, providerIds);
}