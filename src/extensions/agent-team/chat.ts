/**
 * agent-team — viewer 直接对话（派单语义 + 对话线前文注入）
 *
 * 架构约束：成员子进程由 leader 进程派生，cockpit 没有通道向成员注入消息；
 * 但 leader 以 `--mode rpc` 拉起，cockpit 持有其 stdin——因此：(a) 目标是
 * leader 且 run 运行中时用 RPC `steer` 插话（当前回合边界送达，不打断任务）；
 * (b) 其余情况（目标是成员 / steer 不可用 / run 已落定）走派单语义：每条
 * 消息编成一个新 run 的 task（附带目标 actor 的 transcript 尾部作上文），
 * 复用 startBackgroundRun（含 model 预检）派出；当前 run 在跑则消息排队，
 * run 落定（completed）后自动链式派出。
 *
 * 对话线（agent-team-todo #4）：同一（团队，actor）的连续追问属于同一条
 * 对话线——每轮派单时把「最近 N 轮的提问 + 成员答复摘录 + 摘要头」注入本轮
 * task（成员保持一次性子进程，不引入常驻进程或 session 状态；leader 是唯一
 * 中枢，前文由它原文转派）。轮次是新 run：每轮用量落该轮 run 转录并计入该
 * run 的既有预算（dispatch / member-run / cost 三类上限），不新建预算类型；
 * 对话线只把各轮用量求和作展示。轮次与终止沿用既有语义（/team:stop、超时、
 * 排队丢弃）。
 *
 * 本模块是纯逻辑层：task 模板、上文尾部截断、FIFO 队列、对话线状态与链式
 * 门控全部依赖注入（resolveTeam/startRun/contextTail/roundAnswer/notify），
 * 不触进程与文件系统。宿主接线在 index.ts（viewer onMessage → submit；
 * runPromise 收尾 → onRunFinalized；显式停止路径 → clear）。
 */

import { LEADER_ACTOR, sanitizeActorName, type TranscriptEntry } from "./transcript.ts";
import { truncateUtf8, type TeamConfig } from "./types.ts";

/** 上文尾部上限（字节，UTF-8）：派出时刻从上一 run 的 transcript 现读。 */
export const CHAT_CONTEXT_TAIL_BYTES = 2000;

/** 对话线注入的前文轮数上限（「最近 N 轮」；更早的轮次不再注入）。 */
export const CHAT_DIALOGUE_MAX_ROUNDS = 3;

/** 对话线单轮答复注入的字节上限（UTF-8，超出保留头部）。 */
export const CHAT_DIALOGUE_ANSWER_BYTES = 800;

/** 对话线一轮的注入视图（buildDialogueBlock 消费的最小形状）。 */
export interface DialogueTurn {
  /** 轮号（1 起，按派单次数续编；裁剪后仍不回退）。 */
  round: number;
  /** 该轮用户的提问原文。 */
  user: string;
  /** 该轮成员的答复摘录；未产出/未完成时为空串。 */
  answer: string;
}

/**
 * 一轮 run 的用量（run 记录口径：leader 累计 + 成员派发）。仅供对话线
 * 展示累计用——预算 enforcement 仍在各轮 run 内（不新增预算类型）。
 */
export interface RoundUsage {
  cost: number;
  tokens: number;
}

/** 队列条目：只存目标 runId/显示名与消息本身，上下文派出时现读（不缓存）。 */
export interface ChatMessage {
  /** 消息提交时目标 actor 所属的 run（failed 时只丢弃该 run 的排队条目）。 */
  runId: string;
  targetLabel: string;
  message: string;
}

