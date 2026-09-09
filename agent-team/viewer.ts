/**
 * agent-team — split-pane run transcript viewer (fleet inspector layout)
 *
 * Renders the run as one bordered two-pane frame, copied structurally from
 * pi-subagents' fleet inspector (v0.66.0 `fleet.ts:1319-1381`, see
 * docs/tui-sync.md §4): a left member roster (selection marker + status
 * glyph + right-aligned status, windowed scrolling) and a right detail pane
 * (fixed Run/State/成员 meta header + the selected member's full transcript
 * — a continuous chronological flow like the main agent's own conversation
 * view, not per-message timestamp blocks). A key-legend row sits above the
 * bottom border.
 *
 * The frame is a complete box sized from the live terminal height (fleet's
 * 85%−6 formula), so it reads as a clearly separated surface over the main
 * agent UI. Assistant text is rendered with the same Markdown component +
 * theme the host uses for its own messages.
 *
 * All rendering and key handling is pure and unit-tested without pi-tui;
 * styling, Markdown, and terminal dimensions are injected ports.
 * `TranscriptViewer` is the thin host component and `openTranscriptViewer`
 * the thin host opener.
 */

import { Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type OverlayOptions } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type TranscriptEntry } from "./transcript.ts";
import { VIEWER_HEIGHT_JITTER_ROWS, VIEWER_TICK_MS } from "./types.ts";

// ---------------------------------------------------------------------------
// Style port (identity in tests; theme-backed in the host)
// ---------------------------------------------------------------------------

/** Style functions used by the pure renderer. */
export interface Styles {
  dim: (text: string) => string;
  border: (text: string) => string;
  accent: (text: string) => string;
  success: (text: string) => string;
  error: (text: string) => string;
  warning: (text: string) => string;
  /** User-message bubble background (task entries). */
  bubble: (text: string) => string;
  /** Bold (fleet uses it for the selected roster label + header keys). */
  bold: (text: string) => string;
}

/** Unstyled port (tests). */
export function plainStyles(): Styles {
  const identity = (text: string): string => text;
  return {
    dim: identity,
    border: identity,
    accent: identity,
    success: identity,
    error: identity,
    warning: identity,
    bubble: identity,
    bold: identity,
  };
}

/** Theme-backed port (host). All lookups are exception-isolated. */
export function themeStyles(theme: Theme): Styles {
  const fg = (color: Parameters<Theme["fg"]>[0]) => (text: string): string => {
    try {
      return theme.fg(color, text);
    } catch {
      return text;
    }
  };
  return {
    dim: fg("dim"),
    border: fg("border"),
    accent: fg("accent"),
    success: fg("success"),
    error: fg("error"),
    warning: fg("warning"),
    bold: (text: string): string => {
      try {
        return theme.bold(text);
      } catch {
        return text;
      }
    },
    bubble: (text: string): string => {
      try {
        return theme.bg("userMessageBg", text);
      } catch {
        return text;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/** One selectable transcript source in the viewer. */
export interface ViewerActor {
  /** Actor id used by transcript artifacts (e.g. `_leader`, `frontend`). */
  actor: string;
  /** Display label (original member name; leader shown as "leader"). */
  label: string;
  /** Latest known run status (queued/running/done/failed/aborted/…). */
  status?: string;
}

/** Everything the viewer needs to render one frame (reloaded on refresh). */
export interface ViewerData {
  team: string;
  runId: string;
  runStatus: string;
  /** Elapsed label for running runs (e.g. "1m12s"); absent when finished. */
  elapsed?: string;
  actors: ViewerActor[];
  /** Transcript entries per actor id. */
  entries: Map<string, TranscriptEntry[]>;
}

/** Interactive viewer state. */
export type NoticeKind = "success" | "warning" | "error";

export interface ViewerState {
  actorIndex: number;
  /**
   * Selected transcript actor id (e.g. `_leader`, `frontend`). Kept
   * alongside `actorIndex` so the selection survives actor-list changes
   * (new transcript files after a dispatch); the index is re-resolved
   * from this id on every refresh. Absent = follow the index.
   */
  actor?: string;
  /** Row offset into the rendered transcript body (0 = top). */
  scroll: number;
  /** Stick to the bottom while new rows arrive. */
  follow: boolean;
  /** Include tool call rows in the body. */
  showTools: boolean;
  /**
   * Two-step stop confirmation armed (D on a running run). Mirrors
   * fleet's `stopConfirming` — confirm with Enter/Y, cancel with
   * N/Esc/ctrl+c/backspace (cancel never closes the viewer).
   */
  stopConfirming: boolean;
  /** A stop request is in flight (busy banner; repeated confirms ignored). */
  stopping?: boolean;
  /**
   * Top banner notice (D-on-finished hint / stop result). Held as render
   * state; the next keypress replaces or clears it. Mutually exclusive
   * with the busy/confirm banners (busy > confirm > notice, like fleet).
   */
  notice?: { text: string; kind: NoticeKind };
}

export function initialViewerState(): ViewerState {
  return { actorIndex: 0, scroll: 0, follow: true, showTools: true, stopConfirming: false };
}

type StatusStyle = "dim" | "accent" | "success" | "error" | "warning";

function statusDisplay(status: string | undefined): { icon: string; style: StatusStyle } {
  switch (status) {
    case "running":
      return { icon: "▶", style: "accent" };
    case "done":
    case "completed":
      return { icon: "✓", style: "success" };
    case "failed":
      return { icon: "✗", style: "error" };
    case "aborted":
      return { icon: "⊘", style: "warning" };
    case "queued":
      return { icon: "…", style: "dim" };
    default:
      return { icon: "·", style: "dim" };
  }
}

function applyStyle(styles: Styles, name: StatusStyle, text: string): string {
  return styles[name](text);
}

// ---------------------------------------------------------------------------
// Width helpers (ANSI- and CJK-aware)
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Display width of one character (East Asian wide = 2, else 1). */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Word-less greedy wrap that counts CJK characters as width 2. */
export function wrapText(text: string, width: number): string[] {
  if (width < 1) return text.split("\n");
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const ch of paragraph) {
      const w = charWidth(ch);
      if (lineWidth + w > width && line.length > 0) {
        out.push(line);
        line = "";
        lineWidth = 0;
      }
      line += ch;
      lineWidth += w;
    }
    out.push(line);
  }
  return out.length > 0 ? out : [""];
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Display width ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch);
  return width;
}

/** Pads a (possibly styled) line with trailing spaces to the display width. */
export function padLine(line: string, width: number): string {
  const pad = width - visibleWidth(line);
  return pad > 0 ? line + " ".repeat(pad) : line;
}

/** Truncates plain text to the display width with an ellipsis (chrome lines). */
export function truncateVisible(text: string, width: number): string {
  if (width < 1) return "";
  let out = "";
  let lineWidth = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (lineWidth + w > width - 1) return `${out}…`;
    out += ch;
    lineWidth += w;
  }
  return out;
}

