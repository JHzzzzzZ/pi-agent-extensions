/**
 * Merged-entry contract tests (v2.0.0): the single `pwr/index.ts` entry must
 * register the complete PWR surface — the four workflow tools, all commands
 * (/workflow generation + colon sub-commands), the UI shortcuts and the
 * run-entry renderer — with the PRD §6.2 contracts. `workflow_validate`
 * takes `{ source, argsSchema? }` and fails with ENGINE_UNAVAILABLE until
 * the engine is resolved at session_start (never the structural gate).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pwrExtension from "../index.ts";
import { ErrorCode } from "../src/errors.ts";
import { PWR_GENERATION_CUSTOM_TYPE, PWR_RESULT_CUSTOM_TYPE, PWR_RUN_ENTRY } from "../src/types.ts";
import { RunnerError, RunnerErrorCodes } from "../runner/errors.ts";
import { runtime as rt } from "../runtime/index.ts";

interface FakeTool {
	name?: string;
	parameters?: Record<string, unknown>;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>;
}

function register(options: { cwd?: string } = {}) {
	const tools: FakeTool[] = [];
	const commands: string[] = [];
	const commandHandlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const shortcuts: string[] = [];
	const renderers: string[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const sentMessages: Array<{ message: { customType?: string; content?: string }; options?: unknown }> = [];
	const pi = {
		registerTool(def: FakeTool) {
			tools.push(def);
		},
		registerCommand(name: string, opts?: { handler?: (args: string, ctx: unknown) => Promise<void> }) {
			commands.push(name);
			if (opts?.handler) commandHandlers.set(name, opts.handler);
		},
		registerShortcut(key: string) {
			shortcuts.push(key);
		},
		registerEntryRenderer(key: string) {
			renderers.push(key);
		},
		on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		sendMessage(message: unknown, options: unknown) {
			sentMessages.push({ message: message as { customType?: string; content?: string }, options });
		},
		getFlag(name?: string) {
			return name === "cwd" ? options.cwd : undefined;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	};
	pwrExtension(pi as never);
	return { tools, commands, commandHandlers, shortcuts, renderers, handlers, entries, sentMessages };
}

test("merged entry registers the full tool set with PRD §6.2 contracts", () => {
	const { tools } = register();
	const names = tools.map((t) => t.name).sort();
	assert.deepEqual(names, ["workflow_control", "workflow_save", "workflow_start", "workflow_validate"]);

	const validate = tools.find((t) => t.name === "workflow_validate");
	assert.ok(validate, "workflow_validate must be registered");
	const params = validate!.parameters as { properties?: Record<string, unknown> };
	assert.ok(params.properties?.source, "params must declare source");
	assert.ok(params.properties?.argsSchema, "params must declare optional argsSchema");

	const save = tools.find((t) => t.name === "workflow_save")!;
	const saveParams = save.parameters as { properties?: Record<string, unknown> };
	assert.ok(saveParams.properties?.overwrite, "workflow_save declares the optional overwrite flag (JHL-17)");
});

test("merged entry registers the colon command surface, shortcuts and the run-entry renderer", () => {
	const { commands, shortcuts, renderers } = register();
	assert.deepEqual(commands, [
		"workflow",
		"workflow:run",
		"workflow:delete",
		"workflow:model",
		"workflows",
		"workflows:list",
		"workflows:view",
		"workflows:open",
		"workflows:pause",
		"workflows:resume",
		"workflows:stop",
		"workflows:restart",
		"workflows:save",
		"workflows:saved",
		"workflows:script",
		"workflows:approve",
		"workflows:help",
	]);
	assert.ok(!commands.includes("workflow-delete"), "hyphen command retired (now /workflow:delete)");
	assert.ok(!commands.includes("pwr-model"), "hyphen command retired (now /workflow:model)");
	assert.equal(shortcuts.length, 3, "pause/stop/restart shortcuts registered (JHL-15)");
	assert.deepEqual(renderers, [PWR_RUN_ENTRY], "run entry renderer registered (JHL-15)");
});

test("bare /workflow keeps generation；旧子命令词只提示改名不生成", async () => {
	const { commandHandlers, sentMessages } = register();
	const notifyCalls: Array<{ text: string; type: string }> = [];
	const ctx = { ui: { notify: (text: string, type: string) => notifyCalls.push({ text, type }) } } as never;
	const handler = commandHandlers.get("workflow");
	assert.ok(handler, "/workflow 命令 handler 可调用");

	for (const head of ["run", "delete", "model"]) {
		await handler!(head, ctx);
		assert.equal(sentMessages.length, 0, `/${head} 不得触发生成回合`);
		assert.match(notifyCalls.at(-1)?.text ?? "", new RegExp(`已改名为「/workflow:${head}」`));
	}

	await handler!("", ctx);
	assert.equal(sentMessages.length, 0, "空参 = 用法提示，不生成");
	assert.match(notifyCalls.at(-1)?.text ?? "", /Usage: \/workflow <task description>/);

	await handler!("audit the routes", ctx);
	assert.equal(sentMessages.length, 1, "普通任务文本仍走生成回合");
	assert.equal(sentMessages[0]!.message.customType, PWR_GENERATION_CUSTOM_TYPE);
});

test("bare /workflows：旧子命令词只提示改名；自由形态（help/空参=列表）保留", async () => {
	const { commandHandlers } = register();
	const notifyCalls: Array<{ text: string; type: string }> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (text: string, type: string) => notifyCalls.push({ text, type }),
			setStatus() {},
			setWidget() {},
		},
		sessionManager: { getEntries: () => [] },
	} as never;
	const handler = commandHandlers.get("workflows");
	assert.ok(handler, "/workflows 命令 handler 可调用");

	for (const head of ["list", "view", "pause", "approve"]) {
		notifyCalls.length = 0;
		await handler!(head, ctx);
		assert.equal(notifyCalls.at(-1)?.type, "warning", `/${head} 提示为 warning`);
		assert.match(notifyCalls.at(-1)?.text ?? "", new RegExp(`已改名为「/workflows:${head}」`));
	}

	notifyCalls.length = 0;
	await handler!("help", ctx);
	assert.match(notifyCalls.at(-1)?.text ?? "", /colon command surface/, "裸词 help 仍显示帮助");

	notifyCalls.length = 0;
	await handler!("", ctx);
	assert.ok(!(notifyCalls.at(-1)?.text ?? "").includes("已改名"), "空参=列表，不是改名提示");

	const listHandler = commandHandlers.get("workflows:list");
	assert.ok(listHandler, "冒号 list 命令可调用");
	notifyCalls.length = 0;
	await listHandler!("", ctx);
	assert.ok((notifyCalls.at(-1)?.text ?? "").length > 0, "冒号 list handler 有输出");
});

test("merged entry: workflow_validate fails with ENGINE_UNAVAILABLE until session_start resolves the engine", async () => {
	const { tools } = register();
	const validate = tools.find((t) => t.name === "workflow_validate")!;
	const outcome = await validate.execute("t1", { source: `export const meta = { name: 'a' }\nawait agent('x')` });
	const details = outcome.details as { code?: string };
	assert.equal(details.code, ErrorCode.ENGINE_UNAVAILABLE, "no engine -> ENGINE_UNAVAILABLE, never the structural gate");
});

test("approval card appears as soon as workflow_validate succeeds (no workflow_start needed)", async () => {
	const { tools, handlers } = register();

	const sessionStart = handlers.get("session_start")?.[0];
	assert.ok(sessionStart, "session_start handler must be registered");
	const selects: Array<{ title: string; options: string[] }> = [];
	const notifyCalls: Array<{ text: string; type: string }> = [];
	const fakeCtx = {
		sessionManager: { getEntries: () => [] },
		isProjectTrusted: () => false,
		model: undefined,
		hasUI: true,
		ui: {
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return undefined; // dismiss the card
			},
			notify(text: string, type: string) {
				notifyCalls.push({ text, type });
			},
			setStatus() {},
			setWidget() {},
		},
	};
	await (sessionStart as (e: unknown, ctx: unknown) => unknown)({}, fakeCtx);

	const validate = tools.find((t) => t.name === "workflow_validate")!;
	const outcome = await validate.execute("t1", { source: `export const meta = { name: 'a' }\nawait agent('x')` });
	assert.ok(!outcome.isError, "valid script must validate (isError only set on failure)");
	const runId = (outcome.details as { runId?: string }).runId;
	assert.ok(runId, "validation returns a runId");

	const toolResult = handlers.get("tool_result")?.[0];
	assert.ok(toolResult, "tool_result handler must be registered");
	await (toolResult as (e: unknown, ctx: unknown) => unknown)(
		{ toolName: "workflow_validate", isError: false, details: { runId }, content: [] },
		fakeCtx,
	);

	assert.ok(selects.length >= 1, "approval card must be shown after validation succeeds");
	assert.match(selects[0]!.title, /Approve workflow/);
	assert.ok(selects[0]!.options.includes("Run once"), "card offers Run once");
	assert.ok(selects[0]!.options.includes("Reject"), "card offers Reject");
	assert.ok(notifyCalls.some((n) => n.text.includes("Stages")), "approval card notifies the plan summary");
});

test("会话生命周期接线：session_shutdown 中止在途 run，新会话 session_start 复活单例 runtime", async () => {
	// pi 0.85.1 在 /new、/resume、/fork、/clone、exit 时都会发 session_shutdown
	// （顺序：shutdown 先于新 session_start）。接线契约：shutdown() 中止在途
	// 控制器并把非终态 run 标记 cancelled；session_start 用 revive() 复位
	// SESSION_SHUTDOWN 闩锁——模块级单例跨会话复用，不复位则 /new 一次后
	// start() 永久抛 SESSION_SHUTDOWN。
	const { handlers } = register();
	const fakeCtx = {
		sessionManager: { getEntries: () => [] },
		isProjectTrusted: () => false,
		model: undefined,
		hasUI: true,
		ui: {
			select: async () => undefined,
			notify() {},
			setStatus() {},
			setWidget() {},
		},
	};
	const sessionStart = handlers.get("session_start")?.[0];
	assert.ok(sessionStart, "session_start handler must be registered");
	await (sessionStart as (e: unknown, ctx: unknown) => unknown)({}, fakeCtx);

	const sessionShutdown = handlers.get("session_shutdown")?.[0];
	assert.ok(sessionShutdown, "session_shutdown handler must be registered");

	// 在途 run：runner 永不返回（真实 abort 语义下会被 SIGTERM/SIGKILL，
	// 这里只验证状态迁移，不派真进程）。
	rt.setRunner({
		run: () => new Promise(() => {}),
	});
	const source = `export const meta = { name: 'a' }\nawait agent('x')`;
	const script = { scriptId: "s", digest: "d", source, meta: { name: "a" }, astVersion: "1" };
	await rt.start({ runId: "run-shutdown-1", script });
	assert.equal(rt.view("run-shutdown-1").status, "running");

	await (sessionShutdown as (e: unknown, ctx: unknown) => unknown)({}, fakeCtx);
	assert.equal(rt.view("run-shutdown-1").status, "cancelled", "session_shutdown must cancel in-flight runs");

	// 新会话：session_start 先于一切 run 请求触发，runtime 必须可用。
	await (sessionStart as (e: unknown, ctx: unknown) => unknown)({}, fakeCtx);
	const restarted = await rt.start({ runId: "run-shutdown-2", script });
	assert.equal(restarted.status, "running", "new session must revive the singleton runtime (no SESSION_SHUTDOWN)");

	// 收尾：中止测试自己拉起的在途 run，不泄漏到后续用例。
	await (sessionShutdown as (e: unknown, ctx: unknown) => unknown)({}, fakeCtx);
});

test("运行时失败经磁盘桥写入富条目", async () => {
	// 静态导入与入口 resolveRuntime() 的 `./runtime/index.ts` 动态导入解析到
	// 同一模块 URL —— ESM 模块缓存保证拿到同一个单例 runtime，无需动态导入。
	const { tools, handlers, entries, sentMessages } = register();
	const sessionStart = handlers.get("session_start")?.[0];
	assert.ok(sessionStart, "session_start handler must be registered");
	const fakeCtx = {
		sessionManager: { getEntries: () => [] },
		isProjectTrusted: () => false,
		model: undefined,
		hasUI: true,
		ui: {
			select: async () => undefined,
			notify() {},
			setStatus() {},
			setWidget() {},
		},
	};
	await (sessionStart as (e: unknown, ctx: unknown) => unknown)({}, fakeCtx);

	// 覆盖 session_start 注入的真实 runner：统一抛 RunnerError。
	rt.setRunner({
		run: async () => {
			throw new RunnerError(RunnerErrorCodes.AGENT_EXECUTION_ERROR, "boom");
		},
	});

	const source = `export const meta = { name: 'a' }\nawait agent('x')`;
	const validate = tools.find((t) => t.name === "workflow_validate")!;
	const outcome = await validate.execute("t1", { source });
	assert.ok(!outcome.isError, "valid script must validate");
	const runId = (outcome.details as { runId?: string }).runId;
	assert.ok(runId, "validation returns a runId");

	// run_status 事件是磁盘桥写盘的同步前驱（桥 handler 在 session_start 先
	// 注册、同一次 emit 循环内先执行），事件一到条目必然已 append，无需轮询。
	// tsconfig 目标 ES2022（lib 无 Promise.withResolvers），用执行器形式。
	const failedEvent = new Promise<void>((resolve) => {
		rt.onEvent((ev) => {
			if (ev.type === "run_status" && ev.runId === runId && ev.status === "failed") resolve();
		});
	});

	// runtime.start 不校验批准（批准在 startWorkflow 层）；runId 只用作键。
	await rt.start({ runId, script: { scriptId: "s", digest: "d", source, meta: { name: "a" }, astVersion: "1" } });
	await failedEvent;

	const rich = entries
		.filter((e) => e.type === PWR_RUN_ENTRY && (e.data as { runId?: string }).runId === runId)
		.at(-1)!.data as {
		status?: string;
		errorCode?: string;
		errorMessage?: string;
		tasks?: Array<{ status?: string; errorCode?: string; errorMessage?: string }>;
	};
	assert.equal(rich.status, "failed");
	// run 级 code/message 经解释器 normalizeRuntimeError 包裹；任务级字段精确。
	assert.equal(rich.errorCode, "SCRIPT_RUNTIME_ERROR");
	assert.ok(rich.errorMessage?.includes("boom"), "run-level errorMessage carries the detail");
	assert.equal(rich.tasks?.length, 1);
	assert.equal(rich.tasks![0]!.status, "failed");
	assert.equal(rich.tasks![0]!.errorCode, "AGENT_EXECUTION_ERROR");
	assert.equal(rich.tasks![0]!.errorMessage, "boom");

	// 失败 run settle 后主 agent 被唤起：pwr-workflow-result + followUp。
	const wake = sentMessages.at(-1);
	assert.ok(wake, "failed run must send a result message to the main agent");
	assert.equal(wake.message.customType, PWR_RESULT_CUSTOM_TYPE);
	assert.ok(wake.message.content?.includes("failed"), "message reports the failure");
	assert.ok(wake.message.content?.includes("boom"), "message carries the error detail");
	assert.deepEqual(wake.options, { triggerTurn: true, deliverAs: "followUp" });
});

// ===== solo 审批门（docs/cross/solo-approval-gate.md） =====

/** 写一个本进程 pid 的 solo 状态文件并注入 PI_SOLO_MODE_FILE，返回清理函数 */
function enableSolo(): () => void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-solo-entry-"));
	const file = path.join(dir, "solo-mode.json");
	fs.writeFileSync(file, JSON.stringify({ pid: process.pid, activatedAt: "2026-08-05T12:00:00Z" }), "utf8");
	const previous = process.env.PI_SOLO_MODE_FILE;
	process.env.PI_SOLO_MODE_FILE = file;
	return () => {
		if (previous === undefined) delete process.env.PI_SOLO_MODE_FILE;
		else process.env.PI_SOLO_MODE_FILE = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	};
}

