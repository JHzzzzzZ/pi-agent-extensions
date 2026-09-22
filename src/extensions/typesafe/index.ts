/**
 * typesafe — Pi 扩展入口（typesafe-todo#1）
 *
 * 只做两件事，两件事都靠 Pi 自己的机制、不打补丁：
 *
 * 1. **登录界面**：把 TypeSafe 注册成一个 provider。`/login` 的菜单是按
 *    `provider.auth.apiKey` 是否存在来构建的（与模型数量无关，见
 *    `docs/specs/typesafe-login.md` 的源码证据），所以零模型 provider 也会出现；
 *    `interaction.prompt({ type: "secret" })` 提供**遮罩**输入，确认后 Pi 自己把
 *    `{ type: "api_key", key }` 写进 `~/.pi/agent/auth.json` 的 `typesafe` 条目。
 * 2. **调用通道**：注册 `typesafe_ask` 工具。取 key 走 credential.ts，发请求走
 *    client.ts（与 cli.ts 同一个 core）。
 *
 * 安全不变量（todos/align/typesafe-todo#1.md 范围 4）：明文 key 只在 credential.ts →
 * client.ts 的请求头拼装之间短暂存在。工具结果的 `details` 就是调用结果判别联合本身
 * （成功只有 Jev 的答案，失败只有静态码与静态消息），两条分支都不含凭据；错误文本也
 * 不回显响应体、请求头或 key。本扩展**没有**任何读取或打印凭据的工具/参数。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { askTypesafe, resolveBaseUrl, type TypeSafeAskResult, type TypeSafeResult } from "./client.ts";
import { ENV_KEY, resolveKeyFromDisk } from "./credential.ts";

/** provider id / auth.json 条目键（`/login` 菜单里显示的 id）。 */
export const PROVIDER_ID = "typesafe";
/** 工具名。 */
export const TOOL_NAME = "typesafe_ask";

/** TypeSafe 没有聊天模型；误当模型用时给出确定性的失败，而不是静默发往兼容端点。 */
const NO_CHAT_MODELS = "typesafe provider 不提供聊天模型：它只接受结构化问题，请用 typesafe_ask 工具或 cli.ts";

/** 把答案渲染成紧凑文本（模型/用量 + 每个问题的答案与置信度）。 */
export function formatAnswers(result: TypeSafeAskResult): string {
	const lines = [`model: ${result.model}`];
	for (const [id, answer] of Object.entries(result.answers)) {
		const parts: string[] = [`type=${answer.type}`];
		if (answer.type === "choice") parts.push(`choice=${String(answer.choice)}`);
		if (answer.type === "score") parts.push(`score=${String(answer.score)}`);
		if (answer.type === "noul") parts.push(`noul=${String(answer.noul)}`);
		if (answer.confidence !== undefined) parts.push(`confidence=${String(answer.confidence)}`);
		lines.push(`${id}: ${parts.join(" ")}`);
		if (answer.probabilities !== undefined) lines.push(`  probabilities: ${JSON.stringify(answer.probabilities)}`);
	}
	if (result.usage !== undefined) lines.push(`usage: ${JSON.stringify(result.usage)}`);
	return lines.join("\n");
}

export default function typesafeExtension(pi: ExtensionAPI): void {
	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "TypeSafe",
			baseUrl: resolveBaseUrl(),
			auth: {
				apiKey: {
					name: "TypeSafe API key",
					async login(interaction) {
						const entered = await interaction.prompt({
							type: "secret",
							message: "TypeSafe API key",
						});
						const key = entered.trim();
						if (key === "") throw new Error("TypeSafe API key 不能为空");
						return { type: "api_key", key };
					},
					async resolve({ ctx, credential }) {
						const stored = credential?.key;
						const key = stored !== undefined && stored.trim() !== "" ? stored.trim() : await ctx.env(ENV_KEY);
						if (key === undefined || key.trim() === "") return undefined;
						return {
							auth: { apiKey: key.trim() },
							source: stored !== undefined && stored.trim() !== "" ? "stored API key" : ENV_KEY,
						};
					},
				},
			},
			models: [],
			api: {
				stream() {
					throw new Error(NO_CHAT_MODELS);
				},
				streamSimple() {
					throw new Error(NO_CHAT_MODELS);
				},
			},
		}),
	);

	pi.registerTool({
		name: TOOL_NAME,
		label: "TypeSafe Ask",
		description:
			"用 TypeSafe（Jev，System One）对一段 state 做结构化判断：questions 里每个问题用 type 选原语——choice（从给定选项里选一个）、score（按给定的有序档位打分）、noul（一个命题为真的概率）。返回每个问题的答案与 probabilities/confidence。没有 key 时先用 /login typesafe 录入。",
		parameters: Type.Object({
			state: Type.String({ description: "要做判断的材料：工单正文、消息、文档片段、记录等（原样传给模型）" }),
			questions: Type.Any({
				description:
					'问题表：{"<id>": {"type":"choice"|"score"|"noul", "instructions":"<问什么>", "criteria": <选项对象|档位数组|可省略>}}。至少一个问题。',
			}),
			model: Type.Optional(Type.String({ description: "TypeSafe 模型 id，默认 jev-latest" })),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await askTypesafe({
				state: params.state,
				questions: params.questions,
				model: params.model,
				baseUrl: resolveBaseUrl(),
				resolveKey: () => resolveKeyFromDisk(),
				signal,
			});
			// 两条分支共用同一判别联合类型：否则 TS 按首个 return 分支推断 details 泛型，
			// 成功分支就会被判为不兼容（typecheck 实测）。
			const details: TypeSafeResult<TypeSafeAskResult> = result;
			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `${result.code}: ${result.message}` }],
					details,
					isError: true,
				};
			}
			return {
				content: [{ type: "text" as const, text: formatAnswers(result.value) }],
				details,
			};
		},
	});
}
