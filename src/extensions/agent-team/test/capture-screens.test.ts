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
  captureWidgetScene,
  captureAskScene,
  captureAskWalkthrough,
  svgFromGrid,
  assertFrame,
  assertPwrFrame,
  assertWidgetFrame,
  assertAskFrame,
  DARK,
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
    ["agent-team-viewer.svg", "pwr-viewer.svg", "agent-team-widget.svg"],
  );
  for (const shot of shots) {
    const floor = shot.name === "agent-team-widget.svg" ? 1_000 : 12_000;
    assert.ok(shot.svg.length > floor, `${shot.name} 过小：${shot.svg.length}`);
  }
});

test("widget 场景：真实 buildWidgetView/renderWidgetView 帧含锚点", () => {
  const scene = captureWidgetScene();
  assert.equal(assertWidgetFrame(scene.lines), true);
  assert.throws(() => assertWidgetFrame(["nothing here"]), /缺少锚点/);
  const text = scene.lines.join("\n");
  assert.ok(text.includes("▸ leader count-duet"), "展开态 leader 行必须有选中高亮");
  assert.ok(text.includes("├─ front"), "非末项成员行用 ├─ 连接符");
  assert.ok(text.includes("╰─ back"), "末项成员行用圆角 ╰─ 连接符");
  assert.equal(scene.lines.filter((l) => l.includes("↑↓ 选择")).length, 1, "提示行恰一行");
});

test("widget 场景：宿主包装（Text(line,1,0)）与 editor 上下关系", () => {
  const scene = captureWidgetScene();
  // 宿主 setExtensionWidget 对 string[] 的包装 = Container + Text(line, 1, 0)：
  // 非选中行在 widget 内是 "  " 前缀 → 屏上 "   main"（1 列宿主缩进 + 2 列 gutter）。
  assert.ok(
    scene.lines.some((l) => l.trimEnd() === "   main"),
    `main 行缺宿主包装缩进: ${JSON.stringify(scene.lines.find((l) => l.includes("main")))}`,
  );
  const mainIdx = scene.lines.findIndex((l) => l.trimEnd() === "   main");
  let borderIdx = -1;
  scene.lines.forEach((l, i) => {
    // editor 下边框 = 整行纯 ─（成员行连接符 ├─/╰─ 也含 ─，不能只用 includes 判定）。
    if (i < mainIdx && /^─+$/.test(l.trim())) borderIdx = i;
  });
  assert.ok(borderIdx >= 0 && borderIdx < mainIdx, "widget 在 editor 下边框之下（belowEditor 位置）");
});

test("widget 场景：真实宿主包装下背景块连续等宽、选中行更强背景、不折行", () => {
  const scene = captureWidgetScene({ cols: 120, rows: 14 });
  const { grid, cols } = scene;
  const bgRows = grid
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.some((cell) => cell?.bg));
  assert.equal(bgRows.length, 5, `widget 帧 5 行（main/leader/2 成员/提示）不得折行，实得背景物理行 ${bgRows.length}`);

  for (const { row, index } of bgRows) {
    const firstBg = row[1]?.bg;
    assert.ok(firstBg, `物理行 ${index}: 内容列（1..${cols - 2}）必须带背景`);
    assert.equal(row[0]?.bg, null, `物理行 ${index}: 左侧宿主 margin 落在背景之外`);
    assert.equal(row[cols - 1]?.bg, null, `物理行 ${index}: 右侧宿主 margin 落在背景之外`);
    for (let col = 1; col <= cols - 2; col++) {
      assert.equal(row[col]?.bg, firstBg, `物理行 ${index} 列 ${col}: 背景必须连续等宽`);
    }
  }

  const selectedRow = bgRows.find(({ row }) => row.some((cell) => cell?.ch === "▸"));
  assert.ok(selectedRow, "展开态应有选中行（▸）");
  const selectedBg = selectedRow!.row[1]?.bg;
  const normalBg = bgRows.find((entry) => entry.index !== selectedRow!.index)!.row[1]?.bg;
  assert.notEqual(selectedBg, normalBg, "选中行背景必须与普通行不同（更强）");
  for (const { row, index } of bgRows) {
    if (index === selectedRow!.index) continue;
    assert.equal(row[1]?.bg, normalBg, `物理行 ${index}: 普通行共享同一背景色`);
  }
  assert.ok(bgRows.at(-1)!.row.some((cell) => cell?.ch === "↑"), "底部提示行在背景块内");

  const text = scene.lines.join("\n");
  assert.ok(text.includes("├─ front"), "非末项成员行在背景块内");
  assert.ok(text.includes("╰─ back"), "末项圆角成员行在背景块内");
});