function timestampOf(entry: TranscriptEntry): string {
  return entry.ts.length >= 19 ? entry.ts.slice(11, 19) : "";
}

// ---------------------------------------------------------------------------
// Block model: continuous chat flow, not per-message segments
// ---------------------------------------------------------------------------

type Block =
  | { kind: "task"; text: string }
  | { kind: "assistant"; text: string; ts: string }
  | { kind: "tools"; lines: string[] }
  | { kind: "error"; text: string; ts: string }
  | { kind: "system"; text: string; ts: string };

/** Old artifacts baked ▶/✓ icons into tool text; strip them for uniform styling. */
function stripLegacyToolPrefix(text: string): string {
  return text.replace(/^[▶✓\s]+/, "");
}

/**
 * Groups entries into continuous blocks: consecutive tool rows merge into
 * one block, every assistant message is its own block, task/error/system
 * stand alone. The renderer separates blocks with a single blank line —
 * one chronological flow per agent page.
 */
export function buildBlocks(entries: TranscriptEntry[], showTools: boolean): Block[] {
  const blocks: Block[] = [];
  for (const entry of entries) {
    if (entry.kind === "tool") {
      if (!showTools) continue;
      const line = stripLegacyToolPrefix(entry.text);
      if (line.length === 0) continue;
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools") last.lines.push(line);
      else blocks.push({ kind: "tools", lines: [line] });
      continue;
    }
    if (entry.kind === "assistant") {
      blocks.push({ kind: "assistant", text: entry.text, ts: timestampOf(entry) });
    } else if (entry.kind === "task") {
      blocks.push({ kind: "task", text: entry.text });
    } else if (entry.kind === "error") {
      blocks.push({ kind: "error", text: entry.text, ts: timestampOf(entry) });
    } else if (entry.kind === "system") {
      blocks.push({ kind: "system", text: entry.text, ts: timestampOf(entry) });
    }
  }
  return blocks;
}

/** Renders one block to display lines (already width-fitted). */
export function blockLines(
  block: Block,
  width: number,
  styles: Styles,
  renderMarkdown?: (text: string, width: number) => string[],
): string[] {
  switch (block.kind) {
    case "task": {
      const wrapped = wrapText(block.text, width - 2);
      return wrapped.map((line, i) => styles.bubble(padLine(i === 0 ? `❯ ${line}` : `  ${line}`, width)));
    }
    case "assistant": {
      const label = styles.dim(`▸ assistant${block.ts ? ` · ${block.ts}` : ""}`);
      // Host Markdown output is trusted to be readable but not strictly
      // width-bounded — rewrap each line so nothing exceeds the pane.
      const body = renderMarkdown
        ? renderMarkdown(block.text, width - 2).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)))
        : wrapText(block.text, width);
      return [label, ...body];
    }
    case "tools":
      return block.lines.map((line) => styles.dim(`· ${truncateVisible(line, width - 2)}`));
    case "error":
      return wrapText(`✗ ${block.text}`, width).map((line) => styles.error(line));
    case "system":
      return wrapText(`ℹ ${block.text}`, width).map((line) => styles.dim(line));
  }
}

