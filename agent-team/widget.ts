/**
 * agent-team — below-editor live run widget (selectable bright block)
 *
 * Data-driven surface (aligned to pi-subagents fleet-status trigger form):
 * the controller is mounted once per session; the host widget is REGISTERED
 * only while a run is live (`snapshot.running`) — every settled run pushes
 * `setWidget(key, undefined)` and the block disappears. Repaints are
 * event-driven (coordinator `onProgress`) plus a 1s aligned-ticker fallback;
 * identical render strings skip `setWidget` (fleet-status renderKey).
 *
 * Rendering stays `setWidget(key, string[], …)` (placement "belowEditor"):
 * a per-tick component-factory repaint once left appended-line trails on a
 * bundled host build (see docs/tui-sync.md §3.1) — only the trigger form is
 * borrowed from fleet-status, not the component path.
 *
 * Default (unselected) state is a single collapsed line
 * (`agent-team <团队> · ↓/← 查看详情`); bare ↓/← (only while the editor is
 * empty AND focused — aligned to fleet-status) and alt+down/up (ungated
 * second channel) expand it into the `main → leader → 成员` tree + task +
 * hint rows. 展开态窗口化（选中行恒可见、帧总行数 ≤ 宿主 string[] widget
 * 的 10 行硬上限）——隐藏侧以 `… 上方/下方还有 N 行` 提示。↑/↓/j/k 移动行
 * 光标 (到顶再按 ↑/k 退出选中并收回折叠，
 * fleet-status 同构), enter opens the transcript viewer on the row's actor —
 * except the `main` root row, whose enter only leaves selection (fleet main
 * semantics) — esc (or any other key) leaves selection and — except for esc —
 * passes the key through to the editor untouched.
 *
 * While a host selector/dialog owns the keyboard (`probeEditorFocus` →
 * false) the widget is fully inert: no activation key is consumed and an
 * active selection auto-exits, so /login & friends keep their arrows.
 *
 * Row building and the key reducer are pure and unit-tested; the
 * `RunWidgetController` wires them to the host without a pi-tui component.
 */

import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { startAlignedTicker } from "./aligned-ticker.ts";
import { elapsedLabel, type RunStatusSnapshot } from "./cockpit.ts";
import { LEADER_ACTOR, sanitizeActorName } from "./transcript.ts";
import { truncateVisible, type Styles } from "./viewer.ts";
import { WIDGET_TICK_MS, type MemberProgress, type RunProgress } from "./types.ts";

/** Row role in the `main → leader → member` tree (viewer-open semantics). */
export type WidgetRowKind = "root" | "leader" | "member";

/** One widget row plus the transcript actor its enter opens in the viewer. */
export interface WidgetRowSpec {
  text: string;
  actor: string;
  kind: WidgetRowKind;
}

/** 成员行状态图标：queued · / running ● / done ✓ / failed ✗ / aborted ⊘。 */
function memberIcon(status: string): string {
  return status === "running"
    ? "●"
    : status === "done" || status === "completed"
      ? "✓"
      : status === "failed"
        ? "✗"
        : status === "aborted"
          ? "⊘"
          : "·";
}

/** 连续空白（含换行）压成单空格并 trim——宿主把残余换行渲染成额外行。 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 任务摘要：压平后 44 字符 + `…`（截断后 trimEnd，避免 "…" 前留空格）。 */
function truncateTask(text: string): string {
  const flat = flatten(text);
  const clipped = flat.length > 44 ? `${flat.slice(0, 44)}…` : flat;
  return clipped.trimEnd();
}

/** 成员尾注：压平后 ≤30 字符（超出取 29 字 + `…`，总长不超上限）。 */
function truncateMemberTail(text: string): string {
  const flat = flatten(text);
  return flat.length > 30 ? `${flat.slice(0, 29)}…` : flat;
}

/**
 * Leader 行：`leader <团队> · <任务摘要> ▶ running · <耗时> · <N>/<M> 并行[ · 剩 $X.XX]`。
 * 任务摘要与 leader 同行（不再单独占一行）：末行恒为成员行，光标到底即成员，
 * 消除「任务行 enter 打开 leader」的假成员陷阱（用户 2026-09-15 真机反馈）。
 */
