/**
 * goal - Pi 会话目标循环扩展(参考 Claude Code /goal)
 *
 * `/goal <条件>` 设置一个完成条件,agent 跨回合自动推进:每个 agent 回合结束
 * (agent_settled)后,由独立 LLM 评估器(默认当前会话模型的一次小调用,限
 * maxTokens)根据目标 + 最近回合 assistant 输出判定 {met, reason};未达成则
 * 以评估原因为指导自动开启下一回合(triggerTurn + followUp,与 pwr 同款续跑
 * 通道),达成后自动清除目标并写入结果条目。不设轮次上限,可在目标文本中自限
 * (如 "or stop after 20 turns")。
 *
 * 用法:
 *   /goal <条件>            设置目标并立即开始第一轮
 *   /goal                   查看状态(目标/已评估轮数/时长/评估器最近判定)
 *   /goal:status            同上(冒号副本)
 *   /goal:clear|:stop|:off|:reset|:none|:cancel   清除目标(别名共享同一动作)
 *   /goal:resume            手动中断/评估器连续失败暂停后恢复
 *
 * 安装:复制本目录到 ~/.pi/agent/extensions/goal/ 或 <项目>/.pi/extensions/goal/,
 *       在 Pi 中执行 /reload。卸载即删除目录。
 * 测试:node --experimental-strip-types --test goal/index.test.ts
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { startAlignedTicker } from "./aligned-ticker.ts";

// ===== 常量 =====

export const GOAL_COMMAND = "goal";
/** 会话持久化条目:data = { goal: string | null },null 表示已清除(水合取最后一条) */
export const GOAL_STATE_ENTRY = "goal-state-v1";
/** 达成结果条目:仅作会话记录,不参与水合 */
export const GOAL_RESULT_ENTRY = "goal-result-v1";
/** 续跑自定义消息类型 */
export const GOAL_CONTINUE_MESSAGE = "goal-continue";
/** 排序带前缀：宿主按 key localeCompare 拼接 footer 状态行（docs/cross/status-bar.md） */
export const STATUS_KEY = "10:goal";
/** 段分隔前缀（跨插件契约 docs/cross/status-bar.md）：每段状态文本以 `│ ` 开头 */
export const STATUS_SEPARATOR = "│ ";
/** 活动 goal 期间的状态行刷新间隔（对齐秒边界） */
const STATUS_TICK_MS = 1000;
/** 状态行里目标文本的显示列上限（CJK/全角按 2 列计） */
const MAX_STATUS_GOAL_WIDTH = 20;

/** 对齐 Claude Code /goal:条件最长 4000 字符 */
export const MAX_GOAL_LENGTH = 4000;
/** 送入评估器的证据(最近回合 assistant 文本)尾部上限 */
export const MAX_EVIDENCE_CHARS = 12_000;
export const MAX_REASON_CHARS = 500;
export const MAX_EVALUATOR_TOKENS = 512;
/** 评估器连续失败达到该次数才暂停(瞬时失败不杀循环) */
export const MAX_EVALUATOR_FAILURES = 3;

const CLEAR_ALIASES = ["clear", "stop", "off", "reset", "none", "cancel"] as const;

/** 冒号子命令（v1.3.0）：独立静态注册命令名。 */
export const GOAL_SUBCOMMANDS = {
  status: "goal:status",
  clear: "goal:clear",
  stop: "goal:stop",
  off: "goal:off",
  reset: "goal:reset",
  none: "goal:none",
  cancel: "goal:cancel",
  resume: "goal:resume",
} as const;

/**
 * 旧空格子命令 → 新命令 + 用法。裸 `/goal` 命中时只提示改名、绝不执行
 * （防止 `/goal clear` 被误设为目标文本）。`status` 不在表内：`/goal status`
 * 仍是目标文本（裸命令从未有 status 子命令，既有语义不变）。
 */
export const RETIRED_GOAL_SUBCOMMANDS: Record<string, { command: string; usage: string }> = {
  clear: { command: GOAL_SUBCOMMANDS.clear, usage: "/goal:clear" },
  stop: { command: GOAL_SUBCOMMANDS.stop, usage: "/goal:stop" },
  off: { command: GOAL_SUBCOMMANDS.off, usage: "/goal:off" },
  reset: { command: GOAL_SUBCOMMANDS.reset, usage: "/goal:reset" },
  none: { command: GOAL_SUBCOMMANDS.none, usage: "/goal:none" },
  cancel: { command: GOAL_SUBCOMMANDS.cancel, usage: "/goal:cancel" },
  resume: { command: GOAL_SUBCOMMANDS.resume, usage: "/goal:resume" },
};
/** opencode 系模型( provider id 或 baseUrl host )需注入 x-opencode-session 会话头(对齐宿主 provider-attribution) */
const OPENCODE_HOST = "opencode.ai";

