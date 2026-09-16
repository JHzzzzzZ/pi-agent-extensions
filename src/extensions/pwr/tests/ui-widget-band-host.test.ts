/**
 * widget 排序带 × 真实宿主 widget 栈（跨插件契约 docs/cross/status-bar.md）
 *
 * 为什么必须接真实宿主：宿主 `InteractiveMode.setExtensionWidget` 每次写入都先对
 * **两个** widget Map `Map.delete(key)` 再 `Map.set(key, component)`；JS Map 按插入序
 * 迭代 ⇒ 被刷新的 widget 沉到该栈底部，编辑器上方的三段周期性刷新 widget 因此逐秒
 * 换位。这是宿主行为，本仓库不打宿主补丁（AGENTS.md 红线 8），所以这里：
 *
 *   1) 用真实原型方法（`InteractiveMode.prototype.setExtensionWidget` /
 *      `renderWidgetContainer`）+ 真实 pi-tui 容器装配出同样的栈，**复现**三键各自
 *      刷新即换位（bug 现场，宿主升级修好后本用例会红——那是好事，届时回归契约）；
 *   2) 证明排序带把三段并成宿主单键后，连续 N 帧错位刷新下渲染顺序恒定。
 *
 * 为什么不是「纯函数断言」：顺序漂移只存在于真实 Set/Map 插入序 + 真实渲染路径里，
 * 假 ui 记日志式断言抓不到（repo 惯例：碰宿主/进程边界就接真实实现，见 AGENTS.md
 * 「测试与 QA」）。InteractiveMode 本体重（要 TUI/session），故只把原型方法喂给一个
 * 带真实 Map/容器的替身实例，其余一律是真实实现。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { refreshUiStatus } from "../src/ui/renderer.ts";
import { MemoryRunStore } from "../src/ui/run-store.ts";
import { writeBand } from "../src/ui/status-band.ts";
import { HOST_WIDGET_KEY, writeWidgetBand } from "../src/ui/widget-band.ts";

const WIDTH = 80;
/** 三段排序带键（契约 docs/cross/status-bar.md）：pwr < run-timer < loop。 */
const PWR_BAND = "10:pwr-runs";
const TIMER_BAND = "20:run-timer";
const LOOP_BAND = "30:loop";
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** 宿主原型方法（`private` 只在类型层，运行时就是原型方法）。 */
type HostPrototype = {
  setExtensionWidget(
    this: unknown,
    key: string,
    content: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  renderWidgetContainer(
    this: unknown,
    container: Container,
    widgets: Map<string, Component>,
    spacerWhenEmpty: boolean,
    leadingSpacer: boolean,
  ): void;
};

interface HostStack {
  ui: {
    setWidget(key: string, content?: string[], options?: { placement?: "aboveEditor" | "belowEditor" }): void;
    setStatus(key: string, text: string | undefined): void;
  };
  /** 每次写入的原始入参（含宿主键），用来证明「只写单键」。 */
  calls: Array<{ key: string; lines: string[] | undefined }>;
  /** 编辑器上方栈的键顺序（= 宿主渲染顺序）。 */
  keys(): string[];
  /** 编辑器上方区域真实渲染出的行（去 ANSI/两边空白，去空行）。 */
  screen(): string[];
}

function createHostStack(): HostStack {
  const methods = InteractiveMode.prototype as unknown as HostPrototype;
  const above = new Container();
  const calls: Array<{ key: string; lines: string[] | undefined }> = [];
  const instance = {
    extensionWidgetsAbove: new Map<string, Component>(),
    extensionWidgetsBelow: new Map<string, Component>(),
    renderWidgets(): void {
      methods.renderWidgetContainer.call(instance, above, instance.extensionWidgetsAbove, true, true);
    },
  };
  const ui = {
    setWidget: (key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void => {
      calls.push({ key, lines });
      methods.setExtensionWidget.call(instance, key, lines, options);
    },
    setStatus: (): void => {},
  };
  return {
    ui,
    calls,
    keys: () => [...instance.extensionWidgetsAbove.keys()],
    screen: () =>
      above
        .render(WIDTH)
        .map((line) => line.replace(ANSI, "").trim())
        .filter((line) => line.length > 0),
  };
}

/** 清三段登记（登记表在 globalThis，跨用例共享）。 */
function clearBands(stack: HostStack): void {
  for (const key of [PWR_BAND, TIMER_BAND, LOOP_BAND]) writeWidgetBand(key, undefined, stack.ui as never);
  // footer 排序带（测试 D 经 refreshUiStatus 登记过 30:pwr）一并清掉，避免跨用例串味。
  writeBand("30:pwr", undefined, (text) => stack.ui.setStatus("30:pwr", text));
}

test("宿主 bug 现场：三个独立键各自刷新时被刷新的 widget 沉底（顺序逐次换位）", () => {
  const stack = createHostStack();
  stack.ui.setWidget("pwr-runs", ["PWR runs:"]);
  stack.ui.setWidget("run-timer", ["任务 00:01"]);
  stack.ui.setWidget("loop", ["⏰ loop 1 个任务"]);
  assert.deepEqual(stack.screen(), ["PWR runs:", "任务 00:01", "⏰ loop 1 个任务"]);

  stack.ui.setWidget("run-timer", ["任务 00:02"]);
  assert.deepEqual(
    stack.screen(),
    ["PWR runs:", "⏰ loop 1 个任务", "任务 00:02"],
    "刚刷新过的 run-timer 沉到栈底（用户看到的「逐秒换位」）",
  );

  stack.ui.setWidget("loop", ["⏰ loop 1 个任务 · 下次 04:32"]);
  assert.deepEqual(
    stack.screen(),
    ["PWR runs:", "任务 00:02", "⏰ loop 1 个任务 · 下次 04:32"],
    "下一个刷新者又沉底——顺序每秒重排",
  );
});

test("排序带：三段错位刷新 12 帧，宿主只剩单键且渲染顺序恒定", () => {
  const stack = createHostStack();
  const segments = [
    { key: PWR_BAND, lines: (frame: number) => [`PWR runs: f${frame}`, `▶ 00000042 audit f${frame}`] },
    { key: TIMER_BAND, lines: (frame: number) => [`任务 00:0${frame % 10} · 本轮 00:0${frame % 10}`] },
    { key: LOOP_BAND, lines: (frame: number) => [`⏰ loop 1 个任务 · 下次 04:${String(32 + frame).padStart(2, "0")}`] },
  ];
  try {
    /** 各段最后一次提交的行（未登记的段为 undefined，不参与合并）。 */
    const current: Array<string[] | undefined> = [undefined, undefined, undefined];
    for (let frame = 0; frame < 12; frame++) {
      const index = frame % 3;
      const segment = segments[index]!;
      current[index] = segment.lines(frame);
      writeWidgetBand(segment.key, current[index], stack.ui as never);

      assert.deepEqual(stack.keys(), [HOST_WIDGET_KEY], `第 ${frame} 帧宿主栈里只有合并键`);
      assert.deepEqual(
        stack.screen(),
        current.flatMap((lines) => lines ?? []),
        `第 ${frame} 帧渲染顺序恒定（按 band key：pwr → run-timer → loop）`,
      );
    }
    assert.ok(
      stack.calls.every((call) => call.key === HOST_WIDGET_KEY),
      "任何一次刷新都只写宿主单键",
    );
  } finally {
    clearBands(stack);
  }
});

test("排序带：owner 段清空自动移交（无残行），全空卸载宿主键", () => {
  const stack = createHostStack();
  try {
    writeWidgetBand(PWR_BAND, ["PWR runs:"], stack.ui as never);
    writeWidgetBand(TIMER_BAND, ["任务 00:01"], stack.ui as never);
    writeWidgetBand(LOOP_BAND, ["⏰ loop 1 个任务"], stack.ui as never);
    assert.deepEqual(stack.screen(), ["PWR runs:", "任务 00:01", "⏰ loop 1 个任务"]);

    writeWidgetBand(PWR_BAND, undefined, stack.ui as never);
    assert.deepEqual(stack.screen(), ["任务 00:01", "⏰ loop 1 个任务"], "owner 退出后其余段照旧，无残行");

    writeWidgetBand(TIMER_BAND, ["任务 00:02"], stack.ui as never);
    assert.deepEqual(stack.screen(), ["任务 00:02", "⏰ loop 1 个任务"], "移交后刷新仍保序");

    writeWidgetBand(TIMER_BAND, undefined, stack.ui as never);
    writeWidgetBand(LOOP_BAND, undefined, stack.ui as never);
    assert.deepEqual(stack.keys(), [], "三段全空 → 宿主键卸载");
    assert.deepEqual(stack.screen(), [], "屏上不再有 widget 行");
  } finally {
    clearBands(stack);
  }
});

test("pwr 真实写入器经排序带写入：宿主单键、与兄弟段同序", () => {
  const store = new MemoryRunStore();
  const stack = createHostStack();
  try {
    refreshUiStatus(stack.ui as never, store);
    writeWidgetBand(LOOP_BAND, ["⏰ loop 1 个任务"], stack.ui as never);

    assert.deepEqual(stack.keys(), [HOST_WIDGET_KEY], "pwr 的 widget 不再独占自己的宿主键");
    const screen = stack.screen();
    const pwrAt = screen.findIndex((line) => line.includes("PWR runs"));
    const loopAt = screen.findIndex((line) => line.includes("loop"));
    assert.ok(pwrAt >= 0, "pwr 段在屏上");
    assert.ok(loopAt > pwrAt, "pwr 段（band 10）在 loop 段（band 30）之前");

    writeWidgetBand(LOOP_BAND, ["⏰ loop 1 个任务 · 下次 04:32"], stack.ui as never);
    assert.deepEqual(stack.keys(), [HOST_WIDGET_KEY], "兄弟段刷新不引入第二个宿主键");
    assert.ok(stack.screen()[pwrAt]!.includes("PWR runs"), "兄弟段刷新后 pwr 段位置不变");
  } finally {
    clearBands(stack);
  }
});
