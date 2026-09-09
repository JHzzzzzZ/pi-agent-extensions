/**
 * agent-team — below-editor live run widget (selectable bright block)
 *
 * Renders the coordinator's run snapshot BELOW the editor (placement
 * "belowEditor") as plain `setWidget(key, string[], …)` refreshed on a 1s
 * interval, and makes the block selectable: alt+down/up activates a modal
 * selection, bare arrows move the row cursor, enter opens the transcript
 * viewer on the row's actor, esc (or any other key) leaves selection and —
 * except for esc — passes the key through to the editor untouched.
 *
 * Row building and the key reducer are pure and unit-tested; the
 * `RunWidgetController` wires them to the host without a pi-tui component.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import { elapsedLabel, type RunStatusSnapshot } from "./cockpit.ts";
import { LEADER_ACTOR } from "./transcript.ts";
import { truncateVisible, type Styles } from "./viewer.ts";
import { WIDGET_TICK_MS } from "./types.ts";

/** One widget row plus the transcript actor its enter opens in the viewer. */
export interface WidgetRowSpec {
  text: string;
  actor: string;
}

function recordIcon(status: string): string {
  return status === "completed" || status === "done"
    ? "✓"
    : status === "failed"
      ? "✗"
      : status === "aborted"
        ? "⊘"
        : "·";
}

function truncateTask(text: string): string {
  return text.length > 44 ? `${text.slice(0, 44)}…` : text;
}

/**
 * Compact widget rows for a run snapshot: a header line (team, status,
 * elapsed, live parallel-member count) plus the bounded task line — member
 * detail lives in the transcript viewer, not here. A failed/aborted run
 * keeps one bounded error row. Empty when there is nothing to show.
 */
export function buildWidgetRows(snapshot: RunStatusSnapshot, nowMs: number): WidgetRowSpec[] {
  const rows: WidgetRowSpec[] = [];
  if (snapshot.running && snapshot.progress) {
    const progress = snapshot.progress;
    const running = progress.members.filter((member) => member.status === "running").length;
    const counts = progress.members.length > 0 ? ` · ${running}/${progress.members.length} 并行` : "";
    rows.push({
      text: `agent-team ${progress.team} ▶ running · ${elapsedLabel(progress.startedAtMs, nowMs)}${counts}`,
      actor: LEADER_ACTOR,
    });
    rows.push({ text: `任务: ${truncateTask(progress.task)}`, actor: LEADER_ACTOR });
    return rows;
  }
  const record = snapshot.lastRecord;
  if (!record) return [];
  const secs = record.durationMs !== undefined ? ` · ${Math.round(record.durationMs / 100) / 10}s` : "";
  const cost = record.totalCost > 0 ? ` · $${record.totalCost.toFixed(4)}` : "";
  rows.push({ text: `agent-team ${record.team} ${recordIcon(record.status)} ${record.status}${secs}${cost}`, actor: LEADER_ACTOR });
  rows.push({ text: `任务: ${truncateTask(record.task)}`, actor: LEADER_ACTOR });
  if (record.error) rows.push({ text: `✗ ${truncateTask(record.error)}`, actor: LEADER_ACTOR });
  return rows;
}

// ---------------------------------------------------------------------------
// Key handling (pure)
// ---------------------------------------------------------------------------

export interface WidgetKeyState {
  selected: boolean;
  /** Row cursor while selected. */
  cursor: number;
}

export function initialWidgetKeyState(): WidgetKeyState {
  return { selected: false, cursor: 0 };
}

export type WidgetKeyResult =
  | { type: "none" }
  | { type: "update"; state: WidgetKeyState }
  | { type: "confirm"; actor: string; state: WidgetKeyState }
  | { type: "passthrough"; state: WidgetKeyState };

// matchesKey understands the modified-arrow CSI encoding ("\x1b[1;3B");
// legacy xterm sends a bare ESC prefix instead ("\x1b\x1b[B").
function isActivate(data: string): boolean {
  return (
    matchesKey(data, "alt+down") ||
    matchesKey(data, "alt+up") ||
    data === "\x1b\x1b[B" ||
    data === "\x1b\x1b[A"
  );
}

/**
 * Pure key reducer. Not selected: only the activation keys are consumed
 * (everything else reaches the editor untouched). Selected: up/down/enter/
 * esc are consumed; any other key deselects and passes through so typing
 * and ctrl+c keep working in the editor.
 */
