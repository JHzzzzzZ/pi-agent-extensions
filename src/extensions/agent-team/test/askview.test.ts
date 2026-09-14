/**
 * agent-team — 长提问全文视图（askview）测试
 *
 * 边界与动机：宿主对话框（ExtensionSelector/Input）把题面渲染进
 * `editorContainer`（`VStack(basis:auto, shrink:1)`），超屏部分被 `slice` 静默
 * 裁掉且无滚动；`select` 选项列表也不窗口化。长提问因此改走自绘 overlay
 * （`AskView` + `presentAskOverlay`），本文件锁三件事——分流判定（哪些题走自绘）、
 * 帧几何与滚动/窗口化（题面尾部与选中项恒可见）、键位与落定语义（Enter 提交 /
 * Esc 取消 / abort 关闭 / 自绘不可用时回退宿主对话框）。
 * 真实宿主合成路径（真 TuiMainScreen + 假终端）的锁在 viewer-ask-host.test.ts。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { askPortFrom } from "../index.ts";
import type { AskRequest } from "../ask.ts";
import {
  ASK_HOST_MAX_OPTION_CHARS,
  ASK_HOST_MAX_OPTIONS,
  ASK_OVERLAY_QUESTION_CHARS,
  ASK_VIEW_CHROME_ROWS,
  askMaxScroll,
  askOptionWindowStart,
  askQuestionLines,
  computeAskViewLayout,
  fallbackAskTitle,
  handleAskViewKey,
  initialAskViewState,
  presentAskOverlay,
  renderAskFrame,
  shouldRenderAskOverlay,
  type AskViewState,
} from "../askview.ts";
import { plainStyles, visibleWidth } from "../viewer.ts";

const styles = plainStyles();

function request(overrides: Partial<AskRequest> = {}): AskRequest {
  return { id: "q1", method: "input", title: "[dev-team] 要发到哪个环境？", ...overrides };
}

const longQuestion = (): string =>
  ["[dev-team] 部署方案二选一：", "", ...Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：${"细节".repeat(20)}`)].join("\n");

function state(overrides: Partial<AskViewState> = {}): AskViewState {
  return { ...initialAskViewState(), ...overrides };
}

// ---------------------------------------------------------------------------
// 分流
// ---------------------------------------------------------------------------

test("shouldRenderAskOverlay：短题走宿主对话框，长题/多段/选项溢出走自绘", () => {
  assert.equal(shouldRenderAskOverlay(request()), false);
  assert.equal(shouldRenderAskOverlay(request({ method: "select", options: ["staging", "prod"] })), false);
  // 字符数上限（CJK 按字符计，不按字节）
  assert.equal(shouldRenderAskOverlay(request({ title: "字".repeat(ASK_OVERLAY_QUESTION_CHARS + 1) })), true);
  assert.equal(shouldRenderAskOverlay(request({ title: "字".repeat(ASK_OVERLAY_QUESTION_CHARS) })), false);
  // 空行分段（宿主对话框会把多段方案压成一坨）
  assert.equal(shouldRenderAskOverlay(request({ title: "[dev-team] 第一段\n\n第二段" })), true);
  assert.equal(shouldRenderAskOverlay(request({ title: "[dev-team] 第一行\n第二行" })), false);
  // 选项过多 / 单项过长（会被顶出屏幕）
  const options = Array.from({ length: ASK_HOST_MAX_OPTIONS + 1 }, (_, index) => `方案 ${index + 1}`);
  assert.equal(shouldRenderAskOverlay(request({ method: "select", options })), true);
  assert.equal(
    shouldRenderAskOverlay(request({ method: "select", options: ["a".repeat(ASK_HOST_MAX_OPTION_CHARS + 1)] })),
    true,
  );
  assert.equal(
    shouldRenderAskOverlay(request({ method: "select", options: ["a".repeat(ASK_HOST_MAX_OPTION_CHARS)] })),
    false,
  );
  // confirm 只作为两键对话框，不走自绘（即便题面很长）
  assert.equal(shouldRenderAskOverlay(request({ method: "confirm", title: "字".repeat(500) })), false);
});

test("fallbackAskTitle：自绘不可用时题面换摘要 + 指路（全文在转录里）", () => {
  const title = fallbackAskTitle({ title: longQuestion() });
  assert.match(title, /全文见 \/team:view/);
  assert.ok(title.includes("部署方案二选一"));
  assert.ok(Array.from(title).length < 300, "摘要远短于原文");
});

// ---------------------------------------------------------------------------
// 帧几何 / 滚动 / 窗口化
// ---------------------------------------------------------------------------

test("askQuestionLines 保留段落结构并按显示宽度折行", () => {
  const lines = askQuestionLines("第一段\n\n第二段", 10);
  assert.deepEqual(lines.slice(0, 2), ["第一段", ""]);
  assert.ok(askQuestionLines("字".repeat(30), 10).every((line) => visibleWidth(line) <= 10));
});

test("renderAskFrame：固定行数、每行定宽、题面尾部可滚动可见", () => {
  const request10 = request({ title: longQuestion() });
  const rows = 40;
  const layout = computeAskViewLayout(rows, 0);
  const frame = renderAskFrame(request10, initialAskViewState(), 100, { styles, rows });
  assert.equal(frame.length, layout.bodyHeight + ASK_VIEW_CHROME_ROWS, "帧总行数 = bodyHeight + chrome");
  assert.ok(frame.every((line) => visibleWidth(line) === 100), "每行恰好 width 显示列（overlay 单物理行契约）");
  assert.ok(frame.some((line) => line.includes("部署方案二选一")), "题面开头在首屏");
  assert.ok(!frame.some((line) => line.includes("第 40 段")), "前置：尾部在首屏之外");

  const tail = renderAskFrame(request10, state({ scroll: 9999 }), 100, { styles, rows });
  assert.ok(tail.some((line) => line.includes("第 40 段")), "滚动到底后题面尾部可见");
  assert.ok(tail.some((line) => line.includes("输入回答")), "自由文本提问始终保留输入行");
});

test("renderAskFrame：选项窗口化——选中项恒可见、窗口外不渲染、表头给范围", () => {
  const options = Array.from({ length: 12 }, (_, index) => `方案 ${index + 1}`);
  const selectRequest = request({ method: "select", options });
  const rows = 20;
  const layout = computeAskViewLayout(rows, options.length);
  const first = renderAskFrame(selectRequest, initialAskViewState(), 100, { styles, rows });
  assert.equal(first.length, layout.bodyHeight + ASK_VIEW_CHROME_ROWS);
  assert.ok(first.some((line) => line.includes("共 12 项")), "表头报总数与窗口范围");
  assert.ok(first.some((line) => line.includes("› 方案 1")), "选中项有标记");
  assert.ok(!first.some((line) => line.includes("方案 12")), "窗口外的选项不渲染");

  const moved = renderAskFrame(selectRequest, state({ optionIndex: 11 }), 100, { styles, rows });
  assert.ok(moved.some((line) => line.includes("› 方案 12")), "窗口跟随选中项（不盲选）");
  assert.ok(!moved.some((line) => line.includes("方案 1 ")), "窗口已滚到尾部");
});

test("askMaxScroll / askOptionWindowStart：钳位（一屏装得下时为 0、窗口跟随选中）", () => {
  assert.equal(askMaxScroll(5, 10), 0);
  assert.equal(askMaxScroll(30, 10), 20);
  assert.equal(askOptionWindowStart(0, 12, 4), 0);
  assert.equal(askOptionWindowStart(11, 12, 4), 8);
  assert.equal(askOptionWindowStart(99, 3, 4), 0);
});

test("renderAskFrame：窄终端只给一行提示（不画破框）", () => {
  const frame = renderAskFrame(request(), initialAskViewState(), 20, { styles, rows: 40 });
  assert.equal(frame.length, 1);
  assert.ok(frame[0]?.includes("agent-team 提问"), "提示而不是破框");
  assert.ok(!frame[0]?.includes("╭"), "不画边框");
});

// ---------------------------------------------------------------------------
// 键位
// ---------------------------------------------------------------------------

test("handleAskViewKey：↑↓ 选项、Enter 提交选中项、Esc 取消、Kitty release 短路", () => {
  const ctx = { questionLineCount: 40, questionHeight: 10, options: ["staging", "prod"] };
  const down = handleAskViewKey(initialAskViewState(), "\x1b[B", ctx);
  assert.deepEqual(down, { type: "update", state: { scroll: 0, optionIndex: 1, input: "" } });
  assert.deepEqual(handleAskViewKey(state({ optionIndex: 1 }), "\r", ctx), { type: "answer", value: "prod" });
  assert.deepEqual(handleAskViewKey(initialAskViewState(), "\x1b", ctx), { type: "cancel" });
  assert.deepEqual(handleAskViewKey(initialAskViewState(), "\x1b[13;1:3u", ctx), {
    type: "update",
    state: { scroll: 0, optionIndex: 0, input: "" },
  });
  // select 模式下的可打印字符不进输入缓冲
  const typed = handleAskViewKey(initialAskViewState(), "x", ctx);
  assert.equal((typed as { state: AskViewState }).state.input, "");
});

test("handleAskViewKey：自由文本输入 J/K/PgUp/PgDn 滚题面、Enter 提交、backspace 退格", () => {
  const ctx = { questionLineCount: 40, questionHeight: 10, options: [] };
  const typed = handleAskViewKey(initialAskViewState(), "prod", ctx);
  assert.equal((typed as { state: AskViewState }).state.input, "prod");
  const backspaced = handleAskViewKey((typed as { state: AskViewState }).state, "\x7f", ctx);
  assert.equal((backspaced as { state: AskViewState }).state.input, "pro");
  assert.deepEqual(handleAskViewKey((typed as { state: AskViewState }).state, "\r", ctx), {
    type: "answer",
    value: "prod",
  });
  const paged = handleAskViewKey(initialAskViewState(), "\x1b[6~", ctx);
  assert.equal((paged as { state: AskViewState }).state.scroll, 10);
  const line = handleAskViewKey(initialAskViewState(), "J", ctx);
  assert.equal((line as { state: AskViewState }).state.scroll, 1);
  const up = handleAskViewKey(initialAskViewState(), "\x1b[A", ctx);
  assert.equal((up as { state: AskViewState }).state.scroll, 0, "已在顶部不再上滚");
  const capped = handleAskViewKey(initialAskViewState(), "\x1b[5~", ctx);
  assert.equal((capped as { state: AskViewState }).state.scroll, 0);
});

// ---------------------------------------------------------------------------
// presentAskOverlay + askPortFrom 接线
// ---------------------------------------------------------------------------

interface FakeCustomCall {
  factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown;
  options?: { overlay?: boolean };
}

/**
 * 仿真宿主 custom：跑 factory、保留组件、`done` 落定才 resolve（对照
 * interactive-mode.js 的 showExtensionCustom）；`unsupported` 时直接 resolve
 * undefined（RPC 主会话的 custom 形态）。
 */
