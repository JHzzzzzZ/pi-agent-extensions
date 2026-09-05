/**
 * agent-team — full-screen run transcript viewer
 *
 * Renders per-actor run transcripts (leader + members) in a centered
 * overlay with keyboard navigation — the same idea as pi-subagents' fleet
 * inspector, fed by the run artifacts written by transcript.ts.
 *
 * All rendering and key handling is pure and unit-tested without pi-tui;
 * `TranscriptViewer` is the thin host component (pi-tui Component) and
 * `openTranscriptViewer` the thin host opener (ctx.ui.custom overlay).
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type TranscriptEntry } from "./transcript.ts";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/** Visible transcript rows inside the frame (fixed so scrolling is deterministic). */
export const VIEWER_BODY_HEIGHT = 22;
/** Total frame height: header + tabs + rule + body + rule + footer. */
export const VIEWER_FRAME_HEIGHT = VIEWER_BODY_HEIGHT + 5;

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

const STATUS_ICONS: Record<string, string> = {
  queued: "…",
  running: "▶",
  done: "✓",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

function statusIcon(status: string | undefined): string {
  if (!status) return "…";
  return STATUS_ICONS[status] ?? "·";
}

// ---------------------------------------------------------------------------
// Pure text helpers (CJK-aware wrapping)
// ---------------------------------------------------------------------------

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

function timestampOf(entry: TranscriptEntry): string {
  return entry.ts.length >= 19 ? entry.ts.slice(11, 19) : "";
}

// ---------------------------------------------------------------------------
// Entry rendering
// ---------------------------------------------------------------------------

/**
 * Renders one transcript entry to display lines: assistant messages get a
 * timestamped rule line followed by their full wrapped text; other kinds
 * render as compact single blocks (wrapped).
 */
export function entryLines(entry: TranscriptEntry, width: number): string[] {
  const ts = timestampOf(entry);
  if (entry.kind === "assistant") {
    const rule = `─ ${ts} `;
    const pad = Math.max(0, Math.min(width, 40) - rule.length);
    return [`${rule}${"─".repeat(pad)}`, ...wrapText(entry.text, width)];
  }
  const prefix = entry.kind === "task" ? "◆ 任务: " : entry.kind === "error" ? "✗ " : entry.kind === "system" ? "ℹ " : "";
  const body = ts ? `${ts} ${prefix}${entry.text}` : `${prefix}${entry.text}`;
  return wrapText(body, width);
}

/** Kinds hidden when tool rows are toggled off. */
function entryVisible(entry: TranscriptEntry, showTools: boolean): boolean {
  return showTools || entry.kind !== "tool";
}

/** All body lines for one actor (filtered + styled; unwindowed). */
export function bodyLines(
  entries: TranscriptEntry[],
  showTools: boolean,
  width: number,
  dim: (text: string) => string,
): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entryVisible(entry, showTools)) continue;
    const rendered = entryLines(entry, width);
    const isSpeech = entry.kind === "assistant" || entry.kind === "error";
    for (const line of rendered) lines.push(isSpeech ? line : dim(line));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

function tabsLine(actors: ViewerActor[], state: ViewerState, width: number): string {
  const parts = actors.map((actor, index) => {
    const marker = index === state.actorIndex ? "▸" : " ";
    return `${marker}[${index + 1}] ${actor.label} ${statusIcon(actor.status)}`;
  });
  const line = parts.join("  ");
  return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
}

function emptyBodyHint(data: ViewerData, dim: (text: string) => string): string[] {
  if (data.actors.length === 0) {
    return [dim("当前没有可查看的 run 记录。用 /team:run <团队> <任务> 派单后即可查看成员会话记录。")];
  }
  return [dim("（暂无记录，等待子进程事件…）")];
}

/** Clamps scroll/follow against the current body size. */
export function clampViewerState(state: ViewerState, totalLines: number, bodyHeight: number): ViewerState {
  const maxScroll = Math.max(0, totalLines - bodyHeight);
  if (state.follow) return { ...state, scroll: maxScroll };
  return { ...state, scroll: Math.min(Math.max(0, state.scroll), maxScroll) };
}

/**
 * Renders the full viewer frame: header, actor tabs, rule, a fixed-height
 * transcript body window, rule, and the key legend. Always returns exactly
 * `bodyHeight + 5` lines regardless of content size.
 */