test("widget 场景折叠态（真实宿主包装）：单行背景等宽铺满内容区", () => {
  const scene = captureWidgetScene({ cols: 120, rows: 14, selected: false });
  const { grid, cols } = scene;
  const bgRows = grid.filter((row) => row.some((cell) => cell?.bg));
  assert.equal(bgRows.length, 1, "折叠态恰好 1 行且有背景");
  const row = bgRows[0]!;
  assert.ok(row[1]?.bg, "折叠行内容列有背景");
  assert.equal(row[0]?.bg, null);
  assert.equal(row[cols - 1]?.bg, null);
  for (let col = 1; col <= cols - 2; col++) {
    assert.equal(row[col]?.bg, row[1]?.bg, `折叠行列 ${col}: 背景连续等宽`);
  }
  assert.ok(
    scene.lines.some((line) => line.includes("agent-team count-duet · ↓/← 查看详情")),
    "折叠单行文案不变",
  );
});

test("widget 场景窄宽度（20 列）：背景块不折行、不超宽、每行等宽", () => {
  const scene = captureWidgetScene({ cols: 20, rows: 14 });
  const { grid, cols } = scene;
  const bgRows = grid
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.some((cell) => cell?.bg));
  assert.equal(bgRows.length, 5, `20 列下依然 5 个物理行（没折行），实得 ${bgRows.length}`);
  for (const { row, index } of bgRows) {
    const firstBg = row[1]?.bg;
    assert.ok(firstBg, `物理行 ${index}: 内容列必须有背景`);
    assert.equal(row[0]?.bg, null);
    assert.equal(row[cols - 1]?.bg, null);
    for (let col = 1; col <= cols - 2; col++) {
      assert.equal(row[col]?.bg, firstBg, `物理行 ${index} 列 ${col}: 背景连续等宽`);
    }
  }
  assert.ok(scene.lines.some((line) => line.includes("…")), "窄宽度内容截断为 …（不溢出）");
});

test("widget 产物：确定性 + 进 captureAll", () => {
  const a = captureWidgetScene();
  const b = captureWidgetScene();
  assert.equal(a.lines.join("\n"), b.lines.join("\n"));
  const shot = captureAll().find((s) => s.name === "agent-team-widget.svg");
  assert.ok(shot, "captureAll 必须含 widget 截图");
  assert.ok(shot.svg.includes("▸ leader count-duet"), "SVG 含展开态 leader 行");
});

// ---------------------------------------------------------------------------
// ask 场景（#70 长提问三档宽度走查）：真实 AskView overlay + 真实 TuiMainScreen
// 合成路径，产出 initial/bottom/follow/enter-clean/esc-clean 五帧。与
// viewer-ask-host.test.ts 用例 7 同链路（真实输入路由），此处只锁"走查证据能否
// 可信产出"（几何/锚点/确定性/清理），不重复交互正确性。
// ---------------------------------------------------------------------------

const ASK_WIDTHS = [80, 60, 40] as const;

/** 帧宽期望：宿主 resolveOverlayLayout（pi-tui dist/tui.js）= clamp(max(95%×cols, minWidth 60), cols−2)。 */
const ASK_FRAME_WIDTHS: Record<(typeof ASK_WIDTHS)[number], number> = { 80: 76, 60: 58, 40: 38 };

