/**
 * Cockpit coordinator tests: leader spawn args + env, progress tracking
 * (leader activity + member latest), team shared worktree + pre-flight,
 * status snapshots, RUN_IN_PROGRESS, stop/abort.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { formatStatusSnapshot, TeamRunCoordinator, type UiPort } from "../cockpit.ts";
import { visibleWidth } from "../viewer.ts";
import { teamWorktreeBranch } from "../worktree.ts";
import { fixtureTeam } from "./fixtures.ts";
import {
  makeFakeSpawn,
  messageEndLine,
  toolExecutionStartLine,
  toolExecutionEndLine,
  waitForChild,
} from "./helpers.ts";

function fakeUi(): UiPort {
  return {
    notify: () => {},
    dim: (text) => text,
  };
}

function dispatchDetails(members: Array<Record<string, unknown>>): string {
  return toolExecutionEndLine("team_dispatch", {
    content: [{ type: "text", text: "report" }],
    details: { members, totalUsage: { input: 1, output: 1, cost: 0.02, turns: 2 } },
  });
}

function leaderLines(): string[] {
  return [
    messageEndLine("assistant", {
      content: [{ type: "text", text: "让我先把任务拆解成两个子任务" }],
      usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15 },
    }),
    toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }),
    dispatchDetails([
      { name: "frontend", ok: true, status: "done", summary: "前端做完", latest: "前端完成", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } },
      { name: "backend", ok: true, status: "done", summary: "后端做完", usage: { input: 20, output: 8, cost: 0.02, turns: 2 }, worktree: { path: "/wt/backend", branch: "team/r/backend" } },
    ]),
    messageEndLine("assistant", {
      content: [{ type: "text", text: "FINAL REPORT" }],
      usage: { input: 50, output: 20, cost: { total: 0.05 }, totalTokens: 300 },
      model: "claude-opus-4-5",
    }),
  ];
}

test("coordinator spawns the leader with prompt/env/-e and folds member results into the record", async () => {
  const spawn = makeFakeSpawn();
  const ui = fakeUi();
  const progressUpdates: string[] = [];
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    extensionEntryPath: "/ext/agent-team/index.ts",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({
    team: fixtureTeam(),
    task: "修复登录 bug",
    ui,
    onProgress: (progress) => progressUpdates.push(progress.team),
  });
  const child = await waitForChild(spawn, 0);
  const record = spawn.records[0];

  assert.deepEqual(record.args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
  assert.equal(record.stdin, "pipe", "RPC leader keeps a live stdin channel");
  assert.equal(record.args[record.args.indexOf("--model") + 1], "anthropic/claude-opus-4-5");
  const extIndex = record.args.indexOf("-e");
  assert.equal(record.args[extIndex + 1], "/ext/agent-team/index.ts");
  const promptIndex = record.args.indexOf("--append-system-prompt");
  const promptPath = record.args[promptIndex + 1];
  assert.ok(!promptPath.startsWith("team-tmp://"), "prompt materialized to a temp file before spawn");
  const promptContent = fs.readFileSync(promptPath, "utf-8");
  assert.match(promptContent, /team_dispatch/);
  assert.match(promptContent, /frontend/);
  assert.match(promptContent, /你是技术负责人/);
  // RPC 模式：task 走 stdin 的初始 prompt 命令（不再作 argv 尾参）
  assert.ok(!record.args.some((arg) => arg.startsWith("Task: ")), "task not in argv");
  assert.deepEqual(JSON.parse(child.writes[0] ?? "{}"), {
    type: "prompt",
    id: "task",
    message: "Task: 修复登录 bug",
  });
  assert.equal(record.env?.PI_AGENT_TEAM_FILE, fixtureTeam().filePath);
  assert.equal(record.env?.PI_AGENT_TEAM_NAME, "dev-team");
  assert.match(record.env?.PI_AGENT_TEAM_RUN_ID ?? "", /^run-\d+$/);
  assert.equal(record.cwd, "/repo");

  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.equal(fs.existsSync(promptPath), false, "temp prompt removed after exit");
  const run = result.value!;
  assert.equal(run.status, "completed");
  assert.equal(run.report, "FINAL REPORT");
  assert.equal(run.team, "dev-team");
  assert.equal(run.durationMs !== undefined, true);
  assert.ok(Math.abs(run.totalCost - 0.051) < 1e-9);
  assert.equal(run.leaderUsage?.model, "claude-opus-4-5");
  assert.equal(run.members.length, 2);
  assert.equal(run.members[0].name, "frontend");
  assert.equal(run.members[0].model, "chatanywhere/gpt-5.6");
  assert.equal(run.members[0].summary, "前端做完");
  assert.equal(run.members[1].worktree?.branch, "team/r/backend");
  assert.equal(run.members[1].model, "anthropic/claude-sonnet-4-5");
  assert.ok(progressUpdates.length > 0, "onProgress fired");
  assert.equal(coordinator.isRunning(), false);
  // Status snapshot: run over, last record available.
  const status = coordinator.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.lastRecord?.runId, run.runId);
});

test("RPC steer：run 运行中插话写入 stdin，agent_settled 后关闭 stdin（进程退出门）", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "数数", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);

  assert.equal(coordinator.steerLeader("插话一"), true);
  assert.equal(coordinator.steerLeader("插话二"), true);
  assert.deepEqual(
    child.writes.slice(1).map((line) => JSON.parse(line)),
    [
      { type: "steer", message: "插话一" },
      { type: "steer", message: "插话二" },
    ],
  );

  // agent_settled = 本轮任务结束 → 关 stdin，RPC 进程才能退出
  child.emitLine(JSON.stringify({ type: "agent_settled" }));
  assert.equal(child.ended, true, "settle 后关闭 stdin");
  assert.equal(coordinator.steerLeader("太晚了"), false, "关闭后不再接受插话");

  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value!.status, "completed");
});

test("prompt 被 pi 拒绝：记错误 + 关 stdin，run 以 failed 落定而不是挂起", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "x", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);

  child.emitLine(
    JSON.stringify({ type: "response", id: "task", command: "prompt", success: false, error: "Unknown model: a/b" }),
  );
  assert.equal(child.ended, true, "prompt 失败无 settle 事件，必须主动关 stdin");
  child.emitClose(0);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value!.status, "failed");
  assert.match(result.value!.error ?? "", /Unknown model: a\/b/);
});

test("team-level shared worktree: leader runs inside it and the record carries it", async () => {
  const gitCalls: Array<{ args: string[] }> = [];
  const fakeGit = async (args: string[]) => {
    gitCalls.push({ args });
    return { code: 0, stdout: args[0] === "rev-parse" ? "true\n" : "", stderr: "" };
  };
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    gitRunner: fakeGit,
  });
  const team = fixtureTeam({ worktree: true });
  const promise = coordinator.start({ team, task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);

  const add = gitCalls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
  assert.ok(add, "shared worktree created");
  const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
  assert.deepEqual(add.args.slice(0, 3), ["worktree", "add", path.join("/tmp/worktrees", runId, "team")]);
  assert.equal(add.args[3], "-b");
  assert.equal(add.args[4], teamWorktreeBranch(runId));
  assert.equal(spawn.records[0].cwd, path.join("/tmp/worktrees", runId, "team"));

  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.value?.worktree, {
    path: path.join("/tmp/worktrees", runId, "team"),
    branch: teamWorktreeBranch(runId),
  });
});

test("pre-flight: worktree members without a git repo fail fast without spawning", async () => {
  const fakeGit = async (args: string[]) =>
    args[0] === "rev-parse" ? { code: 1, stdout: "false\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/not-a-repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    gitRunner: fakeGit,
  });
  const team = fixtureTeam({
    members: [{ name: "backend", worktree: true, prompt: "p" }],
  });
  const result = await coordinator.start({ team, task: "t", ui: fakeUi() });
  assert.ok(!result.ok);
  assert.equal(result.code, "WORKTREE_UNAVAILABLE");
  assert.match(result.message, /预检失败/);
  assert.equal(spawn.records.length, 0, "no leader spawned");
});

test("formatStatusSnapshot renders a running snapshot and the last record", () => {
  const running = formatStatusSnapshot(
    {
      running: true,
      progress: {
        runId: "r",
        team: "dev-team",
        task: "修复 bug",
        startedAtMs: 0,
        leaderModel: "m1",
        leaderNote: "turn 3",
        leaderActivity: "正在汇总报告",
        members: [{ name: "frontend", status: "running", note: "turn 2", latest: "在写样式" }],
      },
      lastRecord: null,
    },
    5000,
  );
  assert.match(running, /当前 run：team dev-team ▶ running · 5s/);
  assert.match(running, /runId: r/);
  assert.match(running, /leader: m1 · turn 3/);
  assert.match(running, /↳ 正在汇总报告/);
  assert.match(running, /▶ frontend running — turn 2 — 在写样式/);

  const done = formatStatusSnapshot(
    {
      running: false,
      progress: null,
      lastRecord: {
        runId: "run-1",
        team: "dev-team",
        task: "修复 bug",
        startedAt: "2026-09-05T12:00:00Z",
        status: "completed",
        report: "done",
        members: [{ name: "frontend", model: "m", status: "done", summary: "做完了" }],
        totalCost: 0.05,
        totalTokens: 100,
        durationMs: 12000,
        worktree: { path: "/wt/team", branch: "team/run-1" },
      },
    },
    0,
  );
  assert.match(done, /最近一次 run：team dev-team ✓ completed · 12s · \$0\.0500/);
  assert.match(done, /runId: run-1/);
  assert.match(done, /✓ frontend done — m/);
  assert.match(done, /共享 worktree: `\/wt\/team`/);

  const empty = formatStatusSnapshot({ running: false, progress: null, lastRecord: null }, 0);
  assert.match(empty, /没有 team run 记录/);
});

test("formatStatusSnapshot 任务行压平多行任务（运行态与终态同口径，不产生残行）", () => {
  const multiLine = "目标：修复登录页\n  第二步：回归测试\n\t第三步：交付";
  const flattened = "目标：修复登录页 第二步：回归测试 第三步：交付";
  const running = formatStatusSnapshot(
    {
      running: true,
      progress: { runId: "r", team: "dev-team", task: multiLine, startedAtMs: 0, members: [] },
      lastRecord: null,
    },
    0,
  );
  const done = formatStatusSnapshot(
    {
      running: false,
      progress: null,
      lastRecord: {
        runId: "run-1",
        team: "dev-team",
        task: multiLine,
        startedAt: "2026-09-05T12:00:00Z",
        status: "completed",
        members: [],
        totalCost: 0,
        totalTokens: 0,
      },
    },
    0,
  );
  for (const [label, output] of [["运行态", running], ["终态", done]] as const) {
    const lines = output.split("\n");
    const taskLine = lines.find((line) => line.startsWith("任务: "));
    assert.equal(taskLine, `任务: ${flattened}`, `${label}：任务残片必须压平成单行并以单空格相连`);
    assert.ok(
      !lines.some((line) => line.trim() === "第二步：回归测试" || line.trim() === "第三步：交付"),
      `${label}：任务子行不得再作为独立物理行出现`,
    );
  }
});

test("formatStatusSnapshot 任务行按显示宽度截断（上限 60 列、CJK 双宽，运行态与终态同口径）", () => {
  const longTask = "分析".repeat(50) + "abc".repeat(50);
  const running = formatStatusSnapshot(
    {
      running: true,
      progress: { runId: "r", team: "dev-team", task: longTask, startedAtMs: 0, members: [] },
      lastRecord: null,
    },
    0,
  );
  const done = formatStatusSnapshot(
    {
      running: false,
      progress: null,
      lastRecord: {
        runId: "run-1",
        team: "dev-team",
        task: longTask,
        startedAt: "2026-09-05T12:00:00Z",
        status: "completed",
        members: [],
        totalCost: 0,
        totalTokens: 0,
      },
    },
    0,
  );
  for (const [label, output] of [["运行态", running], ["终态", done]] as const) {
    const taskLine = output.split("\n").find((line) => line.startsWith("任务: "));
    assert.ok(taskLine, `${label}：必须输出任务行`);
    const taskText = taskLine.slice("任务: ".length);
    assert.ok(visibleWidth(taskText) <= 60, `${label}：任务文本 ≤ 60 显示列（实际 ${visibleWidth(taskText)}）`);
    assert.ok(taskText.endsWith("…"), `${label}：超宽任务以 … 结尾`);
    assert.ok(visibleWidth(taskLine) <= 66, `${label}：任务行 ≤ 66 显示列（实际 ${visibleWidth(taskLine)}）`);
  }
});

test("restoreLastRecord keeps the most recent record (hydration after reload)", () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const older = { runId: "run-1", team: "t", task: "x", startedAt: "2026-09-05T10:00:00Z", status: "completed" } as never;
  const newer = { runId: "run-2", team: "t", task: "y", startedAt: "2026-09-05T11:00:00Z", status: "failed" } as never;
  coordinator.restoreLastRecord(older);
  coordinator.restoreLastRecord(newer);
  assert.equal(coordinator.getStatus().lastRecord?.runId, "run-2");
});

test("second start while running is rejected with RUN_IN_PROGRESS", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const first = coordinator.start({ team: fixtureTeam(), task: "t1", ui: fakeUi() });
  await waitForChild(spawn, 0);
  const second = await coordinator.start({ team: fixtureTeam(), task: "t2", ui: fakeUi() });
  assert.ok(!second.ok);
  assert.equal(second.code, "RUN_IN_PROGRESS");
  const child = await waitForChild(spawn, 0);
  child.autoRespond(leaderLines());
  const result = await first;
  assert.ok(result.ok);
});

test("stop() aborts the run and the record is marked aborted", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    killGraceMs: 10,
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  assert.equal(coordinator.stop(), true);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(child.killed.includes("SIGTERM"));
  child.emitClose(null);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "aborted");
  assert.equal(coordinator.stop(), false);
});

test("stopAndSettle aborts the active run and returns the terminal aborted record", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  const settle = coordinator.stopAndSettle();
  assert.ok(child.killed.includes("SIGTERM"), "abort sent synchronously");
  child.emitClose(null);
  const outcome = await settle;
  assert.equal(outcome.wasRunning, true);
  assert.equal(outcome.settled, true);
  assert.equal(outcome.record?.status, "aborted");
  assert.equal(outcome.record?.runId, spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID);
  // Stale progress cleared: status lands on the terminal record, not a phantom "running".
  const status = coordinator.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.progress, null);
  assert.equal(status.lastRecord?.status, "aborted");
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "aborted");
  // Settle removed the RUN_IN_PROGRESS residue: an immediate restart works.
  const second = coordinator.start({ team: fixtureTeam(), task: "t2", ui: fakeUi() });
  const child2 = await waitForChild(spawn, 1);
  assert.equal(spawn.records.length, 2, "second leader spawned right after settle");
  child2.autoRespond(leaderLines());
  const secondResult = await second;
  assert.ok(secondResult.ok);
  assert.equal(secondResult.value?.status, "completed");
});

test("stopAndSettle with no active run reports wasRunning:false", async () => {
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    piCommand: "pi",
  });
  const outcome = await coordinator.stopAndSettle();
  assert.deepEqual(outcome, { wasRunning: false, settled: true, record: null });
});

test("stopAndSettle times out while children are still shutting down (settled:false, not an error)", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  const outcome = await coordinator.stopAndSettle(30);
  assert.equal(outcome.wasRunning, true);
  assert.equal(outcome.settled, false);
  assert.equal(outcome.record, null);
  assert.ok(child.killed.includes("SIGTERM"), "abort still sent before the timeout");
  // Once the child finally closes, the run settles into the terminal record.
  child.emitClose(null);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "aborted");
  assert.equal(coordinator.getStatus().progress, null);
});

test("aborted runs fold the full roster into the record: queued/running members become aborted", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const team = fixtureTeam({
    members: [
      ...fixtureTeam().members,
      { name: "db", model: "anthropic/claude-sonnet-4-5", prompt: "你是 DBA。" },
    ],
  });
  const promise = coordinator.start({ team, task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  // Partial progress: one member dispatched and finished; the other two never started.
  child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "拆解任务" }] }));
  child.emitLine(toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }] }));
  child.emitLine(
    dispatchDetails([
      { name: "frontend", ok: true, status: "done", summary: "前端做完", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } },
    ]),
  );
  void coordinator.stopAndSettle();
  child.emitClose(null);
  const result = await promise;
  assert.ok(result.ok);
  const record = result.value!;
  assert.equal(record.status, "aborted");
  assert.equal(record.members.length, 3, "every roster member present in the record");
  const byName = new Map(record.members.map((m) => [m.name, m]));
  assert.equal(byName.get("frontend")?.status, "done");
  assert.equal(byName.get("backend")?.status, "aborted");
  assert.equal(byName.get("backend")?.model, "anthropic/claude-sonnet-4-5");
  assert.equal(byName.get("db")?.status, "aborted");
  assert.equal(byName.get("db")?.model, "anthropic/claude-sonnet-4-5");
});

/**
 * Roster-fold regression (see cockpit.ts start() aborted path): a run that
 * is aborted after its dispatch results have been parsed must not lose the
 * members that never finished a dispatch. Those appear as "aborted".
 */
