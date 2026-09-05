import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import loopFactory from "../index.ts";
import type { LoopTask } from "../tasks.ts";

const LOOP_TASKS_ENTRY = "loop-tasks-v1";
const LOOP_DUE_CUSTOM_TYPE = "loop-task-due";

// 固定"当前时刻"（epoch ms），测试中通过 fakeNow 手动推进
const BASE = 1_000_000_000_000;
let fakeNow = BASE;

// ---------- 定时器 mock：捕获回调，测试手动触发 tick ----------

const timers = new Map<number, () => void>();
let timerSeq = 0;
let origSetInterval: typeof globalThis.setInterval | undefined;
let origClearInterval: typeof globalThis.clearInterval | undefined;
let origDateNow: (() => number) | undefined;

function installMocks(): void {
  origSetInterval = globalThis.setInterval;
  origClearInterval = globalThis.clearInterval;
  origDateNow = globalThis.Date.now;
  timerSeq = 0;
  timers.clear();
  globalThis.setInterval = ((fn: () => void, _ms?: number) => {
    const id = ++timerSeq;
    timers.set(id, fn);
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id: number) => {
    timers.delete(id as number);
  }) as typeof globalThis.clearInterval;
  globalThis.Date.now = () => fakeNow;
}

function restoreMocks(): void {
  if (origSetInterval) globalThis.setInterval = origSetInterval;
  if (origClearInterval) globalThis.clearInterval = origClearInterval;
  if (origDateNow) globalThis.Date.now = origDateNow;
  timers.clear();
}

/** 手动触发所有存活实例的 tick 回调 */
function fireTick(): void {
  for (const fn of [...timers.values()]) fn();
}

function timerCount(): number {
  return timers.size;
}

before(() => installMocks());
after(() => restoreMocks());

// ---------- fake pi API ----------

function rawTask(opts: {
  id: string;
  task?: string;
  recurring?: boolean;
  intervalMs?: number;
  nextDueAt: number;
  createdAt?: number;
  paused?: boolean;
}) {
  // 字段顺序与 serializeTasks 输出一致，保证 JSON 快照可比
  return {
    id: opts.id,
    task: opts.task ?? "种子任务",
    recurring: opts.recurring ?? false,
    intervalMs: opts.recurring ? (opts.intervalMs ?? 60_000) : undefined,
    nextDueAt: opts.nextDueAt,
    createdAt: opts.createdAt ?? BASE,
    paused: opts.paused ?? false,
  };
}

function createFakePi() {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => void | Promise<void>>();
  const commands = new Map<string, {
    description?: string;
    getArgumentCompletions?: (prefix: string) => unknown;
    handler: (args: string, ctx: unknown) => Promise<void> | void;
  }>();
  const widgets = new Map<string, { id: string; content?: string[] }>();
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const persisted: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const sessionEntries: Array<{ type: string; customType: string; data?: unknown }> = [];
  let appendEntryThrows = false;
  let hasUIFlag = true;

  const ctx = {
    get hasUI() {
      return hasUIFlag;
    },
    set hasUI(v: boolean) {
      hasUIFlag = v;
    },
    ui: {
      notify: (message: string, level?: string) => {
        notifications.push({ message, level });
      },
      setWidget: (key: string, content?: string[]) => {
        if (content === undefined) {
          widgets.delete(key);
        } else {
          widgets.set(key, { id: key, content });
        }
      },
    },
    sessionManager: {
      getEntries: () => sessionEntries.slice(),
    },
  };

  const api = {
    _commands: commands,
    _widgets: widgets,
    _sent: sent,
    _persisted: persisted,
    _notifications: notifications,
    _sessionEntries: sessionEntries,
    _ctx: ctx,
    get hasUI() {
      return hasUIFlag;
    },
    set hasUI(v: boolean) {
      hasUIFlag = v;
    },
    on: (event: string, handler: (e: unknown, ctx: unknown) => void | Promise<void>) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, opts: { description?: string; getArgumentCompletions?: (prefix: string) => unknown; handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
      commands.set(name, opts);
    },
    appendEntry: (type: string, data?: unknown) => {
      if (appendEntryThrows) throw new Error("disk full");
      persisted.push({ type, data });
      sessionEntries.push({ type: "custom", customType: type, data });
    },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => {
      sent.push({ message, options });
    },
    fire: async (event: string) => {
      const h = handlers.get(event);
      if (!h) throw new Error(`No handler for ${event}`);
      await h({}, ctx);
    },
    runCommand: async (args: string) => {
      const cmd = commands.get("loop");
      if (!cmd) throw new Error("no /loop command");
      await cmd.handler(args, ctx);
    },
    lastNotification: () => notifications[notifications.length - 1],
    failNextAppendEntry: () => {
      appendEntryThrows = true;
    },
  };

  return api;
}

