import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RecurringSchedule } from "../parse.ts";
import {
  MAX_TASKS,
  MAX_TASK_LEN,
  RECURRING_TTL_MS,
  clearTasks,
  createTask,
  deleteTask,
  describeRecurrence,
  formatCountdown,
  formatClock,
  formatTaskLines,
  formatTimeOfDay,
  hydrateTasks,
  pauseTask,
  pollDue,
  resumeTask,
  resolveTask,
  serializeTasks,
  type LoopTask,
} from "../tasks.ts";

// 任意固定基准时刻（epoch ms）
const BASE = 1_000_000_000_000;

let idCounter = 0;
const genId = () => `id${String(++idCounter).padStart(6, "0")}`;

function makeTask(overrides: Partial<LoopTask> = {}): LoopTask {
  idCounter++;
  return {
    id: `t${String(idCounter).padStart(7, "0")}`,
    task: "测试任务",
    recurring: true,
    intervalMs: 60_000,
    nextDueAt: BASE + 60_000,
    createdAt: BASE,
    paused: false,
    ...overrides,
  };
}

function makeOneShot(nextDueAt: number, overrides: Partial<LoopTask> = {}): LoopTask {
  return makeTask({ recurring: false, intervalMs: undefined, nextDueAt, ...overrides });
}

function makeRecurring(nextDueAt: number, overrides: Partial<LoopTask> = {}): LoopTask {
  return makeTask({ nextDueAt, ...overrides });
}

describe("createTask", () => {
  it("创建并追加，字段按输入填充", () => {
    const tasks: LoopTask[] = [];
    const r = createTask(
      tasks,
      { task: "检查部署", recurring: true, intervalMs: 300_000, fireAtMs: BASE + 300_000, nowMs: BASE },
      genId,
    );
    assert.ok(r.ok);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0], r.ok ? r.task : null);
    assert.equal(r.ok ? r.task.recurring : null, true);
    assert.equal(r.ok ? r.task.intervalMs : null, 300_000);
    assert.equal(r.ok ? r.task.paused : null, false);
  });

  it("一次性任务不携带 intervalMs", () => {
    const tasks: LoopTask[] = [];
    const r = createTask(
      tasks,
      { task: "提醒", recurring: false, fireAtMs: BASE + 5_000, nowMs: BASE },
      genId,
    );
    assert.ok(r.ok);
    assert.equal(r.ok ? r.task.intervalMs : null, undefined);
  });

  it(`上限 ${MAX_TASKS} 个：超出拒绝`, () => {
    const tasks: LoopTask[] = Array.from({ length: MAX_TASKS }, () => makeTask());
    const r = createTask(tasks, { task: "x", recurring: false, fireAtMs: BASE, nowMs: BASE }, genId);
    assert.ok(!r.ok);
    assert.match(r.message, /上限/);
    assert.equal(tasks.length, MAX_TASKS);
  });

  it(`任务内容超过 ${MAX_TASK_LEN} 字符拒绝`, () => {
    const tasks: LoopTask[] = [];
    const r1 = createTask(tasks, { task: "x".repeat(MAX_TASK_LEN), recurring: false, fireAtMs: BASE, nowMs: BASE }, genId);
    assert.ok(r1.ok);
    const r2 = createTask(tasks, { task: "x".repeat(MAX_TASK_LEN + 1), recurring: false, fireAtMs: BASE, nowMs: BASE }, genId);
    assert.ok(!r2.ok);
    assert.match(r2.message, /过长/);
  });

  it("循环任务缺 intervalMs 拒绝（防御工具调用方）", () => {
    const tasks: LoopTask[] = [];
    const r = createTask(tasks, { task: "x", recurring: true, fireAtMs: BASE, nowMs: BASE }, genId);
    assert.ok(!r.ok);
    assert.match(r.message, /间隔/);
  });
});

