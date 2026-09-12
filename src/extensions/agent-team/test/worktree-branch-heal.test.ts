/**
 * worktree.ts branch-heal semantics — REAL git against temp repositories.
 *
 * Incident (real machine run-1789133982726): a member worktree ended up on a
 * branch the member had created itself; the next same-run dispatch hit the
 * branch-mismatch guard, which flatly failed AND advised
 * `git worktree remove --force` — throwing away the member's work. Fix:
 * createWorktree heals the clean, free-branch case with a plain
 * `git switch <branch>` (never destructive), and every remaining mismatch
 * explains current/expected branch + actionable `git switch` guidance
 * (commit/stash for a dirty tree); `remove --force` must not appear.
 *
 * Boundary: real `git worktree`/`git switch` against temp repos (the drift
 * only exists on the git boundary), plus one dispatch-level integration with
 * a fake member spawn (same pattern as worktree-reuse.test.ts).
 */

import { execFile } from "node:child_process";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createDispatchExecutor } from "../dispatch.ts";
import { createWorktree, defaultGitRunner } from "../worktree.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, type FakeChild, type FakeSpawnHandle } from "./helpers.ts";

const exec = promisify(execFile);

async function initRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-heal-"));
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo });
  return repo;
}

/** Sibling of the repo dir (never inside it — worktrees inside are noisier). */
function siblingPath(repo: string, name: string): string {
  return path.join(repo, "..", `${path.basename(repo)}-${name}`);
}

/** Stages + commits `file` inside a worktree (heal requires a clean tree). */
async function commitFile(worktreePath: string, file: string, content: string): Promise<void> {
  fs.writeFileSync(path.join(worktreePath, file), content);
  await exec("git", ["-C", worktreePath, "add", file]);
  await exec("git", [
    "-C",
    worktreePath,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    `add ${file}`,
  ]);
}

