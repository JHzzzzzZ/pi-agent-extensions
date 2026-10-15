/**
 * btw - 只读侧对话面板（`ctx.ui.custom(…, { overlay: true })` 覆盖层）
 *
 * 口径（对齐文档 btw-todo#1）：
 * - 只有 TUI 模式走面板；RPC / 无 UI 由 index.ts 走降级通道（面板绝不假装可用）。
 * - **面板内不放每秒跳动文本**（repo 教训：overlay 逐秒变化即纵向堆叠物本身），
 *   流式阶段只有静态状态词 + 已到达的正文。
 * - 正文用真实 Markdown 渲染（`getMarkdownTheme` + `Markdown`，与 agent-team
 *   viewer 同款）；取不到 markdown 主题时退回纯文本折行。
 * - 帧几何：正文窗口 + 固定 `PANEL_CHROME_ROWS` 行 chrome，每行恰好 width 列
 *   （overlay 单物理行契约；`fit` 收口）。
 */
import {
  Markdown,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { BtwErrorCodes } from "./errors.ts";
import type { SideCallResult } from "./side-call.ts";
import { BTW_OVERLAY_OPTIONS, PANEL_MIN_WIDTH } from "./spec.ts";

// ---------------------------------------------------------------------------
// 状态与样式
// ---------------------------------------------------------------------------

export type PanelPhase = "streaming" | "done" | "error" | "timeout" | "aborted";

export interface PanelState {
  /** 已到达的正文（流式增量累加） */
  answer: string;
  phase: PanelPhase;
  /** error / timeout / aborted 的说明文本 */
  errorText: string;
  /** 正文窗口首行下标 */
  scroll: number;
}

export function initialPanelState(): PanelState {
  return { answer: "", phase: "streaming", errorText: "", scroll: 0 };
}

export interface PanelStyles {
  border: (text: string) => string;
  dim: (text: string) => string;
  accent: (text: string) => string;
  bold: (text: string) => string;
  error: (text: string) => string;
}

/** 每个样式调用都异常隔离：主题缺失/宿主异常绝不破坏面板 */
export function panelStyles(theme: Theme): PanelStyles {
  const fg = (color: Parameters<Theme["fg"]>[0]) => (text: string): string => {
    try {
      return theme.fg(color, text);
    } catch {
      return text;
    }
  };
  return {
    border: fg("border"),
    dim: fg("dim"),
    accent: fg("accent"),
    error: fg("error"),
    bold: (text: string): string => {
      try {
        return theme.bold(text);
      } catch {
        return text;
      }
    },
  };
}

/** 无样式（测试用；也是主题不可用时的兜底） */
export const PLAIN_PANEL_STYLES: PanelStyles = {
  border: (text) => text,
  dim: (text) => text,
  accent: (text) => text,
  bold: (text) => text,
  error: (text) => text,
};

/** 正文窗口 + 固定 chrome（上/下边框、标题、提问、两条分隔线、图例） */
export const PANEL_CHROME_ROWS = 7;
export const PANEL_LEGEND = "J/K 滚动 · ↑↓ 行 · PgUp/PgDn 翻页 · Esc 关闭";

// ---------------------------------------------------------------------------
// 布局 / 文案（纯函数）
// ---------------------------------------------------------------------------

/** 正文窗口高度：终端行数的 ~70% 减去 chrome，钳在 4..24（窄屏也留得下正文） */
export function computePanelBodyHeight(rows: number): number {
  const safe = Number.isFinite(rows) && rows > 0 ? rows : 32;
  return Math.max(4, Math.min(24, Math.floor(safe * 0.7) - PANEL_CHROME_ROWS));
}

export function panelMaxScroll(bodyLineCount: number, bodyHeight: number): number {
  return Math.max(0, bodyLineCount - Math.max(1, bodyHeight));
}

export function phaseLabel(state: PanelState): string {
  switch (state.phase) {
    case "streaming":
      return "思考中…";
    case "done":
      return "已完成";
    case "error":
      return "出错";
    case "timeout":
      return "已超时";
    case "aborted":
      return "已取消";
  }
}

/** 正文区显示什么（空态给明确占位，不静默空白） */
export function panelBodyText(state: PanelState): string {
  if (state.phase === "error") return state.errorText || "侧调用失败。";
  if (state.phase === "timeout") return state.errorText || "侧调用超时（已中止）。";
  if (state.phase === "aborted") return state.errorText || "侧对话已取消。";
  if (state.answer.trim()) return state.answer;
  return state.phase === "streaming" ? "（等待模型输出…）" : "（模型返回了空回答）";
}

/** 侧调用结果 → 面板相位（超时与用户取消都是 aborted，靠 timedOut 区分） */
export function phaseForResult(result: SideCallResult, timedOut: boolean): { phase: PanelPhase; errorText: string } {
  if (result.ok) return { phase: "done", errorText: "" };
  if (result.code === BtwErrorCodes.aborted) {
    return timedOut
      ? { phase: "timeout", errorText: `侧调用超时（已中止）。` }
      : { phase: "aborted", errorText: "侧对话已取消。" };
  }
  return { phase: "error", errorText: result.message };
}

// ---------------------------------------------------------------------------
// 帧渲染（纯函数）
// ---------------------------------------------------------------------------

/** 补齐/截断到恰好 width 显示列（ANSI 感知；超宽时加 …） */
function fit(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible > width) return truncateToWidth(text, width, "…", false);
  return text + " ".repeat(Math.max(0, width - visible));
}

