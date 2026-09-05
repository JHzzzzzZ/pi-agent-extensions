/**
 * Cockpit coordinator tests: leader spawn args + env, progress tracking,
 * record assembly, RUN_IN_PROGRESS, stop/abort.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { renderWidgetLines, TeamRunCoordinator, type UiPort } from "../cockpit.ts";
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
    toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }),
    dispatchDetails([
      { name: "frontend", ok: true, status: "done", summary: "前端做完", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } },
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
  assert.ok(Math.abs(run.totalCost - 0.05) < 1e-9);
  assert.equal(run.leaderUsage?.model, "claude-opus-4-5");
  assert.equal(run.members.length, 2);
  assert.equal(run.members[0].name, "frontend");
  assert.equal(run.members[0].model, "chatanywhere/gpt-5.6");
  assert.equal(run.members[0].summary, "前端做完");
  assert.equal(run.members[1].worktree?.branch, "team/r/backend");
  assert.equal(run.members[1].model, "anthropic/claude-sonnet-4-5");
  assert.ok(ui.widgets.length > 0, "widget rendered");
  assert.ok(progressUpdates.length > 0, "onProgress fired");
  assert.equal(coordinator.isRunning(), false);
});

test("widget renderer shows team, task, leader and member lines", () => {
  const lines = renderWidgetLines(
    {
      runId: "r",
      team: "dev-team",
      task:
        "一个比较长的任务描述超过四十四个字符会被截断省略号结尾一个比较长的任务描述超过四十四个字符省略",
      startedAtMs: 0,
      leaderModel: "m1",
      leaderNote: "turn 2",
      members: [
        { name: "frontend", status: "running", note: "turn 1" },
        { name: "backend", status: "done" },
      ],
    },
    65000,
    (t) => t,
  );
  assert.match(lines[0], /agent-team dev-team ▶ running · 1m5s/);
  assert.match(lines[1], /任务: .+…/);
  assert.match(lines[2], /leader: m1 · turn 2/);
  assert.match(lines[3], /▶ frontend running — turn 1/);
  assert.match(lines[4], /✓ backend done/);
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
