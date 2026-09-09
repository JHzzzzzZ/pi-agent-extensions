/**
 * agent-team — transcript viewer through the REAL host stack (headless)
 *
 * 前三轮修的全是"纸面正确"：纯函数单测绿了，真机照样堆叠。本文件把
 * viewer 接到真实的 `TuiMainScreen`（render → compositeOverlays →
 * previousLines diff → 终端字节流）上跑，并用一个最小 scrollback VT
 * 仿真器把字节流还原成用户实际看到的屏幕，断言顶边标题+成员页签恒为
 * 一组。这是唯一能抓住 overlay 堆叠的测试——坏在这里才算真坏。
 *
 * 场景对标用户真机截图：count-duet 双成员运行中，主屏对话持续变长
 * （leader streaming），elapsed 每秒推进，中途第二个 dispatch 落地。
 * 仓库惯例"测试中不实例化真实 pi-tui"在此文件破例：堆叠 bug 恰恰只
 * 存在于真实合成/diff 路径里，fake 结构断言不到（前三轮就是证明）。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import {
  VIEWER_OVERLAY_OPTIONS,
  TranscriptViewer,
  charWidth,
  plainStyles,
  stripAnsi,
  type ViewerData,
} from "../viewer.ts";
import type { TranscriptEntry } from "../transcript.ts";

// ---------------------------------------------------------------------------
// 最小 scrollback VT 仿真器：只实现主屏 diff 渲染器实际发出的序列
// （\r \n \x1b[nA/B \x1b[H \x1b[{r};{c}H \x1b[2K \x1b[2J \x1b[3J SGR
// OSC/APC/private-mode），可打印字符按显示宽度落格。\n 恒为"缓冲向
// 下 Reynold 一行 + 视口跟随"（scrollback 语义，与渲染器 cursor 数学
// 同模型），这正是 diff 追加路径依赖的行为。
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
      // 跳到 CSI 终止字节（@A–Z[\]^_`a–z），调用方已消费 "\x1b["。
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
        skipUntilBelOrSt(); // OSC（SEGMENT_RESET 尾部的超链接关闭等）
        continue;
      }
      if (ch === "\x1b" && data[i + 1] === "_") {
        i += 2;
        skipUntilBelOrSt(); // APC（CURSOR_MARKER 等零宽标记）
        continue;
      }
      if (ch === "\x1b") {
        i += 1;
        skipCsi(); // 未知 ESC 序列：安全跳过，不断流
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
        break; // SGR(m)/同步输出(?2026h/l)/光标显隐(?25l/h)：无像素影响
    }
  }

  /** 当前全缓冲文本行（ANSI 已在 feed 时剥离，宽字符占位已清除）。 */
  text(): string[] {
    return this.slots.map((line) => line.join("").replaceAll(WIDE_CONT, ""));
  }
}

// ---------------------------------------------------------------------------
// 场景驱动：真实 TuiMainScreen + 假终端 + 真实 TranscriptViewer
// ---------------------------------------------------------------------------

function entry(kind: TranscriptEntry["kind"], text: string): TranscriptEntry {
  return { kind, text, ts: "2026-09-06T12:34:56.000Z" };
}

function scenarioData(elapsedSec: number, dispatches: number): ViewerData {
  const leader: TranscriptEntry[] = [entry("task", "从1数到10，leader 数奇数"), entry("assistant", "收到，开始派单")];
  for (let i = 0; i < dispatches; i++) {
    leader.push(entry("tool", `team_dispatch ${i} → done (11.1s)`), entry("assistant", `第${i}个成员已回复`));
  }
  return {
    team: "count-duet",
    runId: "run-1788938207941",
    runStatus: "running",
    elapsed: `${elapsedSec}s`,
    actors: [
      { actor: "_leader", label: "leader", status: "running" },
      { actor: "front", label: "front", status: "running" },
    ],
    entries: new Map<string, TranscriptEntry[]>([
      ["_leader", leader],
      ["front", [entry("task", "数偶数"), entry("assistant", "2 写完")]],
    ]),
  };
}

const isTitleRow = (line: string): boolean => stripAnsi(line).includes("agent-team viewer");
const isRosterRow = (line: string): boolean => stripAnsi(line).includes("· _leader");

interface HostCounts {
  modelTitles: number;
  gridTitles: number;
  gridRoster: number;
}