describe("pollDue", () => {
  it("无到期任务：空结果且不改动", () => {
    const tasks = [makeRecurring(BASE + 60_000), makeOneShot(BASE + 60_000)];
    const r = pollDue(tasks, BASE);
    assert.deepEqual(r.due.map((t) => t.id), []);
    assert.equal(r.changed, false);
    assert.equal(tasks.length, 2);
  });

  it("到期循环任务：触发一次并把 nextDueAt 推进到 now 之后", () => {
    const t = makeRecurring(BASE - 30_000); // 已过 30s，间隔 60s
    const tasks = [t];
    const r = pollDue(tasks, BASE);
    assert.deepEqual(r.due.map((x) => x.id), [t.id]);
    assert.ok(t.nextDueAt > BASE);
    assert.equal(t.nextDueAt, BASE + 30_000); // BASE-30s + 60s
    assert.equal(tasks.length, 1);
  });

  it("错过多个间隔只触发一次（不补跑）", () => {
    const t = makeRecurring(BASE - 180_000); // 落后 3 个间隔
    pollDue([t], BASE);
    assert.ok(t.nextDueAt > BASE);
    assert.equal(t.nextDueAt, BASE + 60_000);
  });

  it("到期一次性任务：触发后自删", () => {
    const t = makeOneShot(BASE - 1_000);
    const tasks = [t];
    const r = pollDue(tasks, BASE);
    assert.deepEqual(r.due.map((x) => x.id), [t.id]);
    assert.equal(tasks.length, 0);
  });

  it("未到期一次性任务保留", () => {
    const tasks = [makeOneShot(BASE + 1_000)];
    pollDue(tasks, BASE);
    assert.equal(tasks.length, 1);
  });

  it("暂停的任务不触发", () => {
    const t = makeRecurring(BASE - 60_000, { paused: true });
    const r = pollDue([t], BASE);
    assert.equal(r.due.length, 0);
    assert.equal(r.changed, false);
  });

  it("过期（7 天）任务剔除；恰好在到期则最后触发一次", () => {
    const due = makeRecurring(BASE, { createdAt: BASE - RECURRING_TTL_MS, nextDueAt: BASE });
    const notDue = makeRecurring(BASE + 60_000, { createdAt: BASE - RECURRING_TTL_MS, id: "x-notdue" });
    const tasks = [due, notDue];
    const r = pollDue(tasks, BASE);
    assert.deepEqual(r.due.map((x) => x.id), [due.id]);
    assert.equal(tasks.length, 0);
    assert.equal(r.changed, true);
  });

  it("暂停的过期任务直接剔除、不触发", () => {
    const t = makeRecurring(BASE, { createdAt: BASE - RECURRING_TTL_MS, paused: true });
    const r = pollDue([t], BASE);
    assert.equal(r.due.length, 0);
    assert.equal(r.changed, true);
  });

  it("多个到期任务按到期先后排序", () => {
    const a = makeOneShot(BASE - 10_000, { id: "aaa" });
    const b = makeOneShot(BASE - 5_000, { id: "bbb" });
    const r = pollDue([b, a], BASE);
    assert.deepEqual(r.due.map((x) => x.id), ["aaa", "bbb"]);
  });
});

describe("pauseTask / resumeTask", () => {
  it("暂停后不再到期；恢复后错过的间隔跳到 now+interval", () => {
    const t = makeRecurring(BASE - 120_000);
    const tasks = [t];
    const p = pauseTask(tasks, t.id);
    assert.ok(p.ok);
    const r1 = pollDue(tasks, BASE);
    assert.equal(r1.due.length, 0);

    const r2 = resumeTask(tasks, t.id, BASE);
    assert.ok(r2.ok);
    assert.equal(t.paused, false);
    assert.equal(t.nextDueAt, BASE + 60_000);
  });

  it("恢复时仍未到期：nextDueAt 不变", () => {
    const t = makeRecurring(BASE + 60_000);
    const tasks = [t];
    pauseTask(tasks, t.id);
    resumeTask(tasks, t.id, BASE);
    assert.equal(t.nextDueAt, BASE + 60_000);
  });

  it("恢复过期中的一次性任务：保持到期（下次 tick 触发）", () => {
    const t = makeOneShot(BASE - 5_000);
    const tasks = [t];
    pauseTask(tasks, t.id);
    resumeTask(tasks, t.id, BASE);
    const r = pollDue(tasks, BASE);
    assert.equal(r.due.length, 1);
  });
});

