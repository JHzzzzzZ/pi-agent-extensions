/**
 * 测试夹具：构造与 pi Extension API 结构一致的 message_* 事件
 * （按结构识别，仅含测试所需字段，不含内容解析依赖）。
 */

export interface FakeMessage {
  role: string;
  responseId?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown[];
}

export function assistantMessage(
  responseId: string | undefined,
  stopReason = "pending",
  errorMessage?: string,
): FakeMessage {
  return { role: "assistant", responseId, stopReason, errorMessage, content: [] };
}

export function userMessage(): FakeMessage {
  return { role: "user", content: [] };
}

export function toolResultMessage(): FakeMessage {
  return { role: "toolResult", content: [] };
}

export function messageStartEvent(message: FakeMessage): unknown {
  return { type: "message_start", message };
}

export function messageEndEvent(message: FakeMessage): unknown {
  return { type: "message_end", message };
}

export type DeltaType = "text_delta" | "thinking_delta" | "toolcall_delta";

export function messageUpdateEvent(
  message: FakeMessage,
  deltaType: DeltaType,
): unknown {
  return {
    type: "message_update",
    message,
    assistantMessageEvent: { type: deltaType, contentIndex: 0, delta: "x", partial: message },
  };
}

/** 未知/不可计量的 message_update 增量（text_start、done、未知类型等）。 */
export function messageUpdateUnknownEvent(message: FakeMessage, deltaType: string): unknown {
  return {
    type: "message_update",
    message,
    assistantMessageEvent: { type: deltaType, contentIndex: 0, partial: message },
  };
}

/** 记录所有 setStatus 调用的内存状态端口。 */
export class RecordingStatusPort {
  calls: Array<{ key: string; text: string | undefined }> = [];
  uiAvailable = true;
  throwOnSet = false;

  available(): boolean {
    return this.uiAvailable;
  }

  setStatus(key: string, text: string | undefined): void {
    if (this.throwOnSet) throw new Error("ui exploded");
    this.calls.push({ key, text });
  }

  last(): string | undefined {
    return this.calls.length > 0 ? this.calls[this.calls.length - 1].text : undefined;
  }

  /** 仅返回本扩展状态键的文本序列。 */
  statuses(): string[] {
    return this.calls
      .filter((c) => c.key === "stream-token-speed")
      .map((c) => c.text ?? "");
  }
}
