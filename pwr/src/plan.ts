/**
 * PWR - plan extraction (JHL-16 goal 2)
 *
 * Aggregates stages from agent/pipeline/parallel call *nodes of the JHL-12
 * parsed AST* (never raw regex over the source text), estimates the agent
 * budget and flags write-tool risk. Because extraction works on AST nodes:
 *  - comments, string literals and template text never produce phantom calls;
 *  - the raw (unclamped) estimate is preserved so `BUDGET_EXCEEDED` and the
 *    >25-agent warning are computed against the true call count.
 *
 * `extractPlan` must only be called on engine-validated source (the parser
 * is the JHL-12 parser and throws ScriptError on syntax errors).
 */

import {
	AGENT_LIMIT,
	PIPELINE_FANOUT_ESTIMATE,
	type BudgetEstimate,
	type PlanNode,
	type StagePlan,
	type WorkflowPlan,
} from "./types.ts";
import { parseScript } from "../engine/parser.ts";

type CallKind = StagePlan["kind"];

interface CallSite {
	kind: CallKind;
	start: number;
	end: number;
	label?: string;
	concurrency?: number;
	/** pipeline/parallel fan-out driven by a runtime value (not a literal array). */
	dynamic?: boolean;
	writeRisk: boolean;
	/** True when the label was synthesized (ordinal or parent-scoped). */
	synth?: boolean;
}

interface AstNode {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

/** String literal value when the node is a Literal, else undefined. */
function literalString(node: unknown): string | undefined {
	const n = node as { type?: string; value?: unknown } | null | undefined;
	if (n && n.type === "Literal" && typeof n.value === "string") return n.value;
	return undefined;
}

/** Number literal value when the node is a Literal, else undefined. */
function literalNumber(node: unknown): number | undefined {
	const n = node as { type?: string; value?: unknown } | null | undefined;
	if (n && n.type === "Literal" && typeof n.value === "number") return n.value;
	return undefined;
}

/**
 * Reads { label, tools, concurrency } from an options ObjectExpression node
 * (static keys only; computed keys are ignored for planning).
 */
function readOptions(options: unknown): { label?: string; tools?: string; concurrency?: number } {
	const out: { label?: string; tools?: string; concurrency?: number } = {};
	const obj = options as { type?: string; properties?: AstNode[] } | null | undefined;
	if (!obj || obj.type !== "ObjectExpression") return out;
	for (const prop of obj.properties ?? []) {
		const p = prop as { type?: string; key?: AstNode; value?: AstNode; computed?: boolean } | null;
		if (!p || p.type !== "Property" || p.computed) continue;
		const key = p.key as { type?: string; name?: string; value?: unknown } | null;
		const keyName = key?.type === "Identifier" ? key.name : literalString(key);
		if (keyName === "label") out.label = literalString(p.value);
		else if (keyName === "tools") out.tools = literalString(p.value);
		else if (keyName === "concurrency") out.concurrency = literalNumber(p.value);
	}
	return out;
}

/** Recursively collects agent/pipeline/parallel call sites from the AST. */
function collectCalls(node: AstNode | unknown, out: CallSite[]): void {
	const n = node as AstNode | null | undefined;
	if (!n || typeof n !== "object" || typeof n.type !== "string") return;

	if (n.type === "CallExpression") {
		const callee = n.callee as { type?: string; name?: string } | null | undefined;
		if (callee?.type === "Identifier" && (callee.name === "agent" || callee.name === "pipeline" || callee.name === "parallel")) {
			const args = (n.arguments as AstNode[] | undefined) ?? [];
			const kind = callee.name as CallKind;
			const optionsIndex = kind === "agent" ? 1 : kind === "pipeline" ? 2 : 1;
			const opts = readOptions(args[optionsIndex]);
			out.push({
				kind,
				start: n.start,
				end: n.end,
				label: opts.label,
				concurrency: opts.concurrency,
				dynamic:
					kind !== "agent"
						? ((args[0] as { type?: string } | undefined)?.type ?? "") !== "ArrayExpression"
						: false,
				writeRisk: opts.tools === "write",
			});
			// Still descend: pipeline/parallel may be nested inside a pipeline callback.
		}
	}

	for (const key of Object.keys(n)) {
		if (key === "start" || key === "end" || key === "loc" || key === "type") continue;
		const value = (n as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const el of value) collectCalls(el, out);
		} else {
			collectCalls(value, out);
		}
	}
}

/**
 * Builds the stage plan + budget estimate for a validated script.
 * Unlabeled calls get an ordinal label ("agent #1", ...).
 *
 * agent() calls nested inside a pipeline/parallel callback are counted as
 * part of the fan-out (they run once per item), not as separate agents.
 * `estimatedAgents` is the RAW estimate (never clamped) so callers can
 * enforce the hard cap with BUDGET_EXCEEDED before approving.
 */
