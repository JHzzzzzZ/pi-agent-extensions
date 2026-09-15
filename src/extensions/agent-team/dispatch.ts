/**
 * agent-team — team_dispatch tool executor (leader mode)
 *
 * Runs inside the leader child pi process. Validates the leader's dispatch
 * request against the team roster, creates worktrees for isolated members,
 * runs member child pi processes with bounded concurrency, streams progress
 * snapshots (status + latest activity) via onUpdate, and returns a combined
 * per-member report.
 *
 * The executor is created ONCE per leader process and carries the per-run
 * dispatch budget: exceeding it makes further dispatches fail with an
 * instruction to wrap up, so a confused leader cannot loop forever.
 */

import * as path from "node:path";
import { buildExternalArgs, createExternalParser, resolveExternalCli } from "./external.ts";
import {
  decideMemberTerminal,
  formatMemberDiagnostics,
  memberFailureMessage,
  type MemberTerminalSignals,
} from "./outcome.ts";
import { defaultSpawn, getPiInvocation, runChildPi } from "./runner.ts";
import { type TranscriptEntryKind, type TranscriptSink } from "./transcript.ts";
import { createWorktree, defaultGitRunner, memberWorktreeBranch, type GitRunner } from "./worktree.ts";
import {
  DERIVED_AGENT_TOOL_DENYLIST,
  LEADER_ENV_FILE,
  LEADER_ENV_MEMBER_MODELS,
  LEADER_ENV_NAME,
  LEADER_ENV_RUNID,
  LEADER_ENV_WORKTREE_RUNID,
  MAX_PARALLEL_MEMBERS,
  MAX_RESULT_BYTES,
  MAX_SUMMARY_BYTES,
  MAX_TASKS_PER_DISPATCH,
  resolveRunBudget,
  emptyUsage,
  truncateUtf8,
  type AgentUsage,
  type ChildEvent,
  type ChildOutcome,
  type DispatchOutcome,
  type ExternalBackend,
  type ExternalCliResolveResult,
  type MemberDiagnostics,
  type MemberPhase,
  type MemberProgress,
  type MemberProgressStatus,
  type MemberRunResult,
  type PiSpawn,
  type RunBudget,
  type TeamConfig,
  type TeamErrorCode,
} from "./types.ts";

export interface DispatchRequest {
  tasks: Array<{ agent: string; task: string }>;
}

/**
 * 回环豁免主机：本地中继（如 `ANTHROPIC_BASE_URL=http://127.0.0.1:15721`）与本地
 * 模型服务必须直连。宿主 `applyHttpProxySettings` 只注入 `HTTP(S)_PROXY`、从不注入
 * `NO_PROXY`，子进程不显式放行回环就会被 CONNECT-only 代理桥劫持（真机每次派单
 * 405，见 `docs/incidents.md`）。
 */
const LOOPBACK_BYPASS_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

/**
 * 放行变量写两份大小写键：Node/undici 与各外部 CLI 的读取口径不同（curl 优先小写、
 * Go 优先大写），只写一份必然有一侧读不到。
 */
const PROXY_BYPASS_KEYS = ["NO_PROXY", "no_proxy"] as const;

/** 已有豁免值里还缺哪些回环主机（大小写不敏感；只看不改，用户值逐字节保留）。 */
function missingBypassHosts(existing: string): string[] {
  const entries = existing.split(",").map((entry) => entry.trim().toLowerCase());
  return LOOPBACK_BYPASS_HOSTS.filter((host) => !entries.includes(host));
}

/**
 * 拷贝环境并补上回环代理豁免：`NO_PROXY`/`no_proxy` 缺省写回环项本身，已有值只
 * **追加**缺失项（显式值原样保留、已含项不重复追加、重复调用幂等）。不判定代理
 * 是否已设——子进程可能在自身配置里配代理，豁免对无代理环境无害。
 */
export function withLoopbackBypass(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of PROXY_BYPASS_KEYS) {
    const existing = copy[key];
    if (existing === undefined || existing.trim().length === 0) {
      copy[key] = LOOPBACK_BYPASS_HOSTS.join(",");
      continue;
    }
    const missing = missingBypassHosts(existing);
    if (missing.length > 0) copy[key] = `${existing},${missing.join(",")}`;
  }
  return copy;
}

