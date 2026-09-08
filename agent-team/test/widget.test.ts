/**
 * Below-editor run widget tests: row building (live/terminal/empty), the
 * modal key reducer (activate/move/confirm/escape/passthrough), and the
 * legacy alt-arrow encoding. Pure functions only — the pi-tui host
 * component itself is never instantiated (repo convention).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { buildWidgetRows, handleWidgetKey, initialWidgetKeyState } from "../widget.ts";
import type { RunStatusSnapshot } from "../cockpit.ts";

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

test("buildWidgetRows live: renderWidgetLines format with leader/member actor mapping", () => {
  const rows = buildWidgetRows(liveSnapshot(), 65000);
  assert.match(rows[0].text, /agent-team dev-team ▶ running · 1m5s/);
  assert.match(rows[1].text, /任务: 修复登录 bug/);
  assert.match(rows[2].text, /leader: m1 · turn 2/);
  assert.match(rows[3].text, /↳ 正在审查成员结果/);
  assert.match(rows[4].text, /▶ frontend running — turn 1 — 正在编辑 login\.tsx/);
  assert.match(rows[5].text, /✓ backend done/);
  assert.deepEqual(
    rows.map((row) => row.actor),
    ["_leader", "_leader", "_leader", "_leader", "frontend", "backend"],
  );
});

test("buildWidgetRows terminal: status, duration, cost from the last record", () => {
  const rows = buildWidgetRows(doneSnapshot(), 0);
  assert.match(rows[0].text, /agent-team dev-team ✓ completed · 12s · \$0\.0500/);
  assert.match(rows[1].text, /任务: 修复 bug/);
  assert.match(rows[2].text, /✓ frontend done — m — \$0\.0100/);
  assert.equal(rows[2].actor, "frontend");
});

test("buildWidgetRows terminal failed record surfaces the error row", () => {
  const snapshot = doneSnapshot();
  snapshot.lastRecord = { ...snapshot.lastRecord!, status: "failed", error: "模型超时，任务中断" };
  const rows = buildWidgetRows(snapshot, 0);
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
