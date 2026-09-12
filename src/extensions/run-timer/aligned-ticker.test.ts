/**
 * aligned-ticker 单测：mock 全局 setTimeout/clearTimeout + 注入墙钟。
 * 验证：首跳对齐秒边界、跨跳自校正（不累积漂移）、stop 幂等、
 * 回调抛错后仍继续排跳、回调内 stop 可取消已排的下一跳。
 *
 * 运行：node --experimental-strip-types --test aligned-ticker.test.ts
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { startAlignedTicker } from "./aligned-ticker.ts";

let current = 0;
let nextId = 0;
const scheduled: Array<{ id: number; at: number; fn: () => void }> = [];
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;

function installFakeTimers(start = 1500): void {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  current = start;
  nextId = 0;
  scheduled.length = 0;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = ++nextId;
    scheduled.push({ id, at: current + (ms ?? 0), fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    const index = scheduled.findIndex((entry) => entry.id === id);
    if (index >= 0) scheduled.splice(index, 1);
  }) as typeof globalThis.clearTimeout;
}

function restoreFakeTimers(): void {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  scheduled.length = 0;
}

const clockNow = () => current;

/** 到点触发下一跳（墙钟推进到目标时刻）。 */
function fireNext(): void {
  const entry = scheduled.shift();
  assert.ok(entry, "expected a scheduled tick");
  current = entry.at;
  entry.fn();
}

/** 模拟宿主晚到：目标时刻 + lateMs 才触发。 */
function fireLate(lateMs: number): void {
  const entry = scheduled.shift();
  assert.ok(entry, "expected a scheduled tick");
  current = entry.at + lateMs;
  entry.fn();
}

beforeEach(() => installFakeTimers());
afterEach(() => restoreFakeTimers());

test("首跳对齐下一个秒边界：now=1500 → 500ms 后触发", () => {
  startAlignedTicker(() => {}, { intervalMs: 1000, now: clockNow });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].at, 2000);
});

test("now 恰在边界时不立刻补跳，排到下一整秒", () => {
  installFakeTimers(2000);
  startAlignedTicker(() => {}, { intervalMs: 1000, now: clockNow });
  assert.equal(scheduled[0].at, 3000);
});

test("跨跳自校正：宿主晚到后仍回到整秒边界，不累积漂移", () => {
  const targets: number[] = [];
  startAlignedTicker(() => targets.push(current), { intervalMs: 1000, now: clockNow });
  assert.equal(scheduled[0].at, 2000);
  fireLate(200); // 宿主 2200 才触发 → 下一跳应为 3000（补回 800ms）
  assert.equal(scheduled[0].at, 3000);
  fireLate(200); // 3200 触发 → 下一跳仍为 4000
  assert.equal(scheduled[0].at, 4000);
  assert.deepEqual(targets, [2200, 3200]);
});

test("回调抛错不冒泡，且仍排下一跳", () => {
  let calls = 0;
  startAlignedTicker(() => {
    calls += 1;
    throw new Error("boom");
  }, { intervalMs: 1000, now: clockNow });
  assert.doesNotThrow(() => fireNext());
  assert.equal(calls, 1);
  assert.equal(scheduled.length, 1, "抛错后节拍继续");
  assert.equal(scheduled[0].at, 3000);
});

test("stop 幂等：重复调用不抛错且无残留排跳", () => {
  const stop = startAlignedTicker(() => {}, { intervalMs: 1000, now: clockNow });
  assert.equal(scheduled.length, 1);
  stop();
  assert.doesNotThrow(() => stop());
  assert.equal(scheduled.length, 0);
});

test("stop 后不再排跳：已排的下一跳被清掉", () => {
  let calls = 0;
  const stop = startAlignedTicker(() => { calls += 1; }, { intervalMs: 1000, now: clockNow });
  stop();
  assert.equal(calls, 0);
  assert.equal(scheduled.length, 0);
});

test("回调内 stop 能取消已排的下一跳", () => {
  let stop: (() => void) | undefined;
  let calls = 0;
  stop = startAlignedTicker(() => {
    calls += 1;
    stop!();
  }, { intervalMs: 1000, now: clockNow });
  fireNext();
  assert.equal(calls, 1);
  assert.equal(scheduled.length, 0, "回调内 stop 后不再有排跳");
});

test("自定义 intervalMs 同样对齐其边界", () => {
  installFakeTimers(1500);
  startAlignedTicker(() => {}, { intervalMs: 250, now: clockNow });
  assert.equal(scheduled[0].at, 1750);
});

test("默认 now 用 Date.now（不注入也能排跳）", () => {
  const realNow = Date.now;
  Date.now = () => 1500;
  try {
    startAlignedTicker(() => {}, { intervalMs: 1000 });
    assert.equal(scheduled[0].at, 2000);
  } finally {
    Date.now = realNow;
  }
});