export function renderViewerFrame(
  data: ViewerData,
  state: ViewerState,
  width: number,
  opts: { dim: (text: string) => string; bodyHeight?: number },
): string[] {
  const dim = opts.dim;
  const bodyHeight = opts.bodyHeight ?? VIEWER_BODY_HEIGHT;

  const status = data.elapsed ? `${data.runStatus} · ${data.elapsed}` : data.runStatus;
  const header = dim(` agent-team · team ${data.team} · ${status} · ${data.runId || "(no run)"}`);
  const tabs = dim(tabsLine(data.actors, state, width));
  const rule = dim("─".repeat(Math.max(0, width)));

  const actor = data.actors[state.actorIndex];
  const entries = actor ? (data.entries.get(actor.actor) ?? []) : [];
  const lines = data.actors.length > 0 ? bodyLines(entries, state.showTools, width, dim) : emptyBodyHint(data, dim);
  const clamped = clampViewerState(state, lines.length, bodyHeight);
  const window = lines.slice(clamped.scroll, clamped.scroll + bodyHeight);
  while (window.length < bodyHeight) window.push("");

  const position = data.actors.length > 0 ? dim(` 成员 ${Math.min(state.actorIndex + 1, data.actors.length)}/${data.actors.length}`) : "";
  const footer = dim(" ↑↓滚动 · ←→/1-9 成员 · g/G首末 · x 工具行 · q/Esc 关闭");

  return [header, tabs, rule, ...window, rule, footer + position];
}

/** Plain-text transcript dump for the team_transcript tool (no frame). */
export function formatTranscriptText(
  data: ViewerData,
  actor: string,
  opts: { dim?: (text: string) => string } = {},
): string {
  const dim = opts.dim ?? ((t: string) => t);
  const target = data.actors.find((a) => a.actor === actor);
  if (!target) return `没有 "${actor}" 的会话记录。`;
  const entries = data.entries.get(target.actor) ?? [];
  const lines = [`## ${target.label}（${target.status ?? "unknown"}）· run ${data.runId}`, ...bodyLines(entries, true, 100, dim)];
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

export interface TranscriptViewerOptions {
  /** Reloads viewer data (run snapshot + transcripts) on each refresh tick. */
  load: () => ViewerData;
  /** Closes the overlay (ctx.ui.custom's done callback). */
  done: () => void;
  dim: (text: string) => string;
  requestRender: () => void;
  refreshMs?: number;
  bodyHeight?: number;
}

/** pi-tui component wrapper: refresh timer + key handling + rendering. */
export class TranscriptViewer implements Component {
  private readonly opts: TranscriptViewerOptions;
  private data: ViewerData;
  private state: ViewerState = initialViewerState();
  private lastTotalLines = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TranscriptViewerOptions) {
    this.opts = opts;
    this.data = opts.load();
    const refreshMs = opts.refreshMs ?? 800;
    this.timer = setInterval(() => {
      try {
        this.data = this.opts.load();
        this.opts.requestRender();
      } catch {
        /* refresh failures never break the viewer */
      }
    }, refreshMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  render(width: number): string[] {
    const bodyHeight = this.opts.bodyHeight ?? VIEWER_BODY_HEIGHT;
    const actor = this.data.actors[this.state.actorIndex];
    const entries = actor ? (this.data.entries.get(actor.actor) ?? []) : [];
    const total = this.data.actors.length > 0 ? bodyLines(entries, this.state.showTools, width, this.opts.dim).length : 1;
    this.lastTotalLines = total;
    this.state = clampViewerState(this.state, total, bodyHeight);
    return renderViewerFrame(this.data, this.state, width, { dim: this.opts.dim, bodyHeight });
  }

  handleInput(data: string): void {
    const result = handleViewerKey(this.state, data, {
      totalLines: this.lastTotalLines,
      actorCount: this.data.actors.length,
      bodyHeight: this.opts.bodyHeight ?? VIEWER_BODY_HEIGHT,
    });
    if (result.type === "close") {
      this.dispose();
      this.opts.done();
      return;
    }
    this.state = result.state;
    this.opts.requestRender();
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
 * Opens the transcript viewer as a centered capturing overlay. Resolves
 * when the user closes it (q/Esc). Host failures are the caller's to guard
 * (index.ts checks hasUI/mode and exception-isolates).
 */
export async function openTranscriptViewer(
  ui: Pick<ExtensionUIContext, "custom">,
  opts: { load: () => ViewerData; refreshMs?: number; bodyHeight?: number },
): Promise<void> {
  await ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new TranscriptViewer({
        load: opts.load,
        done,
        dim: (text) => {
          try {
            return theme.fg("dim", text);
          } catch {
            return text;
          }
        },
        requestRender: () => {
          try {
            tui.requestRender();
          } catch {
            /* rendering is best-effort */
          }
        },
        ...(opts.refreshMs !== undefined ? { refreshMs: opts.refreshMs } : {}),
        ...(opts.bodyHeight !== undefined ? { bodyHeight: opts.bodyHeight } : {}),
      }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: VIEWER_FRAME_HEIGHT, margin: 1 },
    },
  );
}