export function handleWidgetKey(
  state: WidgetKeyState,
  data: string,
  rowCount: number,
  rowActors: string[],
): WidgetKeyResult {
  const clamp = (n: number): number => Math.min(Math.max(0, n), Math.max(0, rowCount - 1));

  if (!state.selected) {
    if (rowCount > 0 && isActivate(data)) {
      return { type: "update", state: { selected: true, cursor: clamp(state.cursor) } };
    }
    return { type: "none" };
  }

  if (matchesKey(data, "up")) return { type: "update", state: { selected: true, cursor: clamp(state.cursor - 1) } };
  if (matchesKey(data, "down")) return { type: "update", state: { selected: true, cursor: clamp(state.cursor + 1) } };
  if (matchesKey(data, "enter")) {
    return {
      type: "confirm",
      actor: rowActors[clamp(state.cursor)] ?? LEADER_ACTOR,
      state: { selected: false, cursor: state.cursor },
    };
  }
  if (matchesKey(data, "escape")) {
    return { type: "update", state: { selected: false, cursor: state.cursor } };
  }
  return { type: "passthrough", state: { selected: false, cursor: state.cursor } };
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

/**
 * Width-fitted, styled widget lines. Truncation happens on the PLAIN text
 * before styling (ANSI codes would break width measurement); the host TUI
 * crashes on component lines wider than the terminal, and row texts are
 * bounded by char count only — CJK-heavy rows render up to 2× wider.
 */
export function renderWidgetView(
  rows: WidgetRowSpec[],
  state: WidgetKeyState,
  width: number,
  styles: Styles,
): string[] {
  if (rows.length === 0) return [];
  const usable = Math.max(8, width);
  if (!state.selected) {
    return rows.map((row) => styles.dim(truncateVisible(row.text, usable)));
  }
  const inner = Math.max(8, usable - 2); // "▸ " / "  " gutter
  const lines = rows.map((row, index) => {
    const text = truncateVisible(row.text, inner);
    return index === state.cursor ? styles.accent(`▸ ${text}`) : styles.dim(`  ${text}`);
  });
  lines.push(styles.dim(truncateVisible("↑↓ 选择 · enter 查看 · esc 退出", usable)));
  return lines;
}

// ---------------------------------------------------------------------------
// Controller (host-agnostic: string[] setWidget + terminal input hook)
// ---------------------------------------------------------------------------

export interface RunWidgetControllerOptions {
  /** Coordinator status provider (live progress or last record). */
  load: () => RunStatusSnapshot;
  styles: Styles;
  /** Enter handler: opens the transcript viewer on the row's actor. */
  onConfirm: (actor: string) => void;
  /** While true the widget ignores activation (viewer overlay open). */
  gate?: () => boolean;
  /** Terminal width provider; defaults to process.stdout.columns ?? 80. */
  width?: () => number;
  /** Test seam; defaults to Date.now(). */
  nowMs?: () => number;
  tickMs?: number;
}

/**
 * Owns the below-editor widget WITHOUT a pi-tui component: display is plain
 * `setWidget(key, string[], { placement: "belowEditor" })` on a 1s interval —
 * the host wraps and renders string widgets itself, the rendering path
 * proven stable across host builds (a per-tick component-factory repaint
 * turned into appended-line trails on one bundled host build). Selection
 * hooks the terminal input through a host callback (`ctx.ui.onTerminalInput`
 * where available); keys are consumed before the editor only while the
 * modal selection is active, so unsupported hosts just lose the shortcut.
 */
export class RunWidgetController {
  private state = initialWidgetKeyState();
  private rows: WidgetRowSpec[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** True while the transcript viewer overlay is open (tick paused). */
  private paused = false;
  /** True once start() has run (pause/resume never starts a fresh loop). */
  private started = false;
  private removeInput: (() => void) | undefined;
  private readonly opts: RunWidgetControllerOptions;
  private readonly setWidget: (lines: string[] | undefined) => void;
  private readonly attachInput: ((handler: (data: string) => { consume?: boolean } | undefined) => (() => void) | undefined) | undefined;

  constructor(
    opts: RunWidgetControllerOptions,
    setWidget: (lines: string[] | undefined) => void,
    attachInput?: (handler: (data: string) => { consume?: boolean } | undefined) => (() => void) | undefined,
  ) {
    this.opts = opts;
    this.setWidget = setWidget;
    this.attachInput = attachInput;
  }

  /** Starts the repaint loop and (when available) the input hook. */
  start(): void {
    if (this.timer) return;
    this.started = true;
    this.removeInput = this.attachInput?.((data) => this.onData(data));
    if (this.paused) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.opts.tickMs ?? WIDGET_TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /**
   * Pauses the 1s repaint loop while the transcript viewer overlay is
   * open (and hides the below-editor block), resuming with an immediate
   * repaint on close. The open overlay + the per-second widget repaint
   * underneath churn the main screen every second, which leaves ghost
   * title+tabs rows on a trail-prone host — pausing removes that churn.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      try {
        this.setWidget(undefined);
      } catch {
        /* widget failures never break the session */
      }
      return;
    }
    if (this.started && this.timer === null) {
      this.timer = setInterval(() => this.refresh(), this.opts.tickMs ?? WIDGET_TICK_MS);
      if (typeof this.timer.unref === "function") this.timer.unref();
    }
    this.refresh();
  }

  /** Rebuilds rows and pushes them to the host (one setWidget per tick). */
  refresh(): void {
    if (this.paused) return;
    try {
      const snapshot = this.opts.load();
      this.rows = buildWidgetRows(snapshot, this.opts.nowMs?.() ?? Date.now());
      if (this.state.cursor > this.rows.length - 1) this.state.cursor = Math.max(0, this.rows.length - 1);
      const width = this.opts.width?.() ?? process.stdout.columns ?? 80;
      this.setWidget(renderWidgetView(this.rows, this.state, width, this.opts.styles));
    } catch {
      /* widget failures never break the session */
    }
  }

  private onData(data: string): { consume?: boolean } | undefined {
    try {
      if (this.opts.gate?.()) return undefined;
      const result = handleWidgetKey(
        this.state,
        data,
        this.rows.length,
        this.rows.map((row) => row.actor),
      );
      if (result.type === "none") return undefined;
      this.state = result.state;
      if (result.type === "confirm") {
        this.refresh();
        try {
          this.opts.onConfirm(result.actor);
        } catch {
          /* opening the viewer never breaks the session */
        }
        return { consume: true };
      }
      if (result.type === "passthrough") return undefined;
      this.refresh();
      return { consume: true };
    } catch {
      return undefined; /* key failures never break the session */
    }
  }

  /** Stops the repaint loop and removes the input hook. */
  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.removeInput?.();
    this.removeInput = undefined;
  }
}
