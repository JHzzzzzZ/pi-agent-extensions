/**
 * Cockpit coordinator tests: leader spawn args + env, progress tracking
 * (leader activity + member latest), team shared worktree + pre-flight,
 * status snapshots, RUN_IN_PROGRESS, stop/abort.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { formatStatusSnapshot, renderWidgetLines, TeamRunCoordinator, type UiPort } from "../cockpit.ts";
import { fixtureTeam } from "./fixtures.ts";
import {
  makeFakeSpawn,
  messageEndLine,
  toolExecutionStartLine,
  toolExecutionEndLine,
  waitForChild,
} from "./helpers.ts";

function fakeUi(): UiPort & { widgets: Array<string[] | undefined> } {
  const widgets: Array<string[] | undefined> = [];
  return {
    widgets,
    setWidget: (lines) => widgets.push(lines),
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

  assert.deepEqual(record.args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
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
  assert.equal(record.args[record.args.length - 1], "Task: 修复登录 bug");
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
  assert.ok(ui.widgets.length > 0, "widget rendered");
  // Leader activity + member latest surface in the widget lines.
  const flattened = ui.widgets.flat().join("\n");
  assert.match(flattened, /拆解成两个子任务/);
  assert.match(flattened, /前端完成/);
  assert.ok(progressUpdates.length > 0, "onProgress fired");
  assert.equal(coordinator.isRunning(), false);
  // Status snapshot: run over, last record available.
  const status = coordinator.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.lastRecord?.runId, run.runId);
});

test("widget renderer shows team, task, leader activity and member lines", () => {
  const lines = renderWidgetLines(
    {
      runId: "r",
      team: "dev-team",
      task:
        "一个比较长的任务描述超过四十四个字符会被截断省略号结尾一个比较长的任务描述超过四十四个字符省略",
      startedAtMs: 0,
      leaderModel: "m1",
      leaderNote: "turn 2",
      leaderActivity: "正在审查成员结果",
      members: [
        { name: "frontend", status: "running", note: "turn 1", latest: "正在编辑 login.tsx" },
        { name: "backend", status: "done" },
      ],
    },
    65000,
    (t) => t,
  );
  assert.match(lines[0], /agent-team dev-team ▶ running · 1m5s/);
  assert.match(lines[1], /任务: .+…/);
  assert.match(lines[2], /leader: m1 · turn 2/);
  assert.match(lines[3], /↳ 正在审查成员结果/);
  assert.match(lines[4], /▶ frontend running — turn 1 — 正在编辑 login\.tsx/);
  assert.match(lines[5], /✓ backend done/);
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

  const add = gitCalls.find((c) => c.args[0] === "worktree");
  assert.ok(add, "shared worktree created");
  const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
  assert.deepEqual(add.args.slice(0, 3), ["worktree", "add", path.join("/tmp/worktrees", runId, "team")]);
  assert.equal(add.args[3], "-b");
  assert.equal(add.args[4], `team/${runId}`);
  assert.equal(spawn.records[0].cwd, path.join("/tmp/worktrees", runId, "team"));

  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.value?.worktree, {
    path: path.join("/tmp/worktrees", runId, "team"),
    branch: `team/${runId}`,
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
  assert.match(done, /✓ frontend done — m/);
  assert.match(done, /共享 worktree: `\/wt\/team`/);

  const empty = formatStatusSnapshot({ running: false, progress: null, lastRecord: null }, 0);
  assert.match(empty, /没有 team run 记录/);
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
