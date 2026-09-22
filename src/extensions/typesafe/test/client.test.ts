/**
 * typesafe/client.test.ts — 请求构造、响应解析与错误分类（typesafe-todo#1）
 *
 * 全部是 client.ts 导出的纯函数/可注入依赖：`fetchFn` 是进程边界替身（手写，非 mock 库），
 * 断言的是「发了什么请求、错怎么归类」，不涉及网络。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ASK_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  ErrorCodes,
  askTypesafe,
  buildRequestBody,
  parseAskResponse,
  type FetchLike,
} from "../client.ts";

const KEY = "sk-typesafe-test-0002";
const STATE = "客户说 Stripe 连了三天都失败，快要丢单了。";
const QUESTIONS = {
  urgency: { type: "noul", instructions: "这条消息是否传达紧迫性" },
};

interface Recorded {
  url: string;
  init: RequestInit;
}

/** 记录请求并返回固定响应的手写 fetch 替身（进程边界，不是被测行为）。 */
function recordingFetch(response: () => Response, calls: Recorded[]): FetchLike {
  return async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  };
}

test("client: 常量与端点", () => {
  assert.equal(DEFAULT_BASE_URL, "https://api.typesafe.ai");
  assert.equal(ASK_PATH, "/v1/systemone");
  assert.equal(DEFAULT_MODEL, "jev-latest");
});

test("client: buildRequestBody 固定键序与形状", () => {
  const body = buildRequestBody({ state: STATE, questions: QUESTIONS, model: "jev-1.13.0" });
  assert.equal(body, `{"state":${JSON.stringify(STATE)},"model":"jev-1.13.0","questions":${JSON.stringify(QUESTIONS)}}`);
});

test("client: buildRequestBody 缺省模型落 jev-latest", () => {
  const body = buildRequestBody({ state: STATE, questions: QUESTIONS });
  assert.match(body, /"model":"jev-latest"/);
});

test("client: parseAskResponse 保留三原语的全部字段", () => {
  const raw = {
    model: "jev-1.13.0",
    answers: {
      department: { type: "choice", choice: "technical", confidence: 0.78, probabilities: { technical: 0.85 } },
      frustration: { type: "score", score: 1, confidence: 1, legend: { "0": "平静", "1": "不满" }, probabilities: { "1": 1 } },
      urgency: { type: "noul", noul: 1 },
    },
    usage: { input_tokens: 392, output_tokens: 65 },
  };
  const parsed = parseAskResponse(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.model, "jev-1.13.0");
  assert.deepEqual(parsed.value.answers.department, raw.answers.department);
  assert.deepEqual(parsed.value.answers.frustration.legend, { "0": "平静", "1": "不满" });
  assert.deepEqual(parsed.value.answers.urgency, { type: "noul", noul: 1 });
  assert.deepEqual(parsed.value.usage, { input_tokens: 392, output_tokens: 65 });
});

test("client: parseAskResponse 拒绝坏形状（BAD_RESPONSE）", () => {
  const bad: unknown[] = [
    null,
    "text",
    {},
    { answers: {} },
    { answers: [] },
    { answers: { x: null } },
    { answers: { x: "nope" } },
    { answers: { x: { type: "unknown" } } },
    { answers: { x: { type: 7 } } },
  ];
  for (const raw of bad) {
    const parsed = parseAskResponse(raw);
    assert.equal(parsed.ok, false, `应当拒绝：${JSON.stringify(raw)}`);
    if (parsed.ok) continue;
    assert.equal(parsed.code, ErrorCodes.BAD_RESPONSE);
  }
});

test("client: 无 key 时 NO_KEY，且不发请求", async () => {
  const calls: Recorded[] = [];
  const result = await askTypesafe({
    state: STATE,
    questions: QUESTIONS,
    resolveKey: () => undefined,
    fetchFn: recordingFetch(() => new Response("{}", { status: 200 }), calls),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, ErrorCodes.NO_KEY);
  assert.equal(calls.length, 0, "缺 key 必须 fail-closed，不能空 key 打出去");
});

test("client: 参数非法时 BAD_ARGS，且不发请求", async () => {
  const cases = [
    { state: "", questions: QUESTIONS },
    { state: "   ", questions: QUESTIONS },
    { state: STATE, questions: {} },
    { state: STATE, questions: null },
    { state: STATE, questions: "questions" },
  ];
  for (const c of cases) {
    const calls: Recorded[] = [];
    const result = await askTypesafe({
      state: c.state,
      questions: c.questions,
      resolveKey: () => KEY,
      fetchFn: recordingFetch(() => new Response("{}", { status: 200 }), calls),
    });
    assert.equal(result.ok, false, `应当拒绝：${JSON.stringify(c)}`);
    if (!result.ok) assert.equal(result.code, ErrorCodes.BAD_ARGS);
    assert.equal(calls.length, 0);
  }
});

test("client: 请求方法与头正确，且 Accept/Content-Type 齐备", async () => {
  const calls: Recorded[] = [];
  const result = await askTypesafe({
    state: STATE,
    questions: QUESTIONS,
    resolveKey: () => KEY,
    fetchFn: recordingFetch(
      () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { urgency: { type: "noul", noul: 1 } } }), { status: 200 }),
      calls,
    ),
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, `${DEFAULT_BASE_URL}/v1/systemone`);
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
});

test("client: 非 2xx 归 HTTP，消息只带状态码、不带响应体", async () => {
  const calls: Recorded[] = [];
  const result = await askTypesafe({
    state: STATE,
    questions: QUESTIONS,
    resolveKey: () => KEY,
    fetchFn: recordingFetch(() => new Response("SECRET-RESPONSE-BODY", { status: 500 }), calls),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, ErrorCodes.HTTP);
  assert.match(result.message, /500/);
  assert.ok(!result.message.includes("SECRET-RESPONSE-BODY"), "错误消息不得回显响应体");
  assert.ok(!result.message.includes(KEY), "错误消息不得回显 key");
});

test("client: 响应不是 JSON 时 BAD_RESPONSE", async () => {
  const calls: Recorded[] = [];
  const result = await askTypesafe({
    state: STATE,
    questions: QUESTIONS,
    resolveKey: () => KEY,
    fetchFn: recordingFetch(() => new Response("<html>nope</html>", { status: 200 }), calls),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, ErrorCodes.BAD_RESPONSE);
});

test("client: 超时归 TIMEOUT，其它异常归 NETWORK", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  const timedOut = await askTypesafe({
    state: STATE,
    questions: QUESTIONS,
    resolveKey: () => KEY,
    fetchFn: async () => {
      throw timeout;
    },
  });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.code, ErrorCodes.TIMEOUT);

  const boom = await askTypesafe({
    state: STATE,
    questions: QUESTIONS,
    resolveKey: () => KEY,
    fetchFn: async () => {
      throw new Error(`connect ECONNREFUSED ${KEY}`);
    },
  });
  assert.equal(boom.ok, false);
  if (!boom.ok) {
    assert.equal(boom.code, ErrorCodes.NETWORK);
    assert.ok(!boom.message.includes(KEY), "底层异常文本不得穿透到错误消息");
  }
});

test("client: 调用方可从 baseUrl 覆盖端点（测试/自建网关）", async () => {
  const calls: Recorded[] = [];
  await askTypesafe({
    state: STATE,
    questions: QUESTIONS,
    baseUrl: "http://127.0.0.1:9/fake",
    resolveKey: () => KEY,
    fetchFn: recordingFetch(() => new Response("{}", { status: 500 }), calls),
  });
  assert.equal(calls[0].url, "http://127.0.0.1:9/fake/v1/systemone");
});