/** ↓ 六次：选中第 7 项（rows=24 时选项窗口高 6，触发窗口跟随）。 */
const ASK_DOWN_KEYS = Array.from({ length: 6 }, () => "\x1b[B");

const ASK_FRAME_CHARS = new Set(["╭", "╮", "╰", "╯", "─", "│", "├", "┤"]);

type AskScene = ReturnType<typeof captureAskScene>;
type AskFrame = AskScene["frames"][number];

function askFrameOf(scene: AskScene, label: string): AskFrame {
  const frame = scene.frames.find((candidate) => candidate.label === label);
  assert.ok(frame, `缺少 ${label} 帧`);
  return frame;
}

/** 边框之间的内容（帧行带左右宿主 margin 缩进）。 */
function innerBetweenBorders(line: string): string {
  return line.slice(line.indexOf("│") + 1, line.lastIndexOf("│"));
}

test("ask 场景：三档宽度（80/60/40）初始帧产出且含题面/选项窗口/静态超时锚点", () => {
  for (const cols of ASK_WIDTHS) {
    const scene = captureAskScene({ cols });
    const initial = askFrameOf(scene, "initial");
    assert.equal(initial.label, "initial");
    assert.equal(assertAskFrame(initial.lines), true, `${cols} 列：帧自检应通过`);
    const text = initial.lines.join("\n");
    assert.ok(text.includes("部署方案二选一"), `${cols} 列：题面开头可见`);
    assert.ok(text.includes("可选（共 8 项，显示 1-6"), `${cols} 列：选项窗口表头可见`);
    assert.ok(text.includes("› 方案 1"), `${cols} 列：选中标记在首项`);
    assert.ok(text.includes("超时：10 分钟后自动取消"), `${cols} 列：静态超时文案可见`);
    assert.ok(!text.includes("第 30 段"), `${cols} 列：前置——题面尾部不在首屏`);
  }
  assert.throws(() => assertAskFrame(["nothing here"]), /缺少锚点/);
});

test("ask 场景帧几何：宿主钳位宽度 76/58/38、边框连续、不越终端右缘", () => {
  for (const cols of ASK_WIDTHS) {
    const scene = captureAskScene({ cols });
    const grid = askFrameOf(scene, "initial").grid;
    const topRow = grid.find((row) => row.some((cell) => cell?.ch === "╭"));
    assert.ok(topRow, `${cols} 列：应有顶边框行`);
    const left = topRow.findIndex((cell) => cell?.ch === "╭");
    const right = topRow.findIndex((cell) => cell?.ch === "╮");
    // 宿主 resolveOverlayLayout 公式锁定：帧宽 = clamp(max(95%×cols, minWidth 60), cols−2)——宿主漂移即红。
    assert.equal(right - left + 1, ASK_FRAME_WIDTHS[cols], `${cols} 列：帧宽应为钳位结果 ${ASK_FRAME_WIDTHS[cols]}`);
    for (let col = left + 1; col < right; col++) {
      assert.equal(topRow[col]?.ch, "─", `${cols} 列：顶边框列 ${col} 断裂`);
    }
    // 判定标准 2：帧单元格不得越出帧左右缘（col 0 / 右缘以外是主屏背景）。
    for (const row of grid) {
      for (let col = 0; col < cols; col++) {
        if (col >= left && col <= right) continue;
        const ch = row[col]?.ch ?? "";
        assert.ok(!ASK_FRAME_CHARS.has(ch), `${cols} 列：帧字符「${ch}」越出帧缘（col ${col}）`);
      }
    }
  }
});

