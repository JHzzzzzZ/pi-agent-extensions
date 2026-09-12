/**
 * Resume pure-logic tests: parent status lookup, leader session mirror
 * discovery, session-header cwd, effective-team model overrides, the member
 * model env codec, the resume prompt templates, eligibility rules and the
 * shared-worktree spec. Filesystem reads only — no host components.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { writeRunStatus, type RunStatusFile } from "../runstore.ts";
import {
  buildResumePrompt,
  findRunStatus,
  parentWorktreeSpec,
  parseMemberModelEnv,
  readSessionHeaderCwd,
  resolveEffectiveTeam,
  resolveLeaderSessionFile,
  resolveResumeSessionFile,
  resumeEligibility,
} from "../resume.ts";
import { TeamErrorCodes } from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";
import { teamWorktreeBranch } from "../worktree.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-resume-"));
}

function parentStatus(runId: string, overrides: Partial<RunStatusFile> = {}) {
  return {
    version: 1 as const,
    runId,
    team: "dev-team",
    task: "修复 bug",
    startedAt: "2026-09-11T05:00:00Z",
    status: "failed" as const,
    updatedAt: "2026-09-11T05:30:00Z",
    ...overrides,
  };
}

/** Writes a session mirror file into `<root>/<runId>/session/` and returns it. */
function writeSessionMirror(root: string, runId: string, name: string): string {
  const sessionDir = path.join(root, runId, "session");
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, name);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "t", cwd: "/repo" })}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// findRunStatus
// ---------------------------------------------------------------------------

test("findRunStatus locates the parent entry and returns undefined for unknown runs", () => {
  const root = tmpRoot();
  writeRunStatus(root, parentStatus("run-1"));
  writeRunStatus(root, parentStatus("run-2", { status: "completed" }));

  assert.equal(findRunStatus(root, "run-1")?.runId, "run-1");
  assert.equal(findRunStatus(root, "run-2")?.status, "completed");
  assert.equal(findRunStatus(root, "run-missing"), undefined);
  assert.equal(findRunStatus(path.join(root, "nope"), "run-1"), undefined);
});

// ---------------------------------------------------------------------------
// resolveLeaderSessionFile
// ---------------------------------------------------------------------------

test("resolveLeaderSessionFile returns null without a session mirror", () => {
  const root = tmpRoot();
  assert.equal(resolveLeaderSessionFile(path.join(root, "run-1", "session")), null);
  fs.mkdirSync(path.join(root, "run-empty", "session"), { recursive: true });
  assert.equal(resolveLeaderSessionFile(path.join(root, "run-empty", "session")), null);
});

test("resolveLeaderSessionFile picks the newest jsonl file (absolute path)", () => {
  const sessionDir = path.join(tmpRoot(), "session");
  fs.mkdirSync(sessionDir, { recursive: true });
  const older = path.join(sessionDir, "20260911_aaa.jsonl");
  const newer = path.join(sessionDir, "20260911_bbb.jsonl");
  fs.writeFileSync(older, "{}\n");
  fs.writeFileSync(newer, "{}\n");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(older, past, past);

  assert.equal(resolveLeaderSessionFile(sessionDir), path.resolve(newer));
});

// ---------------------------------------------------------------------------
// resolveResumeSessionFile
// ---------------------------------------------------------------------------

test("resolveResumeSessionFile prefers the recorded mirror and falls back to the session dir", () => {
  const root = tmpRoot();
  const runId = "run-1";
  const recorded = writeSessionMirror(root, runId, "recorded.jsonl");
  assert.equal(
    resolveResumeSessionFile({ runsRoot: root, parentStatus: parentStatus(runId, { leaderSessionFile: recorded }) }),
    path.resolve(recorded),
  );

  // Recorded path pruned → scan the conventional session dir instead.
  const scanned = writeSessionMirror(root, runId, "scanned.jsonl");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(recorded, past, past);
  assert.equal(
    resolveResumeSessionFile({
      runsRoot: root,
      parentStatus: parentStatus(runId, { leaderSessionFile: path.join(root, runId, "session", "gone.jsonl") }),
    }),
    path.resolve(scanned),
  );
  assert.equal(resolveResumeSessionFile({ runsRoot: root, parentStatus: parentStatus("run-none") }), null);
});

// ---------------------------------------------------------------------------
// readSessionHeaderCwd
// ---------------------------------------------------------------------------

test("readSessionHeaderCwd reads the header cwd and degrades on bad input", () => {
  const dir = tmpRoot();
  const good = path.join(dir, "good.jsonl");
  fs.writeFileSync(
    good,
    `${JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "t", cwd: "/repo/team-wt" })}\n{"type":"message"}\n`,
  );
  assert.equal(readSessionHeaderCwd(good), "/repo/team-wt");

  const bad = path.join(dir, "bad.jsonl");
  fs.writeFileSync(bad, "{not json\n");
  assert.equal(readSessionHeaderCwd(bad), undefined);

  const noCwd = path.join(dir, "no-cwd.jsonl");
  fs.writeFileSync(noCwd, `${JSON.stringify({ type: "session", version: 3 })}\n`);
  assert.equal(readSessionHeaderCwd(noCwd), undefined);

  assert.equal(readSessionHeaderCwd(path.join(dir, "missing.jsonl")), undefined);
});

