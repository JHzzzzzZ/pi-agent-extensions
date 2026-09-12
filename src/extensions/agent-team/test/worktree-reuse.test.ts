/**
 * worktree.ts re-dispatch semantics — REAL git against temp repositories.
 *
 * Incident: a same-run second dispatch of a worktree member failed with
 * WORKTREE_UNAVAILABLE whose message was git's progress line
 * "Preparing worktree (new branch '…')" — the real fatal line ("a branch
 * named '…' already exists") was thrown away. These tests pin both fixes:
 * re-entrant createWorktree (reuse a registered worktree / attach a free
 * branch) and error text that surfaces git's fatal line.
 *
 * The worktreeError() unit tests sit here as well: that function is exactly
 * where the fatal line was lost on the real machine.
 */

import { execFile } from "node:child_process";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createDispatchExecutor } from "../dispatch.ts";
import { createWorktree, defaultGitRunner, worktreeError } from "../worktree.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, type FakeChild, type FakeSpawnHandle } from "./helpers.ts";

const exec = promisify(execFile);

async function initRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-reuse-"));
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo });
  return repo;
}

/** Sibling of the repo dir (never inside it — worktrees inside are still OK but noisier). */
function siblingPath(repo: string, name: string): string {
  return path.join(repo, "..", `${path.basename(repo)}-${name}`);
}

/**
 * Real `git worktree add` takes seconds on Windows (AV/scanner) — helpers'
 * waitForChild budget (1s) is too tight for the dispatch-level case, so wait
 * generously here.
 */
async function waitForSpawnedChild(handle: FakeSpawnHandle, index: number): Promise<FakeChild> {
  for (let i = 0; i < 600; i++) {
    if (handle.children[index]) return handle.children[index];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no child spawned at index ${index}`);
}

// ---------------------------------------------------------------------------
// worktreeError (pure)
// ---------------------------------------------------------------------------

test("worktreeError keeps git's fatal line and drops the worktree-add progress line", () => {
  // Verbatim Windows stderr from the real incident (git 2.x, `worktree add -b`).
  const stderr =
    "Preparing worktree (new branch 'team/run-1/backend')\nfatal: a branch named 'team/run-1/backend' already exists\n";
  const message = worktreeError(stderr);
  assert.match(message, /fatal: a branch named 'team\/run-1\/backend' already exists/);
  assert.doesNotMatch(message, /Preparing worktree/);
});

test("worktreeError falls back to the first line when every line is progress noise", () => {
  const stderr = "Preparing worktree (new branch 'x')\nHEAD is now at abc1234 init\nUpdating files: 100% (2/2)\n";
  assert.equal(worktreeError(stderr), "Preparing worktree (new branch 'x')");
});

test("worktreeError collapses CRLF and runs of whitespace into one bounded line", () => {
  assert.equal(worktreeError("fatal:  a branch\r\n   named 'x'\r\n"), "fatal: a branch named 'x'");
  const long = worktreeError(`fatal: ${"x".repeat(400)}`);
  assert.equal(long.length, 301);
  assert.ok(long.endsWith("…"));
});

test("worktreeError reports (no stderr) for empty output", () => {
  assert.equal(worktreeError(""), "(no stderr)");
  assert.equal(worktreeError("  \n \n"), "(no stderr)");
});

// ---------------------------------------------------------------------------
// createWorktree re-dispatch semantics (real git)
// ---------------------------------------------------------------------------

test("createWorktree is re-entrant: same path + branch reuses the registered worktree", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const worktreePath = siblingPath(repo, "reuse");
  const branch = "team/run-1/backend";

  const first = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(first.ok, first.ok ? "" : first.message);
  fs.writeFileSync(path.join(worktreePath, "marker.txt"), "keep me");

  const second = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(second.ok, second.ok ? "" : second.message);
  assert.deepEqual(second.value, { path: worktreePath, branch });
  assert.equal(fs.existsSync(path.join(worktreePath, ".git")), true);
  assert.equal(fs.readFileSync(path.join(worktreePath, "marker.txt"), "utf-8"), "keep me");
  const head = await exec("git", ["-C", worktreePath, "rev-parse", "--verify", "HEAD"]);
  assert.ok(head.stdout.trim().length > 0, "reused worktree has a valid HEAD");
});

test("createWorktree surfaces the real git fatal when another worktree holds the branch", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const branch = "team/run-1/backend";
  const first = await createWorktree({ git, repoCwd: repo, worktreePath: siblingPath(repo, "w1"), branch });
  assert.ok(first.ok, first.ok ? "" : first.message);

  const second = await createWorktree({ git, repoCwd: repo, worktreePath: siblingPath(repo, "w2"), branch });
  assert.ok(!second.ok);
  assert.equal(second.code, "WORKTREE_UNAVAILABLE");
  assert.match(second.message, /fatal: a branch named 'team\/run-1\/backend' already exists/);
  assert.ok(second.message.includes(branch), "message names the branch");
  assert.doesNotMatch(second.message, /Preparing worktree/);
  assert.match(second.message, /git worktree list/);
});

test("createWorktree still rejects non-repositories before any worktree work (regression)", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-reuse-plain-"));
  // GIT_CEILING_DIRECTORIES stops git's upward discovery: a parent repo must
  // not make an arbitrary temp dir look like one (same pattern as worktree.test.ts).
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

test("createWorktree attaches a free existing branch instead of failing", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const branch = "team/run-1/backend";
  await exec("git", ["branch", branch], { cwd: repo });

  const worktreePath = siblingPath(repo, "attach");
  const created = await createWorktree({ git, repoCwd: repo, worktreePath, branch });
  assert.ok(created.ok, created.ok ? "" : created.message);
  const head = await exec("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(head.stdout.trim(), branch);
});

test("createWorktree refuses a path occupied by a plain directory with an actionable message", async () => {
  const repo = await initRepo();
  const git = defaultGitRunner();
  const worktreePath = siblingPath(repo, "occupied");
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "plain.txt"), "not a worktree");

  const result = await createWorktree({ git, repoCwd: repo, worktreePath, branch: "team/run-1/backend" });
  assert.ok(!result.ok);
  assert.equal(result.code, "WORKTREE_UNAVAILABLE");
  assert.match(result.message, /not a registered git worktree/);
  assert.match(result.message, /remove/i);
});

// ---------------------------------------------------------------------------
// dispatch-level integration (real git + fake member spawn)
// ---------------------------------------------------------------------------

test("dispatch re-dispatch of a worktree member reuses the same worktree", async () => {
  const repo = await initRepo();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-reuse-root-"));
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

  // Marker proves the second dispatch reused the existing worktree instead of
  // rebuilding it (a fresh `worktree add` would either fail or wipe the tree).
  fs.writeFileSync(path.join(expectedPath, "marker.txt"), "kept");

  const second = executor({ tasks: [{ agent: "backend", task: "第二次" }] }, undefined, undefined);
  const secondChild = await waitForSpawnedChild(fakeSpawn, 1);
  secondChild.autoRespond([assistantLine("第二次完成")]);
  const secondOutcome = await second;
  assert.ok(secondOutcome.ok, secondOutcome.ok ? "" : `${secondOutcome.code} ${secondOutcome.message}`);
  assert.equal(secondOutcome.value.results[0].ok, true);
  assert.deepEqual(secondOutcome.value.results[0].worktree, { path: expectedPath, branch: "team/run-1/backend" });
  assert.equal(fakeSpawn.records[1].cwd, expectedPath);
  assert.equal(fs.readFileSync(path.join(expectedPath, "marker.txt"), "utf-8"), "kept");
});
