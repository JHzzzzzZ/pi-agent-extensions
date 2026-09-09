/**
 * Below-editor run widget tests: row building (live/terminal/empty), the
 * modal key reducer (activate/move/confirm/escape/passthrough), and the
 * legacy alt-arrow encoding. Pure functions only — the pi-tui host
 * component itself is never instantiated (repo convention).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { RunWidgetController, buildWidgetRows, handleWidgetKey, initialWidgetKeyState, renderWidgetView } from "../widget.ts";
import type { RunStatusSnapshot } from "../cockpit.ts";
import { plainStyles, visibleWidth } from "../viewer.ts";

const ACTIVATE_CSI = "\x1b[1;3B"; // alt+down, modified-arrow CSI encoding
const ACTIVATE_LEGACY = "\x1b\x1b[B"; // alt+down, legacy xterm ESC-prefix encoding
const ACTIVATE_UP_CSI = "\x1b[1;3A"; // alt+up
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESC = "\x1b";

function liveSnapshot(): RunStatusSnapshot {
  return {
    running: true,
    progress: {
      runId: "r",
      team: "dev-team",
      task: "修复登录 bug",
      startedAtMs: 0,
      leaderModel: "m1",
      leaderNote: "turn 2",
      leaderActivity: "正在审查成员结果",
      members: [
        { name: "frontend", status: "running", note: "turn 1", latest: "正在编辑 login.tsx" },
        { name: "backend", status: "done" },
      ],
    },
    lastRecord: null,
  };
}

function doneSnapshot(): RunStatusSnapshot {
  return {
    running: false,
    progress: null,
    lastRecord: {
      runId: "run-1",
      team: "dev-team",
      task: "修复 bug",
      startedAt: "2026-09-05T12:00:00Z",
      status: "completed",
      report: "done",
      members: [
        { name: "frontend", model: "m", status: "done", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 } },
      ],
      totalCost: 0.05,
      totalTokens: 100,
      durationMs: 12000,
    },
  };
}

test("buildWidgetRows live: compact header (status/elapsed/parallel count) + task, all leader rows", () => {
  const rows = buildWidgetRows(liveSnapshot(), 65000);
  assert.equal(rows.length, 2, "compact: header + task only, no member detail");
  assert.match(rows[0].text, /agent-team dev-team ▶ running · 1m5s · 1\/2 并行/);
  assert.match(rows[1].text, /任务: 修复登录 bug/);
  assert.deepEqual(
    rows.map((row) => row.actor),
    ["_leader", "_leader"],
  );
});

test("buildWidgetRows terminal: status, duration, cost from the last record", () => {
  const rows = buildWidgetRows(doneSnapshot(), 0);
  assert.equal(rows.length, 2);
  assert.match(rows[0].text, /agent-team dev-team ✓ completed · 12s · \$0\.0500/);
  assert.match(rows[1].text, /任务: 修复 bug/);
  assert.deepEqual(rows.map((row) => row.actor), ["_leader", "_leader"]);
});

test("buildWidgetRows terminal failed record keeps one bounded error row", () => {
  const snapshot = doneSnapshot();
  snapshot.lastRecord = { ...snapshot.lastRecord!, status: "failed", error: "模型超时，任务中断" };
  const rows = buildWidgetRows(snapshot, 0);
  assert.equal(rows.length, 3);
  assert.match(rows[0].text, /agent-team dev-team ✗ failed · 12s/);
  assert.match(rows[2].text, /✗ 模型超时，任务中断/);
  assert.equal(rows[2].actor, "_leader");
});

test("buildWidgetRows empty: no data renders no rows", () => {
  assert.deepEqual(buildWidgetRows({ running: false, progress: null, lastRecord: null }, 0), []);
});

test("key reducer: activation consumes alt+down/up in both encodings; bare keys pass through", () => {
  const state = initialWidgetKeyState();
  const actors = ["_leader", "frontend"];

  // Before activation every bare editor key is untouched.
  assert.equal(handleWidgetKey(state, KEY_DOWN, 2, actors).type, "none");
  assert.equal(handleWidgetKey(state, KEY_UP, 2, actors).type, "none");
  assert.equal(handleWidgetKey(state, KEY_ENTER, 2, actors).type, "none");
  assert.equal(handleWidgetKey(state, KEY_ESC, 2, actors).type, "none");
  assert.equal(handleWidgetKey(state, "x", 2, actors).type, "none");
  assert.equal(handleWidgetKey(state, "\x03", 2, actors).type, "none", "ctrl+c passes through");

  // No rows: nothing to select.
  assert.equal(handleWidgetKey(state, ACTIVATE_CSI, 0, []).type, "none");

  // Both encodings activate (consume) with the cursor kept where it was.
  const csi = handleWidgetKey(state, ACTIVATE_CSI, 2, actors);
  assert.ok(csi.type === "update" && csi.state.selected && csi.state.cursor === 0);
  const legacy = handleWidgetKey(state, ACTIVATE_LEGACY, 2, actors);
  assert.ok(legacy.type === "update" && legacy.state.selected);
  const altUp = handleWidgetKey(state, ACTIVATE_UP_CSI, 2, actors);
  assert.ok(altUp.type === "update" && altUp.state.selected);
});

test("key reducer selected: arrows move and clamp, enter confirms the row's actor", () => {
  const actors = ["_leader", "_leader", "frontend", "backend"];
  let state = { selected: true, cursor: 0 };

  const moved = handleWidgetKey(state, KEY_DOWN, 4, actors);
  assert.ok(moved.type === "update" && moved.state.cursor === 1 && moved.state.selected);
  state = moved.type === "update" ? moved.state : state;

  state = { selected: true, cursor: 2 };
  const confirm = handleWidgetKey(state, KEY_ENTER, 4, actors);
  assert.ok(confirm.type === "confirm");
  assert.ok(confirm.type === "confirm" && confirm.actor === "frontend");
  assert.ok(confirm.state.selected === false, "confirm leaves selection mode");

  // Clamp at both ends.
  const top = handleWidgetKey({ selected: true, cursor: 0 }, KEY_UP, 4, actors);
  assert.ok(top.type === "update" && top.state.cursor === 0);
  const bottom = handleWidgetKey({ selected: true, cursor: 3 }, KEY_DOWN, 4, actors);
  assert.ok(bottom.type === "update" && bottom.state.cursor === 3);
});

test("key reducer selected: esc deselects, other keys deselect and pass through", () => {
  const actors = ["_leader", "frontend"];
  const selected = { selected: true, cursor: 1 };

  const esc = handleWidgetKey(selected, KEY_ESC, 2, actors);
  assert.ok(esc.type === "update" && esc.state.selected === false && esc.state.cursor === 1);

  const other = handleWidgetKey(selected, "x", 2, actors);
  assert.ok(other.type === "passthrough" && other.state.selected === false);

  const ctrlC = handleWidgetKey(selected, "\x03", 2, actors);
  assert.ok(ctrlC.type === "passthrough" && ctrlC.state.selected === false);
});

test("key reducer: re-activation keeps the previous cursor position", () => {
  const actors = ["_leader", "frontend", "backend"];
  const deselected = handleWidgetKey({ selected: true, cursor: 2 }, KEY_ESC, 3, actors);
  assert.ok(deselected.type === "update");
  const state = deselected.type === "update" ? deselected.state : initialWidgetKeyState();
  const reactivated = handleWidgetKey(state, ACTIVATE_CSI, 3, actors);
  assert.ok(reactivated.type === "update" && reactivated.state.selected && reactivated.state.cursor === 2);
});

test("renderWidgetView truncates every line to terminal width (CJK-heavy rows)", () => {
  // Regression: the host TUI crashes when a component line renders wider
  // than the terminal; rows are bounded by char count only, so CJK-heavy
  // text (44-char task = up to 88 columns) must be width-fitted here.
  const snapshot = liveSnapshot();
  snapshot.progress!.task = "实现一个摄影教学网页产出完整的页面结构与文案与样式与脚本内容超长截断示例";
  const rows = buildWidgetRows(snapshot, 65000);
  const styles = plainStyles();

  for (const width of [270, 120, 40, 20]) {
    for (const selected of [false, true]) {
      const lines = renderWidgetView(rows, { selected, cursor: 1 }, width, styles);
      assert.ok(lines.length > 0);
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `selected=${selected} width=${width}: line renders ${visibleWidth(line)} > ${width}`,
        );
      }
    }
  }

  // Selection gutter counts toward the budget, cursor marker still visible.
  const selected = renderWidgetView(rows, { selected: true, cursor: 1 }, 270, styles);
  assert.match(selected[1], /^▸ /);
  assert.match(selected[selected.length - 1], /↑↓ 选择/);
});

test("controller setPaused(true) 隐藏亮块并冻结重绘，恢复后立即刷出最新行", () => {
  const pushed: Array<string[] | undefined> = [];
  const controller = new RunWidgetController(
    {
      load: liveSnapshot,
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 80,
      nowMs: () => 65000,
      tickMs: 60 * 60 * 1000, // 长 tick：本用例只验证暂停/恢复的同步语义
    },
    (lines) => {
      pushed.push(lines);
    },
  );
  try {
    controller.start();
    assert.ok(pushed.length >= 1, "start 后立即刷出一帧");
    assert.ok((pushed[pushed.length - 1]?.length ?? 0) > 0, "运行中有亮块行");

    controller.setPaused(true);
    assert.deepEqual(pushed[pushed.length - 1], undefined, "暂停时推 undefined 隐藏亮块");

    const frozen = pushed.length;
    controller.refresh();
    assert.equal(pushed.length, frozen, "暂停期间 refresh 不再 setWidget");

    controller.setPaused(false);
    assert.ok(pushed.length > frozen, "恢复后立即刷出一帧");
    assert.ok((pushed[pushed.length - 1]?.length ?? 0) > 0, "恢复后亮块行回来");
    assert.match(pushed[pushed.length - 1]![0], /agent-team dev-team ▶ running/);
  } finally {
    controller.stop();
  }
});

test("controller 暂停后 tick 不再 setWidget", async () => {
  const pushed: Array<string[] | undefined> = [];
  const controller = new RunWidgetController(
    {
      load: liveSnapshot,
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 80,
      nowMs: () => 65000,
      tickMs: 5,
    },
    (lines) => {
      pushed.push(lines);
    },
  );
  try {
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(pushed.length >= 2, `tick 应持续重绘，实得 ${pushed.length}`);

    controller.setPaused(true);
    const afterPause = pushed.length;
    assert.deepEqual(pushed[pushed.length - 1], undefined, "暂停帧为 undefined");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pushed.length, afterPause, "暂停后 tick 不再 setWidget");
  } finally {
    controller.stop();
  }
});
