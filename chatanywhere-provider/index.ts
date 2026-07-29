/**
 * ChatAnywhere Provider Extension for Pi
 *
 * ChatAnywhere 是一个 OpenAI 兼容的 API 转发服务，提供 GPT、Claude、Gemini、DeepSeek、Qwen 等模型。
 * 文档: https://docs.chatanywhere.tech
 *
 * 使用方式:
 *   1. 在 ChatAnywhere (https://api.chatanywhere.org) 注册并获取 API Key
 *   2. 设置环境变量 CHATANYWHERE_API_KEY=sk-xxx
 *   3. 启动 Pi: pi -e ./extensions/chatanywhere-provider
 *   4. 在 Pi 中 /model 选择模型
 *
 * 国内用户使用 api.chatanywhere.tech（延迟更低）
 * 国外用户使用 api.chatanywhere.org
 *
 * 可通过 CHATANYWHERE_BASE_URL 环境变量切换端点，
 * 默认使用 api.chatanywhere.tech。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// 配置
// =============================================================================

const BASE_URL =
	process.env.CHATANYWHERE_BASE_URL ?? "https://api.chatanywhere.tech/v1";

// 辅助: CA币/1K 转 CA币/1M（用于 Pi 的成本跟踪）
const per1M = (per1K: number) => per1K * 1000;

// =============================================================================
// 模型定义
// =============================================================================

interface ModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number; // CA币/1M tokens
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
}

const model = (
	id: string,
	name: string,
	inputCostPer1K: number,
	outputCostPer1K: number,
	contextWindow: number,
	maxTokens: number,
	reasoning = false,
	input: ModelDef["input"] = ["text", "image"],
): ModelDef => ({
	id,
	name,
	reasoning,
	input,
	cost: {
		input: per1M(inputCostPer1K),
		output: per1M(outputCostPer1K),
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow,
	maxTokens,
});

// ---- GPT-5.6 系列 ----
const gpt56Models: ModelDef[] = [
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.035),
			output: per1M(0.21),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0175),
			output: per1M(0.105),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.007),
			output: per1M(0.042),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-sol-ca",
		name: "GPT-5.6 Sol (CA)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.02),
			output: per1M(0.12),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-terra-ca",
		name: "GPT-5.6 Terra (CA)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.01),
			output: per1M(0.06),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-luna-ca",
		name: "GPT-5.6 Luna (CA)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.004),
			output: per1M(0.024),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
];

// ---- GPT-5.5 / 5.4 / 5.2 / 5.1 / 5 系列 ----
const gpt5Models: ModelDef[] = [
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.035),
			output: per1M(0.21),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.5-ca",
		name: "GPT-5.5 (CA)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.02),
			output: per1M(0.12),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0175),
			output: per1M(0.105),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.00525),
			output: per1M(0.0315),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.4-nano",
		name: "GPT-5.4 Nano",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0014),
			output: per1M(0.00875),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.4-2026-03-05",
		name: "GPT-5.4 (2026-03-05)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0175),
			output: per1M(0.105),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1050000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.01225),
			output: per1M(0.098),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 400000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.2-codex",
		name: "GPT-5.2 Codex",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.01225),
			output: per1M(0.098),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 400000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.1",
		name: "GPT-5.1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.00875),
			output: per1M(0.07),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 400000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.1-2025-11-13",
		name: "GPT-5.1 (2025-11-13)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.00875),
			output: per1M(0.07),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 400000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5",
		name: "GPT-5",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.00875),
			output: per1M(0.07),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 400000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5-codex",
		name: "GPT-5 Codex",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.00875),
			output: per1M(0.07),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 400000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.00175),
			output: per1M(0.014),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 400000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5-nano",
		name: "GPT-5 Nano",
		reasoning: false,
		input: ["text"],
		cost: {
			input: per1M(0.00035),
			output: per1M(0.0028),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 400000,
		maxTokens: 128000,
	},
];

// ---- ChatAnywhere 文档中的 OpenAI 兼容补充模型 ----
// 定价来自 https://docs.chatanywhere.tech/doc-2694962（CA币/1K tokens）。
// 搜索模型的搜索服务费及 Gemini 图像模型的按张计费不计入 token 成本。
const documentedOpenAIModels: ModelDef[] = [
	model(
		"gpt-5.4-mini-2026-03-17",
		"GPT-5.4 Mini (2026-03-17)",
		0.00525,
		0.0315,
		1050000,
		128000,
		true,
	),
	model(
		"gpt-5.4-nano-2026-03-17",
		"GPT-5.4 Nano (2026-03-17)",
		0.0014,
		0.00875,
		1050000,
		128000,
	),
	model(
		"gpt-5.2-2025-12-11",
		"GPT-5.2 (2025-12-11)",
		0.01225,
		0.098,
		400000,
		128000,
		true,
	),
	model("gpt-5.2-pro", "GPT-5.2 Pro", 0.147, 1.176, 400000, 128000, true),
	model(
		"gpt-5.2-pro-2025-12-11",
		"GPT-5.2 Pro (2025-12-11)",
		0.147,
		1.176,
		400000,
		128000,
		true,
	),
	model(
		"gpt-5-search-api",
		"GPT-5 Search API",
		0.00875,
		0.07,
		400000,
		128000,
		true,
	),
	model("gpt-5-pro", "GPT-5 Pro", 0.105, 0.84, 400000, 128000, true),
	model(
		"gpt-5-chat-latest",
		"GPT-5 Chat Latest",
		0.00875,
		0.07,
		400000,
		128000,
		true,
	),
	model("o3-2025-04-16", "o3 (2025-04-16)", 0.014, 0.056, 200000, 100000, true),
	model(
		"o4-mini-2025-04-16",
		"o4-mini (2025-04-16)",
		0.0088,
		0.0352,
		200000,
		100000,
		true,
	),
	model(
		"gpt-4.1-2025-04-14",
		"GPT-4.1 (2025-04-14)",
		0.014,
		0.056,
		1047576,
		32768,
		true,
	),
	model(
		"gpt-4.1-mini-2025-04-14",
		"GPT-4.1 Mini (2025-04-14)",
		0.0028,
		0.0112,
		1047576,
		32768,
	),
	model(
		"gpt-4.1-nano-2025-04-14",
		"GPT-4.1 Nano (2025-04-14)",
		0.0007,
		0.0028,
		1047576,
		32768,
	),
	model("gpt-oss-20b", "GPT-OSS 20B", 0.0008, 0.0032, 131072, 32768),
	model("gpt-oss-120b", "GPT-OSS 120B", 0.0044, 0.0176, 131072, 32768),
	model("gpt-3.5-turbo", "GPT-3.5 Turbo", 0.0035, 0.0105, 16385, 4096),
	model(
		"gpt-3.5-turbo-1106",
		"GPT-3.5 Turbo (1106)",
		0.007,
		0.014,
		16385,
		4096,
	),
	model(
		"gpt-3.5-turbo-0125",
		"GPT-3.5 Turbo (0125)",
		0.0035,
		0.0105,
		16385,
		4096,
	),
	model("gpt-3.5-turbo-16k", "GPT-3.5 Turbo 16K", 0.021, 0.028, 16385, 4096),
	model(
		"gpt-3.5-turbo-instruct",
		"GPT-3.5 Turbo Instruct",
		0.0105,
		0.014,
		4096,
		4096,
		false,
		["text"],
	),
	model("o3-mini", "o3-mini", 0.0088, 0.0352, 200000, 100000, true),
	model(
		"gpt-4o-search-preview",
		"GPT-4o Search Preview",
		0.0175,
		0.07,
		128000,
		16384,
	),
	model(
		"gpt-4o-search-preview-2025-03-11",
		"GPT-4o Search Preview (2025-03-11)",
		0.0175,
		0.07,
		128000,
		16384,
	),
	model(
		"gpt-4o-mini-search-preview",
		"GPT-4o Mini Search Preview",
		0.00105,
		0.0042,
		128000,
		16384,
	),
	model(
		"gpt-4o-mini-search-preview-2025-03-11",
		"GPT-4o Mini Search Preview (2025-03-11)",
		0.00105,
		0.0042,
		128000,
		16384,
	),
	model("gpt-4", "GPT-4", 0.21, 0.42, 8192, 8192, false, ["text"]),
	model("gpt-4-0613", "GPT-4 (0613)", 0.21, 0.42, 8192, 8192, false, ["text"]),
	model(
		"gpt-4o-2024-11-20",
		"GPT-4o (2024-11-20)",
		0.0175,
		0.07,
		128000,
		16384,
	),
];

// ---- GPT-5 CA 渠道系列 ----
const gpt5CAModels: ModelDef[] = [
	model("gpt-5.4-ca", "GPT-5.4 (CA)", 0.01, 0.06, 1050000, 128000, true),
	model(
		"gpt-5.4-mini-ca",
		"GPT-5.4 Mini (CA)",
		0.003,
		0.018,
		1050000,
		128000,
		true,
	),
	model("gpt-5.4-nano-ca", "GPT-5.4 Nano (CA)", 0.0008, 0.005, 1050000, 128000),
	model("gpt-5.2-ca", "GPT-5.2 (CA)", 0.007, 0.056, 400000, 128000, true),
	model(
		"gpt-5.2-codex-ca",
		"GPT-5.2 Codex (CA)",
		0.007,
		0.056,
		400000,
		128000,
		true,
	),
	model("gpt-5-ca", "GPT-5 (CA)", 0.005, 0.04, 400000, 128000, true),
	model("gpt-5-mini-ca", "GPT-5 Mini (CA)", 0.001, 0.008, 400000, 128000, true),
	model("gpt-5-nano-ca", "GPT-5 Nano (CA)", 0.0002, 0.0016, 400000, 128000),
];

// ---- GPT-4.1 / 4o / o3 系列 ----
const gpt4Models: ModelDef[] = [
	{
		id: "gpt-4.1",
		name: "GPT-4.1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.014),
			output: per1M(0.056),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1047576,
		maxTokens: 32768,
	},
	{
		id: "gpt-4.1-mini",
		name: "GPT-4.1 Mini",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0028),
			output: per1M(0.0112),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1047576,
		maxTokens: 32768,
	},
	{
		id: "gpt-4.1-nano",
		name: "GPT-4.1 Nano",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0007),
			output: per1M(0.0028),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1047576,
		maxTokens: 32768,
	},
	{
		id: "o3",
		name: "o3",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.014),
			output: per1M(0.056),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 100000,
	},
	{
		id: "o4-mini",
		name: "o4-mini",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0088),
			output: per1M(0.0352),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 100000,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0175),
			output: per1M(0.07),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-4o-mini",
		name: "GPT-4o Mini",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.00105),
			output: per1M(0.0042),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 16384,
	},
];

// ---- CA 渠道 GPT-4.x 系列 ----
const gpt4CAModels: ModelDef[] = [
	{
		id: "gpt-4.1-ca",
		name: "GPT-4.1 (CA)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.008),
			output: per1M(0.032),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1047576,
		maxTokens: 32768,
	},
	{
		id: "gpt-4.1-mini-ca",
		name: "GPT-4.1 Mini (CA)",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0016),
			output: per1M(0.0064),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1047576,
		maxTokens: 32768,
	},
	{
		id: "gpt-4.1-nano-ca",
		name: "GPT-4.1 Nano (CA)",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0004),
			output: per1M(0.003),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1047576,
		maxTokens: 32768,
	},
	{
		id: "gpt-4o-ca",
		name: "GPT-4o (CA)",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.01),
			output: per1M(0.04),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-4o-mini-ca",
		name: "GPT-4o Mini (CA)",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.00075),
			output: per1M(0.003),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128000,
		maxTokens: 16384,
	},
];

// ---- DeepSeek 系列 ----
const deepseekModels: ModelDef[] = [
	{
		id: "deepseek-v3-2",
		name: "DeepSeek V3-2",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0012),
			output: per1M(0.0018),
			cacheRead: 0,
			cacheWrite: 0,
		},
		// DeepSeek V3.2：约 160K 上下文，最大输出 64K。
		contextWindow: 163840,
		maxTokens: 65536,
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0008),
			output: per1M(0.0016),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.003),
			output: per1M(0.006),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	model("deepseek-v3.2", "DeepSeek V3.2", 0.0012, 0.0018, 163840, 65536, true),
	// DeepSeek API 的兼容别名：chat 为 8K，reasoner/R1 为 64K 输出。
	model("deepseek-chat", "DeepSeek Chat", 0.0012, 0.0018, 128000, 8192),
	model(
		"deepseek-reasoner",
		"DeepSeek Reasoner",
		0.0024,
		0.0096,
		128000,
		65536,
		true,
	),
	model("deepseek-r1", "DeepSeek R1", 0.0024, 0.0096, 128000, 65536, true),
];

// ---- Qwen 系列 ----
const qwenModels: ModelDef[] = [
	model(
		"qwen3.5-plus",
		"Qwen 3.5 Plus",
		0.00056,
		0.00336,
		1048576,
		65536,
		true,
	),
	// Qwen3.5-397B-A17B 原生支持 262,144 上下文，建议最大输出 32,768。
	model(
		"qwen3.5-397b-a17b",
		"Qwen 3.5 397B A17B",
		0.00084,
		0.00504,
		262144,
		32768,
		true,
	),
	// Qwen Cloud 的 Qwen3 Max 服务规格：262,144 上下文、65,536 最大输出。
	model(
		"qwen3-max-2026-01-23",
		"Qwen 3 Max (2026-01-23)",
		0.00175,
		0.007,
		262144,
		65536,
		true,
	),
	model(
		"qwen3-235b-a22b",
		"Qwen 3 235B A22B",
		0.0014,
		0.0056,
		262144,
		32768,
		true,
		["text"],
	),
	model(
		"qwen3-235b-a22b-instruct-2507",
		"Qwen 3 235B A22B Instruct 2507",
		0.0014,
		0.0056,
		262144,
		32768,
		false,
		["text"],
	),
	model(
		"qwen3-coder-plus",
		"Qwen 3 Coder Plus",
		0.0028,
		0.0112,
		1048576,
		65536,
		true,
		["text"],
	),
	// Qwen3-Coder-480B-A35B-Instruct 原生 262,144 上下文；1M 需 YaRN 扩展。
	model(
		"qwen3-coder-480b-a35b-instruct",
		"Qwen 3 Coder 480B A35B Instruct",
		0.0042,
		0.0168,
		262144,
		32768,
		true,
		["text"],
	),
];

// ---- Kimi 系列 ----
const kimiModels: ModelDef[] = [
	model(
		"kimi-k2.7-code",
		"Kimi K2.7 Code",
		0.0052,
		0.0216,
		262144,
		32768,
		true,
		["text", "image"],
	),
	model("kimi-k2.6", "Kimi K2.6", 0.00455, 0.0189, 262144, 32768, true, [
		"text",
	]),
	model("kimi-k2.5", "Kimi K2.5", 0.0028, 0.0147, 262144, 32768, true, [
		"text",
		"image",
	]),
];

// ---- GLM 系列 ----
const glmModels: ModelDef[] = [
	// GLM-5.2 官方规格：1M 上下文；GLM-5 系列最大生成长度为 131,072。
	model("glm-5.2", "GLM-5.2", 0.0064, 0.0224, 1048576, 131072, true, ["text"]),
	model("glm-5.1", "GLM-5.1", 0.0036, 0.0144, 200000, 131072, true, ["text"]),
	model("glm-5", "GLM-5", 0.0024, 0.0108, 200000, 131072, true, ["text"]),
];

// ---- Claude 系列（通过 Anthropic Messages API） ----
const claudeModels: ModelDef[] = [
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.025),
			output: per1M(0.125),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.015),
			output: per1M(0.075),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-opus-4-5-20251101",
		name: "Claude Opus 4.5 (20251101)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.025),
			output: per1M(0.125),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-sonnet-4-5-20250929",
		name: "Claude Sonnet 4.5 (20250929)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.015),
			output: per1M(0.075),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5 (20251001)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.005),
			output: per1M(0.025),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.025),
			output: per1M(0.125),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.025),
			output: per1M(0.125),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.025),
			output: per1M(0.125),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.025),
			output: per1M(0.125),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.01),
			output: per1M(0.05),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.05),
			output: per1M(0.25),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 128000,
	},
];

// ---- MiniMax 系列 ----
const minimaxModels: ModelDef[] = [
	{
		id: "minimax-m3",
		name: "MiniMax M3",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.00168),
			output: per1M(0.00672),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 8192,
	},
	model("minimax-m2.1", "MiniMax M2.1", 0.00126, 0.00504, 1000000, 8192, true),
	model("minimax-m2.5", "MiniMax M2.5", 0.00126, 0.00504, 1000000, 8192, true),
	model("minimax-m2.7", "MiniMax M2.7", 0.00126, 0.00504, 1000000, 8192, true),
];

// ---- Gemini 系列 ----
const geminiModels: ModelDef[] = [
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.007),
			output: per1M(0.04),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0012),
			output: per1M(0.01),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	{
		id: "gemini-2.5-flash-lite",
		name: "Gemini 2.5 Flash Lite",
		reasoning: false,
		input: ["text", "image"],
		cost: {
			input: per1M(0.0004),
			output: per1M(0.0016),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	{
		id: "gemini-3-pro-preview",
		name: "Gemini 3 Pro Preview",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.008),
			output: per1M(0.048),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash Preview",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: per1M(0.002),
			output: per1M(0.012),
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	model(
		"gemini-2.5-flash-image-preview",
		"Gemini 2.5 Flash Image Preview",
		0.0015,
		0.15,
		1000000,
		64000,
		false,
	),
	// 这些图像模型按张计费；Pi 的 token 成本字段无法表示该费用，因此保留为 0。
	model(
		"gemini-3-pro-image-preview",
		"Gemini 3 Pro Image Preview",
		0,
		0,
		1000000,
		64000,
		false,
	),
	model(
		"gemini-3.1-flash-image-preview",
		"Gemini 3.1 Flash Image Preview",
		0.0025,
		0.3,
		1000000,
		64000,
		false,
	),
	model(
		"gemini-3.1-pro-preview",
		"Gemini 3.1 Pro Preview",
		0.008,
		0.048,
		1000000,
		64000,
		true,
	),
	model(
		"gemini-3.1-flash-lite-preview",
		"Gemini 3.1 Flash Lite Preview",
		0.001,
		0.006,
		1000000,
		64000,
	),
	model(
		"gemini-3.5-flash",
		"Gemini 3.5 Flash",
		0.0075,
		0.045,
		1000000,
		64000,
		true,
	),
];

// =============================================================================
// 合并所有模型
// =============================================================================

// 文档中同一模型可能同时出现在“最新模型”和“快照模型”列表中；按 ID 去重。
const allModels: ModelDef[] = Array.from(
	new Map(
		[
			...gpt56Models,
			// ...gpt5Models,
			// ...documentedOpenAIModels,
			// ...gpt5CAModels,
			// ...gpt4Models,
			// ...gpt4CAModels,
			...deepseekModels,
			// ...qwenModels,
			...kimiModels,
			...glmModels,
			...minimaxModels,
			...geminiModels,
		].map((m) => [m.id, m] as const),
	).values(),
);

// Claude 使用独立 provider（需要 Anthropic Messages API）
const claudeModelsForProvider: ModelDef[] = [...claudeModels];

// =============================================================================
// Extension 入口
// =============================================================================

export default function (pi: ExtensionAPI) {
	// =======================================================================
	// Provider 1: ChatAnywhere — OpenAI 兼容模型
	// 使用 OpenAI Chat Completions API: https://api.chatanywhere.tech/v1/chat/completions
	// =======================================================================
	pi.registerProvider("chatanywhere", {
		name: "ChatAnywhere",
		baseUrl: BASE_URL,
		apiKey: "$CHATANYWHERE_API_KEY",
		api: "openai-completions",

		models: allModels.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			...(m.reasoning
				? {
						thinkingLevelMap: {
							minimal: "low",
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: null,
							max: null,
						} as const,
					}
				: {}),
		})),
	});

	// =======================================================================
	// Provider 2: ChatAnywhere Claude — Claude 模型
	// 使用 Anthropic Messages API: https://api.chatanywhere.tech/v1/messages
	// =======================================================================
	pi.registerProvider("chatanywhere-claude", {
		name: "ChatAnywhere Claude",
		// ChatAnywhere 的 Claude 端点也是 /v1/messages
		// anthropic-messages API 内部会拼接 /v1/messages，所以 baseUrl 设为不含 /v1 的根地址
		baseUrl: "https://api.chatanywhere.tech",
		apiKey: "$CHATANYWHERE_API_KEY",
		api: "anthropic-messages",

		models: claudeModelsForProvider.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			thinkingLevelMap: {
				minimal: null,
				low: null,
				medium: "default",
				high: "default",
				xhigh: null,
				max: null,
			},
			compat: {
				forceAdaptiveThinking: true,
			},
		})),
	});
}