/**
 * Copies an environment, removes the three leader-mode keys and adds the
 * loopback proxy bypass. Member child processes must not inherit the leader
 * keys: agent-team would load in leader mode inside a member and bind its
 * tooling to the parent run. Everything else (PATH, provider keys,
 * credentials, proxy settings) is preserved.
 */
export function stripLeaderEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = withLoopbackBypass(env);
  delete copy[LEADER_ENV_FILE];
  delete copy[LEADER_ENV_NAME];
  delete copy[LEADER_ENV_RUNID];
  return copy;
}

/**
 * 拷贝环境、删除全部 run 级键（3 个 leader 键 + 2 个 resume 谱系键
 * WORKTREE_RUN_ID / MEMBER_MODELS）并补上回环代理豁免。leader 派生一个「新 run」时
 * 不能继承任何父进程的 run 绑定，因此这里比成员侧的 `stripLeaderEnv`（只剥 3 个
 * leader 键、刻意保留 resume 谱系键）剥得更干净；其余环境（PATH、provider
 * key、凭据、代理设置）全部继承，新 run 自己的键由调用方叠加。
 */
export function stripRunScopedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = stripLeaderEnv(env);
  delete copy[LEADER_ENV_WORKTREE_RUNID];
  delete copy[LEADER_ENV_MEMBER_MODELS];
  return copy;
}

export interface DispatchMemberDetail {
  name: string;
  ok: boolean;
  status: MemberProgressStatus;
  summary?: string;
  /** Latest assistant activity tail (progress display only). */
  latest?: string;
  /** Short progress note (turn count / worktree setup / failure code). */
  note?: string;
  /** done 但收尾异常（exitCode ≠ 0）时的一行说明（ADR-0006）。 */
  warning?: string;
  /** 终态诊断（转录/失败通知回看用）。 */
  diagnostics?: MemberDiagnostics;
  /** Live activity phase reported by the member's child events. */
  phase?: MemberPhase;
  /** Tool name while `phase === "tool"`. */
  toolName?: string;
  /** Epoch ms of the member's last observed child event. */
  lastActivityAtMs?: number;
  usage?: AgentUsage;
  worktree?: { path: string; branch: string; switchedBackFrom?: string };
  error?: { code: string; message: string };
}

export interface DispatchDetails {
  members: DispatchMemberDetail[];
  totalUsage: AgentUsage;
}

export interface DispatchDeps {
  /** Team resolved once when the leader starts. */
  team: TeamConfig;
  /** Working directory for member children (shared members run here). */
  cwd: string;
  /** Root directory for per-run worktrees. */
  worktreeRoot: string;
  runId: string;
  /**
   * Run id used for member worktree paths/branches. Defaults to `runId`;
   * a resumed run passes the parent run id so members keep working in the
   * parent's on-disk worktrees (uncommitted changes included).
   */
  worktreeRunId?: string;
  spawn?: PiSpawn;
  piCommand?: string;
  gitRunner?: GitRunner;
  /**
   * External CLI resolver seam (defaults to external.ts's real PATH probe).
   * Leader children resolve their own CLIs; only tests inject a fake here.
   */
  resolveExternalCli?: (backend: ExternalBackend) => ExternalCliResolveResult;
  /** Test seam: SIGTERM→SIGKILL grace for member children. */
  killGraceMs?: number;
  /** Run transcript writer (member activity artifacts for /team:view). */
  transcript?: TranscriptSink;
  /** Resolved per-run budget (defaults to the protocol constants). */
  budget?: RunBudget;
}

