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
import { archiveRunRecords } from "./archive.ts";
import { askLeaderQuestion, formatAskResult, type AskPort, type AskToolOutcome } from "./ask.ts";
import { discoverTeams, findTeam, parseTeamFile, splitModelThinking } from "./config.ts";
import { createDispatchExecutor, parseDispatchRequest } from "./dispatch.ts";
import { resolveExternalCli } from "./external.ts";
import { ChatCoordinator, chatSubmitNotice, transcriptContextTail } from "./chat.ts";
import { buildDoctorReport } from "./doctor.ts";
import { registerManageTools, teamSummaryLines } from "./manage.ts";
import { resolveModelCaliber } from "./model-caliber.ts";
import { TeamRunCoordinator, failedRunRecord, formatStatusSnapshot, type ResumeContext, type UiPort } from "./cockpit.ts";
import { modelLookupFrom, preflightTeamModels } from "./preflight.ts";
import {
  buildResumePrompt,
  findRunStatus,
  parseMemberModelEnv,
  resolveEffectiveTeam,
  resolveResumeSessionFile,
  resumeEligibility,
  type ModelOverrides,
} from "./resume.ts";
import { defaultIsProcessAlive, orphanRunError, reconcileStaleRuns, type RunStatusFile } from "./runstore.ts";
import { appendRunRecord, createRunEntryRenderer, deliverRunResult, formatFailureNotice, type SessionPort } from "./session.ts";
import { RunWidgetController, probeEditorFocus } from "./widget.ts";
import { activityFromTranscript, formatActorActivity, formatTranscriptText, openTranscriptViewer, themeStyles, type ViewerActor, type ViewerData, type ViewerStopResult } from "./viewer.ts";
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
  ASK_TIMEOUT_DEFAULT_MS,
  ASK_TOOL_NAME,
  LEADER_ENV_FILE,
  LEADER_ENV_MEMBER_MODELS,
  LEADER_ENV_NAME,
  LEADER_ENV_RUNID,
  LEADER_ENV_WORKTREE_RUNID,
  MAX_RESULT_BYTES,
  RUN_ENTRY_TYPE,
  STOP_SETTLE_TIMEOUT_MS,
  WIDGET_ID,
  resolveRunBudget,
  truncateUtf8,
  type ExternalBackend,
  type ExternalCliResolveResult,
  type PiSpawn,
  type TeamConfig,
  type TeamErrorCode,
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

/**
 * 冒号命令面（v1.12.0）：每个子命令一条独立静态命令，派单统一走
 * `/team:run <团队名> <任务>`，团队名可与任意子命令同名。
 */
export const TEAM_COMMAND_NAMES = {
  list: "team:list",
  run: "team:run",
  resume: "team:resume",
  status: "team:status",
  stop: "team:stop",
  view: "team:view",
  clear: "team:clear",
  doctor: "team:doctor",
} as const;

/**
 * 旧空格子命令 → 新命令 + 用法。裸 `/team` 命中时只提示改名、绝不执行
 * （防止 `/team clear` 被误当清除、`/team run` 被误当派单）。
 */
export const RETIRED_TEAM_SUBCOMMANDS: Record<string, { command: string; usage: string }> = {
  list: { command: TEAM_COMMAND_NAMES.list, usage: "/team:list" },
  run: { command: TEAM_COMMAND_NAMES.run, usage: "/team:run <团队名> <任务描述>" },
  status: { command: TEAM_COMMAND_NAMES.status, usage: "/team:status" },
  stop: { command: TEAM_COMMAND_NAMES.stop, usage: "/team:stop" },
  view: { command: TEAM_COMMAND_NAMES.view, usage: "/team:view" },
  clear: { command: TEAM_COMMAND_NAMES.clear, usage: "/team:clear" },
  doctor: { command: TEAM_COMMAND_NAMES.doctor, usage: "/team:doctor" },
};

/** 裸 `/team` 带参（且非旧子命令名）时的用法提示。 */
export const TEAM_USAGE = [
  "用法：",
  "  /team                    列出全部团队",
  "  /team:list               列出全部团队",
  "  /team:run <团队> <任务>  后台派单",
  "  /team:resume <runId> [补充指示]  续跑 failed/aborted 的 run（沿用原会话与 worktree；换模型走 team_resume 工具）",
  "  /team:status             查看当前/最近 run 状态",
  "  /team:stop               中止当前 run",
  "  /team:view               打开全屏会话记录查看器",
  "  /team:clear              丢弃排队的 viewer 对话消息（亮块随 run 结束自动隐藏）",
  "  /team:doctor             自检报告",
].join("\n");

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

/**
 * Builds the leader-question port over the main session's ctx.ui: the RPC
 * dialog bridge presents the leader's question as a host dialog and returns
 * the answer. Fail-closed — no UI, stale ctx, host errors and blank answers
 * all degrade to cancelled so the leader never blocks on an impossible ask.
 */
