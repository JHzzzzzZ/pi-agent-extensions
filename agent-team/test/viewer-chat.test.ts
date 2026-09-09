/**
 * agent-team — viewer 输入模式（`m` 发消息）纯 reducer 与渲染
 *
 * 输入模式是 viewer 内的又一个纯状态机（与 stop-confirm/stopping/notice
 * 同构）：分支在 handleViewerKey 最前面，优先于一切现有按键——输入模式中
 * j/k/D/r/q 等都进 buffer，Esc/ctrl+c 只退出输入（不关 viewer），Enter 返回
 * chat-submit 携带文本。渲染走 actionLines 同一区域（busy > confirm >
 * input > notice 互斥），帧总高恒定。
 *
 * 宿主 onMessage 接线（派单/排队/notice 映射）由 viewer-chat-host.test.ts
 * 覆盖；这里只锁纯行为。viewer-host 风格的帧高回归也在此（纯渲染，无需
 * 真实终端）。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIEWER_CHROME_ROWS,
  VIEWER_LEGEND,
  actionLines,
  handleViewerKey,
  initialViewerState,
  plainStyles,
  renderViewerFrame,
  TranscriptViewer,
  type ViewerData,
  type ViewerKeyContext,
  type ViewerState,
} from "../viewer.ts";
import type { TranscriptEntry } from "../transcript.ts";

const styles = plainStyles();

function keyCtx(overrides: Partial<ViewerKeyContext> = {}): ViewerKeyContext {
  return { totalLines: 10, actorCount: 2, bodyHeight: 8, actorIds: ["_leader", "frontend"], runRunning: true, runStatus: "running", ...overrides };
}

function dataFixture(): ViewerData {
  const entries = new Map<string, TranscriptEntry[]>([
    ["_leader", [{ kind: "assistant", text: "leader 说", ts: "2026-09-10T12:00:00Z" }]],
    ["frontend", [{ kind: "assistant", text: "frontend 说", ts: "2026-09-10T12:00:01Z" }]],
  ]);
  return {
    team: "dev-team",
    runId: "run-1",
    runStatus: "running",
    actors: [
      { actor: "_leader", label: "leader", status: "running" },
      { actor: "frontend", label: "frontend", status: "queued" },
    ],
    entries,
  };
}

// ---------------------------------------------------------------------------
// 进入/退出输入模式
// ---------------------------------------------------------------------------

test("m：进入输入模式，清空 buffer，不触发其他行为", () => {
  const state = { ...initialViewerState(), notice: { text: "x", kind: "success" as const } };
  const result = handleViewerKey(state, "m", keyCtx());
  assert.equal(result.type, "update");
  if (result.type !== "update") return;
  assert.equal(result.state.inputMode, true);
  assert.equal(result.state.inputBuffer, "");
  assert.equal(result.state.showTools, state.showTools, "不误触其他开关");
});

test("输入模式：可打印字符追加 buffer（含 CJK）", () => {
  let state: ViewerState = { ...initialViewerState(), inputMode: true, inputBuffer: "" };
  for (const ch of "你好abc 1") {
    const result = handleViewerKey(state, ch, keyCtx());
    assert.equal(result.type, "update");
    if (result.type !== "update") return;
    state = result.state;
  }
  assert.equal(state.inputBuffer, "你好abc 1");
  assert.equal(state.inputMode, true);
});

test("输入模式：j/k/D/r/q/x/1 全部进 buffer，不触发导航/停止/刷新/关闭", () => {
  let state: ViewerState = { ...initialViewerState(), inputMode: true, inputBuffer: "" };
  for (const key of ["j", "k", "D", "r", "q", "x", "1"]) {
    const result = handleViewerKey(state, key, keyCtx());
    assert.equal(result.type, "update", `${key} 不应触发特殊行为`);
    if (result.type !== "update") return;
    state = result.state;
  }
  assert.equal(state.inputBuffer, "jkDrqx1");
});

test("输入模式：Esc 退出输入且不关闭 viewer，buffer 清空", () => {
  const state = { ...initialViewerState(), inputMode: true, inputBuffer: "草稿" };
  const result = handleViewerKey(state, "\x1b", keyCtx());
  assert.equal(result.type, "update");
  if (result.type !== "update") return;
  assert.equal(result.state.inputMode, false);
  assert.equal(result.state.inputBuffer, "");
});

test("输入模式：ctrl+c 也只退出输入，不关闭 viewer", () => {
  const state = { ...initialViewerState(), inputMode: true, inputBuffer: "a" };
  const result = handleViewerKey(state, "\x03", keyCtx());
  assert.equal(result.type, "update");
});

test("输入模式：Enter 返回 chat-submit 并携带全文", () => {
  const state = { ...initialViewerState(), inputMode: true, inputBuffer: "跑一下测试" };
  const result = handleViewerKey(state, "\r", keyCtx());
  assert.equal(result.type, "chat-submit");
  if (result.type !== "chat-submit") return;
  assert.equal(result.text, "跑一下测试");
  assert.equal(result.state.inputMode, false);
  assert.equal(result.state.inputBuffer, "");
});

test("输入模式：Backspace 删除最后一个码点（CJK 安全）", () => {
  const state = { ...initialViewerState(), inputMode: true, inputBuffer: "你好a" };
  const result = handleViewerKey(state, "\x7f", keyCtx());
  assert.equal(result.type, "update");
  if (result.type !== "update") return;
  assert.equal(result.state.inputBuffer, "你好");
  // 再删一次：删掉整个"好"（单码点，不会删半个字符）
  const second = handleViewerKey(result.state, "\x7f", keyCtx());
  if (second.type !== "update") return assert.fail("expected update");
  assert.equal(second.state.inputBuffer, "你");
});

test("输入模式：方向键/翻页等控制序列被忽略（不进 buffer）", () => {
  const state = { ...initialViewerState(), inputMode: true, inputBuffer: "已 有" };
  for (const seq of ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[H", "\t"]) {
    const result = handleViewerKey(state, seq, keyCtx());
    assert.equal(result.type, "update");
    if (result.type !== "update") return;
    assert.equal(result.state.inputBuffer, "已 有", `${JSON.stringify(seq)} 不应进入 buffer`);
    assert.equal(result.state.inputMode, true);
  }
});

test("输入模式：空 buffer Enter 也返回 chat-submit（空文本，宿主决定拒绝）", () => {
  const state = { ...initialViewerState(), inputMode: true, inputBuffer: "" };
  const result = handleViewerKey(state, "\r", keyCtx());
  assert.equal(result.type, "chat-submit");
});

test("非输入模式：m 之外的现有行为不受影响（q 关闭、D 停止确认）", () => {
  assert.equal(handleViewerKey(initialViewerState(), "q", keyCtx()).type, "close");
  assert.equal(handleViewerKey(initialViewerState(), "D", keyCtx()).type, "update");
  const confirmed = handleViewerKey(initialViewerState(), "D", keyCtx());
  if (confirmed.type !== "update") return assert.fail("expected update");
  assert.equal(confirmed.state.stopConfirming, true);
});

test("停止确认态优先于 m（确认态中 m 不进入输入模式）", () => {
  const state = { ...initialViewerState(), stopConfirming: true };
  const result = handleViewerKey(state, "m", keyCtx());
  assert.equal(result.type, "update");
  if (result.type !== "update") return;
  assert.equal(result.state.inputMode, undefined);
  assert.equal(result.state.stopConfirming, true, "确认态忽略 m");
});

// ---------------------------------------------------------------------------
// 渲染：actionLines 输入行 + 帧总高恒定
// ---------------------------------------------------------------------------

test("actionLines：输入模式渲染 ❯ buffer▏，优先级 busy > confirm > input > notice", () => {
  const data = dataFixture();
  const inputState = { ...initialViewerState(), inputMode: true, inputBuffer: "你好" };
  assert.equal(actionLines(data, inputState, styles)[0], "❯ 你好▏");

  const busy = { ...inputState, stopping: true };
  assert.match(actionLines(data, busy, styles)[0] ?? "", /停止中/);

  const confirming = { ...inputState, stopConfirming: true };
  assert.match(actionLines(data, confirming, styles)[0] ?? "", /确认停止/);

  const notice = { ...initialViewerState(), notice: { text: "提示", kind: "success" as const } };
  assert.equal(actionLines(data, notice, styles).length, 1);
  assert.equal(actionLines(data, initialViewerState(), styles).length, 0);
});

test("actionLines：输入行按显示宽度截断（CJK 记 2 列）", () => {
  const data = dataFixture();
  const state = { ...initialViewerState(), inputMode: true, inputBuffer: "啊".repeat(50) };
  const lines = actionLines(data, state, styles, 20);
  assert.equal(lines.length, 1);
  // 截断后不超过宽度（不含样式）；行以省略号结尾。
  const plain = lines[0] ?? "";
  assert.ok(plain.length <= 22, `截断后应 ≤ 宽度附近，实际 ${plain.length}`);
  assert.ok(plain.includes("…"));
});

test("输入行出现/消失不改变帧总高（VIEWER_CHROME_ROWS 约束）", () => {
  const data = dataFixture();
  const bodyHeight = 20;
  const base = renderViewerFrame(data, initialViewerState(), 80, { styles, bodyHeight }).length;
  const withInput = renderViewerFrame(
    data,
    { ...initialViewerState(), inputMode: true, inputBuffer: "消息" },
    80,
    { styles, bodyHeight },
  ).length;
  const withConfirm = renderViewerFrame(data, { ...initialViewerState(), stopConfirming: true }, 80, {
    styles,
    bodyHeight,
  }).length;
  assert.equal(base, bodyHeight + VIEWER_CHROME_ROWS);
  assert.equal(withInput, base, "输入行占正文窗口，不增高帧");
  assert.equal(withConfirm, base, "确认横幅同理");
});

test("VIEWER_LEGEND 追加 m 发消息", () => {
  assert.match(VIEWER_LEGEND, /m 发消息/);
  assert.match(VIEWER_LEGEND, /D 停止/);
  assert.match(VIEWER_LEGEND, /r 刷新/);
  assert.match(VIEWER_LEGEND, /q 关闭/);
});

// ---------------------------------------------------------------------------
// TranscriptViewer 接线：chat-submit → onMessage → notice
// ---------------------------------------------------------------------------

function makeViewer(opts: { onMessage?: (target: { actor: string; label: string }, message: string) => { text: string; kind: "success" | "warning" | "error" } }): TranscriptViewer {
  return new TranscriptViewer({
    load: dataFixture,
    done: () => {},
    styles,
    refreshMs: 60_000,
    ...(opts.onMessage ? { onMessage: opts.onMessage } : {}),
  });
}

test("viewer 提交：onMessage 收到选中 actor 与文本，notice 上屏并退出输入模式", () => {
  const viewer = makeViewer({
    onMessage: (target, message) => {
      assert.deepEqual(target, { actor: "_leader", label: "leader" });
      assert.equal(message, "直接消息");
      return { text: "已发送给 leader", kind: "success" };
    },
  });
  viewer.handleInput("m");
  viewer.handleInput("直");
  viewer.handleInput("接");
  viewer.handleInput("消");
  viewer.handleInput("息");
  viewer.handleInput("\r");
  const frame = viewer.render(100).join("\n");
  assert.match(frame, /已发送给 leader/);
  assert.doesNotMatch(frame, /❯/, "输入行已撤");
  viewer.dispose();
});

test("viewer 提交：无 onMessage → error notice，不抛异常", () => {
  const viewer = makeViewer({});
  viewer.handleInput("m");
  viewer.handleInput("a");
  viewer.handleInput("\r");
  const frame = viewer.render(100).join("\n");
  assert.match(frame, /发消息不可用/);
  viewer.dispose();
});

test("viewer 提交：onMessage 抛异常 → error notice，不上抛", () => {
  const viewer = makeViewer({
    onMessage: () => {
      throw new Error("boom");
    },
  });
  viewer.handleInput("m");
  viewer.handleInput("\r");
  const frame = viewer.render(100).join("\n");
  assert.match(frame, /发送失败/);
  viewer.dispose();
});
