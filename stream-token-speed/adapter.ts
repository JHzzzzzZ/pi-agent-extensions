/**
 * 事件适配层：将 pi 的统一 assistant 消息事件映射为内部度量契约。
 *
 * 契约见 JHL-10-Design-v2.md §2：
 * - 只消费 pi Extension API 的 message_start / message_update / message_end；
 * - 只读取事件 type、消息身份（role / responseId）与时间，绝不解析、复制或
 *   输出 text / thinking / tool call 参数内容；
 * - 可计量增量仅三类：text_delta / thinking_delta / toolcall_delta，每个事件计 1；
 * - tool result、工具执行进度、用户消息、未知 delta 一律返回 null。
 *
 * 适配器按结构识别事件（输入类型为 unknown），不依赖 pi 的具体类型导出，
 * 便于单元测试与跨版本兼容。
 *
 * responseId 语义（与 pi v0.83.0 真实行为一致，见 @earendil-works/pi-ai
 * AssistantMessageEvent 类型与 pi-coding-agent agent-loop 事件转发）：
 * 真实 provider 在流式响应的 `start` 事件前并不知晓 responseId，因此
 * message_start 的 partial 消息通常没有 responseId，而后续 message_update /
 * message_end 的 partial 消息携带 responseId。本适配器对缺失的 responseId
 * 返回空串（表示“未知”），由控制器按“未知即通配”的规则做轮次匹配，
 * 避免把同一轮的真实增量误判为其他轮次而全部丢弃。
 */

import type { ClockMs, EligibleSource } from "./metrics.ts";

export type Outcome = "completed" | "aborted" | "error";

export interface AssistantStart {
  messageId: string;
  role: "assistant";
  at: ClockMs;
}

export interface EligibleTokenDelta {
  messageId: string;
  kind: "eligible_token";
  source: EligibleSource;
  at: ClockMs;
  count: 1;
}

export interface AssistantEnd {
  messageId: string;
  role: "assistant";
  at: ClockMs;
  outcome: Outcome;
}

export interface PiEventAdapter {
  onAssistantStart(event: unknown): AssistantStart | null;
  onEligibleTokenDelta(event: unknown): EligibleTokenDelta | null;
  onAssistantEnd(event: unknown): AssistantEnd | null;
}

/** pi 事件的最小结构形态（仅取需要的字段，不读取内容）。 */
interface RawMessage {
  role?: unknown;
  responseId?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

interface RawUpdateEvent {
  type?: unknown;
  message?: RawMessage;
  assistantMessageEvent?: { type?: unknown };
}

const ASSISTANT_ROLE = "assistant";
const DELTA_SOURCES: Readonly<Record<string, EligibleSource>> = {
  text_delta: "text",
  thinking_delta: "thinking",
  toolcall_delta: "tool_call",
};

function isAssistantMessage(message: unknown): message is RawMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as RawMessage).role === ASSISTANT_ROLE
  );
}

function messageIdOf(message: RawMessage): string {
  return typeof message.responseId === "string" && message.responseId.length > 0
    ? message.responseId
    : "";
}

/**
 * 创建适配器。`now` 为单调时钟（默认 performance.now），同一实例内所有
 * 时间戳都来自该时钟。
 */
export function createStreamAdapter(now: () => ClockMs = () => performance.now()): PiEventAdapter {
  return {
    onAssistantStart(event: unknown): AssistantStart | null {
      const raw = event as { type?: unknown; message?: RawMessage } | null;
      if (!raw || typeof raw !== "object" || raw.type !== "message_start") return null;
      if (!isAssistantMessage(raw.message)) return null;
      return {
        messageId: messageIdOf(raw.message),
        role: ASSISTANT_ROLE,
        at: now(),
      };
    },

    onEligibleTokenDelta(event: unknown): EligibleTokenDelta | null {
      const raw = event as RawUpdateEvent | null;
      if (!raw || typeof raw !== "object" || raw.type !== "message_update") return null;
      const deltaType = raw.assistantMessageEvent?.type;
      if (typeof deltaType !== "string") return null;
      const source = DELTA_SOURCES[deltaType];
      if (source === undefined) return null;
      // 仅 assistant 消息的增量可计量；用户消息 / tool result 无 message_update。
      if (!isAssistantMessage(raw.message)) return null;
      return {
        messageId: messageIdOf(raw.message),
        kind: "eligible_token",
        source,
        at: now(),
        count: 1,
      };
    },

    onAssistantEnd(event: unknown): AssistantEnd | null {
      const raw = event as { type?: unknown; message?: RawMessage } | null;
      if (!raw || typeof raw !== "object" || raw.type !== "message_end") return null;
      if (!isAssistantMessage(raw.message)) return null;
      const stopReason = raw.message.stopReason;
      const hasError = raw.message.errorMessage !== undefined;
      let outcome: Outcome = "completed";
      if (stopReason === "aborted" || hasError || stopReason === "error") {
        outcome = stopReason === "aborted" ? "aborted" : "error";
      }
      return {
        messageId: messageIdOf(raw.message),
        role: ASSISTANT_ROLE,
        at: now(),
        outcome,
      };
    },
  };
}
