/**
 * agent-team — git worktree isolation for members
 *
 * Members flagged `worktree: true` run in their own git worktree under
 * `~/.pi/agent/teams/worktrees/<runId>/<member>` on a dedicated branch
 * `team/<runId>/<member>`. Worktrees are kept after the run (no auto-merge
 * in v1); the dispatch result reports path + branch so the leader (or the
 * user) decides how to integrate the changes.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { err, ok, type Result, TeamErrorCodes } from "./types.ts";

/** Injectable git runner (tests use a fake or a real temp repo). */
export type GitRunner = (
  args: string[],
  cwd?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Default git runner: non-throwing execFile wrapper. */
export function defaultGitRunner(): GitRunner {
  return (args, cwd) =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        // exit code 128 covers "not a git repository" and worktree failures
        const code = error && typeof (error as NodeJS.ErrnoException).code === "number" ? ((error as unknown as { code: number }).code) : error ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

function fail(message: string): Result<never> {
  return err(TeamErrorCodes.WORKTREE_UNAVAILABLE, message);
}

/** True when `cwd` is inside a git working tree. */
export async function isGitRepo(git: GitRunner, cwd: string): Promise<boolean> {
  const r = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.code === 0 && r.stdout.trim() === "true";
}

/**
 * Creates an isolated worktree at `worktreePath` on a new branch. The
 * parent directory is created if missing.
 */
export async function createWorktree(options: {
  git: GitRunner;
  repoCwd: string;
  worktreePath: string;
  branch: string;
}): Promise<Result<{ path: string; branch: string }>> {
  const { git, repoCwd, worktreePath, branch } = options;
  if (!(await isGitRepo(git, repoCwd))) {
    return fail(`"${repoCwd}" is not a git repository — worktree isolation requires one`);
  }
  try {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  } catch (e) {
    return fail(`failed to create worktree parent dir: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = await git(["worktree", "add", worktreePath, "-b", branch], repoCwd);
  if (r.code !== 0) {
    return fail(`git worktree add failed: ${worktreeError(r.stderr)}`);
  }
  return ok({ path: worktreePath, branch });
}

/** Removes a worktree (force). Missing worktrees count as removed. */
export async function removeWorktree(options: {
  git: GitRunner;
  repoCwd: string;
  worktreePath: string;
}): Promise<Result<void>> {
  const r = await options.git(["worktree", "remove", "--force", options.worktreePath], options.repoCwd);
  if (r.code !== 0 && !/not a working tree|does not exist/i.test(r.stderr)) {
    return fail(`git worktree remove failed: ${worktreeError(r.stderr)}`);
  }
  return ok(undefined);
}

/** Truncates git stderr to a bounded, single-line-safe message. */
function worktreeError(stderr: string): string {
  const text = stderr.trim().split("\n")[0] ?? "";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || "(no stderr)";
}
