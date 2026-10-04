/**
 * pi 1.0 工具面契约（pwr-todo#14）：4 个 `workflow_*` 工具全部
 * `exposure: "model-only"`（编排型——起子进程 / 写盘 / 弹批准卡，永不从
 * codemode 脚本可调）、归入 `pwr` namespace、带 MCP 风格 annotations；
 * 查询口径结果带 `outputSchema` + `structuredContent`（程序化调用方的稳定
 * 契约），`details` 保持内部结构。
 *
 * 边界：真实 `pi.getAllTools()` 需要完整会话，这里用假 pi 捕获
 * `registerTool` 收到的定义——宿主报告的 exposure/annotations/namespace
 * 就是这份定义；structuredContent 用 TypeBox `Value.Check` 对着
 * outputSchema 校验（不是手写形状断言）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { ApprovalStore } from "../src/approval.ts";
import { ErrorCode } from "../src/errors.ts";
import { RunRegistry, type FlowDeps, type ValidateSuccess } from "../src/flow.ts";
import { structuralGate } from "../src/engine.ts";
import { registerPwrTools, type ToolDeps } from "../src/tools.ts";
import type { PwrErrorResult, RunStatus, RuntimeAdapter, WorkflowPlan } from "../src/types.ts";

const NOW = "2026-08-05T10:00:00Z";
const ENDED = "2026-08-05T10:05:00Z";
const VALID = `
export const meta = { name: 'audit', version: 1 };
const files = await agent('list', { label: 'discover', tools: 'readonly' });
const out = await pipeline(files.files, f => agent('audit ' + f, { label: 'audit' }), { concurrency: 4 });
return await agent('summarize', { label: 'verify' });
`;

const EMPTY_PLAN: WorkflowPlan = {
	stages: [],
	budget: { agentCalls: 0, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 0, writeRisk: false, warnLargeRun: false },
};

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

interface CapturedTool {
	name: string;
	description: string;
	exposure?: string;
	annotations?: Record<string, unknown>;
	namespace?: { name: string; description?: string };
	outputSchema?: unknown;
	parameters: { properties?: Record<string, unknown> };
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

/** 假 pi：只捕获 registerTool 的定义（宿主 getAllTools 读的就是这些字段）。 */
function register(deps: ToolDeps): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	registerPwrTools({ registerTool: (def: CapturedTool) => tools.set(def.name, def) } as never, deps);
	return tools;
}

/** 读时快照 stub：注册表状态会滞后，view 才是实时真相。 */
interface ViewStub {
	status: RunStatus;
	startedAt?: string;
	endedAt?: string;
	stages: Array<{ label: string; status: string }>;
}

type ViewRuntime = RuntimeAdapter & { view(runId: string): ViewStub };

/** 控制类动作的假 runtime：control 返回固定状态，view 只认识已登记的 run。 */
function runtimeWithView(views: Record<string, ViewStub>, controlStatus: RunStatus = "paused"): ViewRuntime {
	return {
		async start(spec) {
			return { runId: spec.runId, status: "running" };
		},
		async control() {
			return {
				run: {
					runId: "r",
					scriptId: "s",
					scriptName: "audit",
					status: controlStatus,
					digest: "d",
					createdAt: NOW,
					stages: [],
					budget: EMPTY_PLAN.budget,
				},
			};
		},
		view(runId: string) {
			const view = views[runId];
			if (!view) throw new Error("RUN_NOT_FOUND");
			return view;
		},
	};
}

function makeDeps(overrides: Partial<ToolDeps> = {}): { deps: ToolDeps; registry: RunRegistry } {
	const registry = new RunRegistry();
	const deps: FlowDeps & ToolDeps = {
		engine: structuralGate,
		approvals: new ApprovalStore(),
		registry,
		getProjectPath: () => "C:/proj",
		runtime: null,
		now: () => NOW,
		...overrides,
	};
	return { deps, registry };
}

