/**
 * agent-team — below-editor live run widget (selectable bright block)
 *
 * Renders the coordinator's run snapshot BELOW the editor (placement
 * "belowEditor", first user in this workspace) instead of the old
 * per-second string[] widget above it. Mounted once as a component
 * factory; pulls `coordinator.getStatus()` on every render and ticks a
 * 1s repaint timer for elapsed labels.
 *
 * Selection is modal: bare arrows/enter belong to the editor (cursor
 * movement, history, submit), so the block only takes them over after an
 * explicit activation key (alt+down / alt+up). While selected: up/down
 * move the row cursor, enter opens the transcript viewer on the row's
 * actor, esc (or any other key) leaves selection and — except for esc —
 * passes the key through to the editor untouched.
 *
 * Row building and the key reducer are pure and unit-tested;
 * `TeamRunWidget` is the thin pi-tui host component (repo convention).
 */

import { matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { widgetRowSpecs, type RunStatusSnapshot, type WidgetRowSpec } from "./cockpit.ts";
import { LEADER_ACTOR, sanitizeActorName } from "./transcript.ts";
import type { Styles } from "./viewer.ts";
import { WIDGET_TICK_MS } from "./types.ts";

// ---------------------------------------------------------------------------
// Row building (pure)
// ---------------------------------------------------------------------------

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
 * Widget rows for a run snapshot: live progress rows (via widgetRowSpecs,
 * same format the old above-editor widget used) or, after the run ends,
 * terminal rows from the last record — the block stays open for review
 * instead of freezing on "▶ running". Empty when there is nothing to show.
 */
export function buildWidgetRows(snapshot: RunStatusSnapshot, nowMs: number): WidgetRowSpec[] {
  if (snapshot.running && snapshot.progress) {
    return widgetRowSpecs(snapshot.progress, nowMs);
  }
  const record = snapshot.lastRecord;
  if (!record) return [];

  const rows: WidgetRowSpec[] = [];
  const secs = record.durationMs !== undefined ? ` · ${Math.round(record.durationMs / 100) / 10}s` : "";
  const cost = record.totalCost > 0 ? ` · $${record.totalCost.toFixed(4)}` : "";
  rows.push({ text: `agent-team ${record.team} ${recordIcon(record.status)} ${record.status}${secs}${cost}`, actor: LEADER_ACTOR });
  rows.push({ text: `任务: ${truncateTask(record.task)}`, actor: LEADER_ACTOR });
  if (record.error) rows.push({ text: `✗ ${truncateTask(record.error)}`, actor: LEADER_ACTOR });
  for (const member of record.members) {
    const bits = [`${recordIcon(member.status)} ${member.name} ${member.status}`];
    if (member.model) bits.push(member.model);
    if (member.usage) bits.push(`$${member.usage.cost.toFixed(4)}`);
    if (member.summary) bits.push(member.summary.length > 60 ? `${member.summary.slice(0, 60)}…` : member.summary);
    rows.push({ text: bits.join(" — "), actor: sanitizeActorName(member.name) });
  }
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
// Host component (thin; not unit-tested — repo convention)
// ---------------------------------------------------------------------------

export interface TeamRunWidgetOptions {
  /** Coordinator status provider (live progress or last record). */
  load: () => RunStatusSnapshot;
  styles: Styles;
  /** Requests a repaint (host passes a guarded tui.requestRender). */
  requestRender: () => void;
  /** Enter handler: opens the transcript viewer on the row's actor. */
  onConfirm: (actor: string) => void;
  /** While true the widget ignores activation (viewer overlay open). */
  gate?: () => boolean;
  /** Test seam; defaults to Date.now(). */
  nowMs?: () => number;
  tickMs?: number;
}

/** pi-tui component: input listener + repaint timer + row rendering. */
export class TeamRunWidget implements Component {
  private readonly opts: TeamRunWidgetOptions;
  private state = initialWidgetKeyState();
  private rows: WidgetRowSpec[] = [];
  private readonly removeListener: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TeamRunWidgetOptions, tui: TUI) {
    this.opts = opts;
    this.removeListener = tui.addInputListener((data) => this.onData(data));
    this.timer = setInterval(() => this.repaint(), opts.tickMs ?? WIDGET_TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private repaint(): void {
    try {
      this.opts.requestRender();
    } catch {
      /* rendering is best-effort */
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
        this.repaint();
        try {
          this.opts.onConfirm(result.actor);
        } catch {
          /* opening the viewer never breaks the session */
        }
        return { consume: true };
      }
      if (result.type === "passthrough") return undefined;
      this.repaint();
      return { consume: true };
    } catch {
      return undefined; /* key failures never break the session */
    }
  }

  render(_width: number): string[] {
    let snapshot: RunStatusSnapshot;
    try {
      snapshot = this.opts.load();
    } catch {
      return [];
    }
    this.rows = buildWidgetRows(snapshot, this.opts.nowMs?.() ?? Date.now());
    if (this.rows.length === 0) return [];
    if (this.state.cursor > this.rows.length - 1) this.state.cursor = this.rows.length - 1;

    const styles = this.opts.styles;
    if (!this.state.selected) {
      return this.rows.map((row) => styles.dim(row.text));
    }
    const lines = this.rows.map((row, index) =>
      index === this.state.cursor ? styles.accent(`▸ ${row.text}`) : styles.dim(`  ${row.text}`),
    );
    lines.push(styles.dim("↑↓ 选择 · enter 查看 · esc 退出"));
    return lines;
  }

  invalidate(): void {
    /* stateless rendering — nothing cached */
  }

  /** Stops the repaint timer and removes the input listener. */
  dispose(): void {
    this.removeListener();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
