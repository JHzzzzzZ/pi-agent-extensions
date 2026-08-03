/**
 * 集成测试：适配层 + 度量层 + 状态端口 全链路，
 * 逐条验证 JHL-10-PRD-v2 §8 的 AC-01 至 AC-09。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamAdapter } from "../adapter.ts";
import { TokenSpeedController } from "../controller.ts";
import { createStatusPort } from "../status-port.ts";
import {
  assistantMessage,
  messageEndEvent,
  messageStartEvent,
  messageUpdateEvent,
  messageUpdateUnknownEvent,
  toolResultMessage,
  userMessage,
  RecordingStatusPort,
} from "./fixtures.ts";

function makeHarness() {
  let t = 0;
  const ui = new RecordingStatusPort();
  const status = createStatusPort(ui, () => ui.uiAvailable);
  const controller = new TokenSpeedController(createStreamAdapter(() => t));
  return {
    controller,
    status,
    ui,
    at: (v: number) => {
      t = v;
    },
  };
}

/** 快速构造一串消息。 */
const msg = (id: string) => assistantMessage(id);

test("AC-01：正常路径实时计量（TTFT 420ms，1s 窗口 18 增量 -> 18.0 tok/s）", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  assert.equal(h.ui.last(), "生成中：TTFT 等待中｜速度 —");

  // 首个 thinking_delta 于 420ms；随后每 50ms 一个，共 17 个（420..1220）
  const times = [420, 470, 520, 570, 620, 670, 720, 770, 820, 870, 920, 970, 1020, 1070, 1120, 1170, 1220];
  for (const t of times) {
    h.at(t);
    h.controller.onMessageUpdate(messageUpdateEvent(m, "thinking_delta"), h.status);
  }

  // 420ms 到达时 TTFT 已确定，但处于 v4 热身期（前 1s）：速度保持 —
  assert.ok(h.ui.statuses().some((s) => s === "生成中：TTFT 420 ms｜速度 —"));
  // 热身期内其余刷新点不更新速度（无 1000.0 之类未满窗口放大值）

  // 第 18 个增量于 1420ms 到达：满 1s 热身结束，以首个完整窗口值播种 EMA
  // （窗口 [420,1420] 恰好 1s、18 个样本 -> 种子 = 18.0）
  h.at(1420);
  h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  assert.equal(h.ui.last(), "生成中：TTFT 420 ms｜速度 18.0 tok/s");
});

test("AC-02：边界路径未满窗口（500ms 内 5 增量 -> 全程热身期，速度保持 —）", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  // 增量落在 250ms 节流边界上：0/125/250/375/500，均在热身期（<1s）内
  for (const t of [0, 125, 250, 375, 500]) {
    h.at(t);
    h.controller.onMessageUpdate(messageUpdateEvent(m, "toolcall_delta"), h.status);
  }
  // 热身期：TTFT 确定但速度保持 —（不出现未满窗口的放大值）
  assert.equal(h.ui.last(), "生成中：TTFT 0 ms｜速度 —");
});

test("AC-03：未知事件与用户消息不影响计数与 TTFT", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  h.at(100);
  h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  // 未知增量、用户消息更新、tool result 更新均被忽略
  h.at(101);
  h.controller.onMessageUpdate(messageUpdateUnknownEvent(m, "text_start"), h.status);
  h.at(102);
  h.controller.onMessageUpdate(messageUpdateEvent(userMessage(), "text_delta"), h.status);
  h.at(103);
  h.controller.onMessageUpdate(messageUpdateEvent(toolResultMessage(), "text_delta"), h.status);
  h.at(104);
  h.controller.onMessageStart(messageStartEvent(userMessage()), h.status);
  h.at(105);
  h.controller.onMessageStart(messageStartEvent(toolResultMessage()), h.status);

  h.at(600);
  h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  // 只有 2 个有效增量，TTFT 仍是 100ms；600ms 仍在热身期（<1s）-> 速度保持 —
  assert.equal(h.ui.last(), "生成中：TTFT 100 ms｜速度 —");
});