function createRun(registry: RunRegistry, status?: RunStatus): string {
	const run = registry.create(VALID, { name: "audit" }, EMPTY_PLAN, NOW);
	if (status) registry.setStatus(run.runId, status, NOW);
	return run.runId;
}

function matchesSchema(tool: CapturedTool, value: unknown): void {
	assert.ok(
		Value.Check(tool.outputSchema as never, value),
		`structuredContent of ${tool.name} must match its outputSchema: ${JSON.stringify(value)}`,
	);
}

/** pi 文档给出的权限门参考判定式（general-todo#21 验收标准 3）。 */
function needsApproval(annotations: Record<string, unknown> | undefined): boolean {
	const destructive = annotations?.destructiveHint as boolean | undefined;
	const readOnly = annotations?.readOnlyHint as boolean | undefined;
	const openWorld = annotations?.openWorldHint as boolean | undefined;
	return destructive === true || (!readOnly && ((destructive ?? true) || (openWorld ?? true)));
}

test("4 个 workflow 工具全部 model-only 并归入 pwr namespace", () => {
	const { deps } = makeDeps();
	const tools = register(deps);
	assert.deepEqual([...tools.keys()], ["workflow_validate", "workflow_start", "workflow_control", "workflow_save"]);
	for (const tool of tools.values()) {
		assert.equal(tool.exposure, "model-only", `${tool.name} must never be callable from a codemode script`);
		assert.deepEqual(tool.namespace, { name: "pwr", description: "Pi Workflow Runtime 工作流编排" }, tool.name);
		assert.ok(tool.outputSchema, `${tool.name} declares outputSchema`);
	}
});

test("annotations 按 MCP 口径逐条可读，参考判定式结果正确", () => {
	const { deps } = makeDeps();
	const tools = register(deps);
	const hints = (name: string): Record<string, unknown> | undefined => tools.get(name)!.annotations;

	assert.deepEqual(hints("workflow_validate"), { readOnlyHint: true });
	assert.deepEqual(hints("workflow_start"), { destructiveHint: true, openWorldHint: true });
	assert.deepEqual(hints("workflow_control"), { destructiveHint: true });
	assert.deepEqual(hints("workflow_save"), { destructiveHint: true });

	assert.equal(needsApproval(hints("workflow_validate")), false, "read-only validate needs no approval");
	for (const name of ["workflow_start", "workflow_control", "workflow_save"]) {
		assert.equal(needsApproval(hints(name)), true, `${name} needs approval`);
	}
});

test("workflow_control list 返回结构化 runs 数组（runId/status/stage/startedAt/finishedAt?）", async () => {
	const views: Record<string, ViewStub> = {};
	const { deps, registry } = makeDeps({ runtime: runtimeWithView(views) });
	const draftId = createRun(registry);
	const runningId = createRun(registry, "running");
	views[runningId] = {
		status: "running",
		startedAt: NOW,
		stages: [
			{ label: "discover", status: "completed" },
			{ label: "audit", status: "running" },
			{ label: "verify", status: "queued" },
		],
	};

	const control = register(deps).get("workflow_control")!;
	const result = await control.execute("call-1", { action: "list" });
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent, {
		runs: [
			{ runId: draftId, status: "awaiting_approval", stage: "", startedAt: "" },
			{ runId: runningId, status: "running", stage: "audit", startedAt: NOW },
		],
	});
	matchesSchema(control, result.structuredContent);
	assert.ok(result.content[0]!.text.includes(runningId), "content keeps the full runId for the model");
	assert.ok(result.content[0]!.text.includes("audit"), "content shows the most recently entered stage");
	assert.ok(result.details, "details stays populated for the render path");
});