// ---------------------------------------------------------------------------
// resolveEffectiveTeam
// ---------------------------------------------------------------------------

test("resolveEffectiveTeam applies leader/member overrides without touching the source team", () => {
  const team = fixtureTeam();
  const { team: effective, unknownMembers } = resolveEffectiveTeam(team, {
    leaderModel: "opencode-go/deepseek-v4:max",
    memberModels: { frontend: "opencode-go/deepseek-v4-flash", backend: "anthropic/claude-sonnet-4-5:high" },
  });

  assert.equal(effective.leader.model, "opencode-go/deepseek-v4:max");
  assert.equal(effective.members.find((m) => m.name === "frontend")?.model, "opencode-go/deepseek-v4-flash");
  assert.equal(effective.members.find((m) => m.name === "backend")?.model, "anthropic/claude-sonnet-4-5:high");
  assert.deepEqual(unknownMembers, []);
  // Source untouched (overrides apply to one run only).
  assert.equal(team.leader.model, "anthropic/claude-opus-4-5");
  assert.equal(team.members[0].model, "chatanywhere/gpt-5.6");
});

test("resolveEffectiveTeam ignores overrides for unknown members and reports them", () => {
  const team = fixtureTeam();
  const { team: effective, unknownMembers } = resolveEffectiveTeam(team, {
    memberModels: { ghost: "opencode-go/deepseek-v4" },
  });

  assert.deepEqual(unknownMembers, ["ghost"]);
  assert.equal(effective.members.length, team.members.length);
  assert.ok(!effective.members.some((m) => m.name === "ghost"));
});

test("resolveEffectiveTeam without overrides returns the team unchanged", () => {
  const team = fixtureTeam();
  const { team: effective, unknownMembers } = resolveEffectiveTeam(team);
  assert.deepEqual(effective, team);
  assert.deepEqual(unknownMembers, []);
});

// ---------------------------------------------------------------------------
// parseMemberModelEnv
// ---------------------------------------------------------------------------

test("parseMemberModelEnv decodes the JSON env and isolates bad shapes", () => {
  assert.deepEqual(parseMemberModelEnv(undefined), {});
  assert.deepEqual(parseMemberModelEnv(""), {});
  assert.deepEqual(parseMemberModelEnv("{not json"), {});
  assert.deepEqual(parseMemberModelEnv("[1,2]"), {});
  assert.deepEqual(parseMemberModelEnv('{"frontend":"opencode-go/deepseek-v4-flash"}'), {
    frontend: "opencode-go/deepseek-v4-flash",
  });
  assert.deepEqual(parseMemberModelEnv('{"frontend":"","ghost":3,"backend":"  anthropic/claude-sonnet-4-5  "}'), {
    backend: "anthropic/claude-sonnet-4-5",
  });
});

// ---------------------------------------------------------------------------
// buildResumePrompt
// ---------------------------------------------------------------------------

test("buildResumePrompt renders the two resume templates", () => {
  assert.equal(buildResumePrompt(), "继续上次未完成的任务；完成后按团队约定的最终报告格式输出报告。");
  assert.equal(
    buildResumePrompt("  换用有额度的模型继续  "),
    "继续上次未完成的任务。补充指示：\n换用有额度的模型继续\n完成后按团队约定的最终报告格式输出报告。",
  );
});

// ---------------------------------------------------------------------------
// resumeEligibility
// ---------------------------------------------------------------------------

test("resumeEligibility only allows failed/aborted terminal states", () => {
  assert.deepEqual(resumeEligibility("failed"), { ok: true });
  assert.deepEqual(resumeEligibility("aborted"), { ok: true });

  const running = resumeEligibility("running");
  assert.equal(running.ok, false);
  assert.equal(!running.ok && running.code, TeamErrorCodes.RUN_NOT_TERMINAL);

  const completed = resumeEligibility("completed");
  assert.equal(completed.ok, false);
  assert.equal(!completed.ok && completed.code, TeamErrorCodes.RUN_ALREADY_FINISHED);
});

// ---------------------------------------------------------------------------
// parentWorktreeSpec
// ---------------------------------------------------------------------------

test("parentWorktreeSpec prefers the recorded worktree, falling back to the convention", () => {
  const recorded = {
    path: "/tmp/worktrees/run-1/team",
    branch: "team-run-run-1",
  };
  assert.deepEqual(parentWorktreeSpec({ status: parentStatus("run-1", { worktree: recorded }), worktreeRoot: "/tmp/worktrees", runId: "run-1" }), recorded);

  // Legacy runs (no recorded worktree) reconstruct the conventional path/branch.
  const legacyStatus = parentStatus("run-1") as { worktree?: { path: string; branch: string } };
  assert.deepEqual(
    parentWorktreeSpec({ status: legacyStatus, worktreeRoot: "/tmp/worktrees", runId: "run-1" }),
    { path: path.join("/tmp/worktrees", "run-1", "team"), branch: teamWorktreeBranch("run-1") },
  );
});
