/**
 * Worktree branch-namespace tests — REAL git against temp repositories.
 *
 * Incident (v1.15.4, real machine run-1789108491578): the team-level shared
 * worktree used branch `team/<runId>` while member worktrees used
 * `team/<runId>/<member>`. Git refs cannot be both a file and a directory:
 * once `refs/heads/team/<runId>` existed, `refs/heads/team/<runId>/<member>`
 * could not be created (`cannot lock ref`) — the first member dispatch of a
 * team with `worktree: true` (team) + `worktree: true` (member) failed with
 * WORKTREE_UNAVAILABLE. The leader renamed the team branch to the hyphenated
 * `team-run-<runId>` on the real machine to recover; historical successful
 * runs used that shape all along.
 *
 * Red evidence before the fix (team branch still `team/<runId>`):
 *   "member worktree failed: git worktree add failed: fatal: cannot lock ref
 *    'refs/heads/team/run-1/writer-1': 'refs/heads/team/run-1' exists;
 *    cannot create 'refs/heads/team/run-1/writer-1'"
 *
 * These tests pin the hyphenated team branch, the dispatch-level coexistence
 * of team + member worktrees for one run, and the actionable (non-destructive)
 * behaviour when an old-named team worktree already exists on disk.
 */

import { execFile } from "node:child_process";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createDispatchExecutor } from "../dispatch.ts";
import { createWorktree, defaultGitRunner, memberWorktreeBranch, teamWorktreeBranch } from "../worktree.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, type FakeChild, type FakeSpawnHandle } from "./helpers.ts";

const exec = promisify(execFile);

async function initRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-ns-"));
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo });
  return repo;
}

/** Sibling of the repo dir (never inside it — worktrees inside are noisier). */
function siblingPath(repo: string, name: string): string {
  return path.join(repo, "..", `${path.basename(repo)}-${name}`);
}

/**
 * Returns the first spawned member child, or undefined when the dispatch
 * settled without spawning one (the pre-fix defect fails at worktree creation,
 * before any child exists). `pending` is the executor promise.
 */
async function firstSpawnOrSettled(handle: FakeSpawnHandle, pending: Promise<unknown>): Promise<FakeChild | undefined> {
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 600 && !settled && !handle.children[0]; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return handle.children[0];
}

// ---------------------------------------------------------------------------
// Branch templates (pure)
// ---------------------------------------------------------------------------

test("team and member branch templates live in separate ref namespaces", () => {
  const runId = "run-1789109309942";
  const team = teamWorktreeBranch(runId);
  const member = memberWorktreeBranch(runId, "writer-1");
  assert.equal(team, `team-run-${runId}`);
  assert.equal(member, `team/${runId}/writer-1`);
  // A git ref cannot be both file and directory: neither branch may be a
  // path component of the other.
  assert.ok(!member.startsWith(`${team}/`), `"${member}" must not nest under "${team}"`);
  assert.ok(!team.startsWith(`${member}/`), `"${team}" must not nest under "${member}"`);
});

// ---------------------------------------------------------------------------
// Real git: coexistence and compatibility
// ---------------------------------------------------------------------------

test("team-level and member-level worktrees coexist for one run (real git)", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const runId = "run-1";
  const teamPath = siblingPath(repo, "coexist-team");
  const memberPath = siblingPath(repo, "coexist-member");
  const teamBranch = teamWorktreeBranch(runId);
  const memberBranch = memberWorktreeBranch(runId, "writer-1");

  const team = await createWorktree({ git, repoCwd: repo, worktreePath: teamPath, branch: teamBranch });
  assert.ok(team.ok, team.ok ? "" : `team worktree failed: ${team.message}`);
  const member = await createWorktree({ git, repoCwd: repo, worktreePath: memberPath, branch: memberBranch });
  assert.ok(member.ok, member.ok ? "" : `member worktree failed: ${member.message}`);

  const listed = await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo });
  for (const branch of [teamBranch, memberBranch]) {
    assert.ok(listed.stdout.includes(`branch refs/heads/${branch}`), `ref for ${branch} is registered`);
    await exec("git", ["-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`]);
  }
  // Independent working trees: a file in the member worktree never leaks into
  // the team one (and vice versa).
  fs.writeFileSync(path.join(memberPath, "member-only.txt"), "m");
  assert.equal(fs.existsSync(path.join(teamPath, "member-only.txt")), false);
});

test("legacy team worktree on the old branch survives with an actionable retry hint (real git)", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const runId = "run-1";
  const teamPath = siblingPath(repo, "legacy-team");
  const legacyBranch = `team/${runId}`; // pre-1.15.4 naming

  const legacy = await createWorktree({ git, repoCwd: repo, worktreePath: teamPath, branch: legacyBranch });
  assert.ok(legacy.ok, legacy.ok ? "" : legacy.message);

  const retry = await createWorktree({
    git,
    repoCwd: repo,
    worktreePath: teamPath,
    branch: teamWorktreeBranch(runId),
  });
  assert.ok(!retry.ok, "an old-named team worktree must not be silently reused");
  assert.equal(retry.code, "WORKTREE_UNAVAILABLE");
  assert.match(retry.message, /already registered on branch "team\/run-1"/);
  assert.match(retry.message, /git worktree remove --force/);
  // Nothing was deleted or silently re-pointed: legacy dir and branch survive.
  assert.equal(fs.existsSync(path.join(teamPath, ".git")), true);
  await exec("git", ["-C", repo, "rev-parse", "--verify", `refs/heads/${legacyBranch}`]);
});

// ---------------------------------------------------------------------------
// Dispatch-level integration (real git + fake member spawn)
// ---------------------------------------------------------------------------

test("first member dispatch succeeds after the team shared worktree exists (real git + fake spawn)", async () => {
  const repo = await initRepo();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-ns-root-"));
  const runId = "run-1";

  // cockpit path: the team-level shared worktree is created before the leader
  // starts dispatching.
  const teamCreated = await createWorktree({
    git: defaultGitRunner(),
    repoCwd: repo,
    worktreePath: path.join(worktreeRoot, runId, "team"),
    branch: teamWorktreeBranch(runId),
  });
  assert.ok(teamCreated.ok, teamCreated.ok ? "" : `team worktree failed: ${teamCreated.message}`);

  const fakeSpawn = makeFakeSpawn();
  const member = { name: "writer-1", model: "anthropic/claude-sonnet-4-5", worktree: true, prompt: "你是写手。" };
  const executor = createDispatchExecutor({
    team: fixtureTeam({ worktree: true, members: [member] }),
    cwd: repo,
    worktreeRoot,
    runId,
    spawn: fakeSpawn.spawn,
    piCommand: "pi",
    killGraceMs: 20,
  });

  const pending = executor({ tasks: [{ agent: "writer-1", task: "写点东西" }] }, undefined, undefined);
  const child = await firstSpawnOrSettled(fakeSpawn, pending);
  if (child) {
    child.autoRespond([
      messageEndLine("assistant", {
        content: [{ type: "text", text: "写完了" }],
        usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15, turns: 1 },
        stopReason: "stop",
      }),
    ]);
  }
  const outcome = await pending;
  assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.code} ${outcome.message}`);
  const result = outcome.value.results[0];
  assert.ok(result.ok, `member failed: ${result.error?.code ?? ""} ${result.error?.message ?? ""}`);

  const expectedPath = path.join(worktreeRoot, runId, "writer-1");
  assert.equal(fakeSpawn.records[0].cwd, expectedPath);
  assert.deepEqual(result.worktree, { path: expectedPath, branch: memberWorktreeBranch(runId, "writer-1") });
});
