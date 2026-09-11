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

import { Markdown, isKeyRelease, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type OverlayOptions } from "@earendil-works/pi-tui";
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
  /**
   * Backend model for this actor: the leader's live/reported model, or a
   * member's declared `provider/id` from the team file. Absent = the child
   * pi process runs its own default (rendered as `（默认）`).
   */
  model?: string;
  /**
   * Thinking level for this actor: the child-reported provider level, or the
   * declared model-suffix (`provider/id:level`). Absent = provider default
   * (rendered as `思考 （默认）` next to a known model).
   */
  thinkingLevel?: string;
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

/** 连续空白（含换行）压成单空格并 trim——宿主把残余换行渲染成额外行。 */
export function flattenText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
      // 多行条目拆成物理帧行：cockpit 写入的 `team_dispatch 派发 →\n  - 成员: 任务`
      // 整体进入一个帧行时，宿主按物理行写屏会把换行当行分隔——尾巴落在下一行
      // 同列（真机：overlay 左缘残行 + 帧几何漂移）。首段 `· `、续段两空格缩进
      // （保留写入者 `  - <member>: <task>` 结构，对齐 fleet 的续行缩进）。
      return block.lines.flatMap((line) => {
        const segments = line
          .split(/\r?\n/)
          .map((segment) => segment.trim())
          .filter((segment) => segment.length > 0);
        return segments.map((segment, index) =>
          styles.dim(index === 0 ? `· ${truncateVisible(segment, width - 2)}` : `  ${truncateVisible(segment, width - 2)}`),
        );
      });
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
 * 动作键位对齐 pi-subagents' `DEFAULT_FLEET_KEYBINDINGS`（v0.66.0
 * `fleet.ts:33-48`，规格表 §4），与 fleet 同名动作键集逐字一致；agent-team
 * 无 steer/inspect 对应语义，未列入。大写滚动键（`K`/`J`）经
 * `matchesViewerBinding` 的大写→`shift+小写` 转换用 matchesKey 判定
 * （fleet.ts:59-61 同构）。Locked by test/tui-sync.test.ts.
 */
export const VIEWER_ACTION_KEYS = {
  close: ["escape", "ctrl+c", "q"],
  scrollUp: ["K"],
  scrollDown: ["J"],
  selectUp: ["up", "k"],
  selectDown: ["down", "j"],
  selectFirst: ["home"],
  selectLast: ["end"],
  pageUp: ["pageUp"],
  pageDown: ["pageDown"],
  refresh: ["r", "R"],
  stop: ["D"],
  toggleTools: ["x", "X", "ctrl+o"],
} as const;

/** fleet 的 `matchesFleetBinding`（fleet.ts:59-61）：大写绑定 → shift+小写。 */
function matchesViewerBinding(data: string, binding: string): boolean {
  const key = /^[A-Z]$/.test(binding) ? `shift+${binding.toLowerCase()}` : binding;
  return matchesKey(data, key as Parameters<typeof matchesKey>[1]);
}

function matchesViewerAction(data: string, action: keyof typeof VIEWER_ACTION_KEYS): boolean {
  return VIEWER_ACTION_KEYS[action].some((binding) => matchesViewerBinding(data, binding));
}

/** Key legend for the bottom border（fleet footer 风格，与键位实现同步维护）。 */
export const VIEWER_LEGEND = "↑↓ 成员 · J/K 滚动 · PgUp/PgDn 翻页 · x 工具行 · m 发消息 · D 停止 · r 刷新 · q 关闭";

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
 * 模型行文本：`<model> · 思考 <level>`；未知侧降级 `（默认）`——model 已知
 * 而级别未知（legacy/unmanaged provider）→ `· 思考 （默认）`；两者均未知 →
 * 仅 `（默认）`；无选中成员 → `（无成员）`。头部仍固定 4 行（帧总行数不变）。
 */
function modelHeaderText(actor: ViewerActor | undefined): string {
  if (!actor) return "（无成员）";
  if (actor.model === undefined) {
    return actor.thinkingLevel === undefined ? "（默认）" : `（默认） · 思考 ${actor.thinkingLevel}`;
  }
  return `${actor.model} · 思考 ${actor.thinkingLevel ?? "（默认）"}`;
}

/**
 * Fixed detail-pane meta header (the agent-team counterpart of fleet's
 * `structuredHeader`): Run / State / 成员 / 模型. Key names bold like
 * fleet's `^(Run|State|…):` rule; the header never scrolls with the
 * transcript. 模型 shows the selected actor's backend (leader = actual
 * model reported by the child, member = declared team model; `（默认）`
 * when the child runs pi's default) plus its thinking level.
 */
