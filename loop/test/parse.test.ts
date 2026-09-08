import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLoopCommand, parseSchedule, formatInterval, MIN_INTERVAL_MS } from "../parse.ts";
import type { CreateSpec } from "../parse.ts";

// 固定"当前时刻"：本地 2026-09-05 10:00:00
const BASE = new Date(2026, 8, 5, 10, 0, 0).getTime();

function createSpec(value: unknown): CreateSpec {
  assert.equal(typeof value, "object");
  const cmd = value as { kind: string; spec?: CreateSpec };
  assert.equal(cmd.kind, "create");
  assert.ok(cmd.spec);
  return cmd.spec;
}

describe("parseLoopCommand — 空与用法", () => {
  it("空参数 → usage", () => {
    assert.equal(parseLoopCommand("", BASE).ok, true);
    const r = parseLoopCommand("   ", BASE);
    assert.ok(r.ok && r.value.kind === "usage");
  });

  it("无间隔的纯任务文本（MVP 不支持）→ usage", () => {
    const r = parseLoopCommand("check the deploy", BASE);
    assert.ok(r.ok && r.value.kind === "usage");
  });

  it("无法识别的子命令形态 → usage", () => {
    const r = parseLoopCommand("list all pods", BASE);
    assert.ok(r.ok && r.value.kind === "usage");
  });
});

