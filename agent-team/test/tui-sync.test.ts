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
import { VIEWER_OVERLAY_OPTIONS, type ViewerData } from "../viewer.ts";
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

// 类型使用锚：防止 viewer.ts 的 OverlayOptions 引用被误删（编译期锁）。
const _overlayTypeAnchor: typeof VIEWER_OVERLAY_OPTIONS = { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 };
void _overlayTypeAnchor;
void (null as unknown as ViewerData); // 保持 import 面最小