test("AC-04：结束汇总（v4：EMA 种子=首个完整窗口 + 有效流式时长平均）", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  for (let i = 0; i < 36; i++) {
    h.at(420 + Math.round(i * (2000 / 36)));
    h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  }
  h.at(2420);
  h.controller.onMessageEnd(messageEndEvent(m), h.status);
  // 种子（1420ms 首个完整窗口）≈19；末尾原始 18 -> EMA ≈18.7；
  // 平均：36 / (2364−420)ms ≈ 18.5
  assert.equal(h.ui.last(), "TTFT 420 ms｜最后 18.7 tok/s｜平均 18.5 tok/s");
});

test("AC-05：首增量后立即结束 -> 补算汇总，无 NaN/Infinity/除零", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  h.at(100);
  h.controller.onMessageUpdate(messageUpdateEvent(m, "thinking_delta"), h.status);
  h.at(150);
  h.controller.onMessageEnd(messageEndEvent(m), h.status);
  // 短流（未满热身期）：末尾窗口含样本 -> EMA 以末尾原始值 20.0 播种；
  // 平均：单样本有效时长 1ms -> 1000.0
  assert.equal(h.ui.last(), "TTFT 100 ms｜最后 20.0 tok/s｜平均 1000.0 tok/s");
});

test("AC-06：产生增量后取消/报错 -> 按已收增量生成汇总且停止刷新", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  for (const t of [100, 200, 300, 400, 500]) {
    h.at(t);
    h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  }
  h.at(600);
  const aborted = assistantMessage("m1", "aborted");
  h.controller.onMessageEnd(messageEndEvent(aborted), h.status);
  // 短流（未满热身期）：末尾窗口含样本 -> EMA 以末尾原始值 10.0 播种；
  // 平均：5 / 0.4s = 12.5
  assert.equal(h.ui.last(), "TTFT 100 ms｜最后 10.0 tok/s｜平均 12.5 tok/s");
  // 结束后的 message_update 不再刷新
  h.at(700);
  h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  assert.equal(h.ui.last(), "TTFT 100 ms｜最后 10.0 tok/s｜平均 12.5 tok/s");
});

test("AC-07：tool result / 工具进度不影响计数与速度（10 个增量保持 10）", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  for (let i = 0; i < 10; i++) {
    h.at(100 + i * 50);
    h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  }
  // assistant 消息结束（进入工具执行）
  h.at(600);
  h.controller.onMessageEnd(messageEndEvent(m), h.status);
  const summaryBefore = h.ui.last();
  // 短流（未满热身期）：末尾窗口含样本 -> EMA 以末尾原始值 20.0 播种；
  // 平均：10 / (550−100)ms = 22.2
  assert.equal(summaryBefore, "TTFT 100 ms｜最后 20.0 tok/s｜平均 22.2 tok/s");

  // 工具执行：tool result 消息开始/结束、工具进度事件（未知类型）全部到达
  const callsBefore = h.ui.calls.length;
  h.at(1000);
  h.controller.onMessageStart(messageStartEvent(toolResultMessage()), h.status);
  h.at(1100);
  h.controller.onMessageUpdate(messageUpdateEvent(toolResultMessage(), "text_delta"), h.status);
  h.at(1200);
  h.controller.onMessageEnd(messageEndEvent(toolResultMessage()), h.status);
  h.at(1300);
  h.controller.onMessageUpdate(messageUpdateUnknownEvent(m, "tool_progress"), h.status);

  // 汇总不被改变，且这些事件零 UI 副作用（不增加任何 setStatus 调用）
  assert.equal(h.ui.last(), summaryBefore);
  assert.equal(h.ui.calls.length, callsBefore);
});

