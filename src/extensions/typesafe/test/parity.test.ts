/**
 * typesafe/parity.test.ts — 工具与 CLI 走同一条 core（typesafe-todo#1 验收标准 3）
 *
 * 边界口径：这里**不 mock fetch**，而是起一个真实的 `node:http` server 收请求、按真实
 * socket 应答；两条路径都打到它——一条是**扩展真实注册出来的工具 handler**（用假
 * ExtensionAPI 只截获注册调用，handler 本身是真的），另一条是 `spawn` 出来的真实
 * `node cli.ts` 子进程。断言的是「两条路径发出的请求字节级一致、拿回的答案结构一致」，
 * 这是纯函数单测抓不到的东西（接线漂移、进程边界差异）。
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

import typesafeExtension from "../index.ts";
import type { TypeSafeAskResult } from "../client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "cli.ts");

const KEY = "sk-typesafe-test-parity-0003";
const STATE = "客户说 Stripe 连了三天都失败，快要丢单了。";
const QUESTIONS = {
	department: {
		type: "choice",
		instructions: "哪个团队应当处理",
		criteria: { billing: "付款或订阅问题", technical: "故障或集成问题" },
	},
};

const RESPONSE_BODY = {
	model: "jev-1.13.0",
	answers: {
		department: { type: "choice", choice: "technical", confidence: 0.78, probabilities: { technical: 0.85, billing: 0.15 } },
	},
	usage: { input_tokens: 392, output_tokens: 65 },
};

interface Recorded {
	url: string;
	method: string;
	authorization: string;
	contentType: string;
	body: string;
}

/** 起一个记录请求、固定应答的真实 HTTP server；返回它的 baseUrl 与记录数组。 */
async function startFakeApi(status = 200, body: unknown = RESPONSE_BODY): Promise<{ url: string; seen: Recorded[]; close: () => Promise<void> }> {
	const seen: Recorded[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({
				url: req.url ?? "",
				method: req.method ?? "",
				authorization: String(req.headers.authorization ?? ""),
				contentType: String(req.headers["content-type"] ?? ""),
				body: Buffer.concat(chunks).toString("utf8"),
			});
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(typeof body === "string" ? body : JSON.stringify(body));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fake server 未拿到端口");
	return {
		url: `http://127.0.0.1:${address.port}`,
		seen,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

interface CapturedRegistrations {
	provider?: Provider;
	tool?: {
		name: string;
		execute: (
			id: string,
			params: { state: string; questions: unknown; model?: string },
			signal?: AbortSignal,
		) => Promise<{ content: { text: string }[]; details: unknown; isError?: boolean }>;
	};
}

/** 只截获注册调用的假 ExtensionAPI（宿主交互本身不在本测试范围）。 */
function captureRegistrations(): CapturedRegistrations {
	const captured: CapturedRegistrations = {};
	const fakePi = {
		registerProvider: (provider: Provider) => {
			captured.provider = provider;
		},
		registerTool: (tool: CapturedRegistrations["tool"]) => {
			captured.tool = tool;
		},
	} as unknown as ExtensionAPI;
	typesafeExtension(fakePi);
	return captured;
}

function runCliProcess(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

test("parity: 工具与 CLI 的请求体字节级一致，答案结构一致", async () => {
	const api = await startFakeApi();
	const env: NodeJS.ProcessEnv = { ...process.env, TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: api.url };
	const previousKey = process.env.TYPESAFE_API_KEY;
	const previousBase = process.env.TYPESAFE_BASE_URL;
	process.env.TYPESAFE_API_KEY = KEY;
	process.env.TYPESAFE_BASE_URL = api.url;

	try {
		const captured = captureRegistrations();
		assert.ok(captured.tool, "扩展必须注册 typesafe_ask 工具");

		const toolResult = await captured.tool.execute("call-1", { state: STATE, questions: QUESTIONS });
		assert.equal(toolResult.isError, undefined, `工具不应失败：${JSON.stringify(toolResult.content)}`);

		const cli = await runCliProcess(env, ["--state", STATE, "--questions", JSON.stringify(QUESTIONS)]);
		assert.equal(cli.code, 0, `CLI 应成功：${cli.stderr}`);

		assert.equal(api.seen.length, 2, "两条路径各发一次请求");
		const [toolCall, cliCall] = api.seen;

		// 同一端点、同一方法、同一鉴权头、同一 Content-Type
		assert.equal(toolCall.url, "/v1/systemone");
		assert.equal(cliCall.url, "/v1/systemone");
		assert.equal(toolCall.method, "POST");
		assert.equal(cliCall.method, "POST");
		assert.equal(toolCall.authorization, `Bearer ${KEY}`);
		assert.equal(cliCall.authorization, `Bearer ${KEY}`);
		assert.equal(toolCall.contentType, "application/json");
		assert.equal(cliCall.contentType, "application/json");

		// 核心断言：两条路径的请求体字节级一致（同 core 的直接证据）
		assert.equal(toolCall.body, cliCall.body);

		// 答案结构一致：工具 details（调用结果判别联合）与 CLI stdout 解析出的对象相等
		const cliAnswers = JSON.parse(cli.stdout) as TypeSafeAskResult;
		assert.deepEqual(toolResult.details, { ok: true, value: cliAnswers });
		assert.deepEqual(cliAnswers.answers.department.choice, "technical");
	} finally {
		process.env.TYPESAFE_API_KEY = previousKey;
		process.env.TYPESAFE_BASE_URL = previousBase;
		await api.close();
	}
});

test("parity: 无 key 时两条路径都 NO_KEY，且都不发请求", async () => {
	const api = await startFakeApi();
	const env: NodeJS.ProcessEnv = { ...process.env, TYPESAFE_BASE_URL: api.url };
	delete env.TYPESAFE_API_KEY;
	const previousKey = process.env.TYPESAFE_API_KEY;
	const previousBase = process.env.TYPESAFE_BASE_URL;
	delete process.env.TYPESAFE_API_KEY;
	// auth.json 若恰好存在 typesafe 条目会干扰「无 key」前提，故指向空目录
	process.env.PI_CODING_AGENT_DIR = join(HERE, "..", "test", "does-not-exist-agent-dir");
	process.env.TYPESAFE_BASE_URL = api.url;

	try {
		const captured = captureRegistrations();
		const toolResult = await captured.tool?.execute("call-2", { state: STATE, questions: QUESTIONS });
		assert.equal(toolResult?.isError, true);
		assert.match(String(toolResult?.content[0].text), /NO_KEY/);

		const cli = await runCliProcess(env, ["--state", STATE, "--questions", JSON.stringify(QUESTIONS)]);
		assert.equal(cli.code, 1);
		assert.match(cli.stderr, /NO_KEY/);
		assert.equal(api.seen.length, 0, "缺 key 必须 fail-closed，两条路径都不能发请求");
	} finally {
		process.env.TYPESAFE_API_KEY = previousKey;
		process.env.TYPESAFE_BASE_URL = previousBase;
		delete process.env.PI_CODING_AGENT_DIR;
		await api.close();
	}
});