describe("parseLoopCommand — 固定间隔循环", () => {
  it("5m + 任务", () => {
    const r = parseLoopCommand("5m check the deploy", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.deepEqual(
      { recurring: spec.recurring, intervalMs: spec.intervalMs, task: spec.task },
      { recurring: true, intervalMs: 300_000, task: "check the deploy" },
    );
  });

  it("every 前缀：every 30m", () => {
    const r = parseLoopCommand("every 30m walk the dog", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.recurring, true);
    assert.equal(spec.intervalMs, 1_800_000);
    assert.equal(spec.task, "walk the dog");
  });

  it("小时/天单位：2h / 1d", () => {
    const r1 = parseLoopCommand("2h feed cats", BASE);
    assert.ok(r1.ok);
    assert.equal(createSpec(r1.ok ? r1.value : null).intervalMs, 7_200_000);
    const r2 = parseLoopCommand("1d backup", BASE);
    assert.ok(r2.ok);
    assert.equal(createSpec(r2.ok ? r2.value : null).intervalMs, 86_400_000);
  });

  it("完整单词单位：every 2 hours", () => {
    const r = parseLoopCommand("every 2 hours patrol", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.intervalMs, 7_200_000);
    assert.equal(spec.task, "patrol");
  });

  it("秒向上取整到分钟：30s → 1m，90s → 2m", () => {
    const r1 = parseLoopCommand("30s quick", BASE);
    assert.ok(r1.ok);
    assert.equal(createSpec(r1.ok ? r1.value : null).intervalMs, MIN_INTERVAL_MS);
    const r2 = parseLoopCommand("90s quick", BASE);
    assert.ok(r2.ok);
    assert.equal(createSpec(r2.ok ? r2.value : null).intervalMs, 120_000);
  });

  it("只有间隔没有任务 → 报错", () => {
    const r = parseLoopCommand("5m", BASE);
    assert.ok(!r.ok);
    assert.match(r.message, /任务/);
  });

  it("0m / 负数无效 → usage", () => {
    const r = parseLoopCommand("0m task", BASE);
    assert.ok(r.ok && r.value.kind === "usage");
  });

  it("every 后面缺间隔 → 报错", () => {
    const r = parseLoopCommand("every task", BASE);
    assert.ok(!r.ok);
    assert.match(r.message, /间隔/);
  });
});

describe("parseLoopCommand — 一次性提醒", () => {
  it("in 30m：fireAt = now + 30m", () => {
    const r = parseLoopCommand("in 30m push release", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.recurring, false);
    assert.equal(spec.fireAtMs, BASE + 1_800_000);
    assert.equal(spec.task, "push release");
  });

  it("in 90s 一次性不做分钟取整", () => {
    const r = parseLoopCommand("in 90s soon", BASE);
    assert.ok(r.ok);
    assert.equal(createSpec(r.ok ? r.value : null).fireAtMs, BASE + 90_000);
  });

  it("at 15:00 今天未过 → 今天 15:00", () => {
    const r = parseLoopCommand("at 15:00 push release", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    const expected = new Date(2026, 8, 5, 15, 0, 0).getTime();
    assert.equal(spec.fireAtMs, expected);
  });

  it("at 09:00 已过 → 明天 09:00", () => {
    const r = parseLoopCommand("at 09:00 morning", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    const expected = new Date(2026, 8, 6, 9, 0, 0).getTime();
    assert.equal(spec.fireAtMs, expected);
  });

  it("at 25:00 无效 → 报错", () => {
    const r = parseLoopCommand("at 25:00 x", BASE);
    assert.ok(!r.ok);
    assert.match(r.message, /无效时间/);
  });

  it("at 后缺任务 → 报错", () => {
    const r = parseLoopCommand("at 15:00", BASE);
    assert.ok(!r.ok);
    assert.match(r.message, /任务内容/);
  });

  it("in 缺时长 → 报错", () => {
    const r = parseLoopCommand("in later go", BASE);
    assert.ok(!r.ok);
  });
});

describe("parseLoopCommand — 子命令", () => {
  it("list / clear", () => {
    const r1 = parseLoopCommand("list", BASE);
    assert.ok(r1.ok && r1.value.kind === "list");
    const r2 = parseLoopCommand("clear", BASE);
    assert.ok(r2.ok && r2.value.kind === "clear");
  });

  it("pause/resume/delete + id", () => {
    for (const verb of ["pause", "resume", "delete"] as const) {
      const r = parseLoopCommand(`${verb} a1b2c3d4`, BASE);
      assert.ok(r.ok);
      assert.ok(r.ok && r.value.kind === verb && r.value.id === "a1b2c3d4");
    }
  });

  it("pause 缺 id（单词）→ usage", () => {
    const r = parseLoopCommand("pause", BASE);
    assert.ok(r.ok && r.value.kind === "usage");
  });
});

describe("formatInterval", () => {
  it("反向格式化", () => {
    assert.equal(formatInterval(60_000), "1m");
    assert.equal(formatInterval(300_000), "5m");
    assert.equal(formatInterval(7_200_000), "2h");
    assert.equal(formatInterval(86_400_000), "1d");
    assert.equal(formatInterval(172_800_000), "2d");
    assert.equal(formatInterval(90_000), "90s");
  });
});

describe("parseSchedule（agent 工具用）", () => {
  const atMs = (hh: number, mm: number, dayOffset = 0): number => {
    const d = new Date(BASE);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  };

  it("循环：every 5m / 5m / 2 hours / every 2 hours", () => {
    const r1 = parseSchedule("every 5m", BASE);
    assert.ok(r1.ok && r1.value.recurring && r1.value.intervalMs === 300_000);
    const r2 = parseSchedule("5m", BASE);
    assert.ok(r2.ok && r2.value.recurring && r2.value.intervalMs === 300_000);
    const r3 = parseSchedule("2 hours", BASE);
    assert.ok(r3.ok && r3.value.recurring && r3.value.intervalMs === 7_200_000);
    const r4 = parseSchedule("every 2 hours", BASE);
    assert.ok(r4.ok && r4.value.recurring && r4.value.intervalMs === 7_200_000);
  });

  it("循环：30s 向上取整到 1m", () => {
    const r = parseSchedule("30s", BASE);
    assert.ok(r.ok && r.value.recurring && r.value.intervalMs === MIN_INTERVAL_MS);
  });

  it("一次性：in 30m", () => {
    const r = parseSchedule("in 30m", BASE);
    assert.ok(r.ok && !r.value.recurring && r.value.fireAtMs === BASE + 1_800_000);
  });

  it("一次性：at 15:00 今天未过 → 今天；at 09:00 已过 → 明天", () => {
    const r1 = parseSchedule("at 15:00", BASE);
    assert.ok(r1.ok && !r1.value.recurring && r1.value.fireAtMs === atMs(15, 0));
    const r2 = parseSchedule("at 09:00", BASE);
    assert.ok(r2.ok && !r2.value.recurring && r2.value.fireAtMs === atMs(9, 0, 1));
  });

  it("非法输入全部报错", () => {
    for (const bad of ["", "abc", "every", "0m", "in", "in 30m extra", "at", "at 25:00", "at 15:00 extra", "5m extra"]) {
      const r = parseSchedule(bad, BASE);
      assert.ok(!r.ok, `"${bad}" 应解析失败`);
    }
  });
});

describe("parseLoopCommand — daily / 每日时间窗口（v1.2）", () => {
  const localAt = (dayOffset: number, hh: number, mm: number): number => {
    const d = new Date(BASE);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  };

  it("daily at 15:00 今天未过 → 今天 15:00，schedule.daily", () => {
    const r = parseLoopCommand("daily at 15:00 晨会", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.recurring, true);
    assert.deepEqual(spec.schedule, { kind: "daily", atMs: 15 * 3_600_000 });
    assert.equal(spec.fireAtMs, localAt(0, 15, 0));
    assert.equal(spec.task, "晨会");
  });

  it("daily at 09:00 已过 → 明天 09:00", () => {
    const r = parseLoopCommand("daily at 09:00 晨会", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.fireAtMs, localAt(1, 9, 0));
  });

  it("every day at 09:00 等价 daily at", () => {
    const r = parseLoopCommand("every day at 09:00 早报", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.deepEqual(spec.schedule, { kind: "daily", atMs: 9 * 3_600_000 });
    assert.equal(spec.fireAtMs, localAt(1, 9, 0));
  });

  it("大小写不敏感：Daily AT 09:00", () => {
    const r = parseLoopCommand("Daily AT 09:00 早报", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.deepEqual(spec.schedule, { kind: "daily", atMs: 9 * 3_600_000 });
  });

  it("daily 缺 at → 报错", () => {
    const r = parseLoopCommand("daily 09:00 早报", BASE);
    assert.ok(!r.ok);
    assert.match(r.message, /用法/);
  });

  it("daily at 25:00 → 报错", () => {
    const r = parseLoopCommand("daily at 25:00 x", BASE);
    assert.ok(!r.ok);
    assert.match(r.message, /无效时间/);
  });

  it("daily 缺任务 → 报错", () => {
    const r = parseLoopCommand("daily at 09:00", BASE);
    assert.ok(!r.ok);
    assert.match(r.message, /任务内容/);
  });

  it("every 1h from 00:00 to 09:00：窗口闭区间，BASE 已过窗口 → 明天 00:00", () => {
    const r = parseLoopCommand("every 1h from 00:00 to 09:00 夜间巡检", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.deepEqual(spec.schedule, {
      kind: "window", intervalMs: 3_600_000, startMs: 0, endMs: 9 * 3_600_000,
    });
    assert.equal(spec.fireAtMs, localAt(1, 0, 0));
    assert.equal(spec.task, "夜间巡检");
  });

  it("窗口内首触发取下一个网格点：BASE 10:00，from 08:00 to 22:00 every 2h → 今天 12:00", () => {
    const r = parseLoopCommand("every 2h from 08:00 to 22:00 patrol", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.fireAtMs, localAt(0, 12, 0));
  });

  it("窗口间隔秒向上取整：every 30s → 1m", () => {
    const r = parseLoopCommand("every 30s from 00:00 to 09:00 x", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.ok(spec.schedule?.kind === "window");
    assert.equal(spec.schedule.intervalMs, MIN_INTERVAL_MS);
  });

  it("start >= end → 报错", () => {
    const r1 = parseLoopCommand("every 1h from 09:00 to 09:00 x", BASE);
    assert.ok(!r1.ok);
    assert.match(r1.message, /起点需早于终点/);
    const r2 = parseLoopCommand("every 1h from 10:00 to 09:00 x", BASE);
    assert.ok(!r2.ok);
    assert.match(r2.message, /起点需早于终点/);
  });

  it("窗口时刻非法 → 报错", () => {
    const r = parseLoopCommand("every 1h from 25:00 to 09:00 x", BASE);
    assert.ok(!r.ok);
    assert.match(r.message, /无效时间/);
  });

  it("窗口缺任务 → 报错", () => {
    const r = parseLoopCommand("every 1h from 00:00 to 09:00", BASE);
    assert.ok(!r.ok);
    assert.match(r.message, /任务内容/);
  });

  it("非窗口语法的 from 开头任务文本仍按固定间隔解析", () => {
    const r = parseLoopCommand("5m from the deploy logs", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.intervalMs, 300_000);
    assert.equal(spec.schedule, undefined);
    assert.equal(spec.task, "from the deploy logs");
  });
});

describe("parseLoopCommand — --bg 后台模式（v1.3）", () => {
  it("--bg 5m + 任务 → background 标记", () => {
    const r = parseLoopCommand("--bg 5m check the deploy", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.background, true);
    assert.equal(spec.recurring, true);
    assert.equal(spec.intervalMs, 300_000);
    assert.equal(spec.task, "check the deploy");
  });

  it("--bg in 30m / --bg at 22:00 一次性", () => {
    const r1 = parseLoopCommand("--bg in 30m push release", BASE);
    assert.ok(r1.ok);
    const s1 = createSpec(r1.ok ? r1.value : null);
    assert.equal(s1.background, true);
    assert.equal(s1.fireAtMs, BASE + 1_800_000);
    assert.equal(s1.task, "push release");

    const r2 = parseLoopCommand("--bg at 22:00 发布版本", BASE);
    assert.ok(r2.ok);
    const s2 = createSpec(r2.ok ? r2.value : null);
    assert.equal(s2.background, true);
    assert.equal(s2.fireAtMs, new Date(2026, 8, 5, 22, 0, 0).getTime());
  });

  it("--bg daily at 09:00", () => {
    const r = parseLoopCommand("--bg daily at 09:00 晨报", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.background, true);
    assert.deepEqual(spec.schedule, { kind: "daily", atMs: 9 * 3_600_000 });
  });

  it("--bg every 30m from 09:00 to 17:00 窗口", () => {
    const r = parseLoopCommand("--bg every 30m from 09:00 to 17:00 巡检", BASE);
    assert.ok(r.ok);
    const spec = createSpec(r.ok ? r.value : null);
    assert.equal(spec.background, true);
    assert.ok(spec.schedule?.kind === "window");
  });

  it("大小写不敏感：--BG", () => {
    const r = parseLoopCommand("--BG 5m x", BASE);
    assert.ok(r.ok);
    assert.equal(createSpec(r.ok ? r.value : null).background, true);
  });

  it("无 --bg 的形态不带 background 字段（保持既有语义兼容）", () => {
    const r = parseLoopCommand("5m check the deploy", BASE);
    assert.ok(r.ok);
    assert.equal(createSpec(r.ok ? r.value : null).background, undefined);
  });

  it("--bg 单独出现 → usage；--bg 不劫持管理子命令（--bg list → usage）", () => {
    const r1 = parseLoopCommand("--bg", BASE);
    assert.ok(r1.ok && r1.value.kind === "usage");
    const r2 = parseLoopCommand("--bg list", BASE);
    assert.ok(r2.ok && r2.value.kind === "usage");
  });
});

describe("parseSchedule — daily / 时间窗口（v1.2）", () => {
  const localAt = (dayOffset: number, hh: number, mm: number): number => {
    const d = new Date(BASE);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  };

  it("daily at 09:00 / every day at 09:00", () => {
    const r1 = parseSchedule("daily at 09:00", BASE);
    assert.ok(r1.ok && r1.value.recurring && r1.value.schedule?.kind === "daily");
    assert.equal(r1.ok ? r1.value.fireAtMs : 0, localAt(1, 9, 0));
    const r2 = parseSchedule("every day at 09:00", BASE);
    assert.ok(r2.ok && r2.value.recurring && r2.value.schedule?.kind === "daily");
  });

  it("every 1h from 00:00 to 09:00（省略 every 前缀同样支持）", () => {
    const r1 = parseSchedule("every 1h from 00:00 to 09:00", BASE);
    assert.ok(r1.ok && r1.value.recurring);
    assert.deepEqual(r1.ok ? r1.value.schedule : null, {
      kind: "window", intervalMs: 3_600_000, startMs: 0, endMs: 9 * 3_600_000,
    });
    assert.equal(r1.ok ? r1.value.fireAtMs : 0, localAt(1, 0, 0));
    const r2 = parseSchedule("1h from 0:00 to 9:00", BASE);
    assert.ok(r2.ok && r2.value.recurring && r2.value.schedule?.kind === "window");
  });

  it("非法输入全部报错", () => {
    for (const bad of [
      "daily", "daily 09:00", "daily at", "daily at 09:00 extra", "daily at 25:00",
      "every day", "every day 09:00", "every 1h from 00:00", "every 1h from 00:00 to 09:00 extra",
      "from 00:00 to 09:00", "every 1h from 25:00 to 09:00", "every 1h from 09:00 to 09:00",
    ]) {
      const r = parseSchedule(bad, BASE);
      assert.ok(!r.ok, `"${bad}" 应解析失败`);
    }
  });
});
