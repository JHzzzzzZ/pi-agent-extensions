/**
 * agent-team — leader → human questions (RPC dialog bridge)
 *
 * The leader child runs `pi --mode rpc`, so its `ctx.ui.select/input` dialogs
 * travel over the RPC Extension UI protocol: an `extension_ui_request` line
 * on the child's stdout, resolved by an `extension_ui_response` line on its
 * stdin. This module owns both ends of that bridge:
 *
 * - leader side (`askLeaderQuestion` / `buildAskDialog` / `formatAskResult`):
 *   maps the `team_ask` tool params onto a dialog with a bounded timeout and
 *   the tool's abort signal.
 * - cockpit side (`AskChannel` + `AskPort`): receives the wire request, asks
 *   the main session (host dialog), and writes the answer back over the same
 *   stdin channel the steer path uses.
 *
 * Fail-closed invariants: every wait is bounded, no path may hang the run,
 * and a question that cannot be answered (timeout / cancel / no UI / run
 * stop) degrades to a cancelled response so the leader proceeds on its own
 * judgment instead of idling to the budget cap.
 */

import {
  ASK_TIMEOUT_DEFAULT_MS,
  ASK_TIMEOUT_MAX_MS,
  ASK_TIMEOUT_MIN_MS,
  truncateUtf8,
} from "./types.ts";

/** Dialog methods the RPC Extension UI protocol expects a response for. */
export const ASK_METHODS = ["select", "confirm", "input", "editor"] as const;
export type AskMethod = (typeof ASK_METHODS)[number];

/** Cockpit-side backstop: fire this long after the dialog's own timeout. */
export const ASK_BACKSTOP_MARGIN_MS = 5000;

/** Maximum answer text handed back to the leader (and into transcripts). */
export const MAX_ASK_ANSWER_BYTES = 4096;

/** Maximum question length embedded in the host dialog title. */
const MAX_ASK_TITLE_CHARS = 300;

/** One parsed dialog request from the leader's stdout. */
export interface AskRequest {
  id: string;
  method: AskMethod;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Wire wait in ms (leader-side tool already clamps; cockpit re-caps). */
  timeoutMs?: number;
}

/** Result of presenting a question in the main session. */
export type AskOutcome =
  | { kind: "answer"; value: string | boolean }
  | { kind: "cancelled" }
  | { kind: "timeout" }
  | { kind: "unavailable" };

/** Main-session dialog port (implemented over ctx.ui; never throws). */
export interface AskPort {
  present(request: AskRequest, signal: AbortSignal): Promise<AskOutcome>;
}

/**
 * Parses one raw wire line. Only dialog methods are interpreted; fire-and-
 * forget requests (notify/setStatus/setWidget…) and malformed lines return
 * null so the caller keeps its historical tolerate-and-ignore behaviour.
 */
export function parseAskRequest(message: Record<string, unknown>): AskRequest | null {
  if (message.type !== "extension_ui_request") return null;
  const method = message.method;
  if (typeof method !== "string" || !ASK_METHODS.includes(method as AskMethod)) return null;
  const id = typeof message.id === "string" && message.id.length > 0 ? message.id : null;
  const title = typeof message.title === "string" && message.title.length > 0 ? message.title : null;
  if (!id || !title) return null;
  const options = Array.isArray(message.options)
    ? message.options.filter((option): option is string => typeof option === "string")
    : undefined;
  if (method === "select" && (options === undefined || options.length === 0)) return null;
  const timeout =
    typeof message.timeout === "number" && Number.isFinite(message.timeout) && message.timeout > 0
      ? Math.round(message.timeout)
      : undefined;
  return {
    id,
    method: method as AskMethod,
    title,
    ...(typeof message.message === "string" ? { message: message.message } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(typeof message.placeholder === "string" ? { placeholder: message.placeholder } : {}),
    ...(typeof message.prefill === "string" ? { prefill: message.prefill } : {}),
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
  };
}

/** Cockpit-side wait: default 10 minutes, hard cap 30 minutes (no floor). */
export function resolveAskTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return ASK_TIMEOUT_DEFAULT_MS;
  return Math.min(ASK_TIMEOUT_MAX_MS, Math.round(timeoutMs));
}

/** Leader-tool wait: default 10 minutes, clamped to [30s, 30min]. */
export function resolveAskToolTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return ASK_TIMEOUT_DEFAULT_MS;
  return Math.min(ASK_TIMEOUT_MAX_MS, Math.max(ASK_TIMEOUT_MIN_MS, Math.round(timeoutMs)));
}

