/**
 * agent-team — 长提问全文视图（overlay）
 *
 * 宿主对话框（`ExtensionSelectorComponent` / `ExtensionInputComponent`）把题面
 * 渲染进 `editorContainer`（`VStack(basis:auto, shrink:1)`），超出屏幕高度的行
 * 被 `slice` 静默裁掉且无滚动；`select` 的选项列表也不窗口化——题面一长，选项
 * 被顶出屏幕，用户只能盲选。扩展 API 改不了宿主组件，只能换一条路：长提问改走
 * `ctx.ui.custom(…, { overlay: true })` 自绘一层，题面全文 + 选项窗口都在我们
 * 自己的滚动窗口里。
 *
 * 方案与边界（对齐文档 todos/align/agent-team-todo#58.md）：
 * - 短题（≤ `ASK_OVERLAY_QUESTION_CHARS` 字符、无空行分段、选项 ≤ 5 且每项
 *   ≤ 60 字符）继续走宿主对话框——常用路径零回归；判定是纯函数
 *   `shouldRenderAskOverlay`。
 * - 长题走本视图：题面按显示宽度折行、J/K 逐行、PgUp/PgDn 翻页；选项窗口跟随
 *   选中项；`select` 用方向键选，`input` 用手写单行输入缓冲（回答上限仍由
 *   `MAX_ASK_ANSWER_BYTES` 收口，长回答输入是独立条目）。
 * - 超时/取消语义不变：接 `AskChannel` 的 abort signal，超时/停止/落定一律关
 *   视图并回 `cancelled`（fail-closed）；自绘不可用（RPC 主会话、`custom` 抛
 *   错）时 `supported: false`，由调用方回退宿主对话框。
 * - overlay 内**不放每秒跳动文本**：真机事故实锤（viewer titleRow 注释）每秒
 *   变化的 overlay 行会是纵向堆叠物本身，超时只以静态文案呈现。
 */

