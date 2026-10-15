/**
 * btw - 侧调用：一次「只读宿主路由」的模型调用
 *
 * 调用路径（对齐 goal 评估器，goal-todo#10 有真机对照）：经
 * `ctx.modelRegistry.streamSimple()` 走宿主的路由 / 鉴权 / 会话头注入——
 * 虚拟模型（api=pi-virtual）先由宿主路由再请求，opencode 系必需的
 * x-opencode-session 由 provider 层从 `options.sessionId` 注入。
 *
 * 关键不变量：这是一次**直调**，不写会话——不 appendEntry、不 sendMessage，
 * 主会话文件与下一轮主请求都不含侧对话内容（本扩展对宿主只读）。
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  UserMessage,
} from "@earendil-works/pi-ai";
import { BtwErrorCodes, fail, ok, type BtwResult } from "./errors.ts";
import { MAX_ANSWER_TOKENS, MAX_THREAD_MESSAGE_CHARS, SIDE_SYSTEM_PROMPT } from "./spec.ts";

/**
 * 本扩展真正用到的那一小面宿主能力（`ModelRegistry` 结构化兼容；
 * 测试注入 fake，只实现这一个方法）。
 */
export interface StreamSimplePort {
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AsyncIterable<AssistantMessageEvent>;
}

/** 侧对话线里的一轮消息（untrusted 长度在注入时再截一次） */
export interface ThreadTurn {
  role: "user" | "assistant";
  text: string;
}

export interface SideCallInput {
  question: string;
  /** `buildContextText()` 的产物 */
  contextText: string;
  /** 本会话此前的侧问答轮次（注入前截断） */
  thread: readonly ThreadTurn[];
  model: Model<Api>;
  sessionId?: string;
  /** 侧调用自己的取消信号（不被主 run 的 abort 牵连） */
  signal: AbortSignal;
  /** 流式增量（面板实时显示） */
  onDelta?: (delta: string) => void;
}

export type SideCallResult = BtwResult<{ text: string }>;

/** 侧线程单条消息注入上限（保守截断：这是给模型的提示材料，不是持久记录） */
function clamp(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(1, max - 1)).join("") + "…";
}

/**
 * 组装侧模型看到的单条 user 消息：侧对话上文（若有）→ 主会话转录 → 本轮问题。
 * 用单条 user 消息而不是多轮 messages，是为了不伪造 AssistantMessage
 * （它要求 api/provider/usage 等完整字段）。
 */
export function buildSidePrompt(input: Pick<SideCallInput, "question" | "contextText" | "thread">): string {
  const sections: string[] = [];
  if (input.thread.length > 0) {
    const turns = input.thread
      .map((turn) => `${turn.role === "user" ? "Q" : "A"}: ${clamp(turn.text.trim(), MAX_THREAD_MESSAGE_CHARS)}`)
      .join("\n");
    sections.push("SIDE CHAT SO FAR (earlier turns of this side conversation):", turns, "");
  }
  sections.push(
    "MAIN SESSION TRANSCRIPT (most recent activity last):",
    input.contextText.trim() || "(no transcript entries visible yet)",
    "",
    "USER QUESTION:",
    input.question,
  );
  return sections.join("\n");
}

/** done 消息里的文本块拼接（thinking / toolCall 不取） */
export function extractAssistantText(message: AssistantMessage | undefined): string {
  const content = message?.content ?? [];
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text);
  }
  return parts.join("");
}

/** 流内 error 事件的诊断文本（宿主/模型原文，不含用户输入拼装） */
function describeStreamError(event: Extract<AssistantMessageEvent, { type: "error" }>): string {
  return event.error.errorMessage ?? event.error.stopReason ?? "unknown";
}

const ABORTED_MESSAGE = "侧调用已中止（面板关闭或宿主取消）。";

/** 中止竞速哨兵：provider 不理 signal 时也能让调用有界结束（面板关闭不悬挂） */
const ABORT = Symbol("btw-abort");

function abortRace(signal: AbortSignal): Promise<typeof ABORT> {
  if (signal.aborted) return Promise.resolve(ABORT);
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(ABORT), { once: true });
  });
}

/**
 * 跑一次侧调用。任何失败都归一为 result union（绝不抛给调用方）：
 * - 用户关面板 / 宿主取消 → `aborted`
 * - 流内 error 事件或抛错 → `side-call-error`（message 为诊断原文）
 * 超时由调用方的看门狗 abort 触发，判定为 `aborted`（调用方知道是自己超时的）。
 */
export async function runSideCall(
  input: SideCallInput,
  registry: StreamSimplePort,
  deps: { nowMs: () => number },
): Promise<SideCallResult> {
  const message: UserMessage = { role: "user", content: buildSidePrompt(input), timestamp: deps.nowMs() };
  let final: AssistantMessage | undefined;
  try {
    const stream = registry.streamSimple(
      input.model,
      { systemPrompt: SIDE_SYSTEM_PROMPT, messages: [message] },
      { maxTokens: MAX_ANSWER_TOKENS, signal: input.signal, sessionId: input.sessionId },
    );
    // 与 abort 竞速：`for await` 只会在事件边界检查 signal，provider 挂住时
    // 会把命令处理器一起挂住——面板关了但侧调用永不返回（实测形态）。
    const iterator = stream[Symbol.asyncIterator]();
    const aborted = abortRace(input.signal);
    try {
      while (true) {
        const pending = iterator.next();
        // 竞速失败方的迟到错误不得变成 unhandled rejection
        void pending.catch(() => {});
        const next = await Promise.race([pending, aborted]);
        if (next === ABORT) break;
        if (next.done) break;
        const event = next.value;
        if (event.type === "text_delta") input.onDelta?.(event.delta);
        else if (event.type === "done") final = event.message;
        else if (event.type === "error") {
          if (input.signal.aborted) return fail(BtwErrorCodes.aborted, ABORTED_MESSAGE);
          return fail(BtwErrorCodes.sideCallError, describeStreamError(event));
        }
      }
    } finally {
      if (input.signal.aborted) {
        // 不 await：provider 挂住时 return()／cleanup 自身也可能永不落定（实测形态），
        // await 会把超时/关闭路径重新挂住；只尽力发一个清理信号。
        try {
          const cleanup = iterator.return?.();
          if (cleanup && typeof cleanup.catch === "function") void cleanup.catch(() => {});
        } catch {
          /* provider 清理失败不改变语义 */
        }
      }
    }
  } catch (error) {
    if (input.signal.aborted) return fail(BtwErrorCodes.aborted, ABORTED_MESSAGE);
    return fail(BtwErrorCodes.sideCallError, error instanceof Error ? error.message : String(error));
  }
  if (input.signal.aborted) return fail(BtwErrorCodes.aborted, ABORTED_MESSAGE);
  return ok({ text: extractAssistantText(final) });
}