function askPortFrom(ctx: ExtensionContext): AskPort {
  return {
    async present(request, signal) {
      try {
        if (!ctx.hasUI) return { kind: "unavailable" };
        const opts = { ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}), signal };
        if (request.method === "select") {
          const value = await ctx.ui.select(request.title, request.options ?? [], opts);
          return typeof value === "string" && value.trim().length > 0
            ? { kind: "answer", value }
            : { kind: "cancelled" };
        }
        if (request.method === "confirm") {
          return { kind: "answer", value: await ctx.ui.confirm(request.title, request.message ?? "", opts) };
        }
        if (request.method === "editor") {
          // ctx.ui.editor has no timeout/signal options; the channel backstop
          // still bounds the wait from the leader's side.
          const value = await ctx.ui.editor(request.title, request.prefill);
          return typeof value === "string" && value.trim().length > 0
            ? { kind: "answer", value }
            : { kind: "cancelled" };
        }
        const value = await ctx.ui.input(request.title, request.placeholder, opts);
        return typeof value === "string" && value.trim().length > 0
          ? { kind: "answer", value }
          : { kind: "cancelled" };
      } catch {
        return { kind: "cancelled" };
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

/**
 * Injection seams for the two OS boundaries (existing `{spawn}` convention):
 * child-process spawn and external CLI resolution.
 */
export interface AgentTeamExtensionOptions {
  spawn?: PiSpawn;
  /** Defaults to external.ts's real PATH probe; tests inject a fake resolver. */
  resolveExternalCli?: (backend: ExternalBackend) => ExternalCliResolveResult;
}

function registerLeaderMode(pi: ExtensionAPI, teamFile: string, opts: AgentTeamExtensionOptions = {}): void {
  let content: string | null = null;
  try {
    content = fs.readFileSync(teamFile, "utf-8");
  } catch {
    content = null;
  }
  const parsed = content !== null ? parseTeamFile(content, { filePath: teamFile, source: "global" }) : undefined;
  const runId = process.env[LEADER_ENV_RUNID] || `run-${Date.now()}`;
  // 续跑：成员树别名到父 run，成员模型覆盖来自 cockpit 注入的 env（JSON）。
  // 坏 JSON 不是错误——声明模型照常生效（parseMemberModelEnv 内部隔离）。
  const worktreeRunId = process.env[LEADER_ENV_WORKTREE_RUNID] || undefined;
  const memberOverrides = parseMemberModelEnv(process.env[LEADER_ENV_MEMBER_MODELS]);

  // One executor per leader process: it carries the per-run dispatch budget
  // across calls. The leader child's process cwd IS the run cwd (the
  // coordinator spawned us there — shared worktree or base directory).
  const executor =
    parsed && parsed.ok
      ? createDispatchExecutor({
          team: resolveEffectiveTeam(parsed.value, { memberModels: memberOverrides }).team,
          cwd: process.cwd(),
          worktreeRoot: worktreeRoot(),
          runId,
          ...(worktreeRunId !== undefined ? { worktreeRunId } : {}),
          killGraceMs: 5000,
          budget: resolveRunBudget(parsed.value.budget),
          transcript: new FileTranscriptSink(transcriptRoot(), runId),
          ...(opts.spawn ? { spawn: opts.spawn } : {}),
          resolveExternalCli: opts.resolveExternalCli ?? resolveExternalCli,
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

  // Leader → human questions: the child runs in `--mode rpc`, so ctx.ui
  // dialogs surface as extension_ui_request lines the cockpit answers over
  // stdin. Every wait is bounded (tool floor/ceiling + cockpit backstop),
  // and an unanswered question is a normal tool result (never an error) so
  // the leader proceeds on its own judgment instead of retrying.
  const teamName = parsed && parsed.ok ? parsed.value.name : process.env[LEADER_ENV_NAME] || "team";
  pi.registerTool({
    name: ASK_TOOL_NAME,
    label: "Team Ask",
    description:
      "向用户（主会话）提问并阻塞等待回答：需求有歧义、需要人类拍板、或影响结果的假设无法自行判断时使用。不传 options 为自由文本输入，传 options（2~10 项）为选项选择。超时/被取消/主会话无 UI 时返回“未获回答”，据此继续任务并在报告中说明假设。",
    parameters: Type.Object({
      question: Type.String({ description: "要问用户的问题：写清上下文、影响与期望（用户看不到你与成员的对话，必须自包含）" }),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description: "提供选项时向用户呈现选择列表（2~10 项）；省略则请求自由文本",
          minItems: 2,
          maxItems: 10,
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "等待回答的超时（毫秒），默认 600000（10 分钟），范围 30000~1800000",
          default: ASK_TIMEOUT_DEFAULT_MS,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let outcome: AskToolOutcome;
      try {
        outcome = await askLeaderQuestion(
          ctx.ui,
          teamName,
          {
            question: params.question,
            ...(params.options ? { options: params.options } : {}),
            ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
          },
          signal,
        );
      } catch {
        // ctx.ui access itself can throw on a stale context — fail closed.
        outcome = { answered: false };
      }
      const result = formatAskResult(outcome);
      return { content: [{ type: "text" as const, text: result.text }], details: result.details };
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

function registerCockpitMode(pi: ExtensionAPI, opts: AgentTeamExtensionOptions = {}): void {
  const resolveCli = opts.resolveExternalCli ?? resolveExternalCli;
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
    // run 运行中且目标是 leader：RPC steer 插话（不打断任务）；失败或
    // 目标是成员时回退到队列/派单语义（chat.ts）。
    steerLeader: (message) => state.coordinator.steerLeader(message),
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
    // 一次刷新一个时钟：elapsed 与活动行分桶同源（同一 nowMs）。
    const nowMs = Date.now();
    const elapsed = progress
      ? (() => {
          const totalSecs = Math.max(0, Math.round((nowMs - progress.startedAtMs) / 1000));
          const mins = Math.floor(totalSecs / 60);
          return mins > 0 ? `${mins}m${totalSecs % 60}s` : `${totalSecs}s`;
        })()
      : undefined;

    const memberStatuses = new Map<string, string>();
    const memberModels = new Map<string, string>();
    const memberThinking = new Map<string, string>();
    // Live 成员活动（v1.17.0），按 actor id（sanitizeActorName）键控。
    const memberActivity = new Map<
      string,
      { phase?: "tool" | "waiting"; toolName?: string; lastActivityAtMs?: number }
    >();
    if (progress) {
      for (const member of progress.members) {
        memberStatuses.set(member.name, member.status);
        // live 成员：progress.model 在派发结果到达后被覆盖为「声明 provider
        // 前缀 + 实际上报 id」（cockpit 侧归一）；此处对未派发成员兜底归一。
        const model = resolveModelCaliber(member.model);
        if (model) memberModels.set(member.name, model);
        if (member.thinkingLevel) memberThinking.set(member.name, member.thinkingLevel);
        if (member.phase !== undefined || member.toolName !== undefined || member.lastActivityAtMs !== undefined) {
          memberActivity.set(sanitizeActorName(member.name), {
            ...(member.phase !== undefined ? { phase: member.phase } : {}),
            ...(member.toolName !== undefined ? { toolName: member.toolName } : {}),
            ...(member.lastActivityAtMs !== undefined ? { lastActivityAtMs: member.lastActivityAtMs } : {}),
          });
        }
      }
    } else if (lastRecord) {
      for (const member of lastRecord.members) {
        memberStatuses.set(member.name, member.status);
        // 声明 provider 前缀 + 子进程实际上报 id（无声明/无实际各有规则）。
        const model = resolveModelCaliber(member.model, member.usage?.model);
        if (model) memberModels.set(member.name, model);
        // 思考级别同口径：实际上报值优先，回退声明模型后缀。
        const thinkingLevel = member.usage?.thinkingLevel ?? splitModelThinking(member.model).thinkingLevel;
        if (thinkingLevel) memberThinking.set(member.name, thinkingLevel);
      }
    }
    // live leader：声明值（启动时进 progress）+ 实际上报裸 id 组合；
    // 终态回退：record 的声明值 + leaderUsage 实际上报值。
    const leaderModel = progress
      ? resolveModelCaliber(progress.leaderDeclaredModel, progress.leaderModel)
      : resolveModelCaliber(lastRecord?.leaderDeclaredModel, lastRecord?.leaderUsage?.model);
    const leaderThinkingLevel =
      progress?.leaderThinkingLevel ?? lastRecord?.leaderThinkingLevel ?? lastRecord?.leaderUsage?.thinkingLevel;

    const actors: ViewerActor[] = [
      {
        actor: LEADER_ACTOR,
        label: "leader",
        status: progress ? "running" : lastRecord?.status,
        ...(leaderModel ? { model: leaderModel } : {}),
        ...(leaderThinkingLevel ? { thinkingLevel: leaderThinkingLevel } : {}),
      },
    ];
    for (const [name, status] of memberStatuses) {
      const model = memberModels.get(name);
      const thinkingLevel = memberThinking.get(name);
      actors.push({
        actor: sanitizeActorName(name),
        label: name,
        status,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
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
    // 活动行烘焙（v1.17.0）：live progress 阶段优先；缺省时从 transcript 末条
    // 推导（回放/文件-only actor）。时长经 5s 分桶后才能进 activity
    // （fingerprint 含该文本——重影约束：时钟类文本不得超过每桶一次重绘）。
    const running = runStatus === "running";
    for (const actor of actors) {
      const liveMember = memberActivity.get(actor.actor);
      const isLeader = actor.actor === LEADER_ACTOR;
      let phase = isLeader ? progress?.leaderPhase : liveMember?.phase;
      let toolName = isLeader ? progress?.leaderToolName : liveMember?.toolName;
      let lastActivityAtMs = isLeader ? progress?.leaderLastEventAtMs : liveMember?.lastActivityAtMs;
      if (running && phase === undefined && lastActivityAtMs === undefined) {
        const derived = activityFromTranscript(entries.get(actor.actor) ?? []);
        if (derived.phase !== undefined) phase = derived.phase;
        if (derived.toolName !== undefined) toolName = derived.toolName;
        if (derived.lastActivityAtMs !== undefined) lastActivityAtMs = derived.lastActivityAtMs;
      }
      if (phase !== undefined) actor.phase = phase;
      if (toolName !== undefined) actor.toolName = toolName;
      if (lastActivityAtMs !== undefined) actor.lastActivityAtMs = lastActivityAtMs;
      actor.activity = formatActorActivity(
        {
          status: actor.status,
          ...(phase !== undefined ? { phase } : {}),
          ...(toolName !== undefined ? { toolName } : {}),
          ...(lastActivityAtMs !== undefined ? { lastActivityAtMs } : {}),
        },
        running,
        nowMs,
      );
    }
    // 续跑 lineage（v1.21.0）：viewer 右栏 Run: 行展示「续跑自 …」。
    const parentRunId = progress?.parentRunId ?? lastRecord?.parentRunId;
    return {
      team: progress?.team ?? lastRecord?.team ?? "(unknown)",
      runId,
      ...(parentRunId ? { parentRunId } : {}),
      runStatus,
      elapsed,
      actors,
      entries,
    };
  };

  /**
   * Opens the transcript viewer overlay: gates the widget's key handling
   * AND pauses its 1s repaint loop (hiding the below-editor block) so the
   * open overlay repaints against a still main screen. Restores both on
   * close. Every step is exception-isolated — widget failures never break
   * the viewer.
   */
  const openViewer = async (ctx: ExtensionContext, initialActor?: string): Promise<void> => {
    // 互斥：连点 enter（widget confirm）或在 viewer 打开时再敲 /team:view
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
   * 内排队的消息（用户变卦语义，与 team_stop / /team:stop 一致），丢弃条
   * 数追加进 notice 文案。
   */
  const viewerStopAndClearChat = async (): Promise<ViewerStopResult> => {
    const result = await viewerStopAction(state.coordinator);
    if (result.kind === "error") return result;
    refreshWidget();
    const dropped = chat.clear();
    return dropped > 0 ? { ...result, text: `${result.text}；已丢弃排队的 ${dropped} 条对话消息` } : result;
  };

  /**
   * Mounts the below-editor run widget controller (idempotent per session):
   * a data-driven string[] setWidget surface (registered while a run is
   * live, unmounted on settle) plus (when the host exposes it) a
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
   * Event-driven repaint of the below-editor widget: the coordinator's
   * `onProgress` observer calls this on every state change (leader events,
   * dispatch start/end), and the run's terminal paths call it after the
   * coordinator has cleared its progress — the widget then unmounts itself
   * (data-driven registration). The 1s aligned ticker remains the fallback.
   */
  const refreshWidget = (): void => {
    try {
      state.widget?.refresh();
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
    // Without a host registry there are no provider/id refs to check, but
    // external CLI availability is independent of it — a permissive lookup
    // keeps the external probe active without inventing model failures.
    const lookup = modelLookupFrom((ctx as unknown as { modelRegistry?: unknown }).modelRegistry) ?? {
      find: () => ({}),
      hasConfiguredAuth: () => true,
    };
    const result = preflightTeamModels(team, lookup, { resolveCli });
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
        const resumeHint =
          record.leaderSessionFile !== undefined
            ? `；可用 team_resume ${record.runId} 续跑（可换模型）`
            : "";
        ui.notify(
          `team ${record.team} ${record.status}: ${record.error ?? "已中止"}${resumeHint}`,
          record.status === "aborted" ? "warning" : "error",
        );
        // 失败必达：failed 与 completed 走同一 followUp 通道（派单主 agent
        // 需要状态/错误/成员结果/部分报告才能重试或如实转告用户）；aborted
        // 维持 team_stop 契约（不送达）。
        if (record.status === "failed") {
          deliverRunResult(pi as unknown as SessionPort, formatFailureNotice(record));
        }
      }
      return { text: "", isError: false };
    }
    if (record.status !== "completed") {
      return { text: `team run ${record.status}: ${record.error ?? "(no error detail)"}`, isError: record.status === "failed" };
    }
    return { text: record.report ?? "(leader 未返回报告)", isError: false };
  };

  /**
   * Background run flow shared by /team:run and the team_run tool: fire and
   * forget — persists the record and delivers the final report as a
   * followUp turn so the user can keep talking to the main agent while the
   * team works. Returns immediately; RUN_IN_PROGRESS surfaces right away.
   * `resume` carries the team_resume lineage (parent session + worktree).
   */
  const startBackgroundRun = (
    ctx: ExtensionContext,
    ui: UiPort,
    team: TeamConfig,
    task: string,
    resume?: ResumeContext,
  ): { ok: false; code: string; message: string } | { ok: true; team: string; members: number; runId: string } => {
    ensureRunWidget(ctx);
    const preflight = runModelPreflight(ctx, ui, team);
    if (!preflight.ok) {
      return { ok: false, code: preflight.code, message: preflight.message };
    }
    if (state.coordinator.isRunning()) {
      return { ok: false, code: "RUN_IN_PROGRESS", message: "另一个 team run 正在进行中；先 /team:stop 或等它结束。" };
    }
    // start() claims the run synchronously, so the runId is readable right
    // after the call — the handle team_stop needs.
    const runPromise = state.coordinator.start({
      team,
      task,
      ui,
      ...(resume !== undefined ? { resume } : {}),
      ask: askPortFrom(ctx),
      // 状态变化点事件即时重绘（不必等 1s tick）：首个事件通常要等 leader
      // 子进程启动，故下一行再补一帧，派单后亮块立即出现。
      onProgress: () => refreshWidget(),
    });
    const runId = state.coordinator.activeRunId() ?? "";
    // Dispatch-time identity for launch-level failures: the coordinator can
    // fail before producing a record (worktree pre-flight / leader spawn
    // error) — a minimal failed record is rebuilt from these so the failure
    // reaches the main session and /team:status like any terminal state.
    const dispatchStartedAt = new Date().toISOString();
    const failureRecord = (error: string): TeamRunRecord | undefined =>
      runId !== "" ? failedRunRecord({ runId, team: team.name, task, startedAt: dispatchStartedAt, error }) : undefined;
    refreshWidget();
    const startupText = resume
      ? `team ${team.name} 已续跑（续跑自 ${resume.parentRunId}，${team.members.length} 成员）。runId: ${runId}。完成后报告自动送达；期间可继续对话，/team:status 或 team_status 查进度`
      : `team ${team.name} 已在后台启动（${team.members.length} 成员）。runId: ${runId}。完成后报告自动送达；期间可继续对话，/team:status 或 team_status 查进度`;
    ui.notify(startupText, "info");
    // Completion still persists the record and wakes the session with the
    // report (followUp turn), then drives the viewer chat queue: completed
    // → chain-dispatch the next queued message; failed/aborted → drop it.
    // The startup notice promises a report when the run is done — failures
    // must honor that too (status/error/member rows/partial report through
    // the same channel), not only completion.
    // refreshWidget AFTER onRunFinalized: a chained dispatch claims the next
    // run synchronously, so the widget re-registers in the same frame
    // instead of flickering unmounted between runs.
    void runPromise
      .then((result) => {
        if (!result.ok) {
          const record = result.record ?? failureRecord(result.message);
          if (record) finalizeRun(record, ui, "followUp");
          else {
            ui.notify(result.message, "error");
            deliverRunResult(pi as unknown as SessionPort, `team ${team.name} run 失败: ${result.message}`);
          }
          chat.onRunFinalized("failed");
          refreshWidget();
          return;
        }
        finalizeRun(result.value, ui, "followUp");
        chat.onRunFinalized(result.value.status);
        refreshWidget();
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        const record = failureRecord(message);
        if (record) finalizeRun(record, ui, "followUp");
        else {
          ui.notify(`team run 异常退出: ${message}`, "error");
          deliverRunResult(pi as unknown as SessionPort, `team ${team.name} run 异常退出: ${message}`);
        }
        chat.onRunFinalized("failed");
        refreshWidget();
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

  // -- Resume (team_resume tool + /team:resume) -----------------------------

  /** Validated resume request: everything a resume run needs to spawn. */
  type ResumePreparation =
    | {
        ok: true;
        parentRunId: string;
        parentStatus: RunStatusFile;
        sessionFile: string;
        task: string;
        team: TeamConfig;
        overrides: ModelOverrides | undefined;
      }
    | { ok: false; code: TeamErrorCode; message: string };

  /**
   * Validates a resume request against the parent run's status snapshot:
   * only failed/aborted runs with a leader session mirror are resumable; the
   * team definition is re-resolved (it may have changed since the parent),
   * model overrides are applied to a copy for preflight/prompt/record, and
   * the fixed resume task is built. Never spawns anything.
   */
  const prepareResume = (
    ui: UiPort,
    request: {
      runId: string;
      instructions?: string;
      leaderModel?: string;
      memberModels?: Array<{ name?: unknown; model?: unknown }>;
    },
  ): ResumePreparation => {
    const runId = request.runId.trim();
    if (!runId) {
      return { ok: false, code: "RUN_ID_REQUIRED", message: "runId 是必填参数：先用 team_status 查看 failed/aborted 的 runId。" };
    }
    const runsRoot = transcriptRoot();
    const parentStatus = findRunStatus(runsRoot, runId);
    if (!parentStatus) {
      return { ok: false, code: "RUN_NOT_FOUND", message: `没有找到 runId ${runId} 的 run 记录（status.json）。已结束的历史 run 需未落终态快照才能续跑。` };
    }
    if (state.coordinator.activeRunId() === runId) {
      return { ok: false, code: "RUN_NOT_TERMINAL", message: `run ${runId} 仍在运行中，先 /team:stop 或等它落定后再续跑。` };
    }
    const eligibility = resumeEligibility(parentStatus.status);
    if (!eligibility.ok) return { ok: false, code: eligibility.code, message: eligibility.message };
    const sessionFile = resolveResumeSessionFile({ runsRoot, parentStatus });
    if (!sessionFile) {
      return {
        ok: false,
        code: "RESUME_UNAVAILABLE",
        message: `run ${runId} 没有 leader 会话镜像（功能上线前的 run、启动即失败的 run，或已过 7 天保留期被清理）；无法续跑，请用 team_run 重新派单。`,
      };
    }
    const found = resolveTeam(parentStatus.team);
    if (!found.ok) {
      return { ok: false, code: "TEAM_NOT_FOUND", message: `团队定义 ${parentStatus.team} 已不可用：${found.message}` };
    }
    // Model overrides: leader + known members only (unknown names warn + ignored).
    const leaderModel =
      typeof request.leaderModel === "string" && request.leaderModel.trim().length > 0
        ? request.leaderModel.trim()
        : undefined;
    const memberModels: Record<string, string> = {};
    for (const item of request.memberModels ?? []) {
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      const model = typeof item?.model === "string" ? item.model.trim() : "";
      if (name && model) memberModels[name] = model;
    }
    const effective = resolveEffectiveTeam(found.value, {
      ...(leaderModel !== undefined ? { leaderModel } : {}),
      ...(Object.keys(memberModels).length > 0 ? { memberModels } : {}),
    });
    if (effective.unknownMembers.length > 0) {
      ui.notify(`续跑模型覆盖忽略未知成员：${effective.unknownMembers.join("、")}（团队花名册里没有这些成员）`, "warning");
    }
    const knownMembers = Object.fromEntries(
      Object.entries(memberModels).filter(([name]) => found.value.members.some((member) => member.name === name)),
    );
    const overrides: ModelOverrides | undefined =
      leaderModel === undefined && Object.keys(knownMembers).length === 0
        ? undefined
        : { ...(leaderModel !== undefined ? { leaderModel } : {}), ...(Object.keys(knownMembers).length > 0 ? { memberModels: knownMembers } : {}) };
    return {
      ok: true,
      parentRunId: runId,
      parentStatus,
      sessionFile,
      task: buildResumePrompt(request.instructions),
      team: effective.team,
      overrides,
    };
  };

  const resumeContextFrom = (prepared: Extract<ResumePreparation, { ok: true }>): ResumeContext => ({
    parentRunId: prepared.parentRunId,
    parentStatus: prepared.parentStatus,
    sessionFile: prepared.sessionFile,
    ...(prepared.overrides !== undefined ? { modelOverrides: prepared.overrides } : {}),
  });

  /** `/team:resume <runId> [补充指示]`：后台续跑入口（不带模型 flag）。 */
  const resumeFromCommand = (ctx: ExtensionContext, args: string): void => {
    const ui = uiPortFrom(ctx);
    const trimmed = args.trim();
    if (!trimmed) {
      ui.notify("用法：/team:resume <runId> [补充指示]（续跑 failed/aborted 的 run，沿用原会话与 worktree；换模型用 team_resume 工具）", "warning");
      return;
    }
    const spaceIndex = trimmed.indexOf(" ");
    const runId = spaceIndex > 0 ? trimmed.slice(0, spaceIndex) : trimmed;
    const instructions = spaceIndex > 0 ? trimmed.slice(spaceIndex + 1).trim() : undefined;
    const prepared = prepareResume(ui, { runId, ...(instructions ? { instructions } : {}) });
    if (!prepared.ok) {
      ui.notify(prepared.message, "error");
      return;
    }
    const started = startBackgroundRun(ctx, ui, prepared.team, prepared.task, resumeContextFrom(prepared));
    if (!started.ok) ui.notify(started.message, "error");
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
        // followUp turn (same flow as /team:run).
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
        ask: askPortFrom(ctx),
        onProgress: (progress) => {
          // 状态变化点事件即时重绘（下方亮块与工具进度共用同一观察点）。
          refreshWidget();
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
      refreshWidget();
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
        details: {
          actors: data.actors.map((a) => ({
            actor: a.actor,
            label: a.label,
            status: a.status,
            ...(a.model ? { model: a.model } : {}),
            ...(a.thinkingLevel ? { thinkingLevel: a.thinkingLevel } : {}),
          })),
        },
      };
    },
  });

  // Stop tool: the MAIN agent aborts a background run by runId (the same
  // primitive /team:stop uses, plus a bounded settle wait so the agent gets
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
        refreshWidget();
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

  // Resume tool: the MAIN agent continues a failed/aborted run — the new
  // leader opens the parent's session file (full conversation as context) and
  // reuses its worktrees; models can be overridden for this run only. Only
  // the cockpit registers it — no child process ever sees team_resume.
  pi.registerTool({
    name: "team_resume",
    label: "Resume Agent Team Run",
    description:
      "续跑一个 failed/aborted 的 agent team run：新 leader 打开父 run 的 leader 会话原地继续（完整对话上下文，无交接摘要），并复用父 run 的 worktree（含未提交改动）。可为本次续跑单独覆盖 leader/成员模型（不改团队文件，含 provider/id:level 后缀）。默认后台运行、报告自动送达；wait=true 同步等待。仅 failed/aborted 可续跑；completed 请用 team_run。",
    promptGuidelines: [
      "用户说「接着跑/续跑/换模型继续」时：先 team_status 拿 failed/aborted 的 runId，再调本工具。",
      "模型额度耗尽的典型用法：leaderModel 换成有额度的 provider/id（成员同理传 memberModels），本次续跑 run 生效，团队文件不动。",
      "runId 必填：省略 RUN_ID_REQUIRED；未知 RUN_NOT_FOUND；仍在跑 RUN_NOT_TERMINAL；已完成 RUN_ALREADY_FINISHED；无会话镜像 RESUME_UNAVAILABLE；团队已删 TEAM_NOT_FOUND（均不抛异常）。",
      "默认（wait 省略）立即返回，报告稍后自动送达；等待期间正常回应用户其它消息。",
    ],
    parameters: Type.Object({
      runId: Type.String({ description: "要续跑的 runId（failed/aborted；用 team_status 查看）" }),
      instructions: Type.Optional(
        Type.String({ description: "本次续跑给 leader 的补充指示（可选；leader 已有完整上下文，通常只在换模型/换策略时用）" }),
      ),
      leaderModel: Type.Optional(
        Type.String({ description: "本次续跑的 leader 模型覆盖，provider/id[:level]（可选；不改团队文件）" }),
      ),
      memberModels: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "成员名（见 team_list / 团队定义）" }),
            model: Type.String({ description: "成员模型 provider/id[:level]" }),
          }),
          { description: "本次续跑的成员模型覆盖列表（可选；未知成员名忽略并警告）" },
        ),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: "同步等待续跑 run 结束并内联返回报告。默认 false=后台运行", default: false }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      const ui = uiPortFrom(ctx);
      const prepared = prepareResume(ui, {
        runId: typeof params?.runId === "string" ? params.runId : "",
        ...(typeof params?.instructions === "string" ? { instructions: params.instructions } : {}),
        ...(typeof params?.leaderModel === "string" ? { leaderModel: params.leaderModel } : {}),
        ...(Array.isArray(params?.memberModels) ? { memberModels: params.memberModels } : {}),
      });
      if (!prepared.ok) {
        return {
          content: [{ type: "text" as const, text: prepared.message }],
          details: { code: prepared.code },
          isError: true,
        };
      }
      const preflight = runModelPreflight(ctx, ui, prepared.team);
      if (!preflight.ok) {
        return {
          content: [{ type: "text" as const, text: preflight.message }],
          details: { code: preflight.code },
          isError: true,
        };
      }
      const resume = resumeContextFrom(prepared);
      if (params.wait !== true) {
        const started = startBackgroundRun(ctx, ui, prepared.team, prepared.task, resume);
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
              text: `run ${prepared.parentRunId} 已续跑（新 runId: ${started.runId}，team ${started.team}，${started.members} 成员）。报告完成后会自动送达本会话；期间可继续对话。team_status 可查进度。`,
            },
          ],
          details: {
            started: true,
            background: true,
            runId: started.runId,
            parentRunId: prepared.parentRunId,
            team: started.team,
            members: started.members,
          },
        };
      }
      const result = await state.coordinator.start({
        team: prepared.team,
        task: prepared.task,
        ui,
        resume,
        ask: askPortFrom(ctx),
        signal,
        onProgress: () => {
          refreshWidget();
          if (!onUpdate) return;
          try {
            onUpdate({ content: [{ type: "text" as const, text: `team ${prepared.team.name} 续跑中（来自 ${prepared.parentRunId}）` }], details: {} });
          } catch {
            /* progress failures never break the run */
          }
        },
      });
      refreshWidget();
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

  // -- Commands -----------------------------------------------------------

  const statusText = (ctx: ExtensionContext): string =>
    formatStatusSnapshot(state.coordinator.getStatus(), Date.now(), (t) => {
      try {
        return ctx.hasUI ? ctx.ui.theme.fg("dim", t) : t;
      } catch {
        return t;
      }
    });

  /** `/team` 或 `/team:list`（无参）：列出所有 agent team（团队/成员/模型）。 */
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
      lines.push("");
    }
    for (const bad of invalid) lines.push(`⚠ ${bad.file} — ${bad.message}`);
    ui.notify(lines.join("\n"), "info");
  };

  /** `/team:run <团队名> <任务>`：后台派单入口。 */
  const startRunFromArgs = (ctx: ExtensionContext, args: string): void => {
    const trimmed = args.trim();
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex <= 0 || trimmed.slice(spaceIndex + 1).trim().length === 0) {
      uiPortFrom(ctx).notify("用法：/team:run <团队名> <任务描述>", "warning");
      return;
    }
    const teamName = trimmed.slice(0, spaceIndex);
    const task = trimmed.slice(spaceIndex + 1).trim();
    runFromCommand(ctx, teamName, task);
  };

  /** `/team:status`：当前/最近一次 run 的状态。 */
  const showRunStatus = (ctx: ExtensionContext): void => {
    uiPortFrom(ctx).notify(statusText(ctx), "info");
  };

  /** `/team:stop`：中止当前 run（leader 与所有成员）。 */
  const stopRun = (ctx: ExtensionContext): void => {
    const ui = uiPortFrom(ctx);
    if (state.coordinator.stop()) {
      refreshWidget();
      const dropped = chat.clear();
      ui.notify(dropped > 0 ? `已发送中止信号（SIGTERM → SIGKILL）；已丢弃排队的 ${dropped} 条 viewer 对话消息` : "已发送中止信号（SIGTERM → SIGKILL）", "warning");
    } else {
      ui.notify("当前没有正在进行的 team run", "info");
    }
  };

  /** `/team:view`：全屏查看当前/最近一次 run 的成员会话记录（实时）。 */
  const showRunViewer = async (ctx: ExtensionContext): Promise<void> => {
    const ui = uiPortFrom(ctx);
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ui.notify("会话记录查看器仅在交互式 TUI 中可用。", "warning");
      return;
    }
    const snapshot = state.coordinator.getStatus();
    if (!snapshot.progress && !snapshot.lastRecord) {
      ui.notify("当前没有 team run 记录。用 /team:run <团队> <任务> 派单后即可查看。", "info");
      return;
    }
    try {
      await openViewer(ctx);
    } catch (e) {
      ui.notify(`打开会话记录查看器失败: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  /** `/team:clear`：丢弃排队的 viewer 对话（亮块随 run 落定自动隐藏，不再手动卸载）。 */
  const clearRunBlock = (ctx: ExtensionContext): void => {
    const ui = uiPortFrom(ctx);
    if (state.coordinator.isRunning()) {
      ui.notify("team run 进行中；先 /team:stop 或等它结束再清除。", "warning");
      return;
    }
    const dropped = chat.clear();
    ui.notify(
      dropped > 0
        ? `已丢弃排队的 ${dropped} 条对话消息；亮块随 run 结束自动隐藏。`
        : "亮块随 run 结束自动隐藏，没有可清除的内容。",
      "info",
    );
  };

  /** `/team:doctor`：自检报告。 */
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
   * 统一 `/team` 命令（冒号化命令面，v1.12.0）：无参 = 列团队；带参 = 用法提示。
   * 旧空格子命令（`/team run` 等）只提示改名、绝不执行；派单统一走
   * `/team:run <团队名> <任务>`，团队名可与子命令同名（保留词概念退役）。
   */
  pi.registerCommand("team", {
    description: "agent-team：无参列出团队；子命令为独立冒号命令：/team:list|run|status|stop|view|clear|doctor",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        listTeams(ctx);
        return;
      }
      const head = trimmed.split(/\s+/)[0] ?? "";
      const renamed = RETIRED_TEAM_SUBCOMMANDS[head];
      if (renamed) {
        uiPortFrom(ctx).notify(`「/team ${head}」已改名为「/${renamed.command}」；用法：${renamed.usage}`, "warning");
        return;
      }
      uiPortFrom(ctx).notify(TEAM_USAGE, "warning");
    },
  });

  // 冒号子命令：每条独立注册，handler 直接走动作函数（无二次分词）。
  pi.registerCommand(TEAM_COMMAND_NAMES.list, {
    description: "列出全部 agent team（团队/成员/模型；含无效定义文件警告）",
    handler: async (_args, ctx) => listTeams(ctx),
  });

  pi.registerCommand(TEAM_COMMAND_NAMES.run, {
    description: "后台派单：/team:run <团队名> <任务描述>（派单前做 model 预检）",
    handler: async (args, ctx) => startRunFromArgs(ctx, args ?? ""),
  });

  pi.registerCommand(TEAM_COMMAND_NAMES.resume, {
    description: "续跑 failed/aborted 的 run：/team:resume <runId> [补充指示]（沿用父会话与 worktree；换模型用 team_resume 工具）",
    handler: async (args, ctx) => resumeFromCommand(ctx, args ?? ""),
  });

  pi.registerCommand(TEAM_COMMAND_NAMES.status, {
    description: "查看当前/最近一次 team run 的状态（成员、轮次、费用、预算）",
    handler: async (_args, ctx) => showRunStatus(ctx),
  });

  pi.registerCommand(TEAM_COMMAND_NAMES.stop, {
    description: "中止当前 team run（leader 与所有成员，SIGTERM → SIGKILL）",
    handler: async (_args, ctx) => stopRun(ctx),
  });

  pi.registerCommand(TEAM_COMMAND_NAMES.view, {
    description: "打开全屏会话记录查看器（左 roster / 右 detail，仅交互式 TUI）",
    handler: async (_args, ctx) => showRunViewer(ctx),
  });

  pi.registerCommand(TEAM_COMMAND_NAMES.clear, {
    description: "丢弃排队的 viewer 对话消息（亮块随 run 结束自动隐藏；运行中拒绝）",
    handler: async (_args, ctx) => clearRunBlock(ctx),
  });

  pi.registerCommand(TEAM_COMMAND_NAMES.doctor, {
    description: "agent-team 自检报告（团队发现/模型预检/运行目录/预算/worktree）",
    handler: async (_args, ctx) => showDoctor(ctx),
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
        currentPid: process.pid,
        isProcessAlive: defaultIsProcessAlive,
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
        // 崩溃 run 的记录可能还留在 run worktree（随后会被 git worktree remove
        // 删除）或主会话 cwd：翻 failed 后按终态语义归档到主工作区 history/。
        const archived = archiveRunRecords({
          runId: run.runId,
          baseCwd: ctx.cwd,
          worktreeRunRoot: path.join(worktreeRoot(), run.runId),
        });
        const archiveDiagnostics = [...archived.failures, ...archived.conflicts];
        if (archiveDiagnostics.length > 0) {
          uiPortFrom(ctx).notify(`run ${run.runId} 记录归档诊断：\n${archiveDiagnostics.join("\n")}`, "warning");
        }
        uiPortFrom(ctx).notify(
          `发现上次会话残留的未终态 run：team ${run.team}（runId ${run.runId}）已标记为 failed。${record.error}`,
          "warning",
        );
      }
    } catch {
      /* reconcile is best-effort */
    }

    // Below-editor run widget: mount the (idempotent) controller every
    // session — registration is DATA driven (`snapshot.running` ⇒ frame,
    // settle ⇒ setWidget undefined), so the widget appears/disappears with
    // the run without an action-driven remount, and a hydrated terminal
    // record never re-mounts the block on /reload.
    ensureRunWidget(ctx);

    // Best-effort retention: drop transcript artifact dirs older than a week.
    try {
      pruneOldTranscripts(transcriptRoot(), Date.now(), TRANSCRIPT_RETENTION_MS);
    } catch {
      /* pruning is best-effort */
    }

    // 动态 per-team 命令保持退役（v1.9.0）：团队增删即时生效，不需要注册命令；
    // 派单一律走 /team:run 的显式形态。
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

export default function agentTeamExtension(pi: ExtensionAPI, opts?: AgentTeamExtensionOptions): void {
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
    registerLeaderMode(pi, teamFile, opts);
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
    return { text: "已发送中止信号，leader 仍在收尾；稍后用 /team:status 确认终态", kind: "warning" };
  } catch {
    return { text: "停止失败；稍后用 /team:stop 重试", kind: "error" };
  }
}
