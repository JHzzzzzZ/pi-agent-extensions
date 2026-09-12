/**
 * ChatAnywhere 模型目录（定价/元数据）
 *
 * 模型定义只作为“元数据目录”使用：扩展启动时向 ChatAnywhere 探测可用模型
 * （OpenAI 兼容 GET {base}/models，见 discover.ts probeModels），命中目录的
 * 模型取本目录的定价/规格（CA币/1M tokens 成本、上下文窗口、输入类型、是否
 * 推理模型）；目录外的新模型按接口元数据兜底注册（“未定价”，见 discover.ts），
 * 因此新模型会自动出现，无需改动本文件。
 *
 * 家族线（MODEL_LINES）是归并去重的依据：每条线按“同种取最新、每线最多 3 个
 * 档位”收敛（见 discover.ts collapse）。目录内同一模型可能以别名（无日期）与
 * 快照（带日期）重复出现，MODEL_DEFS 按 id 去重。
 */

// 辅助: CA币/1K 转 CA币/1M（用于 Pi 的成本跟踪）
const per1M = (per1K: number) => per1K * 1000;

export interface ModelDef {
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
];

// ---- GLM 系列 ----
const glmModels: ModelDef[] = [
	// GLM-5.2 官方规格：1M 上下文；GLM-5 系列最大生成长度为 131,072。
	model("glm-5.2", "GLM-5.2", 0.0064, 0.0224, 1048576, 131072, true, ["text"]),
];

// ---- Claude 系列（通过 Anthropic Messages API） ----
const claudeModels: ModelDef[] = [
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
];