export interface ToolUpdatePayload {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export type OnUpdate = (update: ToolUpdatePayload) => void;

/** Result of one executor invocation (budget exhaustion is a typed failure). */
export type DispatchExecResult =
  | { ok: true; value: DispatchOutcome }
  | { ok: false; code: TeamErrorCode; message: string };

interface PlannedMemberError {
  code: TeamErrorCode;
  message: string;
}

interface PlannedDispatch {
  /** Requested agent name (the transcript actor even when unknown). */
  agent: string;
  member?: TeamConfig["members"][number];
  task: string;
  worktree?: { path: string; branch: string; switchedBackFrom?: string };
  preError?: PlannedMemberError;
}

/** Validates and normalizes the leader's dispatch request. */
export function parseDispatchRequest(
  raw: unknown,
): { ok: true; value: DispatchRequest } | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "team_dispatch requires a `tasks` array" };
  }
  const tasks = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, message: "team_dispatch requires a non-empty `tasks` array" };
  }
  if (tasks.length > MAX_TASKS_PER_DISPATCH) {
    return { ok: false, message: `too many tasks (${tasks.length}); max ${MAX_TASKS_PER_DISPATCH} per dispatch` };
  }
  const normalized: Array<{ agent: string; task: string }> = [];
  for (let i = 0; i < tasks.length; i++) {
    const item = tasks[i];
    if (item === null || typeof item !== "object") {
      return { ok: false, message: `tasks[${i}] must be an object` };
    }
    const agent = (item as { agent?: unknown }).agent;
    const task = (item as { task?: unknown }).task;
    if (typeof agent !== "string" || agent.trim().length === 0) {
      return { ok: false, message: `tasks[${i}].agent must be a member name` };
    }
    if (typeof task !== "string" || task.trim().length === 0) {
      return { ok: false, message: `tasks[${i}].task must be a non-empty task description` };
    }
    normalized.push({ agent: agent.trim(), task: task.trim() });
  }
  return { ok: true, value: { tasks: normalized } };
}

function rosterText(team: TeamConfig): string {
  return team.members.map((m) => `- ${m.name}${m.model ? ` (${m.model})` : ""}`).join("\n");
}

/**
 * 成员分节标题：三态不变；`done` 且收尾异常时把 warning 前置到括号里
 * （`— done（收尾异常：exit 1，2.3s）`）——leader 一眼看到「完成但有异常」。
 */
function statusLine(result: MemberRunResult): string {
  const secs = Math.round(result.durationMs / 100) / 10;
  const cost = result.usage.cost > 0 ? `，$${result.usage.cost.toFixed(4)}` : "";
  if (result.status === "done") {
    const warning = result.warning ? `${result.warning}，` : "";
    return `## ${result.name} — done（${warning}${secs}s${cost}）`;
  }
  if (result.status === "aborted") return `## ${result.name} — aborted`;
  return `## ${result.name} — failed（${result.error?.code ?? "CHILD_FAILED"}）`;
}

function worktreeLines(result: MemberRunResult): string[] {
  if (!result.worktree) return [];
  const healed = result.worktree.switchedBackFrom ? `，已从 \`${result.worktree.switchedBackFrom}\` 切回` : "";
  return [
    "",
    `> worktree: \`${result.worktree.path}\`（分支 \`${result.worktree.branch}\`${healed}，改动留在该分支，未合并）`,
  ];
}