/**
 * 跑满一个"用户真机 6 秒"：打开 viewer → 每秒主屏追加对话 + elapsed
 * 推进 → 第 3 跳第二个 dispatch 落地。全程走同步 renderNow（确定性，
 * 不依赖 viewer 内部定时器），最后同时检查渲染器屏模型与仿真器像素屏。
 */
function driveHostViewer(opts: { cols?: number; rows?: number; resizeTo?: number } = {}): HostCounts {
  const screen = new FakeScreen(opts.cols ?? 160, opts.rows ?? 40);
  const term = {
    columns: screen.cols,
    rows: screen.rows,
    write: (data: string): void => {
      screen.feed(data);
    },
    hideCursor: (): void => {},
    showCursor: (): void => {},
  };
  const tui = new TuiMainScreen(term as never);
  const baseLines = ["$ pi agent-team count-duet 从1数到10", "leader turn 0 thinking…"];
  const base: Component = {
    render: () => [...baseLines],
    handleInput: () => {},
    invalidate: () => {},
  };
  tui.addChild(base);

  let elapsedSec = 53;
  let dispatches = 2;
  const viewer = new TranscriptViewer({
    load: () => scenarioData(elapsedSec, dispatches),
    done: () => {},
    styles: plainStyles(),
    rows: () => term.rows,
    refreshMs: 3600_000, // 定时器不参与：帧由 renderNow 精确驱动
  });
  try {
    tui.showOverlay(viewer, VIEWER_OVERLAY_OPTIONS);
    tui.renderNow();
    for (let tick = 1; tick <= 6; tick++) {
      elapsedSec += 1;
      if (tick === 3) dispatches += 1; // 第二个成员回复落地
      baseLines.push(`leader turn ${tick} streaming…`, `front ack ${tick}`);
      if (opts.resizeTo !== undefined && tick === 3) term.rows = opts.resizeTo;
      tui.renderNow();
    }
    // previousLines 在 .d.ts 里标 private（JS 侧是公开字段）：经结构类型只读，零运行时影响。
    const model = (tui as unknown as { previousLines: string[] }).previousLines;
    const grid = screen.text();
    return {
      modelTitles: model.filter(isTitleRow).length,
      gridTitles: grid.filter(isTitleRow).length,
      gridRoster: grid.filter(isRosterRow).length,
    };
  } finally {
    viewer.dispose();
  }
}

test("真实宿主 6 秒运行：屏模型与像素屏都恒为一组标题+roster", () => {
  const counts = driveHostViewer();
  assert.equal(counts.modelTitles, 1, `屏模型标题行应恰 1，实得 ${counts.modelTitles}`);
  assert.equal(counts.gridTitles, 1, `像素屏标题行应恰 1，实得 ${counts.gridTitles}`);
  assert.equal(counts.gridRoster, 1, `像素屏 roster 行应恰 1，实得 ${counts.gridRoster}`);
});

test("真实宿主中途改终端高度：重绘后仍为一组标题+roster", () => {
  const counts = driveHostViewer({ resizeTo: 36 });
  assert.equal(counts.modelTitles, 1, `改高度后屏模型标题应恰 1，实得 ${counts.modelTitles}`);
  assert.equal(counts.gridTitles, 1, `改高度后像素屏标题应恰 1，实得 ${counts.gridTitles}`);
  assert.equal(counts.gridRoster, 1, `改高度后像素屏 roster 应恰 1，实得 ${counts.gridRoster}`);
});

// ---------------------------------------------------------------------------
// Slice 7：停止动作全链路（D→确认→busy→notice，真实 TranscriptViewer）
// ---------------------------------------------------------------------------