/** 消息目标：actor id（transcript 文件名）+ 显示名 + 是否 leader + 所属 run。 */
export interface ChatTarget {
  actor: string;
  label: string;
  isLeader: boolean;
  /** 目标 actor 当前所属的 runId（steer 定向与队列归属）。 */
  runId: string;
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
  /** 目标 actor 的 transcript 尾部（宿主实现按目标 runId 现读）。 */
  contextTail: (runId: string, actor: string) => string;
  /**
   * 该轮成员答复的注入摘录（宿主实现按该轮 run 现读转录；缺省即不注入
   * 答复，只注入提问）。
   */
  roundAnswer?: (runId: string, actor: string) => string;
  /**
   * 向指定 run 的 leader 插话（RPC steer：当前回合边界送达，不打断任务）。
   * 不可用时返回 false，提交回退到队列语义。
   */
  steerLeader?: (runId: string, message: string) => boolean;
  /**
   * 转录写入端口（#56 用户输入可见）：`user` = 用户输入原文（提交时刻落，
   * 目标 actor + leader 各一条）；`system` = 排队条目的结局（已派出 / 未派出）。
   * 宿主实现写 FileTranscriptSink；缺失即不落记录（纯逻辑测试 / 降级）。
   */
  appendEntry?: (runId: string, actor: string, kind: "user" | "system", text: string) => void;
}

/**
 * 把用户消息编成新 run 的 task。目标是 leader 时直发；目标是成员时指示
 * leader 把消息转派给该成员并让成员回应（成员子进程只能由 leader 派生）。
 * `context.dialogue` 是本对话线的历史轮次（最近 N 轮），作前文注入。
 */
export function buildChatTask(target: ChatTarget, message: string, context: ChatTaskContext = {}): string {
  const contextTail = context.tail ?? "";
  const tail =
    contextTail.trim().length > 0
      ? `\n\n【${target.label} 最近会话尾部（供衔接上下文）】\n${contextTail}`
      : "";
  const dialogue = buildDialogueBlock(target, context.dialogue ?? [], context.usage);
  if (target.isLeader) {
    return `【用户消息】用户在会话查看器里直接发给你，请回应：\n${message}${dialogue}${tail}`;
  }
  return `【用户消息·请转派】用户在会话查看器里直接点名成员 ${target.label}，请把下面的消息转派给 ${target.label} 并让 ${target.label} 回应用户：\n${message}${dialogue}${tail}`;
}

/** buildChatTask 的上下文：上一 run 的转录尾部 + 对话线前文与累计用量。 */
export interface ChatTaskContext {
  /** 目标 actor 的转录尾部（派出时刻现读；空串即省略该段）。 */
  tail?: string;
  /** 对话线的前文轮次（调用方已按 CHAT_DIALOGUE_MAX_ROUNDS 裁剪）。 */
  dialogue?: readonly DialogueTurn[];
  /** 对话线各轮用量之和（展示用；空即省略累计行）。 */
  usage?: RoundUsage;
}

/**
 * 对话线前文注入块（含摘要头）：轮号、已完成轮数、注入轮数、转派指令、
 * 累计用量。无前文（第 1 轮）返回空串——首轮行为与无对话线时完全一致。
 * 成员答复由 leader 原文转派（成员看不到会话历史，leader 是唯一中枢）。
 */
export function buildDialogueBlock(
  target: ChatTarget,
  turns: readonly DialogueTurn[],
  usage?: RoundUsage,
): string {
  const last = turns[turns.length - 1];
  if (last === undefined) return "";
  const head = target.isLeader
    ? [
        `【对话线前文·第 ${last.round + 1} 轮】与 ${target.label} 的同一条对话线：`,
        `已完成 ${last.round} 轮，本块注入最近 ${turns.length} 轮。`,
        `请延续这条对话线回应本轮消息（回答可引用前文）。`,
      ].join("")
    : [
        `【对话线前文·第 ${last.round + 1} 轮】与 ${target.label} 的同一条对话线：`,
        `已完成 ${last.round} 轮，本块注入最近 ${turns.length} 轮。`,
        `请把前文连同本轮消息一并原文转派给 ${target.label}`,
        `（成员看不到会话历史，前文必须原样带上），让 ${target.label} 的回答延续这条线。`,
      ].join("");
  const usageLine =
    usage !== undefined && (usage.cost > 0 || usage.tokens > 0)
      ? `\n累计用量：$${usage.cost.toFixed(4)} · ${usage.tokens} tokens（各轮已计入其所在 run 的预算）`
      : "";
  const rounds = turns
    .map(
      (turn) =>
        `— 第 ${turn.round} 轮 —\n用户：${turn.user}\n${target.label}：${
          turn.answer.trim().length > 0 ? turn.answer : "（该轮无答复产出）"
        }`,
    )
    .join("\n");
  return `\n\n${head}${usageLine}\n${rounds}`;
}

