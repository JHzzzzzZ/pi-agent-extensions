/**
 * Cockpit ↔ leader question bridge tests (fake spawn): the coordinator turns
 * a leader `extension_ui_request` into a main-session dialog and writes the
 * `extension_ui_response` back over the leader's RPC stdin. Degradations
 * (no UI, timeout backstop, stop, settle) are all fail-closed.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AskPort, AskRequest } from "../ask.ts";
import { TeamRunCoordinator, type UiPort } from "../cockpit.ts";
import { LEADER_ACTOR, readTranscript } from "../transcript.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, waitForChild } from "./helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fakeUi(): UiPort {
  return { notify: () => {}, dim: (text) => text };
}

function askLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "extension_ui_request",
    id: "q1",
    method: "input",
    title: "[dev-team] 要发到哪个环境？",
    ...overrides,
  });
}

function responses(child: { writes: string[] }): Array<Record<string, unknown>> {
  return child.writes
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((message): message is Record<string, unknown> => message?.type === "extension_ui_response");
}

function makeCoordinator(root: string, spawn: ReturnType<typeof makeFakeSpawn>) {
  return new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot: root,
    askBackstopMarginMs: 10,
  });
}

test("coordinator bridges a leader question to the main session and writes the answer back", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-ask-"));
  try {
    const spawn = makeFakeSpawn();
    const seen: AskRequest[] = [];
    const activities: string[] = [];
    let activityWhileWaiting = "";
    const coordinator = makeCoordinator(root, spawn);
    const promise = coordinator.start({
      team: fixtureTeam(),
      task: "修复登录 bug",
      ui: fakeUi(),
      onProgress: (progress) => {
        if (progress.leaderActivity) activities.push(progress.leaderActivity);
      },
      ask: {
        present: async (request) => {
          seen.push(request);
          activityWhileWaiting = coordinator.getStatus().progress?.leaderActivity ?? "";
          return { kind: "answer", value: "staging" };
        },
      },
    });
    const child = await waitForChild(spawn, 0);
    child.emitLine(askLine());
    await sleep(10);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "input");
    assert.equal(seen[0].title, "[dev-team] 要发到哪个环境？");
    assert.deepEqual(responses(child), [{ type: "extension_ui_response", id: "q1", value: "staging" }]);
    assert.match(activityWhileWaiting, /等待人工回答/);

    child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "FINAL" }], usage: { input: 1, output: 1, cost: { total: 0 } } }));
    child.emitClose(0);
    const result = await promise;
    assert.ok(result.ok);

    const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    const qa = readTranscript(root, runId, LEADER_ACTOR).filter((e) => e.kind === "question" || e.kind === "answer");
    assert.deepEqual(
      qa.map((e) => [e.kind, e.text]),
      [
        ["question", "提问：[dev-team] 要发到哪个环境？"],
        ["answer", "回答：staging"],
      ],
    );
    assert.ok(activities.includes("已收到回答，leader 继续"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("coordinator answers cancelled when the main session has no UI, and records why", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-ask-"));
  try {
    const spawn = makeFakeSpawn();
    const coordinator = makeCoordinator(root, spawn);
    const promise = coordinator.start({
      team: fixtureTeam(),
      task: "t",
      ui: fakeUi(),
      ask: { present: async () => ({ kind: "unavailable" }) },
    });
    const child = await waitForChild(spawn, 0);
    child.emitLine(askLine({ method: "select", options: ["staging", "prod"] }));
    await sleep(10);
    assert.deepEqual(responses(child), [{ type: "extension_ui_response", id: "q1", cancelled: true }]);
    child.emitClose(0);
    await promise;

    const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    const entries = readTranscript(root, runId, LEADER_ACTOR);
    assert.ok(entries.some((e) => e.kind === "question" && e.text.includes("选项：staging / prod")));
    assert.ok(entries.some((e) => e.kind === "system" && e.text === "未获回答（主会话无 UI）"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("coordinator backstop timeout cancels a dialog the host never resolves", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-ask-"));
  try {
    const spawn = makeFakeSpawn();
    const coordinator = makeCoordinator(root, spawn);
    const promise = coordinator.start({
      team: fixtureTeam(),
      task: "t",
      ui: fakeUi(),
      ask: { present: () => new Promise(() => {}) },
    });
    const child = await waitForChild(spawn, 0);
    child.emitLine(askLine({ timeout: 20 }));
    await sleep(100);
    assert.deepEqual(responses(child), [{ type: "extension_ui_response", id: "q1", cancelled: true }]);
    child.emitClose(0);
    await promise;
    const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    assert.ok(readTranscript(root, runId, LEADER_ACTOR).some((e) => e.text === "未获回答（超时）"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stop aborts the in-flight dialog and answers cancelled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-ask-"));
  try {
    const spawn = makeFakeSpawn();
    const signals: AbortSignal[] = [];
    const coordinator = makeCoordinator(root, spawn);
    const promise = coordinator.start({
      team: fixtureTeam(),
      task: "t",
      ui: fakeUi(),
      ask: {
        present: (_request, signal) => {
          signals.push(signal);
          return new Promise(() => {});
        },
      },
    });
    const child = await waitForChild(spawn, 0);
    child.emitLine(askLine());
    await sleep(10);
    const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    const stopped = await coordinator.stopAndSettle(runId, 200);
    assert.equal(stopped.wasRunning, true);
    assert.equal(signals[0]?.aborted, true, "host dialog signal aborted by the run abort");
    assert.deepEqual(responses(child), [{ type: "extension_ui_response", id: "q1", cancelled: true }]);
    child.emitClose(null);
    const result = await promise;
    assert.ok(result.ok && result.value.status === "aborted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dialog request arriving after the leader settled is ignored", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-ask-"));
  try {
    const spawn = makeFakeSpawn();
    let presented = 0;
    const port: AskPort = {
      present: async () => {
        presented++;
        return { kind: "answer", value: "x" };
      },
    };
    const coordinator = makeCoordinator(root, spawn);
    const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi(), ask: port });
    const child = await waitForChild(spawn, 0);
    child.emitLine(JSON.stringify({ type: "agent_settled" }));
    child.emitLine(askLine());
    await sleep(10);
    assert.equal(presented, 0);
    assert.deepEqual(responses(child), []);
    child.emitClose(0);
    await promise;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
