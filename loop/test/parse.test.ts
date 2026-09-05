import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLoopCommand, formatInterval, MIN_INTERVAL_MS } from "../parse.ts";
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
