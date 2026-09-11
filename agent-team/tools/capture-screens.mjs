/**
 * agent-team — headless screenshot capture for docs/assets (GOAL.md §2 "真机截图")
 *
 * 为什么这样截图：README 的 ASCII"效果示意"不能替代真实画面，但真机抓屏
 * 需要人肉 + 终端窗口。本工具走"真实渲染路径"——真实的 `TuiMainScreen` +
 * 真实的 `TranscriptViewer` 组件 + 真实的主屏 diff 渲染器，只是把终端换成一个
 * 记录字节流的 headless 终端，再把字节流还原为字符网格写成 SVG（GitHub 可
 * 直接渲染）。产物可重复生成、可 diff、可在 CI/无人值守环境跑。
 *
 * 诚实边界（写进 README 图注）：场景数据是示例 run（count-duet / nightly-audit），
 * 助手正文按纯文本渲染（未接宿主 Markdown 主题），主屏背景为示意文本；除此之外的
 * 布局、边框、页签、状态色、widget 文字全部来自被测组件本身。
 *
 * 本工具是工作区级文档截图管线（住在 agent-team/tools/，但产出两个插件的图）：
 * `agent-team-viewer.svg`（真实 `TranscriptViewer`）与 `pwr-viewer.svg`（真实
 * `pwr/src/ui/viewer.ts` 的 `RunViewer`）——同一 VT/SVG 管线，避免为第二个插件
 * 复制一份仿真屏代码。
 *
 * 用法（需 agent-team/ 与 pwr/ 都 npm install）：
 *   node agent-team/tools/capture-screens.mjs [outDir]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TuiMainScreen, Container, Editor, Spacer, Text } from "@earendil-works/pi-tui";
import { VIEWER_OVERLAY_OPTIONS, TranscriptViewer } from "../viewer.ts";
import { buildWidgetView, renderWidgetView } from "../widget.ts";
import {
  VIEWER_OVERLAY_OPTIONS as PWR_VIEWER_OVERLAY_OPTIONS,
  RunViewer,
  assembleViewerData,
} from "../../pwr/src/ui/viewer.ts";
import { DEFAULT_BG, DEFAULT_FG, VtScreen } from "./vt-screen.mjs";

// ---------------------------------------------------------------------------
// Style port: dark palette (approximates the host's default dark theme)
// ---------------------------------------------------------------------------

const hexToSgr = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { open: `\x1b[38;2;${r};${g};${b}m`, close: "\x1b[39m", bgOpen: `\x1b[48;2;${r};${g};${b}m`, bgClose: "\x1b[49m" };
};

const fgStyle = (hex) => {
  const s = hexToSgr(hex);
  return (text) => `${s.open}${text}${s.close}`;
};
const bgStyle = (hex) => {
  const s = hexToSgr(hex);
  return (text) => `${s.bgOpen}${text}${s.bgClose}`;
};

export const DARK = {
  dim: "#6b7280",
  border: "#4b5263",
  accent: "#61afef",
  success: "#98c379",
  warning: "#e5c07b",
  error: "#e06c75",
  bubble: "#2c313a",
  rowBg: "#2c313a",
  rowSelectedBg: "#3b4252",
  text: DEFAULT_FG,
};

/** Real `Styles` port backed by ANSI codes (no theme object needed headless). */
export function ansiStyles() {
  return {
    dim: fgStyle(DARK.dim),
    border: fgStyle(DARK.border),
    accent: fgStyle(DARK.accent),
    success: fgStyle(DARK.success),
    error: fgStyle(DARK.error),
    warning: fgStyle(DARK.warning),
    bubble: bgStyle(DARK.bubble),
    rowBg: bgStyle(DARK.rowBg),
    rowSelectedBg: bgStyle(DARK.rowSelectedBg),
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
}

// ---------------------------------------------------------------------------
// SVG writer (character grid → GitHub-renderable SVG)
// ---------------------------------------------------------------------------

const CELL_W = 8.4;
const CELL_H = 18;
const FONT_SIZE = 14;

const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const styleKey = (c) => `${c.bold ? "b" : ""}${c.dim ? "d" : ""}${c.underline ? "u" : ""}${c.inverse ? "i" : ""}|${c.fg ?? ""}|${c.bg ?? ""}`;

/** 网格 → SVG 文本（每行按样式切成 run，用 textLength 钉死列宽，保证对齐）。 */
export function svgFromGrid(grid) {
  const cols = grid[0]?.length ?? 0;
  const width = Math.ceil(cols * CELL_W);
  const height = grid.length * CELL_H;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'Cascadia Mono','JetBrains Mono',Consolas,Menlo,monospace" font-size="${FONT_SIZE}">`,
    `<rect width="100%" height="100%" fill="${DEFAULT_BG}"/>`,
  ];
  grid.forEach((row, r) => {
    const y = r * CELL_H + 13;
    // 行尾裁剪：保留有背景色或非空白的最后一格
    let last = -1;
    row.forEach((c, i) => {
      if (!c) return;
      if (c.ch !== " " || c.bg) last = i;
    });
    for (let i = 0; i <= last; i++) {
      const c = row[i];
      if (!c || c.cont) continue;
      const key = styleKey(c);
      let j = i;
      while (j + 1 <= last && row[j + 1] && styleKey(row[j + 1]) === key) j += 1;
      const text = [];
      for (let k = i; k <= j; k++) if (!row[k].cont) text.push(row[k].ch);
      const content = text.join("");
      const runWidth = (j - i + 1) * CELL_W;
      const fg = c.inverse ? (c.bg ?? DARK.text) : (c.fg ?? DARK.text);
      const bg = c.inverse ? (c.fg ?? DEFAULT_BG) : c.bg;
      if (bg) parts.push(`<rect x="${(i * CELL_W).toFixed(1)}" y="${(r * CELL_H).toFixed(1)}" width="${runWidth.toFixed(1)}" height="${CELL_H}" fill="${bg}"/>`);
      if (content.trim() !== "") {
        const weight = c.bold ? ' font-weight="bold"' : "";
        const opacity = c.dim ? ' opacity="0.75"' : "";
        const decoration = c.underline ? ' text-decoration="underline"' : "";
        parts.push(
          `<text x="${(i * CELL_W).toFixed(1)}" y="${y}" fill="${fg}" textLength="${runWidth.toFixed(1)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve"${weight}${opacity}${decoration}>${escapeXml(content)}</text>`,
        );
      }
      i = j;
    }
  });
  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Scene: real TranscriptViewer over a real TuiMainScreen (headless terminal)
// ---------------------------------------------------------------------------

function entry(kind, text) {
  return { kind, text, ts: "2026-09-11T09:12:04.000Z" };
}

/** 切 run 列表（[`]`]）：第二个 run 只在 legend 的 ` · [/] 切 run` 上体现。 */
const VIEWER_RUNS = [
  { runId: "run-1788938207941", team: "count-duet", status: "running" },
  { runId: "run-1788938207942", team: "nightly-audit", status: "running" },
];

/** 示例 run 数据（count-duet：leader 派单、两个成员数数）——与真机冒烟场景同形。 */
function countDuet(elapsedSec, extraDispatch) {
  const leader = [
    entry("task", "用 count-duet 团队从 1 数到 10；leader 数奇数，front 数偶数。"),
    entry("assistant", "收到，先派 front 数偶数，再派 back 复核序列。"),
    entry("tool", "team_dispatch 派发 →\n  - front: 请数出数字 2（计数序列的一部分）。只输出数字 2，不要任何额外文字。"),
    entry("assistant", "front 回了 2，继续。"),
    entry("tool", "team_dispatch 派发 →\n  - back: 复核 front 的 2 是否正确。"),
    entry("assistant", "back 确认无误，本轮结束。"),
  ];
  if (extraDispatch) {
    leader.push(
      entry("tool", "team_dispatch 派发 →\n  - front: 请数出数字 4（计数序列的一部分）。只输出数字 4，不要任何额外文字。"),
      entry("assistant", "front 回了 4，序列 1,2,3,4 连续。"),
    );
  }
  return {
    team: "count-duet",
    runId: "run-1788938207941",
    runStatus: "running",
    elapsed: `${elapsedSec}s`,
    actors: [
      { actor: "_leader", label: "leader", status: "running", model: "opencode-go/deepseek-v4-flash" },
      { actor: "front", label: "front", status: "done", model: "chatanywhere/gpt-5.6" },
      { actor: "back", label: "back", status: "running", model: "anthropic/claude-sonnet-4-5" },
    ],
    entries: new Map([
      ["_leader", leader],
      ["front", [entry("task", "数出数字 2"), entry("assistant", "2"), entry("tool", "read count.txt → 2")]],
      ["back", [entry("task", "复核 front 的 2"), entry("assistant", "核对通过：2 在 1..10 内且为偶数。")]],
    ]),
    runs: VIEWER_RUNS,
  };
}

// 主屏背景文本：overlay 只覆盖中间 95% 宽、85% 高，边缘会露出主屏内容。
// 因此每行留出左右边距（前 3 列 + 行尾不超出 overlay 右缘），避免出现被
// 覆盖一半的字符碎片——那是合成残影，不是真机观感。
const BASE_PAD = "     "; // overlay 左缘在 col 3：主屏文本缩进 ≥4 列才不会露出被覆盖一半的字符
const BASE_LINES = [
  `${BASE_PAD}${fgStyle(DARK.accent)("⏺")} 用 count-duet 团队从 1 数到 10：leader 数奇数，front 数偶数`,
  "",
  `${BASE_PAD}${fgStyle(DARK.dim)("leader turn 7 …")}`,
  ...["team_dispatch 派发 → front 数出数字 2", "front 回了 2", "team_dispatch 派发 → back 复核"].map(
    (line) => `${BASE_PAD}${fgStyle(DARK.dim)("⏵ ")}${line}`,
  ),
];

/**
 * 跑一个场景：真实组件 + 真实合成路径，返回网格屏与文本屏。
 * 全程同步 renderNow（确定性，不依赖内部定时器）。
 */
export function captureViewerScene({ cols = 150, rows = 40 } = {}) {
  const screen = new VtScreen(cols, rows);
  const term = {
    columns: cols,
    rows,
    write: (data) => screen.feed(data),
    hideCursor: () => {},
    showCursor: () => {},
  };
  const tui = new TuiMainScreen(term);
  const baseLines = [...BASE_LINES];
  const base = { render: () => [...baseLines], handleInput: () => {}, invalidate: () => {} };
  tui.addChild(base);

  let elapsedSec = 41;
  let extra = false;
  const viewer = new TranscriptViewer({
    load: () => countDuet(elapsedSec, extra),
    done: () => {},
    styles: ansiStyles(),
    rows: () => term.rows,
    refreshMs: 3600_000, // 定时器不参与：帧由 renderNow 精确驱动
  });
  tui.showOverlay(viewer, VIEWER_OVERLAY_OPTIONS);
  tui.renderNow();
  for (let tick = 1; tick <= 5; tick++) {
    elapsedSec += 1;
    if (tick === 3) extra = true; // 第 3 跳第二个派单落地
    baseLines.push(`${BASE_PAD}${fgStyle(DARK.dim)("leader turn " + (7 + tick) + " …")}`);
    tui.renderNow();
  }
  try {
    return { grid: screen.grid(), lines: screen.text(), cols, rows };
  } finally {
    tui.dispose?.();
  }
}

/** 帧自检：锚点缺失说明真实渲染路径变了，截图不可信——工具必须响亮地失败。 */
export function assertFrame(lines) {
  const text = lines.join("\n");
  const anchors = ["agent-team viewer", "count-duet", "· _leader", "· front", "· back", "模型:", "[/] 切 run"];
  const missing = anchors.filter((a) => !text.includes(a));
  if (missing.length > 0) throw new Error(`截图自检失败，缺少锚点: ${missing.join(", ")}`);
  const titles = lines.filter((l) => l.includes("agent-team viewer")).length;
  if (titles !== 1) throw new Error(`overlay 帧标题应恰好 1 行，实得 ${titles}`);
  return true;
}

// ---------------------------------------------------------------------------
// Scene: pwr run viewer (/workflow:view) over the same real host stack
// ---------------------------------------------------------------------------

/**
 * 示例 run 数据：冒烟脚本 nightly-audit（准备 → 扫描 fan-out → 汇总），
 * 第二个 stage 运行中、带实时 trace 行；三个 stage 都已建 roster 条目。
 * 与 pwr 真机结构同形（run 元信息 + plan tree + agents + 事件尾巴）。
 */
function pwrDetail(elapsedSec) {
  const stages = [
    { stageId: "prepare", label: "准备", kind: "agent", status: "completed", agentCount: 1 },
    { stageId: "scan", label: "扫描模块", kind: "parallel", status: "running", agentCount: 3, dynamic: true },
    { stageId: "summarize", label: "汇总", kind: "agent", status: "queued", agentCount: 1 },
  ];
  const agents = [
    {
      taskId: "prepare-task-0000-0000-000000000000",
      stageId: "prepare",
      label: "收集改动清单",
      status: "completed",
      attempt: 1,
      tokens: 12_400,
      cost: 0.0081,
      elapsedMs: 9_400,
      resultSummary: "改动文件 14 个，待审模块 3 个",
      recentEvents: [],
    },
    {
      taskId: "scan-task-0000-0000-000000000001",
      stageId: "scan",
      label: "审计 agent-team",
      status: "running",
      attempt: 1,
      tokens: 8_900,
      elapsedMs: 12_600,
      recentEvents: ["▶ read agent-team/widget.ts", "… 正在比对状态条刷新路径"],
    },
    {
      taskId: "scan-task-0000-0000-000000000002",
      stageId: "scan",
      label: "审计 pwr",
      status: "running",
      attempt: 1,
      tokens: 5_300,
      elapsedMs: 11_100,
      recentEvents: ["▶ bash: npm test", "… 等待测试输出"],
    },
    { taskId: "scan-task-0000-0000-000000000003",
      stageId: "scan",
      label: "审计 loop",
      status: "queued",
      attempt: 1,
      recentEvents: [],
    },
  ];
  return {
    runId: "9f1e7c40-2b5a-4d18-9a33-77c1e0f2ab44",
    scriptId: "wf-nightly-audit",
    scriptName: "nightly-audit",
    status: "running",
    digest: "3ac1f0d2e59b7788",
    createdAt: "2026-09-11T08:40:02Z",
    startedAt: "2026-09-11T08:40:03Z",
    plan: {
      stages: stages.map((s) => ({
        stageId: s.stageId,
        label: s.label,
        kind: s.kind,
        agentCount: s.agentCount,
        writeRisk: false,
      })),
      budget: {
        agentCalls: 5,
        pipelineCalls: 0,
        parallelCalls: 1,
        estimatedAgents: 5,
        writeRisk: false,
        warnLargeRun: false,
      },
      tree: stages.map((s) => ({
        label: s.label,
        kind: s.kind,
        agentCount: s.agentCount,
        writeRisk: false,
        stageId: s.stageId,
      })),
    },
    stages,
    agents,
    totalTokens: 26_600,
    totalCost: 0.0174,
    elapsedMs: elapsedSec * 1_000,
    warnings: [],
  };
}

/**
 * 跑 pwr 场景：真实 `RunViewer`（默认选中「结构」条目）+ 真实 `TuiMainScreen`
 * 合成路径，与 agent-team 场景共用同一 VT/SVG 管线。
 */
export function capturePwrViewerScene({ cols = 150, rows = 40 } = {}) {
  const screen = new VtScreen(cols, rows);
  const term = {
    columns: cols,
    rows,
    write: (data) => screen.feed(data),
    hideCursor: () => {},
    showCursor: () => {},
  };
  const tui = new TuiMainScreen(term);
  const baseLines = [
    `${BASE_PAD}${fgStyle(DARK.accent)("⏺")} /workflow:view nightly-audit`,
    "",
    `${BASE_PAD}${fgStyle(DARK.dim)("run 9f1e7c40 · stage scan 进行中…")}`,
  ];
  const base = { render: () => [...baseLines], handleInput: () => {}, invalidate: () => {} };
  tui.addChild(base);

  let elapsedSec = 34;
  const runId = pwrDetail(elapsedSec).runId;
  const runs = [
    { runId, scriptName: "nightly-audit", status: "running" },
    { runId: "5c2a88b1-0f3d-4e77-b1aa-93d4e6f7c201", scriptName: "doc-sync", status: "completed" },
  ];
  const viewer = new RunViewer({
    load: () => assembleViewerData(pwrDetail(elapsedSec), "await parallel(['agent-team', 'pwr', 'loop'])", runs),
    initialRunId: runId,
    done: () => {},
    styles: ansiStyles(),
    rows: () => term.rows,
    refreshMs: 3600_000, // 定时器不参与：帧由 renderNow 精确驱动
  });
  tui.showOverlay(viewer, PWR_VIEWER_OVERLAY_OPTIONS);
  tui.renderNow();
  for (let tick = 1; tick <= 4; tick++) {
    elapsedSec += 1;
    baseLines.push(`${BASE_PAD}${fgStyle(DARK.dim)("stage scan · agent 输出片段 " + tick)}`);
    tui.renderNow();
  }
  try {
    return { grid: screen.grid(), lines: screen.text(), cols, rows };
  } finally {
    viewer.dispose?.();
    tui.dispose?.();
  }
}

/** pwr 帧自检：标题/脚本名/结构页锚点缺一即失败。 */
export function assertPwrFrame(lines) {
  const text = lines.join("\n");
  const anchors = ["PWR viewer", "nightly-audit", "脚本结构", "准备", "扫描模块", "汇总", "State:"];
  const missing = anchors.filter((a) => !text.includes(a));
  if (missing.length > 0) throw new Error(`截图自检失败，缺少锚点: ${missing.join(", ")}`);
  const titles = lines.filter((l) => l.includes("PWR viewer")).length;
  if (titles !== 1) throw new Error(`overlay 帧标题应恰好 1 行，实得 ${titles}`);
  return true;
}

// ---------------------------------------------------------------------------
// Scene: agent-team run widget (belowEditor block) over the real host stack
// ---------------------------------------------------------------------------

// 固定时钟：elapsed 标签确定，截图可 diff。
const WIDGET_NOW_MS = Date.parse("2026-09-11T09:12:45.000Z");

/** 示例 run：count-duet（与查看器场景同团队）——leader 行选中，front 完成、back 运行中。 */
function widgetSnapshot(nowMs) {
  return {
    running: true,
    actives: [
      {
        runId: "run-1788938207941",
        team: "count-duet",
        task: "用 count-duet 团队从 1 数到 10；leader 数奇数，front 数偶数。",
        startedAtMs: nowMs - 41_000,
        leaderModel: "opencode-go/deepseek-v4-flash",
        members: [
          { name: "front", status: "done", note: "已数 2" },
          { name: "back", status: "running", latest: "复核 front 的 2" },
        ],
      },
    ],
    records: [],
    lastRecord: null,
    progress: null,
  };
}

/** 双 run 快照（v1.22.0 截图）：单 main 根 + 每 run 一棵 leader 子树。 */
function widgetMultiSnapshot(nowMs) {
  const older = widgetSnapshot(nowMs).actives[0];
  const newer = {
    runId: "run-1788938207942",
    team: "nightly-audit",
    task: "审计 agent-team 与 pwr 的夜间回归。",
    startedAtMs: nowMs - 12_000,
    members: [
      { name: "audit", status: "running", latest: "扫描 widget.ts" },
      { name: "report", status: "queued" },
    ],
  };
  return { running: true, actives: [older, newer], records: [], progress: newer, lastRecord: null };
}

// 编辑器上方的主屏背景（同查看器场景的示意文本）。
const WIDGET_BASE_LINES = [
  `${BASE_PAD}${fgStyle(DARK.accent)("⏺")} back 确认无误，序列 1,2,3,4 连续。`,
  "",
  `${BASE_PAD}${fgStyle(DARK.dim)("leader turn 12 · 等待 back 复核结果…")}`,
];

/**
 * 跑 widget 场景：widget 内容完全来自真实 `buildWidgetView` + `renderWidgetView`
 * （即 controller 经 `setWidget` 推送的同一份 string[]，选中态/高亮/截断一致）；
 * 真实 `Editor`（宿主 CustomEditor 的基类）在 widget 上方；widget 的屏上包装
 * 照抄宿主 `setExtensionWidget` 对 string[] 的确切代码路径
 * （Container + Text(line, 1, 0)，见 interactive-mode setExtensionWidget）。
 * 空编辑器是真实语义：bare ↓/← 只在编辑器为空时激活 widget——截图即该状态。
 * `selected: false` 渲染折叠单行（默认 true = 展开态 leader 行选中）。
 */
export function captureWidgetScene({ cols = 120, rows = 12, selected = true, multiRun = false } = {}) {
  const screen = new VtScreen(cols, rows);
  const term = { columns: cols, rows, write: (data) => screen.feed(data), hideCursor: () => {}, showCursor: () => {} };
  const tui = new TuiMainScreen(term);
  const styles = ansiStyles();
  const root = new Container();
  for (const line of WIDGET_BASE_LINES) root.addChild(new Text(line, 0, 0));
  root.addChild(new Spacer(1));
  root.addChild(new Editor(tui, { borderColor: styles.border, selectList: {} }, {}));
  const view = buildWidgetView(multiRun ? widgetMultiSnapshot(WIDGET_NOW_MS) : widgetSnapshot(WIDGET_NOW_MS), WIDGET_NOW_MS);
  const lines = renderWidgetView(view, selected ? { selected: true, cursor: 1 } : { selected: false, cursor: 0 }, cols, styles);
  const widget = new Container();
  for (const line of lines.slice(0, 10)) widget.addChild(new Text(line, 1, 0));
  root.addChild(widget);
  tui.addChild(root);
  tui.renderNow();
  try {
    return { grid: screen.grid(), lines: screen.text(), cols, rows };
  } finally {
    tui.dispose?.();
  }
}

/** widget 帧自检：展开态树（main/leader/成员）+ 提示行缺一即失败；multiRun 时另锁第二棵子树。 */
export function assertWidgetFrame(lines, { multiRun = false } = {}) {
  const text = lines.join("\n");
  const anchors = ["main", "▸ leader count-duet", "├─ front", "╰─ back", "↑↓ 选择 · enter 查看 · esc 退出"];
  if (multiRun) anchors.push("leader nightly-audit", "├─ audit", "╰─ report");
  const missing = anchors.filter((a) => !text.includes(a));
  if (missing.length > 0) throw new Error(`截图自检失败，缺少锚点: ${missing.join(", ")}`);
  const selectedRows = lines.filter((l) => l.includes("▸ leader count-duet")).length;
  if (selectedRows !== 1) throw new Error(`选中行应恰好 1 行，实得 ${selectedRows}`);
  return true;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

export function capture() {
  const scene = captureViewerScene();
  assertFrame(scene.lines);
  return { name: "agent-team-viewer.svg", svg: svgFromGrid(scene.grid) };
}

function capturePwr() {
  const scene = capturePwrViewerScene();
  assertPwrFrame(scene.lines);
  return { name: "pwr-viewer.svg", svg: svgFromGrid(scene.grid) };
}

function captureWidget() {
  // 文档截图展示多 run 树（v1.22.0；单 run 场景零回归由 capture-screens.test.ts 锁定）。
  const scene = captureWidgetScene({ multiRun: true, rows: 16 });
  assertWidgetFrame(scene.lines, { multiRun: true });
  return { name: "agent-team-widget.svg", svg: svgFromGrid(scene.grid) };
}

/** 全部文档截图（同一管线；CLI 与测试共用）。 */
export function captureAll() {
  return [capture(), capturePwr(), captureWidget()];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const outDir = path.resolve(process.argv[2] ?? path.join(ROOT, "docs", "assets"));
  fs.mkdirSync(outDir, { recursive: true });
  for (const { name, svg } of captureAll()) {
    fs.writeFileSync(path.join(outDir, name), svg, "utf8");
    console.log(`✓ docs/assets/${name}（${svg.split("\n").length} 行 SVG）`);
  }
}