/** Serializes one dialog response line for the leader's RPC stdin. */
export function askResponseLine(request: AskRequest, outcome: AskOutcome): string {
  const base = { type: "extension_ui_response", id: request.id };
  if (outcome.kind === "answer") {
    if (request.method === "confirm") {
      return `${JSON.stringify({ ...base, confirmed: outcome.value === true })}\n`;
    }
    const value = typeof outcome.value === "string" ? outcome.value : String(outcome.value);
    return `${JSON.stringify({ ...base, value })}\n`;
  }
  return `${JSON.stringify({ ...base, cancelled: true })}\n`;
}

export interface AskChannelDeps {
  /** Main-session dialog port; absent = fail-closed with `unavailable`. */
  port?: AskPort;
  /** Writes one JSON line to the leader's RPC stdin (best-effort). */
  write: (line: string) => void;
  /** Run abort signal (team_stop / budget / session shutdown). */
  signal?: AbortSignal;
  /** Called when a question is actually presented (status/transcript seams). */
  onQuestion?: (request: AskRequest) => void;
  /** Called once per question with its terminal outcome. */
  onOutcome?: (request: AskRequest, outcome: AskOutcome) => void;
  /** Extra margin over the dialog timeout before the backstop fires. */
  backstopMarginMs?: number;
}

interface ActiveAsk {
  request: AskRequest;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Cockpit-side bridge: one dialog visible at a time (FIFO), each wait bounded
 * by the requested timeout plus a backstop margin, cancelled on run abort,
 * dropped on dispose. Every observer/write failure is swallowed — a question
 * failure must never break the run.
 */
export class AskChannel {
  private readonly deps: AskChannelDeps;
  private readonly queue: AskRequest[] = [];
  private readonly seen = new Set<string>();
  private active: ActiveAsk | null = null;
  private disposed = false;
  private readonly onAbort: (() => void) | undefined;

  constructor(deps: AskChannelDeps) {
    this.deps = deps;
    if (deps.signal) {
      this.onAbort = () => this.cancelPending();
      if (deps.signal.aborted) queueMicrotask(this.onAbort);
      else deps.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  /** Feeds one raw wire line (fire-and-forget; parsing failures ignored). */
  handle(message: Record<string, unknown>): void {
    if (this.disposed) return;
    const request = parseAskRequest(message);
    if (!request || this.seen.has(request.id)) return;
    this.seen.add(request.id);
    this.queue.push(request);
    this.pump();
  }

  /** Run settled: drop the in-flight dialog and any queued questions. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPending();
    this.detachAbort();
  }

  private cancelPending(): void {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    this.active = null;
    const queued = this.queue.splice(0, this.queue.length);
    if (active) {
      clearTimeout(active.timer);
      active.controller.abort();
      this.respond(active.request, { kind: "cancelled" });
    }
    for (const request of queued) this.respond(request, { kind: "cancelled" });
    this.detachAbort();
  }

  private clearPending(): void {
    const active = this.active;
    this.active = null;
    this.queue.length = 0;
    if (active) {
      clearTimeout(active.timer);
      active.controller.abort();
    }
  }

  private detachAbort(): void {
    if (this.deps.signal && this.onAbort) this.deps.signal.removeEventListener("abort", this.onAbort);
  }

  private pump(): void {
    if (this.disposed || this.active !== null || this.queue.length === 0) return;
    const request = this.queue.shift();
    if (!request) return;
    const controller = new AbortController();
    const waitMs =
      resolveAskTimeout(request.timeoutMs) + (this.deps.backstopMarginMs ?? ASK_BACKSTOP_MARGIN_MS);
    const timer = setTimeout(() => this.settle(request, { kind: "timeout" }), waitMs);
    if (typeof (timer as { unref?: unknown }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.active = { request, controller, timer };
    try {
      this.deps.onQuestion?.(request);
    } catch {
      /* observer failures never break the run */
    }
    void this.present(request, controller.signal);
  }

  private async present(request: AskRequest, signal: AbortSignal): Promise<void> {
    let outcome: AskOutcome;
    try {
      outcome = this.deps.port ? await this.deps.port.present(request, signal) : { kind: "unavailable" };
    } catch {
      outcome = { kind: "cancelled" };
    }
    this.settle(request, outcome);
  }

  /** First outcome per request wins; late dialog resolutions are dropped. */
  private settle(request: AskRequest, outcome: AskOutcome): void {
    const active = this.active;
    if (!active || active.request.id !== request.id) return;
    clearTimeout(active.timer);
    this.active = null;
    active.controller.abort();
    this.respond(request, outcome);
    try {
      this.deps.onOutcome?.(request, outcome);
    } catch {
      /* observer failures never break the run */
    }
    this.pump();
  }

