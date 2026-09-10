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
const KEY_LEFT = "\x1b[D";
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

test("buildWidgetRows adds a remaining-cost hint when a cost cap is set", () => {
  const base = liveSnapshot();
  const budget = {
    maxDispatchCalls: 12,
    maxMemberRuns: 40,
    maxCostUsd: 5,
    maxTotalTokens: null,
    spentCost: 0.42,
    spentTokens: 113,
    dispatchCalls: 1,
    memberRuns: 2,
  };
  base.progress!.budget = budget;
  const rows = buildWidgetRows(base, 65000);
  assert.match(rows[0].text, /剩 \$4\.58/);

  // No cap → no hint.
  const uncapped = liveSnapshot();
  uncapped.progress!.budget = { ...budget, maxCostUsd: null };
  assert.doesNotMatch(buildWidgetRows(uncapped, 65000)[0].text, /剩 \$/);

  // Cap already breached → no hint (the run aborts anyway).
  const breached = liveSnapshot();
  breached.progress!.budget = { ...budget, spentCost: 5.2 };
  assert.doesNotMatch(buildWidgetRows(breached, 65000)[0].text, /剩 \$/);
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

  // 未选中 + 编辑器非空（canActivate=false）时，所有裸编辑器键原样放行。
  assert.equal(handleWidgetKey(state, KEY_DOWN, 2, actors, false).type, "none");
  assert.equal(handleWidgetKey(state, KEY_LEFT, 2, actors, false).type, "none");
  assert.equal(handleWidgetKey(state, KEY_UP, 2, actors, false).type, "none");
  assert.equal(handleWidgetKey(state, KEY_ENTER, 2, actors, false).type, "none");
  assert.equal(handleWidgetKey(state, KEY_ESC, 2, actors, false).type, "none");
  assert.equal(handleWidgetKey(state, "x", 2, actors, false).type, "none");
  assert.equal(handleWidgetKey(state, "\x03", 2, actors, false).type, "none", "ctrl+c passes through");

  // No rows: nothing to select even when activation is allowed.
  assert.equal(handleWidgetKey(state, ACTIVATE_CSI, 0, [], true).type, "none");

  // Both encodings activate (consume) with the cursor kept where it was.
  const csi = handleWidgetKey(state, ACTIVATE_CSI, 2, actors, false);
  assert.ok(csi.type === "update" && csi.state.selected && csi.state.cursor === 0);
  const legacy = handleWidgetKey(state, ACTIVATE_LEGACY, 2, actors, false);
  assert.ok(legacy.type === "update" && legacy.state.selected);
  const altUp = handleWidgetKey(state, ACTIVATE_UP_CSI, 2, actors, false);
  assert.ok(altUp.type === "update" && altUp.state.selected);
});

test("key reducer 激活门控：空编辑器（canActivate=true）才允许 ↓/← 激活（对齐 fleet-status getEditorText）", () => {
  // 规格表 §4：激活键 down/left，且编辑器文本为空才激活（fleet-status.ts:606-607）。
  const actors = ["_leader", "frontend"];

  // 编辑器有文本（canActivate=false）：↓/← 不拦截，放行编辑器。
  assert.equal(handleWidgetKey(initialWidgetKeyState(), KEY_DOWN, 2, actors, false).type, "none");
  assert.equal(handleWidgetKey(initialWidgetKeyState(), KEY_LEFT, 2, actors, false).type, "none");

  // 编辑器为空（canActivate=true）：↓/← 进入选中。
  const down = handleWidgetKey(initialWidgetKeyState(), KEY_DOWN, 2, actors, true);
  assert.ok(down.type === "update" && down.state.selected && down.state.cursor === 0);
  const left = handleWidgetKey(initialWidgetKeyState(), KEY_LEFT, 2, actors, true);
  assert.ok(left.type === "update" && left.state.selected);

  // 无行时即便允许激活也不进入选中。
  assert.equal(handleWidgetKey(initialWidgetKeyState(), KEY_DOWN, 0, [], true).type, "none");
});

test("key reducer 激活门控：alt+↓/↑ 为不受门控的第二通道", () => {
  // 差异表 §3.3：alt 通道是 agent-team 特有语义（模态选中风格），无论编辑器
  // 是否有文本都可进入选中。
  const actors = ["_leader", "frontend"];
  for (const activate of [ACTIVATE_CSI, ACTIVATE_LEGACY, ACTIVATE_UP_CSI]) {
    for (const canActivate of [false, true]) {
      const r = handleWidgetKey(initialWidgetKeyState(), activate, 2, actors, canActivate);
      assert.ok(
        r.type === "update" && r.state.selected,
        `alt 通道（${JSON.stringify(activate)}）在 canActivate=${canActivate} 下应激活`,
      );
    }
  }
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

  // 底部钳位保留；到顶（cursor 0）再按 up 退出选中（fleet-status 同构，见下）。
  const bottom = handleWidgetKey({ selected: true, cursor: 3 }, KEY_DOWN, 4, actors);
  assert.ok(bottom.type === "update" && bottom.state.cursor === 3 && bottom.state.selected);
});