function detailHeaderLines(data: ViewerData, state: ViewerState, styles: Styles): string[] {
  const selected = selectedActor(data, state);
  const member = selected
    ? `${selected.actor.label}（${selected.actor.status ?? "unknown"}）· ${selected.index + 1}/${data.actors.length}`
    : "（无成员）";
  const model = modelHeaderText(selected?.actor);
  return [
    `${styles.bold("Run:")} ${data.runId || "(no run)"}`,
    `${styles.bold("State:")} ${data.runStatus}`,
    `${styles.bold("成员:")} ${member}`,
    `${styles.bold("模型:")} ${model}`,
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
 * ANSI/CJK-aware clamp to an exact display width: fold residual CR/LF to a
 * space, truncate (ellipsis) then pad with spaces. Mirrors pi-subagents'
 * fleet inspector `fit()` — every frame line is exactly `width` columns, so
 * nothing bleeds past the border and the diff renderer sees stable line
 * widths. The CR/LF fold is the frame's single-physical-row contract: a raw
 * newline used to reach the host（真机事故：tool 条目里的 `\n` 被当行分隔，
 * 尾巴落到下一行同列，overlay 左缘残行且 diff 无法清理）. Block rendering
 * already splits `\n`; this is the last-resort choke point for any future
 * writer（team 名/标签/工具行等）。
 */
export function fitLine(line: string, width: number): string {
  const single = line.replace(/[\r\n]+/g, " ");
  const clipped = truncateToWidth(single, width, "…");
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
  return actionLines(data, state, styles, detailWidth).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, detailWidth)));
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
  | { type: "stop-confirm" }
  | { type: "chat-submit"; text: string; state: ViewerState };

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
 * update) so the component ignores them; close 键集请求 close。
 *
 * 键位全面对齐 fleet `DEFAULT_FLEET_KEYBINDINGS`（v0.66.0
 * `fleet.ts:33-48`，规格表 §4）：`↑↓/k/j` 切换成员（切换重置滚动/follow、
 * 钉 actor id，首末钳位）、`Shift+K/J` 右栏正文逐行滚动（上滚 unfollow、
 * 到底 re-follow）、`Home/End` 首末成员（fleet `moveSelection(±items.length)`
 * 同构）、`PgUp/PgDn` 翻页、`x/X/ctrl+o` 工具行开关；旧键
 * `←→/h/l/Tab/1-9/g/G` 退役（按下忽略不改状态）。
 *
 * 停止/刷新/关闭键位同为 fleet 键集：`stop: ["D"]`、`refresh: ["r", "R"]`、
 * `close: ["escape", "ctrl+c", "q"]`。确认态按键集对齐 fleet.ts:1134-1150：
 * Enter/Y 确认、Esc/ctrl+c/N/backspace 取消（取消不关闭查看器）、其余键忽略。
 */
export function handleViewerKey(state: ViewerState, data: string, ctx: ViewerKeyContext): ViewerKeyResult {
  // Kitty 键盘协议 flag 2 下每次按键额外发 release 事件（`:3` 编码）：
  // 不过滤则一次按键生效两次（↓ 跳两个成员、x 开关两次等于无变化、
  // Enter release 重复确认停止）。fleet-status.ts:699 同款过滤，所有模式
  // （输入/确认/普通）统一在此短路。
  if (isKeyRelease(data)) return { type: "update", state };
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
  // fleet 的 `scrollDetail`（fleet.ts:1013-1018）：clamp 到 [0, maxScroll]，
  // 到底/在底再滚 = re-follow（detailAutoFollow 等价语义）。
  const scrollDetail = (delta: number): void => {
    const base = state.follow ? bottom : state.scroll;
    next.scroll = Math.max(0, Math.min(bottom, base + delta));
    next.follow = next.scroll >= bottom;
  };

  // close 键集对齐 fleet `close: ["escape", "ctrl+c", "q"]`（fleet.ts:34）。
  if (matchesViewerAction(data, "close")) {
    return { type: "close" };
  }

  // 键位全面对齐 fleet DEFAULT_FLEET_KEYBINDINGS（fleet.ts:1155-1210 顺序）。
  if (matchesViewerAction(data, "scrollUp")) scrollDetail(-1);
  else if (matchesViewerAction(data, "scrollDown")) scrollDetail(1);
  else if (matchesViewerAction(data, "selectUp")) switchActor(state.actorIndex - 1);
  else if (matchesViewerAction(data, "selectDown")) switchActor(state.actorIndex + 1);
  else if (matchesViewerAction(data, "selectFirst")) switchActor(0);
  else if (matchesViewerAction(data, "selectLast")) switchActor(Math.max(0, ctx.actorCount - 1));
  else if (matchesViewerAction(data, "pageUp")) {
    scrollDetail(-ctx.bodyHeight);
  } else if (matchesViewerAction(data, "pageDown")) {
    scrollDetail(ctx.bodyHeight);
  } else if (matchesViewerAction(data, "refresh")) {
    return { type: "refresh" };
  } else if (matchesViewerAction(data, "stop")) {
    // 停止动作：运行中 → 两步确认；已结束/无 run → error notice（不进确认态，
    // 停止回调不会被调）。
    if (ctx.runRunning) {
      next.stopConfirming = true;
    } else {
      next.notice = { text: `run 已结束（${ctx.runStatus ?? "unknown"}），无需停止`, kind: "error" };
      return { type: "update", state: next };
    }
  } else if (matchesViewerAction(data, "toggleTools")) {
    next.showTools = !state.showTools;
  } else if (data === "m") {
    next.inputMode = true;
    next.inputBuffer = "";
  }
  // 旧键（←→/h/l/Tab/1-9/g/G）与其余未识别键：忽略不改状态，仍返回 update。
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
