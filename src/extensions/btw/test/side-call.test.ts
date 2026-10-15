/**
 * btw 侧调用单测：prompt 组装 + `streamSimple` 调用形状 + 失败归一。
 *
 * 宿主是网络/鉴权边界：这里只 fake `streamSimple` 这一个方法（本扩展真正用到的
 * 那一小面），断言「交给宿主什么」（systemPrompt / maxTokens / sessionId / signal）
 * 与「从宿主拿回什么」（增量、文本、错误码）。真实 provider 调用只能真机验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { buildSidePrompt, runSideCall, type SideCallInput, type StreamSimplePort } from "../side-call.ts";
import { MAX_ANSWER_TOKENS, SIDE_SYSTEM_PROMPT } from "../spec.ts";

const MODEL = { provider: "test", id: "side-model" } as unknown as Model<Api>;

interface Capture {
  model: unknown;
  context: { systemPrompt?: string; messages: Array<{ role?: string; content?: unknown }> };
  options: Record<string, unknown>;
}

function makePort(
  events: unknown[] | ((options: Record<string, unknown>) => unknown[]),
  captured: Capture[] = [],
): StreamSimplePort {
  return {
    streamSimple: (model, context, options) => {
      captured.push({
        model,
        context: context as Capture["context"],
        options: (options ?? {}) as Record<string, unknown>,
      });
      const list = typeof events === "function" ? events((options ?? {}) as Record<string, unknown>) : events;
      return (async function* () {
        for (const event of list) yield event as AssistantMessageEvent;
      })();
    },
  };
}

function makeInput(overrides: Partial<SideCallInput> = {}): SideCallInput {
  return {
    question: "现在在干啥",
    contextText: "[用户] 修 bug\n\n[助手] 在读文件",
    thread: [],
    model: MODEL,
    sessionId: "session-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("buildSidePrompt：无侧线程时不出现 SIDE CHAT SO FAR；含上下文与问题", () => {
  const prompt = buildSidePrompt({ question: "现在在干啥", contextText: "[用户] 修 bug", thread: [] });
  assert.ok(!prompt.includes("SIDE CHAT SO FAR"));
  assert.match(prompt, /MAIN SESSION TRANSCRIPT/);
  assert.ok(prompt.includes("[用户] 修 bug"));
  assert.ok(prompt.trimEnd().endsWith("现在在干啥"));
});

test("buildSidePrompt：空上下文给显式占位（不让模型猜）", () => {
  const prompt = buildSidePrompt({ question: "q", contextText: "   ", thread: [] });
  assert.match(prompt, /\(no transcript entries visible yet\)/);
});

test("buildSidePrompt：有侧线程时按 Q/A 顺序注入上一轮", () => {
  const prompt = buildSidePrompt({
    question: "第二问",
    contextText: "ctx",
    thread: [
      { role: "user", text: "第一问" },
      { role: "assistant", text: "第一答" },
    ],
  });
  assert.match(prompt, /SIDE CHAT SO FAR/);
  assert.match(prompt, /Q: 第一问/);
  assert.match(prompt, /A: 第一答/);
  assert.ok(prompt.indexOf("Q: 第一问") < prompt.indexOf("A: 第一答"));
});

test("runSideCall：systemPrompt / maxTokens / sessionId / signal 如实交给宿主", async () => {
  const captured: Capture[] = [];
  const port = makePort([{ type: "done", message: { content: [{ type: "text", text: "在做 X" }] } }], captured);
  const controller = new AbortController();
  const result = await runSideCall(makeInput({ signal: controller.signal }), port, { nowMs: () => 1234 });
  assert.deepEqual(result, { ok: true, value: { text: "在做 X" } });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.context.systemPrompt, SIDE_SYSTEM_PROMPT);
  assert.equal(captured[0]!.context.messages.length, 1);
  assert.equal(captured[0]!.context.messages[0]!.role, "user");
  assert.ok(String(captured[0]!.context.messages[0]!.content).includes("现在在干啥"));
  assert.equal(captured[0]!.options.maxTokens, MAX_ANSWER_TOKENS);
  assert.equal(captured[0]!.options.sessionId, "session-1");
  assert.equal(captured[0]!.options.signal, controller.signal);
  assert.equal((captured[0]!.model as { id?: string }).id, "side-model");
});

test("runSideCall：流式增量只回调 text_delta；done 文本过滤 thinking", async () => {
  const deltas: string[] = [];
  const seenEvents: string[] = [];
  const port = makePort((options) => {
    seenEvents.push(String(options.sessionId));
    return [
      { type: "thinking_delta", delta: "内部推理" },
      { type: "text_delta", delta: "在做" },
      { type: "text_delta", delta: "测试" },
      { type: "done", message: { content: [{ type: "thinking", thinking: "内部推理" }, { type: "text", text: "在做测试" }] } },
    ];
  });
  const result = await runSideCall(makeInput({ onDelta: (delta) => deltas.push(delta) }), port, { nowMs: () => 0 });
  assert.deepEqual(deltas, ["在做", "测试"]);
  assert.deepEqual(result, { ok: true, value: { text: "在做测试" } });
  assert.deepEqual(seenEvents, ["session-1"], "sessionId 随 options 进宿主（opencode 系请求头靠它）");
});

test("runSideCall：流内 error 事件 → side-call-error，message 为宿主诊断原文", async () => {
  const port = makePort([{ type: "error", reason: "error", error: { errorMessage: "401 unauthorized", stopReason: "error" } }]);
  const result = await runSideCall(makeInput(), port, { nowMs: () => 0 });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.code : "", "side-call-error");
  assert.match(result.ok === false ? result.message : "", /401 unauthorized/);
});

test("runSideCall：streamSimple 抛错 → side-call-error（绝不把异常抛给调用方）", async () => {
  const port: StreamSimplePort = {
    streamSimple: () => {
      throw new Error("boom");
    },
  };
  const result = await runSideCall(makeInput(), port, { nowMs: () => 0 });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.code : "", "side-call-error");
  assert.match(result.ok === false ? result.message : "", /boom/);
});

test("runSideCall：已 abort 的 signal → aborted（不是 side-call-error）", async () => {
  const controller = new AbortController();
  controller.abort();
  const port = makePort([
    { type: "text_delta", delta: "x" },
    { type: "done", message: { content: [] } },
  ]);
  const result = await runSideCall(makeInput({ signal: controller.signal }), port, { nowMs: () => 0 });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.code : "", "aborted");
});

test("runSideCall：无 sessionId 时如实传 undefined（不伪造请求头）", async () => {
  const captured: Capture[] = [];
  const input = makeInput();
  delete input.sessionId;
  await runSideCall(input, makePort([{ type: "done", message: { content: [] } }], captured), { nowMs: () => 0 });
  assert.equal(captured[0]!.options.sessionId, undefined);
  assert.equal("sessionId" in captured[0]!.options, true, "字段存在但值为 undefined（契约显式）");
});

test("runSideCall：空回答返回空串（由面板/通知层决定怎么显示）", async () => {
  const port = makePort([{ type: "done", message: { content: [] } }]);
  const result = await runSideCall(makeInput(), port, { nowMs: () => 0 });
  assert.deepEqual(result, { ok: true, value: { text: "" } });
});
