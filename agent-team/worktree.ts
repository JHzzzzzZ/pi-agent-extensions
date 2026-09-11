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

/**
 * Default git runner: non-throwing execFile wrapper. `extraEnv` is merged
 * over process.env (tests use GIT_CEILING_DIRECTORIES to isolate from
 * repositories in parent directories).
 */
export function defaultGitRunner(extraEnv?: NodeJS.ProcessEnv): GitRunner {
  return (args, cwd) =>
    new Promise((resolve) => {
      execFile(
        "git",
        args,
        { cwd, env: extraEnv ? { ...process.env, ...extraEnv } : undefined, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          // exit code 128 covers "not a git repository" and worktree failures
          const code =
            error && typeof (error as NodeJS.ErrnoException).code === "number"
              ? (error as unknown as { code: number }).code
              : error
                ? 1
                : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

function fail(message: string): Result<never> {
  return err(TeamErrorCodes.WORKTREE_UNAVAILABLE, message);
}

/** One block of `git worktree list --porcelain`. */
interface WorktreeEntry {
  /** Path as reported by git (forward slashes on Windows). */
  path: string;
  /** Short branch name (`refs/heads/` stripped) when attached to one. */
  branch?: string;
}

/** git progress chatter — never the failure reason. */
const GIT_PROGRESS_LINE = /^(Preparing worktree|HEAD is now at|Updating files|Checking out files)\b/i;

const MAX_WORKTREE_ERROR = 300;

/**
 * Bounded single-line rendering of git stderr that skips progress noise.
 * git prints "Preparing worktree (new branch 'x')" BEFORE the fatal line, so
 * taking the first line hid "fatal: a branch named 'x' already exists"
 * (same-run re-dispatch incident, v1.15.2); all-progress stderr still falls
 * back to its first line so callers see something.
 */
export function worktreeError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const informative = lines.filter((line) => !GIT_PROGRESS_LINE.test(line));
  const text = (informative.length > 0 ? informative : lines.slice(0, 1))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "(no stderr)";
  return text.length > MAX_WORKTREE_ERROR ? `${text.slice(0, MAX_WORKTREE_ERROR)}…` : text;
}

function normalizeWorktreePath(p: string): string {
  const slashed = path.resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** Parses porcelain blocks: `worktree <path>` + optional `branch refs/heads/<name>`. */
function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim() };
    } else if (current && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Registered worktree at `worktreePath`, comparing normalized paths. */
function findRegistered(entries: WorktreeEntry[], worktreePath: string): WorktreeEntry | undefined {
  const wanted = normalizeWorktreePath(worktreePath);
  return entries.find((entry) => normalizeWorktreePath(entry.path) === wanted);
}

/** True when `cwd` is inside a git working tree. */
export async function isGitRepo(git: GitRunner, cwd: string): Promise<boolean> {
  const r = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.code === 0 && r.stdout.trim() === "true";
}

/**
 * Creates an isolated worktree at `worktreePath` on `branch`. The parent
 * directory is created if missing. Re-entrant: a same-run re-dispatch whose
 * worktree is already registered on the same branch reuses it, and a branch
 * that exists but is held by no worktree is attached to the path.
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
  // Re-entrant re-dispatch: reuse is preferred over a new error code because
  // a same-run retry should just work (v1.15.2 — see docs/incidents.md).
  const list = await git(["worktree", "list", "--porcelain"], repoCwd);
  const registered = list.code === 0 ? parseWorktreeList(list.stdout) : [];
  const existing = findRegistered(registered, worktreePath);
  if (existing) {
    if (existing.branch !== branch) {
      return fail(
        `worktree path "${worktreePath}" is already registered on branch "${existing.branch ?? "(detached HEAD)"}" ` +
          `but this dispatch needs "${branch}" — run \`git worktree remove --force "${worktreePath}"\` and retry`,
      );
    }
    if (!fs.existsSync(worktreePath)) {
      return fail(
        `worktree path "${worktreePath}" is registered but its directory is missing — run \`git worktree prune\` and retry`,
      );
    }
    return ok({ path: worktreePath, branch });
  }
  if (fs.existsSync(worktreePath)) {
    return fail(
      `worktree path "${worktreePath}" already exists but is not a registered git worktree — remove or rename that directory and retry`,
    );
  }
  const r = await git(["worktree", "add", worktreePath, "-b", branch], repoCwd);
  if (r.code === 0) {
    return ok({ path: worktreePath, branch });
  }

  const failure = `git worktree add failed: ${worktreeError(r.stderr)}`;
  const branchCheck = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoCwd);
  if (branchCheck.code !== 0) {
    return fail(failure);
  }
  const holder = registered.find((entry) => entry.branch === branch);
  if (holder) {
    return fail(
      `${failure} — branch "${branch}" is already checked out at "${holder.path}"; run \`git worktree list\` to locate it`,
    );
  }
  // Branch exists but no worktree holds it (leftover after a removed
  // worktree) — attach it instead of forcing a manual cleanup.
  const attach = await git(["worktree", "add", worktreePath, branch], repoCwd);
  if (attach.code !== 0) {
    return fail(`git worktree add failed: ${worktreeError(attach.stderr)}`);
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