function makeUiCtx(selects: Array<{ title: string; options: string[] }>, notifyCalls: Array<{ text: string; type: string }>, overrides: Record<string, unknown> = {}) {
	return {
		sessionManager: { getEntries: () => [] },
		isProjectTrusted: () => false,
		model: undefined,
		hasUI: true,
		ui: {
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return undefined; // dismiss the card
			},
			notify(text: string, type: string) {
				notifyCalls.push({ text, type });
			},
			setStatus() {},
			setWidget() {},
		},
		...overrides,
	};
}

test("solo 审批门：workflow_validate 不弹批准卡（按 once 自动批准），workflow_start 直接放行", async () => {
	const cleanup = enableSolo();
	try {
		const { tools, handlers } = register();
		const selects: Array<{ title: string; options: string[] }> = [];
		const notifyCalls: Array<{ text: string; type: string }> = [];
		const fakeCtx = makeUiCtx(selects, notifyCalls);
		await (handlers.get("session_start")![0] as (e: unknown, c: unknown) => unknown)({}, fakeCtx);

		const validate = tools.find((t) => t.name === "workflow_validate")!;
		const outcome = await validate.execute("t1", { source: `export const meta = { name: 'a' }\nawait agent('x')` });
		const runId = (outcome.details as { runId?: string }).runId;
		assert.ok(runId, "validation returns a runId");

		await (handlers.get("tool_result")![0] as (e: unknown, c: unknown) => unknown)(
			{ toolName: "workflow_validate", isError: false, details: { runId }, content: [] },
			fakeCtx,
		);
		assert.equal(selects.length, 0, "solo 下不弹批准卡");
		assert.ok(notifyCalls.some((n) => n.text.includes("solo") && n.text.includes("自动批准")), "notify 明示自动批准");

		// workflow_start：once 已记录 + solo 分支双保险，handler 不得返回 block。
		const blocked = await (handlers.get("tool_call")![0] as (e: unknown, c: unknown) => unknown)(
			{ toolName: "workflow_start", input: { runId, approval: "once" } },
			fakeCtx,
		);
		assert.equal(blocked, undefined, "solo 下 workflow_start 直接放行");
		assert.equal(selects.length, 0, "仍无卡片");
	} finally {
		cleanup();
	}
});