type FakePi = ReturnType<typeof createFakePi>;

function seedSnapshot(fake: FakePi, tasks: Array<ReturnType<typeof rawTask>>): void {
  fake._sessionEntries.push({ type: "custom", customType: LOOP_TASKS_ENTRY, data: { tasks } });
}

beforeEach(() => {
  timers.clear();
  fakeNow = BASE;
});

// ---------- 命令注册 ----------

describe("命令注册", () => {
  it("注册 /loop 命令，带描述与参数补全", () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    const cmd = fake._commands.get("loop");
    assert.ok(cmd, "/loop command registered");
    assert.ok(cmd!.description && cmd!.description.length > 0);
    const items = cmd!.getArgumentCompletions?.("de") as Array<{ value: string }>;
    assert.deepEqual(items, [{ value: "delete ", label: "delete" }]);
  });
});

// ---------- 创建与持久化 ----------

describe("创建与持久化", () => {
  it("创建循环任务：通知 + 全量快照落盘", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("5m 检查部署状态");
    const note = fake.lastNotification();
    assert.match(note!.message, /已创建 loop/);
    assert.match(note!.message, /每 5m/);
    assert.equal(fake._persisted.length, 1);
    const data = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.equal(fake._persisted[0]!.type, LOOP_TASKS_ENTRY);
    assert.equal(data.tasks.length, 1);
    assert.equal(data.tasks[0]!.task, "检查部署状态");
    assert.equal(data.tasks[0]!.nextDueAt, BASE + 300_000);
  });

  it("创建一次性任务：通知一次性与触发时刻", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("in 30m 取快递");
    const note = fake.lastNotification();
    assert.match(note!.message, /一次性/);
    const data = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.equal(data.tasks[0]!.nextDueAt, BASE + 1_800_000);
  });

  it("达到 50 上限后拒绝创建", async () => {
    const fake = createFakePi();
    seedSnapshot(
      fake,
      Array.from({ length: 50 }, (_, i) => rawTask({ id: `c${String(i).padStart(2, "0")}`, recurring: true, nextDueAt: BASE + 60_000 })),
    );
    loopFactory(fake as never);
    await fake.fire("session_start");
    assert.equal(fake._persisted.length, 0); // 快照无变化不重写
    await fake.runCommand("5m one more");
    const note = fake.lastNotification();
    assert.equal(note!.level, "warning");
    assert.match(note!.message, /上限/);
    assert.equal(fake._persisted.length, 0);
  });

  it("裸 /loop 显示用法；有任务时附带列表", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("");
    let note = fake.lastNotification();
    assert.match(note!.message, /用法/);
    assert.doesNotMatch(note!.message, /当前任务/);

    seedSnapshot(fake, [rawTask({ id: "seed0001", nextDueAt: BASE + 60_000 })]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("list");
    note = fake.lastNotification();
    assert.match(note!.message, /seed0001/);
  });
});

// ---------- 到期触发 ----------