/** Flattens a message to one line and bounds it (progress notes). */
function shortMessage(text: string, max = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** Member result codes that are environmental — retrying cannot help. */
const FAILURE_GUIDANCE =
  [
    "⚠ 失败处理指令：",
    "- 上面的失败若为环境级错误（worktree/git 不可用、成员/模型不存在、子进程启动失败），重试必然再次失败——**不要再次派发给失败的成员**。",
    "- 调整方案（换成员、改任务、放弃该子任务）或直接输出最终报告，并在报告中如实说明失败原因。",
  ].join("\n");

/**
 * 成员转录收尾行（system）：状态 + warning + 耗时/费用/轮数 + 一行诊断。
 * 转录是排障面，判定只看末轮——早轮错误只在这里的「前轮错误」里可见。
 */
function memberSystemLine(result: MemberRunResult, secs: number, cost: number, turns: number): string {
  const status = result.warning ? `${result.status}（${result.warning}）` : result.status;
  const parts = [`${status} · ${secs}s · $${cost.toFixed(4)} · ${turns} turns`];
  if (result.diagnostics) parts.push(formatMemberDiagnostics(result.diagnostics));
  return parts.join(" · ");
}

/**
 * 失败成员的部分产出提示（ADR-0006）：真 failed 不代表产出无用——
 * 轮中被打断时子进程可能已完成大部分工作，leader 可直接取用而不是重派。
 */
function partialOutputNote(result: MemberRunResult): string {
  if (result.status !== "failed") return "";
  const bytes = Buffer.byteLength(result.result, "utf8");
  if (bytes === 0 || result.result === "(no output)") return "";
  return `（已有完整产出 ${bytes} 字节，可直接取用）`;
}

/** Builds the combined markdown report returned to the leader. */
export function buildDispatchReport(results: MemberRunResult[]): string {
  const sections = results.map((result) => {
    const header = statusLine(result);
    // 失败时错误消息 + 部分产出正文一并可见（产出已拿到就不该白重派）
    const note = partialOutputNote(result);
    const body = result.ok
      ? result.result
      : [`错误: ${result.error?.message ?? result.result}`, ...(note ? ["", note, result.result] : [])].join("\n");
    return [header, "", body, ...worktreeLines(result)].join("\n");
  });
  const anyFailure = results.some((r) => !r.ok);
  return anyFailure ? `${sections.join("\n\n")}\n\n${FAILURE_GUIDANCE}` : sections.join("\n\n");
}

/** Builds a compact progress snapshot text (used for onUpdate + widget). */
export function buildProgressText(members: MemberProgress[]): string {
  const icon: Record<MemberProgressStatus, string> = {
    queued: "…",
    running: "▶",
    done: "✓",
    failed: "✗",
    aborted: "⊘",
  };
  return members
    .map((m) => {
      const bits = [`${icon[m.status]} ${m.name} ${m.status}`];
      if (m.note) bits.push(m.note);
      if (m.latest) bits.push(m.latest);
      return bits.join(" — ");
    })
    .join("\n");
}

/** Runs a bounded-concurrency map over items. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function truncateMessage(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 成员终态落地：共享判定函数（outcome.ts）+ 错误消息/诊断组装。两条后端
 * （pi / 外部 CLI）各传自己的信号，判定表与呈现面只此一处。
 */
function finalizeMember(input: {
  name: string;
  aborted: boolean;
  outcome: ChildOutcome;
  /** 末轮错误消息（外部 CLI 来自解析器，pi 来自 outcome；空则回退到 fallback）。 */
  errorMessage?: string;
  /** 末轮以错误收尾的显式信号（外部 CLI：turn.failed / is_error）。 */
  finalTurnError?: boolean;
  /** 是否观察到任何一轮输出。 */
  hasFinalTurn: boolean;
  rawText: string;
  usage: AgentUsage;
  durationMs: number;
  /** 无错误消息时的兜底描述。 */
  fallbackMessage: string;
}): MemberRunResult {
  const signals: MemberTerminalSignals = {
    aborted: input.aborted,
    exitCode: input.outcome.exitCode,
    signal: input.outcome.signal,
    hasFinalTurn: input.hasFinalTurn,
    toolInterrupted: input.outcome.toolInterrupted === true,
    ...(input.finalTurnError !== undefined ? { finalTurnError: input.finalTurnError } : {}),
    ...(input.outcome.stopReason !== undefined ? { lastStopReason: input.outcome.stopReason } : {}),
    ...(input.errorMessage !== undefined ? { lastErrorMessage: input.errorMessage } : {}),
  };
  const decision = decideMemberTerminal(signals);
  const diagnostics: MemberDiagnostics = {
    exitCode: input.outcome.exitCode,
    ...(input.outcome.signal !== undefined ? { signal: input.outcome.signal } : {}),
    ...(input.outcome.stopReason !== undefined ? { lastStopReason: input.outcome.stopReason } : {}),
    priorErrors: [...(input.outcome.priorErrors ?? [])],
    priorErrorCount: input.outcome.priorErrorCount ?? 0,
  };
  const result: MemberRunResult = {
    name: input.name,
    ok: decision.status === "done",
    status: decision.status,
    result: truncateUtf8(input.rawText, MAX_RESULT_BYTES),
    summary: truncateUtf8(input.rawText, MAX_SUMMARY_BYTES),
    usage: input.usage,
    durationMs: input.durationMs,
    diagnostics,
  };
  if (decision.warning !== undefined) result.warning = decision.warning;
  if (decision.status !== "done") {
    result.error = {
      code: decision.status === "aborted" ? "AGENT_ABORTED" : "CHILD_FAILED",
      message:
        decision.status === "aborted"
          ? truncateMessage(input.errorMessage || "run 已中止，成员子进程被终止")
          : truncateMessage(
              memberFailureMessage({
                interrupted: decision.failure === "interrupted",
                message: input.errorMessage,
                fallback: input.fallbackMessage,
                exitCode: input.outcome.exitCode,
                ...(input.outcome.signal !== undefined ? { signal: input.outcome.signal } : {}),
              }),
            ),
    };
  }
  return result;
}

/**
 * Creates the dispatch executor. Created ONCE per leader process: the
 * closure carries the per-run dispatch budget across calls.
 */
export function createDispatchExecutor(deps: DispatchDeps) {
  const git = deps.gitRunner ?? defaultGitRunner();
  const spawn = deps.spawn ?? defaultSpawn();
  const resolveCli = deps.resolveExternalCli ?? resolveExternalCli;
  const budget = deps.budget ?? resolveRunBudget();
  let dispatchCalls = 0;
  let memberRuns = 0;

  return async function executeDispatch(
    request: DispatchRequest,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdate | undefined,
  ): Promise<DispatchExecResult> {
    // Loop guard: a leader that keeps dispatching (e.g. retrying an
    // environmental failure forever) is cut off and told to wrap up.
    if (dispatchCalls >= budget.maxDispatchCalls || memberRuns >= budget.maxMemberRuns) {
      return {
        ok: false,
        code: "BUDGET_EXCEEDED",
        message: [
          `已达本次 run 的派发预算上限（${dispatchCalls} 次 dispatch / 上限 ${budget.maxDispatchCalls}；${memberRuns} 次成员运行 / 上限 ${budget.maxMemberRuns}）。`,
          "不要再调用 team_dispatch。立即基于已收到的结果输出最终报告（含已完成部分与未完成原因）。",
        ].join(""),
      };
    }
    dispatchCalls++;
    memberRuns += request.tasks.length;

    const statuses = new Map<string, MemberProgress>();

    const emitProgress = () => {
      if (!onUpdate) return;
      try {
        onUpdate({
          content: [{ type: "text", text: buildProgressText(Array.from(statuses.values())) }],
          details: { members: Array.from(statuses.values()) },
        });
      } catch {
        /* progress failures never break the run */
      }
    };

    /** Best-effort transcript write (observability data, never run-critical). */
    const record = (actor: string, kind: TranscriptEntryKind, text: string): void => {
      if (!deps.transcript) return;
      try {
        deps.transcript.append(actor, kind, text);
      } catch {
        /* transcript failures never break the run */
      }
    };

    /** One-line bounded summaries of tool calls/results (transcript display). */
    const toolCallText = (toolName: string, args: unknown): string =>
      shortMessage(`${toolName}${args === undefined ? "" : ` ${JSON.stringify(args)}`}`, 300);
    const toolResultText = (toolName: string, text: unknown): string =>
      shortMessage(`${toolName}${text === undefined ? "" : ` → ${text}`}`, 300);

    const setProgress = (
      name: string,
      status: MemberProgressStatus,
      note?: string,
      latest?: string,
      activity?: { phase: MemberPhase; toolName?: string },
    ) => {
      const previous = statuses.get(name);
      const next: MemberProgress = { name, status };
      if (note !== undefined) next.note = note;
      else if (previous?.note !== undefined) next.note = previous.note;
      if (latest !== undefined) next.latest = latest;
      else if (previous?.latest !== undefined) next.latest = previous.latest;
      if (activity !== undefined) {
        next.phase = activity.phase;
        if (activity.phase === "tool" && activity.toolName !== undefined) next.toolName = activity.toolName;
        next.lastActivityAtMs = Date.now();
      } else if (previous !== undefined) {
        if (previous.phase !== undefined) next.phase = previous.phase;
        if (previous.toolName !== undefined) next.toolName = previous.toolName;
        if (previous.lastActivityAtMs !== undefined) next.lastActivityAtMs = previous.lastActivityAtMs;
      }
      statuses.set(name, next);
      emitProgress();
    };

    /**
     * Shared child-event handler for both member backends (pi JSON stream and
     * external CLI events already mapped to ChildEvent by the parser): keeps
     * transcript + progress identical across backends.
     */
    const handleChildEvent = (name: string, event: ChildEvent): void => {
      if (event.type === "message_end" && event.role === "assistant") {
        if (event.fullText) record(name, "assistant", event.fullText);
        if (event.usage) {
          setProgress(name, "running", `turn ${event.usage.turns}`, event.text, { phase: "waiting" });
        } else {
          setProgress(name, "running", undefined, event.text, { phase: "waiting" });
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        record(name, "tool", toolCallText(event.toolName, event.args));
        setProgress(name, "running", undefined, undefined, { phase: "tool", toolName: event.toolName });
        return;
      }
      if (event.type === "tool_execution_update") {
        // 流式输出只刷新时间（保持工具阶段与工具名）。
        setProgress(name, "running", undefined, undefined, { phase: "tool", toolName: event.toolName });
        return;
      }
      if (event.type === "tool_execution_end") {
        record(name, "tool", toolResultText(event.toolName, event.text));
        setProgress(name, "running", undefined, undefined, { phase: "waiting" });
        return;
      }
      if (event.type === "error") {
        record(name, "error", `${event.code}: ${event.message}`);
      }
    };

    // Plan: resolve members up front (unknown names never spawn anything).
    const planned: PlannedDispatch[] = [];
    for (const item of request.tasks) {
      const member = deps.team.members.find((m) => m.name === item.agent);
      if (!member) {
        planned.push({
          agent: item.agent,
          task: item.task,
          preError: {
            code: "MEMBER_NOT_FOUND",
            message: `unknown agent "${item.agent}". Available members:\n${rosterText(deps.team)}`,
          },
        });
        continue;
      }
      planned.push({ agent: member.name, member, task: item.task });
    }

    // Worktree setup (sequential — cheap git ops, avoids racing git index).
    const worktreeRunId = deps.worktreeRunId ?? deps.runId;
    for (const plan of planned) {
      if (!plan.member?.worktree || plan.preError) continue;
      setProgress(plan.member.name, "running", "创建 worktree…");
      const worktreePath = path.join(deps.worktreeRoot, worktreeRunId, plan.member.name);
      const branch = memberWorktreeBranch(worktreeRunId, plan.member.name);
      const created = await createWorktree({ git, repoCwd: deps.cwd, worktreePath, branch });
      if (created.ok) {
        plan.worktree = created.value;
        if (created.value.switchedBackFrom) {
          setProgress(plan.member.name, "running", `worktree 已从 ${created.value.switchedBackFrom} 切回 ${branch}`);
        }
      } else {
        plan.preError = { code: created.code, message: created.message };
      }
    }

    for (const plan of planned) {
      const name = plan.member?.name ?? "?";
      statuses.set(name, {
        name,
        status: plan.preError ? "failed" : plan.worktree ? "running" : "queued",
        ...(plan.preError ? { note: shortMessage(`${plan.preError.code}: ${plan.preError.message}`) } : {}),
      });
    }
    emitProgress();

    const runOne = async (plan: PlannedDispatch): Promise<MemberRunResult> => {
      const name = plan.member?.name ?? plan.agent;
      const startMs = Date.now();
      if (plan.preError || !plan.member) {
        record(name, "error", `${plan.preError?.code ?? "CHILD_FAILED"}: ${plan.preError?.message ?? "unknown error"}`);
        return {
          name,
          ok: false,
          status: "failed",
          result: "",
          summary: "",
          usage: emptyUsage(),
          durationMs: 0,
          error: {
            code: plan.preError?.code ?? "CHILD_FAILED",
            message: plan.preError?.message ?? "unknown error",
          },
        };
      }

      const backend = plan.member.backend;
      if (backend) {
        // 外部 CLI 成员（v1: codex / claude）：解析可执行文件 → 构建 args →
        // 进程骨架复用 runChildPi（abort/SIGTERM→SIGKILL/stderr/pid 全同）；
        // stdout JSONL 走 onWire 喂解析器，结果取 parser 而非 pi 口径的 outcome。
        const resolved = resolveCli(backend);
        if (!resolved.ok) {
          record(name, "error", `${resolved.code}: ${resolved.message}`);
          setProgress(name, "failed", shortMessage(`${resolved.code}: ${resolved.message}`));
          const result: MemberRunResult = {
            name,
            ok: false,
            status: "failed",
            result: "",
            summary: "",
            usage: emptyUsage(),
            durationMs: 0,
            error: { code: resolved.code, message: resolved.message },
          };
          if (plan.worktree) result.worktree = plan.worktree;
          return result;
        }
        const args = buildExternalArgs(
          backend,
          { ...(plan.member.model ? { model: plan.member.model } : {}), prompt: plan.member.prompt },
          plan.task,
        );
        const parser = createExternalParser(backend);

        record(name, "task", plan.task);
        setProgress(name, "running");
        try {
          const outcome = await runChildPi({
            command: resolved.value.command,
            args,
            cwd: plan.worktree?.path ?? deps.cwd,
            env: stripLeaderEnv(),
            spawn,
            signal,
            killGraceMs: deps.killGraceMs,
            // stdin 不传 = 默认 ignore（探测 P5：argv prompt + ignore 不挂起）。
            onWire: (message) => {
              for (const event of parser.feed(message)) handleChildEvent(name, event);
            },
          });
          const durationMs = Date.now() - startMs;
          const aborted = signal?.aborted === true;
          const finalized = parser.finalize();
          const rawText = parser.finalText || outcome.stderr || "(no output)";
          const errorMessage = finalized.errorMessage ?? (outcome.stderr.trim().length > 0 ? outcome.stderr : undefined);
          const result = finalizeMember({
            name,
            aborted,
            outcome,
            ...(errorMessage !== undefined ? { errorMessage } : {}),
            finalTurnError: finalized.failed,
            hasFinalTurn: parser.finalText.length > 0 || parser.usage.turns > 0 || finalized.failed,
            rawText,
            usage: parser.usage,
            durationMs,
            fallbackMessage: `${backend} CLI 未报告错误消息`,
          });
          if (plan.worktree) result.worktree = plan.worktree;
          setProgress(
            name,
            result.status,
            result.ok ? `turn ${parser.usage.turns}` : shortMessage(`${result.error?.code}: ${result.error?.message}`),
            result.ok ? shortMessage(rawText) : undefined,
          );
          const secs = Math.round(durationMs / 100) / 10;
          record(
            name,
            "system",
            memberSystemLine(result, secs, parser.usage.cost, parser.usage.turns),
          );
          if (result.error) record(name, "error", `${result.error.code}: ${result.error.message}`);
          return result;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          setProgress(name, "failed", shortMessage(`CHILD_FAILED: ${message}`));
          record(name, "error", `CHILD_FAILED: failed to start ${backend} subprocess: ${message}`);
          const result: MemberRunResult = {
            name,
            ok: false,
            status: "failed",
            result: "",
            summary: "",
            usage: emptyUsage(),
            durationMs: Date.now() - startMs,
            error: {
              code: "CHILD_FAILED",
              message: truncateMessage(`failed to start ${backend} subprocess: ${message}`),
            },
          };
          if (plan.worktree) result.worktree = plan.worktree;
          return result;
        }
      }

      // The task travels through argv, so this child must not get a writable
      // stdin: pi's `-p` mode waits for stdin EOF before it works, and nobody
      // ever closes the pipe — the dispatch would hang forever (v1.15.0).
      const args: string[] = ["--mode", "json", "-p", "--no-session"];
      if (plan.member.model) args.push("--model", plan.member.model);
      if (plan.member.tools && plan.member.tools.length > 0) args.push("--tools", plan.member.tools.join(","));
      args.push("--exclude-tools", DERIVED_AGENT_TOOL_DENYLIST.join(","));
      if (plan.member.prompt.trim()) args.push("--append-system-prompt", `team-tmp://${plan.member.prompt}`);
      args.push(`Task: ${plan.task}`);

      const invocation = deps.piCommand ? { command: deps.piCommand, args } : getPiInvocation(args);

      record(name, "task", plan.task);
      setProgress(name, "running");
      try {
        const outcome = await runChildPi({
          command: invocation.command,
          args: invocation.args,
          cwd: plan.worktree?.path ?? deps.cwd,
          env: stripLeaderEnv(),
          spawn,
          signal,
          killGraceMs: deps.killGraceMs,
          onEvent: (event) => handleChildEvent(name, event),
        });
        const durationMs = Date.now() - startMs;
        const aborted = signal?.aborted === true;
        const rawText = outcome.finalText || outcome.stderr || "(no output)";
        const errorMessage = outcome.errorMessage ?? (outcome.stderr.trim().length > 0 ? outcome.stderr : undefined);
        const result = finalizeMember({
          name,
          aborted,
          outcome,
          ...(errorMessage !== undefined ? { errorMessage } : {}),
          hasFinalTurn: outcome.usage.turns > 0,
          rawText,
          usage: outcome.usage,
          durationMs,
          fallbackMessage: "pi 子进程未报告错误消息",
        });
        if (plan.worktree) result.worktree = plan.worktree;
        setProgress(
          name,
          result.status,
          result.ok ? `turn ${outcome.usage.turns}` : shortMessage(`${result.error?.code}: ${result.error?.message}`),
          result.ok ? shortMessage(rawText) : undefined,
        );
        const secs = Math.round(durationMs / 100) / 10;
        record(name, "system", memberSystemLine(result, secs, outcome.usage.cost, outcome.usage.turns));
        if (result.error) record(name, "error", `${result.error.code}: ${result.error.message}`);
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setProgress(name, "failed", shortMessage(`CHILD_FAILED: ${message}`));
        record(name, "error", `CHILD_FAILED: failed to start pi subprocess: ${message}`);
        const result: MemberRunResult = {
          name,
          ok: false,
          status: "failed",
          result: "",
          summary: "",
          usage: emptyUsage(),
          durationMs: Date.now() - startMs,
          error: { code: "CHILD_FAILED", message: truncateMessage(`failed to start pi subprocess: ${message}`) },
        };
        if (plan.worktree) result.worktree = plan.worktree;
        return result;
      }
    };

    const results = await mapWithConcurrency(planned, MAX_PARALLEL_MEMBERS, runOne);

    const totalUsage = emptyUsage();
    for (const result of results) {
      totalUsage.cost += result.usage.cost;
      totalUsage.input += result.usage.input;
      totalUsage.output += result.usage.output;
    }

    return { ok: true, value: { results, text: buildDispatchReport(results) } };
  };
}

/**
 * Extracts the dispatch's combined member usage from a team_dispatch tool
 * `details` payload as seen in the leader's JSON event stream (cockpit-side
 * budget folding). Lenient: malformed shapes yield undefined.
 */
export function parseDispatchTotalUsage(details: unknown): { input: number; output: number; cost: number } | undefined {
  if (details === null || typeof details !== "object") return undefined;
  const raw = (details as { totalUsage?: unknown }).totalUsage;
  if (raw === null || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: num(usage.input), output: num(usage.output), cost: num(usage.cost) };
}

/**
 * Extracts per-member dispatch results (status/summary/latest/usage/worktree)
 * from a team_dispatch tool `details` payload as seen in the leader's JSON
 * event stream. Lenient: malformed shapes yield undefined.
 */
export function parseDispatchMemberResults(details: unknown): DispatchMemberDetail[] | undefined {
  if (details === null || typeof details !== "object") return undefined;
  const members = (details as { members?: unknown }).members;
  if (!Array.isArray(members)) return undefined;
  const results: DispatchMemberDetail[] = [];
  for (const item of members) {
    if (item === null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== "string" || typeof raw.status !== "string") continue;
    results.push({
      name: raw.name,
      ok: raw.ok === true,
      status: raw.status as MemberProgressStatus,
      ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
      ...(typeof raw.latest === "string" ? { latest: raw.latest } : {}),
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      ...(typeof raw.warning === "string" ? { warning: raw.warning } : {}),
      ...(raw.diagnostics !== null && typeof raw.diagnostics === "object"
        ? { diagnostics: raw.diagnostics as MemberDiagnostics }
        : {}),
      ...(raw.phase === "tool" || raw.phase === "waiting" ? { phase: raw.phase } : {}),
      ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
      ...(typeof raw.lastActivityAtMs === "number" && Number.isFinite(raw.lastActivityAtMs)
        ? { lastActivityAtMs: raw.lastActivityAtMs }
        : {}),
      ...(raw.usage !== null && typeof raw.usage === "object" ? { usage: raw.usage as AgentUsage } : {}),
      ...(raw.worktree !== null && typeof raw.worktree === "object"
        ? { worktree: raw.worktree as { path: string; branch: string; switchedBackFrom?: string } }
        : {}),
      ...(raw.error !== null && typeof raw.error === "object" ? { error: raw.error as { code: string; message: string } } : {}),
    });
  }
  return results.length > 0 ? results : undefined;
}
