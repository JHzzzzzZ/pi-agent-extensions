/**
 * widget 排序带（跨插件契约 docs/cross/status-bar.md）——loop 目录内那份拷贝的语义测试。
 *
 * 边界：
 * - 本文件只测登记表语义（合并顺序 / owner 移交 / 卸载 / 文本指纹 / 异常隔离），
 *   宿主键 `widget-band` 的写入用记录型假 ui 观察——假的是进程边界（UI 上下文），
 *   不是被测行为本身。
 * - 真实宿主 `InteractiveMode.setExtensionWidget`（每次写入 delete+set 沉底）接真实
 *   pi-tui 容器渲染的验证在 pwr 侧 `tests/ui-widget-band-host.test.ts`。
 * - 登记表挂在 globalThis（Symbol.for），同进程跨用例共享：每个用例 finally 清登记。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { HOST_WIDGET_KEY, writeWidgetBand } from "../widget-band.ts";

/** 三段排序带键：pwr < run-timer < loop（契约见 docs/cross/status-bar.md）。 */
const PWR = "10:pwr-runs";
const TIMER = "20:run-timer";
const LOOP = "30:loop";

interface Write {
  key: string;
  lines: string[] | undefined;
  placement?: string;
}

function recordingUi(writes: Write[]): ExtensionUIContext {
  return {
    setWidget: (key: string, lines: string[] | undefined, options?: { placement?: string }) => {
      writes.push({ key, lines, placement: options?.placement });
    },
  } as never;
}

/** 卸载三段登记（清理全局登记表，避免用例之间串味）。 */
function clearBands(ui: ExtensionUIContext): void {
  for (const key of [PWR, TIMER, LOOP]) writeWidgetBand(key, undefined, ui);
}