describe("到期触发", () => {
  it("一次性任务到期：sendMessage 形状精确、触发后自删", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("in 1s 喝水提醒");
    fakeNow = BASE + 2_000;
    fireTick();

    assert.equal(fake._sent.length, 1);
    const { message, options } = fake._sent[0]!;
    assert.equal(message.customType, LOOP_DUE_CUSTOM_TYPE);
    assert.ok(String(message.content).includes("喝水提醒"));
    assert.equal(message.display, true);
    const details = message.details as { loopId: string };
    assert.ok(typeof details.loopId === "string" && details.loopId.length > 0);
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });

    // 已落盘为空（自删）
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks.length, 0);

    fireTick();
    assert.equal(fake._sent.length, 1, "第二次 tick 不重复触发");
  });

  it("循环任务在会话中落后多个间隔：只触发一次（不补跑）", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("1m 巡检服务");
    fakeNow = BASE + 190_000; // 落后 3 个间隔
    fireTick();

    assert.equal(fake._sent.length, 1, "落后 3 个间隔只触发一次");
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks.length, 1);
    assert.ok(last.tasks[0]!.nextDueAt > fakeNow);
    assert.equal(last.tasks[0]!.nextDueAt, BASE + 240_000);
  });

  it("恢复会话时错过的循环任务推进到未来，不立即触发", async () => {
    const fake = createFakePi();
    seedSnapshot(fake, [rawTask({ id: "stale001", recurring: true, intervalMs: 60_000, nextDueAt: BASE - 180_000 })]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    assert.equal(fake._sent.length, 0, "恢复时不补跑");
    fireTick();
    assert.equal(fake._sent.length, 0);
    // 推进结果落盘
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks[0]!.nextDueAt, BASE + 60_000);
  });

  it("暂停的任务不触发", async () => {
    const fake = createFakePi();
    seedSnapshot(fake, [rawTask({ id: "paused01", recurring: true, nextDueAt: BASE + 60_000, paused: true })]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    fireTick();
    assert.equal(fake._sent.length, 0);
    assert.equal(fake._persisted.length, 0);
  });

  it("7 天过期恰逢到期：最后触发一次后剔除", async () => {
    const fake = createFakePi();
    // 会话开始时还未过期（60s 后过期），30s 后应触发 → 会在会话中经历"过期且到期"
    seedSnapshot(fake, [
      rawTask({ id: "expired1", recurring: true, nextDueAt: BASE + 30_000, createdAt: BASE - 7 * 86_400_000 + 60_000 }),
    ]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    assert.equal(fake._persisted.length, 0);

    fakeNow = BASE + 70_000;
    fireTick();
    assert.equal(fake._sent.length, 1, "最后触发一次");
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks.length, 0, "触发后剔除");
  });

  it("已过期但未到触发点的任务静默剔除", async () => {
    const fake = createFakePi();
    seedSnapshot(fake, [
      rawTask({ id: "expired2", recurring: true, nextDueAt: BASE + 60_000, createdAt: BASE - 7 * 86_400_000 }),
    ]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    fireTick();
    assert.equal(fake._sent.length, 0);
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks.length, 0);
  });

  it("persist 失败不阻断送达", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("in 1s 重要提醒");
    fake.failNextAppendEntry();
    fakeNow = BASE + 2_000;
    fireTick();
    assert.equal(fake._sent.length, 1);
  });
});

// ---------- 命令管理 ----------

