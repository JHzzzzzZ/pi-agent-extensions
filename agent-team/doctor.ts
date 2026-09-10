/**
 * agent-team — doctor self-check (`/team:doctor`)
 *
 * A pure report builder over injected deps (mirroring pi-subagents'
 * extension/doctor.ts pattern): team discovery, per-team model preflight,
 * the run-status store (stale running runs, corrupt files), per-team
 * budgets, worktree requirements, the widget switch, and the host model
 * registry's error state. Everything degrades to a report line — the
 * doctor never throws.
 */

import * as fs from "node:fs";
import { discoverTeams, type DiscoveryResult } from "./config.ts";
import { readRunStatuses, type RunStatusesRead } from "./runstore.ts";
import { preflightTeamModels, type ModelLookup } from "./preflight.ts";
import { resolveRunBudget, type TeamConfig } from "./types.ts";

/** Where the doctor runs: main session (cockpit) or leader child. */
export type DoctorMode = "cockpit" | "leader";

/** All facts the report renders (probes resolved by the caller). */
export interface DoctorInput {
  mode: DoctorMode;
  cwd: string;
  projectTrusted: boolean;
  /** Team discovery scope (project files only for trusted projects). */
  scope: "global" | "both";
  /** Below-editor run widget enabled (PI_AGENT_TEAM_WIDGET !== "0"). */
  widgetEnabled: boolean;
  /** modelRegistry.getError() — undefined when the registry is healthy. */
  registryError?: string;
  /** Root of per-run artifacts (status.json + transcripts). */
  runsRoot: string;
  /** Root of per-run worktrees. */
  worktreeRoot: string;
  globalDir?: string;
}

export interface DoctorDeps {
  discoverTeams(options: { cwd: string; scope: "global" | "both"; globalDir?: string }): DiscoveryResult;
  readRunStatuses(root: string): RunStatusesRead;
  lookup: ModelLookup;
  /** Directory probe: writable / missing / unwritable. */
  dirStatus(path: string): "ok" | "missing" | "unwritable";
  isGitRepo(cwd: string): boolean;
}

function dirProbe(path: string): "ok" | "missing" | "unwritable" {
  try {
    if (!fs.statSync(path).isDirectory()) return "missing";
    fs.accessSync(path, fs.constants.W_OK);
    return "ok";
  } catch {
    try {
      if (!fs.existsSync(path)) return "missing";
      return "unwritable";
    } catch {
      return "missing";
    }
  }
}

function defaultDeps(overrides?: Partial<DoctorDeps>): DoctorDeps {
  return {
    discoverTeams,
    readRunStatuses,
    lookup: { find: () => undefined, hasConfiguredAuth: () => true },
    dirStatus: dirProbe,
    isGitRepo: (cwd) => {
      try {
        return fs.statSync(`${cwd}/.git`).isDirectory();
      } catch {
        return false;
      }
    },
    ...overrides,
  };
}

/** "预算 caps" summary for one team (defaults included, source labeled). */
function budgetLine(team: TeamConfig): string {
  const b = resolveRunBudget(team.budget);
  const cost = b.maxCostUsd !== null ? `$${b.maxCostUsd.toFixed(2)}` : "无限";
  const tokens = b.maxTotalTokens !== null ? `${b.maxTotalTokens}` : "无限";
  return `- ${team.name}: 派发 ${b.maxDispatchCalls} · 成员 ${b.maxMemberRuns} · 费用 ${cost} · tokens ${tokens}（来源: ${b.source}）`;
}

/** Per-team model preflight line. */
function preflightLine(team: TeamConfig, lookup: ModelLookup): string {
  const result = preflightTeamModels(team, lookup);
  if (result.ok) {
    if (result.warnings.length === 0) return `- ✓ ${team.name}: 全部模型可解析`;
    return [`- ⚠ ${team.name}: 模型可解析，但存在鉴权警告`, ...result.warnings.map((w) => `  - ${w}`)].join("\n");
  }
  return `- ✗ ${team.name}: ${result.message}`;
}

/**
 * Builds the full doctor report. Every section is independent — a throwing
 * dep degrades that section to an error line instead of failing the report.
 */
