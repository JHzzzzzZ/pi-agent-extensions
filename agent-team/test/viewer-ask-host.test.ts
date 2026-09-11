/**
 * agent-team — viewer overlay 与 leader 提问对话框的互斥（真实宿主路径）
 *
 * 真机根因（宿主源码实锤）：宿主 `showExtensionSelector` / `showExtensionInput`
 * 把对话框渲染进 `editorContainer`（主内容基础层）并 `setFocus(selector)`
 * （interactive-mode.js:1953-1982 / 2005-2031）；viewer 是 `ui.custom` 的
 * `overlay: true` 分支经 `ui.showOverlay` 挂的独立覆盖层
 * （interactive-mode.js:2158-2207 overlay 分支），永远盖在基础层之上；且焦点
 * 被选择器拿走 → 用户既看不见提问、viewer 的 q/Esc 也失效。扩展 API 无法把
 * 宿主对话框置顶 overlay。
 *
 * 修复 = 提问到达先程序化收起 viewer（viewer.ts `onOpen`），作答/取消/超时后
 * 自动重开（index.ts `askPortFrom` + `viewerDialogHooks`）。
 *
 * 本文件按 viewer-host.test.ts 的惯例接真实宿主栈（真 TuiMainScreen + 假终端
 * + FakeScreen VT 仿真 + 真 TranscriptViewer + 真 ExtensionSelector/Input
 * 组件）："overlay 盖住对话框"只存在于真实合成/写屏路径里，纸面 fake 断言不到。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Container, TuiMainScreen, type Component, type OverlayOptions } from "@earendil-works/pi-tui";
import { ExtensionInputComponent, ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { askPortFrom, viewerDialogHooks, type ViewerDialogState } from "../index.ts";
import { charWidth, openTranscriptViewer, type ViewerData } from "../viewer.ts";
import type { TranscriptEntry } from "../transcript.ts";

// ---------------------------------------------------------------------------
// 最小 scrollback VT 仿真器（逐字复制 test/viewer-host.test.ts 的设施：只实现
// 主屏 diff 渲染器实际发出的序列，可打印字符按显示宽度落格，\n 恒为
// "缓冲向下滚一行 + 视口跟随"）。
// ---------------------------------------------------------------------------

const WIDE_CONT = "\0";

class FakeScreen {
  private readonly slots: string[][] = [];
  private row = 0;
  private col = 0;

  readonly cols: number;
  readonly rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  private viewportStart(): number {
    return Math.max(0, this.slots.length - this.rows);
  }

  private ensureRow(r: number): string[] {
    while (this.slots.length <= r) this.slots.push([]);
    const line = this.slots[r];
    if (!line) throw new Error("unreachable");
    return line;
  }

  private writeChar(ch: string): void {
    const line = this.ensureRow(this.row);
    const w = charWidth(ch);
    if ((line[this.col] ?? "") === WIDE_CONT && this.col > 0) line[this.col - 1] = "";
    line[this.col] = ch;
    if (w === 2) line[this.col + 1] = WIDE_CONT;
    else if ((line[this.col + 1] ?? "") === WIDE_CONT) line[this.col + 1] = "";
    this.col += w;
  }

  /** 消费渲染器写出的全部字节，返回后本屏即"用户看到的画面"。 */
  feed(data: string): void {
    let i = 0;
    const skipCsi = (): void => {
      while (i < data.length) {
        const code = data.charCodeAt(i) ?? 0;
        i += 1;
        if (code >= 0x40 && code <= 0x7e) return;
      }
    };
    const skipUntilBelOrSt = (): void => {
      while (i < data.length) {
        if (data[i] === "\x07") {
          i += 1;
          return;
        }
        if (data[i] === "\x1b" && data[i + 1] === "\\") {
          i += 2;
          return;
        }
        i += 1;
      }
    };
    while (i < data.length) {
      const ch = data[i] ?? "";
      if (ch === "\x1b" && data[i + 1] === "[") {
        i += 2;
        let params = "";
        while (i < data.length) {
          const code = data.charCodeAt(i) ?? 0;
          if (code >= 0x40 && code <= 0x7e) break;
          params += data[i];
          i += 1;
        }
        const fin = data[i] ?? "";
        i += 1;
        this.applyCsi(params, fin);
        continue;
      }
      if (ch === "\x1b" && data[i + 1] === "]") {
        i += 2;
        skipUntilBelOrSt(); // OSC
        continue;
      }
      if (ch === "\x1b" && data[i + 1] === "_") {
        i += 2;
        skipUntilBelOrSt(); // APC
        continue;
      }
      if (ch === "\x1b") {
        i += 1;
        skipCsi();
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        this.row += 1;
        this.ensureRow(this.row);
        i += 1;
        continue;
      }
      if (ch === "\x07" || ch === "\0") {
        i += 1;
        continue;
      }
      this.writeChar(ch);
      i += 1;
    }
  }

  private applyCsi(params: string, fin: string): void {
    const nums = params
      .replace(/^[?]/, "")
      .split(";")
      .map((p) => Number(p))
      .filter((n) => Number.isInteger(n));
    const n = (dflt: number): number => nums[0] ?? dflt;
    switch (fin) {
      case "A":
        this.row = Math.max(0, this.row - n(1));
        break;
      case "B":
        this.row = this.row + n(1);
        this.ensureRow(this.row);
        break;
      case "H": {
        if (params === "" || nums.length === 0) {
          this.row = this.viewportStart();
          this.col = 0;
        } else {
          this.row = this.viewportStart() + (nums[0] ?? 1) - 1;
          this.col = (nums[1] ?? 1) - 1;
          this.ensureRow(this.row);
        }
        break;
      }
      case "K":
        this.slots[this.row] = [];
        break;
      case "J": {
        const mode = n(0);
        if (mode === 2) {
          const start = this.viewportStart();
          for (let r = start; r < start + this.rows; r++) this.slots[r] = [];
        } else if (mode === 3) {
          const dropped = this.viewportStart();
          this.slots.splice(0, dropped);
          this.row = Math.max(0, this.row - dropped);
        }
        break;
      }
      default:
        break; // SGR / 同步输出 / 光标显示：无像素影响
    }
  }

  /** 当前全缓冲文本行（ANSI 已在 feed 时剥离，宽字符占位已清除）。 */
  text(): string[] {
    return this.slots.map((line) => line.join("").replaceAll(WIDE_CONT, ""));
  }
}