// ===== 类型 =====

export type EvaluatorResult =
  | { ok: true; met: boolean; reason: string }
  | { ok: false; code: "no-model" | "no-provider" | "auth" | "evaluator-error" | "bad-verdict"; message?: string };

export interface GoalEvaluatorInput {
  goal: string;
  evidence: string;
  lastReason?: string;
}

export type GoalEvaluator = (input: GoalEvaluatorInput, ctx: ExtensionContext) => Promise<EvaluatorResult>;

export type RuntimeState =
  | { phase: "idle" }
  | { phase: "active"; goal: string; startedAtMs: number; turns: number; lastReason?: string }
  | { phase: "paused"; goal: string; startedAtMs: number; turns: number; lastReason?: string };

export interface GoalResultPayload {
  goal: string;
  turns: number;
  elapsedMs: number;
  reason: string;
  achievedAt: string;
}

export interface GoalDeps {
  /** 注入自定义评估器(测试用);缺省用当前会话模型的真实评估器 */
  evaluate?: GoalEvaluator;
  /** 注入时钟(测试用);缺省 Date.now */
  nowMs?: () => number;
}

// ===== 纯函数:参数解析 =====

export type ParsedGoalArgs =
  | { action: "set"; goal: string }
  | { action: "status" }
  | { action: "invalid"; reason: string };

/** 裸 `/goal` 解析：空参 = 状态，其余整体为目标文本（管理子命令已拆为冒号命令）。 */
export function parseGoalArgs(args: string): ParsedGoalArgs {
  const trimmed = (args ?? "").trim();
  if (!trimmed) return { action: "status" };
  if (trimmed.length > MAX_GOAL_LENGTH) {
    return { action: "invalid", reason: `目标过长(${trimmed.length} > ${MAX_GOAL_LENGTH} 字符)。` };
  }
  return { action: "set", goal: trimmed };
}

// ===== 纯函数:评估器 prompt / 续跑消息 / verdict 解析 =====

export function buildEvaluatorPrompt(input: GoalEvaluatorInput): string {
  const lines = [
    "You are a strict goal-completion evaluator for a coding agent session.",
    "",
    "GOAL:",
    input.goal,
    "",
  ];
  if (input.lastReason) lines.push("PREVIOUS EVALUATION REASON:", input.lastReason, "");
  lines.push(
    "RECENT AGENT OUTPUT (evidence):",
    input.evidence.trim() ? input.evidence : "(no assistant output captured)",
    "",
    "Decide whether the goal is FULLY met based only on the evidence above.",
    "Be strict: partial progress, plans, or unverified claims do not count as met.",
    "If the evidence does not clearly demonstrate completion, the goal is not met.",
    "",
    'Respond with ONLY a JSON object: {"met": true|false, "reason": "<one or two sentences, in the same language as the goal>"}',
  );
  return lines.join("\n");
}

export function buildContinueMessage(goal: string, reason: string, turns: number): string {
  return [
    `[goal] 第 ${turns} 轮评估:目标尚未达成。`,
    `目标:${goal}`,
    `评估器反馈:${reason}`,
    "请继续向目标推进,避免重复已失败的路线;结束时在回复中呈现可验证的完成证据(如测试输出、命令退出码)。完成后无需额外标记,评估器会自动复核。",
  ].join("\n");
}

/** 从模型输出中截取第一个括号平衡的 JSON 对象(容忍 code fence 与前后说明文字) */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export type Verdict = { ok: true; met: boolean; reason: string } | { ok: false };

export function parseVerdict(text: string): Verdict {
  const raw = extractJsonObject(text ?? "");
  if (!raw) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false };
  const obj = parsed as { met?: unknown; reason?: unknown };
  if (typeof obj.met !== "boolean") return { ok: false };
  const reason = typeof obj.reason === "string" ? obj.reason : "";
  return {
    ok: true,
    met: obj.met,
    reason: reason.length > MAX_REASON_CHARS ? reason.slice(0, MAX_REASON_CHARS) : reason,
  };
}