function deferredStop<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("停止全链路：D→Enter stop 回调恰调一次，busy 期间重复确认被忽略，结果 notice 上屏", async () => {
  const stop = deferredStop<{ text: string; kind: "success" | "warning" | "error" }>();
  let stopCalls = 0;
  const viewer = new TranscriptViewer({
    load: () => scenarioData(1, 0),
    done: () => {},
    styles: plainStyles(),
    rows: () => 40,
    refreshMs: 3600_000, // 定时器不参与：帧由显式 render 驱动
    stop: () => {
      stopCalls += 1;
      return stop.promise;
    },
  });
  try {
    viewer.handleInput("D");
    viewer.handleInput("\r");
    assert.equal(stopCalls, 1, "确认后 stop 回调恰调一次");
    assert.match(stripAnsi(viewer.render(100).join("\n")), /停止中…/, "busy 横幅上屏");

    viewer.handleInput("\r"); // busy 期间重复确认
    viewer.handleInput("Y");
    assert.equal(stopCalls, 1, "busy 守卫：不重复调 stop");

    stop.resolve({ text: "run 已停止（aborted · 3.2s）；该 run 的报告不再送达", kind: "success" });
    await stop.promise;
    const frame = stripAnsi(viewer.render(100).join("\n"));
    assert.match(frame, /run 已停止（aborted · 3.2s）；该 run 的报告不再送达/, "停止结果 notice 上屏");
    assert.doesNotMatch(frame, /停止中…/, "busy 横幅已撤");
    assert.doesNotMatch(frame, /确认停止 run/, "确认横幅已撤");
  } finally {
    viewer.dispose();
  }
});

test("停止确认态渲染：横幅两行占正文窗口顶部且帧总行数不变（真实宿主）", () => {
  const viewer = new TranscriptViewer({
    load: () => scenarioData(1, 0),
    done: () => {},
    styles: plainStyles(),
    rows: () => 40,
    refreshMs: 3600_000,
  });
  try {
    const before = viewer.render(100).length;
    viewer.handleInput("D");
    const frame = stripAnsi(viewer.render(100).join("\n"));
    assert.equal(viewer.render(100).length, before, "帧总行数不变");
    assert.match(frame, /确认停止 run run-1788938207941？/);
    assert.match(frame, /Enter\/Y 确认 · N 取消/, "确认提示占右栏（按 detail 宽换行）");
  } finally {
    viewer.dispose();
  }
});

test("stop 回调 reject：error notice 上屏且不上抛", async () => {
  let rejectStop!: (err: Error) => void;
  const stopPromise = new Promise<{ text: string; kind: "success" | "warning" | "error" }>((_, reject) => {
    rejectStop = reject;
  });
  const viewer = new TranscriptViewer({
    load: () => scenarioData(1, 0),
    done: () => {},
    styles: plainStyles(),
    rows: () => 40,
    refreshMs: 3600_000,
    stop: () => stopPromise,
  });
  try {
    viewer.handleInput("D");
    viewer.handleInput("\r");
    rejectStop(new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const frame = stripAnsi(viewer.render(100).join("\n"));
    assert.match(frame, /停止失败；稍后用 \/team:stop 重试/, "reject 映射为 error notice");
    assert.doesNotMatch(frame, /停止中…/);
  } finally {
    viewer.dispose();
  }
});

// ---------------------------------------------------------------------------
// Slice 6：组件关闭/销毁语义（seam E——真实 TranscriptViewer，真实定时器）
// ---------------------------------------------------------------------------

test("TranscriptViewer 关闭路径：先停 timer 再调 done（close 后 load 冻结 + done 恰一次）", async () => {
  let loadCount = 0;
  const events: string[] = [];
  const viewer = new TranscriptViewer({
    load: () => {
      loadCount += 1;
      return scenarioData(1, 0);
    },
    done: () => events.push("done"),
    styles: plainStyles(),
    refreshMs: 5, // 短 tick：几个微秒内 load 应多次，便于断言 timer 已停
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(loadCount >= 3, `5ms tick 下 load 应持续增长，实得 ${loadCount}`);
    assert.deepEqual(events, [], "未关闭前 done 不应被调");

    viewer.handleInput("\x03"); // ctrl+c 关闭（close 键集对齐 fleet）
    assert.deepEqual(events, ["done"], "关闭路径恰调一次 done");
    const afterClose = loadCount;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(loadCount, afterClose, "关闭后 timer 应已停：load 不再增长（dispose 先于 done 清 timer）");
  } finally {
    viewer.dispose();
  }
});

test("TranscriptViewer dispose 幂等：双调不炸且 timer 只停一次", async () => {
  let loadCount = 0;
  const viewer = new TranscriptViewer({
    load: () => {
      loadCount += 1;
      return scenarioData(1, 0);
    },
    done: () => {},
    styles: plainStyles(),
    refreshMs: 5,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(loadCount >= 2, "dispose 前 timer 在跑");
    viewer.dispose();
    viewer.dispose(); // 幂等：双调不炸
    const afterDispose = loadCount;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(loadCount, afterDispose, "dispose 后 timer 停：load 不再增长");
  } finally {
    viewer.dispose();
  }
});
