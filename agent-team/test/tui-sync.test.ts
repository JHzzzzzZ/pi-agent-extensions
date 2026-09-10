/**
 * agent-team — TUI/pi-subagents 同步规格锁（seam A：常量字面量）
 *
 * 期望值一律抄自 docs/tui-sync.md §4「规格字面量表」（该表抄自
 * pi-subagents v0.66.0 源码），禁止从被测实现复制——测试与实现同源即废。
 * 本文件锁死：viewer tick = fleet REFRESH_MS 750；overlay 几何五字段
 * verbatim（防几何/节流被改导致重影复发）。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIEWER_ACTION_KEYS,
  VIEWER_CHROME_ROWS,
  VIEWER_LEGEND,
  VIEWER_OVERLAY_OPTIONS,
  computeFrameHeight,
  computeViewerLayout,
  initialViewerState,
  plainStyles,
  renderViewerFrame,
  type Styles,
  type ViewerData,
} from "../viewer.ts";
import type { TranscriptEntry } from "../transcript.ts";
import { VIEWER_TICK_MS } from "../types.ts";

test("VIEWER_TICK_MS 对齐 fleet REFRESH_MS = 750（fleet.ts:25）", () => {
  // 规格表：REFRESH_MS = 750（fleet.ts:25）。当前实现若被改回 800 或其它
  // 值，说明与 pi-subagents 节流脱节——重影风险的第一个信号。
  assert.equal(VIEWER_TICK_MS, 750);
});

test("VIEWER_OVERLAY_OPTIONS 五字段逐字对齐 fleet overlayOptions（fleet.ts:1440）", () => {
  // 规格表：{ anchor:"center", width:"95%", minWidth:60, maxHeight:"85%", margin:1 }
  // 照抄 openSubagentFleet 的 overlayOptions——该检查器在同一宿主家族无条件
  // 每 750ms 重绘也不重影，几何任何偏差都是重影嫌疑。
  assert.deepEqual(VIEWER_OVERLAY_OPTIONS, {
    anchor: "center",
    width: "95%",
    minWidth: 60,
    maxHeight: "85%",
    margin: 1,
  });
});

test("viewer 动作键位全面对齐 fleet DEFAULT_FLEET_KEYBINDINGS（fleet.ts:33-48）", () => {
  // 规格表 §4（v0.66.0）：与 fleet 同名动作键集逐字一致（大写滚动键经
  // matchesKey 大写→shift+小写转换判定）；agent-team 无 steer/inspect 对应
  // 语义，未列入。键位漂移即与 fleet 交互脱节。
  assert.deepEqual(VIEWER_ACTION_KEYS, {
    close: ["escape", "ctrl+c", "q"],
    scrollUp: ["K"],
    scrollDown: ["J"],
    selectUp: ["up", "k"],
    selectDown: ["down", "j"],
    selectFirst: ["home"],
    selectLast: ["end"],
    pageUp: ["pageUp"],
    pageDown: ["pageDown"],
    refresh: ["r", "R"],
    stop: ["D"],
    toggleTools: ["x", "X", "ctrl+o"],
  });
});

test("viewer 图例为 fleet footer 风格（含成员/滚动/翻页/工具行与特有 m/D/r/q）", () => {
  assert.match(VIEWER_LEGEND, /↑↓ 成员/);
  assert.match(VIEWER_LEGEND, /J\/K 滚动/);
  assert.match(VIEWER_LEGEND, /PgUp\/PgDn 翻页/);
  assert.match(VIEWER_LEGEND, /x 工具行/);
  assert.match(VIEWER_LEGEND, /m 发消息/);
  assert.match(VIEWER_LEGEND, /D 停止/);
  assert.match(VIEWER_LEGEND, /r 刷新/);
  assert.match(VIEWER_LEGEND, /q 关闭/);
});

// ---------------------------------------------------------------------------
// 分栏几何规格（v1.6.0，抄自 §4 新增行；期望值不从实现复制）
// ---------------------------------------------------------------------------

const styles: Styles = plainStyles();

function entry(kind: TranscriptEntry["kind"], text: string): TranscriptEntry {
  return { kind, text, ts: "2026-09-06T12:34:56.000Z" };
}

function splitData(): ViewerData {
  return {
    team: "dev-team",
    runId: "run-42",
    runStatus: "running",
    actors: [
      { actor: "_leader", label: "leader", status: "running" },
      { actor: "frontend", label: "frontend", status: "done" },
    ],
    entries: new Map<string, TranscriptEntry[]>([["_leader", [entry("task", "任务"), entry("assistant", "回复")]]]),
  };
}

test("chrome 行数 = 6（顶边框/标题/上分隔/下分隔/图例/底边框，§4 帧结构）", () => {
  assert.equal(VIEWER_CHROME_ROWS, 6);
});

test("帧高与分栏几何公式逐字对齐 fleet.ts:1322-1329（§4）", () => {
  assert.equal(computeFrameHeight(40), 28, "max(2, floor(rows*0.85)-6)");
  assert.deepEqual(computeViewerLayout(80), { innerWidth: 78, rosterWidth: 29, detailWidth: 48 });
  assert.deepEqual(computeViewerLayout(200), { innerWidth: 198, rosterWidth: 46, detailWidth: 151 });
});

test("最小宽度门：width<36 → 单行提示（fleet.ts:1321 同构）", () => {
  const frame = renderViewerFrame(splitData(), initialViewerState(), 35, { styles, bodyHeight: 8 });
  assert.equal(frame.length, 1);
  assert.match(frame[0], /36 列/);
});

// 类型使用锚：防止 viewer.ts 的 OverlayOptions 引用被误删（编译期锁）。
const _overlayTypeAnchor: typeof VIEWER_OVERLAY_OPTIONS = { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 };
void _overlayTypeAnchor;
void (null as unknown as ViewerData); // 保持 import 面最小
