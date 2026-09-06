/**
 * JHL-18 - structure diagram tests: plan tree extraction (via extractPlan),
 * plan↔runtime correlation by label, rollup for containers, fallback without
 * a plan, and width-fitted rendering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPlan } from "../src/plan.ts";
import { buildDiagramModel, renderDiagramRows, renderUnmatchedStages } from "../src/ui/diagram.ts";
import type { RunDetail } from "../src/ui/types.ts";

const TREE_SCRIPT = `
export const meta = { name: 't' };
const a = await agent('direct1', { label: 'd1' });
const b = await pipeline([1, 2], x => agent('nested ' + x, { label: 'unit' }), { concurrency: 2, label: 'fan' });
return [a, b];
`;

test("extractPlan 构建结构树：根按源码顺序、容器带 children、stageId 对应扁平 stages", () => {
	const plan = extractPlan(TREE_SCRIPT);
	assert.ok(plan.tree);
	assert.equal(plan.tree!.length, 2);

	const [d1, fan] = plan.tree!;
	assert.equal(d1.label, "d1");
	assert.equal(d1.kind, "agent");
	assert.equal(d1.stageId, "stage-1");
	assert.equal(d1.children, undefined);

	assert.equal(fan.label, "fan");
	assert.equal(fan.kind, "pipeline");
	assert.equal(fan.stageId, "stage-2");
	assert.equal(fan.agentCount, 3);
	assert.ok(fan.children && fan.children.length === 1);
	const nested = fan.children![0]!;
	assert.equal(nested.label, "unit");
	assert.equal(nested.synthesized, undefined, "显式 label 的嵌套 agent 不是 synthesized");
	assert.equal(nested.stageId, undefined, "嵌套 agent 只存在于树中（扁平 stages 把它算进 fan-out）");
});

test("未标注调用的合成 label：直接调用用序号、嵌套调用用父级前缀，均标记 synthesized", () => {
	const plan = extractPlan(
		`
export const meta = { name: 'n' };
await agent('anon direct');
await pipeline([1], x => agent('anon nested'));
`,
	);
	const tree = plan.tree!;
	assert.equal(tree.length, 2);

	const anonDirect = tree[0]!;
	assert.equal(anonDirect.label, "agent #1");
	assert.equal(anonDirect.synthesized, true);
	assert.equal(anonDirect.stageId, "stage-1", "直接调用仍有扁平 stage");

	const pipeline = tree[1]!;
	assert.equal(pipeline.label, "pipeline #1");
	assert.equal(pipeline.synthesized, true);
	const nested = pipeline.children![0]!;
	assert.ok(nested.label.startsWith("pipeline #1/agent-"), `嵌套合成 label 形如 父/agent-N，实际 ${nested.label}`);
	assert.equal(nested.synthesized, true);
	assert.equal(nested.stageId, undefined);
});

function makeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
	return {
		runId: "r1",
		scriptId: "sc1",
		scriptName: "demo",
		status: "running",
		digest: "dd",
		createdAt: "2026-08-05T12:00:00Z",
		startedAt: "2026-08-05T12:00:01Z",
		stages: [],
		agents: [],
		warnings: [],
		...overrides,
	};
}

test("buildDiagramModel 按 label 关联：命中行带 live、容器 rollup、未匹配进尾部分组", () => {
	const detail = makeDetail({
		plan: {
			stages: [
				{ stageId: "stage-1", label: "audit", kind: "agent", agentCount: 1, writeRisk: false },
				{ stageId: "stage-2", label: "build", kind: "pipeline", agentCount: 3, writeRisk: false },
			],
			budget: { agentCalls: 4, pipelineCalls: 1, parallelCalls: 0, estimatedAgents: 4, writeRisk: false, warnLargeRun: false },
			tree: [
				{ label: "audit", kind: "agent", agentCount: 1, writeRisk: false, stageId: "stage-1" },
				{
					label: "build",
					kind: "pipeline",
					agentCount: 3,
					writeRisk: false,
					stageId: "stage-2",
					children: [{ label: "unit", kind: "agent", agentCount: 1, writeRisk: false }],
				},
			],
		},
		stages: [
			{ stageId: "stage-1", label: "audit", kind: "agent", status: "completed", agentCount: 1 },
			{ stageId: "rt-1", label: "unit", kind: "agent", status: "running", agentCount: 1 },
			{ stageId: "rt-2", label: "agent-1", kind: "agent", status: "queued", agentCount: 1 },
		],
		agents: [
			{ taskId: "t1", stageId: "stage-1", label: "audit", status: "completed", attempt: 1, recentEvents: [] },
			{ taskId: "t2", stageId: "rt-1", label: "unit", status: "running", attempt: 1, recentEvents: [] },
			{ taskId: "t3", stageId: "rt-2", label: "agent-1", status: "completed", attempt: 1, cacheHit: true, recentEvents: [] },
		],
	});

	const model = buildDiagramModel(detail);
	assert.equal(model.rows.length, 3);

	const audit = model.rows[0]!;
	assert.equal(audit.live?.status, "completed");
	assert.equal(audit.live?.completed, 1);
	assert.equal(audit.live?.total, 1);

	const build = model.rows[1]!;
	assert.equal(build.live?.status, "running", "容器 rollup：子任务运行中 → running");
	assert.equal(build.live?.completed, 0);
	assert.equal(build.live?.total, 1);

	const unit = model.rows[2]!;
	assert.equal(unit.live?.status, "running");
	assert.equal(unit.node.label, "unit");

	assert.equal(model.unmatched.length, 1, "未匹配的运行时 stage 进尾部分组");
	assert.equal(model.unmatched[0]!.label, "agent-1");
	assert.equal(model.unmatched[0]!.cacheHits, 1);
});

test("synthesized 节点不做 label 关联（运行时不可能出现该 label）", () => {
	const detail = makeDetail({
		plan: {
			stages: [{ stageId: "stage-1", label: "agent #1", kind: "agent", agentCount: 1, writeRisk: false }],
			budget: { agentCalls: 1, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 1, writeRisk: false, warnLargeRun: false },
			tree: [{ label: "agent #1", kind: "agent", agentCount: 1, writeRisk: false, stageId: "stage-1", synthesized: true }],
		},
		stages: [
			{ stageId: "stage-1", label: "agent #1", kind: "agent", status: "queued", agentCount: 1 },
			{ stageId: "rt-1", label: "agent-1", kind: "agent", status: "running", agentCount: 1 },
		],
		agents: [{ taskId: "t1", stageId: "rt-1", label: "agent-1", status: "running", attempt: 1, recentEvents: [] }],
	});
	const model = buildDiagramModel(detail);
	assert.equal(model.rows[0]!.live, undefined, "synthesized 节点永不匹配（避免 agent #1 ↔ agent-1 误配）");
	assert.equal(model.unmatched.length, 1, "运行时 stage-1（plan 种子行，无任务）与 rt-1 中：rt-1 未匹配");
});

test("无 plan（重启后 rehydrated）时退化为运行时 stage 平铺", () => {
	const detail = makeDetail({
		stages: [
			{ stageId: "stage-1", label: "audit", kind: "agent", status: "completed", agentCount: 1 },
			{ stageId: "stage-2", label: "build", kind: "pipeline", status: "running", agentCount: 2 },
		],
		agents: [
			{ taskId: "t1", stageId: "stage-1", label: "audit", status: "completed", attempt: 1, recentEvents: [] },
			{ taskId: "t2", stageId: "stage-2", label: "build", status: "running", attempt: 1, recentEvents: [] },
		],
	});
	const model = buildDiagramModel(detail);
	assert.equal(model.rows.length, 2);
	assert.equal(model.rows[0]!.live?.completed, 1);
	assert.equal(model.unmatched.length, 0);
});

test("renderDiagramRows 输出树形连接符、状态图标与进度并按宽度截断", () => {
	const detail = makeDetail({
		plan: {
			stages: [
				{ stageId: "stage-1", label: "audit", kind: "agent", agentCount: 1, writeRisk: false },
				{ stageId: "stage-2", label: "build", kind: "pipeline", agentCount: 3, writeRisk: true },
			],
			budget: { agentCalls: 4, pipelineCalls: 1, parallelCalls: 0, estimatedAgents: 4, writeRisk: false, warnLargeRun: false },
			tree: [
				{ label: "audit", kind: "agent", agentCount: 1, writeRisk: false, stageId: "stage-1" },
				{
					label: "build",
					kind: "pipeline",
					agentCount: 3,
					writeRisk: false,
					dynamic: true,
					stageId: "stage-2",
					children: [{ label: "unit", kind: "agent", agentCount: 1, writeRisk: false, synthesized: true }],
				},
			],
		},
		stages: [
			{ stageId: "stage-1", label: "audit", kind: "agent", status: "completed", agentCount: 1 },
		],
		agents: [{ taskId: "t1", stageId: "stage-1", label: "audit", status: "completed", attempt: 1, recentEvents: [] }],
	});
	const model = buildDiagramModel(detail);
	const lines = renderDiagramRows(model, 80);
	assert.equal(lines.length, 3);
	assert.ok(lines[0]!.includes("├─"));
	assert.ok(lines[0]!.includes("✓ audit"));
	assert.ok(lines[0]!.includes("1/1"));
	assert.ok(lines[1]!.includes("└─"));
	assert.ok(lines[1]!.includes("build · pipeline ×3≈"));
	assert.ok(lines[1]!.includes("未开始"), "无 live 的容器显示未开始");
	assert.ok(lines[2]!.startsWith("   └─"), "末位根节点的子节点用空格延续缩进");
	assert.ok(lines[2]!.includes("静态"), "synthesized 节点带静态标记");

	const clipped = renderDiagramRows(model, 20);
	assert.ok(clipped.every((line) => line.endsWith("…")), "超宽行以省略号截断");
});

test("renderUnmatchedStages：空时无输出，有则带 ⚡ 与进度", () => {
	const detail = makeDetail({
		stages: [{ stageId: "rt-1", label: "agent-1", kind: "agent", status: "completed", agentCount: 1 }],
		agents: [{ taskId: "t1", stageId: "rt-1", label: "agent-1", status: "completed", attempt: 1, cacheHit: true, recentEvents: [] }],
	});
	const model = buildDiagramModel(detail);
	assert.equal(renderUnmatchedStages(model, 80).length, 0, "无 plan 的平铺模型没有未匹配桶");

	const withPlan = makeDetail({
		plan: {
			stages: [{ stageId: "stage-1", label: "planned", kind: "agent", agentCount: 1, writeRisk: false }],
			budget: { agentCalls: 1, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 1, writeRisk: false, warnLargeRun: false },
			tree: [{ label: "planned", kind: "agent", agentCount: 1, writeRisk: false, stageId: "stage-1" }],
		},
		stages: detail.stages,
		agents: detail.agents,
	});
	const model2 = buildDiagramModel(withPlan);
	const lines = renderUnmatchedStages(model2, 80);
	assert.equal(lines.length, 2);
	assert.ok(lines[0]!.includes("未标注/动态派发"));
	assert.ok(lines[1]!.includes("⚡1"));
});
