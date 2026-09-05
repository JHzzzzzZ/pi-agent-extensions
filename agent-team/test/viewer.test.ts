/**
 * Transcript viewer tests: CJK-aware wrapping, entry/body/frame rendering,
 * scroll clamping, the pure key reducer, and the plain-text tool formatter.
 * The pi-tui host component itself is never instantiated (repo convention).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIEWER_BODY_HEIGHT,
  VIEWER_FRAME_HEIGHT,
  bodyLines,
  charWidth,
  clampViewerState,
  entryLines,
  formatTranscriptText,
  handleViewerKey,
  initialViewerState,
  renderViewerFrame,
  wrapText,
  type ViewerData,
  type ViewerState,
} from "../viewer.ts";
import type { TranscriptEntry } from "../transcript.ts";

const dim = (text: string): string => text;

function entry(kind: TranscriptEntry["kind"], text: string, ts = "2026-09-06T12:34:56.000Z"): TranscriptEntry {
  return { kind, text, ts };
}

function viewerData(overrides: Partial<ViewerData> = {}): ViewerData {
  return {
    team: "dev-team",
    runId: "run-42",
    runStatus: "running",
    elapsed: "5s",
    actors: [
      { actor: "_leader", label: "leader", status: "running" },
      { actor: "frontend", label: "frontend", status: "done" },
    ],
    entries: new Map<string, TranscriptEntry[]>([
      [
        "_leader",
        [
          entry("task", "修复登录 bug"),
          entry("assistant", "让我先拆解任务"),
          entry("tool", "▶ team_dispatch {\"tasks\":[{\"agent\":\"frontend\"}]}"),
          entry("assistant", "FINAL REPORT"),
        ],
      ],
      ["frontend", [entry("task", "写登录页"), entry("assistant", "登录页完成")]],
    ]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

test("charWidth counts CJK ideographs and fullwidth forms as 2 columns", () => {
  assert.equal(charWidth("a"), 1);
  assert.equal(charWidth("中"), 2);
  assert.equal(charWidth("Ａ"), 2, "fullwidth latin");
  assert.equal(charWidth("한"), 2, "hangul");
});

test("wrapText splits by display width, not by character count", () => {
  assert.deepEqual(wrapText("abcdefgh", 4), ["abcd", "efgh"]);
  assert.deepEqual(wrapText("中文中文", 4), ["中文", "中文"], "two wide chars fill a 4-column line");
  assert.deepEqual(wrapText("a中b文", 4), ["a中b", "文"], "greedy fill uses display width");
  assert.deepEqual(wrapText("a\nb", 10), ["a", "b"], "newlines force breaks");
  assert.deepEqual(wrapText("中文", 0), ["中文"], "degenerate width still renders");
});

// ---------------------------------------------------------------------------
// Entry + body rendering
// ---------------------------------------------------------------------------

test("entryLines renders assistant entries with a timestamped rule and wraps the text", () => {
  const lines = entryLines(entry("assistant", "第一行\n第二行"), 40);
  assert.match(lines[0], /─ 12:34:56 ─+/);
  assert.equal(lines[1], "第一行");
  assert.equal(lines[2], "第二行");
});

test("entryLines prefixes non-speech kinds", () => {
  assert.match(entryLines(entry("task", "做事情"), 40).join(""), /◆ 任务: 做事情/);
  assert.match(entryLines(entry("error", "CHILD_FAILED"), 40).join(""), /✗ CHILD_FAILED/);
  assert.match(entryLines(entry("system", "done"), 40).join(""), /ℹ done/);
  assert.doesNotMatch(entryLines(entry("tool", "▶ read"), 40).join(""), /◆|✗|ℹ/);
});

test("bodyLines hides tool rows when showTools is false and dims non-speech rows", () => {
  const entries = [entry("assistant", "hello"), entry("tool", "▶ read x")];
  assert.equal(bodyLines(entries, false, 40, dim).length, 2, "assistant renders rule + text, tools hidden");
  assert.equal(bodyLines(entries, true, 40, dim).length, 3);
  const dimmed = bodyLines([entry("tool", "▶ read x")], true, 40, (t) => `<d>${t}</d>`);
  assert.match(dimmed[0], /^<d>.*read x.*<\/d>$/, "tool rows render dimmed");
});

// ---------------------------------------------------------------------------
// Frame rendering + clamping
// ---------------------------------------------------------------------------

test("renderViewerFrame returns a fixed-height frame with header, tabs, body and footer", () => {
  const frame = renderViewerFrame(viewerData(), initialViewerState(), 80, { dim });
  assert.equal(frame.length, VIEWER_FRAME_HEIGHT);
  assert.match(frame[0], /agent-team · team dev-team · running · 5s · run-42/);
  assert.match(frame[1], /▸\[1\] leader ▶/);
  assert.match(frame[1], /\[2\] frontend ✓/);
  const body = frame.slice(3, 3 + VIEWER_BODY_HEIGHT).join("\n");
  assert.match(body, /◆ 任务: 修复登录 bug/);
  assert.match(body, /FINAL REPORT/);
  assert.match(frame[frame.length - 1], /↑↓滚动/);
  assert.match(frame[frame.length - 1], /成员 1\/2/);
});

test("renderViewerFrame follows the tail by default and honours scroll when unfollowed", () => {
  const many = Array.from({ length: 50 }, (_, i) => entry("assistant", `line ${i}`));
  const data = viewerData({ entries: new Map([["_leader", many]]) });
  const following = renderViewerFrame(data, initialViewerState(), 40, { dim, bodyHeight: 10 });
  const followBody = following.slice(3, 13).join("\n");
  assert.match(followBody, /line 49/, "follow shows the newest line");
  assert.doesNotMatch(followBody, /line 0\b/);

  const state = clampViewerState({ ...initialViewerState(), follow: false }, 100, 10);
  assert.equal(state.scroll, 0);
  const top = renderViewerFrame(data, state, 40, { dim, bodyHeight: 10 });
  assert.match(top.slice(3, 13).join("\n"), /line 0\b/);
  assert.doesNotMatch(top.slice(3, 13).join("\n"), /line 49/);
});

test("renderViewerFrame hides tool rows when toggled off and shows a hint without actors", () => {
  const data = viewerData();
  const frame = renderViewerFrame(data, { ...initialViewerState(), showTools: false }, 60, { dim });
  assert.doesNotMatch(frame.join("\n"), /team_dispatch/);

  const empty = renderViewerFrame(viewerData({ actors: [], entries: new Map() }), initialViewerState(), 60, { dim });
  assert.match(empty.join("\n"), /当前没有可查看的 run 记录/);
});

test("clampViewerState bounds scroll and follow pins to the bottom", () => {
  assert.equal(clampViewerState({ ...initialViewerState(), follow: true }, 100, 20).scroll, 80);
  assert.equal(clampViewerState({ ...initialViewerState(), follow: false, scroll: 999 }, 100, 20).scroll, 80);
  assert.equal(clampViewerState({ ...initialViewerState(), follow: false, scroll: -5 }, 100, 20).scroll, 0);
  assert.equal(clampViewerState(initialViewerState(), 5, 20).scroll, 0, "short transcript");
});

// ---------------------------------------------------------------------------
// Key reducer
// ---------------------------------------------------------------------------

function keyCtx(totalLines: number, actorCount = 2, bodyHeight = 10) {
  return { totalLines, actorCount, bodyHeight };
}

test("handleViewerKey closes on q and Escape", () => {
  assert.equal(handleViewerKey(initialViewerState(), "q", keyCtx(10)).type, "close");
  assert.equal(handleViewerKey(initialViewerState(), "\x1b", keyCtx(10)).type, "close");
});

test("handleViewerKey scrolls, unfollows on up, and re-follows at the bottom", () => {
  const up = handleViewerKey(initialViewerState(), "\x1b[A", keyCtx(50, 2, 10));
  assert.ok(up.type === "update");
  assert.equal(up.state.follow, false);
  assert.equal(up.state.scroll, 39, "unfollow starts from the bottom minus one");

  const down = handleViewerKey({ ...initialViewerState(), follow: false, scroll: 0 }, "\x1b[B", keyCtx(50, 2, 10));
  assert.ok(down.type === "update");
  assert.equal(down.state.scroll, 1);
  assert.equal(down.state.follow, false);

  const toBottom = handleViewerKey({ ...initialViewerState(), follow: false, scroll: 39 }, "\x1b[B", keyCtx(50, 2, 10));
  assert.ok(toBottom.type === "update");
  assert.equal(toBottom.state.follow, true, "reaching the bottom re-enables follow");

  assert.equal(handleViewerKey(initialViewerState(), "G", keyCtx(50)).type === "update" && true, true);
  const pageUp = handleViewerKey(initialViewerState(), "\x1b[5~", keyCtx(50, 2, 10));
  assert.ok(pageUp.type === "update");
  assert.equal(pageUp.state.scroll, 30, "page up from the bottom");
  const home = handleViewerKey(initialViewerState(), "g", keyCtx(50));
  assert.ok(home.type === "update");
  assert.equal(home.state.follow, false);
  assert.equal(home.state.scroll, 0);
});

test("handleViewerKey switches actors with arrows, hjl, tab and number jumps", () => {
  const right = handleViewerKey(initialViewerState(), "\x1b[C", keyCtx(10));
  assert.ok(right.type === "update");
  assert.equal(right.state.actorIndex, 1);
  assert.equal(right.state.follow, true, "actor switch resets to follow");

  const leftFromZero = handleViewerKey(initialViewerState(), "\x1b[D", keyCtx(10));
  assert.ok(leftFromZero.type === "update");
  assert.equal(leftFromZero.state.actorIndex, 0, "clamped at the first actor");

  const jump = handleViewerKey(initialViewerState(), "2", keyCtx(10));
  assert.ok(jump.type === "update");
  assert.equal(jump.state.actorIndex, 1);

  const outOfRange = handleViewerKey(initialViewerState(), "9", keyCtx(10, 2, 10));
  assert.ok(outOfRange.type === "update");
  assert.equal(outOfRange.state.actorIndex, 0, "out-of-range jumps are ignored");

  const tab = handleViewerKey(initialViewerState(), "\t", keyCtx(10));
  assert.ok(tab.type === "update");
  assert.equal(tab.state.actorIndex, 1);
});

test("handleViewerKey toggles tool rows and ignores unknown keys", () => {
  const toggled = handleViewerKey(initialViewerState(), "x", keyCtx(10));
  assert.ok(toggled.type === "update");
  assert.equal(toggled.state.showTools, false);
  const again = handleViewerKey(toggled.state as ViewerState, "x", keyCtx(10));
  assert.ok(again.type === "update");
  assert.equal(again.state.showTools, true);

  const ignored = handleViewerKey(initialViewerState(), "Z", keyCtx(10));
  assert.ok(ignored.type === "update");
  assert.deepEqual(ignored.state, initialViewerState());
});

// ---------------------------------------------------------------------------
// Plain-text formatter (team_transcript tool)
// ---------------------------------------------------------------------------

test("formatTranscriptText renders one actor's transcript or a helpful miss message", () => {
  const text = formatTranscriptText(viewerData(), "frontend", { dim });
  assert.match(text, /## frontend（done）· run run-42/);
  assert.match(text, /◆ 任务: 写登录页/);
  assert.match(text, /登录页完成/);

  const missing = formatTranscriptText(viewerData(), "ghost", { dim });
  assert.match(missing, /没有 "ghost" 的会话记录/);
});
