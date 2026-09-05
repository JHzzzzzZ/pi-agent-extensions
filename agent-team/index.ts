/**
 * agent-team — extension entry
 *
 * One codebase, two modes:
 *
 * - **Leader mode** (env `PI_AGENT_TEAM_FILE` set): this process IS the
 *   leader child spawned by the cockpit. Registers only the
 *   `team_dispatch` tool so the leader model can delegate subtasks to
 *   team members.
 * - **Cockpit mode** (default, main pi session): registers the
 *   conversation tools (`team_create`, `team_list`, `team_run`), the
 *   `/team*` commands, the live progress widget, and run persistence.
 *
 * Install: copy this directory into `~/.pi/agent/extensions/` (or the
 * project's `.pi/extensions/`), then `/reload`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverTeams, findTeam, parseTeamFile } from "./config.ts";
import { createDispatchExecutor, parseDispatchRequest } from "./dispatch.ts";
import { registerManageTools, teamSummaryLines } from "./manage.ts";
import { TeamRunCoordinator, formatStatusSnapshot, type UiPort } from "./cockpit.ts";
import { appendRunRecord, createRunEntryRenderer, deliverRunResult, type SessionPort } from "./session.ts";
import {
  LEADER_ENV_FILE,
  LEADER_ENV_RUNID,
  RUN_ENTRY_TYPE,
  WIDGET_ID,
  type TeamConfig,
  type TeamRunRecord,
} from "./types.ts";

function extensionEntryPath(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.url);
    return fs.existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function worktreeRoot(): string {
  return path.join(getAgentDir(), "teams", "worktrees");
}

/** Builds the guarded UI port over ctx.ui (repo TUI conventions). */
function uiPortFrom(ctx: ExtensionContext): UiPort {
  return {
    setWidget: (lines) => {
      if (!ctx.hasUI) return;
      try {
        ctx.ui.setWidget(WIDGET_ID, lines);
      } catch {
        /* widget failures never break the session */
      }
    },
    notify: (text, level) => {
      try {
        ctx.ui.notify(text, level);
      } catch {
        /* notify failures never break the session */
      }
    },
    dim: (text) => {
      try {
        return ctx.ui.theme.fg("dim", text);
      } catch {
        return text;
      }
    },
  };
}

function clearWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Leader mode (inside the leader child pi process)
// ---------------------------------------------------------------------------

function registerLeaderMode(pi: ExtensionAPI, teamFile: string): void {
  let content: string | null = null;
  try {
    content = fs.readFileSync(teamFile, "utf-8");
  } catch {
    content = null;
  }
  const parsed = content !== null ? parseTeamFile(content, { filePath: teamFile, source: "global" }) : undefined;
  const runId = process.env[LEADER_ENV_RUNID] || `run-${Date.now()}`;

  // One executor per leader process: it carries the per-run dispatch budget
  // across calls. The leader child's process cwd IS the run cwd (the
  // coordinator spawned us there — shared worktree or base directory).
  const executor =
    parsed && parsed.ok
      ? createDispatchExecutor({
          team: parsed.value,
          cwd: process.cwd(),
          worktreeRoot: worktreeRoot(),
          runId,
          killGraceMs: 5000,
        })
      : undefined;

  pi.registerTool({
    name: "team_dispatch",
    label: "Team Dispatch",
    description:
      "把子任务派发给团队成员（并行执行，结果按成员分节返回）。一次最多 8 个子任务；有依赖的子任务分多次调用。环境级失败重试无效；有派发预算上限。",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          agent: Type.String({ description: "成员名（见系统提示中的团队花名册）" }),
          task: Type.String({ description: "自包含的子任务描述：目标、涉及文件/路径、约束、期望产出" }),
        }),
        { description: "要派发的子任务列表（1~8 个）", minItems: 1, maxItems: 8 },
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!parsed || !parsed.ok || !executor) {
        return {
          content: [
            {
              type: "text" as const,
              text: `团队定义不可用（${teamFile}）：${parsed && !parsed.ok ? parsed.message : "文件无法读取"}`,
            },
          ],
          details: { code: "INVALID_TEAM_FILE" },
          isError: true,
        };
      }
      const request = parseDispatchRequest(params);
      if (!request.ok) {
        return {
          content: [{ type: "text" as const, text: request.message }],
          details: { code: "INVALID_DISPATCH" },
          isError: true,
        };
      }
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "dispatch aborted" }],
          details: { code: "AGENT_ABORTED" },
          isError: true,
        };
      }
      const updateProxy = onUpdate
        ? (update: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => {
            try {
              onUpdate({ content: update.content, details: update.details ?? {} });
            } catch {
              /* progress failures never break the run */
            }
          }
        : undefined;
      const executed = await executor(request.value, signal, updateProxy);
      if (!executed.ok) {
        // Budget exceeded (or other executor-level failure): force wrap-up.
        return {
          content: [{ type: "text" as const, text: executed.message }],
          details: { code: executed.code },
          isError: true,
        };
      }
      const outcome = executed.value;
      const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
      for (const result of outcome.results) {
        totalUsage.input += result.usage.input;
        totalUsage.output += result.usage.output;
        totalUsage.cost += result.usage.cost;
      }
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        details: {
          members: outcome.results.map((result) => ({
            name: result.name,
            ok: result.ok,
            status: result.status,
            ...(result.summary ? { summary: result.summary } : {}),
            ...(result.result && result.ok ? { latest: singleLineTail(result.result) } : {}),
            usage: result.usage,
            ...(result.worktree ? { worktree: result.worktree } : {}),
            ...(result.error ? { error: result.error } : {}),
          })),
          totalUsage,
        },
      };
    },
  });
}