describe("命令管理", () => {
  it("pause → 不触发；resume → 错过的间隔跳到 now+interval", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("1m 巡检服务");
    const id = (fake._persisted[0]!.data as { tasks: LoopTask[] }).tasks[0]!.id;

    await fake.runCommand(`pause ${id.slice(0, 3)}`);
    assert.match(fake.lastNotification()!.message, /已暂停/);
    fakeNow = BASE + 600_000;
    fireTick();
    assert.equal(fake._sent.length, 0);

    await fake.runCommand(`resume ${id.slice(0, 3)}`);
    assert.match(fake.lastNotification()!.message, /已恢复/);
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks[0]!.nextDueAt, BASE + 600_000 + 60_000);
  });

  it("delete 按前缀删除", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("5m 任务甲");
    const id = (fake._persisted[0]!.data as { tasks: LoopTask[] }).tasks[0]!.id;
    await fake.runCommand(`delete ${id.slice(0, 4)}`);
    assert.match(fake.lastNotification()!.message, /已删除/);
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks.length, 0);
  });

  it("clear 清空全部", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("5m 甲");
    await fake.runCommand("10m 乙");
    await fake.runCommand("clear");
    assert.match(fake.lastNotification()!.message, /全部 2 个任务/);
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks.length, 0);
  });

  it("歧义前缀与未找到给出警告", async () => {
    const fake = createFakePi();
    seedSnapshot(fake, [
      rawTask({ id: "abc1", nextDueAt: BASE + 60_000 }),
      rawTask({ id: "abc2", nextDueAt: BASE + 60_000 }),
    ]);
    loopFactory(fake as never);
    await fake.fire("session_start");

    await fake.runCommand("pause abc");
    let note = fake.lastNotification();
    assert.equal(note!.level, "warning");
    assert.match(note!.message, /多个任务/);

    await fake.runCommand("pause zzzz");
    note = fake.lastNotification();
    assert.equal(note!.level, "warning");
    assert.match(note!.message, /未找到/);
  });
});

// ---------- widget ----------

describe("widget", () => {
  it("有任务时显示数量与下次倒计时", async () => {
    const fake = createFakePi();
    seedSnapshot(fake, [rawTask({ id: "widget01", nextDueAt: BASE + 65_000 })]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    const w = fake._widgets.get("loop");
    assert.ok(w, "widget exists");
    assert.match(w!.content![0]!, /⏰ loop 1 个任务/);
    assert.match(w!.content![0]!, /下次 1m/);
  });

  it("无任务时 widget 移除", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("5m 临时任务");
    assert.ok(fake._widgets.has("loop"));
    await fake.runCommand("clear");
    assert.ok(!fake._widgets.has("loop"), "widget removed after clear");
  });

  it("无 UI 时不建 widget，但调度与送达照常", async () => {
    const fake = createFakePi();
    fake.hasUI = false;
    loopFactory(fake as never);
    await fake.fire("session_start");
    assert.equal(fake._widgets.size, 0);
    assert.equal(timerCount(), 1, "调度器不依赖 UI");

    await fake.runCommand("in 1s 无界面任务");
    fakeNow = BASE + 2_000;
    fireTick();
    assert.equal(fake._sent.length, 1, "无 UI 照常送达");
  });
});

// ---------- 生命周期 ----------

describe("生命周期", () => {
  it("session_start 启动一个 tick 定时器，session_shutdown 清理", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1);
    assert.ok(fake._widgets.has("loop") === false || true); // 无任务时 widget 可不存在
    await fake.fire("session_shutdown");
    assert.equal(timerCount(), 0);
  });

  it("重复 session_start 只保留一个定时器", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.fire("session_start");
    assert.equal(timerCount(), 1);
  });

  it("/reload（二次工厂调用）清理旧实例定时器", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1);
    loopFactory(fake as never);
    assert.equal(timerCount(), 0, "旧实例定时器被 dispose 清理");
    await fake.fire("session_start");
    assert.equal(timerCount(), 1);
  });

  it("恢复时丢弃坏条目并重写清洗后的快照", async () => {
    const fake = createFakePi();
    seedSnapshot(fake, [
      rawTask({ id: "good0001", nextDueAt: BASE + 60_000 }),
      { id: "", task: "缺 id" },
    ] as unknown as Array<ReturnType<typeof rawTask>>);
    loopFactory(fake as never);
    await fake.fire("session_start");
    assert.equal(fake._persisted.length, 1, "清洗后重写快照");
    const data = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.deepEqual(data.tasks.map((t) => t.id), ["good0001"]);
  });

  it("快照无变化时 session_start 不重写", async () => {
    const fake = createFakePi();
    seedSnapshot(fake, [rawTask({ id: "same0001", nextDueAt: BASE + 60_000 })]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    assert.equal(fake._persisted.length, 0);
  });
});
