/**
 * agent-team — viewer 「用户输入」亮块的真实宿主渲染（#56）
 *
 * 需求：run 运行中用户经 viewer 发的消息（steer/排队）原文必须**看得见**，
 * 且与 agent/leader 输出视觉区分（独立亮块，背景取宿主主题 `userMessageBg`）。
 *
 * 边界：本文件沿 viewer-ask-host.test.ts 的惯例接真实宿主栈——真
 * `TuiMainScreen` + 真 `TranscriptViewer` + 真 `openTranscriptViewer`，终端
 * 换成带样式追踪的 VT 仿真屏（`tools/vt-screen.mjs`，与 capture-screens 同源）。
 * 背景色分类只能在真实合成/写屏路径里验：纯函数 fake 拿到的是序列化前的
 * 字符串，断言不到「屏上那一行到底铺了什么底色」。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { TuiMainScreen, type Component } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { VIEWER_OVERLAY_OPTIONS, openTranscriptViewer, type ViewerData } from "../viewer.ts";
import type { TranscriptEntry } from "../transcript.ts";
import { VtScreen, ansi256 } from "../tools/vt-screen.mjs";

initTheme();

/** 宿主题色位：`userMessageBg` 与 `selectedBg` 在真主题里是两个不同底色。 */
const THEME_BG: Record<string, number> = { userMessageBg: 236, selectedBg: 240 };

const USER_TEXT = "把标题改短一点（用户插话原文）";
const ASSISTANT_TEXT = "收到，正在按你的要求改";

function viewerData(): ViewerData {
  const leader: TranscriptEntry[] = [
    { kind: "task", text: "重写登录页", ts: "2026-09-16T03:00:00.000Z" },
    { kind: "assistant", text: ASSISTANT_TEXT, ts: "2026-09-16T03:04:00.000Z" },
    { kind: "user", text: USER_TEXT, ts: "2026-09-16T03:04:05.000Z" },
  ];
  return {
    team: "dev-team",
    runId: "run-1789135763878",
    runStatus: "running",
    elapsed: "12s",
    actors: [{ actor: "_leader", label: "leader", status: "running" }],
    entries: new Map([["_leader", leader]]),
  };
}

interface UserBlockHost {
  lines: () => string[];
  grid: () => ReturnType<VtScreen["grid"]>;
  bgCalls: string[];
  render: () => void;
}

/** 真宿主栈：overlay 分支与 interactive-mode.js:2158-2207 同构。 */
function mountViewer(): UserBlockHost {
  const screen = new VtScreen(140, 40);
  const term = {
    columns: screen.cols,
    rows: screen.rows,
    write: (data: string): void => screen.feed(data),
    hideCursor: (): void => {},
    showCursor: (): void => {},
  };
  const tui = new TuiMainScreen(term as never);
  const base: Component = {
    render: () => ["$ pi agent-team dev-team 重写登录页", "leader turn 1 thinking…"],
    handleInput: (): void => {},
    invalidate: (): void => {},
  };
  tui.addChild(base);

  const bgCalls: string[] = [];
  const theme = {
    fg: (_color: string, text: string): string => text,
    bold: (text: string): string => text,
    bg: (color: string, text: string): string => {
      bgCalls.push(color);
      const slot = THEME_BG[color] ?? 250;
      return `\x1b[48;5;${slot}m${text}\x1b[49m`;
    },
  };
  const ui = {
    custom: (
      factory: (
        tuiArg: TuiMainScreen,
        themeArg: unknown,
        keybindings: unknown,
        done: (result: unknown) => void,
      ) => unknown,
      options?: { overlayOptions?: typeof VIEWER_OVERLAY_OPTIONS },
    ): Promise<unknown> =>
      new Promise((resolve) => {
        const created = factory(tui, theme, undefined, (result) => resolve(result));
        tui.showOverlay(created as Component, options?.overlayOptions);
      }),
  };

  void openTranscriptViewer(ui as never, {
    load: viewerData,
    refreshMs: 3600_000, // 定时器不参与：帧由 renderNow 精确驱动
  });
  tui.renderNow();

  return {
    lines: () => screen.text(),
    grid: () => screen.grid(),
    bgCalls,
    render: (): void => tui.renderNow(),
  };
}

/** 屏上含 `needle` 的那一行的单元格。 */
function rowOf(host: UserBlockHost, needle: string): ReturnType<VtScreen["grid"]>[number] {
  const grid = host.grid();
  const row = grid.find((cells) => cells.map((cell) => cell?.ch ?? "").join("").includes(needle));
  assert.ok(row, `屏上应有含 "${needle}" 的行：\n${host.lines().join("\n")}`);
  return row;
}

/**
 * 帧行两栏拆分的右栏（detail）列区间：按**单元格列号**定位竖边框
 * （`▌`/`用户` 等宽字符占两格，joined-string 下标不等于列号）。
 */
function detailRange(row: ReturnType<VtScreen["grid"]>[number]): { start: number; width: number } {
  const borders = row.map((cell, col) => (cell?.ch === "│" ? col : -1)).filter((col) => col >= 0);
  assert.ok(borders.length >= 3, `帧行应有三条竖边框（左右 + 分栏）：${borders.join(",")}`);
  const start = (borders[1] ?? 0) + 1;
  const end = borders[borders.length - 1] ?? 0;
  assert.ok(end > start, "分栏边框必须在左右边框之间");
  return { start, width: end - start };
}

test("user 块上屏：标签行带时间、正文行走 userMessageBg、assistant 行无背景", () => {
  const host = mountViewer();
  const text = host.lines().join("\n");
  assert.ok(text.includes("▌用户 · 03:04:05"), `user 块标签与时间应上屏：\n${text}`);
  assert.ok(text.includes(USER_TEXT), "用户输入原文应上屏");
  assert.ok(text.includes("▸ assistant"), "前置：既有 assistant 块仍在");
  assert.ok(host.bgCalls.includes("userMessageBg"), "亮块背景应取宿主主题 userMessageBg 色位");

  const labelRow = rowOf(host, "▌用户");
  const { start, width } = detailRange(labelRow);
  assert.equal(labelRow?.[start]?.bg, null, "标签行不带背景（只有正文铺底）");

  const bodyRow = rowOf(host, USER_TEXT);
  assert.deepEqual(detailRange(bodyRow), { start, width }, "帧行几何一致（两栏分界不变）");
  for (let col = start; col < start + width; col++) {
    assert.equal(
      bodyRow?.[col]?.bg,
      ansi256(236),
      `正文行 ${col} 列：底色应连续铺满右栏（userMessageBg），实得 ${bodyRow?.[col]?.bg}`,
    );
  }

  const assistantRow = rowOf(host, ASSISTANT_TEXT);
  for (let col = start; col < start + width; col++) {
    assert.equal(assistantRow?.[col]?.bg, null, `assistant 行 ${col} 列不应有背景（与用户输入视觉区分）`);
  }
});

test("user 块与 assistant 块底色分类不同：亮块只取 userMessageBg（不误用 selectedBg）", () => {
  const host = mountViewer();
  const bgColors = new Set(
    host
      .grid()
      .flat()
      .map((cell) => cell?.bg)
      .filter((bg): bg is string => typeof bg === "string"),
  );
  assert.deepEqual([...bgColors], [ansi256(236)], "屏上背景色只有 userMessageBg 一种（assistant 无底色）");
  assert.ok(!bgColors.has(ansi256(240)), "不得误用 selectedBg 色位");
});