export function extractPlan(source: string): WorkflowPlan {
	let ast: AstNode;
	try {
		ast = parseScript(source) as unknown as AstNode;
	} catch {
		// Only reachable on non-validated source; surface an empty plan rather
		// than crashing callers (validated source never parses here).
		return {
			stages: [],
			budget: {
				agentCalls: 0,
				pipelineCalls: 0,
				parallelCalls: 0,
				estimatedAgents: 0,
				writeRisk: false,
				warnLargeRun: false,
			},
		};
	}

	const calls: CallSite[] = [];
	collectCalls(ast, calls);

	const agents = calls.filter((c) => c.kind === "agent");
	const pipelines = calls.filter((c) => c.kind === "pipeline");
	const parallels = calls.filter((c) => c.kind === "parallel");

	// Spans of fan-out containers (pipeline/parallel) so nested agent calls
	// are excluded from the direct agent count.
	const containers = [...pipelines, ...parallels];
	const nestedInContainer = (call: CallSite): boolean =>
		containers.some((c) => call.start > c.start && call.end < c.end);

	const directAgents = agents.filter((a) => !nestedInContainer(a));
	const stages: StagePlan[] = [];

	let agentOrdinal = 0;
	let pipelineOrdinal = 0;
	let parallelOrdinal = 0;

	// Assign labels in source order so stages follow the script flow.
	const ordered = [...directAgents, ...pipelines, ...parallels].sort((a, b) => a.start - b.start);
	for (const call of ordered) {
		if (!call.label) {
			call.synth = true;
			if (call.kind === "agent") call.label = `agent #${++agentOrdinal}`;
			else if (call.kind === "pipeline") call.label = `pipeline #${++pipelineOrdinal}`;
			else call.label = `parallel #${++parallelOrdinal}`;
		}
	}

	// Aggregate repeated labels (e.g. the same stage label used in a loop).
	const counts = new Map<string, { kind: CallKind; count: number; writeRisk: boolean; dynamic: boolean }>();
	for (const call of ordered) {
		const label = call.label!;
		const fanOut = call.kind === "agent" ? 1 : PIPELINE_FANOUT_ESTIMATE;
		const existing = counts.get(label);
		if (existing) {
			existing.count += fanOut;
			if (call.writeRisk) existing.writeRisk = true;
			existing.dynamic = existing.dynamic || (call.dynamic ?? false);
			continue;
		}
		counts.set(label, { kind: call.kind, count: fanOut, writeRisk: call.writeRisk, dynamic: call.dynamic ?? false });
	}

	let idx = 0;
	for (const [label, { kind, count, writeRisk, dynamic }] of counts) {
		stages.push({ stageId: `stage-${++idx}`, label, kind, agentCount: count, writeRisk, dynamic: dynamic || undefined });
	}

	const tree = buildTree(calls, containers, stages, nestedInContainer);

	// RAW estimate — intentionally not clamped: the hard-cap check in the
	// validate flow relies on the true count to reject over-budget scripts.
	const estimatedAgents =
		directAgents.length + (pipelines.length + parallels.length) * PIPELINE_FANOUT_ESTIMATE;
	const anyWriteRisk = [...directAgents, ...pipelines, ...parallels].some((c) => c.writeRisk);

	return {
		stages,
		tree,
		budget: {
			agentCalls: directAgents.length,
			pipelineCalls: pipelines.length,
			parallelCalls: parallels.length,
			estimatedAgents,
			writeRisk: anyWriteRisk,
			warnLargeRun: estimatedAgents > 25,
		} satisfies BudgetEstimate,
	};
}

/**
 * Builds the structure tree for the /workflows:view diagram (JHL-18):
 * a call's parent is the smallest pipeline/parallel whose source span
 * strictly contains it; roots are the top-level calls in source order.
 *
 * Labels: direct calls and containers reuse the flat-stage labels (so the
 * diagram can correlate live runtime stages by label); nested unlabeled
 * agent calls get a parent-scoped synthesized label ("<parent>/agent-N")
 * that intentionally never matches a runtime label — their real dispatches
 * surface in the viewer's "未标注派发" section instead.
 */
function buildTree(calls: CallSite[], containers: CallSite[], stages: StagePlan[], nestedInContainer: (call: CallSite) => boolean): PlanNode[] {
	// Smallest containing span first, so find() yields the closest container.
	const sortedContainers = [...containers].sort((a, b) => a.end - a.start - (b.end - b.start));
	const parentOf = (call: CallSite): CallSite | undefined =>
		sortedContainers.find((c) => c !== call && call.start > c.start && call.end < c.end);

	// Parent-scoped labels for nested unlabeled agents (after containers and
	// direct calls got their labels in the ordinal pass above).
	let nestedCounter = 0;
	for (const call of calls) {
		if (call.label || call.kind !== "agent" || !nestedInContainer(call)) continue;
		const parent = parentOf(call);
		// Nested containers are already labeled by the ordinal pass; only
		// agents can still be unlabeled here and always have a container parent.
		call.label = `${parent?.label ?? "agent"}/agent-${++nestedCounter}`;
		call.synth = true;
	}

	const childrenByParent = new Map<CallSite, CallSite[]>();
	const roots: CallSite[] = [];
	for (const call of calls) {
		const parent = parentOf(call);
		if (parent) {
			const list = childrenByParent.get(parent);
			if (list) list.push(call);
			else childrenByParent.set(parent, [call]);
		} else {
			roots.push(call);
		}
	}

	const stageIdByLabel = new Map(stages.map((s) => [s.label, s.stageId]));
	const toNode = (call: CallSite): PlanNode => {
		const children = (childrenByParent.get(call) ?? [])
			.sort((a, b) => a.start - b.start)
			.map(toNode);
		// Flat stages exist for every direct call and container; only nested
		// agent calls are tree-only.
		const nestedAgent = call.kind === "agent" && nestedInContainer(call);
		const node: PlanNode = {
			label: call.label!,
			kind: call.kind,
			agentCount: call.kind === "agent" ? 1 : PIPELINE_FANOUT_ESTIMATE,
			writeRisk: call.writeRisk,
		};
		if (!nestedAgent) node.stageId = stageIdByLabel.get(call.label!);
		if (call.dynamic) node.dynamic = true;
		if (call.synth) node.synthesized = true;
		if (children.length > 0) node.children = children;
		return node;
	};
	return roots.sort((a, b) => a.start - b.start).map(toNode);
}
