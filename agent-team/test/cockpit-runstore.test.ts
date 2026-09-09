/**
 * Coordinator ↔ runstore integration: the coordinator persists a running
 * status.json snapshot as soon as it claims the run (before spawning),
 * refreshes it with the leader PID after spawn, and rewrites it with the
 * terminal status on every exit path — so a crashed main session never
 * leaves a stale "running" behind. Fake-spawn integration against the real
 * runstore.ts file logic.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { TeamRunCoordinator, type UiPort } from "../cockpit.ts";
import { readRunStatuses } from "../runstore.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, waitForChild } from "./helpers.ts";

function fakeUi(): UiPort {
  return { notify: () => {}, dim: (text) => text };
}

function leaderDone(): string[] {
  return [messageEndLine("assistant", { content: [{ type: "text", text: "FINAL" }] })];
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-cockpit-runstore-"));
}

test("coordinator writes a running snapshot on claim and the terminal status at the end", async () => {
  const transcriptRoot = tmpRoot();
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot,
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "修复 bug", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);

  // Claim already happened: the running snapshot exists before any output.
  const running = readRunStatuses(transcriptRoot);
  assert.equal(running.entries.length, 1);
  assert.equal(running.entries[0].status, "running");
  assert.equal(running.entries[0].team, "dev-team");
  assert.equal(running.entries[0].task, "修复 bug");
  assert.equal(running.entries[0].runId, spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID);
  assert.equal(running.entries[0].leaderPid, undefined);
  assert.equal(running.corrupt.length, 0);

  child.autoRespond(leaderDone());
  const result = await promise;
  assert.ok(result.ok);
  const terminal = readRunStatuses(transcriptRoot);
  assert.equal(terminal.entries.length, 1, "same file overwritten, not duplicated");
  assert.equal(terminal.entries[0].status, "completed");
  assert.equal(terminal.entries[0].runId, running.entries[0].runId);
});

test("the leader PID lands in the running snapshot after spawn", async () => {
  const transcriptRoot = tmpRoot();
  const spawn = makeFakeSpawn();
  spawn.nextPid = (index) => 4000 + index;
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot,
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  const running = readRunStatuses(transcriptRoot);
  assert.equal(running.entries[0].leaderPid, 4000, "pid captured at spawn time");
  child.autoRespond(leaderDone());
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(readRunStatuses(transcriptRoot).entries[0].leaderPid, 4000, "terminal rewrite keeps the pid");
});

test("worktree pre-flight failure rewrites the snapshot to failed (no stale running)", async () => {
  const transcriptRoot = tmpRoot();
  const spawn = makeFakeSpawn();
  const fakeGit = async (args: string[]) =>
    args[0] === "rev-parse" ? { code: 1, stdout: "false\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/not-a-repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot,
    gitRunner: fakeGit,
  });
  const result = await coordinator.start({
    team: fixtureTeam({ members: [{ name: "backend", worktree: true, prompt: "p" }] }),
    task: "t",
    ui: fakeUi(),
  });
  assert.ok(!result.ok);
  assert.equal(spawn.records.length, 0);
  const terminal = readRunStatuses(transcriptRoot);
  assert.equal(terminal.entries[0].status, "failed");
  assert.match(terminal.entries[0].error ?? "", /预检失败/);
});

test("leader spawn failure (CHILD_FAILED) rewrites the snapshot to failed", async () => {
  const transcriptRoot = tmpRoot();
  const spawn = makeFakeSpawn();
  spawn.spawnError = new Error("pi not found");
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot,
  });
  const result = await coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  assert.ok(!result.ok);
  assert.equal(result.code, "CHILD_FAILED");
  const terminal = readRunStatuses(transcriptRoot);
  assert.equal(terminal.entries[0].status, "failed");
  assert.match(terminal.entries[0].error ?? "", /pi not found/);
});

test("a failed leader exit rewrites the snapshot to failed with the error detail", async () => {
  const transcriptRoot = tmpRoot();
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot,
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.autoRespond(
    [messageEndLine("assistant", { content: [{ type: "text", text: "boom" }], errorMessage: "model exploded", stopReason: "error" })],
    1,
    5,
  );
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "failed");
  const terminal = readRunStatuses(transcriptRoot);
  assert.equal(terminal.entries[0].status, "failed");
  assert.match(terminal.entries[0].error ?? "", /model exploded/);
});

test("an aborted run rewrites the snapshot to aborted", async () => {
  const transcriptRoot = tmpRoot();
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    killGraceMs: 10,
    transcriptRoot,
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  coordinator.stop();
  child.emitClose(null);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "aborted");
  assert.equal(readRunStatuses(transcriptRoot).entries[0].status, "aborted");
});
