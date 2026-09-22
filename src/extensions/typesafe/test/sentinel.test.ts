/**
 * typesafe/sentinel.test.ts — 明文 key 零暴露（typesafe-todo#1 验收标准 4）
 *
 * 做法：用一枚**唯一的哨兵 key** 跑完整链路（工具 handler + 真实 CLI 子进程 + 真实
 * HTTP server），把每一步的可见产物（工具 content/details、CLI stdout/stderr、错误
 * 消息）拼起来扫哨兵串。同时反向断言「请求确实带了哨兵」——否则测试是空转的。
 *
 * 覆盖的泄漏窗口：成功路径、HTTP 错误（服务端把 Authorization 回显进响应体）、
 * 响应不是 JSON、以及底层异常文本里带 key 的情况。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

import typesafeExtension from "../index.ts";
import { askTypesafe } from "../client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "cli.ts");
const SENTINEL = "sk-typesafe-SENTINEL-0000-DO-NOT-LEAK";
const STATE = "工单：Stripe 集成三天不通，客户要求赔偿。";
const QUESTIONS = { urgency: { type: "noul", instructions: "是否表达紧迫性" } };

interface CapturedTool {
	execute: (
		id: string,
		params: { state: string; questions: unknown },
		signal?: AbortSignal,
	) => Promise<{ content: { text: string }[]; details: unknown; isError?: boolean }>;
}

function captureTool(): CapturedTool {
	let tool: CapturedTool | undefined;
	typesafeExtension({
		registerProvider: (_p: Provider) => {},
		registerTool: (t: CapturedTool) => {
			tool = t;
		},
	} as unknown as ExtensionAPI);
	if (tool === undefined) throw new Error("扩展未注册工具");
	return tool;
}

async function startServer(status: number, body: string): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
	const seen: string[] = [];
	const server = createServer((req, res) => {
		seen.push(String(req.headers.authorization ?? ""));
		req.resume();
		req.on("end", () => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(body);
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

function runCli(env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI_PATH, "--state", STATE, "--questions", JSON.stringify(QUESTIONS)], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
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

test("sentinel: 成功路径的可见产物不含明文 key", async () => {
	const answer = JSON.stringify({ model: "jev-1.13.0", answers: { urgency: { type: "noul", noul: 1 } } });
	const api = await startServer(200, answer);
	const env: NodeJS.ProcessEnv = { ...process.env, TYPESAFE_API_KEY: SENTINEL, TYPESAFE_BASE_URL: api.url };
	const previousKey = process.env.TYPESAFE_API_KEY;
	const previousBase = process.env.TYPESAFE_BASE_URL;
	process.env.TYPESAFE_API_KEY = SENTINEL;
	process.env.TYPESAFE_BASE_URL = api.url;

	try {
		const tool = captureTool();
		const result = await tool.execute("call-1", { state: STATE, questions: QUESTIONS });
		const cli = await runCli(env);

		const visible = `${JSON.stringify(result)}\n${result.content[0].text}\n${cli.stdout}\n${cli.stderr}`;
		assert.ok(!visible.includes(SENTINEL), "成功路径的任何可见产物都不得含明文 key");

		// 反向断言：key 确实被用上了（否则本测试空转）
		assert.equal(api.seen.length, 2);
		assert.deepEqual(api.seen, [`Bearer ${SENTINEL}`, `Bearer ${SENTINEL}`]);
		assert.equal(cli.code, 0);
	} finally {
		process.env.TYPESAFE_API_KEY = previousKey;
		process.env.TYPESAFE_BASE_URL = previousBase;
		await api.close();
	}
});

test("sentinel: 服务端把 key 回显进错误响应体时，错误消息仍不含 key", async () => {
	// 恶意/调试中的服务端把 Authorization 原样回进 body——错误消息绝不许透传响应体。
	const api = await startServer(401, JSON.stringify({ error: `bad key: Bearer ${SENTINEL}` }));
	const env: NodeJS.ProcessEnv = { ...process.env, TYPESAFE_API_KEY: SENTINEL, TYPESAFE_BASE_URL: api.url };
	const previousKey = process.env.TYPESAFE_API_KEY;
	const previousBase = process.env.TYPESAFE_BASE_URL;
	process.env.TYPESAFE_API_KEY = SENTINEL;
	process.env.TYPESAFE_BASE_URL = api.url;

	try {
		const tool = captureTool();
		const result = await tool.execute("call-2", { state: STATE, questions: QUESTIONS });
		const cli = await runCli(env);
		assert.equal(result.isError, true);
		assert.equal(cli.code, 1);

		const visible = `${JSON.stringify(result)}\n${result.content[0].text}\n${cli.stdout}\n${cli.stderr}`;
		assert.ok(!visible.includes(SENTINEL), "错误路径的可见产物不得含明文 key");
		assert.match(cli.stderr, /HTTP 401/);
		assert.equal(api.seen.length, 2);
	} finally {
		process.env.TYPESAFE_API_KEY = previousKey;
		process.env.TYPESAFE_BASE_URL = previousBase;
		await api.close();
	}
});

test("sentinel: 响应不是 JSON 时也只报静态消息", async () => {
	const api = await startServer(200, `<html>Bearer ${SENTINEL}</html>`);
	const previousBase = process.env.TYPESAFE_BASE_URL;
	process.env.TYPESAFE_BASE_URL = api.url;
	try {
		const result = await askTypesafe({
			state: STATE,
			questions: QUESTIONS,
			baseUrl: api.url,
			resolveKey: () => SENTINEL,
		});
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "BAD_RESPONSE");
			assert.ok(!result.message.includes(SENTINEL));
		}
	} finally {
		process.env.TYPESAFE_BASE_URL = previousBase;
		await api.close();
	}
});

test("sentinel: 底层异常文本带 key 也不穿透到错误消息", async () => {
	const result = await askTypesafe({
		state: STATE,
		questions: QUESTIONS,
		resolveKey: () => SENTINEL,
		fetchFn: async () => {
			throw new Error(`socket hang up while sending Bearer ${SENTINEL}`);
		},
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.code, "NETWORK");
		assert.ok(!result.message.includes(SENTINEL), "底层异常文本不得穿透");
	}
});