function leaderRowText(progress: RunProgress, nowMs: number): string {
  const running = progress.members.filter((member) => member.status === "running").length;
  const counts = progress.members.length > 0 ? ` · ${running}/${progress.members.length} 并行` : "";
  // Only a remaining-balance hint when a cost cap is set and not yet
  // breached (a breach aborts the run anyway).
  let budgetHint = "";
  const budget = progress.budget;
  if (budget?.maxCostUsd !== null && budget?.maxCostUsd !== undefined && budget.spentCost < budget.maxCostUsd) {
    budgetHint = ` · 剩 $${(budget.maxCostUsd - budget.spentCost).toFixed(2)}`;
  }
  const task = truncateTask(progress.task);
  const summary = task.length > 0 ? ` · ${task}` : "";
  return `leader ${flatten(progress.team)}${summary} ▶ running · ${elapsedLabel(progress.startedAtMs, nowMs)}${counts}${budgetHint}`;
}

/** 成员行：`|- <成员名> <图标> <状态>[ · <尾部>]`（尾部 note 优先，否则 latest）。 */
function memberRowText(member: MemberProgress): string {
  const tail = member.note ?? member.latest;
  const suffix = tail !== undefined && flatten(tail).length > 0 ? ` · ${truncateMemberTail(tail)}` : "";
  return `|- ${flatten(member.name)} ${memberIcon(member.status)} ${member.status}${suffix}`;
}

/**
 * Widget view for the live run: collapsed one-liner (default, unselected)
 * plus the expanded `main → leader（含任务摘要）→ 成员…` tree. Settled runs
 * (and snapshots without live progress) project to an EMPTY view — the
 * block is unmounted, terminal rows live in /team:status and /team:view.
 */
export interface WidgetView {
  /** 未选中态的单行文案；无活跃 run 时为空串（widget 整体隐藏）。 */
  collapsed: string;
  /** 选中态的行（main + leader + 成员…；任务摘要在 leader 行内）。 */
  rows: WidgetRowSpec[];
}