describe("resolveTask / deleteTask / clearTasks", () => {
  it("精确匹配优先于前缀", () => {
    const tasks = [makeTask({ id: "abc" }), makeTask({ id: "abcdef" })];
    const r = resolveTask(tasks, "abc");
    assert.ok(r.status === "found" && r.task.id === "abc");
  });

  it("唯一前缀命中", () => {
    const tasks = [makeTask({ id: "aaa111" }), makeTask({ id: "bbb222" })];
    const r = resolveTask(tasks, "aaa");
    assert.ok(r.status === "found" && r.task.id === "aaa111");
  });

  it("前缀命中多个 → ambiguous；未命中 → not_found", () => {
    const tasks = [makeTask({ id: "abc1" }), makeTask({ id: "abc2" })];
    assert.equal(resolveTask(tasks, "abc").status, "ambiguous");
    assert.equal(resolveTask(tasks, "zzz").status, "not_found");
  });

  it("deleteTask 按前缀删除", () => {
    const t = makeTask({ id: "abc12345" });
    const tasks = [t];
    const r = deleteTask(tasks, "abc1");
    assert.ok(r.ok);
    assert.equal(tasks.length, 0);
  });

  it("deleteTask 未找到 → 报错消息", () => {
    const r = deleteTask([], "zzzz");
    assert.ok(!r.ok);
    assert.match(r.message, /未找到/);
  });

  it("clearTasks 清空并返回数量", () => {
    const tasks = [makeTask(), makeTask(), makeTask()];
    assert.equal(clearTasks(tasks), 3);
    assert.equal(tasks.length, 0);
  });
});

describe("serializeTasks / hydrateTasks", () => {
  it("序列化 → JSON → 恢复 往返一致", () => {
    const tasks = [
      makeRecurring(BASE + 60_000),
      makeOneShot(BASE + 120_000),
      makeRecurring(BASE + 180_000, { paused: true }),
    ];
    const json = JSON.stringify(serializeTasks(tasks));
    const restored = hydrateTasks(JSON.parse(json), BASE);
    assert.deepEqual(restored, tasks);
  });

  it("恢复时剔除已过期循环任务", () => {
    const snapshot = {
      tasks: [makeRecurring(BASE + 60_000, { createdAt: BASE - RECURRING_TTL_MS - 1 })],
    };
    assert.deepEqual(hydrateTasks(snapshot, BASE), []);
  });

  it("恢复时把错过的循环任务推进到 now+interval（不补跑）", () => {
    const snapshot = { tasks: [makeRecurring(BASE - 600_000)] };
    const restored = hydrateTasks(snapshot, BASE);
    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.nextDueAt, BASE + 60_000);
  });

  it("恢复时丢弃已过期的一次性任务", () => {
    const snapshot = {
      tasks: [makeOneShot(BASE - 1), makeOneShot(BASE + 1, { id: "future" })],
    };
    const restored = hydrateTasks(snapshot, BASE);
    assert.deepEqual(restored.map((t) => t.id), ["future"]);
  });

  it("坏条目逐个跳过，不影响其余", () => {
    const snapshot = {
      tasks: [
        null,
        {},
        { id: "x", task: "", nextDueAt: BASE + 1, createdAt: BASE },
        { id: "y", task: "ok", nextDueAt: Number.NaN, createdAt: BASE },
        { id: "z", task: "recurring 但缺 interval", recurring: true, nextDueAt: BASE + 1, createdAt: BASE },
        makeRecurring(BASE + 5_000, { id: "good" }),
      ],
    };
    const restored = hydrateTasks(snapshot, BASE);
    assert.deepEqual(restored.map((t) => t.id), ["good"]);
  });

  it("非对象输入返回空数组", () => {
    assert.deepEqual(hydrateTasks(undefined, BASE), []);
    assert.deepEqual(hydrateTasks("nope", BASE), []);
    assert.deepEqual(hydrateTasks({ tasks: "not-array" }, BASE), []);
  });
});

