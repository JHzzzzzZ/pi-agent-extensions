/**
 * Worktree isolation tests — REAL git against a temp repository.
 */

import { execFile } from "node:child_process";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createWorktree, defaultGitRunner, isGitRepo, removeWorktree } from "../worktree.ts";

const exec = promisify(execFile);

async function initRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-git-"));
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo });
  return repo;
}

test("isGitRepo detects repositories and non-repositories", async () => {
  const repo = await initRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-plain-"));
  const git = defaultGitRunner();
  assert.equal(await isGitRepo(git, repo), true);
  // GIT_CEILING_DIRECTORIES stops git's upward discovery: the user's home
  // (or any parent) must not make an arbitrary temp dir look like a repo.
  // The ceiling must name the PARENT — git won't chdir up through it.
  const ceilingGit = defaultGitRunner({ GIT_CEILING_DIRECTORIES: path.dirname(plain) });
  assert.equal(await isGitRepo(ceilingGit, plain), false);
});

test("createWorktree + removeWorktree round trip on a real repo", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const worktreePath = path.join(repo, "..", `${path.basename(repo)}-wt`);
  const branch = "team/run-42/backend";

  const created = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(created.ok, created.ok ? "" : created.message);
  assert.equal(created.value?.path, worktreePath);
  assert.equal(created.value?.branch, branch);
  assert.equal(fs.existsSync(path.join(worktreePath, ".git")), true);
  const verify = await exec("git", ["rev-parse", "--verify", branch], { cwd: repo });
  assert.ok(verify.stdout.trim().length > 0);

  const removed = await removeWorktree({ git, repoCwd: repo, worktreePath });
  assert.ok(removed.ok, removed.ok ? "" : removed.message);
  assert.equal(fs.existsSync(worktreePath), false);
  // branch still exists after worktree removal
  await exec("git", ["rev-parse", "--verify", branch], { cwd: repo });
});

test("createWorktree fails with WORKTREE_UNAVAILABLE outside a git repo", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-plain-"));
  const ceilingGit = defaultGitRunner({ GIT_CEILING_DIRECTORIES: path.dirname(plain) });
  const result = await createWorktree({
    git: ceilingGit,
    repoCwd: plain,
    worktreePath: path.join(plain, "wt"),
    branch: "team/x/y",
  });
  assert.ok(!result.ok);
  assert.equal(result.code, "WORKTREE_UNAVAILABLE");
  assert.match(result.message, /not a git repository/);
});
