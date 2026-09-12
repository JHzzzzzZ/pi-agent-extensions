/**
 * ChatAnywhere Provider Extension for Pi
 *
 * v1.1.0 起改为运行时自动发现：加载时探测 GET {base}/models（OpenAI 兼容
 * data 列表），按“家族线 + 档位”归并去重后注册（见 discover.ts 与
 * catalog.ts 目录）。探测失败 fail-closed：两个 provider 均注册空模型列表，
 * 绝不回退到静态目录。
 *
 * 配置：
 *  - CHATANYWHERE_API_KEY   API key（可从 https://api.chatanywhere.tech 获取）
 *  - CHATANYWHERE_BASE_URL  可选，默认 https://api.chatanywhere.tech/v1
 *
 * key 解析优先级：环境变量 → ~/.pi/agent/auth.json（chatanywhere →
 * chatanywhere-claude 条目，见 auth.ts）——没设环境变量也能探测成功。
 *
 * 注册两个 provider：
 *  - chatanywhere（openai-completions）：OpenAI 兼容模型；推理模型带思考等级映射
 *  - chatanywhere-claude（anthropic-messages）：Claude 系模型（id 以 claude- 开头），
 *    附 Claude 思考映射与 forceAdaptiveThinking 兼容标志
 *
 * 注：真实 GET /models 响应形状未能在线验证（无可用密钥，401），按 OpenAI 兼容
 * 规范解析并防御性读取 context_window/max_tokens（camelCase 亦接受），
 * 见 discover.ts 头部注释。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claudeApiRoot, probeModels, selectForRegistration } from "./discover.ts";
import { MODEL_DEFS, MODEL_LINES } from "./catalog.ts";
import { readAuthJson, resolveApiKey } from "./auth.ts";

const DEFAULT_BASE_URL = "https://api.chatanywhere.tech/v1";

// 探测用 key：环境变量 → auth.json（两 provider 共用同一账户 key）
const AUTH_PROVIDER_IDS = ["chatanywhere", "chatanywhere-claude"] as const;

export default async function (pi: ExtensionAPI) {
	const baseUrl = process.env.CHATANYWHERE_BASE_URL ?? DEFAULT_BASE_URL;
	const apiKey = resolveApiKey(process.env.CHATANYWHERE_API_KEY, readAuthJson(), AUTH_PROVIDER_IDS);
	const probe = await probeModels(baseUrl, apiKey ?? "");
	// 探测失败 → 空模型列表（fail-closed）
	const { openai, claude } = selectForRegistration(probe, MODEL_DEFS, MODEL_LINES);

	// Provider 1: ChatAnywhere — OpenAI 兼容模型（OpenAI Chat Completions API）
	pi.registerProvider("chatanywhere", {
		name: "ChatAnywhere",
		baseUrl,
		apiKey: "$CHATANYWHERE_API_KEY",
		api: "openai-completions",
		models: openai,
	});

	// Provider 2: ChatAnywhere Claude — Claude 模型（Anthropic Messages API）
	// anthropic-messages API 内部会拼接 /v1/messages，所以 baseUrl 用去 /v1 的根地址
	pi.registerProvider("chatanywhere-claude", {
		name: "ChatAnywhere Claude",
		baseUrl: claudeApiRoot(baseUrl),
		apiKey: "$CHATANYWHERE_API_KEY",
		api: "anthropic-messages",
		models: claude,
	});
}