describe("格式化", () => {
  it("formatCountdown", () => {
    assert.equal(formatCountdown(0), "0s");
    assert.equal(formatCountdown(-5), "0s");
    assert.equal(formatCountdown(45_000), "45s");
    assert.equal(formatCountdown(192_000), "3m12s");
    assert.equal(formatCountdown(3_600_000), "1h0m");
    assert.equal(formatCountdown(5_400_000), "1h30m");
  });

  it("formatClock（本地时区 HH:MM:SS）", () => {
    const ms = new Date(2026, 8, 5, 14, 5, 9).getTime();
    assert.equal(formatClock(ms), "14:05:09");
  });

  it("formatTaskLines 按触发先后排序，暂停任务显示 ⏸", () => {
    const tasks = [
      makeRecurring(BASE + 120_000, { id: "later", task: "稍后" }),
      makeOneShot(BASE + 60_000, { id: "soon", task: "先来" }),
      makeRecurring(BASE + 30_000, { id: "paused1", paused: true }),
    ];
    const lines = formatTaskLines(tasks, BASE);
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /paused1/);
    assert.match(lines[0]!, /⏸ 已暂停/);
    assert.match(lines[0]!, /—/);
    assert.match(lines[1]!, /soon/);
    assert.match(lines[2]!, /later/);
  });

  it("formatTaskLines 超长任务截断", () => {
    const tasks = [makeTask({ id: "long1", task: "x".repeat(100) })];
    const line = formatTaskLines(tasks, BASE)[0]!;
    assert.ok(line.length < 100);
    assert.match(line, /…$/);
  });
});

