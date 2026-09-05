/**
 * Transcript viewer tests: CJK/ANSI-aware width helpers, block grouping
 * (continuous chat flow), the bordered full-page frame, dynamic height,
 * the pure key reducer, and the plain-text tool formatter. The pi-tui host
 * component itself is never instantiated (repo convention).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIEWER_CHROME_ROWS,
  bodyLines,
  buildBlocks,
  blockLines,
  charWidth,
  clampViewerState,
  computeFrameHeight,
  formatTranscriptText,
  handleViewerKey,
  initialViewerState,
  padLine,
  plainStyles,
  renderViewerFrame,
  truncateVisible,
  visibleWidth,
  wrapText,
  type Styles,
  type ViewerData,
  type ViewerState,
} from "../viewer.ts";
import type { TranscriptEntry } from "../transcript.ts";

const styles: Styles = plainStyles();

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
          entry("tool", 'team_dispatch {"tasks":[{"agent":"frontend"}]}'),
          entry("tool", "team_dispatch → report"),
          entry("assistant", "FINAL REPORT"),
        ],
      ],
      ["frontend", [entry("task", "写登录页"), entry("assistant", "登录页完成")]],
    ]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Width helpers
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

test("visibleWidth/padLine are ANSI-aware and pad to display width", () => {
  const styled = "\x1b[2mread\x1b[0m";
  assert.equal(visibleWidth(styled), 4, "escapes do not count");
  assert.equal(visibleWidth("中文"), 4);
  const padded = padLine(styled, 10);
  assert.equal(visibleWidth(padded), 10);
  assert.equal(padLine("中文x", 4), "中文x", "no negative padding");
});

test("truncateVisible cuts plain text by display width with an ellipsis", () => {
  assert.equal(truncateVisible("abcdef", 4), "abc…");
  assert.equal(truncateVisible("中文中文", 5), "中文…");
  assert.equal(truncateVisible("abc", 10), "abc");
  assert.equal(truncateVisible("abc", 0), "");
});

// ---------------------------------------------------------------------------
// Block grouping: continuous chat flow
// ---------------------------------------------------------------------------

test("buildBlocks merges consecutive tool rows and keeps each message separate", () => {
  const blocks = buildBlocks(
    [
      entry("task", "修复登录 bug"),
      entry("tool", "read src/login.tsx"),
      entry("tool", "read → file body"),
      entry("assistant", "第一条回复"),
      entry("tool", "edit login.tsx"),
      entry("assistant", "第二条回复"),
    ],
    true,
  );
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["task", "tools", "assistant", "tools", "assistant"],
  );
  const firstTools = blocks[1];
  assert.ok(firstTools.kind === "tools");
  assert.deepEqual(firstTools.lines, ["read src/login.tsx", "read → file body"]);
});

test("buildBlocks hides tool rows when toggled off and strips legacy icon prefixes", () => {
  const hidden = buildBlocks([entry("task", "t"), entry("tool", "▶ read x")], false);
  assert.deepEqual(hidden.map((b) => b.kind), ["task"]);
  const legacy = buildBlocks([entry("tool", "  ✓ read → ok")], true);
  assert.ok(legacy[0].kind === "tools");
  assert.deepEqual(legacy[0].lines, ["read → ok"]);
});

test("blockLines renders task as a full-width bubble, assistant with a dim label, tools dim", () => {
  const task = blockLines({ kind: "task", text: "修复登录 bug" }, 40, styles);
  assert.match(task[0], /^❯ 修复登录 bug\s+$/, "padded to full width for the bubble");
  assert.equal(visibleWidth(task[0]), 40);

  const md: string[] = [];
  const assistant = blockLines({ kind: "assistant", text: "正文内容", ts: "12:34:56" }, 40, styles, (text) => {
    md.push(text);
    return ["<md>正文内容</md>"];
  });
  assert.equal(md.length, 1, "markdown seam receives the raw text");
  assert.equal(assistant[0], "▸ assistant · 12:34:56");
  assert.deepEqual(assistant.slice(1), ["<md>正文内容</md>"]);

  const assistantPlain = blockLines({ kind: "assistant", text: "正文内容", ts: "" }, 40, styles);
  assert.equal(assistantPlain[0], "▸ assistant");
  assert.deepEqual(assistantPlain.slice(1), ["正文内容"], "plain wrap fallback");

  const tools = blockLines({ kind: "tools", lines: ["read src/login.tsx", "read → " + "x".repeat(100)] }, 40, styles);
  assert.equal(tools[0], "· read src/login.tsx");
  assert.ok(tools[1].length <= 42, "tool rows truncated to the frame width");

  const error = blockLines({ kind: "error", text: "CHILD_FAILED: boom", ts: "" }, 40, styles);
  assert.equal(error[0], "✗ CHILD_FAILED: boom");
  const system = blockLines({ kind: "system", text: "done · 5s", ts: "" }, 40, styles);
  assert.equal(system[0], "ℹ done · 5s");
});

test("bodyLines separates blocks with exactly one blank line", () => {
  const entries = [entry("task", "任务"), entry("assistant", "回复"), entry("tool", "read x")];
  const lines = bodyLines(entries, true, 40, styles);
  assert.deepEqual(lines, [padLine("❯ 任务", 40), "", "▸ assistant · 12:34:56", "回复", "", "· read x"]);
  const withoutTools = bodyLines(entries, false, 40, styles);
  assert.deepEqual(withoutTools, [padLine("❯ 任务", 40), "", "▸ assistant · 12:34:56", "回复"]);
});

// ---------------------------------------------------------------------------
// Bordered frame + dynamic height
// ---------------------------------------------------------------------------

test("computeFrameHeight scales to ~82% of the terminal with a 12-row floor", () => {
  assert.equal(computeFrameHeight(40), 32);
  assert.equal(computeFrameHeight(24), 19);
  assert.equal(computeFrameHeight(30), 24);
  assert.equal(computeFrameHeight(10), 12, "floor for tiny terminals");
  assert.equal(computeFrameHeight(0), 24, "unknown rows fallback");
});

test("renderViewerFrame returns a complete bordered box of the requested height", () => {
  const bodyHeight = 10;
  const frame = renderViewerFrame(viewerData(), initialViewerState(), 80, { styles, bodyHeight });
  assert.equal(frame.length, bodyHeight + VIEWER_CHROME_ROWS);
  assert.match(frame[0], /^╭─ agent-team · team dev-team · running · 5s · run-42 ─+╮$/);
  assert.match(frame[frame.length - 1], /^╰─ .*╯$/);
  assert.match(frame[frame.length - 1], /↑↓ 滚动/);
  assert.match(frame[frame.length - 1], /成员 1\/2/);
  for (const line of frame.slice(1, frame.length - 1)) {
    assert.match(line, /^│ /, "side border opens every inner row");
    assert.match(line, / │$/, "side border closes every inner row");
    assert.equal(visibleWidth(line), 80, "inner rows are padded to the full width");
  }
  assert.equal(visibleWidth(frame[0]), 80);
  assert.equal(visibleWidth(frame[frame.length - 1]), 80);
});

test("renderViewerFrame colors tabs with the style port and marks the current actor", () => {
  const styled: Styles = {
    ...styles,
    accent: (t) => `<a>${t}</a>`,
    success: (t) => `<s>${t}</s>`,
  };
  const frame = renderViewerFrame(viewerData(), initialViewerState(), 80, { styles: styled, bodyHeight: 8 });
  const tabs = frame[1];
  assert.match(tabs, /<a>▸1 leader <\/a>/, "current actor highlighted with accent");
  assert.match(tabs, /<s>✓<\/s>/, "done status icon in success style");
});

test("renderViewerFrame shows the continuous flow and honours scroll/follow", () => {
  const many = Array.from({ length: 50 }, (_, i) => entry("assistant", `line ${i}`));
  const data = viewerData({ entries: new Map([["_leader", many]]) });

  const following = renderViewerFrame(data, initialViewerState(), 60, { styles, bodyHeight: 10 });
  const followBody = following.slice(2, 12).join("\n");
  assert.match(followBody, /line 49/, "follow shows the newest line");
  assert.doesNotMatch(followBody, /line 0\b/);

  const state = clampViewerState({ ...initialViewerState(), follow: false }, 100, 10);
  assert.equal(state.scroll, 0);
  const top = renderViewerFrame(data, state, 60, { styles, bodyHeight: 10 });
  assert.match(top.slice(2, 12).join("\n"), /line 0\b/);
  assert.doesNotMatch(top.slice(2, 12).join("\n"), /line 49/);
});

test("renderViewerFrame hides tool rows when toggled off and shows a hint when empty", () => {
  const frame = renderViewerFrame(viewerData(), { ...initialViewerState(), showTools: false }, 60, { styles, bodyHeight: 10 });
  assert.doesNotMatch(frame.join("\n"), /team_dispatch/);

  const empty = renderViewerFrame(viewerData({ actors: [], entries: new Map() }), initialViewerState(), 60, { styles, bodyHeight: 10 });
  assert.match(empty.join("\n"), /暂无记录/);
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
  const text = formatTranscriptText(viewerData(), "frontend", { styles });
  assert.match(text, /## frontend（done）· run run-42/);
  assert.match(text, /❯ 写登录页/);
  assert.match(text, /登录页完成/);
  assert.match(text, /▸ assistant · 12:34:56/, "assistant label present in tool output");

  const missing = formatTranscriptText(viewerData(), "ghost", { styles });
  assert.match(missing, /没有 "ghost" 的会话记录/);
});
