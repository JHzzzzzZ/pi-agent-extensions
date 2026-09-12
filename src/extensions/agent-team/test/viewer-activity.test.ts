/**
 * viewer 活动行纯逻辑测试（v1.17.0）：
 * - `formatActorActivity` 全分支 + 5s 分桶边界（4999→0s / 5000→5s / 60s 分秒进位）；
 * - `activityFromTranscript` 回放推导（末条 tool → 工具+首 token；assistant/task → 思考中；ts → age）；
 * - 指纹：activity 文本变化 ⇒ 变化、同桶时钟推进 ⇒ 不变、原始 phase/toolName/at 变化 ⇒ 变化；
 * - detail 头第 5 行 `活动:`（renderViewerFrame 真实帧路径，含 bodyHeight-1 封顶）。
 * 期望值抄自任务书/`docs/tui-sync.md` §4，不从实现反推。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIEWER_CHROME_ROWS,
  activityFromTranscript,
  formatActorActivity,
  initialViewerState,
  plainStyles,
  renderViewerFrame,
  viewerDataFingerprint,
  type ViewerData,
} from "../viewer.ts";
import type { TranscriptEntry } from "../transcript.ts";

const styles = plainStyles();

function entry(kind: TranscriptEntry["kind"], text: string, ts = "2026-09-06T12:34:56.000Z"): TranscriptEntry {
  return { kind, text, ts };
}

// 帧行两栏拆分：按中间分隔边框切（与 viewer.test.ts 同构）。
function paneColumns(line: string): { roster: string; detail: string } {
  const mid = line.indexOf("│", 1);
  return { roster: line.slice(1, mid).trimEnd(), detail: line.slice(mid + 1, line.length - 1).trimEnd() };
}

function viewerData(overrides: Partial<ViewerData> = {}): ViewerData {
  return {
    team: "dev-team",
    runId: "run-42",
    runStatus: "running",
    elapsed: "5s",
    actors: [{ actor: "_leader", label: "leader", status: "running" }],
    entries: new Map<string, TranscriptEntry[]>([["_leader", [entry("task", "修复登录 bug")]]]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatActorActivity
// ---------------------------------------------------------------------------

test("formatActorActivity：终态 run 恒 `run 已结束`（任何 status/phase 不带时长）", () => {
  const cases = [
    { status: "running", phase: "tool" as const, toolName: "read", lastActivityAtMs: 0 },
    { status: "queued" },
    { status: "done", phase: "tool" as const },
    { status: "failed" },
    { status: "aborted" },
  ];
  for (const actor of cases) {
    assert.equal(formatActorActivity(actor, false, 10_000), "run 已结束", JSON.stringify(actor));
  }
});

test("formatActorActivity：运行中成员终态 status → 已完成/失败/已中止/排队中（不带时长）", () => {
  const stale = { phase: "tool" as const, toolName: "read", lastActivityAtMs: 0 };
  assert.equal(formatActorActivity({ status: "queued", ...stale }, true, 10_000), "排队中");
  assert.equal(formatActorActivity({ status: "done", ...stale }, true, 10_000), "已完成");
  assert.equal(formatActorActivity({ status: "completed", ...stale }, true, 10_000), "已完成");
  assert.equal(formatActorActivity({ status: "failed", ...stale }, true, 10_000), "失败");
  assert.equal(formatActorActivity({ status: "aborted", ...stale }, true, 10_000), "已中止");
});

test("formatActorActivity：phase tool → `工具调用 <tool> · 距上次输出 <age>`；无 toolName 不带名", () => {
  assert.equal(
    formatActorActivity({ status: "running", phase: "tool", toolName: "read", lastActivityAtMs: 0 }, true, 7_000),
    "工具调用 read · 距上次输出 5s",
  );
  assert.equal(
    formatActorActivity({ status: "running", phase: "tool", lastActivityAtMs: 0 }, true, 7_000),
    "工具调用 · 距上次输出 5s",
  );
});

test("formatActorActivity：waiting/缺 phase → `思考中`；缺 lastActivityAtMs 不带时长段", () => {
  assert.equal(
    formatActorActivity({ status: "running", phase: "waiting", lastActivityAtMs: 1_000 }, true, 6_000),
    "思考中 · 距上次输出 5s",
  );
  assert.equal(formatActorActivity({ status: "running" }, true, 6_000), "思考中");
  assert.equal(
    formatActorActivity({ status: "running", phase: "tool", toolName: "read" }, true, 6_000),
    "工具调用 read",
  );
  assert.equal(formatActorActivity({}, true, 6_000), "思考中", "无 status 也按思考中");
});

test("formatActorActivity：5 秒分桶边界 4999→0s、5000→5s；60s 起分秒进位，负 age 钳 0", () => {
  const actor = { status: "running", phase: "waiting" as const, lastActivityAtMs: 100_000 };
  assert.equal(formatActorActivity(actor, true, 100_000), "思考中 · 距上次输出 0s");
  assert.equal(formatActorActivity(actor, true, 104_999), "思考中 · 距上次输出 0s", "4999ms 仍 0s 桶");
  assert.equal(formatActorActivity(actor, true, 105_000), "思考中 · 距上次输出 5s", "5000ms 进位 5s 桶");
  assert.equal(formatActorActivity(actor, true, 159_999), "思考中 · 距上次输出 55s");
  assert.equal(formatActorActivity(actor, true, 160_000), "思考中 · 距上次输出 1m0s", "60s 起分秒");
  assert.equal(formatActorActivity(actor, true, 225_000), "思考中 · 距上次输出 2m5s", "125s → 2m5s");
  assert.equal(formatActorActivity(actor, true, 99_000), "思考中 · 距上次输出 0s", "负 age 钳到 0");
});

// ---------------------------------------------------------------------------
// activityFromTranscript（回放/无 live progress 推导）
// ---------------------------------------------------------------------------

test("activityFromTranscript：末条 tool → phase tool + 文本首 token；ts → lastActivityAtMs", () => {
  const derived = activityFromTranscript([
    entry("task", "数数"),
    entry("tool", 'team_dispatch {"tasks":[{"agent":"front"}]}', "2026-09-06T12:34:58.000Z"),
  ]);
  assert.equal(derived.phase, "tool");
  assert.equal(derived.toolName, "team_dispatch");
  assert.equal(derived.lastActivityAtMs, Date.parse("2026-09-06T12:34:58.000Z"));

  const noName = activityFromTranscript([entry("tool", "→ 某结果")]);
  assert.equal(noName.phase, "tool");
  assert.equal(noName.toolName, undefined, "首 token 取不到（{/→ 起始）则不带名");
});

test("activityFromTranscript：末条 assistant/task/其它 → 思考中；空列表/坏 ts 降级", () => {
  const assistant = activityFromTranscript([entry("assistant", "回复", "2026-09-06T12:35:00.000Z")]);
  assert.equal(assistant.phase, "waiting");
  assert.equal(assistant.toolName, undefined);
  assert.equal(assistant.lastActivityAtMs, Date.parse("2026-09-06T12:35:00.000Z"));

  assert.equal(activityFromTranscript([entry("task", "任务")]).phase, "waiting");
  assert.equal(activityFromTranscript([entry("error", "炸了")]).phase, "waiting");
  assert.equal(activityFromTranscript([entry("system", "done")]).phase, "waiting");
  assert.deepEqual(activityFromTranscript([]), {});
  const badTs = activityFromTranscript([entry("assistant", "x", "not-a-date")]);
  assert.equal(badTs.phase, "waiting");
  assert.equal(badTs.lastActivityAtMs, undefined);
});

// ---------------------------------------------------------------------------
// fingerprint（重影约束：分桶文本进指纹）
// ---------------------------------------------------------------------------

test("指纹包含 activity 文本：变化 ⇒ 变化；仅 elapsed 空转 ⇒ 不变", () => {
  const base = viewerData({
    actors: [{ actor: "_leader", label: "leader", status: "running", activity: "思考中 · 距上次输出 0s" }],
  });
  assert.equal(viewerDataFingerprint(base), viewerDataFingerprint({ ...base, elapsed: "9s" }), "elapsed 不进指纹");
  assert.notEqual(
    viewerDataFingerprint(base),
    viewerDataFingerprint({
      ...base,
      actors: [{ actor: "_leader", label: "leader", status: "running", activity: "思考中 · 距上次输出 5s" }],
    }),
    "activity 变化必须触发重绘",
  );
});

test("指纹包含 phase/toolName/lastActivityAtMs（活动原始字段变化 ⇒ 指纹变化）", () => {
  const base = viewerData({
    actors: [{ actor: "_leader", label: "leader", status: "running", phase: "waiting", lastActivityAtMs: 1000 }],
  });
  const toolPhase = viewerData({
    actors: [{ actor: "_leader", label: "leader", status: "running", phase: "tool", toolName: "read", lastActivityAtMs: 1000 }],
  });
  assert.notEqual(viewerDataFingerprint(base), viewerDataFingerprint(toolPhase), "phase/toolName 变化");
  const later = viewerData({
    actors: [{ actor: "_leader", label: "leader", status: "running", phase: "waiting", lastActivityAtMs: 6000 }],
  });
  assert.notEqual(viewerDataFingerprint(base), viewerDataFingerprint(later), "lastActivityAtMs 变化");
});

test("同 5s 桶内的时钟推进不改变活动文本（=> 同数据指纹，时钟重绘 ≤ 每桶一次）", () => {
  const actor = { status: "running", phase: "waiting" as const, lastActivityAtMs: 1_000 };
  assert.equal(
    formatActorActivity(actor, true, 2_000),
    formatActorActivity(actor, true, 5_999),
    "同一桶内文本恒定",
  );
  assert.notEqual(formatActorActivity(actor, true, 5_999), formatActorActivity(actor, true, 6_000));
});

// ---------------------------------------------------------------------------
// detail 头第 5 行 `活动:`（真实帧路径）
// ---------------------------------------------------------------------------

test("renderViewerFrame：detail 头第 5 行 `活动:` 用烘焙文本；帧总行数不变", () => {
  const bodyHeight = 10;
  const data = viewerData({
    actors: [
      {
        actor: "_leader",
        label: "leader",
        status: "running",
        activity: "工具调用 read · 距上次输出 10s",
        phase: "tool",
        toolName: "read",
        lastActivityAtMs: 1_000,
      },
    ],
  });
  const frame = renderViewerFrame(data, initialViewerState(), 80, { styles, bodyHeight });
  assert.equal(frame.length, bodyHeight + VIEWER_CHROME_ROWS, "帧总行数不变");
  assert.match(paneColumns(frame[7]).detail, /^活动: 工具调用 read · 距上次输出 10s/, "活动行在模型行之下");
  assert.match(paneColumns(frame[6]).detail, /^模型:（默认）|^模型: （默认）/);
  assert.match(frame.slice(8).join("\n"), /修复登录 bug/, "正文从第 6 个头部行之后开始");
});

test("renderViewerFrame：无 activity 的 running actor 回退 `思考中`；终态 run 回退 `run 已结束`", () => {
  const frame = renderViewerFrame(viewerData(), initialViewerState(), 80, { styles, bodyHeight: 10 });
  assert.match(paneColumns(frame[7]).detail, /^活动: 思考中$/);

  const finished = viewerData({ runStatus: "completed" });
  const frame2 = renderViewerFrame(finished, initialViewerState(), 80, { styles, bodyHeight: 10 });
  assert.match(paneColumns(frame2[7]).detail, /^活动: run 已结束$/);
});

test("renderViewerFrame：bodyHeight-1 封顶时活动行让位给正文（头 5 行不越界）", () => {
  const frame = renderViewerFrame(viewerData(), initialViewerState(), 80, { styles, bodyHeight: 5 });
  assert.equal(frame.length, 5 + VIEWER_CHROME_ROWS);
  assert.match(paneColumns(frame[3]).detail, /^Run:/);
  assert.match(paneColumns(frame[4]).detail, /^State:/);
  assert.match(paneColumns(frame[5]).detail, /^成员:/);
  assert.match(paneColumns(frame[6]).detail, /^模型:/);
  assert.ok(!frame.join("\n").includes("活动:"), "头部封顶在 bodyHeight-1（5 行头里只显示前 4 行）");
});