test("查询口径以 runtime view 为准：滞后的注册表状态被覆盖，finishedAt 随 endedAt 出现", async () => {
	const views: Record<string, ViewStub> = {};
	const { deps, registry } = makeDeps({ runtime: runtimeWithView(views) });
	const runId = createRun(registry, "running");
	views[runId] = {
		status: "completed",
		startedAt: NOW,
		endedAt: ENDED,
		stages: [
			{ label: "discover", status: "completed" },
			{ label: "audit", status: "completed" },
		],
	};

	const tools = register(deps);
	const control = tools.get("workflow_control")!;
	const status = await control.execute("c", { runId, action: "status" });
	assert.deepEqual(status.structuredContent, { runId, ok: true, status: "completed" });
	matchesSchema(control, status.structuredContent);

	const list = await control.execute("c", { action: "list" });
	assert.deepEqual(list.structuredContent, {
		runs: [{ runId, status: "completed", stage: "audit", startedAt: NOW, finishedAt: ENDED }],
	});
});

test("status 查询不受控制门限制（awaiting_approval 也能读），runtime 缺席时退回注册表", async () => {
	const { deps, registry } = makeDeps();
	const draftId = createRun(registry);
	const control = register(deps).get("workflow_control")!;
	const result = await control.execute("c", { runId: draftId, action: "status" });
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent, { runId: draftId, ok: true, status: "awaiting_approval" });
	matchesSchema(control, result.structuredContent);
});

test("pause/resume/stop/restart_agent 的结果统一为 { runId, ok, status }", async () => {
	const { deps, registry } = makeDeps({ runtime: runtimeWithView({}, "paused") });
	const runId = createRun(registry, "running");
	const control = register(deps).get("workflow_control")!;
	for (const action of ["pause", "resume", "stop", "restart_agent"]) {
		const result = await control.execute("c", { runId, action, agentId: "task-1" });
		assert.equal(result.isError, undefined, action);
		assert.deepEqual(result.structuredContent, { runId, ok: true, status: "paused" }, action);
		matchesSchema(control, result.structuredContent);
		assert.ok(result.details, `${action} keeps the internal runtime view in details`);
	}
});

test("失败结果保持 isError + details，不产出 structuredContent", async () => {
	const { deps } = makeDeps();
	const control = register(deps).get("workflow_control")!;
	const result = await control.execute("c", { runId: "missing", action: "pause" });
	assert.equal(result.isError, true);
	assert.equal(result.structuredContent, undefined);
	assert.equal((result.details as PwrErrorResult).code, ErrorCode.RUN_NOT_FOUND);
});

test("workflow_validate / workflow_start / workflow_save 的结构化结果与 outputSchema 一致", async () => {
	const { deps, registry } = makeDeps({ runtime: runtimeWithView({}) });
	const tools = register(deps);

	const validated = await tools.get("workflow_validate")!.execute("c", { source: VALID });
	const details = validated.details as ValidateSuccess;
	const validateStructured = validated.structuredContent as {
		runId: string;
		digest: string;
		scriptName: string;
		stages: Array<{ label: string; agentCount: number; dynamic: boolean }>;
		estimatedAgents: number;
	};
	assert.equal(validateStructured.runId, details.runId);
	assert.equal(validateStructured.digest, details.script.digest);
	assert.equal(validateStructured.scriptName, "audit");
	assert.deepEqual(validateStructured.stages.map((s) => s.label), ["discover", "pipeline #1", "verify"]);
	assert.deepEqual(validateStructured.stages.map((s) => s.dynamic), [false, true, false]);
	assert.ok(validateStructured.estimatedAgents > 0);
	matchesSchema(tools.get("workflow_validate")!, validated.structuredContent);
	assert.ok(details.plan, "details keeps the internal plan");

	registry.markOnceApproved(details.runId);
	const started = await tools.get("workflow_start")!.execute("c", { runId: details.runId, approval: "once" });
	assert.deepEqual(started.structuredContent, { runId: details.runId, status: "running" });
	matchesSchema(tools.get("workflow_start")!, started.structuredContent);

	deps.saveAdapter = { save: async (input) => ({ commandName: input.name, pathScope: input.scope }) };
	const saved = await tools.get("workflow_save")!.execute("c", { runId: details.runId, scope: "user", name: "audit-routes" });
	assert.deepEqual(saved.structuredContent, { commandName: "audit-routes", scope: "user" });
	matchesSchema(tools.get("workflow_save")!, saved.structuredContent);
});
