/**
 * Cockpit-side budget integration: usage folding (leader turns + dispatch
 * member usage) into the live budget snapshot, cost/token cap enforcement
 * (auto-abort with BUDGET_EXCEEDED), and the status snapshot's budget line.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { formatStatusSnapshot, TeamRunCoordinator, type RunStatusSnapshot, type UiPort } from "../cockpit.ts";
import { readRunStatuses } from "../runstore.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, toolExecutionStartLine, toolExecutionEndLine, waitForChild } from "./helpers.ts";

function fakeUi(): UiPort {
  return { notify: () => {}, dim: (text) => text };
}

function dispatchEndLine(members: Array<Record<string, unknown>>, totalUsage: Record<string, unknown>): string {
  return toolExecutionEndLine("team_dispatch", {
    content: [{ type: "text", text: "report" }],
    details: { members, totalUsage },
  });
}

function leaderLines(): string[] {
  return [
    messageEndLine("assistant", {
      content: [{ type: "text", text: "拆解任务" }],
      usage: { input: 50, output: 20, cost: { total: 0.001 }, totalTokens: 70 },
    }),
    toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }),
    dispatchEndLine(
      [
        { name: "frontend", ok: true, status: "done", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } },
        { name: "backend", ok: true, status: "done", usage: { input: 20, output: 8, cost: 0.02, turns: 2 } },
      ],
      { input: 30, output: 13, cost: 0.03 },
    ),
    messageEndLine("assistant", {
      content: [{ type: "text", text: "FINAL" }],
      usage: { input: 50, output: 20, cost: { total: 0.05 }, totalTokens: 70 },
    }),
  ];
}

test("progress folds leader + member usage into the budget snapshot", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const snapshots: RunStatusSnapshot[] = [];
  const promise = coordinator.start({
    team: fixtureTeam(),
    task: "t",
    ui: fakeUi(),
    onProgress: () => snapshots.push(coordinator.getStatus()),
  });
  const child = await waitForChild(spawn, 0);
  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok);

  // The last snapshot before the run settled carries the folded totals.
  const budget = snapshots[snapshots.length - 1]?.progress?.budget;
  assert.ok(budget, "budget snapshot present");
  // Leader cumulative (0.001 + 0.05 = 0.051) + member dispatch totalUsage (0.03).
  assert.ok(Math.abs(budget.spentCost - 0.081) < 1e-9, `spentCost=${budget.spentCost}`);
  // Leader cumulative input+output (50+20 twice = 140) + member (43).
  assert.equal(budget.spentTokens, 183);
  assert.equal(budget.dispatchCalls, 1);
  assert.equal(budget.memberRuns, 2);
  // Protocol defaults (no budget block in the fixture team).
  assert.equal(budget.maxDispatchCalls, 12);
  assert.equal(budget.maxMemberRuns, 40);
  assert.equal(budget.maxCostUsd, null);
  assert.equal(budget.maxTotalTokens, null);
});

test("formatStatusSnapshot renders the budget line (cost cap and unlimited)", () => {
  const base = {
    runId: "r",
    team: "dev-team",
    task: "t",
    startedAtMs: 0,
    members: [{ name: "frontend", status: "running" as const }],
  };
  const withCap = formatStatusSnapshot(
    {
      running: true,
      actives: [],
      records: [],
      progress: {
        ...base,
        budget: {
          maxDispatchCalls: 12,
          maxMemberRuns: 40,
          maxCostUsd: 5,
          maxTotalTokens: null,
          spentCost: 0.42,
          spentTokens: 113,
          dispatchCalls: 1,
          memberRuns: 2,
        },
      },
      lastRecord: null,
    },
    0,
  );
  assert.match(withCap, /预算: \$0\.42\/\$5\.00 · 1\/12 派发 · 2\/40 成员/);

  const unlimited = formatStatusSnapshot(
    {
      running: true,
      actives: [],
      records: [],
      progress: {
        ...base,
        budget: {
          maxDispatchCalls: 12,
          maxMemberRuns: 40,
          maxCostUsd: null,
          maxTotalTokens: null,
          spentCost: 0.42,
          spentTokens: 113,
          dispatchCalls: 1,
          memberRuns: 2,
        },
      },
      lastRecord: null,
    },
    0,
  );
  assert.match(unlimited, /预算: \$0\.42 · 1\/12 派发 · 2\/40 成员/);
});

test("frontmatter budget caps are surfaced in the snapshot", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const snapshots: RunStatusSnapshot[] = [];
  const team = fixtureTeam({ budget: { maxCostUsd: 5, maxDispatchCalls: 30 } });
  const promise = coordinator.start({
    team,
    task: "t",
    ui: fakeUi(),
    onProgress: () => snapshots.push(coordinator.getStatus()),
  });
  const child = await waitForChild(spawn, 0);
  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok);
  const budget = snapshots[snapshots.length - 1]?.progress?.budget;
  assert.equal(budget?.maxDispatchCalls, 30);
  assert.equal(budget?.maxMemberRuns, 40, "unset caps keep the protocol default");
  assert.equal(budget?.maxCostUsd, 5);
});

test("exceeding the cost cap aborts the run with BUDGET_EXCEEDED", async () => {
  const transcriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-budget-"));
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    killGraceMs: 10,
    transcriptRoot,
  });
  const team = fixtureTeam({ budget: { maxCostUsd: 0.02 } });
  const promise = coordinator.start({ team, task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok);
  const record = result.value!;
  assert.equal(record.status, "aborted");
  assert.match(record.error ?? "", /BUDGET_EXCEEDED/);
  assert.match(record.error ?? "", /\$0\.0310/);
  assert.ok(child.killed.includes("SIGTERM"), "children aborted on cap breach");
  assert.equal(readRunStatuses(transcriptRoot).entries[0].status, "aborted");
  assert.match(readRunStatuses(transcriptRoot).entries[0].error ?? "", /BUDGET_EXCEEDED/);
});

test("exceeding the token cap aborts the run with BUDGET_EXCEEDED", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    killGraceMs: 10,
  });
  const team = fixtureTeam({ budget: { maxTotalTokens: 100 } });
  const promise = coordinator.start({ team, task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "aborted");
  assert.match(result.value?.error ?? "", /BUDGET_EXCEEDED/);
  assert.match(result.value?.error ?? "", /113/);
});

test("runs within their budget complete normally (no false abort)", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const team = fixtureTeam({ budget: { maxCostUsd: 5, maxTotalTokens: 1000000 } });
  const promise = coordinator.start({ team, task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "completed");
});
