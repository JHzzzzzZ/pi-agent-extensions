/**
 * agent-team — viewer 直接对话（派单语义）
 *
 * 架构约束：成员子进程由 leader 进程派生，cockpit 没有通道向成员注入消息；
 * 但 leader 以 `--mode rpc` 拉起，cockpit 持有其 stdin——因此：(a) 目标是
 * leader 且 run 运行中时用 RPC `steer` 插话（当前回合边界送达，不打断任务）；
 * (b) 其余情况（目标是成员 / steer 不可用 / run 已落定）走派单语义：每条
 * 消息编成一个新 run 的 task（附带目标 actor 的 transcript 尾部作上文），
 * 复用 startBackgroundRun（含 model 预检）派出；当前 run 在跑则消息排队，
 * run 落定（completed）后自动链式派出。
 *
 * 本模块是纯逻辑层：task 模板、上文尾部截断、FIFO 队列与链式门控全部依赖
 * 注入（resolveTeam/startRun/contextTail/notify），不触进程与文件系统。
 * 宿主接线在 index.ts（viewer onMessage → submit；runPromise 收尾 →
 * onRunFinalized；显式停止路径 → clear）。
 */

import { LEADER_ACTOR, sanitizeActorName, type TranscriptEntry } from "./transcript.ts";
import type { TeamConfig } from "./types.ts";

/** 上文尾部上限（字节，UTF-8）：派出时刻从上一 run 的 transcript 现读。 */
export const CHAT_CONTEXT_TAIL_BYTES = 2000;

/** 队列条目：只存目标显示名与消息本身，上下文派出时现读（不缓存）。 */
export interface ChatMessage {
  targetLabel: string;
  message: string;
}

/** 消息目标：actor id（transcript 文件名）+ 显示名 + 是否 leader。 */
export interface ChatTarget {
  actor: string;
  label: string;
  isLeader: boolean;
}

/** 一次提交的宿主会话绑定（team 名 + ctx + 通知口），随每次 submit 刷新。 */
export interface ChatSession {
  teamName: string;
  /** 宿主 ExtensionContext（对 chat.ts 不透明；链式派出复用最近一次绑定）。 */
  ctx: unknown;
  notify: (text: string, level: "info" | "warning" | "error") => void;
}

export type ChatSubmitOutcome =
  | { kind: "started"; runId: string }
  | { kind: "queued"; pending: number }
  | { kind: "steered" }
  | { kind: "rejected"; message: string };

export interface ChatCoordinatorDeps {
  resolveTeam: (name: string) => { ok: true; value: TeamConfig } | { ok: false; message: string };
  isRunning: () => boolean;
  /** 启动一个后台 run（宿主实现含 model 预检与 ensureRunWidget）。 */
  startRun: (
    ctx: unknown,
    team: TeamConfig,
    task: string,
  ) => { ok: true; runId: string } | { ok: false; code: string; message: string };
  /** 目标 actor 的 transcript 尾部（宿主实现按当前/最近 runId 现读）。 */
  contextTail: (actor: string) => string;
  /**
   * 向运行中的 leader 插话（RPC steer：当前回合边界送达，不打断任务）。
   * 不可用时返回 false，提交回退到队列语义。
   */
  steerLeader?: (message: string) => boolean;
}

/**
 * 把用户消息编成新 run 的 task。目标是 leader 时直发；目标是成员时指示
 * leader 把消息转派给该成员并让成员回应（成员子进程只能由 leader 派生）。
 */
export function buildChatTask(target: ChatTarget, message: string, contextTail: string): string {
  const tail =
    contextTail.trim().length > 0
      ? `\n\n【${target.label} 最近会话尾部（供衔接上下文）】\n${contextTail}`
      : "";
  if (target.isLeader) {
    return `【用户消息】用户在会话查看器里直接发给你，请回应：\n${message}${tail}`;
  }
  return `【用户消息·请转派】用户在会话查看器里直接点名成员 ${target.label}，请把下面的消息转派给 ${target.label} 并让 ${target.label} 回应用户：\n${message}${tail}`;
}

/**
 * transcript 尾部摘要：每条折叠成 `[kind] text` 单行，从最新条目往回收集，
 * 直到达到 maxBytes。空记录返回空串（task 模板随之省略尾部段）。
 */
export function transcriptContextTail(entries: TranscriptEntry[], maxBytes: number = CHAT_CONTEXT_TAIL_BYTES): string {
  const lines = entries.map((e) => `[${e.kind}] ${e.text.replace(/\s+/g, " ").trim()}`);
  let text = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const candidate = text.length > 0 ? `${line}\n${text}` : line;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) break;
    text = candidate;
  }
  return text;
}

/**
 * 插话文本（steer 通道）：带 ``【用户消息·插话】`` 标记，让 leader 能区分
 * 这是会话查看器里的即时插话，不是新任务派单。
 */