export function buildWidgetView(snapshot: RunStatusSnapshot, nowMs: number): WidgetView {
  if (!snapshot.running || !snapshot.progress) return { collapsed: "", rows: [] };
  const progress = snapshot.progress;
  const rows: WidgetRowSpec[] = [
    { text: "main", actor: LEADER_ACTOR, kind: "root" },
    { text: leaderRowText(progress, nowMs), actor: LEADER_ACTOR, kind: "leader" },
  ];
  for (const member of progress.members) {
    rows.push({ text: memberRowText(member), actor: sanitizeActorName(member.name), kind: "member" });
  }
  return { collapsed: `agent-team ${flatten(progress.team)} · ↓/← 查看详情`, rows };
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
  | { type: "confirm"; row: WidgetRowSpec; state: WidgetKeyState }
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
 * Pure key reducer. Not selected: the activation keys are consumed (bare
 * ↓/← only when `canActivate` — editor empty; alt+↓/↑ always); everything
 * else reaches the editor untouched. Selected: up/down/j/k/enter/esc are
 * consumed — up/k 在第 0 行再按退出选中（fleet-status 同构，后续键到达
 * 编辑器）；any other key deselects and passes through so typing and
 * ctrl+c keep working in the editor. Enter confirms the row under the
 * cursor (caller maps the `main` root row to a plain deselect).
 */
export function handleWidgetKey(
  state: WidgetKeyState,
  data: string,
  rows: readonly WidgetRowSpec[],
  canActivate = false,
): WidgetKeyResult {
  // Kitty 键盘协议 flag 2 下每次按键额外发 release 事件（`:3` 编码），release
  // 同样能被 matchesKey 命中——不过滤会让一次按键生效两次（激活+移动、
  // 或移动两行）。fleet-status.ts:699 同款过滤。
  if (isKeyRelease(data)) return { type: "none" };
  const clamp = (n: number): number => Math.min(Math.max(0, n), Math.max(0, rows.length - 1));

  if (!state.selected) {
    // 激活门控对齐 fleet-status（v0.66.0 fleet-status.ts:606-607，规格表
    // §4）：bare ↓/← 只在编辑器为空（canActivate=true）时激活；alt+↓/↑ 为
    // 不受门控的第二通道（差异表 §3.3）。
    const gatedActivate = canActivate && (matchesKey(data, "down") || matchesKey(data, "left"));
    if (rows.length > 0 && (isActivate(data) || gatedActivate)) {
      return { type: "update", state: { selected: true, cursor: clamp(state.cursor) } };
    }
    return { type: "none" };
  }

  if (matchesKey(data, "up") || matchesKey(data, "k")) {
    // 到顶退出（fleet-status.ts:620-625 同构）：选中第 0 行再按 up/k → 退出
    // 选中放行编辑器（本次按键被消费，后续键到达编辑器）；退出时保持 cursor
    // 供再次激活恢复。
    if (state.cursor === 0) return { type: "update", state: { selected: false, cursor: state.cursor } };
    return { type: "update", state: { selected: true, cursor: clamp(state.cursor - 1) } };
  }
  if (matchesKey(data, "down") || matchesKey(data, "j")) return { type: "update", state: { selected: true, cursor: clamp(state.cursor + 1) } };
  if (matchesKey(data, "enter")) {
    const row = rows[clamp(state.cursor)];
    // Rows can vanish between frames (run settles while selected): nothing
    // to confirm — leave selection and let the key reach the editor.
    if (!row) return { type: "passthrough", state: { selected: false, cursor: state.cursor } };
    return { type: "confirm", row, state: { selected: false, cursor: state.cursor } };
  }
  if (matchesKey(data, "escape")) {
    return { type: "update", state: { selected: false, cursor: state.cursor } };
  }
  return { type: "passthrough", state: { selected: false, cursor: state.cursor } };
}

// ---------------------------------------------------------------------------
// Focus probe (aligns to fleet-status `editorHasFocus`, v0.66.0
// fleet-status.ts:701/965)
// ---------------------------------------------------------------------------

/**
 * Structural editor check: the pi-tui focus getter/field returns whatever
 * component is focused (selector, dialog, editor…). `instanceof` is
 * unreliable across jiti module boundaries, so the editor is recognized by
 * the five-method shape the host editor interface requires (fleet-status
 * uses the same predicate).
 */
export function isEditorComponentLike(focused: unknown): boolean {
  if (!focused || typeof focused !== "object") return false;
  const candidate = focused as {
    render?: unknown;
    invalidate?: unknown;
    handleInput?: unknown;
    getText?: unknown;
    setText?: unknown;
  };
  return (
    typeof candidate.render === "function" &&
    typeof candidate.invalidate === "function" &&
    typeof candidate.handleInput === "function" &&
    typeof candidate.getText === "function" &&
    typeof candidate.setText === "function"
  );
}

/**
 * Reads the host TUI's focused component without new pi-tui API
 * dependencies: prefers the public `getFocusedComponent()` getter, falls
 * back to the runtime `focusedComponent` field (fleet-status's read).
 * Returns undefined when the host exposes neither (focus unknown → caller
 * keeps legacy gating) or when the probe throws — the key path must never
 * break. false means focus is KNOWN to be elsewhere (selector/dialog).
 */
export function probeEditorFocus(tui: unknown): boolean | undefined {
  if (!tui || typeof tui !== "object") return undefined;
  const candidate = tui as { getFocusedComponent?: unknown; focusedComponent?: unknown };
  if (typeof candidate.getFocusedComponent === "function") {
    try {
      return isEditorComponentLike((candidate.getFocusedComponent as () => unknown)());
    } catch {
      return undefined;
    }
  }
  try {
    if (!("focusedComponent" in candidate)) return undefined;
    return isEditorComponentLike(candidate.focusedComponent);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

/**
 * 宿主 `setExtensionWidget` 对 `string[]` 的硬上限：只渲染前 10 行并追加
 * `... (widget truncated)`（pi-coding-agent `interactive-mode.js`
 * `InteractiveMode.MAX_WIDGET_LINES = 10`）。展开态据此窗口化——帧总行数
 * （含底部提示行与折叠提示行）不超过该值，光标行永远在帧内。
 */
export const WIDGET_MAX_LINES = 10;

/** 展开态底部键位提示（窗口化预算里固定占 1 行）。 */
const WIDGET_HINT_TEXT = "↑↓ 选择 · enter 查看 · esc 退出";

/** 隐藏行折叠提示（两个空格与行 gutter 对齐）：`  … 上方还有 N 行`。 */
function foldHintText(where: "上" | "下", hidden: number): string {
  return `  … ${where}方还有 ${hidden} 行`;
}

/**
 * 展开态行窗口：选中行永远在窗口内；窗口行数 + 折叠提示行 ≤ 提示行之外的
 * 预算（`WIDGET_MAX_LINES - 1`）。窗口尺寸变化后重算一次即收敛（尺寸只减
 * 不增，折叠提示最多 2 行 ⇒ 至多 3 轮）。
 */
function widgetRowWindow(rows: readonly WidgetRowSpec[], cursor: number): { start: number; size: number } {
  const budget = WIDGET_MAX_LINES - 1;
  let size = Math.min(rows.length, budget);
  let start = 0;
  for (let pass = 0; pass < 3; pass++) {
    start = Math.max(0, Math.min(cursor - size + 1, rows.length - size));
    const foldLines = (start > 0 ? 1 : 0) + (start + size < rows.length ? 1 : 0);
    const allowed = budget - foldLines;
    if (size <= allowed) break;
    size = allowed;
  }
  return { start, size };
}

/**
 * Width-fitted, styled widget lines. Truncation happens on the PLAIN text
 * before styling (ANSI codes would break width measurement); the host TUI
 * crashes on component lines wider than the terminal, and row texts are
 * bounded by char count only — CJK-heavy rows render up to 2× wider.
 * 展开态窗口化（见 `WIDGET_MAX_LINES`）：大团队不再撞宿主截断，隐藏侧以
 * `… 上方/下方还有 N 行` 明示。
 */
export function renderWidgetView(
  view: WidgetView,
  state: WidgetKeyState,
  width: number,
  styles: Styles,
): string[] {
  if (view.rows.length === 0) return [];
  const usable = Math.max(8, width);
  if (!state.selected) {
    // 折叠默认态：恰好一行，不逐行输出 rows（状态/耗时收进展开态）。
    return [styles.dim(truncateVisible(view.collapsed, usable))];
  }
  const inner = Math.max(8, usable - 2); // "▸ " / "  " gutter
  const cursor = Math.min(Math.max(0, state.cursor), view.rows.length - 1);
  const window = widgetRowWindow(view.rows, cursor);
  const lines: string[] = [];
  if (window.start > 0) {
    lines.push(styles.dim(truncateVisible(foldHintText("上", window.start), usable)));
  }
  for (let index = window.start; index < window.start + window.size; index++) {
    const row = view.rows[index];
    if (!row) continue;
    const text = truncateVisible(row.text, inner);
    lines.push(index === cursor ? styles.accent(`▸ ${text}`) : styles.dim(`  ${text}`));
  }
  const hiddenBelow = view.rows.length - (window.start + window.size);
  if (hiddenBelow > 0) {
    lines.push(styles.dim(truncateVisible(foldHintText("下", hiddenBelow), usable)));
  }
  lines.push(styles.dim(truncateVisible(WIDGET_HINT_TEXT, usable)));
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
  /**
   * Editor-text provider. Bare ↓/← activate only when the editor is empty
   * (aligned to fleet-status `getEditorText() === ""`, v0.66.0
   * fleet-status.ts:607). Absent = degraded: only the alt channel activates.
   */
  editorState?: () => { text: string };
  /**
   * Keyboard-focus provider (`probeEditorFocus` over the captured host TUI).
   * `false` = focus is known to be elsewhere (selector/dialog open): the
   * widget consumes nothing and exits selection. `true`/`undefined` = the
   * main editor is focused / focus unknown → existing gating (bare ↓/←
   * only while the editor is empty). Aligns to fleet-status
   * `editorHasFocus` (v0.66.0 fleet-status.ts:701/965).
   */
  editorFocus?: () => boolean | undefined;
  /** Terminal width provider; defaults to process.stdout.columns ?? 80. */
  width?: () => number;
  /** Test seam; defaults to Date.now(). */
  nowMs?: () => number;
  tickMs?: number;
}

/**
 * Owns the below-editor widget WITHOUT a pi-tui component: display is plain
 * `setWidget(key, string[], { placement: "belowEditor" })` pushed while a
 * run is live — the host wraps and renders string widgets itself, the
 * rendering path proven stable across host builds (a per-tick
 * component-factory repaint turned into appended-line trails on one
 * bundled host build). The controller itself is mounted once per session
 * (idempotent `start()`); whether the host widget is registered is DATA
 * driven: `snapshot.running === true` ⇒ string[] frame, otherwise
 * `setWidget(key, undefined)` (auto-unmount on settle). Selection hooks the
 * terminal input through a host callback (`ctx.ui.onTerminalInput` where
 * available); keys are consumed before the editor only while the modal
 * selection is active, so unsupported hosts just lose the shortcut.
 */
export class RunWidgetController {
  private state = initialWidgetKeyState();
  private view: WidgetView = { collapsed: "", rows: [] };
  private stopTicker: (() => void) | null = null;
  /** True while the transcript viewer overlay is open (tick paused). */
  private paused = false;
  /** True once start() has run (pause/resume never starts a fresh loop). */
  private started = false;
  private removeInput: (() => void) | undefined;
  /** True while a string[] frame is registered on the host (data-driven). */
  private registered = false;
  /** Render-string fingerprint of the last setWidget (skip identical repaints). */
  private lastRender: string | null = null;
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

  /** 对齐墙钟秒边界的重绘节拍（docs/cross/status-bar.md；tickMs 仅供测试覆盖）。 */
  private startTicker(): () => void {
    return startAlignedTicker(() => this.refresh(), { intervalMs: this.opts.tickMs ?? WIDGET_TICK_MS });
  }

  /** Starts the repaint loop and (when available) the input hook. */
  start(): void {
    if (this.stopTicker) return;
    this.started = true;
    this.removeInput = this.attachInput?.((data) => this.onData(data));
    if (this.paused) return;
    this.refresh();
    this.stopTicker = this.startTicker();
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
      if (this.stopTicker !== null) {
        this.stopTicker();
        this.stopTicker = null;
      }
      this.hide();
      return;
    }
    if (this.started && this.stopTicker === null) {
      this.stopTicker = this.startTicker();
    }
    // 恢复必须强制重绘一帧：上一帧渲染串可能未变，若不清指纹，refresh 会
    // 跳过 setWidget，亮块将停留在隐藏态（fleet-status 恢复时同样重置 key）。
    this.lastRender = null;
    this.refresh();
  }

  /** 卸载亮块（若已注册）：清指纹 + 复位选择态（数据驱动卸载/暂停隐藏共用）。 */
  private hide(): void {
    this.lastRender = null;
    this.state = initialWidgetKeyState();
    if (!this.registered) return;
    this.registered = false;
    try {
      this.setWidget(undefined);
    } catch {
      /* widget failures never break the session */
    }
  }

  /**
   * Rebuilds the view and syncs the host registration: a live run renders
   * the collapsed/expanded frame, a settled run (or a snapshot without
   * progress) unmounts the widget. Skips setWidget when the render string
   * is unchanged (aligned to fleet-status renderKey semantics, v0.66.0
   * fleet-status.ts:585-591) — the collapsed default line carries no
   * per-second text, so a running run does not churn the host while
   * unselected; the expanded leader row's elapsed label changes every
   * second while selected, and a selection toggle changes the gutter/hint
   * lines and rebuilds too. Called on state-change events and on the 1s
   * aligned ticker.
   */
  refresh(): void {
    if (this.paused) return;
    try {
      const snapshot = this.opts.load();
      this.view = buildWidgetView(snapshot, this.opts.nowMs?.() ?? Date.now());
      if (this.view.rows.length === 0) {
        // 数据驱动卸载：run 落定 → 亮块消失；选择态随 run 结束复位。
        this.hide();
        return;
      }
      if (this.state.cursor > this.view.rows.length - 1) this.state.cursor = Math.max(0, this.view.rows.length - 1);
      const width = this.opts.width?.() ?? process.stdout.columns ?? 80;
      const lines = renderWidgetView(this.view, this.state, width, this.opts.styles);
      const renderKey = lines.join("\n");
      if (this.registered && renderKey === this.lastRender) return;
      this.lastRender = renderKey;
      this.registered = true;
      this.setWidget(lines);
    } catch {
      /* widget failures never break the session */
    }
  }

  private onData(data: string): { consume?: boolean } | undefined {
    try {
      if (this.opts.gate?.()) return undefined;
      // 焦点门控（对齐 fleet-status editorHasFocus，v0.66.0
      // fleet-status.ts:701/965）：宿主选择器/对话框（/login、/model、
      // /settings…）打开时键盘焦点不在主编辑器，widget 完全不介入（含
      // alt 第二通道）；选中态则退出选中并把该键让行（保留 cursor 供
      // 焦点回来后恢复）。
      if (this.opts.editorFocus?.() === false) {
        if (this.state.selected) {
          this.state = { selected: false, cursor: this.state.cursor };
          this.refresh();
        }
        return undefined;
      }
      // 编辑器为空才允许 bare ↓/← 激活（对齐 fleet-status getEditorText===""）；
      // 宿主无 editorState 端口时降级为仅 alt 通道（canActivate=false）。
      const canActivate = this.opts.editorState ? this.opts.editorState().text === "" : false;
      const result = handleWidgetKey(this.state, data, this.view.rows, canActivate);
      if (result.type === "none") return undefined;
      this.state = result.state;
      if (result.type === "confirm") {
        this.refresh();
        // main 根行：enter 只退出选中（fleet main 语义），不进 viewer。
        if (result.row.kind === "root") return { consume: true };
        try {
          this.opts.onConfirm(result.row.actor);
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
    if (this.stopTicker !== null) {
      this.stopTicker();
      this.stopTicker = null;
    }
    this.removeInput?.();
    this.removeInput = undefined;
  }
}
