import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TASKS,
  MAX_TASK_LEN,
  RECURRING_TTL_MS,
  clearTasks,
  createTask,
  deleteTask,
  formatCountdown,
  formatClock,
  formatTaskLines,
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