test("aborted roster fold leaves completed members untouched", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const team = fixtureTeam();
  const promise = coordinator.start({ team, task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.emitLine(toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }));
  child.emitLine(
    dispatchDetails([
      { name: "frontend", ok: true, status: "done", summary: "s", usage: { input: 1, output: 1, cost: 0, turns: 1 } },
      { name: "backend", ok: false, status: "failed", summary: "f", usage: { input: 1, output: 1, cost: 0, turns: 1 } },
    ]),
  );
  void coordinator.stopAndSettle();
  child.emitClose(null);
  const result = await promise;
  assert.ok(result.ok);
  const record = result.value!;
  assert.equal(record.status, "aborted");
  assert.equal(record.members.length, 2, "completed dispatch statuses survive the fold");
  assert.equal(record.members.find((m) => m.name === "frontend")?.status, "done");
  assert.equal(record.members.find((m) => m.name === "backend")?.status, "failed");
});

// ---------------------------------------------------------------------------
// stopAndSettle helpers are kept private; the coordinator's own promise is
// the only settle boundary (bounded wait, never throws).
// ---------------------------------------------------------------------------

test("leader child failure marks the run failed with the error detail", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.autoRespond(
    [messageEndLine("assistant", { content: [{ type: "text", text: "partial" }], errorMessage: "model exploded", stopReason: "error" })],
    1,
    5,
  );
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "failed");
  assert.match(result.value?.error ?? "", /model exploded/);
});