/** 左内容 + 右内容，合计恰好 width 列（右内容优先保留） */
function rightAligned(left: string, right: string, width: number): string {
  const rightText = truncateToWidth(right, Math.max(1, width - 2), "…", false);
  const rightWidth = visibleWidth(rightText);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fit(left, leftWidth) + " " + rightText;
}

export interface PanelFrameOptions {
  styles: PanelStyles;
  /** 终端行数（tui.terminal.rows） */
  rows: number;
  question: string;
  /** 已渲染好的正文行（Markdown 或纯文本折行） */
  bodyLines: string[];
}

/** 拼帧：正文窗口按 state.scroll 取窗口，chrome 固定 7 行，每行恰好 width 列 */
export function renderPanelFrame(state: PanelState, width: number, opts: PanelFrameOptions): string[] {
  const styles = opts.styles;
  if (width < PANEL_MIN_WIDTH) {
    return [fit(`btw 面板至少需要 ${PANEL_MIN_WIDTH} 列。Esc 关闭。`, width)];
  }
  const innerWidth = width - 2;
  const contentWidth = Math.max(1, innerWidth - 2);
  const bodyHeight = computePanelBodyHeight(opts.rows);
  const scroll = Math.min(Math.max(0, state.scroll), panelMaxScroll(opts.bodyLines.length, bodyHeight));
  const body: string[] = [];
  for (let index = 0; index < bodyHeight; index++) {
    body.push(" " + fit(opts.bodyLines[scroll + index] ?? "", contentWidth) + " ");
  }
  const question = opts.question.replace(/\s+/g, " ").trim();
  const title = rightAligned(styles.bold(" btw 旁路对话"), styles.dim(`${phaseLabel(state)} `), innerWidth);
  const questionLine = fit(styles.dim(` ❯ ${question}`), innerWidth);
  const position = panelMaxScroll(opts.bodyLines.length, bodyHeight) > 0 ? `${scroll + 1}/${opts.bodyLines.length}` : "";
  const legend = rightAligned(styles.dim(` ${PANEL_LEGEND}`), styles.dim(`${position} `), innerWidth);
  const lines = [
    styles.border(`╭${"─".repeat(innerWidth)}╮`),
    styles.border("│") + title + styles.border("│"),
    styles.border("│") + questionLine + styles.border("│"),
    styles.border(`├${"─".repeat(innerWidth)}┤`),
    ...body.map((line) => styles.border("│") + line + styles.border("│")),
    styles.border(`├${"─".repeat(innerWidth)}┤`),
    styles.border("│") + legend + styles.border("│"),
    styles.border(`╰${"─".repeat(innerWidth)}╯`),
  ];
  return lines.map((line) => truncateToWidth(line, width, "", false));
}

// ---------------------------------------------------------------------------
// 按键（纯函数）
// ---------------------------------------------------------------------------

