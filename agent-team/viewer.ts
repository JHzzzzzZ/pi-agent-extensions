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

import { Markdown, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type TranscriptEntry } from "./transcript.ts";

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
export interface ViewerState {
  actorIndex: number;
  /** Row offset into the rendered transcript body (0 = top). */
  scroll: number;
  /** Stick to the bottom while new rows arrive. */
  follow: boolean;
  /** Include tool call rows in the body. */
  showTools: boolean;
}

export function initialViewerState(): ViewerState {
  return { actorIndex: 0, scroll: 0, follow: true, showTools: true };
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
      const body = renderMarkdown ? renderMarkdown(block.text, width - 2) : wrapText(block.text, width);
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
 * Frame height for a terminal with `rows` rows: ~82% of the screen,
 * at least 12 rows (very small terminals let the TUI clip).
 */
export function computeFrameHeight(rows: number): number {
  if (!Number.isFinite(rows) || rows <= 0) return 24;
  return Math.max(12, Math.min(Math.floor(rows * 0.82), rows - 2));
}

function topBorder(data: ViewerData, width: number, styles: Styles): string {
  const status = data.elapsed ? `${data.runStatus} · ${data.elapsed}` : data.runStatus;
  const title = `agent-team · team ${data.team} · ${status} · ${data.runId || "(no run)"}`;
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
  const legend = "↑↓ 滚动 · ←→/1-9 成员 · g/G 首末 · x 工具行 · q 关闭";
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
 * Renders the full bordered frame: title top border, member tabs, a
 * fixed-height continuous-transcript body window, and the key-legend
 * bottom border. Always returns exactly `bodyHeight + VIEWER_CHROME_ROWS`
 * lines.
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
  const clamped = clampViewerState(state, lines.length, opts.bodyHeight);
  const window = lines.slice(clamped.scroll, clamped.scroll + opts.bodyHeight);
  while (window.length < opts.bodyHeight) window.push("");

  return [
    topBorder(data, width, styles),
    sideWrap(tabsRow(data, state, inner, styles), inner, styles),
    ...window.map((line) => sideWrap(line, inner, styles)),
    bottomBorder(data, state, width, styles),
  ];
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
}

export type ViewerKeyResult = { type: "update"; state: ViewerState } | { type: "close" };

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
 */
export function handleViewerKey(state: ViewerState, data: string, ctx: ViewerKeyContext): ViewerKeyResult {
  const bottom = Math.max(0, ctx.totalLines - ctx.bodyHeight);
  const next: ViewerState = { ...state };
  const switchActor = (index: number): void => {
    next.actorIndex = Math.min(Math.max(0, index), Math.max(0, ctx.actorCount - 1));
    next.scroll = 0;
    next.follow = true;
  };

  switch (data) {
    case "q":
    case "\x1b":
      return { type: "close" };
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

export interface TranscriptViewerOptions {
  /** Reloads viewer data (run snapshot + transcripts) on each refresh tick. */
  load: () => ViewerData;
  /** Closes the overlay (ctx.ui.custom's done callback). */
  done: () => void;
  styles: Styles;
  /** Requests a repaint (host passes tui.requestRender). */
  requestRender?: () => void;
  /** Terminal rows provider (defaults to 30). Host passes tui.terminal.rows. */
  rows?: () => number;
  /** Assistant-text renderer; defaults to plain wrapping. Host passes Markdown. */
  renderMarkdown?: (text: string, width: number) => string[];
  refreshMs?: number;
}

/** pi-tui component wrapper: refresh timer + key handling + rendering. */
export class TranscriptViewer implements Component {
  private readonly opts: TranscriptViewerOptions;
  private data: ViewerData;
  private state: ViewerState = initialViewerState();
  private lastTotalLines = 0;
  private lastBodyHeight = 22;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TranscriptViewerOptions) {
    this.opts = opts;
    this.data = opts.load();
    const refreshMs = opts.refreshMs ?? 800;
    this.timer = setInterval(() => {
      try {
        this.data = this.opts.load();
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
    const bodyHeight = computeFrameHeight(rows) - VIEWER_CHROME_ROWS;
    this.lastBodyHeight = bodyHeight;
    this.data = this.opts.load();
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
    });
    if (result.type === "close") {
      this.dispose();
      this.opts.done();
      return;
    }
    this.state = result.state;
    this.requestRender();
  }

  invalidate(): void {
    /* stateless rendering — nothing cached */
  }

  /** Stops the refresh timer (called on close and by the host on teardown). */
  dispose(): void {
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
 * Opens the transcript viewer as a centered capturing overlay (~96% wide,
 * ~82% of the terminal height with a full border). Resolves when the user
 * closes it (q/Esc). Host failures are the caller's to guard (index.ts
 * checks hasUI/mode and exception-isolates).
 */
export async function openTranscriptViewer(
  ui: Pick<ExtensionUIContext, "custom">,
  opts: { load: () => ViewerData; refreshMs?: number },
): Promise<void> {
  const renderMarkdown = markdownRenderer();
  await ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new TranscriptViewer({
        load: opts.load,
        done,
        styles: themeStyles(theme),
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
      overlayOptions: { anchor: "center", width: "96%" },
    },
  );
}