test("ask 场景 40 列：完整帧渲染（非 ASK_MIN_WIDTH 单行提示）+ 题面折行 + 尾行可读", () => {
  const scene = captureAskScene({ cols: 40 });
  const initial = askFrameOf(scene, "initial");
  const text = initial.lines.join("\n");
  assert.ok(!text.includes("至少需要 36 列"), "40 列不得落到 ASK_MIN_WIDTH 单行提示分支（宿主钳位到 38）");

  const bottomRow = initial.grid.find((row) => row.some((cell) => cell?.ch === "╰"));
  assert.ok(bottomRow, "应有底边框行");
  const left = bottomRow.findIndex((cell) => cell?.ch === "╰");
  const right = bottomRow.findIndex((cell) => cell?.ch === "╯");
  assert.ok(left >= 0 && right > left, "底边框 ╰…╯ 应完整");
  for (let col = left + 1; col < right; col++) {
    assert.equal(bottomRow[col]?.ch, "─", `40 列：底边框列 ${col} 断裂`);
  }

  const timeoutLine = initial.lines.find((line) => line.includes("超时：10 分钟后自动取消"));
  assert.ok(timeoutLine, "尾行应有静态超时文案");
  assert.ok(timeoutLine.includes("超时：10 分钟后自动取消│"), "40 列下超时文案右端紧贴右边框（可读）");

  const firstParagraph = initial.lines.findIndex((line) => line.includes("第 1 段："));
  assert.ok(firstParagraph >= 0, "首屏应可见第 1 段开头");
  assert.ok(initial.lines[firstParagraph + 1]?.includes("细节"), "折行续行以「细节」开头（按显示宽度折行而非截断）");

  const title = initial.lines.findIndex((line) => line.includes("部署方案二选一"));
  assert.ok(title >= 0, "首屏应可见题面标题行");
  assert.equal(innerBetweenBorders(initial.lines[title + 1] ?? "").trim(), "", "题面首行后段落空行保留");
});

test("ask 场景：PgDn 到底第 30 段可见且钳位（再翻帧不变）", () => {
  for (const cols of ASK_WIDTHS) {
    const scene = captureAskScene({ cols, steps: [{ label: "bottom" }, { label: "bottom-clamped", keys: ["\x1b[6~"] }] });
    const bottom = askFrameOf(scene, "bottom");
    const text = bottom.lines.join("\n");
    assert.ok(text.includes("第 30 段"), `${cols} 列：自适应 PgDn 应到底（第 30 段可见）`);
    assert.ok(!text.includes("第 1 段"), `${cols} 列：到底后题面头部应滚出窗口`);
    assert.equal(askFrameOf(scene, "bottom-clamped").lines.join("\n"), text, `${cols} 列：到底后再翻页帧不变（maxScroll 钳位）`);
  }
});

test("ask 场景：选项窗口跟随——↓×6 后显示 2-7、选中标记在方案 7、方案 1 滚出", () => {
  for (const cols of ASK_WIDTHS) {
    const scene = captureAskScene({ cols, steps: [{ label: "follow", keys: ASK_DOWN_KEYS }] });
    const follow = askFrameOf(scene, "follow");
    const text = follow.lines.join("\n");
    assert.ok(text.includes("显示 2-7"), `${cols} 列：选项表头应显示 2-7`);
    assert.ok(text.includes("› 方案 7"), `${cols} 列：选中标记应在方案 7`);
    assert.ok(!text.includes("方案 1"), `${cols} 列：方案 1 应滚出窗口`);

    // 选中态：› 与标签同为 accent（模板中 marker 与标签之间一格分隔空格不着色，不参与连续断言）。
    const selected = follow.grid.find((row) => row.some((cell) => cell?.ch === "›"));
    assert.ok(selected, `${cols} 列：应有选中行`);
    const marker = selected.findIndex((cell) => cell?.ch === "›");
    assert.equal(selected[marker]?.fg, DARK.accent, `${cols} 列：选中标记应为 accent 色`);
    const rightBorder = selected.findIndex((cell, col) => col > marker && cell?.ch === "│");
    assert.ok(rightBorder > marker, `${cols} 列：选中行应有右边框`);
    const labelCells = selected.slice(marker + 1, rightBorder).filter((cell) => (cell?.ch ?? "").trim() !== "");
    assert.ok(labelCells.length > 0, `${cols} 列：选中项标签应有可见字符`);
    for (const cell of labelCells) assert.equal(cell?.fg, DARK.accent, `${cols} 列：选中项标签应为 accent 色`);

    const joined = follow.grid.map((row) => row.map((cell) => cell?.ch ?? "").join(""));
    const selectedIndex = joined.findIndex((line) => line.includes("›"));
    const plainIndex = joined.findIndex((line, index) => index !== selectedIndex && line.includes("方案 2"));
    assert.ok(plainIndex >= 0, `${cols} 列：应有非选中项在窗口内`);
    assert.ok(!follow.grid[plainIndex]?.some((cell) => cell?.fg === DARK.accent), `${cols} 列：非选中项不得染 accent`);
  }
});