export type PanelKeyResult = { type: "update"; state: PanelState } | { type: "close" };

/** 大写绑定（`J`/`K`）= shift + 小写，与 askview/viewer 同构 */
function matchesBinding(data: string, binding: string): boolean {
  const key = /^[A-Z]$/.test(binding) ? `shift+${binding.toLowerCase()}` : binding;
  return matchesKey(data, key as Parameters<typeof matchesKey>[1]);
}

/**
 * 纯键位 reducer：`J/K`、`↑↓` 逐行滚动，`PgUp/PgDn` 翻页，`Esc`/`ctrl+c`/`q`
 * 关闭。Kitty 键盘协议的 release 事件统一短路（一次按键只生效一次）。
 */
export function handlePanelKey(
  state: PanelState,
  data: string,
  ctx: { bodyLineCount: number; bodyHeight: number },
): PanelKeyResult {
  if (isKeyRelease(data)) return { type: "update", state };
  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) return { type: "close" };
  const maxScroll = panelMaxScroll(ctx.bodyLineCount, ctx.bodyHeight);
  const scrollBy = (delta: number): PanelKeyResult => ({
    type: "update",
    state: { ...state, scroll: Math.max(0, Math.min(maxScroll, state.scroll + delta)) },
  });
  if (matchesKey(data, "pageUp")) return scrollBy(-Math.max(1, ctx.bodyHeight));
  if (matchesKey(data, "pageDown")) return scrollBy(Math.max(1, ctx.bodyHeight));
  if (matchesBinding(data, "K")) return scrollBy(-1);
  if (matchesBinding(data, "J")) return scrollBy(1);
  if (matchesKey(data, "up")) return scrollBy(-1);
  if (matchesKey(data, "down")) return scrollBy(1);
  return { type: "update", state };
}

// ---------------------------------------------------------------------------
// 正文渲染器（Markdown 优先，纯文本兜底；按 (text,width) 记忆化）
// ---------------------------------------------------------------------------

/** markdown 主题不可用（测试/无主题宿主）时返回 undefined，调用方退回纯文本 */
export function markdownLines(text: string, width: number): string[] | undefined {
  try {
    return new Markdown(text, 1, 0, getMarkdownTheme()).render(width);
  } catch {
    return undefined;
  }
}

export function plainLines(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width));
}

