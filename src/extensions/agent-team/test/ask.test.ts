/**
 * Ask channel tests: RPC dialog parsing (extension_ui_request), leader-side
 * dialog mapping (team_ask), response wire shapes, cockpit-side serialization
 * and every fail-closed degradation path (timeout / cancelled / no UI /
 * abort / dispose). Pure logic + injected ports — no processes here.
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASK_BACKSTOP_MARGIN_MS,
  ASK_METHODS,
  AskChannel,
  askLeaderQuestion,
  askResponseLine,
  buildAskDialog,
  buildAskTitle,
  clampAskAnswer,
  formatAskResult,
  outcomeEntryText,
  parseAskRequest,
  questionEntryText,
  resolveAskTimeout,
  resolveAskToolTimeout,
  type AskOutcome,
  type AskPort,
  type AskRequest,
} from "../ask.ts";
import { ASK_TIMEOUT_DEFAULT_MS, ASK_TIMEOUT_MAX_MS, ASK_TIMEOUT_MIN_MS } from "../types.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    id: "q1",
    method: "input",
    title: "要发到哪个环境？",
    ...overrides,
  };
}

function request(overrides: Partial<AskRequest> = {}): AskRequest {
  return { id: "q1", method: "input", title: "要发到哪个环境？", ...overrides };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseAskRequest accepts all four dialog methods with their optional fields", () => {
  assert.deepEqual(parseAskRequest(wire()), { id: "q1", method: "input", title: "要发到哪个环境？" });
  const select = parseAskRequest(wire({ method: "select", options: ["staging", "prod"], timeout: 1000 }));
  assert.deepEqual(select, {
    id: "q1",
    method: "select",
    title: "要发到哪个环境？",
    options: ["staging", "prod"],
    timeoutMs: 1000,
  });
  assert.equal(parseAskRequest(wire({ method: "confirm", message: "全部丢失" }))?.message, "全部丢失");
  assert.equal(parseAskRequest(wire({ method: "editor", prefill: "a\nb" }))?.prefill, "a\nb");
  assert.equal(parseAskRequest(wire({ placeholder: "输入" }))?.placeholder, "输入");
  assert.deepEqual([...ASK_METHODS], ["select", "confirm", "input", "editor"]);
});

test("parseAskRequest ignores non-dialog wire lines and malformed requests", () => {
  assert.equal(parseAskRequest({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" }), null);
  assert.equal(parseAskRequest({ type: "extension_ui_request", id: "s1", method: "setStatus" }), null);
  assert.equal(parseAskRequest({ type: "response", command: "prompt", success: true }), null);
  assert.equal(parseAskRequest({ type: "extension_ui_request", id: "x", method: "bogus", title: "t" }), null);
  assert.equal(parseAskRequest({ type: "extension_ui_request", method: "input", title: "t" }), null, "missing id");
  assert.equal(parseAskRequest({ type: "extension_ui_request", id: "x", method: "input" }), null, "missing title");
  assert.equal(parseAskRequest(wire({ method: "select" })), null, "select without options is unusable");
  assert.equal(parseAskRequest(wire({ method: "select", options: [] })), null);
  assert.equal(parseAskRequest(wire({ timeout: -5 }))?.timeoutMs, undefined, "non-positive timeout is dropped");
  assert.equal(parseAskRequest(wire({ timeout: Number.NaN }))?.timeoutMs, undefined);
});

test("resolveAskTimeout defaults to 10 minutes and caps at 30 minutes; tool params keep a 30s floor", () => {
  assert.equal(ASK_TIMEOUT_DEFAULT_MS, 600_000, "默认 10 分钟（用户选定）");
  assert.equal(ASK_TIMEOUT_MIN_MS, 30_000);
  assert.equal(ASK_TIMEOUT_MAX_MS, 1_800_000);
  assert.equal(resolveAskTimeout(undefined), 600_000);
  assert.equal(resolveAskTimeout(1000), 1000, "cockpit honours a short wired wait (tests / explicit calls)");
  assert.equal(resolveAskTimeout(999_999_999), 1_800_000);
  assert.equal(resolveAskToolTimeout(undefined), 600_000);
  assert.equal(resolveAskToolTimeout(1000), 30_000, "the tool never asks a human for less than 30s");
  assert.equal(resolveAskToolTimeout(999_999_999), 1_800_000);
});

// ---------------------------------------------------------------------------
// Response wire shapes
// ---------------------------------------------------------------------------

test("askResponseLine emits value/confirmed/cancelled responses", () => {
  assert.deepEqual(JSON.parse(askResponseLine(request({ method: "input" }), { kind: "answer", value: "staging" })), {
    type: "extension_ui_response",
    id: "q1",
    value: "staging",
  });
  assert.deepEqual(JSON.parse(askResponseLine(request({ method: "select" }), { kind: "answer", value: "prod" })), {
    type: "extension_ui_response",
    id: "q1",
    value: "prod",
  });
  assert.deepEqual(JSON.parse(askResponseLine(request({ method: "confirm" }), { kind: "answer", value: true })), {
    type: "extension_ui_response",
    id: "q1",
    confirmed: true,
  });
  assert.deepEqual(JSON.parse(askResponseLine(request({ method: "confirm" }), { kind: "answer", value: false })), {
    type: "extension_ui_response",
    id: "q1",
    confirmed: false,
  });
  for (const outcome of [{ kind: "cancelled" }, { kind: "timeout" }, { kind: "unavailable" }] as AskOutcome[]) {
    assert.deepEqual(JSON.parse(askResponseLine(request(), outcome)), {
      type: "extension_ui_response",
      id: "q1",
      cancelled: true,
    });
  }
});

// ---------------------------------------------------------------------------
// AskChannel (cockpit side)
// ---------------------------------------------------------------------------

test("AskChannel presents a request, writes the answer response and reports the outcome", async () => {
  const writes: string[] = [];
  const questions: AskRequest[] = [];
  const outcomes: Array<{ id: string; kind: string }> = [];
  const channel = new AskChannel({
    port: { present: async () => ({ kind: "answer", value: "staging" }) },
    write: (line) => writes.push(line),
    onQuestion: (r) => questions.push(r),
    onOutcome: (r, outcome) => outcomes.push({ id: r.id, kind: outcome.kind }),
  });
  channel.handle(wire({ method: "select", options: ["staging", "prod"] }));
  await sleep(5);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].id, "q1");
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]), { type: "extension_ui_response", id: "q1", value: "staging" });
  assert.deepEqual(outcomes, [{ id: "q1", kind: "answer" }]);
  channel.dispose();
});

test("AskChannel answers cancelled when no main-session UI is available", async () => {
  const writes: string[] = [];
  const outcomes: string[] = [];
  const channel = new AskChannel({
    write: (line) => writes.push(line),
    onOutcome: (_r, outcome) => outcomes.push(outcome.kind),
  });
  channel.handle(wire());
  await sleep(5);
  assert.deepEqual(JSON.parse(writes[0]), { type: "extension_ui_response", id: "q1", cancelled: true });
  assert.deepEqual(outcomes, ["unavailable"]);
  channel.dispose();
});

test("AskChannel serializes concurrent dialogs (one visible at a time, FIFO)", async () => {
  const presented: string[] = [];
  const resolvers: Array<(outcome: AskOutcome) => void> = [];
  const port: AskPort = {
    present: (r) =>
      new Promise<AskOutcome>((resolve) => {
        presented.push(r.id);
        resolvers.push(resolve);
      }),
  };
  const channel = new AskChannel({ port, write: () => {} });
  channel.handle(wire({ id: "q1" }));
  channel.handle(wire({ id: "q2" }));
  await sleep(5);
  assert.deepEqual(presented, ["q1"], "second request waits for the first dialog");
  resolvers[0]({ kind: "answer", value: "a" });
  await sleep(5);
  assert.deepEqual(presented, ["q1", "q2"]);
  resolvers[1]({ kind: "cancelled" });
  await sleep(5);
  channel.dispose();
});

test("AskChannel ignores duplicate ids and malformed lines", async () => {
  const presented: string[] = [];
  const channel = new AskChannel({
    port: {
      present: async (r) => {
        presented.push(r.id);
        return { kind: "cancelled" };
      },
    },
    write: () => {},
  });
  channel.handle(wire({ id: "q1" }));
  channel.handle(wire({ id: "q1" }));
  channel.handle({ type: "response", command: "prompt", success: true });
  channel.handle(wire({ id: "q2", method: "select" }));
  await sleep(10);
  assert.deepEqual(presented, ["q1"], "duplicate + malformed lines never reach the port");
  channel.dispose();
});

test("AskChannel backstop timeout cancels a dialog the host never resolves", async () => {
  const writes: string[] = [];
  const outcomes: string[] = [];
  const channel = new AskChannel({
    port: { present: () => new Promise<AskOutcome>(() => {}) },
    write: (line) => writes.push(line),
    onOutcome: (_r, outcome) => outcomes.push(outcome.kind),
    backstopMarginMs: 10,
  });
  channel.handle(wire({ timeout: 20 }));
  await sleep(80);
  assert.deepEqual(JSON.parse(writes[0] ?? "{}"), { type: "extension_ui_response", id: "q1", cancelled: true });
  assert.deepEqual(outcomes, ["timeout"]);
  channel.dispose();
});

test("AskChannel cancels the in-flight dialog when the run aborts", async () => {
  const writes: string[] = [];
  let seenSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const channel = new AskChannel({
    port: {
      present: (_r, signal) => {
        seenSignal = signal;
        return new Promise<AskOutcome>(() => {});
      },
    },
    write: (line) => writes.push(line),
    signal: controller.signal,
  });
  channel.handle(wire());
  await sleep(5);
  assert.equal(seenSignal?.aborted, false);
  controller.abort();
  await sleep(5);
  assert.equal(seenSignal?.aborted, true, "host dialog signal is aborted");
  assert.deepEqual(JSON.parse(writes[0] ?? "{}"), { type: "extension_ui_response", id: "q1", cancelled: true });
  assert.equal(writes.length, 1);
  channel.handle(wire({ id: "q2" }));
  await sleep(5);
  assert.equal(writes.length, 1, "requests after abort are ignored");
});

test("AskChannel writes cancelled for queued requests when the run aborts", async () => {
  const writes: string[] = [];
  const controller = new AbortController();
  const channel = new AskChannel({
    port: { present: () => new Promise<AskOutcome>(() => {}) },
    write: (line) => writes.push(line),
    signal: controller.signal,
  });
  channel.handle(wire({ id: "q1" }));
  channel.handle(wire({ id: "q2" }));
  await sleep(5);
  controller.abort();
  await sleep(5);
  assert.equal(writes.length, 2, "in-flight + queued both get a cancelled response");
  assert.deepEqual(JSON.parse(writes[0]).id, "q1");
  assert.deepEqual(JSON.parse(writes[1]).id, "q2");
});

test("AskChannel dispose drops the in-flight dialog (no late response after the run settled)", async () => {
  const writes: string[] = [];
  let resolvePort: ((outcome: AskOutcome) => void) | undefined;
  const channel = new AskChannel({
    port: { present: () => new Promise<AskOutcome>((resolve) => (resolvePort = resolve)) },
    write: (line) => writes.push(line),
  });
  channel.handle(wire());
  await sleep(5);
  channel.dispose();
  resolvePort?.({ kind: "answer", value: "late" });
  await sleep(5);
  assert.equal(writes.length, 0);
});

test("AskChannel swallows write failures and port exceptions", async () => {
  const channel = new AskChannel({
    port: { present: async () => { throw new Error("stale ctx"); } },
    write: () => {
      throw new Error("stdin closed");
    },
  });
  channel.handle(wire());
  await sleep(5);
  channel.dispose();
});

// ---------------------------------------------------------------------------
// Leader side (team_ask)
// ---------------------------------------------------------------------------

test("buildAskTitle flattens the question and prefixes the team, bounded to 300 chars", () => {
  assert.equal(buildAskTitle("dev-team", "要发到哪个环境？"), "[dev-team] 要发到哪个环境？");
  assert.equal(buildAskTitle("dev-team", "第一行\n第二行"), "[dev-team] 第一行 第二行");
  assert.equal(buildAskTitle("dev-team", "x".repeat(400)).length, "[dev-team] ".length + 300 + 1);
});

test("buildAskDialog picks select when options are given, input otherwise", () => {
  const select = buildAskDialog("dev-team", { question: "环境？", options: ["staging", "prod"] });
  assert.equal(select.method, "select");
  assert.deepEqual(select.options, ["staging", "prod"]);
  assert.equal(select.title, "[dev-team] 环境？");
  const input = buildAskDialog("dev-team", { question: "环境？" });
  assert.equal(input.method, "input");
  assert.match(input.placeholder ?? "", /Esc 取消/);
});

test("askLeaderQuestion passes timeout/signal to the dialog and trims the answer", async () => {
  const calls: Array<{ title: string; placeholder?: string; options?: string[]; timeout?: number; hasSignal: boolean }> = [];
  const controller = new AbortController();
  const ui = {
    input: async (title: string, placeholder?: string, opts?: { timeout?: number; signal?: AbortSignal }) => {
      calls.push({ title, placeholder, timeout: opts?.timeout, hasSignal: opts?.signal === controller.signal });
      return "  staging  ";
    },
    select: async (title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }) => {
      calls.push({ title, options, timeout: opts?.timeout, hasSignal: opts?.signal === controller.signal });
      return options[1];
    },
  };
  const input = await askLeaderQuestion(ui, "dev-team", { question: "环境？", timeoutMs: 1000 }, controller.signal);
  assert.deepEqual(input, { answered: true, answer: "staging" });
  assert.equal(calls[0].timeout, 30_000, "tool floor applies");
  assert.equal(calls[0].hasSignal, true);
  const select = await askLeaderQuestion(ui, "dev-team", { question: "环境？", options: ["a", "b"] });
  assert.deepEqual(select, { answered: true, answer: "b" });
  assert.equal(calls[1].timeout, 600_000, "default applies");
  assert.equal(calls[1].hasSignal, false);
});

test("askLeaderQuestion reports unanswered for undefined/blank/timeout/throw", async () => {
  const noUi = { input: async () => undefined, select: async () => undefined };
  const blank = { input: async () => "   ", select: async () => undefined };
  const boom = {
    input: async () => {
      throw new Error("stale ctx");
    },
    select: async () => undefined,
  };
  assert.deepEqual(await askLeaderQuestion(noUi, "t", { question: "q" }), { answered: false });
  assert.deepEqual(await askLeaderQuestion(blank, "t", { question: "q" }), { answered: false });
  assert.deepEqual(await askLeaderQuestion(boom, "t", { question: "q" }), { answered: false });
});

test("formatAskResult keeps answers bounded and nudges the leader to proceed when unanswered", () => {
  const answered = formatAskResult({ answered: true, answer: "staging" });
  assert.equal(answered.text, "用户回答：\nstaging");
  assert.deepEqual(answered.details, { answered: true, answer: "staging" });
  const long = formatAskResult({ answered: true, answer: "x".repeat(10_000) });
  assert.ok(long.details.answer !== undefined && long.details.answer.length <= 4096, "answer bounded for the leader context");
  const unanswered = formatAskResult({ answered: false });
  assert.deepEqual(unanswered.details, { answered: false });
  assert.match(unanswered.text, /不要重复追问/);
  assert.match(unanswered.text, /最合理的假设/);
  assert.equal(clampAskAnswer("x".repeat(10_000)).length, 4096);
  assert.equal(ASK_BACKSTOP_MARGIN_MS, 5000);
});

test("question/outcome transcript text keeps the question, options and degradation reason", () => {
  assert.equal(questionEntryText(request({ title: "[dev-team] 要发到哪个环境？" })), "提问：[dev-team] 要发到哪个环境？");
  assert.equal(
    questionEntryText(request({ method: "select", options: ["staging", "prod"] })),
    "提问：要发到哪个环境？\n选项：staging / prod",
  );
  assert.deepEqual(outcomeEntryText({ kind: "answer", value: "staging" }), { kind: "answer", text: "回答：staging" });
  assert.deepEqual(outcomeEntryText({ kind: "answer", value: false }), { kind: "answer", text: "回答：否" });
  assert.deepEqual(outcomeEntryText({ kind: "cancelled" }), { kind: "system", text: "未获回答（用户取消）" });
  assert.deepEqual(outcomeEntryText({ kind: "timeout" }), { kind: "system", text: "未获回答（超时）" });
  assert.deepEqual(outcomeEntryText({ kind: "unavailable" }), { kind: "system", text: "未获回答（主会话无 UI）" });
});
