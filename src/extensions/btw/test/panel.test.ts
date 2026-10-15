/**
 * btw 面板单测：帧几何 / 键位 reducer / 组件状态机 / presenter 降级。
 *
 * 帧是 overlay 的单物理行契约：每行恰好 width 显示列（含 CJK 双宽）——这是
 * 真机上最容易翻车的点，因此逐行断言 `visibleWidth`。presenter 用结构 fake 的
 * `ui.custom`（宿主渲染管线本身由 agent-team viewer-host 覆盖，这里只验我们的
 * 契约面：起步即跑、Esc 关 + abort、不支持自绘时如实回 supported=false）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  BtwPanel,
  PANEL_CHROME_ROWS,
  PANEL_LEGEND,
  PLAIN_PANEL_STYLES,
  computePanelBodyHeight,
  handlePanelKey,
  initialPanelState,
  panelBodyText,
  panelMaxScroll,
  phaseForResult,
  phaseLabel,
  presentBtwPanel,
  renderPanelFrame,
  type PanelState,
} from "../panel.ts";
import type { SideCallResult } from "../side-call.ts";

const WIDTH = 72;
const ROWS = 40;

const THEME_STUB = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function state(overrides: Partial<PanelState> = {}): PanelState {
  return { ...initialPanelState(), ...overrides };
}

// ---------------------------------------------------------------------------
// 布局 / 文案
// ---------------------------------------------------------------------------

test("computePanelBodyHeight：常规行数取 70% 减 chrome，异常输入兜底", () => {
  assert.equal(computePanelBodyHeight(40), 21);
  assert.equal(computePanelBodyHeight(24), 9);
  assert.ok(computePanelBodyHeight(1) >= 4, "窄屏也留得下正文");
  assert.equal(computePanelBodyHeight(Number.NaN), computePanelBodyHeight(32));
  assert.equal(computePanelBodyHeight(0), computePanelBodyHeight(32));
});

test("panelMaxScroll：内容少于窗口为 0，否则给出可滚行数", () => {
  assert.equal(panelMaxScroll(3, 10), 0);
  assert.equal(panelMaxScroll(25, 10), 15);
  assert.equal(panelMaxScroll(25, 0), 24, "窗口退化时不除零");
});

test("phaseLabel / panelBodyText：每个相位都有明确文案，空态不静默", () => {
  assert.equal(phaseLabel(initialPanelState()), "思考中…");
  assert.match(panelBodyText(initialPanelState()), /等待模型输出/);
  assert.equal(phaseLabel(state({ phase: "done" })), "已完成");
  assert.match(panelBodyText(state({ phase: "done" })), /空回答/);
  assert.equal(phaseLabel(state({ phase: "error" })), "出错");
  assert.equal(phaseLabel(state({ phase: "timeout" })), "已超时");
  assert.equal(phaseLabel(state({ phase: "aborted" })), "已取消");
  assert.equal(panelBodyText(state({ phase: "error", errorText: "401 unauthorized" })), "401 unauthorized");
});

test("phaseForResult：ok→done；aborted 按 timedOut 区分超时/取消；其余→error", () => {
  assert.deepEqual(phaseForResult({ ok: true, value: { text: "x" } }, false), { phase: "done", errorText: "" });
  assert.equal(phaseForResult({ ok: false, code: "aborted", message: "x" }, true).phase, "timeout");
  assert.equal(phaseForResult({ ok: false, code: "aborted", message: "x" }, false).phase, "aborted");
  const error = phaseForResult({ ok: false, code: "side-call-error", message: "boom" }, false);
  assert.equal(error.phase, "error");
  assert.equal(error.errorText, "boom");
});

// ---------------------------------------------------------------------------
// 帧渲染
// ---------------------------------------------------------------------------

test("帧几何：行数 = 正文窗口 + chrome，每行恰好 width 列（含 CJK）", () => {
  const bodyLines = Array.from({ length: 30 }, (_, index) => `第${index}行内容 with ascii tail`);
  const lines = renderPanelFrame(state({ phase: "done" }), WIDTH, {
    styles: PLAIN_PANEL_STYLES,
    rows: ROWS,
    question: "现在在干啥",
    bodyLines,
  });
  assert.equal(lines.length, computePanelBodyHeight(ROWS) + PANEL_CHROME_ROWS);
  for (const line of lines) assert.equal(visibleWidth(line), WIDTH);
  assert.ok(lines.some((line) => line.includes("btw 旁路对话")));
  assert.ok(lines.some((line) => line.includes("已完成")));
  assert.ok(lines.some((line) => line.includes("❯ 现在在干啥")));
  assert.ok(lines.some((line) => line.includes(PANEL_LEGEND)));
});

test("滚动窗口：正文取 scroll 起的窗口，图例右侧显示位置", () => {
  const bodyLines = Array.from({ length: 20 }, (_, index) => `line-${index}`);
  const lines = renderPanelFrame(state({ phase: "done", scroll: 5 }), WIDTH, {
    styles: PLAIN_PANEL_STYLES,
    rows: 16,
    question: "q",
    bodyLines,
  });
  const body = lines.filter((line) => line.includes("line-"));
  assert.ok(body.some((line) => line.includes("line-5")), "窗口从 scroll 开始");
  assert.ok(!body.some((line) => line.includes("line-0")), "0 号行已滚出窗口");
  assert.ok(lines.some((line) => line.includes("6/20")), "位置指示");
});

test("窄屏（< 最小宽度）只给一行提示，不崩", () => {
  const lines = renderPanelFrame(initialPanelState(), 20, {
    styles: PLAIN_PANEL_STYLES,
    rows: ROWS,
    question: "q",
    bodyLines: [],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /至少需要/);
});

test("提问压成单行并截断（长提问不把正文顶走）", () => {
  const lines = renderPanelFrame(initialPanelState(), WIDTH, {
    styles: PLAIN_PANEL_STYLES,
    rows: ROWS,
    question: `第一行\n第二行${"x".repeat(300)}`,
    bodyLines: ["body"],
  });
  const questionLines = lines.filter((line) => line.includes("❯"));
  assert.equal(questionLines.length, 1);
  assert.ok(questionLines[0]!.includes("第一行 第二行"), "换行被压平");
  assert.ok(questionLines[0]!.endsWith("│"), "提问行仍在框内");
});

// ---------------------------------------------------------------------------
// 键位
// ---------------------------------------------------------------------------

test("按键：Esc/ctrl+c/q 关闭；J/K/↑↓/PgUp/PgDn 滚动并钳位；release 事件短路", () => {
  const ctx = { bodyLineCount: 50, bodyHeight: 10 };
  const base = state({ phase: "done" });
  assert.equal(handlePanelKey(base, "\x1b", ctx).type, "close");
  assert.equal(handlePanelKey(base, "\x03", ctx).type, "close");
  assert.equal(handlePanelKey(base, "q", ctx).type, "close");

  const j = handlePanelKey(base, "J", ctx);
  assert.equal(j.type === "update" ? j.state.scroll : -1, 1);
  const k = handlePanelKey(state({ phase: "done", scroll: 3 }), "K", ctx);
  assert.equal(k.type === "update" ? k.state.scroll : -1, 2);
  const down = handlePanelKey(base, "\x1b[B", ctx);
  assert.equal(down.type === "update" ? down.state.scroll : -1, 1);
  const up = handlePanelKey(state({ phase: "done", scroll: 3 }), "\x1b[A", ctx);
  assert.equal(up.type === "update" ? up.state.scroll : -1, 2);
  const pageDown = handlePanelKey(base, "\x1b[6~", ctx);
  assert.equal(pageDown.type === "update" ? pageDown.state.scroll : -1, 10);
  const pageUp = handlePanelKey(state({ phase: "done", scroll: 25 }), "\x1b[5~", ctx);
  assert.equal(pageUp.type === "update" ? pageUp.state.scroll : -1, 15);
  const clampedLow = handlePanelKey(base, "K", ctx);
  assert.equal(clampedLow.type === "update" ? clampedLow.state.scroll : -1, 0, "上界钳位");
  const clampedHigh = handlePanelKey(state({ phase: "done", scroll: 40 }), "J", ctx);
  assert.equal(clampedHigh.type === "update" ? clampedHigh.state.scroll : -1, 40, "下界钳位（50-10）");

  const release = handlePanelKey(base, "\x1b[13;1:3u", ctx);
  assert.deepEqual(release, { type: "update", state: base }, "Kitty release 不触发第二次动作");
  const other = handlePanelKey(base, "z", ctx);
  assert.deepEqual(other, { type: "update", state: base });
});

// ---------------------------------------------------------------------------
// 组件状态机
// ---------------------------------------------------------------------------

interface PanelHarness {
  panel: BtwPanel;
  closed: () => number;
  renders: () => number;
}

function makePanel(): PanelHarness {
  let closed = 0;
  let renders = 0;
  const panel = new BtwPanel({
    question: "现在在干啥",
    styles: PLAIN_PANEL_STYLES,
    rows: () => ROWS,
    requestRender: () => {
      renders += 1;
    },
    renderAnswer: (text) => text.split("\n"),
    onClose: () => {
      closed += 1;
    },
  });
  return { panel, closed: () => closed, renders: () => renders };
}

test("组件：增量累加并请求重绘；落定后到达的增量被丢弃", () => {
  const h = makePanel();
  h.panel.appendDelta("第一段");
  h.panel.appendDelta("第二段");
  assert.ok(h.renders() >= 2);
  assert.ok(h.panel.render(WIDTH).some((line) => line.includes("第一段第二段")));
  h.panel.finish({ ok: true, value: { text: "第一段第二段" } }, { timedOut: false });
  const before = h.renders();
  h.panel.appendDelta("迟到的增量");
  assert.equal(h.renders(), before, "落定后不再重绘");
  assert.ok(!h.panel.render(WIDTH).join("\n").includes("迟到的增量"));
});

test("组件：Esc 关闭只触发一次 onClose（幂等），render 不因关闭崩", () => {
  const h = makePanel();
  h.panel.handleInput("\x1b");
  h.panel.handleInput("\x1b");
  assert.equal(h.closed(), 1);
  assert.ok(h.panel.render(WIDTH).length > 0);
});

test("组件：错误相位在正文区显示诊断文本", () => {
  const h = makePanel();
  h.panel.finish({ ok: false, code: "side-call-error", message: "401 unauthorized" }, { timedOut: false });
  const lines = h.panel.render(WIDTH);
  assert.ok(lines.some((line) => line.includes("401 unauthorized")));
  assert.ok(lines.some((line) => line.includes("出错")));
});

test("组件：超时相位显示「已超时」而不是「已取消」", () => {
  const h = makePanel();
  h.panel.finish({ ok: false, code: "aborted", message: "x" }, { timedOut: true });
  const lines = h.panel.render(WIDTH).join("\n");
  assert.ok(lines.includes("已超时"));
});

// ---------------------------------------------------------------------------
// presenter
// ---------------------------------------------------------------------------

interface FakeUiSeen {
  factories: number;
  components: BtwPanel[];
  renders: number;
}

function makeFakeUi(mode: "ok" | "no-factory" | "throw" = "ok"): {
  ui: Pick<ExtensionUIContext, "custom">;
  seen: FakeUiSeen;
} {
  const seen: FakeUiSeen = { factories: 0, components: [], renders: 0 };
  const ui = {
    custom: async (factory: unknown, _options?: unknown) => {
      if (mode === "throw") throw new Error("宿主不支持自绘");
      if (mode === "no-factory") return undefined;
      seen.factories += 1;
      return await new Promise((resolve) => {
        const create = factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: unknown) => void,
        ) => BtwPanel;
        const component = create(
          { terminal: { rows: ROWS }, requestRender: () => (seen.renders += 1) },
          THEME_STUB,
          {},
          (value) => resolve(value),
        );
        seen.components.push(component);
      });
    },
  };
  return { ui: ui as unknown as Pick<ExtensionUIContext, "custom">, seen };
}

test("presenter：组件一创建就启动侧调用，delta 实时上屏，Esc 关闭 = abort + done", async () => {
  const { ui, seen } = makeFakeUi();
  const controller = new AbortController();
  let aborts = 0;
  controller.signal.addEventListener("abort", () => (aborts += 1));
  const promise = presentBtwPanel(ui, {
    question: "现在在干啥",
    run: (onDelta, signal) =>
      new Promise((resolve) => {
        onDelta("正在读文件");
        signal.addEventListener("abort", () => resolve({ ok: false, code: "aborted", message: "已中止" }));
        setTimeout(() => resolve({ ok: true, value: { text: "正在读文件，准备改 X" } }), 5);
      }),
    controller,
    isTimedOut: () => false,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const component = seen.components[0]!;
  assert.ok(component.render(WIDTH).some((line) => line.includes("准备改 X")), "最终答案以 done 消息为准上屏");
  component.handleInput("\x1b");
  const outcome = await promise;
  assert.equal(outcome.supported, true);
  assert.equal(aborts, 1, "关闭面板即 abort 侧调用");
  assert.equal(outcome.result?.ok, true);
  assert.ok(seen.factories >= 1);
});

test("presenter：用户先关面板（调用被中止）→ outcome.result 是 aborted", async () => {
  const { ui, seen } = makeFakeUi();
  const controller = new AbortController();
  const promise = presentBtwPanel(ui, {
    question: "q",
    run: (_onDelta, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ ok: false, code: "aborted", message: "已中止" }));
      }),
    controller,
    isTimedOut: () => false,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  seen.components[0]!.handleInput("q");
  const outcome = await promise;
  assert.equal(outcome.supported, true);
  assert.equal(outcome.result?.ok, false);
  assert.equal(outcome.result?.ok === false ? outcome.result.code : "", "aborted");
});

test("presenter：宿主不支持自绘（factory 未被调用 / custom 抛错）→ supported=false，绝不假装问过", async () => {
  const noFactory = makeFakeUi("no-factory");
  const first = await presentBtwPanel(noFactory.ui, {
    question: "q",
    run: async () => ({ ok: true, value: { text: "x" } }),
    controller: new AbortController(),
    isTimedOut: () => false,
  });
  assert.equal(first.supported, false);
  assert.equal(noFactory.seen.factories, 0);

  const throwing = makeFakeUi("throw");
  const second = await presentBtwPanel(throwing.ui, {
    question: "q",
    run: async () => ({ ok: true, value: { text: "x" } }),
    controller: new AbortController(),
    isTimedOut: () => false,
  });
  assert.equal(second.supported, false);
});
