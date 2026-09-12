/**
 * Run status store tests: per-run status.json write/read under the run dir
 * (same retention lifecycle as transcripts), corrupt-file isolation, and
 * stale-running reconciliation. Pure filesystem logic — no host components.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  defaultIsProcessAlive,
  reconcileStaleRuns,
  readRunStatuses,
  runStatusPath,
  writeRunStatus,
  type RunStatusFile,
} from "../runstore.ts";

/** Non-owner reconcile caller: a different pi session (pid) than the owner. */
const OTHER_SESSION_PID = 1111;

/** Dead owner probe (the owning session is gone). */
const ownerGone = () => false;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-runstore-"));
}

function sample(overrides: Partial<RunStatusFile> = {}): RunStatusFile {
  return {
    version: 1,
    runId: "run-1",
    team: "dev-team",
    task: "修复 bug",
    startedAt: "2026-09-09T03:00:00Z",
    status: "running",
    updatedAt: "2026-09-09T03:00:00Z",
    ...overrides,
  };
}

test("writeRunStatus writes status.json into the run dir and readRunStatuses reads it back", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample());
  const file = runStatusPath(root, "run-1");
  assert.equal(fs.existsSync(file), true);
  assert.equal(path.dirname(file), path.join(root, "run-1"));
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as RunStatusFile;
  assert.equal(raw.status, "running");
  assert.equal(raw.team, "dev-team");

  const read = readRunStatuses(root);
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].runId, "run-1");
  assert.equal(read.entries[0].status, "running");
  assert.equal(read.corrupt.length, 0);
});

test("terminal update overwrites the running snapshot (single file per run)", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample());
  writeRunStatus(root, sample({ status: "completed", updatedAt: "2026-09-09T03:05:00Z" }));
  const read = readRunStatuses(root);
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].status, "completed");
  assert.equal(read.entries[0].updatedAt, "2026-09-09T03:05:00Z");
});

test("leaderPid is persisted and read back", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample({ leaderPid: 4321 }));
  const read = readRunStatuses(root);
  assert.equal(read.entries[0].leaderPid, 4321);
});

test("ownerPid is persisted and read back (legacy files read as undefined)", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample({ runId: "run-owned", ownerPid: 4242 }));
  writeRunStatus(root, sample({ runId: "run-legacy" }));
  const read = readRunStatuses(root);
  const byId = new Map(read.entries.map((e) => [e.runId, e]));
  assert.equal(byId.get("run-owned")?.ownerPid, 4242);
  assert.equal(byId.get("run-legacy")?.ownerPid, undefined);
});

test("a non-numeric ownerPid is isolated as a corrupt file (lenient parse)", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "run-bad-owner"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "run-bad-owner", "status.json"),
    JSON.stringify({ ...sample(), ownerPid: "4242" }),
    "utf-8",
  );
  const read = readRunStatuses(root);
  assert.equal(read.entries.length, 0);
  assert.equal(read.corrupt.length, 1);
  assert.equal(read.corrupt[0].file, path.join(root, "run-bad-owner", "status.json"));
});

test("resume lineage fields (parentRunId/leaderSessionFile/worktree) round-trip and survive reconcile", () => {
  const root = tmpRoot();
  writeRunStatus(
    root,
    sample({
      runId: "run-resume",
      status: "completed",
      parentRunId: "run-parent",
      leaderSessionFile: "/runs/run-parent/session/20260911_a.jsonl",
      worktree: { path: "/tmp/worktrees/run-parent/team", branch: "team-run-run-parent" },
    }),
  );
  const read = readRunStatuses(root);
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].parentRunId, "run-parent");
  assert.equal(read.entries[0].leaderSessionFile, "/runs/run-parent/session/20260911_a.jsonl");
  assert.deepEqual(read.entries[0].worktree, { path: "/tmp/worktrees/run-parent/team", branch: "team-run-run-parent" });

  // Reconcile rewrites stale running entries: the lineage fields must survive
  // the rewrite (otherwise a crashed parent loses its resume pointers).
  writeRunStatus(root, sample({ runId: "run-stale", ownerPid: 4242, parentRunId: "run-parent", leaderSessionFile: "/x.jsonl" }));
  const reconciled = reconcileStaleRuns({
    root,
    inMemoryRunIds: new Set(),
    currentPid: OTHER_SESSION_PID,
    isProcessAlive: ownerGone,
    now: () => "2026-09-11T06:00:00Z",
  });
  assert.equal(reconciled.length, 1);
  const stale = readRunStatuses(root).entries.find((e) => e.runId === "run-stale");
  assert.equal(stale?.status, "failed");
  assert.equal(stale?.parentRunId, "run-parent");
  assert.equal(stale?.leaderSessionFile, "/x.jsonl");
});