describe("daily/window 调度（v1.2）", () => {
  // 本地时区日期构造（2026-09-05 起），与 nextDailyOccurrence 的本地 Date 语义一致
  const D = (day: number, h: number, min: number): number => new Date(2026, 8, day, h, min, 0, 0).getTime();
  const DAY = 86_400_000;

  function makeDaily(nextDueAt: number, overrides: Partial<LoopTask> = {}): LoopTask {
    const t = makeTask({ intervalMs: undefined, nextDueAt, ...overrides });
    t.schedule = overrides.schedule ?? { kind: "daily", atMs: 9 * 3_600_000 };
    return t;
  }

  function makeWindow(nextDueAt: number, overrides: Partial<LoopTask> = {}): LoopTask {
    const t = makeTask({ intervalMs: undefined, nextDueAt, ...overrides });
    t.schedule = overrides.schedule ?? { kind: "window", intervalMs: 3_600_000, startMs: 0, endMs: 9 * 3_600_000 };
    return t;
  }

  it("createTask 创建 daily/window 任务：schedule 落到任务上，intervalMs 可缺省", () => {
    const tasks: LoopTask[] = [];
    const r1 = createTask(
      tasks,
      { task: "晨会", recurring: true, schedule: { kind: "daily", atMs: 9 * 3_600_000 }, fireAtMs: D(6, 9, 0), nowMs: D(5, 10, 0) },
      genId,
    );
    assert.ok(r1.ok);
    assert.deepEqual(r1.ok ? r1.task.schedule : null, { kind: "daily", atMs: 9 * 3_600_000 });
    assert.equal(r1.ok ? r1.task.intervalMs : null, undefined);

    const r2 = createTask(
      tasks,
      { task: "巡检", recurring: true, schedule: { kind: "window", intervalMs: 3_600_000, startMs: 0, endMs: 9 * 3_600_000 }, fireAtMs: D(6, 0, 0), nowMs: D(5, 10, 0) },
      genId,
    );
    assert.ok(r2.ok);
    assert.ok(r2.ok ? r2.task.schedule?.kind === "window" : false);
    assert.equal(tasks.length, 2);
  });

  it("createTask 校验非法 schedule", () => {
    const bad: RecurringSchedule[] = [
      { kind: "daily", atMs: -1 },
      { kind: "daily", atMs: DAY },
      { kind: "daily", atMs: 3_600_000 + 1 },
      { kind: "window", intervalMs: 0, startMs: 0, endMs: 3_600_000 },
      { kind: "window", intervalMs: 3_600_000, startMs: 9 * 3_600_000, endMs: 9 * 3_600_000 },
      { kind: "window", intervalMs: 3_600_000, startMs: 10 * 3_600_000, endMs: 9 * 3_600_000 },
      { kind: "window", intervalMs: 3_600_000, startMs: 0, endMs: DAY },
    ];
    for (const schedule of bad) {
      const tasks: LoopTask[] = [];
      const r = createTask(tasks, { task: "x", recurring: true, schedule, fireAtMs: D(6, 0, 0), nowMs: D(5, 10, 0) }, genId);
      assert.ok(!r.ok, JSON.stringify(schedule));
      assert.match(r.message, /无效/);
      assert.equal(tasks.length, 0);
    }
  });

  it("pollDue daily：到期触发一次，推进到明天同一时刻", () => {
    const t = makeDaily(D(5, 9, 0), { createdAt: D(5, 8, 0) });
    const r = pollDue([t], D(5, 9, 1));
    assert.deepEqual(r.due.map((x) => x.id), [t.id]);
    assert.equal(t.nextDueAt, D(6, 9, 0));
  });

  it("pollDue daily：跨多天错过只触发一次，推进到下一个未来触发点", () => {
    const t = makeDaily(D(3, 9, 0), { createdAt: D(3, 8, 0) });
    const r = pollDue([t], D(5, 10, 0));
    assert.equal(r.due.length, 1);
    assert.equal(t.nextDueAt, D(6, 9, 0));
  });

  it("pollDue daily：未到期不触发", () => {
    const t = makeDaily(D(5, 9, 0), { createdAt: D(5, 8, 0) });
    const r = pollDue([t], D(5, 8, 30));
    assert.equal(r.due.length, 0);
    assert.equal(t.nextDueAt, D(5, 9, 0));
  });

  it("pollDue window：窗口内推进到下一个网格点", () => {
    const t = makeWindow(D(5, 3, 0), { createdAt: D(5, 0, 0) });
    const r = pollDue([t], D(5, 3, 30));
    assert.equal(r.due.length, 1);
    assert.equal(t.nextDueAt, D(5, 4, 0));
  });

  it("pollDue window：窗口末尾（闭区间）触发后跳到明天窗口起点", () => {
    const t = makeWindow(D(5, 9, 0), { createdAt: D(5, 0, 0) });
    const r = pollDue([t], D(5, 9, 30));
    assert.equal(r.due.length, 1);
    assert.equal(t.nextDueAt, D(6, 0, 0));
  });

  it("pollDue window：非整点间隔网格对齐窗口起点（every 90m from 00:00）", () => {
    // 网格点：00:00、01:30、03:00……种子落在 01:30，01:30:01 触发后推进到 03:00
    const t = makeWindow(D(5, 1, 30), {
      createdAt: D(5, 0, 0),
      schedule: { kind: "window", intervalMs: 90 * 60_000, startMs: 0, endMs: 9 * 3_600_000 },
    });
    const r = pollDue([t], D(5, 1, 31));
    assert.equal(r.due.length, 1);
    assert.equal(t.nextDueAt, D(5, 3, 0));
  });

  it("resume daily：错过的排到下一个触发点", () => {
    const t = makeDaily(D(5, 9, 0), { createdAt: D(5, 8, 0), paused: true });
    const tasks = [t];
    const r = resumeTask(tasks, t.id, D(5, 10, 0));
    assert.ok(r.ok);
    assert.equal(t.nextDueAt, D(6, 9, 0));
  });

  it("hydrate daily：错过的推进到下一个触发点（不补跑）", () => {
    const snapshot = {
      tasks: [{
        id: "daily001", task: "晨会", recurring: true, intervalMs: undefined,
        schedule: { kind: "daily", atMs: 9 * 3_600_000 },
        nextDueAt: D(5, 9, 0), createdAt: D(5, 8, 0), paused: false,
      }],
    };
    const restored = hydrateTasks(snapshot, D(5, 10, 0));
    assert.equal(restored.length, 1);
    assert.deepEqual(restored[0]!.schedule, { kind: "daily", atMs: 9 * 3_600_000 });
    assert.equal(restored[0]!.nextDueAt, D(6, 9, 0));
  });

  it("hydrate 旧快照（无 schedule 字段）兼容：按固定间隔推进", () => {
    const restored = hydrateTasks({ tasks: [makeRecurring(BASE - 600_000)] }, BASE);
    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.schedule, undefined);
    assert.equal(restored[0]!.nextDueAt, BASE + 60_000);
  });

  it("sanitize 丢弃非法 schedule 条目，保留合法的", () => {
    const snapshot = {
      tasks: [
        { id: "badwin01", task: "窗口终点越界", recurring: true,
          schedule: { kind: "window", intervalMs: 3_600_000, startMs: 0, endMs: DAY },
          nextDueAt: BASE + 60_000, createdAt: BASE, paused: false },
        { id: "badday1", task: "时刻越界", recurring: true,
          schedule: { kind: "daily", atMs: DAY },
          nextDueAt: BASE + 60_000, createdAt: BASE, paused: false },
        { id: "goodwin1", task: "合法窗口", recurring: true,
          schedule: { kind: "window", intervalMs: 3_600_000, startMs: 0, endMs: 9 * 3_600_000 },
          nextDueAt: BASE + 60_000, createdAt: BASE, paused: false },
      ],
    };
    const restored = hydrateTasks(snapshot, BASE);
    assert.deepEqual(restored.map((t) => t.id), ["goodwin1"]);
  });

  it("serialize → hydrate 往返保留 schedule", () => {
    const tasks = [
      makeDaily(D(6, 9, 0), { createdAt: D(5, 8, 0) }),
      makeWindow(D(6, 0, 0), { createdAt: D(5, 8, 0) }),
    ];
    const json = JSON.stringify(serializeTasks(tasks));
    const restored = hydrateTasks(JSON.parse(json), D(5, 10, 0));
    assert.deepEqual(restored, tasks);
  });

  it("describeRecurrence / formatTimeOfDay", () => {
    assert.equal(describeRecurrence({ recurring: false }), "一次性");
    assert.equal(describeRecurrence({ recurring: true, intervalMs: 300_000 }), "每 5m");
    assert.equal(describeRecurrence({ recurring: true, schedule: { kind: "daily", atMs: 9 * 3_600_000 } }), "每天 09:00");
    assert.equal(
      describeRecurrence({ recurring: true, schedule: { kind: "window", intervalMs: 3_600_000, startMs: 0, endMs: 9 * 3_600_000 } }),
      "每天 00:00–09:00 每 1h",
    );
    assert.equal(formatTimeOfDay(0), "00:00");
    assert.equal(formatTimeOfDay(9 * 3_600_000), "09:00");
    assert.equal(formatTimeOfDay(23 * 3_600_000 + 59 * 60_000), "23:59");
  });

  it("formatTaskLines 展示 daily/window 调度描述", () => {
    const tasks = [
      makeDaily(D(6, 9, 0), { id: "daily001", createdAt: D(5, 8, 0), task: "晨会" }),
      makeWindow(D(6, 0, 0), { id: "window01", createdAt: D(5, 8, 0), task: "巡检" }),
    ];
    const lines = formatTaskLines(tasks, D(5, 10, 0));
    assert.match(lines[0]!, /每天 00:00–09:00 每 1h/);
    assert.match(lines[1]!, /每天 09:00/);
  });
});