test("key reducer selected: cursor 0 再按 up/k 退出选中放行编辑器（fleet-status 同构）", () => {
  // fleet-status.ts:620-625：选中第 0 行再按 up → deactivate（退出选中，
  // 后续键到达编辑器）；退出时保持 cursor 供再次激活恢复。
  const actors = ["_leader", "frontend"];
  for (const key of [KEY_UP, "k"]) {
    const exited = handleWidgetKey({ selected: true, cursor: 0 }, key, 2, actors);
    assert.ok(exited.type === "update");
    assert.ok(exited.type === "update" && exited.state.selected === false && exited.state.cursor === 0);
  }
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
  let nowMs = 65000;
  const controller = new RunWidgetController(
    {
      load: liveSnapshot,
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 80,
      nowMs: () => nowMs,
      tickMs: 5,
    },
    (lines) => {
      pushed.push(lines);
    },
  );
  try {
    controller.start();
    // 无变化跳过语义下，同 nowMs 的 tick 不再重绘；推进 elapsed 跨秒后 tick
    // 读到新渲染串 → 正常重建（证明 tick 循环仍在跑）。
    nowMs = 67000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(pushed.length >= 2, `tick 应读到推进的 elapsed 并重绘，实得 ${pushed.length}`);

    controller.setPaused(true);
    const afterPause = pushed.length;
    assert.deepEqual(pushed[pushed.length - 1], undefined, "暂停帧为 undefined");
    nowMs = 69000; // 暂停期间 elapsed 再推进也不得 setWidget
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pushed.length, afterPause, "暂停后 tick 不再 setWidget");
  } finally {
    controller.stop();
  }
});

// ---------------------------------------------------------------------------
// Slice 4：editorState 门控 + j/k 导航（seam D：经 fake 端口的真实 controller）
// ---------------------------------------------------------------------------

function controllerHarness(opts: {
  load: () => RunStatusSnapshot;
  editorState?: () => { text: string };
}) {
  const pushed: Array<string[] | undefined> = [];
  const handlers: Array<(data: string) => { consume?: boolean } | undefined> = [];
  const controller = new RunWidgetController(
    {
      load: opts.load,
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 80,
      nowMs: () => 65000,
      tickMs: 60 * 60 * 1000, // 长 tick：本用例只验证键盘事件路径
      editorState: opts.editorState,
    },
    (lines) => {
      pushed.push(lines);
    },
    (handler) => {
      handlers.push(handler);
      return () => {};
    },
  );
  controller.start();
  return { controller, pushed, handlers };
}

const lastLines = (pushed: Array<string[] | undefined>): string[] => pushed[pushed.length - 1] ?? [];
const cursorRow = (lines: string[]): number => lines.findIndex((line) => line.startsWith("▸ "));

// 编辑器为空：bare ↓ 进入选中并 consume（对齐 fleet-status getEditorText===""）。
test("controller 空编辑器按 ↓ 激活 widget（consume 且出现行光标）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
  });
  try {
    assert.equal(handlers.length, 1, "attachInput 应收到一个 handler");
    const r = handlers[0]!("\x1b[B");
    assert.equal(r?.consume, true, "空编辑器 ↓ 应被 widget 消费");
    assert.equal(cursorRow(lastLines(pushed)), 0, "激活后行光标应在第 0 行");
  } finally {
    controller.stop();
  }
});

// 编辑器有文本：bare ↓/← 放行编辑器（不消费），widget 不劫持输入。
test("controller 编辑器有文本时 ↓/← 不消费（放行编辑器）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "abc" }),
  });
  try {
    assert.equal(handlers[0]!("\x1b[B"), undefined, "有文本时 ↓ 不消费");
    assert.equal(handlers[0]!("\x1b[D"), undefined, "有文本时 ← 不消费");
    assert.equal(cursorRow(lastLines(pushed)), -1, "未进入选中，无行光标");
  } finally {
    controller.stop();
  }
});

// 编辑器有文本：alt+↓/↑ 第二通道仍激活（差异表 §3.3）。
test("controller 编辑器有文本时 alt+↓/↑ 仍激活（第二通道不受门控）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "abc" }),
  });
  try {
    const r = handlers[0]!("\x1b[1;3B");
    assert.equal(r?.consume, true, "有文本时 alt+↓ 仍应激活");
    assert.equal(cursorRow(lastLines(pushed)), 0);
  } finally {
    controller.stop();
  }
});