/** Single-line tail helper for tool details (kept local; mirrors runner.textTail). */
function singleLineTail(text: string, max = 160): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `…${single.slice(single.length - max)}`;
}

// ---------------------------------------------------------------------------
// Cockpit mode (main pi session)
// ---------------------------------------------------------------------------

function registerCockpitMode(pi: ExtensionAPI): void {
  const state: {
    coordinator: TeamRunCoordinator;
    cwd: string;
    projectTrusted: boolean;
  } = {
    coordinator: new TeamRunCoordinator({
      cwd: () => state.cwd,
      worktreeRoot: worktreeRoot(),
      extensionEntryPath: extensionEntryPath(),
    }),
    cwd: process.cwd(),
    projectTrusted: false,
  };

  const resolveTeam = (name: string): { ok: true; value: TeamConfig } | { ok: false; message: string } => {
    const found = findTeam({
      cwd: state.cwd,
      scope: state.projectTrusted ? "both" : "global",
      name,
    });
    return found.ok ? { ok: true, value: found.value } : { ok: false, message: found.message };
  };

  /** Command-mode run flow (runs in BACKGROUND): persist, notify, deliver. */
  const runFromCommand = (ctx: ExtensionContext, teamName: string, task: string): void => {
    const ui = uiPortFrom(ctx);
    const found = resolveTeam(teamName);
    if (!found.ok) {
      ui.notify(found.message, "error");
      return;
    }
    ui.notify(`team ${teamName} 已在后台启动（/team:status 查看进度，/team:stop 中止）`, "info");
    // Fire-and-forget: the command handler returns immediately so the user
    // can keep talking to the main agent while the team works. Completion
    // still persists the record and wakes the session with the report.
    void state.coordinator
      .start({ team: found.value, task, ui })
      .then((result) => {
        if (!result.ok) {
          ui.notify(result.message, "error");
          return;
        }
        const record = result.value;
        appendRunRecord(pi as unknown as SessionPort, record);
        if (record.status === "completed") {
          const secs = Math.round((record.durationMs ?? 0) / 100) / 10;
          ui.notify(`team ${teamName} 完成 ✓（${secs}s，$${record.totalCost.toFixed(4)}）`, "info");
          deliverRunResult(pi as unknown as SessionPort, record.report ?? "(leader 未返回报告)");
        } else {
          ui.notify(
            `team ${teamName} ${record.status}: ${record.error ?? "已中止"}`,
            record.status === "aborted" ? "warning" : "error",
          );
        }
      })
      .catch((e: unknown) => {
        ui.notify(`team run 异常退出: ${e instanceof Error ? e.message : String(e)}`, "error");
      });
  };

  // -- Conversation tools -------------------------------------------------

  registerManageTools(pi);

  pi.registerTool({
    name: "team_run",
    label: "Run Agent Team",
    description:
      "把一个任务派给指定的 agent team：leader 会拆解任务并通过 team_dispatch 调度成员协同完成，返回最终报告。同一团队可反复派单复用。",
    promptGuidelines: [
      "派单前先用 team_list 确认团队存在且成员配置合适；不确定时先问用户。",
      "task 要自包含：目标、范围、验收标准。成员和 leader 都看不到这段对话。",
    ],
    parameters: Type.Object({
      team: Type.String({ description: "团队名（可用 team_list 查询）" }),
      task: Type.String({ description: "任务描述（issue）" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const found = resolveTeam(params.team);
      if (!found.ok) {
        return {
          content: [{ type: "text" as const, text: found.message }],
          details: { code: "TEAM_NOT_FOUND" },
          isError: true,
        };
      }
      const ui = uiPortFrom(ctx);
      const result = await state.coordinator.start({
        team: found.value,
        task: params.task,
        ui,
        signal,
        onProgress: (progress) => {
          if (!onUpdate) return;
          try {
            const active = progress.members.filter((m) => m.status === "running").length;
            onUpdate({
              content: [
                {
                  type: "text" as const,
                  text: `team ${progress.team} 运行中 · ${active}/${progress.members.length} 成员并行`,
                },
              ],
              details: {},
            });
          } catch {
            /* progress failures never break the run */
          }
        },
      });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: { code: result.code },
          isError: true,
        };
      }
      const record = result.value;
      appendRunRecord(pi as unknown as SessionPort, record);
      if (record.status !== "completed") {
        return {
          content: [{ type: "text" as const, text: `team run ${record.status}: ${record.error ?? "(no error detail)"}` }],
          details: record,
          isError: record.status === "failed",
        };
      }
      return {
        content: [{ type: "text" as const, text: record.report ?? "(leader 未返回报告)" }],
        details: record,
      };
    },
  });

  // Status query tool: lets the MAIN agent answer "团队现在在干什么" at any
  // time, including while a background run is in progress.
  pi.registerTool({
    name: "team_status",
    label: "Agent Team Status",
    description: "查看当前/最近一次 agent team run 的状态：各成员在做什么、轮次、费用、worktree。",
    promptGuidelines: ["用户问团队进度时调用本工具并转述结果；后台 run 进行中也可以随时调用。"],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      return {
        content: [{ type: "text" as const, text: statusText(ctx) }],
        details: {},
      };
    },
  });

  // -- Commands -----------------------------------------------------------

  const statusText = (ctx: ExtensionContext): string =>
    formatStatusSnapshot(state.coordinator.getStatus(), Date.now(), (t) => {
      try {
        return ctx.hasUI ? ctx.ui.theme.fg("dim", t) : t;
      } catch {
        return t;
      }
    });

  pi.registerCommand("team", {
    description: "列出所有 agent team（团队/成员/模型）",
    handler: async (_args, ctx) => {
      const ui = uiPortFrom(ctx);
      const { teams, invalid } = discoverTeams({
        cwd: state.cwd,
        scope: state.projectTrusted ? "both" : "global",
      });
      if (teams.length === 0 && invalid.length === 0) {
        ui.notify("没有任何团队定义。用 team_create 工具创建，或在 ~/.pi/agent/teams/ 放置团队 .md 文件。", "info");
        return;
      }
      const lines: string[] = [];
      for (const team of teams) lines.push(...teamSummaryLines(team), "");
      for (const bad of invalid) lines.push(`⚠ ${bad.file} — ${bad.message}`);
      ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("team:run", {
    description: "派单（后台运行）：/team:run <团队名> <任务描述>",
    handler: async (args, ctx) => {
      const ui = uiPortFrom(ctx);
      const trimmed = (args ?? "").trim();
      const spaceIndex = trimmed.indexOf(" ");
      if (spaceIndex <= 0 || trimmed.slice(spaceIndex + 1).trim().length === 0) {
        ui.notify("用法：/team:run <团队名> <任务描述>", "warning");
        return;
      }
      const teamName = trimmed.slice(0, spaceIndex);
      const task = trimmed.slice(spaceIndex + 1).trim();
      runFromCommand(ctx, teamName, task);
    },
  });

  pi.registerCommand("team:status", {
    description: "查看当前/最近一次 team run 的状态（各成员在干什么）",
    handler: async (_args, ctx) => {
      uiPortFrom(ctx).notify(statusText(ctx), "info");
    },
  });

  pi.registerCommand("team:stop", {
    description: "中止当前 team run（leader 与所有成员）",
    handler: async (_args, ctx) => {
      const ui = uiPortFrom(ctx);
      if (state.coordinator.stop()) {
        ui.notify("已发送中止信号（SIGTERM → SIGKILL）", "warning");
      } else {
        ui.notify("当前没有正在进行的 team run", "info");
      }
    },
  });

  // -- Session lifecycle --------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    state.cwd = ctx.cwd;
    state.projectTrusted = ctx.isProjectTrusted();
    clearWidget(ctx);

    // Hydrate the most recent run record so /team:status works after reload.
    try {
      const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: unknown }>;
      for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE && entry.data) {
          const data = entry.data as { runId?: string; team?: string; task?: string; startedAt?: string; status?: string; members?: unknown[] };
          if (typeof data.runId === "string" && typeof data.team === "string" && typeof data.task === "string") {
            state.coordinator.restoreLastRecord(data as unknown as TeamRunRecord);
          }
        }
      }
    } catch {
      /* hydration is best-effort */
    }

    // Dynamic per-team commands: /team:<name> <任务>（/reload 后新团队生效）
    const { teams } = discoverTeams({ cwd: state.cwd, scope: state.projectTrusted ? "both" : "global" });
    for (const team of teams) {
      pi.registerCommand(`team:${team.name}`, {
        description: `派单给 ${team.name}${team.description ? `（${team.description}）` : ""}：/team:${team.name} <任务>`,
        handler: async (args, cmdCtx) => {
          const task = (args ?? "").trim();
          if (!task) {
            uiPortFrom(cmdCtx).notify(`用法：/team:${team.name} <任务描述>`, "warning");
            return;
          }
          runFromCommand(cmdCtx, team.name, task);
        },
      });
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.coordinator.stop();
    clearWidget(ctx);
  });

  // Run record entry card (collapsed one-liner, expanded detail).
  pi.registerEntryRenderer(RUN_ENTRY_TYPE, createRunEntryRenderer());
}

// ---------------------------------------------------------------------------

export default function agentTeamExtension(pi: ExtensionAPI): void {
  const teamFile = process.env[LEADER_ENV_FILE];
  if (teamFile) {
    registerLeaderMode(pi, teamFile);
    return;
  }
  registerCockpitMode(pi);
}