export function buildDoctorReport(input: DoctorInput, depsOverride?: Partial<DoctorDeps>): string {
  const deps = defaultDeps(depsOverride);
  const section = (label: string, render: () => string[]): string[] => {
    try {
      return [label, ...render()];
    } catch (e) {
      return [label, `- 分节渲染失败: ${e instanceof Error ? e.message : String(e)}`];
    }
  };

  const lines: string[] = ["agent-team 自检报告", ""];

  lines.push(
    ...section("运行模式", () => [
      `- 模式: ${input.mode}${input.mode === "leader" ? "（子进程，PI_AGENT_TEAM_FILE 已设置）" : "（主会话）"}`,
      `- cwd: ${input.cwd}`,
      `- 项目信任: ${input.projectTrusted ? "是（project scope 团队可用）" : "否（仅 global scope 团队可用）"}`,
      `- 亮块 widget: ${input.widgetEnabled ? "启用" : "关闭（PI_AGENT_TEAM_WIDGET=0）"}`,
    ]),
    "",
  );

  lines.push(
    ...section("模型注册表", () => [input.registryError ? `- 错误: ${input.registryError}` : "- 正常（无错误）"]),
    "",
  );

  lines.push(
    ...section("团队发现", () => {
      const { teams, invalid } = deps.discoverTeams({
        cwd: input.cwd,
        scope: input.scope,
        ...(input.globalDir ? { globalDir: input.globalDir } : {}),
      });
      const globalCount = teams.filter((t) => t.source === "global").length;
      const projectCount = teams.filter((t) => t.source === "project").length;
      const out = [`- global: ${globalCount} 个；project: ${projectCount} 个；无效文件 ${invalid.length} 个`];
      for (const bad of invalid) out.push(`- ⚠ ${bad.file} — ${bad.message}`);
      return out;
    }),
    "",
  );

  lines.push(
    ...section("模型预检", () => {
      const { teams } = deps.discoverTeams({
        cwd: input.cwd,
        scope: input.scope,
        ...(input.globalDir ? { globalDir: input.globalDir } : {}),
      });
      if (teams.length === 0) return ["- （没有可用团队）"];
      return teams.map((team) => preflightLine(team, deps.lookup));
    }),
    "",
  );

  lines.push(
    ...section("运行目录", () => {
      const status = deps.dirStatus(input.runsRoot);
      const statusText = status === "ok" ? `ok (${input.runsRoot})` : status === "missing" ? `缺失 (${input.runsRoot})` : `不可写 (${input.runsRoot})`;
      const read = deps.readRunStatuses(input.runsRoot);
      const stale = read.entries.filter((e) => e.status === "running");
      const out = [
        `- runs 目录: ${statusText}`,
        `- run 目录数: ${read.entries.length + read.corrupt.length}`,
        `- 残留 running: ${stale.length} 个${stale.length > 0 ? `（${stale.map((e) => (e.leaderPid !== undefined ? `${e.runId}（pid ${e.leaderPid}）` : e.runId)).join("、")}）` : ""}`,
        `- 损坏 status 文件: ${read.corrupt.length}`,
      ];
      for (const bad of read.corrupt) out.push(`  - ${bad.file} — ${bad.message}`);
      return out;
    }),
    "",
  );

  lines.push(
    ...section("预算", () => {
      const { teams } = deps.discoverTeams({
        cwd: input.cwd,
        scope: input.scope,
        ...(input.globalDir ? { globalDir: input.globalDir } : {}),
      });
      if (teams.length === 0) return ["- （没有可用团队）"];
      return teams.map(budgetLine);
    }),
    "",
  );

  lines.push(
    ...section("worktree", () => [
      `- git 仓库: ${deps.isGitRepo(input.cwd) ? "是" : "否（worktree 隔离的团队/成员将预检失败）"}`,
      `- worktreeRoot: ${(() => {
        const status = deps.dirStatus(input.worktreeRoot);
        return status === "ok" ? `ok (${input.worktreeRoot})` : status === "missing" ? `缺失 (${input.worktreeRoot})` : `不可写 (${input.worktreeRoot})`;
      })()}`,
    ]),
    "",
  );

  return lines.join("\n");
}