// ===== 纯函数:状态行 / 时长 / 截断 / 证据提取 =====

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${String(sec).padStart(2, "0")}s`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, "0")}m`;
}

/** CJK/全角字符判定（本地实现，与 run-timer 同款；不做跨插件共享） */
export function isCJK(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    (cp >= 0x3000 && cp <= 0x303f)
  );
}

/** 终端显示列数（CJK/全角按 2 列） */
export function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) n += isCJK(ch) ? 2 : 1;
  return n;
}

/** 按显示列截断（超出时保留 ≤ max-1 列 + `…`，截断结果不超过 max 列） */
export function truncateText(text: string, maxVisual: number): string {
  if (visualLen(text) <= maxVisual) return text;
  let result = "";
  let width = 0;
  for (const ch of text) {
    const charWidth = isCJK(ch) ? 2 : 1;
    if (width + charWidth > maxVisual - 1) break;
    result += ch;
    width += charWidth;
  }
  return result + "…";
}

export interface StatusInfo {
  phase: "active" | "paused";
  goal: string;
  turns: number;
  startedAtMs: number;
}

export function buildStatusLine(info: StatusInfo, nowMsValue: number): string {
  const elapsed = formatElapsed(Math.max(0, nowMsValue - info.startedAtMs));
  const goal = truncateText(info.goal, MAX_STATUS_GOAL_WIDTH);
  return info.phase === "paused"
    ? `⏸ ${goal} · 已暂停 · ${elapsed}`
    : `◎ ${goal} · ${info.turns}轮 · ${elapsed}`;
}

/** 提取 agent 回合中 assistant 消息的文本内容(忽略 thinking/toolResult),超限取尾部 */
export function extractAssistantText(messages: unknown[]): string {
  const parts: string[] = [];
  for (const message of messages ?? []) {
    const msg = message as { role?: unknown; content?: unknown };
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const item = block as { type?: unknown; text?: unknown };
      if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) parts.push(item.text);
    }
  }
  const joined = parts.join("\n\n");
  return joined.length > MAX_EVIDENCE_CHARS ? joined.slice(-MAX_EVIDENCE_CHARS) : joined;
}

// ===== 纯函数:opencode 会话头(对齐宿主 pi-coding-agent/core/provider-attribution 的 getSessionHeaders) =====