// 宿主选择器/输入组件构造时读全局 theme（未初始化会抛）；用宿主默认主题初始化。
initTheme();

// ---------------------------------------------------------------------------
// 场景驱动：真实 TuiMainScreen + 假终端 + 真实 TranscriptViewer
// ---------------------------------------------------------------------------

const VIEWER_TITLE = "agent-team viewer";
const ASK_INPUT_TITLE = "[dev-team] 要发到哪个环境？";
const ASK_SELECT_TITLE = "[dev-team] 部署到哪个环境？";

function viewerData(): ViewerData {
  const entries: TranscriptEntry[] = [{ kind: "assistant", text: "正在等待答复", ts: "2026-09-16T00:00:00.000Z" }];
  return {
    team: "dev-team",
    runId: "run-1789135763878",
    runStatus: "running",
    elapsed: "12s",
    actors: [{ actor: "_leader", label: "leader", status: "running" }],
    entries: new Map([["_leader", entries]]),
  };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), `${label}（等待 2s 超时）`);
}

interface AskHost {
  tui: TuiMainScreen;
  screen: FakeScreen;
  dispatch: (data: string) => void;
  state: ViewerDialogState;
  port: ReturnType<typeof askPortFrom>;
  openViewer: (initialActor?: string) => Promise<void>;
  counters: { customShown: number; customClosed: number; inputShown: number; selectShown: number };
  selector: () => ExtensionSelectorComponent | undefined;
  input: () => ExtensionInputComponent | undefined;
  render: () => void;
  screenHas: (needle: string) => boolean;
  stop: () => void;
}

/**
 * 宿主仿真：`custom` 走 overlay 分支（showOverlay + done → hideOverlay + resolve，
 * 对照 interactive-mode.js:2158-2207）；`select`/`input` 把对话框 clear 进
 * editorContainer 基础层再 setFocus（对照 interactive-mode.js:1953-1982 /
 * 2005-2031）。base 先放若干主屏行、editorContainer 在后——与真机布局同向
 * （对话框落在 overlay 的覆盖区里，而不是屏幕最顶部）。
 */
