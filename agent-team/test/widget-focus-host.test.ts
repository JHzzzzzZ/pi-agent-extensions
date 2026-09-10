/**
 * agent-team — widget 焦点门控经真实宿主输入路径（headless）
 *
 * 前车之鉴（repo 约定：宿主/进程边界上"纸面正确"的纯函数测试抓不住真问题）：
 * 本 bug 的关键在 pi-tui 真实的输入分发顺序——扩展 `onTerminalInput` 监听器
 * **先于**聚焦组件收到按键（`TuiBase.handleTerminalInput`），监听器 consume
 * 则聚焦的选择器永远收不到键（/login 抢键即此）。本文件把真实
 * `TuiMainScreen` + 假终端接起来：`start()` 拿到真实终端输入回调，经
 * `tui.addInputListener` 挂真实 `RunWidgetController` + 真实
 * `probeEditorFocus`，焦点用宿主真实组件（`CustomEditor` /
 * `OAuthSelectorComponent` / `ExtensionSelectorComponent`）设置，断言只有
 * 主编辑器聚焦时 widget 才吃键、选择器聚焦时方向键完整让行。
 *
 * 仓库惯例"测试中不实例化真实 pi-tui"在此文件破例：焦点判定与监听器分发
 * 顺序只存在于真实宿主路径里（同 viewer-host.test.ts 的理由）。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { CustomEditor, ExtensionSelectorComponent, OAuthSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { RunStatusSnapshot } from "../cockpit.ts";
import { plainStyles } from "../viewer.ts";
import { RunWidgetController, probeEditorFocus } from "../widget.ts";

const KEY_DOWN = "\x1b[B"; // bare ↓

// 宿主选择器组件构造时读全局 theme（未初始化会抛）；用宿主默认主题初始化。
initTheme();

function liveSnapshot(): RunStatusSnapshot {
  return {
    running: true,
    progress: {
      runId: "r",
      team: "dev-team",
      task: "修复登录 bug",
      startedAtMs: 0,
      leaderModel: "m1",
      leaderNote: "turn 2",
      leaderActivity: "正在审查成员结果",
      members: [{ name: "frontend", status: "running", note: "turn 1" }],
    },
    lastRecord: null,
  };
}

/** 假终端：`start()` 捕获真实输入回调，其余全 no-op（渲染字节流不参与本用例）。 */
function fakeTerminal() {
  let onInput: ((data: string) => void) | undefined;
  const term = {
    columns: 100,
    rows: 30,
    start(cb: (data: string) => void): void {
      onInput = cb;
    },
    stop(): void {},
    drainInput(): Promise<void> {
      return Promise.resolve();
    },
    write(): void {},
    get kittyProtocolActive(): boolean {
      return false;
    },
    moveBy(): void {},
    hideCursor(): void {},
    showCursor(): void {},
    clearLine(): void {},
    clearFromCursor(): void {},
    clearScreen(): void {},
    setTitle(): void {},
    setProgress(): void {},
  };
  return {
    term,
    dispatch(data: string): void {
      assert.ok(onInput, "start 后应捕获到真实输入回调");
      onInput(data);
    },
  };
}

/** 宿主编辑器主题（CustomEditor 只把它存下来，渲染不参与本用例）。 */
function editorTheme(): never {
  return { borderColor: (text: string): string => text, selectList: {} } as never;
}

const cursorRow = (lines: string[]): number => lines.findIndex((line) => line.startsWith("▸ "));
const lastLines = (pushed: Array<string[] | undefined>): string[] => pushed[pushed.length - 1] ?? [];

/** 真实 controller + 真实 probeEditorFocus 挂到真实 TUI 的输入监听上。 */
function mountController(tui: TuiMainScreen): { controller: RunWidgetController; pushed: Array<string[] | undefined> } {
  const pushed: Array<string[] | undefined> = [];
  const controller = new RunWidgetController(
    {
      load: liveSnapshot,
      styles: plainStyles(),
      onConfirm: () => {},
      width: () => 100,
      nowMs: () => 65000,
      tickMs: 60 * 60 * 1000, // 定时器不参与：按键路径同步驱动
      editorState: () => ({ text: "" }), // 空编辑器：裸 ↓ 的 canActivate 门开
      editorFocus: () => probeEditorFocus(tui),
    },
    (lines) => {
      pushed.push(lines);
    },
    (handler) => tui.addInputListener(handler),
  );
  controller.start();
  return { controller, pushed };
}