export function buildSteerMessage(message: string): string {
  return `【用户消息·插话】用户在会话查看器里插话，请在不中断当前任务的前提下尽快回应：\n${message}`;
}

/**
 * viewer 对话队列 + 链式派出门控。队列驻留在 cockpit 扩展状态，不落盘——
 * 会话重启丢队列可接受（run 元数据已有落盘，对话队列属易失交互态）。
 */
export class ChatCoordinator {
  private readonly deps: ChatCoordinatorDeps;
  private queue: ChatMessage[] = [];
  private session: ChatSession | undefined;

  constructor(deps: ChatCoordinatorDeps) {
    this.deps = deps;
  }

  /** 当前排队条数。 */
  get size(): number {
    return this.queue.length;
  }

  /**
   * 提交一条消息：目标是 leader 且 run 运行中、steer 通道可用 → 直接插话
   * （RPC steer，不打断任务、不排队）；否则 run 运行中入队；run 空闲则立即
   * 派单。先入队再判定，run 恰在提交间隙落定时走本路径立即派出，不滞留。
   */
  submit(session: ChatSession, target: ChatTarget, message: string): ChatSubmitOutcome {
    this.session = session;
    if (target.isLeader && this.deps.isRunning() && this.deps.steerLeader?.(buildSteerMessage(message))) {
      return { kind: "steered" };
    }
    this.queue.push({ targetLabel: target.label, message });
    if (this.deps.isRunning()) return { kind: "queued", pending: this.queue.length };
    return this.dispatchNext(session);
  }

  /**
   * run 落定回调（宿主在 startBackgroundRun 的 runPromise 收尾调用）：
   * completed → 链式派出下一条（一次只发一条，本 run 落定后再续下一条）；
   * failed/aborted → 清空队列——用户显式停止 / team_stop / 超预算中止均属
   * "变卦"，排队消息一并丢弃，与 run 语义一致。
   */
  onRunFinalized(status: string): void {
    if (this.queue.length === 0) return;
    const session = this.session;
    if (status !== "completed") {
      const dropped = this.queue.length;
      this.queue = [];
      session?.notify(`上一 run ${status}（未完成）：已丢弃排队的 ${dropped} 条 viewer 对话消息`, "warning");
      return;
    }
    if (!session) {
      this.queue = [];
      return;
    }
    const outcome = this.dispatchNext(session);
    if (outcome.kind === "started") {
      session.notify(`已自动续发排队的对话消息（新 run ${outcome.runId}）`, "info");
    } else if (outcome.kind === "rejected") {
      this.queue = [];
      session.notify(`续发排队消息失败：${outcome.message}；已清空队列`, "error");
    }
  }

  /** 显式停止/清除时丢弃整个队列，返回丢弃条数（宿主提示用）。 */
  clear(): number {
    const dropped = this.queue.length;
    this.queue = [];
    return dropped;
  }

  /** 派出队首一条；任何失败都清空队列（简单一致，失败经 notify 明示）。 */
  private dispatchNext(session: ChatSession): ChatSubmitOutcome {
    const entry = this.queue.shift();
    if (!entry) return { kind: "queued", pending: 0 };
    const team = this.deps.resolveTeam(session.teamName);
    if (!team.ok) {
      this.queue = [];
      return { kind: "rejected", message: team.message };
    }
    const target = chatTargetForLabel(entry.targetLabel);
    const task = buildChatTask(target, entry.message, this.deps.contextTail(target.actor));
    const started = this.deps.startRun(session.ctx, team.value, task);
    if (!started.ok) {
      this.queue = [];
      return { kind: "rejected", message: started.message };
    }
    return { kind: "started", runId: started.runId };
  }
}

/** 由显示名还原消息目标（leader 显示名固定为 "leader"）。 */
function chatTargetForLabel(label: string): ChatTarget {
  if (label === "leader") return { actor: LEADER_ACTOR, label, isLeader: true };
  return { actor: sanitizeActorName(label), label, isLeader: false };
}

/** 提交结果 → viewer 顶部 notice 文案（纯映射，供宿主与测试共用）。 */
export function chatSubmitNotice(
  outcome: ChatSubmitOutcome,
  label: string,
): { text: string; kind: "success" | "warning" | "error" } {
  switch (outcome.kind) {
    case "started":
      return {
        text: `已发送给 ${label}：新 run ${outcome.runId} 已启动，回复出现在该成员的会话页`,
        kind: "success",
      };
    case "queued":
      return {
        text: `run 进行中，消息已排队（第 ${outcome.pending} 条），run 落定后自动发送`,
        kind: "warning",
      };
    case "steered":
      return {
        text: `已插话给 ${label}（steer）：不打断当前任务，leader 会在当前回合结束后尽快回应`,
        kind: "success",
      };
    case "rejected":
      return { text: `发送失败：${outcome.message}`, kind: "error" };
  }
}