  private respond(request: AskRequest, outcome: AskOutcome): void {
    try {
      this.deps.write(askResponseLine(request, outcome));
    } catch {
      /* stdin may already be closed — the run settles regardless */
    }
  }
}

// ---------------------------------------------------------------------------
// Leader side (the team_ask tool)
// ---------------------------------------------------------------------------

/** team_ask tool parameters. */
export interface AskToolParams {
  question: string;
  /** When present the human picks from the list; otherwise free text. */
  options?: string[];
  /** Wait for an answer (tool clamps to [30s, 30min]; default 10 minutes). */
  timeoutMs?: number;
}

/** Structural dialog surface the leader tool needs (subset of ctx.ui). */
export interface AskDialogOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface AskDialogUi {
  input(title: string, placeholder?: string, opts?: AskDialogOptions): Promise<string | undefined>;
  select(title: string, options: string[], opts?: AskDialogOptions): Promise<string | undefined>;
}

export interface AskDialogRequest {
  method: "select" | "input";
  title: string;
  options?: string[];
  placeholder?: string;
}

export interface AskToolOutcome {
  answered: boolean;
  answer?: string;
}

export interface AskToolResult {
  text: string;
  details: { answered: boolean; answer?: string };
}

/** `[team] question` one-liner for the host dialog title. */
export function buildAskTitle(teamName: string, question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  const bounded = flat.length > MAX_ASK_TITLE_CHARS ? `${flat.slice(0, MAX_ASK_TITLE_CHARS)}…` : flat;
  return `[${teamName}] ${bounded}`;
}

/** Maps tool params onto the dialog shape (options ⇒ select, else input). */
export function buildAskDialog(teamName: string, params: AskToolParams): AskDialogRequest {
  const title = buildAskTitle(teamName, params.question);
  if (params.options && params.options.length > 0) return { method: "select", title, options: params.options };
  return { method: "input", title, placeholder: "输入回答后回车；Esc 取消" };
}

/** UTF-8 bounded answer text for the tool result. */
export function clampAskAnswer(answer: string): string {
  return truncateUtf8(answer, MAX_ASK_ANSWER_BYTES);
}

/**
 * Runs one leader question through the child's RPC dialog methods. Any
 * missing/blank answer (timeout, Esc, no main-session UI, stale ctx) maps to
 * `{ answered: false }` — the tool never throws.
 */
export async function askLeaderQuestion(
  ui: AskDialogUi,
  teamName: string,
  params: AskToolParams,
  signal?: AbortSignal,
): Promise<AskToolOutcome> {
  const dialog = buildAskDialog(teamName, params);
  const timeout = resolveAskToolTimeout(params.timeoutMs);
  const opts: AskDialogOptions = { timeout, ...(signal ? { signal } : {}) };
  try {
    const value =
      dialog.method === "select"
        ? await ui.select(dialog.title, dialog.options ?? [], opts)
        : await ui.input(dialog.title, dialog.placeholder, opts);
    if (typeof value !== "string" || value.trim().length === 0) return { answered: false };
    return { answered: true, answer: value.trim() };
  } catch {
    return { answered: false };
  }
}

/** Formats the tool result: answered text or the proceed-on-your-own nudge. */
export function formatAskResult(outcome: AskToolOutcome): AskToolResult {
  if (outcome.answered && outcome.answer !== undefined) {
    const answer = clampAskAnswer(outcome.answer);
    return { text: `用户回答：\n${answer}`, details: { answered: true, answer } };
  }
  return {
    text: "未获回答（可能原因：超时 / 用户取消 / 主会话无 UI）。不要重复追问；请基于最合理的假设继续任务，并在最终报告中说明该假设。",
    details: { answered: false },
  };
}

/** Transcript entry for the question as it reaches the main session. */
export function questionEntryText(request: AskRequest): string {
  const options = request.options && request.options.length > 0 ? `\n选项：${request.options.join(" / ")}` : "";
  return `提问：${request.title}${options}`;
}

/** Transcript entry for the question outcome (answer or degradation reason). */
export function outcomeEntryText(outcome: AskOutcome): { kind: "answer" | "system"; text: string } {
  switch (outcome.kind) {
    case "answer": {
      const value = typeof outcome.value === "boolean" ? (outcome.value ? "是" : "否") : outcome.value;
      return { kind: "answer", text: `回答：${clampAskAnswer(value)}` };
    }
    case "cancelled":
      return { kind: "system", text: "未获回答（用户取消）" };
    case "timeout":
      return { kind: "system", text: "未获回答（超时）" };
    case "unavailable":
      return { kind: "system", text: "未获回答（主会话无 UI）" };
  }
}