test("AC-08：新轮 message_start 立即替换上一轮，旧轮 tool result 不影响新轮", () => {
  const h = makeHarness();
  // 上一轮完成汇总
  const m1 = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m1), h.status);
  h.at(100);
  h.controller.onMessageUpdate(messageUpdateEvent(m1, "text_delta"), h.status);
  h.at(200);
  h.controller.onMessageEnd(messageEndEvent(m1), h.status);
  assert.ok(h.ui.last()!.startsWith("TTFT 100 ms"));

  // 新轮开始
  const m2 = msg("m2");
  h.at(1000);
  h.controller.onMessageStart(messageStartEvent(m2), h.status);
  assert.equal(h.ui.last(), "生成中：TTFT 等待中｜速度 —");
  // 上一轮的 tool result 随后到达：不得改变新轮
  h.at(1100);
  h.controller.onMessageStart(messageStartEvent(toolResultMessage()), h.status);
  h.at(1200);
  h.controller.onMessageEnd(messageEndEvent(toolResultMessage()), h.status);
  // 新轮样本只计自己的；1300/1600 均在热身期（首增量 1300 + 1s）内 -> 速度 —
  h.at(1300);
  h.controller.onMessageUpdate(messageUpdateEvent(m2, "text_delta"), h.status);
  h.at(1600);
  h.controller.onMessageUpdate(messageUpdateEvent(m2, "text_delta"), h.status);
  assert.equal(h.ui.last(), "生成中：TTFT 300 ms｜速度 —");
  h.at(1700);
  h.controller.onMessageEnd(messageEndEvent(m2), h.status);
  // 短流（未满热身期）：末尾窗口含样本 -> EMA 以末尾原始值 5.0 播种；
  // 平均：2 / 0.3s = 6.7
  assert.equal(h.ui.last(), "TTFT 300 ms｜最后 5.0 tok/s｜平均 6.7 tok/s");
});

test("AC-09：无流式增量 -> 无流式速度数据；非流式消息同样处理", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  h.at(50);
  h.controller.onMessageEnd(messageEndEvent(m), h.status);
  assert.equal(h.ui.last(), "无流式速度数据");
  // 非流式：message_start(final) 后立即 message_end
  h.at(100);
  h.controller.onMessageStart(messageStartEvent(msg("m2")), h.status);
  h.at(101);
  h.controller.onMessageEnd(messageEndEvent(msg("m2")), h.status);
  assert.equal(h.ui.last(), "无流式速度数据");
});

test("AC-09：TUI 不可用（print/json 模式）时静默降级，零渲染调用", () => {
  const h = makeHarness();
  h.ui.uiAvailable = false;
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  h.at(100);
  h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  h.at(200);
  h.controller.onMessageEnd(messageEndEvent(m), h.status);
  assert.equal(h.ui.calls.length, 0);
});

test("AC-09：setStatus 抛错被端口隔离，不中断度量与后续渲染", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  h.ui.throwOnSet = true;
  h.at(100);
  assert.doesNotThrow(() => h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status));
  h.at(200);
  assert.doesNotThrow(() => h.controller.onMessageEnd(messageEndEvent(m), h.status));
  h.ui.throwOnSet = false;
  // 新一轮仍可正常渲染
  h.at(300);
  h.controller.onMessageStart(messageStartEvent(msg("m2")), h.status);
  assert.equal(h.ui.last(), "生成中：TTFT 等待中｜速度 —");
});

test("状态键固定为 stream-token-speed（原位更新，不与其他扩展冲突）", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  h.at(100);
  h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  h.at(200);
  h.controller.onMessageEnd(messageEndEvent(m), h.status);
  assert.ok(h.ui.calls.length > 0);
  assert.ok(h.ui.calls.every((c) => c.key === "stream-token-speed"));
});

