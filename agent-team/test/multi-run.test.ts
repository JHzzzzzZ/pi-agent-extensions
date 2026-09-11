/**
 * Multi-run core tests (真正并发跑多个 team run, writer-1 core line).
 *
 * Locks the registry contract: several runs coexist in one session, each
 * with its own child process, stdin channel, progress and terminal record.
 * The parallel/steer/settle cases drive REAL child processes
 * (`defaultSpawn()` + `process.execPath -e`, the runner.test.ts pattern):
 * two leaders must be alive at the same time, stdin routing must not cross
 * runs, and each run must settle independently — a fake spawn cannot catch
 * registry-level cross-talk (v1.15.0 deadlock lesson: fakes never hit EOF).
 *
 * Pure-function cases (runId suffix, records bound, status projection,
 * snapshot formatting) run against fake children — the archive path is
 * already covered by real-file tests elsewhere.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { formatStatusSnapshot, TeamRunCoordinator, type UiPort } from "../cockpit.ts";
import { defaultSpawn } from "../runner.ts";
import { MAX_CONCURRENT_TEAM_RUNS, MAX_RETAINED_RUN_RECORDS, type PiSpawn, type RunProgress } from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, sleep, waitForChild } from "./helpers.ts";

function fakeUi(): UiPort {
  return { notify: () => {}, dim: (text) => text };
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-multi-run-"));
}

async function waitFor(predicate: () => boolean, what: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.ok(false, `等待超时：${what}`);
}

/**
 * Steers as soon as the run's RPC stdin channel is live (the leader spawn
 * does async temp-prompt work before onChild installs the channel, so an
 * immediate steer would fall back to queue semantics).
 */
async function steerWhenReady(coordinator: TeamRunCoordinator, runId: string, message: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (coordinator.steerLeader(runId, message)) return;
    await sleep(10);
  }
  assert.ok(false, `steer channel never became ready for ${runId}`);
}

/**
 * RPC-mode leader script for real child processes. Reads JSON lines from
 * stdin exactly like pi's `--mode rpc`:
 * - `prompt`  → assistant message_end (keeps the run live)
 * - `steer` containing "dispatch" → team_dispatch tool_execution_end whose
 *   details carry member progress (per-run event routing proof)
 * - `steer` containing "settle"   → agent_settled (cockpit closes stdin;
 *   stdin end exits the process)
 * - any other steer → assistant message_end echoing the message back
 */
const CHILD_SCRIPT = [
  "const readline = require('node:readline');",
  "const rl = readline.createInterface({ input: process.stdin });",
  "const runId = process.env.PI_AGENT_TEAM_RUN_ID || '?';",
  "function emit(o){ console.log(JSON.stringify(o)); }",
  "function assistant(text){ emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 1, output: 1, cost: { total: 0 } }, model: 'm' } }); }",
  "rl.on('line', (line) => {",
  "  let msg; try { msg = JSON.parse(line); } catch { return; }",
  "  if (msg.type === 'prompt') { setTimeout(() => assistant('working ' + runId), 30); return; }",
  "  if (msg.type !== 'steer') return;",
  "  const text = String(msg.message || '');",
  "  if (text.includes('settle')) { emit({ type: 'agent_settled' }); return; }",
  "  if (text.includes('dispatch')) {",
  "    emit({ type: 'tool_execution_end', toolName: 'team_dispatch', result: { content: [{ type: 'text', text: 'ok' }], details: { members: [{ name: 'frontend', ok: true, status: 'done', summary: 's', usage: { input: 1, output: 1, cost: 0, turns: 1 } }], totalUsage: { input: 1, output: 1, cost: 0, turns: 1 } } } });",
  "    return;",
  "  }",
  "  assistant('STEER:' + text);",
  "});",
].join("\n");

/** Spawn port that replaces the leader argv with a real `node -e` child. */
function realChildSpawn(): PiSpawn {
  const base = defaultSpawn();
  return (_command, _args, opts) => base(process.execPath, ["-e", CHILD_SCRIPT], opts);
}

function makeRealCoordinator(root: string, nowMs?: () => number): TeamRunCoordinator {
  return new TeamRunCoordinator({
    cwd: () => root,
    worktreeRoot: path.join(root, "worktrees"),
    transcriptRoot: path.join(root, "runs"),
    piCommand: "node",
    spawn: realChildSpawn(),
    killGraceMs: 50,
    ...(nowMs ? { nowMs } : {}),
  });
}