test("真实宿主：焦点在主编辑器（CustomEditor）→ 裸 ↓ 被 widget 消费并展开（防门控永不开）", () => {
  const { term, dispatch } = fakeTerminal();
  const tui = new TuiMainScreen(term as never);
  const { controller, pushed } = mountController(tui);
  try {
    tui.start();
    const editor = new CustomEditor(tui as never, editorTheme(), { matches: () => false } as never);
    tui.setFocus(editor);
    assert.equal(probeEditorFocus(tui), true, "真 CustomEditor 必须通过编辑器形状判定");

    const before = lastLines(pushed);
    assert.equal(before.length, 1, "默认帧为折叠单行");
    assert.match(before[0]!, /agent-team dev-team · ↓\/← 查看详情/);

    dispatch(KEY_DOWN);
    const after = lastLines(pushed);
    assert.equal(cursorRow(after), 0, "编辑器焦点时裸 ↓ 照常激活");
    // 树行：main + leader + 1 成员 + 任务 = 4 行，加底部提示行。
    assert.equal(after.length, 4, "真实 ↓ 分发后展开为树行（main/leader/1 成员）+ 提示行");
    assert.equal(after[0], "▸ main");
    assert.match(after[1], /^ {2}leader dev-team · 修复登录 bug ▶ running/);
    assert.match(after[2], /^ {2}\|- frontend ● running/);
    assert.match(after[after.length - 1]!, /↑↓ 选择/);
  } finally {
    controller.stop();
    tui.stop();
  }
});

test("真实宿主：焦点在 /login 选择器（OAuthSelectorComponent）→ 裸 ↓ 让行给选择器，widget 不选中", () => {
  const { term, dispatch } = fakeTerminal();
  const tui = new TuiMainScreen(term as never);
  const { controller, pushed } = mountController(tui);
  try {
    tui.start();
    const selector = new OAuthSelectorComponent(
      "login",
      [{ id: "p1", name: "Provider", authType: "api_key" }],
      () => {},
      () => {},
    );
    const received: string[] = [];
    selector.handleInput = (data: string): void => {
      received.push(data);
    };
    tui.setFocus(selector);
    assert.equal(probeEditorFocus(tui), false, "真登录选择器必须判定为非编辑器");

    dispatch(KEY_DOWN);
    assert.deepEqual(received, [KEY_DOWN], "选择器必须收到方向键（widget 不得抢键）");
    assert.equal(cursorRow(lastLines(pushed)), -1, "widget 不得进入选中");
    assert.equal(lastLines(pushed).length, 1, "widget 保持折叠单行");
  } finally {
    controller.stop();
    tui.stop();
  }
});

test("真实宿主：焦点在扩展选择器（ExtensionSelectorComponent，ctx.ui.select 类对话框）→ 裸 ↓ 让行", () => {
  const { term, dispatch } = fakeTerminal();
  const tui = new TuiMainScreen(term as never);
  const { controller, pushed } = mountController(tui);
  try {
    tui.start();
    const selector = new ExtensionSelectorComponent("选择", ["a", "b"], () => {}, () => {});
    const received: string[] = [];
    selector.handleInput = (data: string): void => {
      received.push(data);
    };
    tui.setFocus(selector);
    assert.equal(probeEditorFocus(tui), false, "扩展选择器必须判定为非编辑器");

    dispatch(KEY_DOWN);
    assert.deepEqual(received, [KEY_DOWN], "选择器必须收到方向键（widget 不得抢键）");
    assert.equal(cursorRow(lastLines(pushed)), -1, "widget 不得进入选中");
    assert.equal(lastLines(pushed).length, 1, "widget 保持折叠单行");
  } finally {
    controller.stop();
    tui.stop();
  }
});