test("修复#2 回归：真实 provider 时序（start 无 responseId，update/end 有）完整计量", () => {
  // 与 pi v0.83.0 真实行为一致：message_start 的 partial 尚无 responseId，
  // responseId 在流开始后才可知，故 message_update / message_end 才携带。
  // 旧实现对“assistant-N 匿名 id vs 真实 responseId”的硬性不匹配会丢弃
  // 全部增量并卡死在“生成中：TTFT 等待中｜速度 —”。
  const h = makeHarness();
  const startMsg = assistantMessage(undefined); // message_start：无 responseId
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(startMsg), h.status);
  assert.equal(h.ui.last(), "生成中：TTFT 等待中｜速度 —");

  // 首个增量携带真实 responseId：必须被计入（TTFT 起点 100ms，热身期速度 —）
  const realIdMsg = assistantMessage("msg_real_001");
  h.at(100);
  h.controller.onMessageUpdate(messageUpdateEvent(realIdMsg, "thinking_delta"), h.status);
  assert.ok(h.ui.statuses().some((s) => s === "生成中：TTFT 100 ms｜速度 —"));

  // 后续增量（带真实 id）正常累计；600ms 仍在热身期（<1s）-> 速度保持 —
  h.at(200);
  h.controller.onMessageUpdate(messageUpdateEvent(realIdMsg, "text_delta"), h.status);
  h.at(600);
  h.controller.onMessageUpdate(messageUpdateEvent(realIdMsg, "text_delta"), h.status);
  assert.equal(h.ui.last(), "生成中：TTFT 100 ms｜速度 —");

  // message_end 携带真实 id：轮次正常收尾为汇总（旧实现会因不匹配而永不收尾）
  // 短流：EMA 以末尾原始值 5.0 播种；平均：3 / 0.5s = 6.0
  const endMsg = assistantMessage("msg_real_001", "stop");
  h.at(700);
  h.controller.onMessageEnd(messageEndEvent(endMsg), h.status);
  assert.equal(h.ui.last(), "TTFT 100 ms｜最后 5.0 tok/s｜平均 6.0 tok/s");
});

test("修复#2 回归：收编真实 responseId 后，跨轮事件仍被精确隔离", () => {
  const h = makeHarness();
  const startMsg = assistantMessage(undefined);
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(startMsg), h.status);
  h.at(100);
  const realIdMsg = assistantMessage("msg_a");
  h.controller.onMessageUpdate(messageUpdateEvent(realIdMsg, "text_delta"), h.status);

  // 完全不同的真实 id（跨轮/串流串扰）仍被丢弃
  const otherIdMsg = assistantMessage("msg_b");
  h.at(500);
  h.controller.onMessageUpdate(messageUpdateEvent(otherIdMsg, "text_delta"), h.status);
  h.at(600);
  h.controller.onMessageEnd(messageEndEvent(assistantMessage("msg_b", "stop")), h.status);
  // 状态仍为 msg_a 的生成中（msg_b 的增量被隔离；热身期显示 —）
  assert.equal(h.ui.last(), "生成中：TTFT 100 ms｜速度 —");

  // 本轮的 message_end（msg_a）正常收尾：单样本 -> EMA 播种 1.7；
  // 平均：单样本有效时长 1ms -> 1000.0
  h.at(700);
  h.controller.onMessageEnd(messageEndEvent(assistantMessage("msg_a", "stop")), h.status);
  assert.equal(h.ui.last(), "TTFT 100 ms｜最后 1.7 tok/s｜平均 1000.0 tok/s");
});

test("修复#1：style 样式函数作用于全部状态文本（theme.fg(\"dim\") 场景）", () => {
  const ui = new RecordingStatusPort();
  const styled: Array<string | undefined> = [];
  const status = createStatusPort(ui, () => ui.uiAvailable, (t) => {
    const out = `\u001b[2m${t}\u001b[22m`;
    styled.push(out);
    return out;
  });
  const controller = new TokenSpeedController(createStreamAdapter(() => 0));
  const m = msg("m1");
  controller.onMessageStart(messageStartEvent(m), status);
  controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), status);
  controller.onMessageEnd(messageEndEvent(m), status);

  assert.ok(styled.length >= 3, "每个状态都经 style 包装");
  assert.ok(styled.every((s) => s!.startsWith("\u001b[2m") && s!.endsWith("\u001b[22m")));
  // 未提供 style 时原样输出
  const plain = createStatusPort(ui, () => true);
  const controller2 = new TokenSpeedController(createStreamAdapter(() => 0));
  controller2.onMessageStart(messageStartEvent(msg("m2")), plain);
  assert.equal(ui.last(), "生成中：TTFT 等待中｜速度 —");
});