/**
 * 该轮成员答复的注入摘录：取转录里**最后一条 assistant** 文本（单行化 +
 * 按字节截断）。取 assistant 而不是整段尾部，是为了避免把上一轮注入的前文
 * （写在 `task` 行里）递归卷进下一轮。
 */
export function dialogueAnswerExcerpt(
  entries: TranscriptEntry[],
  maxBytes: number = CHAT_DIALOGUE_ANSWER_BYTES,
): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.kind !== "assistant") continue;
    return truncateUtf8(entry.text.replace(/\s+/g, " ").trim(), maxBytes);
  }
  return "";
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
 * 这是会话查看器里的即时插话，不是新任务派单。**只在 wire 上**——落转录的
 * 是用户原文（`user` 条目），不带这个标记。
 */
export function buildSteerMessage(message: string): string {
  return `【用户消息·插话】用户在会话查看器里插话，请在不中断当前任务的前提下尽快回应：\n${message}`;
}

/** 排队条目结局文案：派出成功（带新 runId）/ 三种未派出场景（落 `system` 行）。 */
function queuedDispatchedText(runId: string): string {
  return `已派出（新 run ${runId}）`;
}
const QUEUE_DROPPED_BY_STOP = "未派出（run 已停止）";
const QUEUE_DROPPED_BY_CLEAR = "未派出（队列已清空）";
const QUEUE_DROPPED_BY_FAILURE = "未派出（派出失败）";

/**
 * 用户输入落转录的 actor 集合：目标 actor + leader 各一条（消息就是交给它
 * 处理的；目标即 leader 时只落一条，不重复）。
 */
function userEntryActors(actor: string): string[] {
  return actor === LEADER_ACTOR ? [LEADER_ACTOR] : [actor, LEADER_ACTOR];
}

/** 对话线一轮（注入视图 + 回读锚点）；只驻内存，不落盘。 */
interface DialogueRound extends DialogueTurn {
  /** 目标 actor（转录文件名口径；答复按它回读）。 */
  actor: string;
  /** 该轮派出的 run（答复与用量按它回读，结局行也落它）。 */
  runId: string;
  /** 该轮终态（run 落定前 undefined；落定后不再被回读改写）。 */
  status?: "completed" | "failed" | "aborted";
  /** 该轮 run 的用量（宿主在落定时传入）。 */
  usage?: RoundUsage;
}

/** 对话线状态：最近 N 轮明细（注入用）+ 已派轮次计数 + 累计用量。 */
interface DialogueLine {
  rounds: DialogueRound[];
  /** 已派出的轮次总数（轮号续编；裁剪不回退）。 */
  dispatched: number;
  /** 各轮用量之和（展示用；enforcement 在各轮 run 预算内）。 */
  usage: RoundUsage;
}

/**
 * viewer 对话队列 + 链式派出门控 + 对话线（同一 actor 的连续追问）。
 * 队列与对话线都驻留在 cockpit 扩展状态，不落盘——会话重启丢队列/对话线
 * 可接受（run 元数据与转录已有落盘，两者属易失交互态）。
 */
