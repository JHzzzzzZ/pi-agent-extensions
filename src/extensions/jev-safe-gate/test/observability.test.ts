/**
 * 可观测性单测（纯逻辑 + 记录桩）：
 * fail-open 的补偿要求是「放行必须看得见」——计数、最近原因、首次提示、
 * 无 UI 时落到 stderr，四条通道各锁一条断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATUS_KEY,
  createReleaseObserver,
  logLine,
  notifyText,
  statusText,
  type ReleaseSink,
} from "../observability.ts";
import { FailOpenReasons } from "../gate.ts";

function makeSink() {
  const seen = { status: [] as Array<string | undefined>, notify: [] as string[], log: [] as string[] };
  const sink: ReleaseSink = {
    setStatus: (text) => seen.status.push(text),
    notify: (text) => seen.notify.push(text),
    log: (line) => seen.log.push(line),
  };
  return { sink, seen };
}

test("statusText：显示放行计数与最近一次原因（状态条契约要求的最小信息）", () => {
  const text = statusText(2, FailOpenReasons.classifyTimeout);
  assert.match(text, /2/, "计数可见");
  assert.match(text, /超时/, "最近原因可见（短标签）");
  assert.ok(text.length <= 20, `footer 段要短：${text}`);
});

test("record：计数累加、最近原因更新、状态条每次重写、只提示一次", () => {
  const { sink, seen } = makeSink();
  const observer = createReleaseObserver();
  observer.record(FailOpenReasons.classifyError, sink);
  observer.record(FailOpenReasons.classifyTimeout, sink);
  observer.record(FailOpenReasons.noUI, sink);
  assert.equal(observer.count(), 3);
  assert.equal(observer.lastReason(), FailOpenReasons.noUI);
  assert.equal(seen.status.length, 3, "每次放行都重写状态条（数量在变）");
  assert.match(String(seen.status[0]), /1/);
  assert.match(String(seen.status[2]), /无界面/);
  assert.equal(seen.notify.length, 1, "首次放行给一次 notify，之后交给状态条");
  assert.equal(seen.log.length, 3, "每一次放行都留一行可查日志");
  assert.equal(logLine(FailOpenReasons.noUI, 3), seen.log[2]);
});

test("notifyText：静态模板（带原因码与计数），不插值命令原文", () => {
  const text = notifyText(FailOpenReasons.classifierUnavailable, 1);
  assert.match(text, /classifier-unavailable/);
  assert.match(text, /1/);
});

test("reset：清零计数并清掉状态条（换会话不留上一轮的残留段）", () => {
  const { sink, seen } = makeSink();
  const observer = createReleaseObserver();
  observer.record(FailOpenReasons.classifyError, sink);
  observer.reset(sink);
  assert.equal(observer.count(), 0);
  assert.equal(observer.lastReason(), undefined);
  assert.equal(seen.status.at(-1), undefined, "reset 必须写 undefined 清段");
  assert.equal(seen.notify.length, 1, "reset 不发通知");
});

test("STATUS_KEY：带两位排序前缀的 footer 键（docs/cross/status-bar.md 契约）", () => {
  assert.equal(STATUS_KEY, "60:jev-safe-gate");
  assert.ok("50:stream-token-speed".localeCompare(STATUS_KEY) < 0, "带序必须排在既有段之后");
});

test("writeBand 协调：状态文本经 status-band 落段（回调用已含前缀的文本）", async () => {
  const { writeBand } = await import("../status-band.ts");
  const bands = new Map<string, string | undefined>();
  writeBand(STATUS_KEY, statusText(1, FailOpenReasons.classifyError), (text) => bands.set(STATUS_KEY, text));
  assert.match(String(bands.get(STATUS_KEY)), /放行1/);
  writeBand(STATUS_KEY, undefined, (text) => bands.set(STATUS_KEY, text));
  assert.equal(bands.get(STATUS_KEY), undefined);
});