test("修复#1：style 抛错被端口隔离，不影响度量与后续渲染", () => {
  const ui = new RecordingStatusPort();
  const status = createStatusPort(ui, () => true, () => {
    throw new Error("theme.fg exploded");
  });
  const controller = new TokenSpeedController(createStreamAdapter(() => 0));
  const m = msg("m1");
  assert.doesNotThrow(() => controller.onMessageStart(messageStartEvent(m), status));
  assert.doesNotThrow(() => controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), status));
  assert.doesNotThrow(() => controller.onMessageEnd(messageEndEvent(m), status));
  assert.equal(ui.calls.length, 0);
});

test("v3：末端无输出（工具执行间隙）-> 最后沿用最近非零值并以 ~ 标注，平均按有效流式时长", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  // 增量 100..500ms 到达（全部在热身期内）；之后 1.5s 无任何增量
  for (const t of [100, 200, 300, 400, 500]) {
    h.at(t);
    h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  }
  h.at(2000);
  h.controller.onMessageEnd(messageEndEvent(m), h.status);
  // 平均：5 / 0.4s = 12.5（末端 1.5s 间隙不拉低平均速度）
  // 最后：末尾窗口无样本且热身期未完成（EMA 无种子）-> 退回有效时长平均并标注
  assert.match(h.ui.last()!, /^TTFT 100 ms｜最后 ~12\.5 tok\/s｜平均 12\.5 tok\/s$/);
  assert.ok(!h.ui.last()!.includes("0.0 tok/s"));
});

test("v4：热身期（前 1s 速度 —）-> 满 1s 以首个完整窗口值为 EMA 种子", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  // 每 100ms 一个增量：100..1000 全部在热身期内
  for (const t of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) {
    h.at(t);
    h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  }
  assert.equal(h.ui.last(), "生成中：TTFT 100 ms｜速度 —");
  // 1100ms：满 1s，首个完整窗口 [100,1100] = 11 个增量 -> 种子 11.0
  h.at(1100);
  h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  assert.equal(h.ui.last(), "生成中：TTFT 100 ms｜速度 11.0 tok/s");
  h.at(1200);
  h.controller.onMessageEnd(messageEndEvent(m), h.status);
  // 末尾窗口 [200,1200] = 10 个增量 -> EMA 0.3*10 + 0.7*11 = 10.7；
  // 平均：11 / 1.0s = 11.0
  assert.equal(h.ui.last(), "TTFT 100 ms｜最后 10.7 tok/s｜平均 11.0 tok/s");
});

test("v4：EMA 平滑抑制瞬时波动（热身期后原始速率变化时渲染值平滑收敛、无跳变）", () => {
  const h = makeHarness();
  const m = msg("m1");
  h.at(0);
  h.controller.onMessageStart(messageStartEvent(m), h.status);
  // 第 1 秒：100..1000 每 100ms 一个增量（10 个，热身期不显示速度）；
  // 第 2 秒起：每 400ms 一个增量（速率下降）——原始窗口值逐级下降
  for (const t of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1500, 1900, 2300, 2700]) {
    h.at(t);
    h.controller.onMessageUpdate(messageUpdateEvent(m, "text_delta"), h.status);
  }
  const statuses = h.ui.statuses();
  // [0]=waiting, [1]=热身期（速度保持 —），[2..]=正式计量
  assert.equal(statuses[0], "生成中：TTFT 等待中｜速度 —");
  assert.equal(statuses[1], "生成中：TTFT 100 ms｜速度 —");
  // 满 1s 后：首个完整窗口 [100,1100] = 11 个增量 -> 种子 11.0（无 1000 级放大值）
  assert.equal(statuses[2], "生成中：TTFT 100 ms｜速度 11.0 tok/s");
  // EMA 平滑序列：11.0 -> 10.1 -> 8.6 -> 6.9 -> 5.7（原始值 11/8/5/3/3 被阻尼）
  const emaSeq = statuses.slice(2).map((s) => Number(/速度 ([\d.]+) tok\/s/.exec(s)?.[1]));
  assert.deepEqual(emaSeq, [11.0, 10.1, 8.6, 6.9, 5.7]);
  assert.ok(emaSeq.every((v) => v > 0));
});