export class ChatCoordinator {
  private readonly deps: ChatCoordinatorDeps;
  private queue: ChatMessage[] = [];
  private session: ChatSession | undefined;
  /** 对话线：`${teamName}\u0000${actor}` → 最近轮次。 */
  private readonly lines = new Map<string, DialogueLine>();

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
   *
   * 两条通道都在**提交时刻**把用户原文落转录（steer / 排队 / 立即派单同
   * 口径）：这是「我发了什么」的唯一真值，排队中不建第二个事实源（队列本
   * 身不落盘），结局（已派出/未派出）等派出或丢弃时再补 `system` 行。
   */
  submit(session: ChatSession, target: ChatTarget, message: string): ChatSubmitOutcome {
    this.session = session;
    const steered =
      target.isLeader &&
      this.deps.isRunning() &&
      (this.deps.steerLeader?.(target.runId, buildSteerMessage(message)) ?? false);
    this.recordUserInput(target, message);
    if (steered) return { kind: "steered" };
    this.queue.push({ runId: target.runId, targetLabel: target.label, message });
    if (this.deps.isRunning()) return { kind: "queued", pending: this.queue.length };
    return this.dispatchNext(session);
  }

  /**
   * run 落定回调（宿主在 startBackgroundRun 的 runPromise 收尾调用，带
   * 该 run 的 runId 与用量）：先收尾该 run 上的对话轮（答复摘录 + 用量 +
   * 转录结局行），再按既有语义驱动队列——completed → 链式派出下一条
   * （一次只发一条，本 run 落定后再续下一条）；failed/aborted → 只丢弃
   * 属于该 run 的排队条目——其余并行 run 的排队消息保留（用户变卦只针对
   * 停止的这个 run）。对话轮收尾必须在链式派出之前：下一轮的注入要用它。
   */
  onRunFinalized(runId: string, status: string, usage?: RoundUsage): void {
    this.finishRounds(runId, status, usage);
    if (this.queue.length === 0) return;
    const session = this.session;
    if (status !== "completed") {
      const dropped = this.queue.filter((entry) => entry.runId === runId);
      this.queue = this.queue.filter((entry) => entry.runId !== runId);
      if (dropped.length > 0) {
        for (const entry of dropped) this.recordOutcome(entry, QUEUE_DROPPED_BY_STOP);
        session?.notify(`run ${runId} ${status}（未完成）：已丢弃排队的 ${dropped.length} 条 viewer 对话消息`, "warning");
      }
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

  /** 丢弃属于该 run 的排队条目，返回丢弃条数（定向停止路径）。 */
  clearRun(runId: string): number {
    const dropped = this.queue.filter((entry) => entry.runId === runId);
    this.queue = this.queue.filter((entry) => entry.runId !== runId);
    for (const entry of dropped) this.recordOutcome(entry, QUEUE_DROPPED_BY_STOP);
    return dropped.length;
  }

  /** 显式停止/清除时丢弃整个队列，返回丢弃条数（宿主提示用）。 */
  clear(): number {
    const dropped = this.queue.length;
    this.dropAll(QUEUE_DROPPED_BY_CLEAR);
    return dropped;
  }

  /** 用户原文落转录：目标 actor + leader 各一条（提交时刻调用一次）。 */
  private recordUserInput(target: ChatTarget, message: string): void {
    for (const actor of userEntryActors(target.actor)) this.deps.appendEntry?.(target.runId, actor, "user", message);
  }

  /** 排队条目结局落转录（与提交记录的 actor 集合对称）。 */
  private recordOutcome(entry: ChatMessage, text: string): void {
    const { actor } = chatTargetForLabel(entry.targetLabel, entry.runId);
    for (const target of userEntryActors(actor)) this.deps.appendEntry?.(entry.runId, target, "system", text);
  }

  /** 清空队列并把被丢弃条目的结局落转录。 */
  private dropAll(text: string): void {
    const dropped = this.queue;
    this.queue = [];
    for (const entry of dropped) this.recordOutcome(entry, text);
  }

  /**
   * 派出队首一条：编 task 时带上该对话线的前文（最近 N 轮 + 摘要头）；
   * 成功派单后记一轮。任何失败都清空队列（简单一致，失败经 notify 明示）。
   */
  private dispatchNext(session: ChatSession): ChatSubmitOutcome {
    const entry = this.queue.shift();
    if (!entry) return { kind: "queued", pending: 0 };
    const team = this.deps.resolveTeam(session.teamName);
    if (!team.ok) return this.rejectDispatch(entry, team.message);
    const target = chatTargetForLabel(entry.targetLabel, entry.runId);
    const line = this.lines.get(lineKey(session.teamName, target.actor));
    const task = buildChatTask(target, entry.message, {
      tail: this.deps.contextTail(target.runId, target.actor),
      ...(line ? { dialogue: line.rounds, usage: line.usage } : {}),
    });
    const started = this.deps.startRun(session.ctx, team.value, task);
    if (!started.ok) return this.rejectDispatch(entry, started.message);
    this.recordRound(session.teamName, target, entry.message, started.runId);
    this.recordOutcome(entry, queuedDispatchedText(started.runId));
    return { kind: "started", runId: started.runId };
  }

  /** 派单成功 → 记一轮对话（只保留最近 N 轮明细，轮号继续续编）。 */
  private recordRound(teamName: string, target: ChatTarget, message: string, runId: string): void {
    const key = lineKey(teamName, target.actor);
    const line = this.lines.get(key) ?? { rounds: [], dispatched: 0, usage: { cost: 0, tokens: 0 } };
    line.dispatched += 1;
    line.rounds.push({ round: line.dispatched, user: message, answer: "", actor: target.actor, runId });
    if (line.rounds.length > CHAT_DIALOGUE_MAX_ROUNDS) {
      line.rounds.splice(0, line.rounds.length - CHAT_DIALOGUE_MAX_ROUNDS);
    }
    this.lines.set(key, line);
  }

  /**
   * 收尾该 run 上派出的对话轮：completed 回读成员答复摘录；用量累计进
   * 对话线（展示）并落该轮 run 转录的结局行；未完成的轮不注入答复。
   */
  private finishRounds(runId: string, status: string, usage?: RoundUsage): void {
    for (const line of this.lines.values()) {
      const round = line.rounds.find((candidate) => candidate.runId === runId);
      if (!round || round.status !== undefined) continue;
      round.status = status === "completed" ? "completed" : status === "aborted" ? "aborted" : "failed";
      if (round.status === "completed") round.answer = this.deps.roundAnswer?.(runId, round.actor) ?? "";
      if (usage !== undefined) {
        round.usage = usage;
        line.usage = { cost: line.usage.cost + usage.cost, tokens: line.usage.tokens + usage.tokens };
      }
      for (const actor of userEntryActors(round.actor)) {
        this.deps.appendEntry?.(runId, actor, "system", roundOutcomeText(round));
      }
    }
  }

  /** 派出失败：队首与余下条目一并丢弃，各自落一条「未派出」结局行。 */
  private rejectDispatch(entry: ChatMessage, message: string): ChatSubmitOutcome {
    this.recordOutcome(entry, QUEUE_DROPPED_BY_FAILURE);
    this.dropAll(QUEUE_DROPPED_BY_FAILURE);
    return { kind: "rejected", message };
  }
}

/** 对话线键：团队名 + 目标 actor（同团队同名成员视为同一条对话线）。 */
function lineKey(teamName: string, actor: string): string {
  return `${teamName}\u0000${actor}`;
}

/** 轮结局行（落该轮 run 转录）：轮号 + 终态 + 该 run 用量（预算口径）。 */
function roundOutcomeText(round: DialogueRound): string {
  const state = round.status === "completed" ? "完成" : `未完成（${round.status ?? "unknown"}）`;
  const parts = [`第 ${round.round} 轮${state}`];
  const usage = round.usage;
  if (usage !== undefined && (usage.cost > 0 || usage.tokens > 0)) {
    parts.push(`$${usage.cost.toFixed(4)}`, `${usage.tokens} tokens`);
  }
  return parts.join(" · ");
}

/** 由显示名还原消息目标（leader 显示名固定为 "leader"）。 */
function chatTargetForLabel(label: string, runId: string): ChatTarget {
  if (label === "leader") return { actor: LEADER_ACTOR, label, isLeader: true, runId };
  return { actor: sanitizeActorName(label), label, isLeader: false, runId };
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
