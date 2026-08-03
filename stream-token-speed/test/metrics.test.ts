/**
 * 度量层单元测试：覆盖 JHL-10-PRD-v2 §8 的计算口径
 * （1 秒滑动窗口、未满窗口分母、250ms 节流、结束补算、除零防护）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addEligibleDelta,
  computeSummary,
  createRun,
  effectiveStreamingSeconds,
  formatSummary,
  formatTps,
  formatWarmupStatus,
  instantTps,
  isWarmingUp,
  shouldRender,
  updateEma,
  WINDOW_MS,
  THROTTLE_MS,
  WARMUP_MS,
  EMA_ALPHA,
  type MetricRun,
} from "../metrics.ts";

function run(messageId = "m1", startAt = 0): MetricRun {
  return createRun(messageId, startAt);
}

test("createRun 初始化：无可计量增量前 TTFT 未定、速度为 0", () => {
  const r = run();
  assert.equal(r.totalEligibleTokens, 0);
  assert.equal(r.firstEligibleDeltaAt, undefined);
  assert.equal(instantTps(r, 1000), 0);
  assert.deepEqual(computeSummary(r, 500), {
    ttftMs: 0,
    lastInstantTps: 0,
    averageTps: 0,
    hasStreamingData: false,
    lastInstantCarried: false,
  });
});

test("AC-01 口径：1 秒观察窗内 18 个增量在窗口满 1s 的刷新点显示 18.0 tok/s", () => {
  // 首增量到达瞬间：未满窗口最小分母 1ms -> 1/0.001 = 1000
  const first = run();
  addEligibleDelta(first, "thinking", 420);
  assert.equal(instantTps(first, 420), 1000);

  const r = run("m1", 0);
  // 首个 thinking_delta 于 420ms 到达；随后每 50ms 一个增量，共 18 个（到 1270ms）。
  const times = [420, 470, 520, 570, 620, 670, 720, 770, 820, 870, 920];
  for (const t of times) addEligibleDelta(r, "thinking", t);
  // 未满窗口：920ms 时窗口 500ms、11 个样本 -> 22.0
  assert.equal(instantTps(r, 920), 22.0);
  for (const t of [970, 1020, 1070, 1120, 1170, 1220, 1270]) addEligibleDelta(r, "thinking", t);
  assert.equal(r.totalEligibleTokens, 18);
  assert.equal(r.firstEligibleDeltaAt, 420);
  // 到 1420ms 时窗口 [420,1420] 恰好 1s、18 个样本 -> 18.0
  assert.equal(instantTps(r, 1420), 18.0);
});

test("AC-02 口径：未满 1 秒窗口用实际观察窗口作分母", () => {
  const r = run();
  // 首个 toolcall_delta 后 500ms 内累计 5 个增量
  for (const t of [0, 100, 200, 300, 400]) addEligibleDelta(r, "tool_call", t);
  assert.equal(instantTps(r, 500), 5 / 0.5);
  assert.equal(formatTps(instantTps(r, 500)), "10.0 tok/s");
});

test("窗口清理：超过 1,000ms 的样本被移除，长回复内存有界", () => {
  const r = run();
  for (let t = 0; t <= 5000; t += 100) addEligibleDelta(r, "text", t);
  assert.ok(r.samples.length <= 11, `samples=${r.samples.length}`);
  // 窗口 [4000,5000] 内 11 个样本 -> 11 tok/s
  assert.equal(instantTps(r, 5000), 11.0);
});

test("混合来源增量（text/thinking/tool_call）全部计入", () => {
  const r = run();
  addEligibleDelta(r, "thinking", 10);
  addEligibleDelta(r, "text", 20);
  addEligibleDelta(r, "tool_call", 30);
  assert.equal(r.totalEligibleTokens, 3);
  assert.deepEqual(r.samples.map((s) => s.source), ["thinking", "text", "tool_call"]);
});

test("250ms 节流：shouldRender 在未满 250ms 时返回 false", () => {
  const r = run();
  assert.equal(shouldRender(r, 0), true); // 从未渲染过 -> 允许
  r.lastRenderAt = 0;
  assert.equal(shouldRender(r, 249), false);
  assert.equal(shouldRender(r, 250), true);
  assert.equal(shouldRender(r, 1000), true);
});

test("EMA 平滑：α=0.3，首值取原始值（种子），后续 0.3×raw + 0.7×prev", () => {
  const r = run();
  assert.equal(updateEma(r, 100), 100); // 种子
  assert.equal(updateEma(r, 100), 100); // 稳定值不变
  assert.ok(Math.abs(updateEma(r, 20) - 76) < 1e-9, "0.3*20+0.7*100=76");
  assert.ok(Math.abs(updateEma(r, 20) - 59.2) < 1e-9, "0.3*20+0.7*76=59.2");
  assert.equal(EMA_ALPHA, 0.3);
  // 连续等值输入收敛到该值
  let v = 0;
  for (let i = 0; i < 60; i++) v = updateEma(r, 40);
  assert.ok(Math.abs(v - 40) < 0.001, `converged=${v}`);
});

test("有效流式时长：= 最后增量 − 首增量（末端无输出/工具执行间隙不占时长）", () => {
  const r = run();
  for (const t of [100, 200, 300, 400, 500]) addEligibleDelta(r, "text", t);
  assert.equal(effectiveStreamingSeconds(r), 0.4);
  // 单增量：最小分母 1ms
  const single = run();
  addEligibleDelta(single, "text", 100);
  assert.equal(effectiveStreamingSeconds(single), 0.001);
});

test("AC-04 口径（v3）：结束汇总 = TTFT + EMA 最后瞬时 + 有效流式时长平均", () => {
  const r = run("m1", 0);
  // TTFT 420ms；36 个增量分布在 2 秒内，最后 1s 内 18 个
  for (let i = 0; i < 36; i++) addEligibleDelta(r, "text", 420 + i * (2000 / 36));
  const s = computeSummary(r, 2420);
  assert.equal(s.ttftMs, 420);
  // 平均按有效流式时长：36 / (2364.4 − 420)ms ≈ 18.5
  assert.ok(Math.abs(s.averageTps - 18.5) < 0.1, `avg=${s.averageTps}`);
  // 末尾窗口（1420~2420）有 18 个样本 -> 不沿用；本层未模拟渲染，EMA 以
  // 末尾原始值 18 为种子（渲染路径见集成测试 AC-04）
  assert.equal(s.lastInstantCarried, false);
  assert.ok(Math.abs(s.lastInstantTps - 18) < 0.01, `last=${s.lastInstantTps}`);
  assert.match(formatSummary(s), /^TTFT 420 ms｜最后 18\.0 tok\/s｜平均 18\.5 tok\/s$/);
});

test("AC-05（v3）：首增量后立即结束也能补算，且无 NaN / Infinity / 除零", () => {
  const r = run("m1", 0);
  addEligibleDelta(r, "thinking", 100);
  const s = computeSummary(r, 150);
  assert.equal(s.ttftMs, 100);
  assert.ok(Number.isFinite(s.lastInstantTps) && s.lastInstantTps > 0);
  // 单样本：有效流式时长 = 最小分母 1ms -> 平均 = 1000 tok/s
  assert.ok(Math.abs(s.averageTps - 1000) < 0.01, `avg=${s.averageTps}`);
  // 末尾窗口（[100,150]）含样本 -> 不沿用
  assert.equal(s.lastInstantCarried, false);
});

test("同一时间点多个增量：最小分母 1ms，不产生 Infinity", () => {
  const r = run();
  addEligibleDelta(r, "text", 100);
  addEligibleDelta(r, "text", 100);
  addEligibleDelta(r, "text", 100);
  const s = computeSummary(r, 100);
  assert.equal(s.ttftMs, 100);
  assert.ok(Number.isFinite(s.averageTps));
  assert.ok(s.averageTps > 0);
  assert.ok(Number.isFinite(s.lastInstantTps));
});

test("无增量 -> hasStreamingData=false（渲染层显示无流式速度数据）", () => {
  const r = run();
  assert.equal(computeSummary(r, 500).hasStreamingData, false);
});

test("v3：末尾窗口无输出 -> 最后沿用最近非零平滑值并以 ~ 标注", () => {
  const r = run("m1", 0);
  // 增量在 100..500ms，message_end 在 2000ms（末端 1.5s 无输出）
  for (const t of [100, 200, 300, 400, 500]) {
    addEligibleDelta(r, "text", t);
    updateEma(r, instantTps(r, t)); // 模拟渲染点的 EMA 更新
  }
  const s = computeSummary(r, 2000);
  // 平均按有效流式时长：5 / 0.4s = 12.5（末端间隙不拉低）
  assert.equal(s.averageTps, 12.5);
  // 末尾窗口（1000~2000）无样本 -> 沿用最近非零平滑值并标注
  assert.equal(s.lastInstantCarried, true);
  assert.ok(s.lastInstantTps > 200 && s.lastInstantTps < 300, `last=${s.lastInstantTps}`);
  assert.match(formatSummary(s), /^TTFT 100 ms｜最后 ~2\d\d\.\d tok\/s｜平均 12\.5 tok\/s$/);
});

test("v3：流中段无输出间隙计入有效时长（仅扣除末端间隙）", () => {
  const r = run("m1", 0);
  for (const t of [100, 200]) addEligibleDelta(r, "text", t);
  for (const t of [1600, 1700]) addEligibleDelta(r, "text", t);
  const s = computeSummary(r, 1800);
  // 有效时长 = 1700 − 100 = 1600ms（中段 1.4s 间隙不扣除）
  assert.equal(s.averageTps, 4 / 1.6);
  // 末尾窗口（800~1800）有 2 个样本 -> 不沿用
  assert.equal(s.lastInstantCarried, false);
});

test("v4：热身期判定（首个增量后前 1s 内）与 `—` 状态格式", () => {
  const r = run("m1", 0);
  assert.equal(isWarmingUp(r, 100), false); // 尚无增量：非热身
  addEligibleDelta(r, "text", 100);
  assert.equal(isWarmingUp(r, 99), false); // 首增量之前：非热身
  assert.equal(isWarmingUp(r, 100), true); // 首增量瞬间：热身开始
  assert.equal(isWarmingUp(r, 1099), true); // 999ms：仍在热身
  assert.equal(isWarmingUp(r, 1100), false); // 满 1s：热身结束
  assert.equal(WARMUP_MS, 1000);
  assert.equal(formatWarmupStatus(420), "生成中：TTFT 420 ms｜速度 —");
});

test("v4：热身期未完成且末尾窗口无输出 -> 最后退回有效时长平均（恒非零）", () => {
  const r = run("m1", 0);
  // 增量 100..200ms，message_end 在 1500ms；全程未满 1s 热身期
  // （控制器在热身期不播种 EMA，故此处只 addEligibleDelta 不 updateEma）
  for (const t of [100, 200]) {
    addEligibleDelta(r, "text", t);
  }
  const s = computeSummary(r, 1500);
  assert.equal(s.lastInstantCarried, true);
  // 退回有效时长平均 = 2 / 0.1s = 20（而非 0）
  assert.ok(Math.abs(s.lastInstantTps - 20) < 1e-9, `last=${s.lastInstantTps}`);
  assert.match(formatSummary(s), /^TTFT 100 ms｜最后 ~20\.0 tok\/s｜平均 20\.0 tok\/s$/);
});

test("WINDOW_MS / THROTTLE_MS 常量符合设计（1000ms / 250ms）", () => {
  assert.equal(WINDOW_MS, 1000);
  assert.equal(THROTTLE_MS, 250);
});
