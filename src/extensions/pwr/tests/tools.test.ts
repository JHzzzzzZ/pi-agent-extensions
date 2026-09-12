/**
 * Approval-card contract tests (PRD §4.2): "View raw script" shows the
 * script read-only and returns to the SAME card; only an explicit Reject
 * yields "reject"; dismissing the card yields null (approval stays pending).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApprovalBody, confirmApprovalCard, formatPlanText, type ApprovalCardInfo } from "../src/tools.ts";

const INFO: ApprovalCardInfo = {
	runId: "r1",
	scriptName: "audit",
	digest: "d".repeat(64),
	planText: "Stages (2):\n  - discover\n  - verify",
	scriptSource: "export const meta = { name: 'audit' };\nawait agent('x');",
};

interface FakeCtx {
	hasUI: boolean;
	ui: {
		select: (prompt: string, options: string[]) => Promise<string | undefined>;
		notify: (text: string, type: string) => void;
	};
	notifyCalls: Array<{ text: string; type: string }>;
	selectCalls: number;
}

function fakeCtx(choices: Array<string | undefined>): FakeCtx {
	const ctx: FakeCtx = {
		hasUI: true,
		ui: {
			select: async (_prompt, _options) => {
				ctx.selectCalls++;
				return choices.shift();
			},
			notify: (text, type) => {
				ctx.notifyCalls.push({ text, type });
			},
		},
		notifyCalls: [],
		selectCalls: 0,
	};
	return ctx;
}

test("View raw script shows the source read-only and returns to the same card", async () => {
	const ctx = fakeCtx(["View raw script", "Run once"]);
	const decision = await confirmApprovalCard(ctx as never, INFO);
	assert.equal(decision, "once");
	assert.equal(ctx.selectCalls, 2, "card must be re-shown after viewing the script");
	assert.equal(ctx.notifyCalls.length, 3, "body, script notice, then body again on the re-shown card");
	assert.ok(ctx.notifyCalls[0]!.text.includes("Choices:"), "body notified before select");
	assert.ok(ctx.notifyCalls[1]!.text.includes(INFO.scriptSource!), "raw script must be displayed");
	assert.ok(ctx.notifyCalls[1]!.text.includes("read-only"));
	assert.equal(ctx.notifyCalls[1]!.type, "info");
	assert.ok(ctx.notifyCalls[2]!.text.includes("Choices:"), "body re-notified after returning from the script view");
});

test("viewing the script multiple times never turns into a rejection", async () => {
	const ctx = fakeCtx(["View raw script", "View raw script", "View raw script", "Remember for this script"]);
	const decision = await confirmApprovalCard(ctx as never, INFO);
	assert.equal(decision, "remember");
	assert.equal(ctx.selectCalls, 4);
	// one body notice before every select (4) + one script notice per view (3)
	assert.equal(ctx.notifyCalls.length, 7);
});

test("only an explicit Reject yields reject", async () => {
	const ctx = fakeCtx(["Reject"]);
	const decision = await confirmApprovalCard(ctx as never, INFO);
	assert.equal(decision, "reject");
	assert.equal(ctx.notifyCalls.length, 1, "body notified before prompting, even for a reject");
});

test("dismissing the card yields null (approval stays pending, not a rejection)", async () => {
	const ctx = fakeCtx([undefined]);
	const decision = await confirmApprovalCard(ctx as never, INFO);
	assert.equal(decision, null);
	assert.equal(ctx.notifyCalls.length, 1, "body notified before select");
});

test("no UI -> null without prompting", async () => {
	const ctx = fakeCtx([]);
	ctx.hasUI = false;
	const decision = await confirmApprovalCard(ctx as never, INFO);
	assert.equal(decision, null);
	assert.equal(ctx.selectCalls, 0);
});

test("formatPlanText 动态阶段显示 · 动态", () => {
	const text = formatPlanText(
		`export const meta = { name: 'audit' };
		 const items = getFiles();
		 await pipeline(items, (f) => agent('审查 ' + f, { label: 'analyze' }), { concurrency: 4 });`,
	);
	assert.ok(text.includes("3 agent(s) · 动态"), "dynamic fan-out stage carries the marker");
	const literal = formatPlanText(
		`export const meta = { name: 'audit' };
		 await pipeline([1, 2], (f) => agent('x', { label: 'analyze' }));`,
	);
	assert.ok(!literal.includes("· 动态"), "literal fan-out stage has no marker");
});

test("approval card notifies the plan summary body before prompting", async () => {
	const ctx = fakeCtx(["Reject"]);
	const decision = await confirmApprovalCard(ctx as never, INFO);
	assert.equal(decision, "reject");
	assert.equal(ctx.notifyCalls.length, 1);
	const body = ctx.notifyCalls[0]!;
	assert.ok(body.text.includes(INFO.digest.slice(0, 12)), "digest shown in the body");
	assert.ok(body.text.includes("Stages (2)"), "stages shown in the body");
	assert.ok(body.text.includes(INFO.planText), "plan summary shown in the body");
	assert.ok(body.text.includes("Choices: Run once / Remember for this script / View raw script / Reject"), "choices listed");
	assert.equal(body.type, "info");
	assert.ok(!body.text.includes("\x1b["), "plain text, no color-only status");
});

test("view raw script truncates oversized script sources", async () => {
	const BIG = {
		...INFO,
		// periodic body > 8KB preview cap; unique tail marker proves the tail is cut
		scriptSource: "export const meta = { name: 'audit' };\n".repeat(600) + "// UNIQUE-TAIL-MARKER\n",
	};
	const ctx = fakeCtx(["View raw script", "Reject"]);
	const decision = await confirmApprovalCard(ctx as never, BIG);
	assert.equal(decision, "reject");
	assert.equal(ctx.notifyCalls.length, 3, "body, truncated script notice, then body again before Reject");
	const scriptNotice = ctx.notifyCalls[1]!;
	assert.ok(scriptNotice.text.includes("read-only"));
	assert.ok(scriptNotice.text.includes("[脚本过长"), "truncation marker shown");
	assert.ok(scriptNotice.text.includes("仅展示前"), "preview length guidance shown");
	assert.ok(!scriptNotice.text.includes("UNIQUE-TAIL-MARKER"), "oversized source tail is not shown");
});

test("buildApprovalBody renders stages, budget, digest and choices as plain text", () => {
	const rich: ApprovalCardInfo = {
		runId: "r1",
		scriptName: "audit",
		digest: "d".repeat(64),
		planText:
			"Stages (2):\n  - discover (1 agent(s))\n  - verify (40 agent(s)) [write]\nBudget: ~41 agents\n⚠️ Large run warning (over 25 agents).",
		scriptSource: "export const meta = { name: 'audit' };\nawait agent('x');",
	};
	const body = buildApprovalBody(rich);
	assert.ok(body.includes(rich.digest.slice(0, 12)), "digest prefix shown");
	assert.ok(body.includes("discover"), "stage 1 shown");
	assert.ok(body.includes("verify"), "stage 2 shown");
	assert.ok(body.includes("~41 agents"), "agent budget shown");
	assert.ok(body.includes("Large run"), "large-run warning shown");
	assert.ok(body.includes("Run once"), "choices shown");
	assert.ok(!body.includes("\x1b["), "no color-only status");
});
