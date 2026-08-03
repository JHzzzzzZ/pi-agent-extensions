/**
 * 适配层单元测试：pi 事件 -> 内部契约的映射与过滤
 * （覆盖 AC-03 未知事件忽略、AC-06 取消/错误 outcome、tool result 排除、
 * 三类可计量增量、messageId 提取）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamAdapter } from "../adapter.ts";
import {
  assistantMessage,
  messageEndEvent,
  messageStartEvent,
  messageUpdateEvent,
  messageUpdateUnknownEvent,
  toolResultMessage,
  userMessage,
} from "./fixtures.ts";

/** 可控时钟适配器。 */
function makeAdapter() {
  let t = 0;
  const adapter = createStreamAdapter(() => t);
  return {
    adapter,
    at: (v: number) => {
      t = v;
    },
  };
}

test("assistant message_start -> AssistantStart（携带 responseId 与时间）", () => {
  const { adapter, at } = makeAdapter();
  at(1234);
  const s = adapter.onAssistantStart(messageStartEvent(assistantMessage("resp-1")));
  assert.deepEqual(s, { messageId: "resp-1", role: "assistant", at: 1234 });
});

test("无 responseId 时 messageId 为空串（未知 id，由控制器按通配处理）", () => {
  const { adapter, at } = makeAdapter();
  at(1);
  const s1 = adapter.onAssistantStart(messageStartEvent(assistantMessage(undefined)));
  at(2);
  const s2 = adapter.onAssistantStart(messageStartEvent(assistantMessage(undefined)));
  assert.equal(s1!.messageId, "");
  assert.equal(s2!.messageId, "");
});

test("三类可计量增量 -> EligibleTokenDelta，count 恒为 1", () => {
  const { adapter, at } = makeAdapter();
  const msg = assistantMessage("resp-1");
  at(500);
  assert.deepEqual(
    adapter.onEligibleTokenDelta(messageUpdateEvent(msg, "text_delta")),
    { messageId: "resp-1", kind: "eligible_token", source: "text", at: 500, count: 1 },
  );
  at(501);
  assert.equal(adapter.onEligibleTokenDelta(messageUpdateEvent(msg, "thinking_delta"))!.source, "thinking");
  at(502);
  assert.equal(adapter.onEligibleTokenDelta(messageUpdateEvent(msg, "toolcall_delta"))!.source, "tool_call");
});

test("AC-03：未知/不可计量增量 -> null（text_start、done、error、未知类型）", () => {
  const { adapter } = makeAdapter();
  const msg = assistantMessage("resp-1");
  for (const type of ["text_start", "text_end", "thinking_start", "toolcall_start", "done", "error", "mystery_delta"]) {
    assert.equal(adapter.onEligibleTokenDelta(messageUpdateUnknownEvent(msg, type)), null, type);
  }
  assert.equal(adapter.onEligibleTokenDelta(null), null);
  assert.equal(adapter.onEligibleTokenDelta({}), null);
  assert.equal(adapter.onEligibleTokenDelta("nope"), null);
});

test("非 assistant 消息与其它事件类型 -> null（用户消息、tool result）", () => {
  const { adapter } = makeAdapter();
  assert.equal(adapter.onAssistantStart(messageStartEvent(userMessage())), null);
  assert.equal(adapter.onAssistantStart(messageStartEvent(toolResultMessage())), null);
  assert.equal(adapter.onAssistantEnd(messageEndEvent(toolResultMessage())), null);
  assert.equal(adapter.onAssistantEnd(messageEndEvent(userMessage())), null);
  assert.equal(adapter.onAssistantStart({ type: "message_end", message: assistantMessage("r") }), null);
  assert.equal(adapter.onAssistantStart({ type: "session_start" }), null);
});

test("tool result 的消息生命周期事件完全不可计量（AC-07 适配层）", () => {
  const { adapter, at } = makeAdapter();
  at(100);
  assert.equal(adapter.onAssistantStart(messageStartEvent(toolResultMessage())), null);
  at(200);
  assert.equal(adapter.onEligibleTokenDelta(messageUpdateEvent(toolResultMessage(), "text_delta")), null);
  at(300);
  assert.equal(adapter.onAssistantEnd(messageEndEvent(toolResultMessage())), null);
});

test("assistant message_end -> AssistantEnd；completed / aborted / error outcome", () => {
  const { adapter, at } = makeAdapter();
  at(900);
  assert.deepEqual(
    adapter.onAssistantEnd(messageEndEvent(assistantMessage("resp-1", "stop"))),
    { messageId: "resp-1", role: "assistant", at: 900, outcome: "completed" },
  );
  at(901);
  assert.equal(adapter.onAssistantEnd(messageEndEvent(assistantMessage("r", "aborted")))!.outcome, "aborted");
  at(902);
  assert.equal(adapter.onAssistantEnd(messageEndEvent(assistantMessage("r", "error")))!.outcome, "error");
  at(903);
  assert.equal(adapter.onAssistantEnd(messageEndEvent(assistantMessage("r", "pending", "boom")))!.outcome, "error");
});