/** The branch name the worktree is currently on (abbreviated). */
async function currentBranch(worktreePath: string): Promise<string> {
  const r = await exec("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  return r.stdout.trim();
}

/**
 * Real `git worktree add` takes seconds on Windows (AV/scanner) — helpers'
 * waitForChild budget (1s) is too tight for the dispatch-level case, so wait
 * generously here (same as worktree-reuse.test.ts).
 */
async function waitForSpawnedChild(handle: FakeSpawnHandle, index: number): Promise<FakeChild> {
  for (let i = 0; i < 600; i++) {
    if (handle.children[index]) return handle.children[index];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no child spawned at index ${index}`);
}

// ---------------------------------------------------------------------------
// createWorktree branch heal (real git)
// ---------------------------------------------------------------------------

test("createWorktree heals a clean worktree parked on a self-created branch", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const worktreePath = siblingPath(repo, "heal");
  const branch = "team/run-1/backend";

  const first = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(first.ok, first.ok ? "" : first.message);
  await commitFile(worktreePath, "marker.txt", "keep me");
  await exec("git", ["-C", worktreePath, "switch", "-c", "feat/member"]);

  const second = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(second.ok, second.ok ? "" : second.message);
  assert.equal(second.value.path, worktreePath);
  assert.equal(second.value.branch, branch);
  assert.equal(second.value.switchedBackFrom, "feat/member");
  assert.equal(await currentBranch(worktreePath), branch);
  // The member's work survives the heal and its branch is not deleted.
  assert.equal(fs.readFileSync(path.join(worktreePath, "marker.txt"), "utf-8"), "keep me");
  const branches = await exec("git", ["-C", repo, "branch", "--list", "feat/member"]);
  assert.equal(branches.stdout.trim(), "feat/member");
});

test("createWorktree refuses a dirty drifted worktree with non-destructive guidance", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const worktreePath = siblingPath(repo, "dirty");
  const branch = "team/run-1/backend";

  const first = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(first.ok, first.ok ? "" : first.message);
  await exec("git", ["-C", worktreePath, "switch", "-c", "feat/member"]);
  fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "uncommitted");

  const second = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(!second.ok);
  assert.equal(second.code, "WORKTREE_UNAVAILABLE");
  assert.ok(second.message.includes(branch), "message names the expected branch");
  assert.ok(second.message.includes("feat/member"), "message names the current branch");
  assert.match(second.message, /git -C/);
  assert.match(second.message, /switch/);
  assert.match(second.message, /commit|stash/i);
  assert.doesNotMatch(second.message, /remove --force/);
});

test("createWorktree reports a branch held by another worktree without destructive advice", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const branch = "team/run-1/backend";
  const holder = siblingPath(repo, "holder");
  const first = await createWorktree({ git, repoCwd: repo, worktreePath: holder, branch });
  assert.ok(first.ok, first.ok ? "" : first.message);

  const drifted = siblingPath(repo, "held");
  const second = await createWorktree({ git, repoCwd: repo, worktreePath: drifted, branch: "team/run-1/other" });
  assert.ok(second.ok, second.ok ? "" : second.message);
  await exec("git", ["-C", drifted, "switch", "-c", "feat/member"]);

  const third = await createWorktree({ git, repoCwd: repo, worktreePath: drifted, branch });
  assert.ok(!third.ok);
  assert.equal(third.code, "WORKTREE_UNAVAILABLE");
  assert.ok(third.message.includes(branch), "message names the expected branch");
  assert.ok(third.message.includes("feat/member"), "message names the current branch");
  assert.match(third.message, /git -C/);
  assert.match(third.message, /worktree list/);
  assert.doesNotMatch(third.message, /remove --force/);
});

test("createWorktree reports a missing expected branch without destructive advice", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const worktreePath = siblingPath(repo, "missing");
  const branch = "team/run-1/backend";

  const first = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(first.ok, first.ok ? "" : first.message);
  await exec("git", ["-C", worktreePath, "switch", "-c", "feat/member"]);
  await exec("git", ["-C", repo, "branch", "-D", branch]);

  const second = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(!second.ok);
  assert.equal(second.code, "WORKTREE_UNAVAILABLE");
  assert.ok(second.message.includes(branch), "message names the expected branch");
  assert.ok(second.message.includes("feat/member"), "message names the current branch");
  assert.match(second.message, /git -C/);
  assert.doesNotMatch(second.message, /remove --force/);
});

// ---------------------------------------------------------------------------
// dispatch-level integration (real git + fake member spawn)
// ---------------------------------------------------------------------------

test("dispatch heals a drifted member worktree, keeps its work and reports the switch-back", async () => {
  const repo = await initRepo();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-heal-root-"));
  const fakeSpawn = makeFakeSpawn();
  const member = { name: "backend", model: "anthropic/claude-sonnet-4-5", worktree: true, prompt: "你是后端工程师。" };
  const executor = createDispatchExecutor({
    team: fixtureTeam({ members: [member] }),
    cwd: repo,
    worktreeRoot,
    runId: "run-1",
    spawn: fakeSpawn.spawn,
    piCommand: "pi",
    killGraceMs: 20,
  });
  const expectedPath = path.join(worktreeRoot, "run-1", "backend");
  const branch = "team/run-1/backend";
  const assistantLine = (text: string) =>
    messageEndLine("assistant", {
      content: [{ type: "text", text }],
      usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15, turns: 1 },
      stopReason: "stop",
    });

  const first = executor({ tasks: [{ agent: "backend", task: "第一次" }] }, undefined, undefined);
  const firstChild = await waitForSpawnedChild(fakeSpawn, 0);
  firstChild.autoRespond([assistantLine("第一次完成")]);
  const firstOutcome = await first;
  assert.ok(firstOutcome.ok, firstOutcome.ok ? "" : `${firstOutcome.code} ${firstOutcome.message}`);
  assert.equal(firstOutcome.value.results[0].ok, true);
  assert.equal(fakeSpawn.records[0].cwd, expectedPath);

  // Marker proves the second dispatch reused the existing worktree; committed
  // so the tree is clean (the heal path only switches clean trees).
  await commitFile(expectedPath, "marker.txt", "kept");
  await exec("git", ["-C", expectedPath, "switch", "-c", "feat/member"]);

  const second = executor({ tasks: [{ agent: "backend", task: "第二次" }] }, undefined, undefined);
  const secondChild = await waitForSpawnedChild(fakeSpawn, 1);
  secondChild.autoRespond([assistantLine("第二次完成")]);
  const secondOutcome = await second;
  assert.ok(secondOutcome.ok, secondOutcome.ok ? "" : `${secondOutcome.code} ${secondOutcome.message}`);
  assert.equal(secondOutcome.value.results[0].ok, true);
  assert.equal(secondOutcome.value.results[0].worktree?.path, expectedPath);
  assert.equal(secondOutcome.value.results[0].worktree?.branch, branch);
  assert.equal(secondOutcome.value.results[0].worktree?.switchedBackFrom, "feat/member");
  assert.equal(fakeSpawn.records[1].cwd, expectedPath);
  assert.equal(fs.readFileSync(path.join(expectedPath, "marker.txt"), "utf-8"), "kept");
  assert.match(secondOutcome.value.text, /已从 `feat\/member` 切回/);
  assert.equal(await currentBranch(expectedPath), branch);
});