function fakeCustomUi(overrides: { unsupported?: boolean } = {}): {
  ui: { custom: (factory: FakeCustomCall["factory"], options?: { overlay?: boolean }) => Promise<unknown> };
  view: () => { handleInput: (data: string) => void } | undefined;
  calls: FakeCustomCall[];
} {
  const calls: FakeCustomCall[] = [];
  let created: { handleInput: (data: string) => void } | undefined;
  const ui = {
    custom: (factory: FakeCustomCall["factory"], options?: { overlay?: boolean }): Promise<unknown> => {
      calls.push({ factory, options });
      if (overrides.unsupported) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        created = factory(
          { terminal: { rows: 40 }, requestRender: () => {} },
          { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
          undefined,
          resolve,
        ) as { handleInput: (data: string) => void };
      });
    },
  };
  return { ui, view: () => created, calls };
}

test("presentAskOverlay：自绘不可用（宿主 custom 返回 undefined）→ supported: false，不假装问过", async () => {
  const { ui } = fakeCustomUi({ unsupported: true });
  const result = await presentAskOverlay(ui as never, request({ title: longQuestion() }), new AbortController().signal);
  assert.deepEqual(result, { supported: false });
});

test("presentAskOverlay：overlay 渲染 + Enter 提交选中项，abort 只关视图", async () => {
  const { ui, view, calls } = fakeCustomUi();
  const controller = new AbortController();
  const pending = presentAskOverlay(
    ui as never,
    request({ title: longQuestion(), method: "select", options: ["staging", "prod"] }),
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options?.overlay, true, "自绘必须走 overlay（基础层会被宿主裁掉）");
  view()?.handleInput("\x1b[B");
  view()?.handleInput("\r");
  assert.deepEqual(await pending, { supported: true, answer: "prod" });

  const { ui: ui2, view: view2 } = fakeCustomUi();
  const controller2 = new AbortController();
  const pending2 = presentAskOverlay(ui2 as never, request({ title: longQuestion() }), controller2.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  view2()?.handleInput("半句回答");
  controller2.abort(); // 超时/停止：AskChannel 已定 outcome，这里只关视图
  assert.deepEqual(await pending2, { supported: true });
});

test("askPortFrom：短题不走自绘；长题自绘不可用时回退宿主对话框（题面换摘要 + 指路）", async () => {
  let customCalls = 0;
  let inputTitle = "";
  let selectTitle = "";
  const ui = {
    custom: async () => {
      customCalls += 1;
      return undefined;
    },
    input: async (title: string) => {
      inputTitle = title;
      return "ok";
    },
    select: async (title: string) => {
      selectTitle = title;
      return "staging";
    },
  };
  const port = askPortFrom({ hasUI: true, mode: "tui", ui } as never);

  const short = await port.present(request(), new AbortController().signal);
  assert.deepEqual(short, { kind: "answer", value: "ok" });
  assert.equal(customCalls, 0, "短题保持宿主对话框路径（零回归）");
  assert.equal(inputTitle, "[dev-team] 要发到哪个环境？");

  const long = await port.present(
    request({ method: "select", title: longQuestion(), options: ["staging", "prod"] }),
    new AbortController().signal,
  );
  assert.deepEqual(long, { kind: "answer", value: "staging" });
  assert.equal(customCalls, 1, "长题先尝试自绘");
  assert.match(selectTitle, /全文见 \/team:view/, "回退题面必须是摘要 + 指路");
});

test("askPortFrom：自绘可用时长题走 overlay（不经宿主对话框）", async () => {
  let selectCalls = 0;
  const { ui, view, calls } = fakeCustomUi();
  const port = askPortFrom({
    hasUI: true,
    mode: "tui",
    ui: {
      ...ui,
      select: async () => {
        selectCalls += 1;
        return "host";
      },
      input: async () => "host",
    },
  } as never);
  const pending = port.present(
    request({ method: "select", title: longQuestion(), options: ["staging", "prod"] }),
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 1);
  view()?.handleInput("\r");
  assert.deepEqual(await pending, { kind: "answer", value: "staging" });
  assert.equal(selectCalls, 0, "长题不再走宿主 select（选项会被顶出屏幕）");
});
