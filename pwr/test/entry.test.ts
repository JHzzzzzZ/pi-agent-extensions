/**
 * Merged-entry contract tests (v2.0.0): the single `pwr/index.ts` entry must
 * register the complete PWR surface — the four workflow tools, all commands
 * (/workflow, /workflow:<name>, /workflows:*), the UI shortcuts and the
 * run-entry renderer — with the PRD §6.2 contracts. `workflow_validate`
 * takes `{ source, argsSchema? }` and fails with ENGINE_UNAVAILABLE until
 * the engine is resolved at session_start (never the structural gate).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import pwrExtension from "../index.ts";
import { ErrorCode } from "../src/errors.ts";
import { PWR_RESULT_CUSTOM_TYPE, PWR_RUN_ENTRY } from "../src/types.ts";
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

function register() {
	const tools: FakeTool[] = [];
	const commands: string[] = [];
	const shortcuts: string[] = [];
	const renderers: string[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const sentMessages: Array<{ message: { customType?: string; content?: string }; options?: unknown }> = [];
	const pi = {
		registerTool(def: FakeTool) {
			tools.push(def);
		},
		registerCommand(name: string) {
			commands.push(name);
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
		getFlag() {
			return undefined;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	};
	pwrExtension(pi as never);
	return { tools, commands, shortcuts, renderers, handlers, entries, sentMessages };
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

test("merged entry registers /workflow + /workflows UI commands, shortcuts and the run-entry renderer", () => {
	const { commands, shortcuts, renderers } = register();
	for (const expected of [
		"workflow",
		"workflow-delete",
		"pwr-model",
		"workflows",
		"workflows:list",
		"workflows:open",
		"workflows:pause",
		"workflows:resume",
		"workflows:stop",
		"workflows:restart",
		"workflows:save",
		"workflows:script",
		"workflows:approve",
		"workflows:help",
	]) {
		assert.ok(commands.includes(expected), `command ${expected} must be registered`);
	}
	assert.equal(shortcuts.length, 3, "pause/stop/restart shortcuts registered (JHL-15)");
	assert.deepEqual(renderers, [PWR_RUN_ENTRY], "run entry renderer registered (JHL-15)");
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