describe("widget 排序带（loop 拷贝）", () => {
  it("三段按排序带键升序合并成一次宿主写入，段间不加分隔符", () => {
    const writes: Write[] = [];
    const ui = recordingUi(writes);
    try {
      // 乱序登记：合并顺序只看 band key，不看登记先后。
      writeWidgetBand(LOOP, ["⏰ loop 1 个任务 · 下次 04:32"], ui);
      writeWidgetBand(PWR, ["PWR runs:", "  ▶ 00000042 audit"], ui);
      writeWidgetBand(TIMER, ["任务 00:01 · 本轮 00:00 · 本会话 00:01"], ui);

      const last = writes.at(-1)!;
      assert.equal(last.key, HOST_WIDGET_KEY, "只写宿主单键");
      assert.deepEqual(last.lines, [
        "PWR runs:",
        "  ▶ 00000042 audit",
        "任务 00:01 · 本轮 00:00 · 本会话 00:01",
        "⏰ loop 1 个任务 · 下次 04:32",
      ]);
      assert.equal(last.placement, "aboveEditor", "位置与现状一致：编辑器上方");
      assert.ok(
        writes.every((w) => w.key === HOST_WIDGET_KEY),
        "任何一次刷新都只写宿主单键（宿主 delete+set 沉底不再影响段间顺序）",
      );
      assert.ok(!last.lines!.join("\n").includes("│"), "段间不加分隔符（widget 是多行块）");
    } finally {
      clearBands(ui);
    }
  });

  it("错位刷新 12 帧：每帧仍是单键写入，且合并顺序恒定", () => {
    const writes: Write[] = [];
    const ui = recordingUi(writes);
    const state: Record<string, string[]> = {
      [PWR]: ["PWR runs:", "  ▶ 00000042 audit"],
      [TIMER]: ["任务 00:01 · 本轮 00:00"],
      [LOOP]: ["⏰ loop 1 个任务 · 下次 04:32"],
    };
    try {
      const keys = [PWR, TIMER, LOOP];
      /** 各段最后一次提交的行（未登记的段不参与合并）。 */
      const current: Array<string[] | undefined> = [undefined, undefined, undefined];
      for (let frame = 0; frame < 12; frame++) {
        const index = frame % 3;
        const key = keys[index]!;
        state[key] = state[key]!.map((line) => `${line} f${frame}`);
        current[index] = state[key]!;
        writeWidgetBand(key, current[index], ui);

        const last = writes.at(-1)!;
        assert.equal(last.key, HOST_WIDGET_KEY, `第 ${frame} 帧仍写宿主单键`);
        assert.deepEqual(
          last.lines,
          current.flatMap((lines) => lines ?? []),
          `第 ${frame} 帧合并顺序恒定`,
        );
      }
    } finally {
      clearBands(ui);
    }
  });

  it("owner = 排序带键最小者；owner 清空自动移交，其余段照常刷新", () => {
    const writesA: Write[] = [];
    const writesB: Write[] = [];
    const uiA = recordingUi(writesA);
    const uiB = recordingUi(writesB);
    try {
      writeWidgetBand(PWR, ["PWR runs:"], uiA);
      writeWidgetBand(TIMER, ["任务 00:01"], uiB);
      assert.deepEqual(writesA.at(-1)!.lines, ["PWR runs:", "任务 00:01"], "最小的可见段当 owner");
      assert.equal(writesB.length, 0, "非 owner 不写宿主");

      writeWidgetBand(PWR, undefined, uiA);
      assert.deepEqual(writesB.at(-1)!.lines, ["任务 00:01"], "owner 清空后由次小段接管写入");
      assert.equal(writesB.at(-1)!.key, HOST_WIDGET_KEY);

      writeWidgetBand(TIMER, ["任务 00:02"], uiB);
      assert.deepEqual(writesB.at(-1)!.lines, ["任务 00:02"], "移交后其余段仍正常刷新");
    } finally {
      clearBands(uiA);
      clearBands(uiB);
    }
  });

  it("全段清空卸载宿主键；随后同内容重新登记会重新写入", () => {
    const writes: Write[] = [];
    const ui = recordingUi(writes);
    try {
      writeWidgetBand(PWR, ["PWR runs:"], ui);
      writeWidgetBand(TIMER, ["任务 00:01"], ui);
      writeWidgetBand(PWR, undefined, ui);
      writeWidgetBand(TIMER, undefined, ui);
      assert.equal(writes.at(-1)!.key, HOST_WIDGET_KEY);
      assert.equal(writes.at(-1)!.lines, undefined, "全空 → 卸载宿主键（无残行）");

      const before = writes.length;
      writeWidgetBand(PWR, ["PWR runs:"], ui);
      assert.equal(writes.length, before + 1, "卸载重置指纹，重新出现必写一次");
      assert.deepEqual(writes.at(-1)!.lines, ["PWR runs:"]);
    } finally {
      clearBands(ui);
    }
  });

  it("同一 ui + 相同行不重复写宿主（文本指纹）", () => {
    const writes: Write[] = [];
    const ui = recordingUi(writes);
    try {
      writeWidgetBand(TIMER, ["任务 00:01"], ui);
      const before = writes.length;
      writeWidgetBand(TIMER, ["任务 00:01"], ui);
      assert.equal(writes.length, before, "内容未变不踢宿主重绘");

      writeWidgetBand(TIMER, ["任务 00:02"], ui);
      assert.equal(writes.length, before + 1, "内容变化照常写入");
      assert.deepEqual(writes.at(-1)!.lines, ["任务 00:02"]);
    } finally {
      clearBands(ui);
    }
  });

  it("ui 身份变化（会话/重载边界）时同内容也重写一次", () => {
    const writesA: Write[] = [];
    const writesB: Write[] = [];
    const uiA = recordingUi(writesA);
    const uiB = recordingUi(writesB);
    try {
      writeWidgetBand(TIMER, ["任务 00:01"], uiA);
      writeWidgetBand(TIMER, ["任务 00:01"], uiB);
      assert.deepEqual(writesB.at(-1)!.lines, ["任务 00:01"], "新会话的新 ui 必须重新落一次（宿主重绑会清 widget）");
    } finally {
      clearBands(uiA);
      clearBands(uiB);
    }
  });

  it("空数组等同 undefined（本段不显示）", () => {
    const writes: Write[] = [];
    const ui = recordingUi(writes);
    try {
      writeWidgetBand(PWR, [], ui);
      assert.equal(writes.length, 0, "空段不产生宿主行（不存在的键无需清）");

      writeWidgetBand(TIMER, ["任务 00:01"], ui);
      writeWidgetBand(PWR, [], ui);
      assert.deepEqual(writes.at(-1)!.lines, ["任务 00:01"], "空段不占位、不改变合并结果");
    } finally {
      clearBands(ui);
    }
  });

  it("写入异常被吞掉，不影响登记表与后续段", () => {
    const writes: Write[] = [];
    const boom = {
      setWidget: () => {
        throw new Error("UI 崩了");
      },
    } as never;
    const ui = recordingUi(writes);
    try {
      assert.doesNotThrow(() => writeWidgetBand(PWR, ["PWR runs:"], boom));
      writeWidgetBand(TIMER, ["任务 00:01"], ui);
      writeWidgetBand(PWR, undefined, ui);
      assert.deepEqual(writes.at(-1)!.lines, ["任务 00:01"], "坏 ui 不影响其余段");
    } finally {
      clearBands(ui);
    }
  });
});