/** All body lines for one actor (block-separated continuous flow). */
export function bodyLines(
  entries: TranscriptEntry[],
  showTools: boolean,
  width: number,
  styles: Styles,
  renderMarkdown?: (text: string, width: number) => string[],
): string[] {
  const blocks = buildBlocks(entries, showTools);
  const lines: string[] = [];
  for (const block of blocks) {
    if (lines.length > 0) lines.push("");
    lines.push(...blockLines(block, width, styles, renderMarkdown));
  }
  if (lines.length === 0) {
    lines.push(styles.dim("（暂无记录，等待子进程事件…）"));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Split frame (fleet inspector layout: roster left, detail right)
// ---------------------------------------------------------------------------

/**
 * Chrome rows of the frame: top border + title row + upper separator +
 * lower separator + legend row + bottom border (fleet.ts:1343-1370; spec
 * §4). "Frame total = bodyHeight + VIEWER_CHROME_ROWS" stays invariant.
 */
export const VIEWER_CHROME_ROWS = 6;

/**
 * Action key sets aligned with pi-subagents' `DEFAULT_FLEET_KEYBINDINGS`
 * (v0.66.0 `fleet.ts:43/46`, spec table §4): `stop: ["D"]`, `refresh:
 * ["r", "R"]`. Locked by test/tui-sync.test.ts.
 */
export const VIEWER_ACTION_KEYS = {
  stop: ["D"],
  refresh: ["r", "R"],
} as const;

/** Key legend for the bottom border (kept in sync with VIEWER_ACTION_KEYS). */
export const VIEWER_LEGEND = "↑↓ 滚动 · ←→/1-9 成员 · g/G 首末 · x 工具行 · D 停止 · r 刷新 · q 关闭";

/**
 * Frame body height for a terminal with `rows` rows: fleet's formula
 * `max(2, floor(rows * 0.85) - 6)` (fleet.ts:1326-1327; spec §4). Invalid
 * rows fall back to fleet's default terminal height of 32.
 */
export function computeFrameHeight(rows: number): number {
  const safe = Number.isFinite(rows) && rows > 0 ? rows : 32;
  return Math.max(2, Math.floor(safe * 0.85) - 6);
}

/**
 * Split-pane geometry, verbatim from fleet.ts:1322-1329 (spec §4): the two
 * `│` borders take 2 columns total, the roster takes 22..46 columns (38%
 * of the rest), and the detail pane gets whatever remains (≥ 1).
 */
export function computeViewerLayout(width: number): { innerWidth: number; rosterWidth: number; detailWidth: number } {
  const innerWidth = Math.max(0, width - 2);
  const rosterWidth = Math.max(22, Math.min(46, Math.floor((innerWidth - 1) * 0.38)));
  const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
  return { innerWidth, rosterWidth, detailWidth };
}

/** fleet's `rightAligned` (fleet.ts:754): left + gap + right, exact width. */
function rightAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fitLine(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fitLine(right, rightWidth);
}

function selectedActor(data: ViewerData, state: ViewerState): { actor: ViewerActor; index: number } | undefined {
  const index = Math.min(Math.max(0, state.actorIndex), Math.max(0, data.actors.length - 1));
  const actor = data.actors[index];
  return actor ? { actor, index } : undefined;
}

/**
 * Left-pane member roster, fleet's `rosterLines` (fleet.ts:1217-1229)
 * adapted to the agent-team actor list: `<marker> <status icon> <label>
 * · <actorId>` with the status text right-aligned, selected row marker
 * `›` (accent) + bold label. The window follows the selection so it never
 * scrolls out of view (fleet's start-clamp formula, fleet.ts:1219). Actor
 * order is the stable one from buildViewerData (leader first, then by id).
 */
function rosterLines(data: ViewerData, state: ViewerState, width: number, bodyHeight: number, styles: Styles): string[] {
  if (data.actors.length === 0) return [styles.dim("（无成员）")];
  const selected = Math.min(Math.max(0, state.actorIndex), data.actors.length - 1);
  const start = Math.max(0, Math.min(selected - bodyHeight + 1, Math.max(0, data.actors.length - bodyHeight)));
  const rows: string[] = [];
  for (let index = start; index < Math.min(data.actors.length, start + bodyHeight); index++) {
    const actor = data.actors[index];
    if (!actor) continue;
    const { icon, style } = statusDisplay(actor.status);
    const isSelected = index === selected;
    const marker = isSelected ? styles.accent("›") : " ";
    const label = isSelected ? styles.bold(actor.label) : actor.label;
    const left = `${marker} ${applyStyle(styles, style, icon)} ${label} ${styles.dim(`· ${actor.actor}`)}`;
    rows.push(rightAligned(left, styles.dim(actor.status ?? "unknown"), width));
  }
  return rows;
}

/**
 * Fixed detail-pane meta header (the agent-team counterpart of fleet's
 * `structuredHeader`, minimal three lines per the spec): Run / State /
 * 成员. Key names bold like fleet's `^(Run|State|…):` rule; the header
 * never scrolls with the transcript.
 */
function detailHeaderLines(data: ViewerData, state: ViewerState, styles: Styles): string[] {
  const selected = selectedActor(data, state);
  const member = selected
    ? `${selected.actor.label}（${selected.actor.status ?? "unknown"}）· ${selected.index + 1}/${data.actors.length}`
    : "（无成员）";
  return [
    `${styles.bold("Run:")} ${data.runId || "(no run)"}`,
    `${styles.bold("State:")} ${data.runStatus}`,
    `${styles.bold("成员:")} ${member}`,
  ];
}

function titleRow(data: ViewerData, state: ViewerState, innerWidth: number, styles: Styles): string {
  // 标题刻意保持静态（对标 fleet 检查器的静态标题行）：真机截图实锤——
  // 每秒跳动的 `elapsed` 时钟行就是纵向堆叠物本身（53s/54s、1m26s/1m27s
  // 标题并存）。存活秒表只放在输入栏下方的 widget 里（宿主渲染的纯字符
  // 串表面，已证明稳定），绝不放进这个 overlay——chrome 区零每秒文本。
  const title = ` agent-team viewer · team ${data.team}`;
  const selected = selectedActor(data, state);
  const right = selected
    ? `${applyStyle(styles, statusDisplay(selected.actor.status).style, statusDisplay(selected.actor.status).icon)} ${selected.actor.label} · ${selected.actor.status ?? "unknown"} `
    : `${styles.dim("无成员")} `;
  return styles.border("│") + rightAligned(title, right, innerWidth) + styles.border("│");
}

function legendRow(data: ViewerData, state: ViewerState, styles: Styles): string {
  const count = data.actors.length;
  const position = count > 0 ? `成员 ${Math.min(state.actorIndex + 1, count)}/${count}` : "";
  const text = position ? `${VIEWER_LEGEND} · ${position}` : VIEWER_LEGEND;
  return styles.dim(text);
}

/**
 * ANSI/CJK-aware clamp to an exact display width: truncate (ellipsis) then
 * pad with spaces. Mirrors pi-subagents' fleet inspector `fit()` — every
 * frame line is exactly `width` columns, so nothing bleeds past the border
 * and the diff renderer sees stable line widths.
 */
export function fitLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * Action banner/notice lines for the top of the body window (fleet's
 * `actionLines` counterpart, priority busy > confirm > notice). Pure:
 * derived entirely from the viewer state, mutually exclusive display.
 */
export function actionLines(data: ViewerData, state: ViewerState, styles: Styles): string[] {
  if (state.stopping) return [styles.accent("停止中…")];
  if (state.stopConfirming) {
    return [
      styles.warning(`确认停止 run ${data.runId || "(no run)"}？`),
      styles.dim("停止会中止 leader 与所有成员子进程。Enter/Y 确认 · N 取消 · Esc 取消"),
    ];
  }
  if (state.notice) {
    const style = state.notice.kind === "error" ? styles.error : state.notice.kind === "warning" ? styles.warning : styles.success;
    return [style(state.notice.text)];
  }
  return [];
}

/**
 * Detail-pane transcript viewport height: bodyHeight minus the fixed
 * header rows and any action lines (≥ 1). Action lines wrap to the detail
 * width, so their row count depends on it. The component clamps scroll
 * and feeds key handling with this so paging matches what is visible.
 */
export function viewerViewportHeight(data: ViewerData, state: ViewerState, width: number, bodyHeight: number, styles: Styles): number {
  const header = detailHeaderLines(data, state, styles).slice(0, Math.max(0, bodyHeight - 1));
  const actions = wrappedActions(data, state, computeViewerLayout(width).detailWidth, styles);
  return Math.max(1, bodyHeight - header.length - actions.length);
}

/** Action lines wrapped to the detail width (fleet wraps detail lines too). */
function wrappedActions(data: ViewerData, state: ViewerState, detailWidth: number, styles: Styles): string[] {
  return actionLines(data, state, styles).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, detailWidth)));
}