function leaderLines(): string[] {
  return [messageEndLine("assistant", { content: [{ type: "text", text: "FINAL" }] })];
}

test("two runs progress in parallel under real child processes", async () => {
  const root = tmpRoot();
  try {
    const coordinator = makeRealCoordinator(root);
    const first = coordinator.start({ team: fixtureTeam(), task: "任务 A", ui: fakeUi() });
    const second = coordinator.start({ team: fixtureTeam(), task: "任务 B", ui: fakeUi() });
    const runA = coordinator.activeRunIds()[0]!;
    const runB = coordinator.activeRunIds()[1]!;
    assert.ok(runA && runB && runA !== runB, "two distinct runs claimed");

    // Both leaders are alive: neither promise resolved / no close observed.
    let settledA = false;
    void first.then(() => {
      settledA = true;
    });
    await waitFor(() => coordinator.activeRunIds().length === 2, "both runs active");
    assert.equal(settledA, false, "run A still running while B runs");

    // Per-run member events: only A's dispatch folds into A's progress.
    await steerWhenReady(coordinator, runA, "please dispatch now");
    await waitFor(() => coordinator.getStatus(runA)?.progress?.members[0]?.status === "done", "A member done");
    const progressA = coordinator.getStatus(runA)?.progress as RunProgress;
    const progressB = coordinator.getStatus(runB)?.progress as RunProgress;
    assert.equal(progressA.members[0]?.status, "done");
    assert.equal(progressB.members[0]?.status, "queued", "B's members untouched by A's dispatch");

    // Per-run steering: only B's child echoes B's message.
    await steerWhenReady(coordinator, runB, "hello-B");
    await waitFor(() => coordinator.getStatus(runB)?.progress?.leaderActivity === "STEER:hello-B", "B saw its steer");
    assert.notEqual(coordinator.getStatus(runA)?.progress?.leaderActivity, "STEER:hello-B", "A's channel did not see B's steer");

    // A settles first (agent_settled → stdin closed → real child exits).
    await steerWhenReady(coordinator, runA, "settle");
    const resultA = await first;
    assert.ok(resultA.ok);
    assert.equal(resultA.value?.status, "completed");
    assert.deepEqual(coordinator.getStatus().records.map((r) => r.runId).slice(0, 1), [runA], "A is the newest record");
    assert.deepEqual(coordinator.activeRunIds(), [runB], "B keeps running after A settled");

    // B settles later: both terminal records coexist, independently.
    await steerWhenReady(coordinator, runB, "settle");
    const resultB = await second;
    assert.ok(resultB.ok);
    assert.equal(resultB.value?.status, "completed");
    assert.equal(coordinator.getStatus().records.length, 2);
    assert.deepEqual(new Set(coordinator.getStatus().records.map((r) => r.runId)), new Set([runA, runB]));
    assert.equal(coordinator.getStatus(runA)?.progress, null);
    assert.equal(coordinator.getStatus(runA)?.lastRecord?.status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two runs start; the fourth is rejected with RUN_IN_PROGRESS listing active runIds", async () => {
  const root = tmpRoot();
  try {
    const coordinator = makeRealCoordinator(root);
    const promises = [0, 1, 2].map((i) =>
      coordinator.start({ team: fixtureTeam(), task: `task ${i}`, ui: fakeUi() }),
    );
    await waitFor(() => coordinator.activeRunIds().length === MAX_CONCURRENT_TEAM_RUNS, "cap reached");
    const activeIds = coordinator.activeRunIds();
    assert.equal(activeIds.length, MAX_CONCURRENT_TEAM_RUNS);

    const rejected = await coordinator.start({ team: fixtureTeam(), task: "one too many", ui: fakeUi() });
    assert.ok(!rejected.ok);
    assert.equal(rejected.code, "RUN_IN_PROGRESS");
    for (const id of activeIds) assert.ok(rejected.message.includes(id), `message lists ${id}`);
    assert.equal(coordinator.activeRunIds().length, MAX_CONCURRENT_TEAM_RUNS, "no fourth run claimed");

    // Keep the test bounded: settle all three real children.
    for (const id of activeIds) await steerWhenReady(coordinator, id, "settle");
    await Promise.all(promises);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runIds in the same millisecond get distinct -n suffixes", async () => {
  const root = tmpRoot();
  try {
    const spawn = makeFakeSpawn();
    const coordinator = new TeamRunCoordinator({
      cwd: () => root,
      worktreeRoot: path.join(root, "worktrees"),
      spawn: spawn.spawn,
      piCommand: "pi",
      transcriptRoot: path.join(root, "runs"),
      now: () => "2026-09-16T00:00:00Z",
      nowMs: () => 1000,
    });
    const first = coordinator.start({ team: fixtureTeam(), task: "a", ui: fakeUi() });
    const second = coordinator.start({ team: fixtureTeam(), task: "b", ui: fakeUi() });
    const ids = coordinator.activeRunIds();
    assert.deepEqual(ids, ["run-1000", "run-1000-2"]);
    assert.ok(fs.existsSync(path.join(root, "runs", "run-1000", "status.json")));
    assert.ok(fs.existsSync(path.join(root, "runs", "run-1000-2", "status.json")));

    const childA = await waitForChild(spawn, 0);
    const childB = await waitForChild(spawn, 1);
    childA.autoRespond(leaderLines(), 0, 5);
    childB.autoRespond(leaderLines(), 0, 5);
    const [resultA, resultB] = await Promise.all([first, second]);
    assert.ok(resultA.ok && resultB.ok);
    assert.deepEqual(coordinator.getStatus().records.map((r) => r.runId), ["run-1000-2", "run-1000"]);
    assert.equal(coordinator.getStatus("run-1000")?.lastRecord?.runId, "run-1000");
    assert.equal(coordinator.getStatus("run-1000-2")?.lastRecord?.runId, "run-1000-2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("records are bounded to five, newest first", async () => {
  const root = tmpRoot();
  try {
    const spawn = makeFakeSpawn();
    const coordinator = new TeamRunCoordinator({
      cwd: () => root,
      worktreeRoot: path.join(root, "worktrees"),
      spawn: spawn.spawn,
      piCommand: "pi",
    });
    const runIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const promise = coordinator.start({ team: fixtureTeam(), task: `task ${i}`, ui: fakeUi() });
      const runId = coordinator.activeRunIds().at(-1) ?? "";
      runIds.push(runId);
      const child = await waitForChild(spawn, i);
      child.autoRespond([messageEndLine("assistant", { content: [{ type: "text", text: `done ${i}` }] })], 0, 2);
      const result = await promise;
      assert.ok(result.ok);
    }
    const snapshot = coordinator.getStatus();
    assert.equal(snapshot.records.length, MAX_RETAINED_RUN_RECORDS);
    assert.deepEqual(snapshot.records.map((r) => r.runId), runIds.slice(2).reverse());
    assert.equal(snapshot.lastRecord?.runId, runIds[6], "lastRecord is the newest record");
    assert.equal(snapshot.records[0], snapshot.lastRecord);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stopAndSettle(runId) settles only the targeted run", async () => {
  const root = tmpRoot();
  try {
    const coordinator = makeRealCoordinator(root);
    const first = coordinator.start({ team: fixtureTeam(), task: "A", ui: fakeUi() });
    const second = coordinator.start({ team: fixtureTeam(), task: "B", ui: fakeUi() });
    const runA = coordinator.activeRunIds()[0]!;
    const runB = coordinator.activeRunIds()[1]!;
    await waitFor(() => coordinator.activeRunIds().length === 2, "both active");

    const outcome = await coordinator.stopAndSettle(runB, 5000);
    assert.equal(outcome.wasRunning, true);
    assert.equal(outcome.settled, true, "B's real child exits on SIGTERM");
    assert.equal(outcome.record?.status, "aborted");
    assert.equal(outcome.record?.runId, runB);
    assert.deepEqual(coordinator.activeRunIds(), [runA], "A keeps running");

    // A is untouched: it still settles into its own completed record.
    await steerWhenReady(coordinator, runA, "settle");
    const resultA = await first;
    assert.ok(resultA.ok);
    assert.equal(resultA.value?.status, "completed");
    const resultB = await second;
    assert.ok(resultB.ok);
    assert.equal(resultB.value?.status, "aborted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("getStatus(runId) projects a single run; an unknown runId returns null", async () => {
  const root = tmpRoot();
  try {
    const spawn = makeFakeSpawn();
    const coordinator = new TeamRunCoordinator({
      cwd: () => root,
      worktreeRoot: path.join(root, "worktrees"),
      spawn: spawn.spawn,
      piCommand: "pi",
    });
    const first = coordinator.start({ team: fixtureTeam(), task: "A", ui: fakeUi() });
    const second = coordinator.start({ team: fixtureTeam(), task: "B", ui: fakeUi() });
    const runA = coordinator.activeRunIds()[0]!;
    const runB = coordinator.activeRunIds()[1]!;

    const projection = coordinator.getStatus(runA);
    assert.ok(projection);
    assert.equal(projection.running, true);
    assert.equal(projection.progress?.runId, runA);
    assert.deepEqual(projection.actives.map((p) => p.runId), [runA]);

    assert.equal(coordinator.getStatus("run-unknown"), null);

    const aggregate = coordinator.getStatus();
    assert.equal(aggregate.actives.length, 2);
    assert.equal(aggregate.running, true);
    assert.equal(aggregate.progress?.runId, runB, "aggregate progress is the newest active run");

    const [childA, childB] = [await waitForChild(spawn, 0), await waitForChild(spawn, 1)];
    childB.autoRespond(leaderLines(), 0, 5);
    childA.autoRespond(leaderLines(), 0, 5);
    await Promise.all([first, second]);

    const afterTerminal = coordinator.getStatus(runA);
    assert.ok(afterTerminal);
    assert.equal(afterTerminal.running, false);
    assert.equal(afterTerminal.progress, null);
    assert.equal(afterTerminal.lastRecord?.runId, runA, "terminal projection pins the requested run");
    assert.deepEqual(afterTerminal.actives, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("formatStatusSnapshot renders multi-active sections and runId lookup", () => {
  const older: RunProgress = {
    runId: "run-old",
    team: "alpha",
    task: "第一个任务",
    startedAtMs: 0,
    members: [{ name: "frontend", status: "running", model: "m1", note: "turn 1" }],
  };
  const newer: RunProgress = {
    runId: "run-new",
    team: "beta",
    task: "第二个任务",
    startedAtMs: 65_000,
    leaderDeclaredModel: "opencode-go/deepseek",
    leaderModel: "deepseek-v3",
    members: [{ name: "backend", status: "queued" }],
  };
  const multi = formatStatusSnapshot(
    { running: true, progress: newer, lastRecord: null, actives: [older, newer], records: [] },
    130_000,
  );
  assert.match(multi, new RegExp(`^当前共 2 个 run 并行（上限 ${MAX_CONCURRENT_TEAM_RUNS}）：`));
  assert.match(multi, /── run run-old · team alpha ▶ running · 2m10s/);
  assert.match(multi, /── run run-new · team beta ▶ running · 1m5s/);
  assert.match(multi, /任务: 第一个任务/);
  assert.match(multi, /任务: 第二个任务/);
  assert.match(multi, /leader: opencode-go\/deepseek-v3/);
  assert.match(multi, /▶ frontend running — m1 — turn 1/);
  assert.doesNotMatch(multi, /当前 run：/);

  // runId-targeted lookup keeps the single-run format (zero regression).
  const targeted = formatStatusSnapshot(
    { running: true, progress: older, lastRecord: null, actives: [older], records: [] },
    10_000,
    undefined,
    "run-old",
  );
  assert.match(targeted, /当前 run：team alpha ▶ running · 10s/);
  assert.match(targeted, /runId: run-old/);
  assert.doesNotMatch(targeted, /── run /);

  // No active runs + several records: single record block plus the recent tail.
  const records = [0, 1, 2, 3, 4, 5].map((i) => ({
    runId: `run-${i}`,
    team: "t",
    task: "x",
    startedAt: `2026-09-16T00:00:0${i}Z`,
    status: (i === 0 ? "completed" : i === 1 ? "failed" : "aborted") as "completed" | "failed" | "aborted",
    members: [],
    totalCost: 0,
    totalTokens: 0,
  }));
  const tail = formatStatusSnapshot({ running: false, progress: null, lastRecord: records[0]!, actives: [], records }, 0);
  assert.match(tail, /最近一次 run：team t ✓ completed/);
  assert.match(tail, /近期 run：run-1 ✗failed · run-2 ⊘aborted · run-3 ⊘aborted · run-4 ⊘aborted（最多再列 4 条；\/team:status <runId> 查看详情）/);
  assert.doesNotMatch(tail, /run-5/);
});
