/**
 * Run transcript artifact tests: FileTranscriptSink append/read roundtrip,
 * actor name sanitization, file cap, retention pruning, lenient parsing,
 * plus integration — the dispatch executor records member activity and the
 * cockpit records leader activity into the run artifact directory.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createDispatchExecutor } from "../dispatch.ts";
import { TeamRunCoordinator } from "../cockpit.ts";
import {
  FileTranscriptSink,
  LEADER_ACTOR,
  MAX_TRANSCRIPT_FILE_BYTES,
  MemoryTranscriptSink,
  actorTranscriptPath,
  listTranscriptActors,
  pruneOldTranscripts,
  readTranscript,
  sanitizeActorName,
  sanitizeRunId,
  transcriptRunDir,
} from "../transcript.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, toolExecutionEndLine, toolExecutionStartLine, waitForChild } from "./helpers.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-transcript-"));
}

test("sanitizeActorName keeps filesystem-safe names and strips leading separators", () => {
  assert.equal(sanitizeActorName("frontend"), "frontend");
  assert.equal(sanitizeActorName("Front End"), "Front_End");
  assert.equal(sanitizeActorName("_leader"), "leader", "member cannot collide with the leader artifact");
  assert.equal(sanitizeActorName("../etc/passwd"), "etc_passwd");
  assert.equal(sanitizeActorName("..."), "member");
  assert.equal(sanitizeActorName(""), "member");
});

test("sanitizeRunId produces a safe directory name", () => {
  assert.equal(sanitizeRunId("run-123"), "run-123");
  assert.equal(sanitizeRunId("../../x"), "x");
  assert.equal(sanitizeRunId(""), "run");
});

test("FileTranscriptSink appends bounded JSONL entries that readTranscript parses back", () => {
  const root = tmpRoot();
  try {
    const sink = new FileTranscriptSink(root, "run-1", () => "2026-09-06T12:00:00.000Z");
    sink.append("frontend", "task", "写登录页");
    sink.append("frontend", "assistant", "第一段回复\n第二行");
    sink.append(LEADER_ACTOR, "system", "run completed · 5s");

    const entries = readTranscript(root, "run-1", "frontend");
    assert.deepEqual(entries.map((e) => e.kind), ["task", "assistant"]);
    assert.equal(entries[0].text, "写登录页");
    assert.equal(entries[0].ts, "2026-09-06T12:00:00.000Z");
    assert.equal(entries[1].text, "第一段回复\n第二行");

    const leader = readTranscript(root, "run-1", LEADER_ACTOR);
    assert.equal(leader.length, 1);
    assert.equal(leader[0].kind, "system");
    assert.ok(fs.existsSync(path.join(transcriptRunDir(root, "run-1"), "_leader.jsonl")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readTranscript drops malformed lines and missing files read as empty", () => {
  const root = tmpRoot();
  try {
    const file = actorTranscriptPath(root, "run-1", "frontend");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      ["not json", JSON.stringify({ kind: "bogus", text: "x" }), JSON.stringify({ kind: "tool", text: "▶ read" }), ""].join("\n"),
      "utf-8",
    );
    const entries = readTranscript(root, "run-1", "frontend");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "tool");
    assert.equal(readTranscript(root, "missing-run", "nobody").length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("FileTranscriptSink stops appending after the file cap and records the truncation notice once", () => {
  const root = tmpRoot();
  try {
    const sink = new FileTranscriptSink(root, "run-1", () => "2026-09-06T12:00:00.000Z");
    sink.append("frontend", "system", "prefill");
    const file = actorTranscriptPath(root, "run-1", "frontend");
    fs.truncateSync(file, MAX_TRANSCRIPT_FILE_BYTES); // simulate a full file without writing 2MB
    sink.append("frontend", "assistant", "one");
    sink.append("frontend", "assistant", "two");
    const entries = readTranscript(root, "run-1", "frontend");
    assert.equal(entries.length, 1, "no entries appended past the cap");
    const raw = fs.readFileSync(file, "utf-8");
    assert.match(raw, /记录已达上限/, "exactly one truncation notice");
    assert.equal(raw.match(/记录已达上限/g)?.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listTranscriptActors puts the leader first then sorts members", () => {
  const root = tmpRoot();
  try {
    const sink = new FileTranscriptSink(root, "run-1");
    sink.append("zeta", "system", "s");
    sink.append("alpha", "system", "s");
    sink.append(LEADER_ACTOR, "system", "s");
    fs.writeFileSync(path.join(transcriptRunDir(root, "run-1"), "ignored.txt"), "x", "utf-8");
    assert.deepEqual(listTranscriptActors(root, "run-1"), [LEADER_ACTOR, "alpha", "zeta"]);
    assert.deepEqual(listTranscriptActors(root, "missing"), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneOldTranscripts removes only run directories older than the retention window", () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(transcriptRunDir(root, "run-old"), { recursive: true });
    fs.mkdirSync(transcriptRunDir(root, "run-new"), { recursive: true });
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(transcriptRunDir(root, "run-old"), old, old);
    const removed = pruneOldTranscripts(root, Date.now(), 7 * 24 * 60 * 60 * 1000);
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(transcriptRunDir(root, "run-old")), false);
    assert.equal(fs.existsSync(transcriptRunDir(root, "run-new")), true);
    assert.equal(pruneOldTranscripts(path.join(root, "missing"), Date.now(), 1000), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: dispatch executor records member activity
// ---------------------------------------------------------------------------

test("dispatch executor records member transcripts: task, tools, assistant, finish", async () => {
  const spawn = makeFakeSpawn();
  const transcript = new MemoryTranscriptSink(() => "2026-09-06T12:00:00.000Z");
  const executor = createDispatchExecutor({
    team: fixtureTeam(),
    cwd: "/repo",
    worktreeRoot: "/tmp/worktrees",
    runId: "run-1",
    spawn: spawn.spawn,
    piCommand: "pi",
    killGraceMs: 20,
    transcript,
  });
  const promise = executor({ tasks: [{ agent: "frontend", task: "写登录页" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.autoRespond(
    [
      toolExecutionStartLine("read", { path: "/src/login.tsx" }),
      toolExecutionEndLine("read", { content: [{ type: "text", text: "file body" }] }),
      messageEndLine("assistant", {
        content: [{ type: "text", text: "登录页写完了" }],
        usage: { input: 10, output: 5, cost: { total: 0.01 }, totalTokens: 15 },
      }),
    ],
    0,
    5,
  );
  const result = await promise;
  assert.ok(result.ok);

  const entries = transcript.entries.get("frontend") ?? [];
  assert.deepEqual(entries.map((e) => e.kind), ["task", "tool", "tool", "assistant", "system"]);
  assert.equal(entries[0].text, "写登录页");
  assert.match(entries[1].text, /read.*login\.tsx/);
  assert.match(entries[2].text, /read.*file body/);
  assert.equal(entries[3].text, "登录页写完了");
  assert.match(entries[4].text, /done · .* · \$0\.0100 · 1 turns/);
});

test("dispatch executor records an error transcript for unknown members", async () => {
  const spawn = makeFakeSpawn();
  const transcript = new MemoryTranscriptSink(() => "2026-09-06T12:00:00.000Z");
  const executor = createDispatchExecutor({
    team: fixtureTeam(),
    cwd: "/repo",
    worktreeRoot: "/tmp/worktrees",
    runId: "run-1",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcript,
  });
  const result = await executor({ tasks: [{ agent: "ghost", task: "不可能执行" }] }, undefined, undefined);
  assert.ok(result.ok);
  const entries = transcript.entries.get("ghost") ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "error");
  assert.match(entries[0].text, /MEMBER_NOT_FOUND/);
});

// ---------------------------------------------------------------------------
// Integration: cockpit records leader activity into the run artifact dir
// ---------------------------------------------------------------------------

test("coordinator writes the leader transcript (task/assistant/tools/system) to the run dir", async () => {
  const root = tmpRoot();
  try {
    const spawn = makeFakeSpawn();
    const coordinator = new TeamRunCoordinator({
      cwd: () => "/repo",
      worktreeRoot: "/tmp/worktrees",
      spawn: spawn.spawn,
      piCommand: "pi",
      transcriptRoot: root,
    });
    const promise = coordinator.start({ team: fixtureTeam(), task: "修复登录 bug", ui: { setWidget: () => {}, notify: () => {}, dim: (t) => t } });
    const child = await waitForChild(spawn, 0);
    const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    child.autoRespond(
      [
        messageEndLine("assistant", {
          content: [{ type: "text", text: "让我先拆解任务" }],
          usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15 },
        }),
        toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }] }),
        toolExecutionEndLine("team_dispatch", {
          content: [{ type: "text", text: "report" }],
          details: { members: [{ name: "frontend", ok: true, status: "done" }] },
        }),
        messageEndLine("assistant", { content: [{ type: "text", text: "FINAL REPORT" }] }),
      ],
      0,
      5,
    );
    const result = await promise;
    assert.ok(result.ok);

    const entries = readTranscript(root, runId, LEADER_ACTOR);
    const kinds = entries.map((e) => e.kind);
    assert.equal(kinds[0], "task");
    assert.equal(entries[0].text, "修复登录 bug");
    assert.ok(kinds.includes("assistant"));
    assert.ok(entries.some((e) => e.kind === "assistant" && e.text === "让我先拆解任务"));
    assert.ok(entries.some((e) => e.kind === "assistant" && e.text === "FINAL REPORT"));
    assert.ok(entries.some((e) => e.kind === "tool" && e.text.includes("team_dispatch") && e.text.includes("frontend")));
    assert.ok(entries.some((e) => e.kind === "system" && /run completed/.test(e.text)));
    assert.deepEqual(listTranscriptActors(root, runId)[0], LEADER_ACTOR);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