/** 记忆化：流式时正文每个增量都会重渲染，同一 (text,width) 只算一次 */
export function makeAnswerRenderer(): (text: string, width: number) => string[] {
  let cache: { text: string; width: number; lines: string[] } | undefined;
  return (text, width) => {
    if (cache && cache.text === text && cache.width === width) return cache.lines;
    const lines = markdownLines(text, width) ?? plainLines(text, width);
    cache = { text, width, lines };
    return lines;
  };
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export interface BtwPanelOptions {
  question: string;
  styles: PanelStyles;
  rows: () => number;
  requestRender: () => void;
  renderAnswer: (text: string, width: number) => string[];
  /** 用户关闭面板时回调（presenter 在这里 abort 侧调用并 done） */
  onClose: () => void;
}

export class BtwPanel implements Component {
  private state: PanelState = initialPanelState();
  private readonly opts: BtwPanelOptions;
  private lastBodyLineCount = 1;
  private lastBodyHeight = 1;
  private closed = false;

  constructor(opts: BtwPanelOptions) {
    this.opts = opts;
  }

  render(width: number): string[] {
    const rows = this.safeRows();
    const bodyHeight = computePanelBodyHeight(rows);
    const contentWidth = Math.max(1, width - 4);
    const bodyText = panelBodyText(this.state);
    const bodyLines =
      this.state.phase === "streaming" || this.state.phase === "done"
        ? this.opts.renderAnswer(bodyText, contentWidth)
        : plainLines(bodyText, contentWidth);
    this.lastBodyLineCount = bodyLines.length;
    this.lastBodyHeight = bodyHeight;
    return renderPanelFrame(this.state, width, {
      styles: this.opts.styles,
      rows,
      question: this.opts.question,
      bodyLines,
    });
  }

  handleInput(data: string): void {
    const result = handlePanelKey(this.state, data, {
      bodyLineCount: this.lastBodyLineCount,
      bodyHeight: this.lastBodyHeight,
    });
    if (result.type === "close") {
      this.close();
      return;
    }
    this.state = result.state;
    this.requestRender();
  }

  invalidate(): void {
    /* 无缓存（正文渲染器自管记忆化） */
  }

  /** 流式增量（已落定/已关闭后到达的增量直接丢弃） */
  appendDelta(delta: string): void {
    if (this.closed || this.state.phase !== "streaming" || !delta) return;
    this.state = { ...this.state, answer: this.state.answer + delta };
    this.requestRender();
  }

  /** 侧调用落定：切相位（文档性说明文本由 phaseForResult 决定）；
   *  最终文本以 `done` 消息为准（有些 provider 不发 text_delta，面板不能只剩空态） */
  finish(result: SideCallResult, opts: { timedOut: boolean }): void {
    if (this.closed) return;
    const mapped = phaseForResult(result, opts.timedOut);
    const answer = result.ok && result.value.text.trim() ? result.value.text : this.state.answer;
    this.state = { ...this.state, phase: mapped.phase, errorText: mapped.errorText, answer };
    this.requestRender();
  }

  /** 关闭一次（幂等；`onClose` 抛错不影响宿主 done） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.opts.onClose();
    } catch {
      /* 关闭链路失败不阻塞 done */
    }
  }

  dispose(): void {
    /* 无外部资源 */
  }

  private safeRows(): number {
    try {
      return this.opts.rows();
    } catch {
      return 32;
    }
  }

  private requestRender(): void {
    try {
      this.opts.requestRender();
    } catch {
      /* rendering is best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// 打开面板（presenter）
// ---------------------------------------------------------------------------

export interface BtwPanelOutcome {
  /** `ctx.ui.custom` 是否真的创建了组件（false = RPC / 宿主不支持自绘，调用方走降级） */
  supported: boolean;
  /** 侧调用结果（用户提前关闭时通常为 aborted） */
  result: SideCallResult | undefined;
}

export interface BtwPanelPresenterOptions {
  question: string;
  run: (onDelta: (delta: string) => void, signal: AbortSignal) => Promise<SideCallResult>;
  controller: AbortController;
  /** 本次 abort 是否由超时看门狗触发（决定面板显示「已超时」还是「已取消」） */
  isTimedOut: () => boolean;
}

/**
 * 打开只读面板：组件一创建就启动侧调用（delta 实时进面板），用户
 * `Esc`/`q`/`ctrl+c` 关闭 = abort + done。宿主不支持自绘（factory 未被调用、
 * 或 `custom` 抛错）时回 `supported: false`，绝不假装问过。
 */
export async function presentBtwPanel(
  ui: Pick<ExtensionUIContext, "custom">,
  options: BtwPanelPresenterOptions,
): Promise<BtwPanelOutcome> {
  let factoryRan = false;
  let callPromise: Promise<SideCallResult> | undefined;
  let result: SideCallResult | undefined;
  try {
    await ui.custom<undefined>(
      (tui, theme, _keybindings, done) => {
        factoryRan = true;
        const panel = new BtwPanel({
          question: options.question,
          styles: panelStyles(theme),
          rows: () => {
            try {
              return tui.terminal.rows;
            } catch {
              return 32;
            }
          },
          requestRender: () => {
            try {
              tui.requestRender();
            } catch {
              /* rendering is best-effort */
            }
          },
          renderAnswer: makeAnswerRenderer(),
          onClose: () => {
            options.controller.abort();
            done(undefined);
          },
        });
        callPromise = options
          .run(
            (delta) => panel.appendDelta(delta),
            options.controller.signal,
          )
          .then((callResult) => {
            result = callResult;
            panel.finish(callResult, { timedOut: options.isTimedOut() });
            return callResult;
          });
        return panel;
      },
      { overlay: true, overlayOptions: BTW_OVERLAY_OPTIONS },
    );
  } catch {
    /* 宿主不支持自绘或 custom 抛错：走 supported=false 降级 */
  }
  if (callPromise) {
    try {
      result ??= await callPromise;
    } catch {
      /* run 契约上不抛错；这里只做最后兜底 */
    }
  }
  return { supported: factoryRan, result };
}