test("a malformed worktree field is isolated as a corrupt file (lenient parse)", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "run-bad-wt"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "run-bad-wt", "status.json"),
    JSON.stringify({ ...sample(), worktree: { path: "/x" } }),
    "utf-8",
  );
  const read = readRunStatuses(root);
  assert.equal(read.entries.length, 0);
  assert.equal(read.corrupt.length, 1);
});

test("defaultIsProcessAlive reports the current process as alive", () => {
  assert.equal(defaultIsProcessAlive(process.pid), true);
});

test("corrupt status files are isolated, not thrown", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample());
  fs.mkdirSync(path.join(root, "run-2"), { recursive: true });
  fs.writeFileSync(path.join(root, "run-2", "status.json"), "{not json", "utf-8");
  fs.mkdirSync(path.join(root, "run-3"), { recursive: true });
  fs.writeFileSync(path.join(root, "run-3", "status.json"), JSON.stringify({ version: "x" }), "utf-8");

  const read = readRunStatuses(root);
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].runId, "run-1");
  assert.equal(read.corrupt.length, 2);
  assert.ok(read.corrupt.every((c) => c.file.endsWith("status.json")));
  assert.ok(read.corrupt.every((c) => c.message.length > 0));
});

test("readRunStatuses on a missing root returns empty without throwing", () => {
  const read = readRunStatuses(path.join(tmpRoot(), "nope"));
  assert.deepEqual(read, { entries: [], corrupt: [] });
});

test("writeRunStatus swallows filesystem failures (best-effort store)", () => {
  // A path component that is a FILE makes mkdir/write fail.
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "blocker"), "x");
  assert.doesNotThrow(() => writeRunStatus(root, sample({ runId: "blocker/nested" })));
});

test("reconcileStaleRuns rewrites stale running entries to failed and leaves the rest alone", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample({ runId: "run-1", leaderPid: 111 }));
  writeRunStatus(root, sample({ runId: "run-2", leaderPid: 222 }));
  writeRunStatus(root, sample({ runId: "run-3", status: "completed" }));

  const reconciled = reconcileStaleRuns({
    root,
    inMemoryRunIds: new Set(["run-2"]),
    currentPid: OTHER_SESSION_PID,
    isProcessAlive: ownerGone,
    now: () => "2026-09-09T09:00:00Z",
  });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].runId, "run-1");
  assert.equal(reconciled[0].leaderPid, 111);
  assert.equal(reconciled[0].team, "dev-team");
  assert.equal(reconciled[0].task, "修复 bug");
  assert.equal(reconciled[0].startedAt, "2026-09-09T03:00:00Z");

  const read = readRunStatuses(root);
  const byId = new Map(read.entries.map((e) => [e.runId, e]));
  assert.equal(byId.get("run-1")?.status, "failed");
  assert.equal(byId.get("run-1")?.error, "主会话在 run 进行中退出，run 未落终态；leader 子进程 pid=111 可能仍残留（未自动终止）");
  assert.equal(byId.get("run-2")?.status, "running", "in-memory run untouched");
  assert.equal(byId.get("run-3")?.status, "completed", "terminal run untouched");
});

test("reconcileStaleRuns reports a stale run without pid in its diagnostic", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample({ runId: "run-1" }));
  const reconciled = reconcileStaleRuns({
    root,
    inMemoryRunIds: new Set(),
    currentPid: OTHER_SESSION_PID,
    isProcessAlive: ownerGone,
    now: () => "t",
  });
  assert.equal(reconciled.length, 1);
  const read = readRunStatuses(root);
  assert.match(read.entries[0].error ?? "", /leader 子进程/);
  assert.ok(!(read.entries[0].error ?? "").includes("pid="), "no fabricated pid");
});