/**
 * Renders the fleet-style split frame (fleet.ts:1343-1370): plain top
 * border, static title row with the selected actor's status right-aligned,
 * `│roster│detail│` body rows, and the key legend above the plain bottom
 * border. The detail pane = fixed meta header + action lines (stop
 * banner/notice) + the scrollable transcript window — the frame always
 * returns exactly `bodyHeight + VIEWER_CHROME_ROWS` lines. Terminals
 * narrower than 36 columns get a single hint line (fleet's minimum-width
 * gate, fleet.ts:1321; spec §4).
 */
export function renderViewerFrame(
  data: ViewerData,
  state: ViewerState,
  width: number,
  opts: {
    styles: Styles;
    bodyHeight: number;
    renderMarkdown?: (text: string, width: number) => string[];
  },
): string[] {
  if (width < 36) return [truncateToWidth("agent-team viewer 至少需要 36 列。Esc 关闭。", width)];
  const styles = opts.styles;
  const { innerWidth, rosterWidth, detailWidth } = computeViewerLayout(width);
  const bodyHeight = opts.bodyHeight;

  const roster = rosterLines(data, state, rosterWidth, bodyHeight, styles);
  const actor = data.actors[state.actorIndex];
  const entries = actor ? (data.entries.get(actor.actor) ?? []) : [];
  const body = bodyLines(entries, state.showTools, detailWidth, styles, opts.renderMarkdown);
  const header = detailHeaderLines(data, state, styles).slice(0, Math.max(0, bodyHeight - 1));
  const actions = wrappedActions(data, state, detailWidth, styles);
  const effective = Math.max(1, bodyHeight - header.length - actions.length);
  const clamped = clampViewerState(state, body.length, effective);
  const window = body.slice(clamped.scroll, clamped.scroll + effective);
  while (window.length < effective) window.push("");
  const detail = [...header, ...actions, ...window];

  const lines = [
    styles.border(`╭${"─".repeat(innerWidth)}╮`),
    titleRow(data, state, innerWidth, styles),
    styles.border(`├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`),
  ];
  for (let index = 0; index < bodyHeight; index++) {
    const rosterLine = roster[index] ?? "";
    const detailLine = detail[index] ?? "";
    lines.push(
      styles.border("│") +
        fitLine(rosterLine, rosterWidth) +
        styles.border("│") +
        fitLine(detailLine, detailWidth) +
        styles.border("│"),
    );
  }
  lines.push(styles.border(`├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
  lines.push(styles.border("│") + fitLine(legendRow(data, state, styles), innerWidth) + styles.border("│"));
  lines.push(styles.border(`╰${"─".repeat(innerWidth)}╯`));
  return lines.map((line) => fitLine(line, width));
}

/** Plain-text transcript dump for the team_transcript tool (no frame). */
export function formatTranscriptText(
  data: ViewerData,
  actor: string,
  opts: { styles?: Styles; renderMarkdown?: (text: string, width: number) => string[] } = {},
): string {
  const styles = opts.styles ?? plainStyles();
  const target = data.actors.find((a) => a.actor === actor);
  if (!target) return `没有 "${actor}" 的会话记录。`;
  const entries = data.entries.get(target.actor) ?? [];
  const lines = [
    `## ${target.label}（${target.status ?? "unknown"}）· run ${data.runId}`,
    ...bodyLines(entries, true, 100, styles, opts.renderMarkdown),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Key handling (pure)
// ---------------------------------------------------------------------------

export interface ViewerKeyContext {
  /** Total rendered body lines for the current actor (last render). */
  totalLines: number;
  actorCount: number;
  bodyHeight: number;
  /** Transcript actor ids in roster order (pins selection by id when present). */
  actorIds?: string[];
  /** True while the current run is running (gates the D stop action). */
  runRunning?: boolean;
  /** Latest known run status (used for the D-on-finished notice copy). */
  runStatus?: string;
}

export type ViewerKeyResult =
  | { type: "update"; state: ViewerState }
  | { type: "close" }
  | { type: "refresh" }
  | { type: "stop-confirm" };

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_LEFT = "\x1b[D";
const KEY_RIGHT = "\x1b[C";
const KEY_PGUP = "\x1b[5~";
const KEY_PGDN = "\x1b[6~";
const KEY_HOME = "\x1b[H";
const KEY_END = "\x1b[F";

/**
 * Pure key reducer. Unrecognized keys leave the state unchanged (still an
 * update) so the component ignores them; `q`/Esc request close.
 *
 * 停止/刷新动作键位对齐 fleet `DEFAULT_FLEET_KEYBINDINGS`（v0.66.0，
 * `stop: ["D"]`、`refresh: ["r", "R"]`，规格表 §4）。确认态按键集对齐
 * fleet.ts:1134-1150：Enter/Y 确认、Esc/ctrl+c/N/backspace 取消（取消不关
 * 闭查看器）、其余键忽略。
 */
export function handleViewerKey(state: ViewerState, data: string, ctx: ViewerKeyContext): ViewerKeyResult {
  if (state.stopConfirming) {
    if (matchesKey(data, "enter") || data === "y" || data === "Y") {
      return { type: "stop-confirm" };
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "n" || data === "N" || matchesKey(data, "backspace")) {
      return { type: "update", state: { ...state, stopConfirming: false } };
    }
    return { type: "update", state }; // 确认态下其余键一律忽略
  }

  const bottom = Math.max(0, ctx.totalLines - ctx.bodyHeight);
  const next: ViewerState = { ...state };
  const switchActor = (index: number): void => {
    next.actorIndex = Math.min(Math.max(0, index), Math.max(0, ctx.actorCount - 1));
    if (ctx.actorIds !== undefined) {
      const id = ctx.actorIds[next.actorIndex];
      if (id !== undefined) next.actor = id;
      else delete next.actor;
    }
    next.scroll = 0;
    next.follow = true;
  };

  // close 键集对齐 fleet `close: ["escape", "ctrl+c", "q"]`（v0.66.0
  // `DEFAULT_FLEET_KEYBINDINGS`，fleet.ts:33-34；规格表 §4）。用 matchesKey
  // 判定（ctrl+c 编码契约 \x03），普通字符不受影响。
  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
    return { type: "close" };
  }

  // 停止动作：运行中 → 两步确认；已结束/无 run → error notice（不进确认态，
  // 停止回调不会被调）。
  if (data === VIEWER_ACTION_KEYS.stop[0]) {
    if (ctx.runRunning) return { type: "update", state: { ...next, stopConfirming: true } };
    return {
      type: "update",
      state: { ...next, notice: { text: `run 已结束（${ctx.runStatus ?? "unknown"}），无需停止`, kind: "error" } },
    };
  }
  if (data === VIEWER_ACTION_KEYS.refresh[0] || data === VIEWER_ACTION_KEYS.refresh[1]) {
    return { type: "refresh" };
  }

  switch (data) {
    case KEY_UP:
    case "k":
      next.follow = false;
      next.scroll = Math.max(0, (state.follow ? bottom : state.scroll) - 1);
      break;
    case KEY_DOWN:
    case "j": {
      const base = state.follow ? bottom : state.scroll;
      next.scroll = base + 1;
      if (next.scroll >= bottom) next.follow = true;
      break;
    }
    case KEY_PGUP:
      next.follow = false;
      next.scroll = Math.max(0, (state.follow ? bottom : state.scroll) - ctx.bodyHeight);
      break;
    case KEY_PGDN: {
      const base = state.follow ? bottom : state.scroll;
      next.scroll = base + ctx.bodyHeight;
      if (next.scroll >= bottom) next.follow = true;
      break;
    }
    case "g":
    case KEY_HOME:
      next.follow = false;
      next.scroll = 0;
      break;
    case "G":
    case KEY_END:
      next.follow = true;
      break;
    case KEY_LEFT:
    case "h":
      switchActor(state.actorIndex - 1);
      break;
    case KEY_RIGHT:
    case "l":
    case "\t":
      switchActor(state.actorIndex + 1);
      break;
    case "x":
      next.showTools = !state.showTools;
      break;
    default: {
      if (/^[1-9]$/.test(data)) {
        const index = Number(data) - 1;
        if (index < ctx.actorCount) switchActor(index);
      }
      break;
    }
  }
  // 普通按键清除顶部 notice（下一次交互自然滚出）。
  delete next.notice;
  return { type: "update", state: next };
}

// ---------------------------------------------------------------------------
// Host component + opener (thin; not unit-tested — repo convention)
// ---------------------------------------------------------------------------

/** Clamps scroll/follow against the current body size. */
export function clampViewerState(state: ViewerState, totalLines: number, bodyHeight: number): ViewerState {
  const maxScroll = Math.max(0, totalLines - bodyHeight);
  if (state.follow) return { ...state, scroll: maxScroll };
  return { ...state, scroll: Math.min(Math.max(0, state.scroll), maxScroll) };
}

/**
 * Resolves the selected tab from the pinned actor id. Falls back to the
 * stored index (clamped) when no id is pinned or the actor is gone —
 * pure, so actor-list growth after a dispatch never steals the selection.
 */
export function resolveActorIndex(data: ViewerData, state: ViewerState): number {
  const clamped = Math.min(Math.max(0, state.actorIndex), Math.max(0, data.actors.length - 1));
  if (state.actor === undefined) return clamped;
  const found = data.actors.findIndex((a) => a.actor === state.actor);
  return found >= 0 ? found : clamped;
}

/** State with actorIndex re-resolved from the pinned actor id (pure). */
export function withResolvedActor(data: ViewerData, state: ViewerState): ViewerState {
  if (data.actors.length === 0) return state.actorIndex === 0 ? state : { ...state, actorIndex: 0 };
  const index = resolveActorIndex(data, state);
  return index === state.actorIndex ? state : { ...state, actorIndex: index };
}

/**
 * Refresh-gate fingerprint: everything the frame shows EXCEPT the
 * wall-clock `elapsed` label. The label ticks every second while the
 * transcript is idle; repainting on it alone repaints ~1/s and — on a
 * host whose overlay repaint appends instead of replacing — stacks a new
 * title+tabs pair per tick (the reported 15s/16s/17s… ghost). Elapsed
 * still refreshes on every content-driven repaint.
 */
export function viewerDataFingerprint(data: ViewerData): string {
  const actors = data.actors.map((a) => `${a.actor}=${a.label}=${a.status ?? ""}`).join(",");
  const entries = data.actors
    .map((a) => {
      const list = data.entries.get(a.actor) ?? [];
      const last = list[list.length - 1];
      const tail = last ? `${last.kind}:${last.ts}:${last.text.slice(-64)}` : "-";
      return `${a.actor}:${list.length}:${tail}`;
    })
    .join(",");
  return `${data.team}|${data.runId}|${data.runStatus}|${actors}|${entries}`;
}

/**
 * Frame-height stabilizer: terminal-row reports that wobble within
 * `tolerance` keep the previous body height instead of resizing the
 * overlay frame (each resize is a full repaint on a trail-prone host).
 */
export function stabilizeBodyHeight(prev: number, next: number, tolerance: number = VIEWER_HEIGHT_JITTER_ROWS): number {
  if (prev <= 0) return next;
  return Math.abs(next - prev) <= tolerance ? prev : next;
}

/** Result of a viewer stop action, mapped to a top banner notice. */
export interface ViewerStopResult {
  text: string;
  kind: NoticeKind;
}

export interface TranscriptViewerOptions {
  /** Reloads viewer data (run snapshot + transcripts) on each refresh tick. */
  load: () => ViewerData;
  /** Closes the overlay (ctx.ui.custom's done callback). */
  done: () => void;
  styles: Styles;
  /** Opens on this actor (transcript id) instead of the first one. */
  initialActor?: string;
  /** Requests a repaint (host passes tui.requestRender). */
  requestRender?: () => void;
  /** Terminal rows provider (defaults to 30). Host passes tui.terminal.rows. */
  rows?: () => number;
  /** Assistant-text renderer; defaults to plain wrapping. Host passes Markdown. */
  renderMarkdown?: (text: string, width: number) => string[];
  refreshMs?: number;
  /**
   * Stops the whole run (leader + all members) after the two-step D
   * confirmation. Wired by the cockpit (`viewerStopAction`); maps the
   * outcome to a top banner notice. Exceptions never escape (busy guard
   * swallows repeats; rejections render an error notice).
   */
  stop?: () => Promise<ViewerStopResult>;
}

/** pi-tui component wrapper: gated refresh timer + key handling + rendering. */
export class TranscriptViewer implements Component {
  private readonly opts: TranscriptViewerOptions;
  private data: ViewerData;
  private state: ViewerState = initialViewerState();
  private lastTotalLines = 0;
  private lastBodyHeight = 22;
  private lastWidth = 100;
  private lastFingerprint: string | null = null;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TranscriptViewerOptions) {
    this.opts = opts;
    this.data = opts.load();
    if (opts.initialActor !== undefined) {
      const index = this.data.actors.findIndex((a) => a.actor === opts.initialActor);
      if (index >= 0) {
        this.state.actorIndex = index;
        this.state.actor = this.data.actors[index]?.actor;
      }
    } else if (this.data.actors[this.state.actorIndex]?.actor !== undefined) {
      this.state.actor = this.data.actors[this.state.actorIndex]?.actor;
    }
    try {
      const rows = this.opts.rows?.() ?? 30;
      this.lastBodyHeight = computeFrameHeight(rows);
    } catch {
      /* keep the default height */
    }
    this.lastFingerprint = viewerDataFingerprint(this.data);
    const refreshMs = opts.refreshMs ?? VIEWER_TICK_MS;
    this.timer = setInterval(() => {
      if (this.disposed) return;
      try {
        const next = this.opts.load();
        let bodyHeight = this.lastBodyHeight;
        try {
          const rows = this.opts.rows?.() ?? 30;
          bodyHeight = stabilizeBodyHeight(this.lastBodyHeight, computeFrameHeight(rows));
        } catch {
          /* keep the previous height */
        }
        const fingerprint = viewerDataFingerprint(next);
        this.data = next;
        this.state = withResolvedActor(this.data, this.state);
        if (fingerprint === this.lastFingerprint && bodyHeight === this.lastBodyHeight) return;
        this.lastFingerprint = fingerprint;
        this.lastBodyHeight = bodyHeight;
        this.requestRender();
      } catch {
        /* refresh failures never break the viewer */
      }
    }, refreshMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private requestRender(): void {
    if (!this.opts.requestRender) return;
    try {
      this.opts.requestRender();
    } catch {
      /* rendering is best-effort */
    }
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const rows = this.opts.rows?.() ?? 30;
    const bodyHeight = stabilizeBodyHeight(this.lastBodyHeight, computeFrameHeight(rows));
    this.lastBodyHeight = bodyHeight;
    this.data = this.opts.load();
    this.state = withResolvedActor(this.data, this.state);
    this.lastFingerprint = viewerDataFingerprint(this.data);
    const { detailWidth } = computeViewerLayout(width);
    const actor = this.data.actors[this.state.actorIndex];
    const entries = actor ? (this.data.entries.get(actor.actor) ?? []) : [];
    // 总行数按右栏正文宽度计（detailWidth）：滚动状态作用在 detail 正文上。
    this.lastTotalLines =
      this.data.actors.length > 0
        ? bodyLines(entries, this.state.showTools, detailWidth, this.opts.styles, this.opts.renderMarkdown).length
        : 1;
    // 滚动/翻页以右栏实际视口（bodyHeight − 头部 − action 行）为准。
    this.state = clampViewerState(this.state, this.lastTotalLines, viewerViewportHeight(this.data, this.state, width, bodyHeight, this.opts.styles));
    return renderViewerFrame(this.data, this.state, width, {
      styles: this.opts.styles,
      bodyHeight,
      ...(this.opts.renderMarkdown ? { renderMarkdown: this.opts.renderMarkdown } : {}),
    });
  }

  handleInput(data: string): void {
    const result = handleViewerKey(this.state, data, {
      totalLines: this.lastTotalLines,
      actorCount: this.data.actors.length,
      // 键位 reducer 的 bodyHeight 语义 = 右栏实际视口高（bodyHeight −
      // 头部 − action 行），翻页/滚动与屏上可见范围一致。
      bodyHeight: viewerViewportHeight(this.data, this.state, this.lastWidth, this.lastBodyHeight, this.opts.styles),
      actorIds: this.data.actors.map((a) => a.actor),
      runRunning: this.data.runStatus === "running",
      runStatus: this.data.runStatus,
    });
    if (result.type === "close") {
      this.dispose();
      this.opts.done();
      return;
    }
    if (result.type === "refresh") {
      // 手动刷新：绕过 750ms 指纹门控强制重载重绘（render() 每次 load）。
      this.requestRender();
      return;
    }
    if (result.type === "stop-confirm") {
      this.beginStop();
      return;
    }
    this.state = result.state;
    this.requestRender();
  }

  /**
   * Runs the injected stop action once: busy banner immediately, notice
   * on settle. Repeated confirms during the flight are ignored (busy
   * guard); failures map to an error notice and never escape.
   */
  private beginStop(): void {
    if (this.state.stopping) return;
    const stop = this.opts.stop;
    if (!stop) {
      this.state = {
        ...this.state,
        stopConfirming: false,
        notice: { text: "停止不可用：当前上下文没有接停止动作", kind: "error" },
      };
      this.requestRender();
      return;
    }
    this.state = { ...this.state, stopConfirming: false, stopping: true };
    this.requestRender();
    void (async () => {
      let result: ViewerStopResult;
      try {
        result = await stop();
      } catch {
        result = { text: "停止失败；稍后用 /team:stop 重试", kind: "error" };
      }
      this.state = { ...this.state, stopping: false, notice: { text: result.text, kind: result.kind } };
      this.requestRender();
    })();
  }

  invalidate(): void {
    /* stateless rendering — nothing cached */
  }

  /** Stops the refresh timer (called on close and by the host on teardown). */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Assistant-text renderer matching the main agent: the host's Markdown
 * component with the shared markdown theme. Returns undefined (plain
 * wrapping) when the theme is unavailable.
 */
function markdownRenderer(): ((text: string, width: number) => string[]) | undefined {
  try {
    const mdTheme = getMarkdownTheme();
    return (text: string, width: number) => new Markdown(text, 1, 0, mdTheme).render(width);
  } catch {
    return undefined;
  }
}

/**
 * Overlay geometry for the transcript viewer, copied verbatim from
 * pi-subagents' fleet inspector (`openSubagentFleet` in
 * `pi-subagents/src/tui/fleet.ts` v0.66.0, line 1440) — that inspector
 * repaints unconditionally every 750ms on the same host family without
 * ghosting, so any deviation here is a ghosting suspect. Do not
 * "improve" it. Spec-table entry: docs/tui-sync.md §4 (locked by
 * test/tui-sync.test.ts).
 */
export const VIEWER_OVERLAY_OPTIONS: OverlayOptions = {
  anchor: "center",
  width: "95%",
  minWidth: 60,
  maxHeight: "85%",
  margin: 1,
};

/**
 * Opens the transcript viewer as a centered capturing overlay (geometry:
 * `VIEWER_OVERLAY_OPTIONS`, verbatim from pi-subagents' fleet inspector).
 * Resolves when the user closes it (q/Esc). Host failures are the
 * caller's to guard (index.ts checks hasUI/mode and exception-isolates).
 */
export async function openTranscriptViewer(
  ui: Pick<ExtensionUIContext, "custom">,
  opts: { load: () => ViewerData; refreshMs?: number; initialActor?: string; stop?: () => Promise<ViewerStopResult> },
): Promise<void> {
  const renderMarkdown = markdownRenderer();
  await ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new TranscriptViewer({
        load: opts.load,
        done,
        styles: themeStyles(theme),
        ...(opts.initialActor !== undefined ? { initialActor: opts.initialActor } : {}),
        ...(opts.stop ? { stop: opts.stop } : {}),
        requestRender: () => {
          try {
            tui.requestRender();
          } catch {
            /* rendering is best-effort */
          }
        },
        rows: () => {
          try {
            return tui.terminal.rows;
          } catch {
            return 30;
          }
        },
        ...(renderMarkdown ? { renderMarkdown } : {}),
        ...(opts.refreshMs !== undefined ? { refreshMs: opts.refreshMs } : {}),
      }),
    {
      overlay: true,
      overlayOptions: VIEWER_OVERLAY_OPTIONS,
    },
  );
}
