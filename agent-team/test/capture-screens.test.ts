/**
 * agent-team — docs screenshot tool (tools/) contract tests
 *
 * 边界：本文件只锁"工具能不能可信地生产文档截图"——VT 解析、SVG 结构、
 * 真实渲染路径的帧自检与确定性。它不重复 viewer-host.test.ts 的堆叠断言
 * （那是渲染正确性），只保证截图产物与真机帧同源、可重复生成。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  capture,
  captureAll,
  captureViewerScene,
  capturePwrViewerScene,
  svgFromGrid,
  assertFrame,
  assertPwrFrame,
} from "../tools/capture-screens.mjs";
import { VtScreen, ansi256, DEFAULT_BG } from "../tools/vt-screen.mjs";

test("vt-screen: truecolor / 256 / reset 解析到单元格样式", () => {
  const s = new VtScreen(10, 2);
  s.feed("\x1b[38;2;97;175;239mAB\x1b[39m\x1b[48;5;236mCD\x1b[49m\x1b[1mEF\x1b[22m");
  const [row] = s.grid();
  assert.equal(row[0]?.fg, "#61afef");
  assert.equal(row[0]?.bg, null);
  assert.equal(row[2]?.bg, "#303030");
  assert.equal(row[4]?.bold, true);
  assert.equal(row[5]?.bold, true);
  assert.equal(s.text()[0], "ABCDEF");
});

test("vt-screen: 宽字符占两列且不破坏后续列", () => {
  const s = new VtScreen(8, 1);
  s.feed("中a");
  const [row] = s.grid();
  assert.equal(row[0]?.ch, "中");
  assert.equal(row[1]?.cont, true);
  assert.equal(row[2]?.ch, "a");
});

test("svg: 结构完整、列宽钉死、文本转义", () => {
  const s = new VtScreen(20, 1);
  s.feed("\x1b[31m<a&b>\x1b[0m");
  const svg = svgFromGrid(s.grid());
  assert.ok(svg.startsWith("<svg "), "必须是 SVG 根");
  assert.ok(svg.endsWith("</svg>\n"));
  assert.ok(svg.includes('width="168"'), `20 列 × 8.4 = 168，实得 ${svg.slice(0, 200)}`);
  assert.ok(svg.includes("&lt;a&amp;b&gt;"), "XML 特殊字符必须转义");
  assert.ok(svg.includes('textLength="42.0"'), "run 用 textLength 钉死显示宽度");
  assert.ok(svg.includes('fill="#e06c75"'), "ANSI 红映射到调色板");
});

test("svg: 默认背景整屏铺底", () => {
  const s = new VtScreen(4, 1);
  const svg = svgFromGrid(s.grid());
  assert.ok(svg.includes(`fill="${DEFAULT_BG}"`));
});

test("截图自检：锚点缺失即失败，真实帧通过", () => {
  const scene = captureViewerScene();
  assert.equal(assertFrame(scene.lines), true);
  assert.throws(() => assertFrame(["nothing here"]), /缺少锚点/);
});

test("产物确定性：两次捕获字节一致（文档可 diff）", () => {
  const a = capture();
  const b = capture();
  assert.equal(a.name, "agent-team-viewer.svg");
  assert.equal(a.svg, b.svg);
  assert.ok(a.svg.length > 12_000, `SVG 过小，疑似空帧：${a.svg.length}`);
});

test("pwr 场景：真实 RunViewer 帧含锚点（脚本名/结构页/roster）", () => {
  const scene = capturePwrViewerScene();
  assert.equal(assertPwrFrame(scene.lines), true);
  assert.throws(() => assertPwrFrame(["nothing here"]), /缺少锚点/);
});

test("pwr 产物：revision 稳定 + 与 agent-team 帧同管线产出", () => {
  const a = capturePwrViewerScene();
  const b = capturePwrViewerScene();
  assert.equal(a.lines.join("\n"), b.lines.join("\n"));
  const shots = captureAll();
  assert.deepEqual(
    shots.map((s) => s.name),
    ["agent-team-viewer.svg", "pwr-viewer.svg"],
  );
  for (const shot of shots) assert.ok(shot.svg.length > 12_000, `${shot.name} 过小：${shot.svg.length}`);
});