function mountAskHost(): AskHost {
  const screen = new FakeScreen(160, 40);
  let onInput: ((data: string) => void) | undefined;
  const term = {
    columns: screen.cols,
    rows: screen.rows,
    start(cb: (data: string) => void): void {
      onInput = cb;
    },
    stop(): void {},
    drainInput(): Promise<void> {
      return Promise.resolve();
    },
    write(data: string): void {
      screen.feed(data);
    },
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
  const tui = new TuiMainScreen(term as never);
  const chatLines = [
    "$ pi agent-team dev-team 部署演练",
    "leader turn 0 thinking…",
    "leader turn 1 thinking…",
    "leader turn 2 thinking…",
    "leader turn 3 thinking…",
    "leader turn 4 thinking…",
  ];
  const chat: Component = { render: () => [...chatLines], handleInput: () => {}, invalidate: () => {} };
  const editor: Component & { getText: () => string; setText: (text: string) => void } = {
    render: () => ["（编辑器占位）"],
    handleInput: () => {},
    invalidate: () => {},
    getText: () => "",
    setText: () => {},
  };
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  tui.addChild(chat);
  tui.addChild(editorContainer);
  tui.start();

  const counters = { customShown: 0, customClosed: 0, inputShown: 0, selectShown: 0 };
  let inputComponent: ExtensionInputComponent | undefined;
  let selectorComponent: ExtensionSelectorComponent | undefined;

  const restoreEditor = (): void => {
    editorContainer.clear();
    editorContainer.addChild(editor);
    tui.setFocus(editor);
    tui.requestRender();
  };

  // TranscriptViewer 经 themeStyles(theme) 只用到 fg/bg/bold，取不到即降级。
  const hostTheme = {
    fg: (_color: string, text: string): string => text,
    bg: (_color: string, text: string): string => text,
    bold: (text: string): string => text,
  };

  const ui = {
    custom: (
      factory: (
        tuiArg: TuiMainScreen,
        themeArg: unknown,
        keybindingsArg: unknown,
        done: (result: unknown) => void,
      ) => unknown,
      options?: { overlayOptions?: OverlayOptions },
    ): Promise<unknown> =>
      new Promise((resolve) => {
        let component: { dispose?: () => void } | undefined;
        let closed = false;
        const close = (result: unknown): void => {
          if (closed) return;
          closed = true;
          counters.customClosed += 1;
          tui.hideOverlay();
          resolve(result);
          try {
            component?.dispose?.();
          } catch {
            /* dispose 幂等 */
          }
        };
        Promise.resolve(factory(tui, hostTheme, undefined, close)).then((created) => {
          if (closed) return;
          component = created as { dispose?: () => void };
          counters.customShown += 1;
          tui.showOverlay(created as Component, options?.overlayOptions);
          tui.requestRender();
        });
      }),
    input: (
      title: string,
      placeholder: string | undefined,
      opts?: { signal?: AbortSignal; timeout?: number },
    ): Promise<string | undefined> =>
      new Promise((resolve) => {
        if (opts?.signal?.aborted) {
          resolve(undefined);
          return;
        }
        const settle = (value: string | undefined): void => {
          opts?.signal?.removeEventListener("abort", onAbort);
          try {
            inputComponent?.dispose();
          } catch {
            /* dispose 幂等 */
          }
          inputComponent = undefined;
          restoreEditor();
          resolve(value);
        };
        const onAbort = (): void => settle(undefined);
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        const component = new ExtensionInputComponent(
          title,
          placeholder,
          (value) => settle(value),
          () => settle(undefined),
          { tui, ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}) },
        );
        inputComponent = component;
        counters.inputShown += 1;
        editorContainer.clear();
        editorContainer.addChild(component);
        tui.setFocus(component);
        tui.requestRender();
      }),
    select: (
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal; timeout?: number },
    ): Promise<string | undefined> =>
      new Promise((resolve) => {
        if (opts?.signal?.aborted) {
          resolve(undefined);
          return;
        }
        const settle = (value: string | undefined): void => {
          opts?.signal?.removeEventListener("abort", onAbort);
          try {
            selectorComponent?.dispose();
          } catch {
            /* dispose 幂等 */
          }
          selectorComponent = undefined;
          restoreEditor();
          resolve(value);
        };
        const onAbort = (): void => settle(undefined);
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        const component = new ExtensionSelectorComponent(
          title,
          options,
          (option) => settle(option),
          () => settle(undefined),
          { tui, ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}) },
        );
        selectorComponent = component;
        counters.selectShown += 1;
        editorContainer.clear();
        editorContainer.addChild(component);
        tui.setFocus(component);
        tui.requestRender();
      }),
  };

  const state: ViewerDialogState = { viewerOpen: false, viewerSettled: undefined };
  // 与 index.ts openViewer 同构的测试替身（真实 openTranscriptViewer + onOpen）
  const openViewer = async (initialActor?: string): Promise<void> => {
    if (state.viewerOpen) return;
    state.viewerOpen = true;
    if (initialActor !== undefined) state.viewerActor = initialActor;
    try {
      await openTranscriptViewer(ui as never, {
        load: viewerData,
        ...(initialActor !== undefined ? { initialActor } : {}),
        onOpen: (close) => {
          state.viewerClose = close;
        },
      });
    } finally {
      state.viewerOpen = false;
      state.viewerClose = undefined;
      const settle = state.viewerSettled;
      state.viewerSettled = undefined;
      if (settle) {
        try {
          settle();
        } catch {
          /* 与生产 openViewer 的异常隔离一致 */
        }
      }
    }
  };

  return {
    tui,
    screen,
    dispatch: (data: string): void => {
      assert.ok(onInput, "tui.start 后应捕获到真实输入回调");
      onInput(data);
    },
    state,
    port: askPortFrom({ hasUI: true, ui } as never, viewerDialogHooks(state, openViewer)),
    openViewer,
    counters,
    selector: () => selectorComponent,
    input: () => inputComponent,
    render: (): void => {
      tui.renderNow();
    },
    screenHas: (needle: string): boolean => screen.text().some((line) => line.includes(needle)),
    stop: (): void => {
      tui.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// 用例 1：遮挡复现 + 修复锁定（input 提问）
// ---------------------------------------------------------------------------

test("提问到达先收起 viewer：input 对话框标题上屏、viewer 标题消失", async () => {
  const host = mountAskHost();
  const controller = new AbortController();
  try {
    void host.openViewer();
    await waitFor(() => host.counters.customShown === 1, "viewer overlay 应上屏");
    host.render();
    assert.ok(host.screenHas(VIEWER_TITLE), "前置：viewer 标题应在屏上");
    assert.ok(!host.screenHas(ASK_INPUT_TITLE), "前置：提问尚未到达");

    const result = host.port.present({ id: "q1", method: "input", title: ASK_INPUT_TITLE }, controller.signal);
    await waitFor(() => host.counters.inputShown === 1, "input 对话框应已呈现");
    host.render();
    const visible = host.screen.text().filter((line) => line.includes("环境")).join(" | ");
    assert.ok(host.screenHas(ASK_INPUT_TITLE), `提问标题应在屏上（未被 overlay 盖住）：${visible}`);
    assert.ok(!host.screenHas(VIEWER_TITLE), "viewer 必须先收起（不再盖住对话框）");

    controller.abort();
    assert.deepEqual(await result, { kind: "cancelled" }, "取消后 present fail-closed 返回 cancelled");
  } finally {
    host.stop();
  }
});

// ---------------------------------------------------------------------------
// 用例 2：作答路径（select 确认 → answer + viewer 重开）
// ---------------------------------------------------------------------------

test("作答后 viewer 自动重开：selector 确认 → answer + viewer 标题重现", async () => {
  const host = mountAskHost();
  try {
    void host.openViewer();
    await waitFor(() => host.counters.customShown === 1, "viewer overlay 应上屏");

    const result = host.port.present(
      { id: "q1", method: "select", title: ASK_SELECT_TITLE, options: ["staging", "prod"] },
      new AbortController().signal,
    );
    await waitFor(() => host.counters.selectShown === 1, "select 对话框应已呈现");
    host.render();
    assert.ok(host.screenHas(ASK_SELECT_TITLE), "选择器标题应在屏上");
    assert.ok(!host.screenHas(VIEWER_TITLE), "viewer 收起后才呈现对话框");

    const selector = host.selector();
    assert.ok(selector, "应捕获到真实 ExtensionSelectorComponent");
    selector.handleInput("\r"); // 确认首项
    assert.deepEqual(await result, { kind: "answer", value: "staging" });

    await waitFor(() => host.counters.customShown === 2, "作答后 viewer 应自动重开");
    host.render();
    assert.ok(host.screenHas(VIEWER_TITLE), "viewer 标题重现");
    assert.ok(!host.screenHas(ASK_SELECT_TITLE), "提问行随对话框收起消失");
    assert.equal(host.state.viewerOpen, true, "重开后互斥状态回到打开");
  } finally {
    host.stop();
  }
});

// ---------------------------------------------------------------------------
// 用例 3：取消路径（真实 Esc 路由）+ Esc 语义不互吞
// ---------------------------------------------------------------------------

test("取消路径：对话框 Esc → cancelled + viewer 重开；重开后 Esc 关闭 viewer（不互吞）", async () => {
  const host = mountAskHost();
  try {
    void host.openViewer();
    await waitFor(() => host.counters.customShown === 1, "viewer overlay 应上屏");

    const result = host.port.present(
      { id: "q1", method: "select", title: ASK_SELECT_TITLE, options: ["staging", "prod"] },
      new AbortController().signal,
    );
    await waitFor(() => host.counters.selectShown === 1, "select 对话框应已呈现");

    host.dispatch("\x1b"); // 真实输入路由 → 聚焦的 selector → cancel
    assert.deepEqual(await result, { kind: "cancelled" }, "Esc 取消提问");
    assert.equal(host.counters.customClosed, 1, "取消时 viewer 仍是收起态（未重开关闭）");

    await waitFor(() => host.counters.customShown === 2, "取消后 viewer 应自动重开");
    host.render();
    assert.ok(host.screenHas(VIEWER_TITLE), "viewer 重开");

    host.dispatch("\x1b"); // 重开后 Esc → 聚焦的 viewer → close
    await waitFor(() => host.counters.customClosed === 2, "重开的 viewer 应被 Esc 关闭");
    host.render();
    assert.ok(!host.screenHas(VIEWER_TITLE), "viewer 关闭后标题消失");
    await waitFor(() => host.state.viewerOpen === false, "关闭后互斥状态回到关闭");
  } finally {
    host.stop();
  }
});

// ---------------------------------------------------------------------------
// 用例 4：超时/中止路径（present 期间 abort signal）
// ---------------------------------------------------------------------------

test("超时路径：提问进行中 abort signal → cancelled + viewer 重开", async () => {
  const host = mountAskHost();
  const controller = new AbortController();
  try {
    void host.openViewer();
    await waitFor(() => host.counters.customShown === 1, "viewer overlay 应上屏");

    const result = host.port.present(
      { id: "q1", method: "select", title: ASK_SELECT_TITLE, options: ["staging", "prod"] },
      controller.signal,
    );
    await waitFor(() => host.counters.selectShown === 1, "select 对话框应已呈现");
    host.render();
    assert.ok(!host.screenHas(VIEWER_TITLE), "对话框呈现时 viewer 处于收起态");

    controller.abort();
    assert.deepEqual(await result, { kind: "cancelled" }, "signal 中止 → cancelled");

    await waitFor(() => host.counters.customShown === 2, "中止后 viewer 应自动重开");
    host.render();
    assert.ok(host.screenHas(VIEWER_TITLE), "viewer 标题重现");
  } finally {
    host.stop();
  }
});

// ---------------------------------------------------------------------------
// 用例 5：收起等待上限（custom 未落定时不让提问挂起）
// ---------------------------------------------------------------------------

test("收起等待上限：viewerClose 缺失时 suspendViewer 约 1.5s 内放行返回 true（不让提问挂起）", async () => {
  const untouched = viewerDialogHooks({ viewerOpen: false }, () => Promise.resolve());
  assert.equal(await untouched.suspendViewer(), false, "viewer 未打开 → 无需收起");

  const started = Date.now();
  const hooks = viewerDialogHooks({ viewerOpen: true }, () => Promise.resolve());
  // viewerClose 缺失 = 模拟 custom 未落定（openTranscriptViewer 未回调 onOpen）。
  assert.equal(await hooks.suspendViewer(), true, "已打开但 close 不落定 → 超时也放行");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1400, `应等满收纳上限才放行，实测 ${elapsed}ms`);
  assert.ok(elapsed < 5000, `放行时间必须有界，实测 ${elapsed}ms`);
});
