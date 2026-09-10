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
 *   `/team*` commands, the selectable below-editor run widget, and run
 *   persistence.
 *
 * Install: copy this directory into `~/.pi/agent/extensions/` (or the
 * project's `.pi/extensions/`), then `/reload`. The double-load guard at
 * the bottom resets on `session_shutdown` (pi guarantees it fires before
 * re-binding extensions on reload/new/resume/fork/switch), so reload
 * re-registers everything instead of silently no-op'ing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverTeams, findTeam, parseTeamFile } from "./config.ts";
import { createDispatchExecutor, parseDispatchRequest } from "./dispatch.ts";
import { ChatCoordinator, chatSubmitNotice, transcriptContextTail } from "./chat.ts";
import { buildDoctorReport } from "./doctor.ts";
import { registerManageTools, teamSummaryLines } from "./manage.ts";
import { TeamRunCoordinator, formatStatusSnapshot, type UiPort } from "./cockpit.ts";
import { modelLookupFrom, preflightTeamModels } from "./preflight.ts";
import { orphanRunError, reconcileStaleRuns } from "./runstore.ts";
import { appendRunRecord, createRunEntryRenderer, deliverRunResult, type SessionPort } from "./session.ts";
import { RunWidgetController, probeEditorFocus } from "./widget.ts";
import { formatTranscriptText, openTranscriptViewer, themeStyles, type ViewerActor, type ViewerData, type ViewerStopResult } from "./viewer.ts";
import {
  FileTranscriptSink,
  LEADER_ACTOR,
  listTranscriptActors,
  pruneOldTranscripts,
  readTranscript,
  sanitizeActorName,
  type TranscriptEntry,
} from "./transcript.ts";
import {
  LEADER_ENV_FILE,
  LEADER_ENV_RUNID,
  MAX_RESULT_BYTES,
  RUN_ENTRY_TYPE,
  STOP_SETTLE_TIMEOUT_MS,
  WIDGET_ID,
  resolveRunBudget,
  truncateUtf8,
  type PiSpawn,
  type TeamConfig,
  type TeamRunRecord,
} from "./types.ts";
import { defaultGitRunner, isGitRepo } from "./worktree.ts";

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

/** Root of per-run transcript artifacts (leader + member JSONL files). */
function transcriptRoot(): string {
  // Test/isolation override: keeps run artifacts (status.json + transcripts)
  // out of the real ~/.pi/agent/teams/runs during automated tests.
  const override = process.env.PI_AGENT_TEAM_RUNS_DIR;
  return override ? path.resolve(override) : path.join(getAgentDir(), "teams", "runs");
}

/** Transcript directories older than this are pruned on session start. */
const TRANSCRIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** First tokens owned by the /team sub-command router (anything else is a team name). */
const RESERVED_TEAM_COMMAND_NAMES = new Set(["run", "status", "stop", "view", "clear", "doctor"]);

/** Builds the guarded UI port over ctx.ui (repo TUI conventions). */
function uiPortFrom(ctx: ExtensionContext): UiPort {
  return {
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
          budget: resolveRunBudget(parsed.value.budget),
          transcript: new FileTranscriptSink(transcriptRoot(), runId),
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

function registerCockpitMode(pi: ExtensionAPI, opts: { spawn?: PiSpawn } = {}): void {
  const state: {
    coordinator: TeamRunCoordinator;
    cwd: string;
    projectTrusted: boolean;
    /** Below-editor run widget mounted once per session. */
    widgetMounted: boolean;
    widget: RunWidgetController | undefined;
    /** Host TUI instance captured from the widget factory (focus probe source). */
    tui: unknown;
    /** True while the transcript viewer overlay is open (widget key gate). */
    viewerOpen: boolean;
  } = {
    coordinator: new TeamRunCoordinator({
      cwd: () => state.cwd,
      worktreeRoot: worktreeRoot(),
      extensionEntryPath: extensionEntryPath(),
      transcriptRoot: transcriptRoot(),
      ...(opts.spawn ? { spawn: opts.spawn } : {}),
    }),
    cwd: process.cwd(),
    projectTrusted: false,
    widgetMounted: false,
    widget: undefined,
    tui: undefined,
    viewerOpen: false,
  };

  const resolveTeam = (name: string): { ok: true; value: TeamConfig } | { ok: false; message: string } => {
    const found = findTeam({
      cwd: state.cwd,
      scope: state.projectTrusted ? "both" : "global",
      name,
    });
    return found.ok ? { ok: true, value: found.value } : { ok: false, message: found.message };
  };

  /**
   * Viewer 直接对话（派单语义）：FIFO 队列 + 链式派出门控（chat.ts，纯逻辑
   * 层）。startRun 包装 startBackgroundRun（含 model 预检与 widget 复挂）；
   * contextTail 在派出时刻从当前/最近 run 的 transcript 现读（不随消息缓
   * 存）。队列驻留在本闭包内，不落盘——会话重启丢队列可接受。
   */
  const chat = new ChatCoordinator({
    resolveTeam: (name) => resolveTeam(name),
    isRunning: () => state.coordinator.isRunning(),
    startRun: (sessionCtx, team, task) => {
      const ui = uiPortFrom(sessionCtx as ExtensionContext);
      const started = startBackgroundRun(sessionCtx as ExtensionContext, ui, team, task);
      return started.ok ? { ok: true, runId: started.runId } : { ok: false, code: started.code, message: started.message };
    },
    contextTail: (actor) => {
      const snapshot = state.coordinator.getStatus();
      const runId = snapshot.progress?.runId ?? snapshot.lastRecord?.runId ?? "";
      if (!runId) return "";
      return transcriptContextTail(readTranscript(transcriptRoot(), runId, actor));
    },
  });

  /**
   * Loads the viewer model for the current/most recent run: leader first,
   * then members (status from live progress or the last record), then any
   * extra transcript files. Transcripts are read per actor on each load —
   * the viewer refreshes on a timer, so this stays live while a run works.
   */
  const buildViewerData = (): ViewerData => {
    const snapshot = state.coordinator.getStatus();
    const progress = snapshot.progress;
    const lastRecord = snapshot.lastRecord;
    const runId = progress?.runId ?? lastRecord?.runId ?? "";
    const runStatus = progress ? "running" : (lastRecord?.status ?? "unknown");
    const elapsed = progress
      ? (() => {
          const totalSecs = Math.max(0, Math.round((Date.now() - progress.startedAtMs) / 1000));
          const mins = Math.floor(totalSecs / 60);
          return mins > 0 ? `${mins}m${totalSecs % 60}s` : `${totalSecs}s`;
        })()
      : undefined;

    const memberStatuses = new Map<string, string>();
    if (progress) for (const member of progress.members) memberStatuses.set(member.name, member.status);
    else if (lastRecord) for (const member of lastRecord.members) memberStatuses.set(member.name, member.status);

    const actors: ViewerActor[] = [
      { actor: LEADER_ACTOR, label: "leader", status: progress ? "running" : lastRecord?.status },
    ];
    for (const [name, status] of memberStatuses) {
      actors.push({ actor: sanitizeActorName(name), label: name, status });
    }
    for (const fileActor of listTranscriptActors(transcriptRoot(), runId)) {
      if (fileActor === LEADER_ACTOR) continue;
      if (!actors.some((a) => a.actor === fileActor)) actors.push({ actor: fileActor, label: fileActor });
    }
    // Stable roster order: the leader stays first, everyone else sorts by
    // actor id. Progress/record/file sources arrive in different orders
    // (dispatch history vs. alphabetical file listing); without this the
    // roster rows shift after each dispatch and index-kept selections jump.
    // Selection itself is pinned by actor id (viewer.ts), this only fixes order.
    const [leader, ...rest] = actors;
    if (leader !== undefined) {
      rest.sort((a, b) => a.actor.localeCompare(b.actor));
      actors.length = 0;
      actors.push(leader, ...rest);
    }

    const entries = new Map<string, TranscriptEntry[]>();
    if (runId) {
      for (const actor of actors) entries.set(actor.actor, readTranscript(transcriptRoot(), runId, actor.actor));
    }
    return { team: progress?.team ?? lastRecord?.team ?? "(unknown)", runId, runStatus, elapsed, actors, entries };
  };

  /**
   * Opens the transcript viewer overlay: gates the widget's key handling
   * AND pauses its 1s repaint loop (hiding the below-editor block) so the
   * open overlay repaints against a still main screen. Restores both on
   * close. Every step is exception-isolated — widget failures never break
   * the viewer.
   */
  const openViewer = async (ctx: ExtensionContext, initialActor?: string): Promise<void> => {
    // 互斥：连点 enter（widget confirm）或在 viewer 打开时再敲 /team view
    // 会开出第二个 overlay，上一个不消失——标题+页签成双成对堆叠。fleet
    // 检查器同样只认单实例（`fleetInspectorOpen`），这里直接 early-return。
    if (state.viewerOpen) return;
    state.viewerOpen = true;
    try {
      state.widget?.setPaused(true);
    } catch {
      /* widget failures never break the session */
    }
    try {
      await openTranscriptViewer(ctx.ui, {
        load: buildViewerData,
        ...(initialActor !== undefined ? { initialActor } : {}),
        stop: () => viewerStopAndClearChat(),
        onMessage: (target, message) =>
          chatSubmitNotice(
            chat.submit(
              {
                teamName: buildViewerData().team,
                ctx,
                notify: (text, level) => uiPortFrom(ctx).notify(text, level),
              },
              { actor: target.actor, label: target.label, isLeader: target.actor === LEADER_ACTOR },
              message,
            ),
            target.label,
          ),
      });
    } finally {
      state.viewerOpen = false;
      try {
        state.widget?.setPaused(false);
      } catch {
        /* widget failures never break the session */
      }
    }
  };

  /**
   * Viewer 停止动作 + 对话队列清理：停止成功（非 error notice）时丢弃队列
   * 内排队的消息（用户变卦语义，与 team_stop / /team stop 一致），丢弃条
   * 数追加进 notice 文案。
   */
  const viewerStopAndClearChat = async (): Promise<ViewerStopResult> => {
    const result = await viewerStopAction(state.coordinator);
    if (result.kind === "error") return result;
    const dropped = chat.clear();
    return dropped > 0 ? { ...result, text: `${result.text}；已丢弃排队的 ${dropped} 条对话消息` } : result;
  };

  /**
   * Mounts the below-editor run widget (idempotent per session): a 1s
   * string[] setWidget loop plus (when the host exposes it) a
   * `ctx.ui.onTerminalInput` hook for the modal selection.
   * PI_AGENT_TEAM_WIDGET=0 disables it entirely (rendering diagnostics).
   */
  const ensureRunWidget = (ctx: ExtensionContext): void => {
    if (process.env.PI_AGENT_TEAM_WIDGET === "0") return;
    if (state.widgetMounted || !ctx.hasUI || ctx.mode !== "tui") return;
    try {
      // 一次性捕获宿主 TUI 供焦点门控（factory 由宿主同步调用，见
      // interactive-mode setExtensionWidget）。widget 本身仍用 string[]
      // 渲染（差异表 §3.1）；空组件在 controller 首帧（同步 refresh）即被
      // string[] 替换，宿主渲染是异步帧，无可见变化。捕获失败则焦点
      // 未知，controller 走降级语义（保持旧门控）。
      try {
        ctx.ui.setWidget(
          WIDGET_ID,
          (tui: unknown) => {
            state.tui = tui;
            return { render: () => [], invalidate: () => {} };
          },
          { placement: "belowEditor" },
        );
      } catch {
        /* 捕获失败：不阻断 widget 挂载 */
      }
      const controller = new RunWidgetController(
        {
          load: () => state.coordinator.getStatus(),
          styles: themeStyles(ctx.ui.theme),
          onConfirm: (actor) => {
            void openViewer(ctx, actor).catch(() => {
              /* opening failures never break the session */
            });
          },
          gate: () => state.viewerOpen,
          // 焦点=主编辑器才允许激活（对齐 fleet-status editorHasFocus）：
          // 宿主选择器/对话框（/login、/model…）打开时 widget 不让任何
          // 激活键；probe 返回 undefined（宿主无焦点信息）时 controller
          // 保持旧门控（仅编辑器为空）。
          editorFocus: () => probeEditorFocus(state.tui),
          // 空编辑器才允许 bare ↓/← 激活 widget（对齐 fleet-status
          // `getEditorText() === ""`）；宿主无 getEditorText 时省略该端口
          // → controller 降级为仅 alt 通道激活。
          ...(typeof ctx.ui.getEditorText === "function"
            ? { editorState: () => ({ text: ctx.ui.getEditorText() }) }
            : {}),
        },
        (lines) => {
          try {
            ctx.ui.setWidget(WIDGET_ID, lines, { placement: "belowEditor" });
          } catch {
            /* widget failures never break the session */
          }
        },
        (handler) => {
          const hookable = ctx.ui as {
            onTerminalInput?: (h: (data: string) => { consume?: boolean } | undefined) => (() => void) | void;
          };
          if (typeof hookable.onTerminalInput !== "function") return undefined;
          const remove = hookable.onTerminalInput((data) => {
            try {
              return handler(data);
            } catch {
              return undefined; /* key failures never break the session */
            }
          });
          return typeof remove === "function" ? remove : undefined;
        },
      );
      controller.start();
      state.widget = controller;
      state.widgetMounted = true;
    } catch {
      /* widget failures never break the session */
    }
  };

  /**
   * Model preflight before any spawn: unresolvable provider/id references
   * fail typed (MODEL_NOT_FOUND, nothing spawns); resolvable models without
   * configured auth pass with a ui warning. Without a host registry
   * (non-interactive contexts) there is nothing to check — pass through.
   */
  const runModelPreflight = (
    ctx: ExtensionContext,
    ui: UiPort,
    team: TeamConfig,
  ): { ok: true } | { ok: false; code: string; message: string } => {
    const lookup = modelLookupFrom((ctx as unknown as { modelRegistry?: unknown }).modelRegistry);
    if (!lookup) return { ok: true };
    const result = preflightTeamModels(team, lookup);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    for (const warning of result.warnings) ui.notify(warning, "warning");
    return { ok: true };
  };

  /**
   * Single terminal path for both delivery modes (async-first
   * unification): persists the run record, then either delivers the report
   * as a followUp turn (background) or produces the inline tool result
   * (wait:true). Shared so the two flows cannot drift.
   */
  const finalizeRun = (
    record: TeamRunRecord,
    ui: UiPort,
    delivery: "inline" | "followUp",
  ): { text: string; isError: boolean } => {
    appendRunRecord(pi as unknown as SessionPort, record);
    if (delivery === "followUp") {
      if (record.status === "completed") {
        const secs = Math.round((record.durationMs ?? 0) / 100) / 10;
        ui.notify(`team ${record.team} 完成 ✓（${secs}s，$${record.totalCost.toFixed(4)}）`, "info");
        deliverRunResult(pi as unknown as SessionPort, record.report ?? "(leader 未返回报告)");
      } else {
        ui.notify(
          `team ${record.team} ${record.status}: ${record.error ?? "已中止"}`,
          record.status === "aborted" ? "warning" : "error",
        );
      }
      return { text: "", isError: false };
    }
    if (record.status !== "completed") {
      return { text: `team run ${record.status}: ${record.error ?? "(no error detail)"}`, isError: record.status === "failed" };
    }
    return { text: record.report ?? "(leader 未返回报告)", isError: false };
  };

  /**
   * Background run flow shared by /team run and the team_run tool: fire and
   * forget — persists the record and delivers the final report as a
   * followUp turn so the user can keep talking to the main agent while the
   * team works. Returns immediately; RUN_IN_PROGRESS surfaces right away.
   */
  const startBackgroundRun = (
    ctx: ExtensionContext,
    ui: UiPort,
    team: TeamConfig,
    task: string,
  ): { ok: false; code: string; message: string } | { ok: true; team: string; members: number; runId: string } => {
    ensureRunWidget(ctx);
    const preflight = runModelPreflight(ctx, ui, team);
    if (!preflight.ok) {
      return { ok: false, code: preflight.code, message: preflight.message };
    }
    if (state.coordinator.isRunning()) {
      return { ok: false, code: "RUN_IN_PROGRESS", message: "另一个 team run 正在进行中；先 /team stop 或等它结束。" };
    }
    // start() claims the run synchronously, so the runId is readable right
    // after the call — the handle team_stop needs.
    const runPromise = state.coordinator.start({ team, task, ui });
    const runId = state.coordinator.activeRunId() ?? "";
    ui.notify(`team ${team.name} 已在后台启动（${team.members.length} 成员）。runId: ${runId}。完成后报告自动送达；期间可继续对话，/team status 或 team_status 查进度`, "info");
    // Completion still persists the record and wakes the session with the
    // report (followUp turn), then drives the viewer chat queue: completed
    // → chain-dispatch the next queued message; failed/aborted → drop it.
    void runPromise
      .then((result) => {
        if (!result.ok) {
          ui.notify(result.message, "error");
          chat.onRunFinalized("failed");
          return;
        }
        finalizeRun(result.value, ui, "followUp");
        chat.onRunFinalized(result.value.status);
      })
      .catch((e: unknown) => {
        ui.notify(`team run 异常退出: ${e instanceof Error ? e.message : String(e)}`, "error");
        chat.onRunFinalized("failed");
      });
    return { ok: true, team: team.name, members: team.members.length, runId };
  };

  /** Command-mode run flow (runs in BACKGROUND): persist, notify, deliver. */
  const runFromCommand = (ctx: ExtensionContext, teamName: string, task: string): void => {
    const ui = uiPortFrom(ctx);
    const found = resolveTeam(teamName);
    if (!found.ok) {
      ui.notify(found.message, "error");
      return;
    }
    const started = startBackgroundRun(ctx, ui, found.value, task);
    if (!started.ok) {
      ui.notify(started.message, "error");
    }
  };

  // -- Conversation tools -------------------------------------------------

  registerManageTools(pi);

  pi.registerTool({
    name: "team_run",
    label: "Run Agent Team",
    description:
      "把一个任务派给指定的 agent team：leader 会拆解任务并通过 team_dispatch 调度成员协同完成。默认后台运行、立即返回，最终报告完成后自动送达本会话（followUp），等待期间用户可继续对话；wait=true 时同步等待整个 run 结束并内联返回报告（阻塞主会话，不推荐）。同一团队可反复派单复用。",
    promptGuidelines: [
      "派单前先用 team_list 确认团队存在且成员配置合适；不确定时先问用户。",
      "task 要自包含：目标、范围、验收标准。成员和 leader 都看不到这段对话。",
      "默认（wait 省略）立即返回，报告稍后自动送达；等待期间正常回应用户其它消息，不要空转等待。",
    ],
    parameters: Type.Object({
      team: Type.String({ description: "团队名（可用 team_list 查询）" }),
      task: Type.String({ description: "任务描述（issue）" }),
      wait: Type.Optional(
        Type.Boolean({ description: "同步等待整个 run 完成并内联返回报告（阻塞主会话）。默认 false=后台运行", default: false }),
      ),
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
      const preflight = runModelPreflight(ctx, ui, found.value);
      if (!preflight.ok) {
        return {
          content: [{ type: "text" as const, text: preflight.message }],
          details: { code: preflight.code },
          isError: true,
        };
      }
      if (params.wait !== true) {
        // Default: background dispatch — the main agent's turn ends right
        // away so the user can keep talking; the report arrives later as a
        // followUp turn (same flow as /team run).
        const started = startBackgroundRun(ctx, ui, found.value, params.task);
        if (!started.ok) {
          return {
            content: [{ type: "text" as const, text: started.message }],
            details: { code: started.code },
            isError: started.code === "RUN_IN_PROGRESS" ? false : true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `team ${started.team} 已在后台启动（${started.members} 成员并行）。runId: ${started.runId}；报告完成后会自动送达本会话；期间可继续对话。用 team_status 查询进度（含 runId），team_stop 按 runId 中止。`,
            },
          ],
          details: { started: true, background: true, team: started.team, task: params.task, members: started.members, runId: started.runId },
        };
      }
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
      const outcome = finalizeRun(record, ui, "inline");
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        details: record,
        ...(outcome.isError ? { isError: true } : {}),
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

  // Transcript tool: the MAIN agent relays what a member actually did —
  // its conversation, tool calls, and errors — from the run artifacts.
  pi.registerTool({
    name: "team_transcript",
    label: "Team Member Transcript",
    description:
      "查看当前/最近一次 agent team run 中 leader 或指定成员的会话记录（对话、工具调用、错误）。用户想深入了解某个成员具体做了什么时调用。",
    promptGuidelines: [
      "member 传成员名；传 \"leader\" 查看 leader 的调度过程。可用成员名先看 team_status。",
      "记录可能很长：转述要点而不是全文粘贴。",
    ],
    parameters: Type.Object({
      member: Type.Optional(
        Type.String({ description: "成员名（leader 表示主控）；省略则查看 leader" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const data = buildViewerData();
      if (!data.runId) {
        return { content: [{ type: "text" as const, text: "当前没有 team run 记录。" }], details: {} };
      }
      const actor = params.member && params.member !== "leader" ? sanitizeActorName(params.member) : LEADER_ACTOR;
      const text = formatTranscriptText(data, actor);
      const body =
        text.startsWith("没有 ") && data.actors.length > 0
          ? `${text}\n可用的记录：${data.actors.map((a) => a.label).join("、")}`
          : text;
      return {
        content: [{ type: "text" as const, text: truncateUtf8(body, MAX_RESULT_BYTES) }],
        details: { actors: data.actors.map((a) => ({ actor: a.actor, label: a.label, status: a.status })) },
      };
    },
  });

  // Stop tool: the MAIN agent aborts a background run by runId (the same
  // primitive /team stop uses, plus a bounded settle wait so the agent gets
  // a terminal record instead of a phantom "running"). Only the cockpit
  // registers it — leader/member child processes never see team_stop.
  pi.registerTool({
    name: "team_stop",
    label: "Stop Agent Team Run",
    description:
      "按 runId 停止正在运行的 agent team run（leader 与所有成员子进程）。runId 必填，先 team_status 查看当前/最近 runId。停止后该 run 的报告 followUp 不再送达。",
    promptGuidelines: [
      "派单变卦/超预算/跑偏需要停止时：先 team_status 确认活动 run 与其 runId，再调本工具。",
      "runId 必填：省略返回 RUN_ID_REQUIRED；未知返回 RUN_NOT_FOUND；已结束返回 RUN_ALREADY_FINISHED（都不抛异常）。",
      "停止后收不到该 run 的报告 followUp，只会收到“已中止”通知；停止完成后可立即重新派单。",
    ],
    parameters: Type.Object({
      runId: Type.String({ description: "要停止的 runId（必填；用 team_status 查看当前/最近 runId）" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        return {
          content: [{ type: "text" as const, text: "runId 是必填参数：先用 team_status 查看当前/最近一次 run 的 runId。" }],
          details: { code: "RUN_ID_REQUIRED" },
          isError: true,
        };
      }
      const snapshot = state.coordinator.getStatus();
      const activeRunId = snapshot.progress?.runId ?? null;
      if (activeRunId === runId) {
        const outcome = await state.coordinator.stopAndSettle();
        const dropped = chat.clear();
        const droppedNote = dropped > 0 ? `已丢弃排队的 ${dropped} 条 viewer 对话消息。` : "";
        if (outcome.settled) {
          const record = outcome.record;
          const secs = record?.durationMs !== undefined ? `（${Math.round(record.durationMs / 100) / 10}s）` : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `run ${runId}（team ${record?.team ?? "?"}）已停止${secs}，状态 aborted。该 run 的报告不再送达；可立即重新派单。${droppedNote}`,
              },
            ],
            details: {
              stopped: true,
              settled: true,
              runId,
              team: record?.team ?? "",
              status: "aborted",
              ...(record ? { record } : {}),
            },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `已向 run ${runId} 发送中止信号，leader 仍在收尾（超过 ${Math.round(STOP_SETTLE_TIMEOUT_MS / 1000)}s 等待窗口未落定）。稍后用 team_status 确认终态。${droppedNote}`,
            },
          ],
          details: {
            stopped: true,
            settled: false,
            runId,
            team: snapshot.progress?.team ?? "",
            status: "aborted",
          },
        };
      }
      if (snapshot.lastRecord?.runId === runId) {
        return {
          content: [{ type: "text" as const, text: `run ${runId} 已经结束（${snapshot.lastRecord.status}），无需停止。` }],
          details: { code: "RUN_ALREADY_FINISHED", status: snapshot.lastRecord.status },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `没有找到 runId ${runId}。当前/最近的 runId 用 team_status 查看；已结束的历史 run 无法停止。`,
          },
        ],
        details: { code: "RUN_NOT_FOUND" },
        isError: true,
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

  /** `/team`（无参）：列出所有 agent team（团队/成员/模型）。 */
  const listTeams = (ctx: ExtensionContext): void => {
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
    for (const team of teams) {
      lines.push(...teamSummaryLines(team));
      if (RESERVED_TEAM_COMMAND_NAMES.has(team.name)) {
        lines.push(`⚠ 团队名与内置子命令同名；派单请用 /team run ${team.name} <任务>`);
      }
      lines.push("");
    }
    for (const bad of invalid) lines.push(`⚠ ${bad.file} — ${bad.message}`);
    ui.notify(lines.join("\n"), "info");
  };

  /** `/team run <团队名> <任务>`：显式派单（团队名撞保留词时的唯一入口）。 */
  const startRunFromArgs = (ctx: ExtensionContext, args: string): void => {
    const trimmed = args.trim();
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex <= 0 || trimmed.slice(spaceIndex + 1).trim().length === 0) {
      uiPortFrom(ctx).notify("用法：/team run <团队名> <任务描述>", "warning");
      return;
    }
    const teamName = trimmed.slice(0, spaceIndex);
    const task = trimmed.slice(spaceIndex + 1).trim();
    runFromCommand(ctx, teamName, task);
  };

  /** `/team status`：当前/最近一次 run 的状态。 */
  const showRunStatus = (ctx: ExtensionContext): void => {
    uiPortFrom(ctx).notify(statusText(ctx), "info");
  };

  /** `/team stop`：中止当前 run（leader 与所有成员）。 */
  const stopRun = (ctx: ExtensionContext): void => {
    const ui = uiPortFrom(ctx);
    if (state.coordinator.stop()) {
      const dropped = chat.clear();
      ui.notify(dropped > 0 ? `已发送中止信号（SIGTERM → SIGKILL）；已丢弃排队的 ${dropped} 条 viewer 对话消息` : "已发送中止信号（SIGTERM → SIGKILL）", "warning");
    } else {
      ui.notify("当前没有正在进行的 team run", "info");
    }
  };

  /** `/team view`：全屏查看当前/最近一次 run 的成员会话记录（实时）。 */
  const showRunViewer = async (ctx: ExtensionContext): Promise<void> => {
    const ui = uiPortFrom(ctx);
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ui.notify("会话记录查看器仅在交互式 TUI 中可用。", "warning");
      return;
    }
    const snapshot = state.coordinator.getStatus();
    if (!snapshot.progress && !snapshot.lastRecord) {
      ui.notify("当前没有 team run 记录。用 /team run <团队> <任务> 派单后即可查看。", "info");
      return;
    }
    try {
      await openViewer(ctx);
    } catch (e) {
      ui.notify(`打开会话记录查看器失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  /** `/team clear`：清除输入栏下方的 team run 亮块。 */
  const clearRunBlock = (ctx: ExtensionContext): void => {
    const ui = uiPortFrom(ctx);
    if (state.coordinator.isRunning()) {
      ui.notify("team run 进行中；先 /team stop 或等它结束再清除。", "warning");
      return;
    }
    if (!state.widgetMounted) {
      ui.notify("下方没有 team run 亮块。", "info");
      return;
    }
    try {
      state.widget?.stop();
    } catch {
      /* widget failures never break the session */
    }
    state.widget = undefined;
    state.widgetMounted = false;
    clearWidget(ctx);
    const dropped = chat.clear();
    ui.notify(dropped > 0 ? `已清除下方亮块与排队的 ${dropped} 条对话消息；/team status、/team view 仍可回看。` : "已清除下方亮块；/team status、/team view 仍可回看。", "info");
  };

  /** `/team doctor`：自检报告。 */
  const showDoctor = async (ctx: ExtensionContext): Promise<void> => {
    const ui = uiPortFrom(ctx);
    const registry = (ctx as unknown as {
      modelRegistry?: { refresh?: () => Promise<void>; getError?: () => string | undefined };
    }).modelRegistry;
    if (registry?.refresh) {
      try {
        await registry.refresh();
      } catch {
        /* refresh is best-effort */
      }
    }
    let gitRepo = false;
    try {
      gitRepo = await isGitRepo(defaultGitRunner(), state.cwd);
    } catch {
      gitRepo = false;
    }
    const report = buildDoctorReport(
      {
        mode: "cockpit",
        cwd: state.cwd,
        projectTrusted: state.projectTrusted,
        scope: state.projectTrusted ? "both" : "global",
        widgetEnabled: process.env.PI_AGENT_TEAM_WIDGET !== "0",
        ...(registry?.getError ? { registryError: registry.getError() } : {}),
        runsRoot: transcriptRoot(),
        worktreeRoot: worktreeRoot(),
      },
      { isGitRepo: () => gitRepo },
    );
    ui.notify(report, "info");
  };

  /**
   * 统一 `/team` 命令（命令风格统一：子命令式）。首 token 是保留词 → 子命令；
   * 否则视为团队名 → `/team <团队名> <任务>` 直接派单。撞保留词的团队名走
   * 显式 `/team run <名> <任务>`（列表文案会提示）。
   */
  pi.registerCommand("team", {
    description:
      "agent team：无参列出团队；/team run <团队> <任务> 派单；/team <团队> <任务> 直接派单；子命令 status|stop|view|clear|doctor",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        listTeams(ctx);
        return;
      }
      const spaceIndex = trimmed.indexOf(" ");
      const head = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
      const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
      if (!RESERVED_TEAM_COMMAND_NAMES.has(head)) {
        if (!rest) {
          uiPortFrom(ctx).notify(`用法：/team ${head} <任务描述>`, "warning");
          return;
        }
        runFromCommand(ctx, head, rest);
        return;
      }
      switch (head) {
        case "run":
          startRunFromArgs(ctx, rest);
          return;
        case "status":
          showRunStatus(ctx);
          return;
        case "stop":
          stopRun(ctx);
          return;
        case "view":
          await showRunViewer(ctx);
          return;
        case "clear":
          clearRunBlock(ctx);
          return;
        default: // doctor — RESERVED_TEAM_COMMAND_NAMES is exactly the sub-command set
          await showDoctor(ctx);
      }
    },
  });

  // -- Session lifecycle --------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    state.cwd = ctx.cwd;
    state.projectTrusted = ctx.isProjectTrusted();
    state.viewerOpen = false;
    state.widget?.stop();
    state.widget = undefined;
    state.widgetMounted = false;
    clearWidget(ctx);

    // Hydrate the most recent run record so /team status works after reload.
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

    // Crash recovery: stale `running` status files left by a previous
    // session (main session died mid-run) are reconciled into failed
    // records — report only, the possibly-orphaned leader process is
    // NEVER killed here (PID reuse risk; the diagnostic tells the user
    // what to check).
    try {
      // Runs still claimed by this coordinator (e.g. a mid-run re-bind) are
      // live and must not be reconciled away.
      const inMemoryRunIds = new Set<string>();
      const activeRunId = state.coordinator.activeRunId();
      if (activeRunId) inMemoryRunIds.add(activeRunId);
      const stale = reconcileStaleRuns({
        root: transcriptRoot(),
        inMemoryRunIds,
        now: () => new Date().toISOString(),
      });
      for (const run of stale) {
        const record: TeamRunRecord = {
          runId: run.runId,
          team: run.team,
          task: run.task,
          startedAt: run.startedAt,
          status: "failed",
          error: orphanRunError(run.leaderPid),
          members: [],
          totalCost: 0,
          totalTokens: 0,
        };
        state.coordinator.restoreLastRecord(record);
        uiPortFrom(ctx).notify(
          `发现上次会话残留的未终态 run：team ${run.team}（runId ${run.runId}）已标记为 failed。${record.error}`,
          "warning",
        );
      }
    } catch {
      /* reconcile is best-effort */
    }

    // Below-editor run widget: only mount right away when hydration found a
    // STILL-RUNNING run. A terminal record hydrates /team status and
    // /team view paths but must not re-mount the below-editor block on every
    // /reload — the user cleared it with /team clear for a reason. The next
    // dispatch remounts it (startBackgroundRun → ensureRunWidget).
    const snapshot = state.coordinator.getStatus();
    if (snapshot.running) ensureRunWidget(ctx);

    // Best-effort retention: drop transcript artifact dirs older than a week.
    try {
      pruneOldTranscripts(transcriptRoot(), Date.now(), TRANSCRIPT_RETENTION_MS);
    } catch {
      /* pruning is best-effort */
    }

    // 动态 per-team 命令已退役（命令风格统一）：非保留词首 token 的
    // `/team <团队名> <任务>` 由统一路由器现场解析，团队增删无需注册命令。
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.coordinator.stop();
    state.widget?.stop();
    state.widget = undefined;
    clearWidget(ctx);
  });

  // Run record entry card (collapsed one-liner, expanded detail).
  pi.registerEntryRenderer(RUN_ENTRY_TYPE, createRunEntryRenderer());
}

// ---------------------------------------------------------------------------

/**
 * Double-load guard: the same extension can reach one process twice (e.g.
 * installed as a git package AND passed via `-e`, which is exactly how the
 * cockpit spawns the leader child). pi treats the copies as different
 * extensions and fails on duplicate tool names, so the first instance wins
 * and later ones become no-ops.
 *
 * 复位时机 = session_shutdown：pi 宿主保证在重新绑定扩展（/reload、new、
 * resume、fork、switch）之前必先发 session_shutdown，因此在这里删掉标志，
 * 下一次 factory 调用就能重新注册（修复 /reload 后 team 工具全部消失）。
 * 同一进程生命周期内的真双加载（两份之间没有 shutdown）依旧被抑制。
 */
const LOADER_FLAG = "__piAgentTeamExtensionLoaded";

export default function agentTeamExtension(pi: ExtensionAPI, opts?: { spawn?: PiSpawn }): void {
  const loader = globalThis as { [LOADER_FLAG]?: boolean };
  if (loader[LOADER_FLAG]) return;
  loader[LOADER_FLAG] = true;

  // 复位双加载守卫：宿主在重绑扩展前必发 session_shutdown（见上方注释）。
  // delete 对不存在的键是 no-op，不可能抛异常。
  pi.on("session_shutdown", async () => {
    delete loader[LOADER_FLAG];
  });

  const teamFile = process.env[LEADER_ENV_FILE];
  if (teamFile) {
    registerLeaderMode(pi, teamFile);
    return;
  }
  registerCockpitMode(pi, opts);
}

/** Test seam: clears the double-load guard (the flag lives on globalThis). */
export function resetDoubleLoadGuardForTests(): void {
  delete (globalThis as { [LOADER_FLAG]?: boolean })[LOADER_FLAG];
}

/** Minimal structural view of the coordinator a viewer stop needs. */
interface ViewerStopCoordinator {
  getStatus(): {
    progress: { runId: string } | null;
    lastRecord: { status: string; runId: string } | null;
  };
  stopAndSettle(): Promise<{ settled: boolean; record: { durationMs?: number } | null }>;
}

/**
 * Viewer 停止动作（D 确认后注入 TranscriptViewer 的 stop 回调）：与
 * team_stop 工具共用 stopAndSettle 语义，结果映射为 viewer 顶部 notice
 * 文案（settled → success、未落定 → warning、异常 → error，绝不上抛）。
 * 导出仅为测试（同 resetDoubleLoadGuardForTests 惯例）。
 */
export async function viewerStopAction(coordinator: ViewerStopCoordinator): Promise<ViewerStopResult> {
  const snapshot = coordinator.getStatus();
  if (!snapshot.progress) {
    return {
      text: snapshot.lastRecord ? `run 已结束（${snapshot.lastRecord.status}），无需停止` : "当前没有正在运行的 run，无需停止",
      kind: "error",
    };
  }
  try {
    const outcome = await coordinator.stopAndSettle();
    if (outcome.settled) {
      const secs = outcome.record?.durationMs !== undefined ? ` · ${Math.round(outcome.record.durationMs / 100) / 10}s` : "";
      return { text: `run 已停止（aborted${secs}）；该 run 的报告不再送达`, kind: "success" };
    }
    return { text: "已发送中止信号，leader 仍在收尾；稍后用 /team status 确认终态", kind: "warning" };
  } catch {
    return { text: "停止失败；稍后用 /team stop 重试", kind: "error" };
  }
}