/** 判定模型是否属于 opencode 系:provider id 为 opencode/opencode-go,或 baseUrl host 为 opencode.ai */
export function isOpencodeModel(model: { provider?: unknown; baseUrl?: unknown }): boolean {
  if (model.provider === "opencode" || model.provider === "opencode-go") return true;
  try {
    return new URL(String(model.baseUrl)).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}

/** 有 sessionId 才返回会话头;无则 undefined(与宿主 if (!sessionId) return undefined 一致) */
export function buildOpencodeSessionHeaders(sessionId?: string): Record<string, string> | undefined {
  if (!sessionId) return undefined;
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

/** 防御式取会话 id:sessionManager 缺失/getSessionId 不存在或抛异常均视为无 sessionId */
function getSessionIdSafe(ctx: ExtensionContext): string | undefined {
  try {
    const id = (ctx.sessionManager as { getSessionId?: unknown } | undefined)?.getSessionId;
    return typeof id === "function" ? (id.call(ctx.sessionManager) as string | undefined) : undefined;
  } catch {
    return undefined;
  }
}

// ===== 真实评估器:当前会话模型的一次小调用 =====

export function createModelEvaluator(options: { nowMs?: () => number } = {}): GoalEvaluator {
  const nowMs = options.nowMs ?? (() => Date.now());
  return async (input, ctx) => {
    const model = ctx.model;
    if (!model) return { ok: false, code: "no-model" };
    let provider: ReturnType<typeof ctx.modelRegistry.getProvider>;
    try {
      provider = ctx.modelRegistry.getProvider(model.provider);
    } catch (error) {
      return { ok: false, code: "evaluator-error", message: error instanceof Error ? error.message : String(error) };
    }
    if (!provider) return { ok: false, code: "no-provider", message: model.provider };
    let auth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
    try {
      auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    } catch (error) {
      return { ok: false, code: "auth", message: error instanceof Error ? error.message : String(error) };
    }
    if (!auth.ok) return { ok: false, code: "auth", message: auth.error };
    // 评估器直调 provider.stream,绕过宿主 streamFn 的请求头合并;opencode 系模型(Console Go)强制要求
    // x-opencode-session,缺失返回 400 MissingSessionID——此处自行注入与宿主等价的会话头,
    // auth.headers 在后保持宿主合并顺序(请求头覆盖会话头)。
    const sessionHeaders = isOpencodeModel(model) ? buildOpencodeSessionHeaders(getSessionIdSafe(ctx)) : undefined;
    const message: UserMessage = { role: "user", content: buildEvaluatorPrompt(input), timestamp: nowMs() };
    let finalMessage: AssistantMessage | undefined;
    try {
      const stream = provider.stream(model, { messages: [message] }, {
        apiKey: auth.apiKey,
        headers: { ...sessionHeaders, ...auth.headers },
        maxTokens: MAX_EVALUATOR_TOKENS,
        signal: ctx.signal,
      });
      for await (const event of stream) {
        if (event.type === "done") finalMessage = event.message;
        else if (event.type === "error") {
          return { ok: false, code: "evaluator-error", message: event.error.errorMessage ?? event.error.stopReason };
        }
      }
    } catch (error) {
      return { ok: false, code: "evaluator-error", message: error instanceof Error ? error.message : String(error) };
    }
    const text = (finalMessage?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("");
    const verdict = parseVerdict(text);
    if (!verdict.ok) return { ok: false, code: "bad-verdict", message: text.slice(0, 200) };
    return { ok: true, met: verdict.met, reason: verdict.reason };
  };
}

// ===== 扩展工厂:命令 + hooks + 控制逻辑 =====

export function createGoalExtension(pi: ExtensionAPI, deps: GoalDeps = {}): void {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const evaluate = deps.evaluate ?? createModelEvaluator({ nowMs });

  let state: RuntimeState = { phase: "idle" };
  let evidenceTail = "";
  let userInterrupted = false;
  let evaluating = false;
  let evaluatorFailures = 0;
  /** 最近一次状态写入所绑定的 ctx（ticker 每秒重算“已运行”时长）。 */
  let statusCtx: ExtensionContext | undefined;
  let stopStatusTicker: (() => void) | undefined;
  /** 上次写入的状态文本指纹：相同则跳过 setStatus。 */
  let lastStatusText: string | null = null;

  function stopStatusClock(): void {
    if (stopStatusTicker) {
      stopStatusTicker();
      stopStatusTicker = undefined;
    }
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
      ctx.ui.notify(message, type);
    } catch {
      /* 通知失败不破坏会话 */
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    statusCtx = ctx;
    if (!ctx.hasUI) {
      stopStatusClock();
      return;
    }
    try {
      if (state.phase === "idle") {
        stopStatusClock();
        if (lastStatusText !== null) {
          lastStatusText = null;
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }
        return;
      }
      // 活动/暂停期间按对齐秒节拍刷新“已运行”时长（此前只靠事件点更新）。
      if (!stopStatusTicker) {
        stopStatusTicker = startAlignedTicker(() => {
          if (statusCtx) updateStatus(statusCtx);
        }, { intervalMs: STATUS_TICK_MS });
      }
      const line = STATUS_SEPARATOR + buildStatusLine(
        { phase: state.phase, goal: state.goal, turns: state.turns, startedAtMs: state.startedAtMs },
        nowMs(),
      );
      const text = ctx.mode === "tui" && ctx.ui.theme ? ctx.ui.theme.fg("dim", line) : line;
      if (text === lastStatusText) return;
      lastStatusText = text;
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      /* 状态行失败不破坏会话 */
    }
  }

  function notifyStatus(ctx: ExtensionContext): void {
    if (state.phase === "idle") {
      notify(ctx, "当前没有活跃的 goal。用法:/goal <完成条件>;清除:/goal:clear。");
      return;
    }
    const lines = [
      state.phase === "paused" ? `⏸ goal 已暂停:${state.goal}` : `◎ goal:${state.goal}`,
      `已评估轮数:${state.turns} · 已运行:${formatElapsed(Math.max(0, nowMs() - state.startedAtMs))}`,
      `评估器最近判定:${state.lastReason ?? "—"}`,
      state.phase === "paused" ? "使用 /goal:resume 恢复,或 /goal:clear 清除。" : "清除:/goal:clear。",
    ];
    notify(ctx, lines.join("\n"));
  }

  function persistState(goal: string | null): void {
    try {
      pi.appendEntry(GOAL_STATE_ENTRY, { goal });
    } catch {
      /* 持久化失败不破坏会话 */
    }
  }

  function persistResult(result: GoalResultPayload): void {
    try {
      pi.appendEntry(GOAL_RESULT_ENTRY, result);
    } catch {
      /* 持久化失败不破坏会话 */
    }
  }

  function continueTurn(goal: string, reason: string, turns: number): void {
    pi.sendMessage(
      { customType: GOAL_CONTINUE_MESSAGE, content: buildContinueMessage(goal, reason, turns), display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  function hydrate(ctx: ExtensionContext): void {
    state = { phase: "idle" };
    evidenceTail = "";
    userInterrupted = false;
    evaluatorFailures = 0;
    try {
      let lastGoal: string | null | undefined;
      for (const entry of ctx.sessionManager.getEntries()) {
        const e = entry as { type?: string; customType?: string; data?: unknown };
        if (e?.type === "custom" && e.customType === GOAL_STATE_ENTRY) {
          const data = e.data as { goal?: unknown } | undefined;
          lastGoal = typeof data?.goal === "string" && data.goal ? data.goal : null;
        }
      }
      // 对齐 /goal:resume 语义:恢复目标但轮数与计时重置;已清除(null)不恢复
      if (typeof lastGoal === "string") {
        state = { phase: "active", goal: lastGoal, startedAtMs: nowMs(), turns: 0 };
      }
    } catch {
      /* 水合失败保持 idle */
    }
  }

  async function onSettled(ctx: ExtensionContext): Promise<void> {
    if (state.phase !== "active") return;
    if (evaluating) return;
    evaluating = true;
    try {
      const snapshot = state;
      if (snapshot.phase !== "active") return;
      if (userInterrupted) {
        // 不原地改 snapshot.phase:它已被收窄为 "active",整体替换为 paused 态
        state = { ...snapshot, phase: "paused" };
        notify(ctx, "goal 已暂停(检测到手动中断)。使用 /goal:resume 继续。", "warning");
        updateStatus(ctx);
        return;
      }
      snapshot.turns += 1;
      updateStatus(ctx);
      const result = await evaluate({ goal: snapshot.goal, evidence: evidenceTail, lastReason: snapshot.lastReason }, ctx);
      if (state !== snapshot) return; // 评估期间目标被替换/清除,本轮作废
      if (!result.ok) {
        evaluatorFailures += 1;
              if (evaluatorFailures >= MAX_EVALUATOR_FAILURES) {
                const lastReason = `评估器连续 ${evaluatorFailures} 次失败:${result.message ?? result.code}`;
                state = { ...snapshot, phase: "paused", lastReason };
                notify(ctx, `goal 已暂停:${lastReason}。使用 /goal:resume 重试。`, "error");
                updateStatus(ctx);
                return;
              }
        // 瞬时失败:按未达成继续,避免一次网络抖动杀掉循环
        continueTurn(snapshot.goal, `评估器暂时不可用(${result.code}),请继续推进目标并在回复中给出可验证的证据。`, snapshot.turns);
        return;
      }
      evaluatorFailures = 0;
      if (result.met) {
        const achievedAtMs = nowMs();
        persistResult({
          goal: snapshot.goal,
          turns: snapshot.turns,
          elapsedMs: Math.max(0, achievedAtMs - snapshot.startedAtMs),
          reason: result.reason,
          achievedAt: new Date(achievedAtMs).toISOString(),
        });
        state = { phase: "idle" };
        notify(ctx, `🎉 goal 已达成(第 ${snapshot.turns} 轮):${result.reason}`, "info");
        updateStatus(ctx);
        return;
      }
      snapshot.lastReason = result.reason;
      continueTurn(snapshot.goal, result.reason, snapshot.turns);
    } catch (error) {
      // 防御性兜底:循环链路任何异常都不破坏会话
      notify(ctx, `goal 循环异常已忽略:${error instanceof Error ? error.message : String(error)}`, "warning");
    } finally {
      evaluating = false;
    }
  }

  /** 清除 goal（clear 及全部别名共用）。 */
  function clearGoal(ctx: ExtensionContext): void {
    if (state.phase === "idle") {
      notify(ctx, "当前没有活跃的 goal。");
      return;
    }
    state = { phase: "idle" };
    persistState(null);
    notify(ctx, "goal 已清除。");
    updateStatus(ctx);
  }

  /** `/goal:resume`：手动中断/评估器连续失败暂停后恢复并立即续跑。 */
  function resumeGoal(ctx: ExtensionContext): void {
    if (state.phase === "active") {
      notify(ctx, "goal 正在运行,无需恢复。");
      return;
    }
    if (state.phase === "idle") {
      notify(ctx, "当前没有可恢复的 goal(仅在中断/暂停后可用)。");
      return;
    }
    const resumed: RuntimeState = { ...state, phase: "active" };
    state = resumed;
    if (resumed.phase !== "active") return;
    notify(ctx, "goal 已恢复,继续推进。");
    updateStatus(ctx);
    continueTurn(resumed.goal, resumed.lastReason ?? "继续推进目标。", resumed.turns);
  }

  /** 设置目标并立即开第一轮（`/goal <条件>`）。 */
  async function setGoal(ctx: ExtensionContext, goal: string): Promise<void> {
    await ctx.waitForIdle();
    state = { phase: "active", goal, startedAtMs: nowMs(), turns: 0 };
    evidenceTail = "";
    userInterrupted = false;
    evaluatorFailures = 0;
    persistState(goal);
    notify(ctx, "goal 已设置,开始第一轮推进。");
    updateStatus(ctx);
    // 对齐 /goal:以条件本身作为指令立即启动第一回合
    pi.sendUserMessage(goal);
  }

  /**
   * 裸 `/goal`（命令面冒号化 v1.3.0）：空参=状态；其余=目标文本；旧管理词
   * （clear/stop/off/reset/none/cancel/resume）只提示改名、绝不执行；`/goal status`
   * 仍视为目标文本（裸命令从未有 status 子命令）。
   */
  pi.registerCommand(GOAL_COMMAND, {
    description: "设置目标并自动循环推进直至评估器判定达成（/goal <条件>；无参数查看状态；清除/恢复为独立冒号命令 /goal:clear、/goal:resume）",
    handler: async (args, ctx) => {
      const head = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const renamed = RETIRED_GOAL_SUBCOMMANDS[head];
      if (renamed) {
        notify(ctx, `「/goal ${head}」已改名为「/${renamed.command}」；用法：${renamed.usage}`, "warning");
        return;
      }
      const parsed = parseGoalArgs(args);
      switch (parsed.action) {
        case "status":
          notifyStatus(ctx);
          return;
        case "invalid":
          notify(ctx, parsed.reason, "warning");
          return;
        case "set":
          await setGoal(ctx, parsed.goal);
          return;
      }
    },
  });

  pi.registerCommand(GOAL_SUBCOMMANDS.status, {
    description: "查看当前 goal 状态（目标 / 已评估轮数 / 时长 / 评估器最近判定）",
    handler: async (_args, ctx) => notifyStatus(ctx),
  });

  // clear 及其 5 个别名：同一动作，各自独立静态注册。
  for (const alias of CLEAR_ALIASES) {
    pi.registerCommand(GOAL_SUBCOMMANDS[alias], {
      description: alias === "clear" ? "清除 goal（停止自动推进）" : `清除 goal（/goal:clear 的别名）：/goal:${alias}`,
      handler: async (_args, ctx) => clearGoal(ctx),
    });
  }

  pi.registerCommand(GOAL_SUBCOMMANDS.resume, {
    description: "恢复被手动中断/评估器连续失败暂停的 goal，并立即续跑",
    handler: async (_args, ctx) => resumeGoal(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    hydrate(ctx);
    updateStatus(ctx);
  });
  pi.on("agent_start", async () => {
    userInterrupted = false;
  });
  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.signal?.aborted) userInterrupted = true;
  });
  pi.on("agent_end", async (event, ctx) => {
    evidenceTail = extractAssistantText(event.messages);
    if (ctx.signal?.aborted) userInterrupted = true;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await onSettled(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    // 新会话/退出/重载都回到 idle;reload/resume 场景由 session_start 重新水合
    state = { phase: "idle" };
    evaluating = false;
    stopStatusClock();
    statusCtx = undefined;
    lastStatusText = null;
    try {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      /* 忽略 */
    }
  });
}

export default function goalExtension(pi: ExtensionAPI): void {
  createGoalExtension(pi);
}