// ---- Gemini 系列 ----
const geminiModels: ModelDef[] = [
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
// 家族线（MODEL_LINES）与目录导出
// =============================================================================

export const CATALOG_GROUPS: ModelDef[][] = [
  gpt56Models,
  gpt5Models,
  documentedOpenAIModels,
  gpt5CAModels,
  gpt4Models,
  gpt4CAModels,
  deepseekModels,
  qwenModels,
  kimiModels,
  glmModels,
  claudeModels,
  minimaxModels,
  geminiModels,
];

// 同一模型可能同时出现在“最新模型”和“快照模型”列表中；按 id 去重。
export const MODEL_DEFS: ModelDef[] = Array.from(
  new Map(CATALOG_GROUPS.flat().map((m) => [m.id, m] as const)).values(),
);

/** 家族线的版本语法：dot = 前缀后跟 ".N"（gpt-5.6）；dash = "-N-M"（claude-opus-4-8）；none = 版本内嵌于前缀（gpt-4.1/qwen3.5/…） */
export type VersionStyle = "dot" | "dash" | "none";

/** 家族线：prefix 匹配 id 前缀；tiers 为该线已知档位名（base = 无档位后缀）；cap = 该线最多注册档位数 */
export interface ModelLine {
  name: string;
  prefix: string;
  version: VersionStyle;
  tiers: string[];
  cap: number;
}

export const LINE_TIER_CAP = 3;

/** 家族线表：顺序即注册输出顺序；版本/日期/档位解析见 discover.ts classifyId */
export const MODEL_LINES: ModelLine[] = [
  { name: "gpt-5", prefix: "gpt-5", version: "dot", tiers: ["sol", "terra", "luna", "mini", "nano", "codex", "pro", "search-api", "chat-latest"], cap: LINE_TIER_CAP },
  { name: "gpt-4.1", prefix: "gpt-4.1", version: "none", tiers: ["mini", "nano"], cap: LINE_TIER_CAP },
  { name: "gpt-4o", prefix: "gpt-4o", version: "none", tiers: ["mini-search-preview", "search-preview", "mini"], cap: LINE_TIER_CAP },
  { name: "gpt-4", prefix: "gpt-4", version: "none", tiers: [], cap: LINE_TIER_CAP },
  { name: "gpt-3.5", prefix: "gpt-3.5", version: "none", tiers: ["turbo-instruct", "turbo-16k", "turbo"], cap: LINE_TIER_CAP },
  { name: "gpt-oss", prefix: "gpt-oss", version: "none", tiers: ["120b", "20b"], cap: LINE_TIER_CAP },
  { name: "o3", prefix: "o3", version: "none", tiers: ["mini"], cap: LINE_TIER_CAP },
  { name: "o4-mini", prefix: "o4-mini", version: "none", tiers: [], cap: LINE_TIER_CAP },
  { name: "deepseek-v4", prefix: "deepseek-v4", version: "none", tiers: ["flash", "pro"], cap: LINE_TIER_CAP },
  { name: "qwen3.5", prefix: "qwen3.5", version: "none", tiers: ["397b-a17b", "plus"], cap: LINE_TIER_CAP },
  { name: "qwen3", prefix: "qwen3", version: "none", tiers: ["coder-480b-a35b-instruct", "coder-plus", "max", "235b-a22b-instruct", "235b-a22b"], cap: LINE_TIER_CAP },
  { name: "kimi-k2.7", prefix: "kimi-k2.7", version: "none", tiers: ["code"], cap: LINE_TIER_CAP },
  { name: "glm-5", prefix: "glm-5", version: "dot", tiers: [], cap: LINE_TIER_CAP },
  { name: "minimax-m3", prefix: "minimax-m3", version: "none", tiers: [], cap: LINE_TIER_CAP },
  { name: "gemini-3.5", prefix: "gemini-3.5", version: "none", tiers: ["flash"], cap: LINE_TIER_CAP },
  { name: "claude-opus", prefix: "claude-opus", version: "dash", tiers: [], cap: LINE_TIER_CAP },
  { name: "claude-sonnet", prefix: "claude-sonnet", version: "dash", tiers: [], cap: LINE_TIER_CAP },
  { name: "claude-haiku", prefix: "claude-haiku", version: "dash", tiers: [], cap: LINE_TIER_CAP },
  { name: "claude-fable", prefix: "claude-fable", version: "dash", tiers: [], cap: LINE_TIER_CAP },
];

/** 非 chat 模型 id：不参与注册（embedding/tts/whisper/生图/转写/旧 completions/斜杠重复别名） */
export const NON_CHAT_ID_PATTERNS: RegExp[] = [
  /^text-embedding-/,
  /^tts-/,
  /^whisper-/,
  /^gpt-image-/,
  /-transcribe$/,
  /-image-preview$/,
  /^davinci-/,
  /\//, // openai/gpt-oss-120b 这类斜杠前缀是重复别名
];

export const isNonChatId = (id: string): boolean => NON_CHAT_ID_PATTERNS.some((re) => re.test(id));

/** 旧代整代过滤：家族前缀版本低于 min 一律不注册（“同系列旧版全删，仅保留最新代”） */
export interface GenerationFloor {
  versionRe: RegExp;
  min: readonly number[];
  /** 家族名下无版本号的旧代命名（如 deepseek-chat）也视为低于下限 */
  bare?: RegExp;
}

export const GENERATION_FLOORS: GenerationFloor[] = [
  { versionRe: /^gpt-(\d+(?:\.\d+)*)/, bare: /^gpt-/, min: [5, 6] }, // GPT-4.x/3.5/oss 旧代删除；5.6 与 6 保留
  { versionRe: /^o(\d+(?:\.\d+)*)/, min: [4] }, // o1/o3 删除；o4-mini（当前代）保留
  { versionRe: /^gemini-(\d+(?:\.\d+)*)/, min: [3] }, // gemini-2.x 删除
  { versionRe: /^deepseek-v(\d+(?:\.\d+)*)/, bare: /^deepseek-/, min: [4] }, // v3.2 / deepseek-chat 删除
  { versionRe: /^qwen(\d+(?:\.\d+)*)/, min: [3, 5] }, // qwen3 旧代删除；3.5/3.8 保留
  { versionRe: /^kimi-k(\d+(?:\.\d+)*)/, min: [3] }, // k2.x 删除；k3 保留
  { versionRe: /^glm-(\d+(?:\.\d+)*)/, min: [5] }, // glm-4.7 删除
  { versionRe: /^minimax-m(\d+(?:\.\d+)*)/, min: [3] }, // m2.x 删除
];
