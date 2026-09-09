/**
 * agent-team — full-page run transcript viewer
 *
 * Renders each actor (leader + members) as one bordered full-page chat
 * transcript — a continuous chronological flow like the main agent's own
 * conversation view, not per-message timestamp blocks. Fed by the run
 * artifacts written by transcript.ts (same idea as pi-subagents' fleet
 * inspector).
 *
 * The page is a complete box (title in the top border, key legend in the
 * bottom border, side borders on every row) sized from the live terminal
 * height (~82%), so it reads as a clearly separated surface over the main
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
  /**
   * Single-line message input mode (`m` from the normal state). While set,
   * every key feeds the input state machine first — no other viewer action
   * fires; Esc/ctrl+c leave input mode (never close the viewer); Enter
   * submits as a `chat-submit` key result.
   */
  inputMode?: boolean;
  /** Message input buffer (text typed so far; empty when not in input mode). */
  inputBuffer?: string;
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
// Bordered frame (~82% of the terminal, clear separation from the main UI)
// ---------------------------------------------------------------------------

/** Chrome rows of the frame: top border + member tabs + bottom border. */
export const VIEWER_CHROME_ROWS = 3;

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
export const VIEWER_LEGEND = "↑↓ 滚动 · ←→/1-9 成员 · g/G 首末 · x 工具行 · m 发消息 · D 停止 · r 刷新 · q 关闭";

/**
 * Frame height for a terminal with `rows` rows: ~82% of the screen,
 * at least 12 rows (very small terminals let the TUI clip).
 */
export function computeFrameHeight(rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return 24;
  return Math.max(12, Math.min(Math.floor(rows * 0.82), rows - 2));
}

function topBorder(data: ViewerData, width: number, styles: Styles): string {
  // 标题刻意保持静态（对标 fleet 检查器的静态标题行）：真机截图实锤——
  // 每秒跳动的 `elapsed` 时钟行就是纵向堆叠物本身（53s/54s、1m26s/1m27s
  // 标题并存）。存活秒表只放在输入栏下方的 widget 里（宿主渲染的纯字符
  // 串表面，已证明稳定），绝不放进这个 overlay——chrome 区零每秒文本。
  const title = `agent-team · team ${data.team} · ${data.runStatus} · ${data.runId || "(no run)"}`;
  const room = Math.max(4, width - 5);
  const shown = truncateVisible(title, room);
  const pad = Math.max(1, width - visibleWidth(`╭─ ${shown} `) - 1);
  return styles.border(`╭─ `) + shown + styles.border(` ${"─".repeat(pad)}╮`);
}

function tabsRow(data: ViewerData, state: ViewerState, width: number, styles: Styles): string {
  const parts = data.actors.map((actor, index) => {
    const { icon, style } = statusDisplay(actor.status);
    const iconText = applyStyle(styles, style, icon);
    const current = index === state.actorIndex;
    const base = `${index + 1} ${actor.label} `;
    return current ? styles.accent(`▸${base}`) + iconText : styles.dim(base) + iconText;
  });
  const position =
    data.actors.length > 0 ? styles.dim(`成员 ${Math.min(state.actorIndex + 1, data.actors.length)}/${data.actors.length}`) : "";
  const tabs = parts.join(styles.dim("  "));
  const gap = width - visibleWidth(tabs) - visibleWidth(position) - 2;
  return gap > 1 ? `${tabs}${" ".repeat(gap)}${position}` : tabs;
}

function bottomBorder(data: ViewerData, state: ViewerState, width: number, styles: Styles): string {
  const legend = VIEWER_LEGEND;
  const hasPosition = data.actors.length > 0;
  const position = hasPosition ? `成员 ${Math.min(state.actorIndex + 1, data.actors.length)}/${data.actors.length}` : "";
  const segmentWidth = (legendText: string): number =>
    3 + visibleWidth(legendText) + (hasPosition ? 3 + visibleWidth(position) + 1 : 1) + 1;
  let shownLegend = legend;
  if (segmentWidth(shownLegend) > width) {
    shownLegend = truncateVisible(legend, Math.max(4, width - segmentWidth("") - 1));
  }
  const pad = Math.max(1, width - segmentWidth(shownLegend));
  return (
    styles.border(`╰─ `) +
    styles.dim(shownLegend) +
    (hasPosition ? styles.border(` ─ `) + styles.dim(position) : styles.border(` `)) +
    styles.border(` ${"─".repeat(pad)}╯`)
  );
}