test("reconcileStaleRuns tolerates a missing/corrupt store", () => {
  const root = path.join(tmpRoot(), "nope");
  assert.deepEqual(
    reconcileStaleRuns({ root, inMemoryRunIds: new Set(), currentPid: OTHER_SESSION_PID, isProcessAlive: ownerGone, now: () => "t" }),
    [],
  );
  const corruptRoot = tmpRoot();
  fs.mkdirSync(path.join(corruptRoot, "run-9"), { recursive: true });
  fs.writeFileSync(path.join(corruptRoot, "run-9", "status.json"), "!!!");
  assert.deepEqual(
    reconcileStaleRuns({ root: corruptRoot, inMemoryRunIds: new Set(), currentPid: OTHER_SESSION_PID, isProcessAlive: ownerGone, now: () => "t" }),
    [],
  );
});

// -- Cross-session reconcile: the owner session's live run must survive ----

test("reconcileStaleRuns leaves a running run whose owner session is still alive", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample({ runId: "run-live", ownerPid: 4242, leaderPid: 77 }));
  const probed: number[] = [];
  const reconciled = reconcileStaleRuns({
    root,
    inMemoryRunIds: new Set(),
    currentPid: OTHER_SESSION_PID,
    isProcessAlive: (pid) => {
      probed.push(pid);
      return true;
    },
    now: () => "2026-09-11T06:00:00Z",
  });
  assert.deepEqual(reconciled, [], "another session's live run is not reconciled away");
  assert.deepEqual(probed, [4242], "exactly the owner pid was probed");
  const read = readRunStatuses(root);
  assert.equal(read.entries[0].status, "running", "file stays running");
  assert.equal(read.entries[0].error, undefined, "no orphan diagnostic written");
  assert.equal(read.entries[0].updatedAt, "2026-09-09T03:00:00Z", "file untouched");
});

test("reconcileStaleRuns skips its own owner pid without probing (defense in depth)", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample({ runId: "run-self", ownerPid: OTHER_SESSION_PID }));
  let probed = false;
  const reconciled = reconcileStaleRuns({
    root,
    inMemoryRunIds: new Set(),
    currentPid: OTHER_SESSION_PID,
    isProcessAlive: () => {
      probed = true;
      return false;
    },
    now: () => "t",
  });
  assert.deepEqual(reconciled, []);
  assert.equal(probed, false, "own pid wins over a (stale) probe result");
  assert.equal(readRunStatuses(root).entries[0].status, "running");
});

test("reconcileStaleRuns flips a run whose owner session is gone (orphan diagnostic)", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample({ runId: "run-orphan", ownerPid: 4242, leaderPid: 77 }));
  const reconciled = reconcileStaleRuns({
    root,
    inMemoryRunIds: new Set(),
    currentPid: OTHER_SESSION_PID,
    isProcessAlive: ownerGone,
    now: () => "2026-09-11T06:00:00Z",
  });
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].runId, "run-orphan");
  assert.equal(reconciled[0].leaderPid, 77);
  const read = readRunStatuses(root);
  assert.equal(read.entries[0].status, "failed");
  assert.equal(read.entries[0].updatedAt, "2026-09-11T06:00:00Z");
  assert.match(read.entries[0].error ?? "", /主会话在 run 进行中退出/);
  assert.match(read.entries[0].error ?? "", /pid=77/);
});

test("reconcileStaleRuns still flips legacy running files without ownerPid, without probing", () => {
  const root = tmpRoot();
  writeRunStatus(root, sample({ runId: "run-legacy" }));
  let probed = false;
  const reconciled = reconcileStaleRuns({
    root,
    inMemoryRunIds: new Set(),
    currentPid: OTHER_SESSION_PID,
    isProcessAlive: () => {
      probed = true;
      return true;
    },
    now: () => "t",
  });
  assert.equal(reconciled.length, 1, "no liveness info: stale run still reconciled");
  assert.equal(probed, false, "nothing to probe without an owner pid");
  assert.equal(readRunStatuses(root).entries[0].status, "failed");
});