// 选中态 j/k 移动行光标（对齐 fleet selectDown/selectUp 的 down/j、up/k）。
test("controller 选中态 k/j 移动行光标（▸ 前缀位置随之变化）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: liveSnapshot,
    editorState: () => ({ text: "" }),
  });
  try {
    handlers[0]!("\x1b[B"); // 激活（cursor 0）
    assert.equal(cursorRow(lastLines(pushed)), 0);

    handlers[0]!("j"); // 下移
    assert.equal(cursorRow(lastLines(pushed)), 1, "j 应下移到第 1 行");
    handlers[0]!("k"); // 上移
    assert.equal(cursorRow(lastLines(pushed)), 0, "k 应回到第 0 行");
    handlers[0]!("k"); // 顶部再按 k：退出选中放行编辑器（fleet-status 同构）
    assert.equal(cursorRow(lastLines(pushed)), -1, "到顶再按 k 应退出选中（无行光标）");
    assert.equal(handlers[0]!("j"), undefined, "退出选中后 j 放行编辑器");
    handlers[0]!("\x1b[1;3B"); // alt+↓ 重新激活（cursor 保持）
    assert.equal(cursorRow(lastLines(pushed)), 0, "再次激活回到原光标");
    handlers[0]!("j");
    handlers[0]!("j"); // 底部再按 j：钳位不越界（仍选中）
    assert.equal(cursorRow(lastLines(pushed)), 1);
  } finally {
    controller.stop();
  }
});

// 宿主无 editorState 端口：降级为仅 alt 通道激活（bare ↓ 不消费）。
test("controller 宿主无 editorState 端口 → 降级：仅 alt 通道激活", () => {
  const { controller, handlers } = controllerHarness({ load: liveSnapshot });
  try {
    assert.equal(handlers[0]!("\x1b[B"), undefined, "降级时 bare ↓ 不消费");
    assert.equal(handlers[0]!("\x1b[1;3B")?.consume, true, "降级时 alt+↓ 仍激活");
  } finally {
    controller.stop();
  }
});

// ---------------------------------------------------------------------------
// Slice 5：无变化跳过 setWidget（seam D，对齐 fleet-status renderKey 语义）
// ---------------------------------------------------------------------------

function skipHarness(opts: { load: () => RunStatusSnapshot; nowMs?: () => number }) {
  const pushed: Array<string[] | undefined> = [];
  const controller = new RunWidgetController(
    {
      load: opts.load,
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 80,
      nowMs: opts.nowMs ?? (() => 0),
      tickMs: 60 * 60 * 1000, // 长 tick：只验证显式 refresh 的跳过语义
    },
    (lines) => {
      pushed.push(lines);
    },
  );
  controller.start();
  return { controller, pushed };
}

// 终态快照渲染串静止：连续 refresh 只应 setWidget 一次（第二次起跳过）。
test("controller 终态静态行连续 refresh → setWidget 只调一次（无变化跳过）", () => {
  const { controller, pushed } = skipHarness({ load: doneSnapshot, nowMs: () => 0 });
  try {
    const afterStart = pushed.length;
    assert.ok(afterStart >= 1, "start 后应至少刷出一帧");
    controller.refresh();
    controller.refresh();
    assert.equal(pushed.length, afterStart, "静态终态行连续 refresh 应跳过 setWidget");
  } finally {
    controller.stop();
  }
});

// running 快照固定 nowMs（elapsed 不变）：连续 refresh 跳过；elapsed 变化则重建。
test("controller running 快照：elapsed 不变跳过、变化重建", () => {
  let nowMs = 65000;
  const { controller, pushed } = skipHarness({ load: liveSnapshot, nowMs: () => nowMs });
  try {
    const afterStart = pushed.length;
    controller.refresh();
    assert.equal(pushed.length, afterStart, "elapsed 未变（同 nowMs）应跳过");

    nowMs = 66000; // elapsed 1m5s → 1m6s
    controller.refresh();
    assert.equal(pushed.length, afterStart + 1, "elapsed 变化应重建一帧");

    controller.refresh();
    assert.equal(pushed.length, afterStart + 1, "同 elapsed 再次 refresh 应跳过");
  } finally {
    controller.stop();
  }
});

// 选中态 toggle 必须触发重绘（跳过逻辑不得压制选中态变化）。
test("controller 选中态 toggle 触发重绘（不被跳过逻辑压制）", () => {
  const { controller, pushed, handlers } = controllerHarness({
    load: doneSnapshot,
    editorState: () => ({ text: "" }),
  });
  try {
    const before = pushed.length;
    handlers[0]!("\x1b[B"); // 进入选中：渲染串出现 ▸ + 提示行 → 必须重绘
    assert.equal(pushed.length, before + 1, "进入选中应触发一次重绘");
    assert.equal(cursorRow(lastLines(pushed)), 0, "选中后行光标在第 0 行");

    handlers[0]!("\x1b"); // esc 退出选中：渲染串回到无 ▸ → 必须重绘
    assert.equal(pushed.length, before + 2, "退出选中应再触发一次重绘");
    assert.equal(cursorRow(lastLines(pushed)), -1, "退出后无行光标");
  } finally {
    controller.stop();
  }
});