/** Wraps a body/chrome line with the side borders, padding to full width. */
function sideWrap(line: string, width: number, styles: Styles): string {
  return styles.border("│ ") + padLine(line, width) + styles.border(" │");
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
 * `actionLines` counterpart, priority busy > confirm > input > notice).
 * Pure: derived entirely from the viewer state, mutually exclusive display.
 * `width` (display columns) truncates the input line to the pane; CJK
 * aware via truncateVisible.
 */
export function actionLines(data: ViewerData, state: ViewerState, styles: Styles, width?: number): string[] {
  if (state.stopping) return [styles.accent("停止中…")];
  if (state.stopConfirming) {
    return [
      styles.warning(`确认停止 run ${data.runId || "(no run)"}？`),
      styles.dim("停止会中止 leader 与所有成员子进程。Enter/Y 确认 · N 取消 · Esc 取消"),
    ];
  }
  if (state.inputMode) {
    const line = `❯ ${state.inputBuffer ?? ""}▏`;
    return [styles.accent(width !== undefined ? truncateVisible(line, width) : line)];
  }
  if (state.notice) {
    const style = state.notice.kind === "error" ? styles.error : state.notice.kind === "warning" ? styles.warning : styles.success;
    return [style(state.notice.text)];
  }
  return [];
}

/**
 * Renders the full bordered frame: title top border, member tabs, a
 * fixed-height continuous-transcript body window, and the key-legend
 * bottom border. Action lines (stop banner/notice) take the top of the
 * body window and shrink it accordingly — the frame always returns
 * exactly `bodyHeight + VIEWER_CHROME_ROWS` lines.
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
  const styles = opts.styles;
  // Side borders take "│ " + " │" = 4 columns.
  const inner = Math.max(10, width - 4);

  const actor = data.actors[state.actorIndex];
  const entries = actor ? (data.entries.get(actor.actor) ?? []) : [];
  const lines = bodyLines(entries, state.showTools, inner, styles, opts.renderMarkdown);
  const actions = actionLines(data, state, styles, inner);
  const effective = Math.max(1, opts.bodyHeight - actions.length);
  const clamped = clampViewerState(state, lines.length, effective);
  const window = lines.slice(clamped.scroll, clamped.scroll + effective);
  while (window.length < effective) window.push("");

  return [
    topBorder(data, width, styles),
    sideWrap(tabsRow(data, state, inner, styles), inner, styles),
    ...actions.map((line) => sideWrap(line, inner, styles)),
    ...window.map((line) => sideWrap(line, inner, styles)),
    bottomBorder(data, state, width, styles),
  ].map((line) => fitLine(line, width));
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
  /** Transcript actor ids in tab order (pins selection by id when present). */
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
  | { type: "stop-confirm" }
  | { type: "chat-submit"; text: string; state: ViewerState };

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_LEFT = "\x1b[D";
const KEY_RIGHT = "\x1b[C";
const KEY_PGUP = "\x1b[5~";
const KEY_PGDN = "\x1b[6~";
const KEY_HOME = "\x1b[H";
const KEY_END = "\x1b[F";