import { isKeyRelease, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { MAX_ASK_ANSWER_BYTES, resolveAskTimeout, type AskRequest } from "./ask.ts";
import {
  computeFrameHeight,
  fitLine,
  themeStyles,
  truncateVisible,
  visibleWidth,
  wrapText,
  VIEWER_OVERLAY_OPTIONS,
  type Styles,
} from "./viewer.ts";

/**
 * 题面字符数超过它即走自绘（全题面按显示宽度折行，CJK 按字符计）。
 * 200 字符 ≈ 宿主对话框在 40 行终端里还能把题面 + 选项一起装下的量级。
 */
export const ASK_OVERLAY_QUESTION_CHARS = 200;

/** 宿主 `select` 最多能同时装下多少选项（再多就窗口化）。 */
export const ASK_HOST_MAX_OPTIONS = 5;

/** 宿主 `select` 单个选项的字符上限（再长就窗口化）。 */
export const ASK_HOST_MAX_OPTION_CHARS = 60;

/** 回退宿主对话框时的题面摘要字符数。 */
export const ASK_FALLBACK_PREVIEW_CHARS = 120;

/**
 * 自绘帧的固定 chrome 行数（上边框 / 标题 / 两条分隔线 / 图例 / 下边框）——
 * 帧总行数恒为 `bodyHeight + ASK_VIEW_CHROME_ROWS`，与 viewer 同口径
 * （`VIEWER_CHROME_ROWS`）。
 */
export const ASK_VIEW_CHROME_ROWS = 6;

/** 自绘视图的最小终端宽度（与 viewer 同门禁：窄于此只给一行提示）。 */
export const ASK_MIN_WIDTH = 36;

export const ASK_LEGEND_SELECT = "↑↓ 选项 · J/K 滚动 · PgUp/PgDn 翻页 · Enter 提交 · Esc 取消";
export const ASK_LEGEND_INPUT = "J/K 滚动 · PgUp/PgDn 翻页 · Enter 提交 · Esc 取消";

/** 纯输入型提问（自由文本）在帧里的输入行前缀。 */
const INPUT_PROMPT = "❯ ";

// ---------------------------------------------------------------------------
// 分流（纯函数）
// ---------------------------------------------------------------------------

/**
 * 该提问是否需要自绘全文视图：题面过长（> `ASK_OVERLAY_QUESTION_CHARS` 字符）、
 * 含空行分段（宿主对话框会把多段方案压成一坨）、选项过多/过长（会被顶出屏幕）。
 * 只有 `select` / `input` 两种方法参与——`confirm` 仍是宿主两键对话框。
 */
export function shouldRenderAskOverlay(request: Pick<AskRequest, "method" | "title" | "options">): boolean {
  if (request.method !== "select" && request.method !== "input") return false;
  if (Array.from(request.title).length > ASK_OVERLAY_QUESTION_CHARS) return true;
  if (/\n[ \t]*\n/.test(request.title)) return true;
  const options = request.options ?? [];
  if (options.length > ASK_HOST_MAX_OPTIONS) return true;
  return options.some((option) => Array.from(option).length > ASK_HOST_MAX_OPTION_CHARS);
}

/**
 * 自绘不可用时（RPC 主会话 / 宿主 `custom` 不支持）的宿主对话框题面：摘要 +
 * 指路。全文已在 `questionEntryText` 的「提问：」块里（`/team:view` 可看），
 * 所以这里只保证用户知道去哪儿找，而不是看到一份被静默裁掉的题面。
 */
export function fallbackAskTitle(request: Pick<AskRequest, "title">): string {
  const flat = request.title.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  const head = chars.slice(0, ASK_FALLBACK_PREVIEW_CHARS).join("");
  const ellipsis = chars.length > ASK_FALLBACK_PREVIEW_CHARS ? "…" : "";
  return `[题面较长，这里只显示前 ${ASK_FALLBACK_PREVIEW_CHARS} 字符；全文见 /team:view 的「提问：」块]\n${head}${ellipsis}`;
}

// ---------------------------------------------------------------------------
// 视图状态与布局（纯函数）
// ---------------------------------------------------------------------------

/** 自绘视图的易变状态（滚动 / 选项下标 / 输入缓冲）。 */
export interface AskViewState {
  /** 题面窗口的首行下标。 */
  scroll: number;
  /** 选项下标（无选项时恒 0）。 */
  optionIndex: number;
  /** 自由文本答案缓冲（无选项时使用）。 */
  input: string;
}

export function initialAskViewState(): AskViewState {
  return { scroll: 0, optionIndex: 0, input: "" };
}

export interface AskViewLayout {
  bodyHeight: number;
  questionHeight: number;
  /** 选项区行数（含表头；无选项时为 0）。 */
  optionsHeight: number;
  /** 输入区行数（表头 + 输入行；有选项时为 0）。 */
  inputHeight: number;
}

/**
 * 帧布局：正文区（`computeFrameHeight`，与 viewer 同公式）切成「题面窗口 +
 * 底部交互区」。有选项时交互区最多占正文一半（表头 + 窗口化选项）；自由文本
 * 时固定 2 行（表头 + 输入行）。
 */
export function computeAskViewLayout(rows: number, optionCount: number): AskViewLayout {
  const bodyHeight = computeFrameHeight(rows);
  if (optionCount > 0) {
    const optionsHeight = Math.min(optionCount + 1, Math.max(3, Math.floor(bodyHeight / 2)));
    return { bodyHeight, questionHeight: Math.max(1, bodyHeight - optionsHeight), optionsHeight, inputHeight: 0 };
  }
  return { bodyHeight, questionHeight: Math.max(1, bodyHeight - 2), optionsHeight: 0, inputHeight: 2 };
}

/** 题面行（按显示宽度折行，段落结构保留）。 */
export function askQuestionLines(question: string, width: number): string[] {
  return wrapText(question, Math.max(1, width));
}

/** 题面窗口最大滚动量（0 = 一屏装得下）。 */
export function askMaxScroll(questionLineCount: number, questionHeight: number): number {
  return Math.max(0, questionLineCount - questionHeight);
}

/** 选项窗口起点：跟随选中项，绝不把选中项滚出窗口（viewer roster 同款钳位）。 */
export function askOptionWindowStart(optionIndex: number, optionCount: number, windowHeight: number): number {
  const height = Math.max(1, windowHeight);
  const selected = Math.min(Math.max(0, optionIndex), Math.max(0, optionCount - 1));
  return Math.max(0, Math.min(selected - height + 1, Math.max(0, optionCount - height)));
}

/** 超时的静态文案（overlay 内不放每秒跳动文本，见文件头注）。 */
export function askTimeoutLabel(timeoutMs: number | undefined): string {
  const ms = resolveAskTimeout(timeoutMs);
  if (ms < 60_000) return `超时：${Math.round(ms / 1000)} 秒后自动取消`;
  const minutes = Math.round(ms / 60_000);
  return `超时：${minutes} 分钟后自动取消`;
}

// ---------------------------------------------------------------------------
// 帧渲染（纯函数）
// ---------------------------------------------------------------------------

/** 右对齐一行（左内容截断、右内容保留）——与 viewer 的 titleRow 同口径。 */
function rightAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fitLine(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fitLine(right, rightWidth);
}

/**
 * 渲染提问帧：固定 `bodyHeight + ASK_VIEW_CHROME_ROWS` 行、每行恰好 `width`
 * 显示列（`fitLine` 收口，overlay 单物理行契约）。正文 = 题面窗口 + 底部交互区
 * （选项窗口 / 输入行）。题面窗口跟随 `state.scroll`，选项窗口跟随
 * `state.optionIndex`——屏上永远能看到当前选中项与题面当前位置。
 */
export function renderAskFrame(
  request: AskRequest,
  state: AskViewState,
  width: number,
  opts: { styles: Styles; rows: number },
): string[] {
  const styles = opts.styles;
  if (width < ASK_MIN_WIDTH) {
    return [fitLine(`agent-team 提问至少需要 ${ASK_MIN_WIDTH} 列。Esc 取消。`, width)];
  }
  const innerWidth = Math.max(0, width - 2);
  const contentWidth = Math.max(1, innerWidth - 2);
  const options = request.options ?? [];
  const layout = computeAskViewLayout(opts.rows, options.length);
  const question = askQuestionLines(request.title, contentWidth);
  const scroll = Math.min(Math.max(0, state.scroll), askMaxScroll(question.length, layout.questionHeight));

  // 正文：题面窗口
  const body: string[] = [];
  for (let index = 0; index < layout.questionHeight; index++) {
    body.push(` ${fitLine(question[scroll + index] ?? "", contentWidth)}`);
  }
  // 正文：底部交互区
  if (layout.optionsHeight > 0) {
    const windowHeight = layout.optionsHeight - 1; // 表头占 1 行
    const start = askOptionWindowStart(state.optionIndex, options.length, windowHeight);
    const selected = Math.min(Math.max(0, state.optionIndex), Math.max(0, options.length - 1));
    const range = `${start + 1}-${Math.min(options.length, start + windowHeight)}`;
    body.push(styles.dim(` 可选（共 ${options.length} 项，显示 ${range}，↑↓ 选择）：`));
    for (let index = start; index < Math.min(options.length, start + windowHeight); index++) {
      const option = options[index] ?? "";
      const marker = index === selected ? styles.accent("›") : " ";
      const label = index === selected ? styles.accent(option) : option;
      body.push(` ${marker} ${fitLine(label, contentWidth - 2)}`);
    }
  } else {
    body.push(styles.dim(" 输入回答（自由文本，Enter 提交）："));
    const line = `${INPUT_PROMPT}${state.input}▏`;
    body.push(` ${styles.accent(truncateVisible(line, contentWidth))}`);
  }

  const right = options.length > 0 ? `选择 ${Math.min(state.optionIndex + 1, options.length)}/${options.length} ` : "输入回答 ";
  const legend = options.length > 0 ? ASK_LEGEND_SELECT : ASK_LEGEND_INPUT;
  const lines = [
    styles.border(`╭${"─".repeat(innerWidth)}╮`),
    styles.border("│") + rightAligned(styles.bold(" agent-team 提问"), right, innerWidth) + styles.border("│"),
    styles.border(`├${"─".repeat(innerWidth)}┤`),
    ...body.map((line) => styles.border("│") + fitLine(line, innerWidth) + styles.border("│")),
    styles.border(`├${"─".repeat(innerWidth)}┤`),
    styles.border("│") + fitLine(rightAligned(legend, askTimeoutLabel(request.timeoutMs), innerWidth), innerWidth) + styles.border("│"),
    styles.border(`╰${"─".repeat(innerWidth)}╯`),
  ];
  return lines.map((line) => fitLine(line, width));
}

// ---------------------------------------------------------------------------
// 按键（纯函数）
// ---------------------------------------------------------------------------

export interface AskViewKeyContext {
  /** 题面总行数（上次渲染）。 */
  questionLineCount: number;
  /** 题面窗口高度（上次渲染）。 */
  questionHeight: number;
  /** 选项文本（`select` 有，`input` 空数组）。 */
  options: string[];
}

export type AskViewKeyResult =
  | { type: "update"; state: AskViewState }
  | { type: "answer"; value: string }
  | { type: "cancel" };

/** 大写绑定（`J`/`K`）= shift + 小写，与 viewer 的 `matchesViewerBinding` 同构。 */
function matchesBinding(data: string, binding: string): boolean {
  const key = /^[A-Z]$/.test(binding) ? `shift+${binding.toLowerCase()}` : binding;
  return matchesKey(data, key as Parameters<typeof matchesKey>[1]);
}

/** 可打印输入判定（含 CJK 与粘贴串；转义序列与控制字符不算）。 */
function isPrintableInput(data: string): boolean {
  if (data.length === 0 || data.startsWith("\x1b")) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * 纯键位 reducer：`↑↓` 选选项（无选项时滚题面）、`J/K` 逐行滚题面、
 * `PgUp/PgDn` 翻页、`Enter` 提交（选中项或输入缓冲）、`Esc`/`ctrl+c` 取消；
 * 无选项时其余可打印字符进输入缓冲（上限 `MAX_ASK_ANSWER_BYTES`），
 * `backspace` 退格。Kitty 键盘协议的 release 事件统一短路（一次按键只生效一次）。
 */
export function handleAskViewKey(state: AskViewState, data: string, ctx: AskViewKeyContext): AskViewKeyResult {
  if (isKeyRelease(data)) return { type: "update", state };
  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return { type: "cancel" };
  const maxScroll = askMaxScroll(ctx.questionLineCount, ctx.questionHeight);
  const scrollBy = (delta: number): AskViewKeyResult => ({
    type: "update",
    state: { ...state, scroll: Math.max(0, Math.min(maxScroll, state.scroll + delta)) },
  });
  if (matchesKey(data, "enter")) {
    if (ctx.options.length > 0) {
      const index = Math.min(Math.max(0, state.optionIndex), ctx.options.length - 1);
      return { type: "answer", value: ctx.options[index] ?? "" };
    }
    return { type: "answer", value: state.input };
  }
  if (matchesKey(data, "pageUp")) return scrollBy(-ctx.questionHeight);
  if (matchesKey(data, "pageDown")) return scrollBy(ctx.questionHeight);
  if (matchesBinding(data, "K")) return scrollBy(-1);
  if (matchesBinding(data, "J")) return scrollBy(1);
  if (matchesKey(data, "up") || matchesKey(data, "down")) {
    const delta = matchesKey(data, "up") ? -1 : 1;
    if (ctx.options.length > 0) {
      const next = Math.min(Math.max(0, state.optionIndex + delta), Math.max(0, ctx.options.length - 1));
      return { type: "update", state: { ...state, optionIndex: next } };
    }
    return scrollBy(delta);
  }
  if (ctx.options.length > 0) return { type: "update", state }; // select 模式不收集输入
  if (matchesKey(data, "backspace")) {
    return { type: "update", state: { ...state, input: Array.from(state.input).slice(0, -1).join("") } };
  }
  if (isPrintableInput(data)) {
    const next = state.input + data;
    if (Buffer.byteLength(next, "utf8") > MAX_ASK_ANSWER_BYTES) return { type: "update", state };
    return { type: "update", state: { ...state, input: next } };
  }
  return { type: "update", state };
}

// ---------------------------------------------------------------------------
// pi-tui 组件
// ---------------------------------------------------------------------------

export interface AskViewOptions {
  styles: Styles;
  /** 终端行数（宿主 tui.terminal.rows）。 */
  rows: () => number;
  requestRender: () => void;
  /** 视图落定：带答案（提交）或 undefined（取消/超时/停止）。 */
  done: (value: string | undefined) => void;
}

/** overlay 组件：题面 + 选项/输入；`close()` 幂等（超时与用户按键可能同时到）。 */
export class AskView implements Component {
  private readonly request: AskRequest;
  private readonly opts: AskViewOptions;
  private state: AskViewState = initialAskViewState();
  private lastQuestionLines = 1;
  private lastQuestionHeight = 1;
  private finished = false;

  constructor(request: AskRequest, opts: AskViewOptions) {
    this.request = request;
    this.opts = opts;
  }

  render(width: number): string[] {
    const rows = this.safeRows();
    const options = this.request.options ?? [];
    const layout = computeAskViewLayout(rows, options.length);
    this.lastQuestionLines = askQuestionLines(this.request.title, Math.max(1, width - 4)).length;
    this.lastQuestionHeight = layout.questionHeight;
    return renderAskFrame(this.request, this.state, width, { styles: this.opts.styles, rows });
  }

  handleInput(data: string): void {
    const result = handleAskViewKey(this.state, data, {
      questionLineCount: this.lastQuestionLines,
      questionHeight: this.lastQuestionHeight,
      options: this.request.options ?? [],
    });
    if (result.type === "cancel") {
      this.close(undefined);
      return;
    }
    if (result.type === "answer") {
      this.close(result.value);
      return;
    }
    this.state = result.state;
    this.requestRender();
  }

  invalidate(): void {
    /* stateless rendering — nothing cached */
  }

  /** 落定一次（幂等）：`undefined` = 未获回答。 */
  close(value: string | undefined): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.opts.done(value);
    } catch {
      /* 宿主 done 失败不改变语义：AskChannel 侧仍有 backstop */
    }
  }

  private safeRows(): number {
    try {
      return this.opts.rows();
    } catch {
      return 30;
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

/** 自绘落定结果：`supported: false` = 宿主不支持自绘，调用方需回退宿主对话框。 */
export interface AskOverlayOutcome {
  supported: boolean;
  answer?: string;
}

/**
 * 打开自绘提问 overlay（几何：`VIEWER_OVERLAY_OPTIONS`，与 viewer 同观感）。
 * abort（超时 / run 停止 / 落定）只是关视图——`AskChannel` 已经以先到者为准
 * 定过 outcome，这里不参与判定。factory 未被调用（RPC 主会话的 `custom` 直接
 * 返回 undefined）时回 `supported: false`，绝不假装问过用户。
 */
export async function presentAskOverlay(
  ui: Pick<ExtensionUIContext, "custom">,
  request: AskRequest,
  signal: AbortSignal,
): Promise<AskOverlayOutcome> {
  let factoryRan = false;
  let close: ((value: string | undefined) => void) | undefined;
  const onAbort = (): void => {
    close?.(undefined);
  };
  const detach = (): void => {
    try {
      signal.removeEventListener("abort", onAbort);
    } catch {
      /* signal 已不可用 */
    }
  };
  try {
    const answer = await ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        factoryRan = true;
        const view = new AskView(request, {
          styles: themeStyles(theme as Theme),
          rows: () => {
            try {
              return tui.terminal.rows;
            } catch {
              return 30;
            }
          },
          requestRender: () => {
            try {
              tui.requestRender();
            } catch {
              /* rendering is best-effort */
            }
          },
          done: (value) => {
            detach();
            done(value);
          },
        });
        close = (value) => view.close(value);
        if (signal.aborted) queueMicrotask(onAbort);
        else signal.addEventListener("abort", onAbort, { once: true });
        return view;
      },
      { overlay: true, overlayOptions: VIEWER_OVERLAY_OPTIONS },
    );
    return { supported: factoryRan, ...(typeof answer === "string" ? { answer } : {}) };
  } catch {
    return { supported: factoryRan };
  } finally {
    detach();
  }
}