test("solo 审批门：已保存命令 /workflow:run <name> 不弹批准卡，直接按 once 启动", async () => {
	const cleanup = enableSolo();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-solo-cwd-"));
	try {
		fs.mkdirSync(path.join(cwd, ".pi", "workflows"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "workflows", "solo-saved.js"),
			`export const meta = { name: 'solo-saved' }\nawait agent('x')`,
			"utf8",
		);
		const { commandHandlers, handlers } = register({ cwd });
		const selects: Array<{ title: string; options: string[] }> = [];
		const notifyCalls: Array<{ text: string; type: string }> = [];
		const fakeCtx = makeUiCtx(selects, notifyCalls, { isProjectTrusted: () => true });
		await (handlers.get("session_start")![0] as (e: unknown, c: unknown) => unknown)({}, fakeCtx);

		// 命令面冒号化（v2.8.0）：saved 调用走独立命令 `/workflow:run <name>`。
		const handler = commandHandlers.get("workflow:run");
		assert.ok(handler, "/workflow:run 命令 handler 可调用");

		// 不派真子进程：假 runner 挂起，run 停在 running。
		rt.setRunner({ run: () => new Promise(() => {}) });
		await handler!("solo-saved", fakeCtx);

		assert.equal(selects.length, 0, "solo 下已保存命令不弹批准卡");
		assert.ok(notifyCalls.some((n) => n.text.includes("started")), "命令按 once 启动");
		assert.ok(notifyCalls.some((n) => n.text.includes("solo") && n.text.includes("自动批准")), "notify 明示自动批准");

		await (handlers.get("session_shutdown")![0] as (e: unknown, c: unknown) => unknown)({}, fakeCtx);
	} finally {
		cleanup();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