/** 可打印输入判定：非转义序列、无控制字符（含 CJK 多字节字符与粘贴串）。 */
function isPrintableInput(data: string): boolean {
  if (data.length === 0 || data.startsWith("\x1b")) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

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
  // 输入模式分支在最前面：优先于一切现有按键——输入模式中 j/k/D/r/q 等都
  // 进 buffer；Esc/ctrl+c 只退出输入（绝不关 viewer）；Enter 提交。
  if (state.inputMode) {
    if (matchesKey(data, "enter")) {
      return {
        type: "chat-submit",
        text: state.inputBuffer ?? "",
        state: { ...state, inputMode: false, inputBuffer: "" },
      };
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      return { type: "update", state: { ...state, inputMode: false, inputBuffer: "" } };
    }
    if (matchesKey(data, "backspace")) {
      const chars = Array.from(state.inputBuffer ?? "");
      return { type: "update", state: { ...state, inputBuffer: chars.slice(0, -1).join("") } };
    }
    // 可打印字符（含 CJK 多字节）追加；控制序列（\x1b 开头的方向键等）与
    // 其余控制字符一律忽略。
    if (isPrintableInput(data)) {
      return { type: "update", state: { ...state, inputBuffer: (state.inputBuffer ?? "") + data } };
    }
    return { type: "update", state }; // 其余键一律忽略
  }

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
    case "m":
      next.inputMode = true;
      next.inputBuffer = "";
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
  /**
   * Delivers a message typed in the viewer (m → input line → Enter) to the
   * selected actor (leader or member). Wired by the cockpit; dispatches a
   * new background run (or queues it) and returns the banner notice.
   * Exceptions never escape (mapped to an error notice).
   */
  onMessage?: (target: { actor: string; label: string }, message: string) => { text: string; kind: NoticeKind };
}

/** pi-tui component wrapper: gated refresh timer + key handling + rendering. */
export class TranscriptViewer implements Component {
  private readonly opts: TranscriptViewerOptions;
  private data: ViewerData;
  private state: ViewerState = initialViewerState();
  private lastTotalLines = 0;
  private lastBodyHeight = 22;
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
      this.lastBodyHeight = computeFrameHeight(rows) - VIEWER_CHROME_ROWS;
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
          bodyHeight = stabilizeBodyHeight(this.lastBodyHeight, computeFrameHeight(rows) - VIEWER_CHROME_ROWS);
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
    const rows = this.opts.rows?.() ?? 30;
    const bodyHeight = stabilizeBodyHeight(this.lastBodyHeight, computeFrameHeight(rows) - VIEWER_CHROME_ROWS);
    this.lastBodyHeight = bodyHeight;
    this.data = this.opts.load();
    this.state = withResolvedActor(this.data, this.state);
    this.lastFingerprint = viewerDataFingerprint(this.data);
    const actor = this.data.actors[this.state.actorIndex];
    const entries = actor ? (this.data.entries.get(actor.actor) ?? []) : [];
    this.lastTotalLines =
      this.data.actors.length > 0
        ? bodyLines(entries, this.state.showTools, Math.max(10, width - 4), this.opts.styles, this.opts.renderMarkdown).length
        : 1;
    this.state = clampViewerState(this.state, this.lastTotalLines, bodyHeight);
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
      bodyHeight: this.lastBodyHeight,
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
    if (result.type === "chat-submit") {
      this.state = result.state;
      this.submitChat(result.text);
      return;
    }
    this.state = result.state;
    this.requestRender();
  }

  /**
   * Runs the injected onMessage action for a submitted viewer message:
   * notice maps to the top banner. Without a callback (or a resolvable
   * selected actor) an error notice renders; failures never escape.
   */
  private submitChat(text: string): void {
    const onMessage = this.opts.onMessage;
    const actor = this.data.actors[this.state.actorIndex];
    if (!onMessage || !actor) {
      this.state = { ...this.state, notice: { text: "发消息不可用：当前上下文没有接消息动作", kind: "error" } };
      this.requestRender();
      return;
    }
    let notice: { text: string; kind: NoticeKind };
    try {
      notice = onMessage({ actor: actor.actor, label: actor.label }, text);
    } catch {
      notice = { text: "发送失败：消息处理异常，请重试", kind: "error" };
    }
    this.state = { ...this.state, notice };
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
  opts: {
    load: () => ViewerData;
    refreshMs?: number;
    initialActor?: string;
    stop?: () => Promise<ViewerStopResult>;
    onMessage?: (target: { actor: string; label: string }, message: string) => { text: string; kind: NoticeKind };
  },
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
        ...(opts.onMessage ? { onMessage: opts.onMessage } : {}),
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
