/**
 * agent-team — resume support (read-only logic)
 *
 * A run is resumed by opening its parent leader session file in a new leader
 * child (`pi --mode rpc --session <file>`): the conversation is the context,
 * no handoff summary is built. These helpers locate the resumable artifacts
 * (`status.json`, the session mirror, the session-header cwd, the parent
 * shared worktree), build the fixed resume prompt, and apply per-run model
 * overrides. Everything here is pure or read-only filesystem access so the
 * cockpit/index layers stay thin and testable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readRunStatuses, type RunStatusFile } from "./runstore.ts";
import { transcriptRunDir } from "./transcript.ts";
import { TeamErrorCodes, type RunStatus, type TeamConfig, type TeamErrorCode } from "./types.ts";
import { teamWorktreeBranch } from "./worktree.ts";

/** Per-run model overrides handed to a resume (`provider/id[:level]`). */
export interface ModelOverrides {
  leaderModel?: string;
  /** Member name → model (`provider/id[:level]`, passed through as-is). */
  memberModels?: Record<string, string>;
}

/** Effective team for one run plus the override names that matched nothing. */
export interface EffectiveTeam {
  team: TeamConfig;
  unknownMembers: string[];
}

export type ResumeEligibility = { ok: true } | { ok: false; code: TeamErrorCode; message: string };

/** Finds one parent run's status snapshot (undefined when absent/corrupt). */
export function findRunStatus(root: string, runId: string): RunStatusFile | undefined {
  return readRunStatuses(root).entries.find((entry) => entry.runId === runId);
}

/**
 * Newest `.jsonl` file in a leader session dir (absolute path), or null when
 * the dir is missing/empty. A leader writes exactly one session file per
 * session dir; the newest wins if an old retry left more than one.
 */
export function resolveLeaderSessionFile(sessionDir: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(sessionDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const better =
      !best || stat.mtimeMs > best.mtimeMs || (stat.mtimeMs === best.mtimeMs && name > path.basename(best.file));
    if (better) best = { file, mtimeMs: stat.mtimeMs };
  }
  return best ? path.resolve(best.file) : null;
}

/**
 * cwd recorded in a session file's header line. Malformed/missing headers
 * yield undefined (the caller falls back to its own cwd) — never a guess.
 */
export function readSessionHeaderCwd(sessionFile: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return undefined;
  }
  const first = content.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!first) return undefined;
  try {
    const header = JSON.parse(first) as { type?: unknown; cwd?: unknown };
    if (header === null || typeof header !== "object" || header.type !== "session") return undefined;
    return typeof header.cwd === "string" && header.cwd.length > 0 ? header.cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the session file a resume opens: the parent's recorded mirror
 * when it still exists, else the newest file in the parent's session dir
 * (runs written before the mirror field existed). Null → RESUME_UNAVAILABLE.
 */
export function resolveResumeSessionFile(options: { runsRoot: string; parentStatus: RunStatusFile }): string | null {
  const recorded = options.parentStatus.leaderSessionFile;
  if (recorded) {
    try {
      if (fs.statSync(recorded).isFile()) return path.resolve(recorded);
    } catch {
      /* pruned/moved — fall through to the session dir scan */
    }
  }
  return resolveLeaderSessionFile(path.join(transcriptRunDir(options.runsRoot, options.parentStatus.runId), "session"));
}

/**
 * Applies one run's model overrides to a team config without mutating it.
 * Unknown member names are ignored and reported so the cockpit can warn
 * (the team file may have changed after the failed parent run).
 */
export function resolveEffectiveTeam(team: TeamConfig, overrides: ModelOverrides = {}): EffectiveTeam {
  const memberModels = overrides.memberModels ?? {};
  const names = new Set(team.members.map((member) => member.name));
  const unknownMembers = Object.keys(memberModels).filter((name) => !names.has(name));
  const members = team.members.map((member) => {
    const override = memberModels[member.name];
    return override === undefined ? member : { ...member, model: override };
  });
  return {
    unknownMembers,
    team: {
      ...team,
      leader: overrides.leaderModel !== undefined ? { ...team.leader, model: overrides.leaderModel } : team.leader,
      members,
    },
  };
}

/**
 * Decodes the member-model env (`PI_AGENT_TEAM_MEMBER_MODELS`). Bad JSON or
 * malformed entries are dropped: a corrupt override must never break a run
 * (the declared team models stay in effect).
 */
export function parseMemberModelEnv(raw?: string): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [name, model] of Object.entries(parsed as Record<string, unknown>)) {
    const trimmedName = name.trim();
    if (!trimmedName || typeof model !== "string" || !model.trim()) continue;
    out[trimmedName] = model.trim();
  }
  return out;
}

/**
 * Fixed resume task (also the initial RPC prompt through the cockpit's
 * `Task: ` wrapper): the conversation itself is the context, so this only
 * states "continue" — plus optional user instructions for this run.
 */
export function buildResumePrompt(instructions?: string): string {
  const trimmed = instructions?.trim();
  if (!trimmed) return "继续上次未完成的任务；完成后按团队约定的最终报告格式输出报告。";
  return `继续上次未完成的任务。补充指示：\n${trimmed}\n完成后按团队约定的最终报告格式输出报告。`;
}

/** Only failed/aborted runs are resumable (a completed run needs team_run). */
export function resumeEligibility(status: RunStatus): ResumeEligibility {
  if (status === "running") {
    return {
      ok: false,
      code: TeamErrorCodes.RUN_NOT_TERMINAL,
      message: "run 仍在运行中，无法续跑；先 team_stop 中止或等它落定后再试。",
    };
  }
  if (status === "completed") {
    return {
      ok: false,
      code: TeamErrorCodes.RUN_ALREADY_FINISHED,
      message: "run 已成功完成，无需续跑；需要继续工作请用 team_run 派新任务。",
    };
  }
  return { ok: true };
}

/**
 * Shared-worktree spec of a resumed run: the parent's recorded worktree,
 * falling back to the convention path/branch for runs recorded before the
 * `worktree` field existed.
 */
export function parentWorktreeSpec(options: {
  status?: { worktree?: { path: string; branch: string } };
  worktreeRoot: string;
  runId: string;
}): { path: string; branch: string } {
  const recorded = options.status?.worktree;
  if (recorded) return { path: recorded.path, branch: recorded.branch };
  return { path: path.join(options.worktreeRoot, options.runId, "team"), branch: teamWorktreeBranch(options.runId) };
}
