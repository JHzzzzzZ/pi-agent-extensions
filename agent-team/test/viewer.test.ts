/**
 * Transcript viewer tests: CJK/ANSI-aware width helpers, block grouping
 * (continuous chat flow), the fleet-inspector-style roster+detail split
 * frame (left member roster, right meta header + scrollable transcript),
 * dynamic height, the pure key reducer, and the plain-text tool formatter.
 * The pi-tui host component itself is never instantiated (repo convention).
 * 帧几何期望值一律抄自 docs/tui-sync.md §4（fleet v0.66.0 字面量）。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIEWER_CHROME_ROWS,
  actionLines,
  bodyLines,
  buildBlocks,
  blockLines,
  charWidth,
  clampViewerState,
  computeFrameHeight,
  computeViewerLayout,
  fitLine,
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
import type { Theme } from "@earendil-works/pi-coding-agent";
import { themeStyles } from "../viewer.ts";

const styles: Styles = plainStyles();

test("themeStyles 背景端口：bubble/rowBg → userMessageBg、rowSelectedBg → selectedBg；缺失/抛错 → 无背景降级", () => {
  const calls: string[] = [];
  const styles = themeStyles({
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    bg: (color: string, text: string) => {
      calls.push(color);
      return `[${color}]${text}`;
    },
  } as unknown as Theme);
  assert.equal(styles.rowBg("x"), "[userMessageBg]x");
  assert.equal(styles.rowSelectedBg("y"), "[selectedBg]y", "选中行用更强的 selectedBg");
  assert.equal(styles.bubble("z"), "[userMessageBg]z");
  assert.deepEqual(calls, ["userMessageBg", "selectedBg", "userMessageBg"]);

  // 色名取不到（宿主 Theme.bg 抛错）→ 原样返回（亮块无背景但可读，绝不弄崩渲染）。
  const throwing = themeStyles({
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    bg: () => {
      throw new Error("Unknown theme background color: selectedBg");
    },
  } as unknown as Theme);
  assert.equal(throwing.rowBg("x"), "x");
  assert.equal(throwing.rowSelectedBg("y"), "y");

  // 宿主题无 bg 方法（旧接口/降级主题）：同样无背景降级。
  const noBg = themeStyles({ fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme);
  assert.equal(noBg.rowBg("x"), "x");
  assert.equal(noBg.rowSelectedBg("y"), "y");
});

function entry(kind: TranscriptEntry["kind"], text: string, ts = "2026-09-06T12:34:56.000Z"): TranscriptEntry {
  return { kind, text, ts };
}

// 帧行两栏拆分：按中间分隔边框切（位置与宽度/标签无关，精确到列）。
function paneColumns(line: string): { roster: string; detail: string } {
  const mid = line.indexOf("│", 1);
  return { roster: line.slice(1, mid).trimEnd(), detail: line.slice(mid + 1, line.length - 1).trimEnd() };
}

// ANSI 包裹样式：与真机 theme 同构（escape 不占显示宽度，不影响 fitLine 定宽）。
const ansi = (code: string) => (text: string): string => `\x1b[${code}m${text}\x1b[0m`;

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

// 真机事故（重复行第四轮）：cockpit.ts:499 把每次派发写成多行 tool 条目
// （`team_dispatch 派发 →\n  - 成员: 任务`）。旧渲染把它当单行输出，帧行携带
// 原始 \n——宿主按物理行写屏时换行把尾巴挤到下一行的同列，overlay 左缘出现
// 残行、帧几何漂移且 diff 渲染器无法清理（真机 pane1/pane2 相隔 3s 像素相同）。
test("blockLines splits multi-line tool entries into physical rows (no raw newline survives)", () => {
  const dispatch = "team_dispatch 派发 →\n  - front: 请数出数字 2（计数序列的一部分）。只输出数字 2，不要任何额外文字。";
  const lines = blockLines({ kind: "tools", lines: [dispatch] }, 60, styles);
  assert.equal(lines.length, 2, "多行条目拆成两帧行");
  for (const line of lines) {
    assert.doesNotMatch(line, /[\r\n]/, "帧行不得残留原始换行");
    assert.ok(visibleWidth(line) <= 60, `帧行不得超宽：${JSON.stringify(line)}`);
  }
  assert.match(lines[0], /^· team_dispatch 派发 →/);
  assert.match(lines[1], /^ {2}- front: 请数出数字 2/, "续行保留写入者的缩进结构");

  const viaBody = bodyLines([entry("tool", dispatch)], true, 60, styles);
  assert.equal(viaBody.length, 2, "buildBlocks → blockLines 全路径同样拆行");
  assert.ok(viaBody.every((line) => !/[\r\n]/.test(line)));
});

test("renderViewerFrame never emits raw CR/LF and keeps the frame height exact", () => {
  const dispatch = "team_dispatch 派发 →\n  - front: 请数出数字 2（计数序列的一部分）。";
  const data = viewerData({
    entries: new Map<string, TranscriptEntry[]>([
      ["_leader", [entry("task", "数数"), entry("tool", dispatch), entry("assistant", "第一段\n\n第二段")]],
    ]),
  });
  const bodyHeight = 12;
  const frame = renderViewerFrame(data, initialViewerState(), 90, { styles, bodyHeight });
  assert.equal(frame.length, bodyHeight + VIEWER_CHROME_ROWS, "帧高恒定");
  for (const line of frame) {
    assert.doesNotMatch(line, /[\r\n]/, `帧行不得含原始换行：${JSON.stringify(line)}`);
  }
});

test("fitLine folds raw CR/LF before measuring so rows stay single physical lines", () => {
  const line = fitLine("a\nb", 6);
  assert.doesNotMatch(line, /[\r\n]/);
  assert.equal(visibleWidth(line), 6);
  assert.equal(line, "a b   ", "换行折成空格后按宽度补齐");
  assert.equal(fitLine("x\r\ny", 4), "x y ", "CRLF 同样折叠且不双计宽度");
});

// ---------------------------------------------------------------------------
// Bordered frame + dynamic height
// ---------------------------------------------------------------------------

// 规格表 §4：bodyHeight = max(2, floor(rows*0.85) - 6)（fleet.ts:1326-1327，
// rows 缺省 32）；期望值从 tui-sync.md §4 抄录，不从实现复制。
test("computeFrameHeight follows the fleet 85%−6 formula with a 2-row floor", () => {
  assert.equal(computeFrameHeight(40), 28);
  assert.equal(computeFrameHeight(24), 14);
  assert.equal(computeFrameHeight(30), 19);
  assert.equal(computeFrameHeight(10), 2, "2-row floor for tiny terminals");
  assert.equal(computeFrameHeight(0), 21, "unknown rows fallback = fleet default 32");
});

test("computeViewerLayout follows the fleet roster/detail geometry formulas", () => {
  // 规格表 §4：innerWidth=width-2、rosterWidth=max(22,min(46,floor((inner-1)*0.38)))、
  // detailWidth=max(1,inner-roster-1)（fleet.ts:1322/1328/1329）。
  assert.deepEqual(computeViewerLayout(80), { innerWidth: 78, rosterWidth: 29, detailWidth: 48 });
  assert.deepEqual(computeViewerLayout(36), { innerWidth: 34, rosterWidth: 22, detailWidth: 11 }, "最小门下 roster 钳到 22");
  assert.deepEqual(computeViewerLayout(200), { innerWidth: 198, rosterWidth: 46, detailWidth: 151 }, "roster 钳到 46");
});

test("renderViewerFrame renders the fleet split-frame structure", () => {
  // 帧结构（§4）：顶边框 → 标题行（左静态标题/右对齐选中态）→ ├─┬─┤ →
  // bodyHeight 行 │roster│detail│ → ├─┴─┤ → 图例行 → 底边框（fleet.ts:1343-1370）。
  const bodyHeight = 10;
  const frame = renderViewerFrame(viewerData(), initialViewerState(), 80, { styles, bodyHeight });
  assert.equal(frame.length, bodyHeight + VIEWER_CHROME_ROWS);
  assert.match(frame[0], /^╭─+╮$/, "plain top border");
  assert.match(frame[1], /^│ agent-team viewer · team dev-team/, "static title on the left");
  assert.match(frame[1], /▶ leader · running\s+│$/, "selected actor status right-aligned");
  assert.match(frame[2], /^├─+┬─+┤$/, "upper roster/detail separator");
  for (const line of frame.slice(3, 3 + bodyHeight)) {
    assert.match(line, /^│.*│.*│$/, "body rows span both panes");
    assert.equal(visibleWidth(line), 80, "body rows are padded to the full width");
  }
  assert.match(frame[3 + bodyHeight], /^├─+┴─+┤$/, "lower separator");
  assert.match(frame[3 + bodyHeight + 1], /↑↓ 成员/, "legend row above the bottom border");
  assert.match(frame[3 + bodyHeight + 2], /^╰─+╯$/, "plain bottom border");
  for (const [index, line] of frame.entries()) {
    assert.equal(visibleWidth(line), 80, `line ${index} is exactly frame width`);
  }
});

test("renderViewerFrame styles the roster with the port: selected marker, bold label, status icons", () => {
  const styled: Styles = { ...styles, bold: ansi("1"), accent: ansi("36"), success: ansi("32") };
  const frame = renderViewerFrame(viewerData(), initialViewerState(), 80, { styles: styled, bodyHeight: 8 });
  const text = frame.join("\n");
  assert.match(text, /\x1b\[36m›\x1b\[0m \x1b\[36m▶\x1b\[0m \x1b\[1mleader\x1b\[0m · _leader/, "selected row: accent marker + running icon + bold label");
  assert.match(text, /\x1b\[32m✓\x1b\[0m frontend · frontend/, "unselected row: success icon + plain label");
  assert.ok(!frame[1].includes("\x1b[1m"), "title row never bolds (roster-only styling)");
});

test("renderViewerFrame pins a fixed five-line meta header atop the detail pane", () => {
  const styled: Styles = { ...styles, bold: ansi("1") };
  const data = viewerData({
    actors: [
      { actor: "_leader", label: "leader", status: "running", model: "anthropic/claude-opus-4-5" },
      { actor: "frontend", label: "frontend", status: "done" },
    ],
  });
  const frame = renderViewerFrame(data, { ...initialViewerState(), follow: false, scroll: 0 }, 80, { styles: styled, bodyHeight: 10 });
  assert.match(paneColumns(frame[3]).detail, /^\x1b\[1mRun:\x1b\[0m run-42/, "Run line first");
  assert.match(paneColumns(frame[4]).detail, /^\x1b\[1mState:\x1b\[0m running/, "State line second");
  assert.match(paneColumns(frame[5]).detail, /^\x1b\[1m成员:\x1b\[0m leader（running）· 1\/2/, "member line third");
  assert.match(
    paneColumns(frame[6]).detail,
    /^\x1b\[1m模型:\x1b\[0m anthropic\/claude-opus-4-5/,
    "model line fourth (selected actor's backend model)",
  );
  assert.match(paneColumns(frame[7]).detail, /^\x1b\[1m活动:\x1b\[0m /, "activity line fifth");
  assert.match(frame.slice(8).join("\n"), /让我先拆解任务/, "transcript body starts below the header");
  assert.doesNotMatch(paneColumns(frame[3]).detail, /❯/, "header does not scroll with the body");

  // 未声明模型的 actor（子进程走 pi 默认）：显式降级文案，不猜模型名。
  const second = { ...initialViewerState(), actorIndex: 1 };
  const frame2 = renderViewerFrame(data, second, 80, { styles: styled, bodyHeight: 10 });
  assert.match(paneColumns(frame2[6]).detail, /^\x1b\[1m模型:\x1b\[0m （默认）/, "unspecified model → child default label");

  // 头部行数上限 bodyHeight-1（fleet.ts:1335）：bodyHeight=3 时成员行让位给正文。
  const tight = renderViewerFrame(data, initialViewerState(), 80, { styles: styled, bodyHeight: 3 });
  assert.equal(tight.length, 3 + VIEWER_CHROME_ROWS);
  assert.match(paneColumns(tight[3]).detail, /\x1b\[1mRun:/);
  assert.match(paneColumns(tight[4]).detail, /\x1b\[1mState:/);
  assert.ok(!tight.join("\n").includes("\x1b[1m成员:"), "header capped at bodyHeight-1");
});

// 需求 B：模型行追加思考级别段——`<model> · 思考 <level>`；
// model 已知/未知分别降级 `（默认）`，头部仍是固定 5 行。
test("详情头模型行带思考级别：有值 `· 思考 <level>`，model 已知/未知分别降级 （默认）", () => {
  const styled: Styles = { ...styles, bold: ansi("1") };
  const withLevel = viewerData({
    actors: [{ actor: "_leader", label: "leader", status: "running", model: "anthropic/claude-opus-4-5", thinkingLevel: "high" }],
  });
  const frame = renderViewerFrame(withLevel, initialViewerState(), 80, { styles: styled, bodyHeight: 10 });
  assert.match(paneColumns(frame[6]).detail, /^\x1b\[1m模型:\x1b\[0m anthropic\/claude-opus-4-5 · 思考 high/);
  assert.equal(frame.length, 10 + VIEWER_CHROME_ROWS, "帧总行数不变（仍 5 行头）");

  // model 已知而思考级别未知（legacy/unmanaged provider 缺省）：显式降级
  const noLevel = viewerData({
    actors: [{ actor: "_leader", label: "leader", status: "running", model: "anthropic/claude-opus-4-5" }],
  });
  const frame2 = renderViewerFrame(noLevel, initialViewerState(), 80, { styles: styled, bodyHeight: 10 });
  assert.match(paneColumns(frame2[6]).detail, /^\x1b\[1m模型:\x1b\[0m anthropic\/claude-opus-4-5 · 思考 （默认）/);

  // model 与级别均未知：仅 （默认），不猜
  const neither = viewerData({ actors: [{ actor: "_leader", label: "leader", status: "running" }] });
  const frame3 = renderViewerFrame(neither, initialViewerState(), 80, { styles: styled, bodyHeight: 10 });
  assert.match(paneColumns(frame3[6]).detail, /^\x1b\[1m模型:\x1b\[0m （默认）/);
});

test("renderViewerFrame gates tiny terminals with a single hint line", () => {
  // 最小宽度门（§4，fleet.ts:1321）：width<36 → 单行提示（与 fleet 同构：
  // 窄终端下提示本身也会被截断，只保证单行不破版）。
  const frame = renderViewerFrame(viewerData(), initialViewerState(), 35, { styles, bodyHeight: 8 });
  assert.equal(frame.length, 1);
  assert.match(frame[0], /agent-team viewer/);
  assert.equal(visibleWidth(frame[0]), 35, "hint line still fits the terminal");
});

test("renderViewerFrame windows the roster so the selection stays visible", () => {
  // 窗口化公式（§4，fleet.ts:1219）：start = max(0, min(sel-body+1, max(0, n-body)))。
  const actors = [
    { actor: "_leader", label: "leader", status: "running" as const },
    ...Array.from({ length: 12 }, (_, i) => ({ actor: `m${String(i + 1).padStart(2, "0")}`, label: `m${String(i + 1).padStart(2, "0")}`, status: "done" as const })),
  ];
  const data = viewerData({ actors });
  const bottom = { ...initialViewerState(), actorIndex: 12 };
  // 宽 120：图例 + 成员位置完整可见（82 列宽 < innerWidth 118）。
  const frame = renderViewerFrame(data, bottom, 120, { styles, bodyHeight: 10 });
  assert.match(frame.join("\n"), /· m12/, "selected last actor visible");
  assert.doesNotMatch(frame.join("\n"), /· m01/, "early actors scrolled out");
  assert.match(frame.join("\n"), /成员 13\/13/);

  const top = renderViewerFrame(data, initialViewerState(), 120, { styles, bodyHeight: 10 });
  assert.match(top.join("\n"), /· _leader/, "selection at top shows the head of the roster");
});

test("renderViewerFrame shows an empty-roster dim row and a member-less header", () => {
  const frame = renderViewerFrame(viewerData({ actors: [], entries: new Map() }), initialViewerState(), 80, { styles, bodyHeight: 10 });
  assert.match(paneColumns(frame[3]).roster, /（无成员）/, "roster dim row");
  assert.match(paneColumns(frame[5]).detail, /成员:\s*（无成员）/);
  assert.match(frame.join("\n"), /暂无记录/);
});

test("renderViewerFrame shows the continuous flow and honours scroll/follow in the detail pane", () => {
  const many = Array.from({ length: 50 }, (_, i) => entry("assistant", `line ${i}`));
  const data = viewerData({ entries: new Map([["_leader", many]]) });

  const following = renderViewerFrame(data, initialViewerState(), 60, { styles, bodyHeight: 10 });
  assert.match(following.join("\n"), /line 49/, "follow shows the newest line");
  assert.doesNotMatch(following.join("\n"), /line 0\b/);

  const state = clampViewerState({ ...initialViewerState(), follow: false }, 100, 7);
  assert.equal(state.scroll, 0);
  const top = renderViewerFrame(data, state, 60, { styles, bodyHeight: 10 });
  assert.match(top.join("\n"), /line 0\b/);
  assert.doesNotMatch(top.join("\n"), /line 49/);
});

test("renderViewerFrame hides tool rows when toggled off", () => {
  const frame = renderViewerFrame(viewerData(), { ...initialViewerState(), showTools: false }, 60, { styles, bodyHeight: 10 });
  assert.doesNotMatch(frame.join("\n"), /team_dispatch/);
});

test("renderViewerFrame clamps overflowing body lines to the exact frame width", () => {
  // Regression: host Markdown output (and any tool text) wider than the pane
  // used to bleed past the right border — fleet-inspector style fit() now
  // truncates + pads every frame line to an exact display width.
  const data = viewerData({
    entries: new Map<string, TranscriptEntry[]>([
      [
        "_leader",
        [
          entry("task", "目标：" + "面向摄影初学者的中文摄影教学页面。".repeat(20)),
          entry("tool", "team_dispatch → " + "x".repeat(400)),
          entry("assistant", "正文"),
        ],
      ],
    ]),
  });
  const overwideMarkdown = (text: string): string[] => [text + "——很长的未换行 markdown 输出".repeat(10)];
  const width = 120;
  const frame = renderViewerFrame(data, initialViewerState(), width, {
    styles,
    bodyHeight: 12,
    renderMarkdown: overwideMarkdown,
  });
  assert.equal(frame.length, 12 + VIEWER_CHROME_ROWS);
  for (const [index, line] of frame.entries()) {
    assert.ok(visibleWidth(line) <= width, `line ${index} renders ${visibleWidth(line)} > ${width}`);
    assert.equal(visibleWidth(line), width, `line ${index} is padded to the exact frame width`);
  }
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

test("handleViewerKey closes on q, Escape and ctrl+c", () => {
  // close 键集对齐 fleet `close: ["escape", "ctrl+c", "q"]`（v0.66.0
  // fleet.ts:34，规格表 §4）。ctrl+c 编码契约 \x03（matchesKey 判定）。
  assert.equal(handleViewerKey(initialViewerState(), "q", keyCtx(10)).type, "close");
  assert.equal(handleViewerKey(initialViewerState(), "\x1b", keyCtx(10)).type, "close");
  assert.equal(handleViewerKey(initialViewerState(), "\x03", keyCtx(10)).type, "close");
});

test("handleViewerKey 普通字符不关闭（ctrl+c 不被吞也不会误关）", () => {
  // 与上面互补：非 close 键保持原状态 update，close 判定不会误伤普通字符。
  for (const ch of ["a", "z", "0", "\t"]) {
    const r = handleViewerKey(initialViewerState(), ch, keyCtx(10));
    assert.ok(r.type === "update", `普通字符 ${JSON.stringify(ch)} 应 update 而非 close`);
  }
});

// Kitty 键盘协议 flag 2 下每次按键额外发送 release 事件（`:3` 编码）；
// 不过滤则一次按键生效两次（↓ 跳两个成员、x 切换两次等于没反应、
// D 确认后 release 再次确认）。fleet-status.ts:699 同款过滤。
test("handleViewerKey: Kitty release 事件一律忽略（状态零变化）", () => {
  const state = initialViewerState();
  const ctx = keyCtx(50, 3, 10);
  for (const release of [
    "\x1b[1;1:3B", // ↓ release
    "\x1b[1;1:3A", // ↑ release
    "\x1b[1;1:3D", // ← release
    "\x1b[1;1:3C", // → release
    "\x1b[13;1:3u", // enter release
    "\x1b[120;1:3u", // x release（工具行开关不得双切）
  ]) {
    const r = handleViewerKey(state, release, ctx);
    assert.ok(r.type === "update", `release ${JSON.stringify(release)} 应为 no-op update`);
    assert.deepEqual(r.state, state, `release ${JSON.stringify(release)} 不得改变状态`);
  }
  // 确认态：Enter 的 release 不得触发 stop-confirm。
  const confirming = { ...initialViewerState(), stopConfirming: true };
  const r = handleViewerKey(confirming, "\x1b[13;1:3u", ctx);
  assert.ok(r.type === "update" && r.state.stopConfirming === true, "release 不得确认停止");
});

test("handleViewerKey 滚动正文：Shift+K 上滚 unfollow、Shift+J 下滚到底 re-follow", () => {
  // 滚动键对齐 fleet scrollUp: ["K"] / scrollDown: ["J"]（fleet.ts:35-36，
  // 大写绑定→shift+小写经 matchesKey 判定）；小写 k/j 现在是成员切换键。
  const up = handleViewerKey(initialViewerState(), "K", keyCtx(50, 2, 10));
  assert.ok(up.type === "update");
  assert.equal(up.state.follow, false);
  assert.equal(up.state.scroll, 39, "unfollow starts from the bottom minus one");

  const down = handleViewerKey({ ...initialViewerState(), follow: false, scroll: 0 }, "J", keyCtx(50, 2, 10));
  assert.ok(down.type === "update");
  assert.equal(down.state.scroll, 1);
  assert.equal(down.state.follow, false);

  const toBottom = handleViewerKey({ ...initialViewerState(), follow: false, scroll: 39 }, "J", keyCtx(50, 2, 10));
  assert.ok(toBottom.type === "update");
  assert.equal(toBottom.state.follow, true, "reaching the bottom re-enables follow");
});

test("handleViewerKey PgUp/PgDn 翻页不变；g/G（旧滚动到顶/底）退役忽略", () => {
  const pageUp = handleViewerKey(initialViewerState(), "\x1b[5~", keyCtx(50, 2, 10));
  assert.ok(pageUp.type === "update");
  assert.equal(pageUp.state.scroll, 30, "page up from the bottom");
  assert.equal(pageUp.state.follow, false);

  // 从底部再 PgDn：已在底，保持 follow；从 scroll 30 再 PgDn 一页到底 re-follow。
  const pageDown = handleViewerKey(initialViewerState(), "\x1b[6~", keyCtx(50, 2, 10));
  assert.ok(pageDown.type === "update");
  assert.equal(pageDown.state.follow, true, "底部再 PgDn 保持 follow");
  const pageDownHalf = handleViewerKey({ ...initialViewerState(), follow: false, scroll: 30 }, "\x1b[6~", keyCtx(50, 2, 10));
  assert.ok(pageDownHalf.type === "update");
  assert.equal(pageDownHalf.state.scroll, 40);
  assert.equal(pageDownHalf.state.follow, true, "翻到底自动 re-follow");

  for (const key of ["g", "G"]) {
    const r = handleViewerKey(initialViewerState(), key, keyCtx(50, 2, 10));
    assert.ok(r.type === "update");
    assert.deepEqual(r.state, initialViewerState(), `退役键 ${JSON.stringify(key)} 不改状态`);
  }
});

test("handleViewerKey ↑↓/j/k 切换成员（重置滚动 follow、首末钳位）", () => {
  const down = handleViewerKey(initialViewerState(), "\x1b[B", keyCtx(10));
  assert.ok(down.type === "update");
  assert.equal(down.state.actorIndex, 1);
  assert.equal(down.state.follow, true, "actor switch resets to follow");
  assert.equal(down.state.scroll, 0, "actor switch resets scroll");

  const j = handleViewerKey(initialViewerState(), "j", keyCtx(10));
  assert.ok(j.type === "update");
  assert.equal(j.state.actorIndex, 1);

  const upClamp = handleViewerKey(initialViewerState(), "\x1b[A", keyCtx(10));
  assert.ok(upClamp.type === "update");
  assert.equal(upClamp.state.actorIndex, 0, "clamped at the first actor");
  assert.deepEqual(upClamp.state, initialViewerState(), "首行再按 ↑：状态不变");

  const k = handleViewerKey(initialViewerState(), "k", keyCtx(10));
  assert.ok(k.type === "update");
  assert.equal(k.state.actorIndex, 0);

  const endClamp = handleViewerKey({ ...initialViewerState(), actorIndex: 1 }, "\x1b[B", keyCtx(10));
  assert.ok(endClamp.type === "update");
  assert.equal(endClamp.state.actorIndex, 1, "clamped at the last actor");
});

test("handleViewerKey Home/End 跳首/末成员（fleet moveSelection(±items.length) 同构）", () => {
  const home = handleViewerKey({ ...initialViewerState(), actorIndex: 1 }, "\x1b[H", keyCtx(10));
  assert.ok(home.type === "update");
  assert.equal(home.state.actorIndex, 0, "Home → first member");

  const end = handleViewerKey(initialViewerState(), "\x1b[F", keyCtx(10, 3, 10));
  assert.ok(end.type === "update");
  assert.equal(end.state.actorIndex, 2, "End → last member");
});

test("handleViewerKey 旧成员/滚动键退役：←→/h/l/Tab/1-9 忽略不改状态", () => {
  for (const key of ["\x1b[D", "\x1b[C", "h", "l", "\t", "1", "5", "9"]) {
    const r = handleViewerKey(initialViewerState(), key, keyCtx(10));
    assert.ok(r.type === "update", `键 ${JSON.stringify(key)} 应 update 不关闭`);
    assert.deepEqual(r.state, initialViewerState(), `退役键 ${JSON.stringify(key)} 不改状态`);
  }
});

// ---------------------------------------------------------------------------
// Stop/refresh actions（v1.4.0，fleet v0.66.0 stop/refresh 对齐）
// ---------------------------------------------------------------------------

function stopCtx(overrides: Partial<{ totalLines: number; actorCount: number; bodyHeight: number; runRunning: boolean; runStatus: string }> = {}) {
  return { totalLines: 10, actorCount: 2, bodyHeight: 10, runRunning: true, runStatus: "running", ...overrides };
}

test("handleViewerKey D on a running run arms stop confirmation", () => {
  const result = handleViewerKey(initialViewerState(), "D", stopCtx());
  assert.ok(result.type === "update");
  assert.equal(result.state.stopConfirming, true);
  // 小写 d 不触发（fleet 键位 stop: ["D"]，shift+d）。
  const lower = handleViewerKey(initialViewerState(), "d", stopCtx());
  assert.ok(lower.type === "update");
  assert.equal(lower.state.stopConfirming, false);
});

test("确认态 Enter/Y 请求停止，N/Esc/ctrl+c/backspace 取消且不关闭，q 被忽略", () => {
  const armed = { ...initialViewerState(), stopConfirming: true };
  for (const key of ["\r", "y", "Y"]) {
    const r = handleViewerKey(armed, key, stopCtx());
    assert.equal(r.type, "stop-confirm", `键 ${JSON.stringify(key)} 应 stop-confirm`);
  }
  for (const key of ["n", "N", "\x1b", "\x03", "\x7f"]) {
    const r = handleViewerKey(armed, key, stopCtx());
    assert.ok(r.type === "update", `键 ${JSON.stringify(key)} 应 update（取消不关闭）`);
    if (r.type === "update") assert.equal(r.state.stopConfirming, false, `键 ${JSON.stringify(key)} 应退出确认态`);
  }
  const ignored = handleViewerKey(armed, "q", stopCtx());
  assert.ok(ignored.type === "update", "确认态下 q 不关闭");
  if (ignored.type === "update") assert.equal(ignored.state.stopConfirming, true, "确认态保持");
  const other = handleViewerKey(armed, "\x1b[B", stopCtx());
  assert.ok(other.type === "update");
  if (other.type === "update") assert.equal(other.state.stopConfirming, true, "确认态下其余键被忽略");
});

test("handleViewerKey D on a finished run shows an error notice without arming", () => {
  const result = handleViewerKey(initialViewerState(), "D", stopCtx({ runRunning: false, runStatus: "aborted" }));
  assert.ok(result.type === "update");
  if (result.type === "update") {
    assert.equal(result.state.stopConfirming, false, "不进确认态");
    assert.ok(result.state.notice, "D-on-finished 应产出 notice");
    assert.equal(result.state.notice?.kind, "error");
    assert.match(result.state.notice?.text ?? "", /run 已结束（aborted），无需停止/);
  }
});

test("handleViewerKey r/R request refresh; any other keypress clears the notice", () => {
  assert.equal(handleViewerKey(initialViewerState(), "r", stopCtx()).type, "refresh");
  assert.equal(handleViewerKey(initialViewerState(), "R", stopCtx()).type, "refresh");

  const noticed = handleViewerKey(initialViewerState(), "D", stopCtx({ runRunning: false, runStatus: "done" }));
  assert.ok(noticed.type === "update");
  const cleared = handleViewerKey(noticed.type === "update" ? noticed.state : initialViewerState(), "\x1b[A", stopCtx({ runRunning: false }));
  assert.ok(cleared.type === "update");
  if (cleared.type === "update") assert.equal(cleared.state.notice, undefined, "下一次按键清除 notice");
});

test("actionLines：确认横幅两行/busy 一行/notice 一行互斥（优先级 busy > 确认 > notice）", () => {
  const armed = { ...initialViewerState(), stopConfirming: true };
  const banner = actionLines(viewerData(), armed, styles);
  assert.equal(banner.length, 2);
  assert.match(banner[0], /确认停止 run run-42？/);
  assert.match(banner[1], /Enter\/Y 确认 · N 取消 · Esc 取消/);

  const busy = actionLines(viewerData(), { ...initialViewerState(), stopping: true }, styles);
  assert.equal(busy.length, 1);
  assert.match(busy[0], /停止中…/);

  const notice = actionLines(viewerData(), { ...initialViewerState(), notice: { text: "run 已停止", kind: "success" } }, styles);
  assert.equal(notice.length, 1);
  assert.match(notice[0], /run 已停止/);

  // busy 优先于确认与 notice（对齐 fleet actionLines 顺序）。
  const busyWins = actionLines(viewerData(), { ...armed, stopping: true, notice: { text: "x", kind: "error" } }, styles);
  assert.equal(busyWins.length, 1);
  assert.match(busyWins[0], /停止中…/);
});

test("renderViewerFrame：action 行占右栏正文窗口顶部（头部之下），窗口收缩，帧总行数不变", () => {
  const bodyHeight = 10;
  const plain = renderViewerFrame(viewerData(), initialViewerState(), 80, { styles, bodyHeight });
  assert.equal(plain.length, bodyHeight + VIEWER_CHROME_ROWS);

  const armed = { ...initialViewerState(), follow: false, scroll: 0, stopConfirming: true };
  const frame = renderViewerFrame(viewerData(), armed, 80, { styles, bodyHeight });
  assert.equal(frame.length, bodyHeight + VIEWER_CHROME_ROWS, "帧总行数恒定");
  // detail 列布局：头部五行（3-7）→ 横幅按 detail 宽换行（8-10）→ 正文（11 起）。
  assert.match(paneColumns(frame[8]).detail, /确认停止 run run-42/, "横幅第一行在头部之下");
  assert.match(paneColumns(frame[9]).detail, /Enter\/Y 确认/, "横幅第二行（换行后首段）");
  assert.match(paneColumns(frame[10]).detail, /· N 取消 · Esc 取消/, "横幅换行尾段");
  assert.match(paneColumns(frame[11]).detail, /❯ 修复登录 bug/, "正文第一行被横幅下推");
  for (const [index, line] of frame.entries()) {
    assert.equal(visibleWidth(line), 80, `line ${index} fitLine 后行宽恒定`);
  }

  const noticeFrame = renderViewerFrame(viewerData(), { ...initialViewerState(), notice: { text: "run 已结束（done），无需停止", kind: "error" } }, 80, { styles, bodyHeight });
  assert.equal(noticeFrame.length, bodyHeight + VIEWER_CHROME_ROWS);
  assert.match(paneColumns(noticeFrame[8]).detail, /run 已结束（done），无需停止/);
});

test("图例行独立于底边框：含 D 停止/r 刷新/q 关闭与成员位置", () => {
  // v1.6.0：图例从底边框内嵌改为独立一行（§4 帧结构，fleet.ts:1366-1368）。
  const frame = renderViewerFrame(viewerData(), initialViewerState(), 120, { styles, bodyHeight: 8 });
  const legend = frame[frame.length - 2];
  assert.match(legend, /D 停止 · r 刷新 · q 关闭/);
  assert.match(legend, /成员 1\/2/);
  assert.match(legend, /^│.*│$/, "图例行在边框内");
  assert.match(frame[frame.length - 1], /^╰─+╯$/, "底边框纯边框，无内嵌文案");
});

test("handleViewerKey toggles tool rows with x/X/ctrl+o（fleet toggleTools 键集）", () => {
  // fleet toggleTools: ["x", "X", "ctrl+o"]（fleet.ts:48，规格表 §4）。
  for (const key of ["x", "X", "\x0f"]) {
    const toggled = handleViewerKey(initialViewerState(), key, keyCtx(10));
    assert.ok(toggled.type === "update");
    assert.equal(toggled.state.showTools, false, `键 ${JSON.stringify(key)} 应关闭工具行`);
    const again = handleViewerKey(toggled.state as ViewerState, key, keyCtx(10));
    assert.ok(again.type === "update");
    assert.equal(again.state.showTools, true, `再按 ${JSON.stringify(key)} 应恢复`);
  }

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