test("ask 场景：Enter 提交后 settled=方案 7、屏面回基线无残行", () => {
  for (const cols of ASK_WIDTHS) {
    const scene = captureAskScene({
      cols,
      steps: [{ label: "follow-again", keys: ASK_DOWN_KEYS }, { label: "enter-clean", keys: ["\r"] }],
    });
    assert.equal(scene.settled, "方案 7", `${cols} 列：Enter 应提交选中项`);
    const clean = askFrameOf(scene, "enter-clean");
    assert.deepEqual(
      clean.lines.map((line) => line.trimEnd()),
      scene.baseline.map((line) => line.trimEnd()),
      `${cols} 列：提交后屏面应回基线（无残行）`,
    );
    const text = clean.lines.join("\n");
    for (const residue of ["╭", "╰", "agent-team 提问", "方案 "]) {
      assert.ok(!text.includes(residue), `${cols} 列：清理帧不得残留「${residue}」`);
    }
  }
});

test("ask 场景：Esc 取消后 settled=undefined、屏面回基线无残行", () => {
  for (const cols of ASK_WIDTHS) {
    const scene = captureAskScene({ cols, steps: [{ label: "esc-clean", keys: ["\x1b"] }] });
    assert.equal(scene.settled, undefined, `${cols} 列：Esc 不应产生答案`);
    const clean = askFrameOf(scene, "esc-clean");
    assert.deepEqual(
      clean.lines.map((line) => line.trimEnd()),
      scene.baseline.map((line) => line.trimEnd()),
      `${cols} 列：取消后屏面应回基线（无残行）`,
    );
    const text = clean.lines.join("\n");
    for (const residue of ["╭", "╰", "agent-team 提问", "方案 "]) {
      assert.ok(!text.includes(residue), `${cols} 列：清理帧不得残留「${residue}」`);
    }
  }
});

test("ask 产物：三档 walkthrough 各 5 帧且确定性（两次捕获逐字节一致）+ captureAll 不受影响", () => {
  for (const cols of ASK_WIDTHS) {
    const first = captureAskWalkthrough({ cols });
    const second = captureAskWalkthrough({ cols });
    assert.deepEqual(
      first.frames.map((frame) => frame.label),
      ["initial", "bottom", "follow", "enter-clean", "esc-clean"],
      `${cols} 列：canonical 帧清单`,
    );
    assert.equal(first.settledEnter, "方案 7", `${cols} 列：walkthrough 的 Enter 答案`);
    assert.equal(first.settledEsc, undefined, `${cols} 列：walkthrough 的 Esc 无答案`);
    assert.equal(second.frames.length, first.frames.length);
    first.frames.forEach((frame, index) => {
      assert.equal(
        frame.lines.join("\n"),
        second.frames[index]?.lines.join("\n"),
        `${cols} 列 ${frame.label} 帧：两次捕获应逐字节一致`,
      );
    });
  }
  assert.deepEqual(
    captureAll().map((shot) => shot.name),
    ["agent-team-viewer.svg", "pwr-viewer.svg", "agent-team-widget.svg"],
    "captureAll 名单不变（ask 帧不进 docs/assets）",
  );
});
