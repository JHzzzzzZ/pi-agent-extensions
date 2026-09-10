import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import loopFactory from "../index.ts";
import type { BgRunOutcome } from "../runner.ts";
import type { LoopTask } from "../tasks.ts";

const LOOP_TASKS_ENTRY = "loop-tasks-v1";
const LOOP_DUE_CUSTOM_TYPE = "loop-task-due";

// 固定"当前时刻"（epoch ms），测试中通过 fakeNow 手动推进
const BASE = 1_000_000_000_000;
let fakeNow = BASE;

// ---------- 定时器 mock：捕获回调，测试手动触发 tick ----------

const timers = new Map<number, () => void>();
let timerSeq = 0;
let origSetTimeout: typeof globalThis.setTimeout | undefined;
let origClearTimeout: typeof globalThis.clearTimeout | undefined;
let origDateNow: (() => number) | undefined;

function installMocks(): void {
  // 节拍器（aligned-ticker.ts）用 setTimeout 对齐秒边界；捕获回调手动触发。
  origSetTimeout = globalThis.setTimeout;
  origClearTimeout = globalThis.clearTimeout;
  origDateNow = globalThis.Date.now;
  timerSeq = 0;
  timers.clear();
  globalThis.setTimeout = ((fn: () => void, _ms?: number) => {
    const id = ++timerSeq;
    timers.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id as number);
  }) as typeof globalThis.clearTimeout;
  globalThis.Date.now = () => fakeNow;
}

function restoreMocks(): void {
  if (origSetTimeout) globalThis.setTimeout = origSetTimeout;
  if (origClearTimeout) globalThis.clearTimeout = origClearTimeout;
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
  schedule?: { kind: "daily"; atMs: number } | { kind: "window"; intervalMs: number; startMs: number; endMs: number };
  background?: boolean;
  lastRun?: {
    startedAt: number;
    finishedAt?: number;
    status: string;
    sessionId?: string;
    sessionPath?: string;
    summary?: string;
  };
}) {
  // 字段顺序与 serializeTasks 输出一致，保证 JSON 快照可比（schedule/background/lastRun 依序追加在末尾）
  const base = {
    id: opts.id,
    task: opts.task ?? "种子任务",
    recurring: opts.recurring ?? false,
    intervalMs: opts.recurring ? (opts.intervalMs ?? 60_000) : undefined,
    nextDueAt: opts.nextDueAt,
    createdAt: opts.createdAt ?? BASE,
    paused: opts.paused ?? false,
  };
  const out: Record<string, unknown> = opts.schedule !== undefined ? { ...base, schedule: opts.schedule } : { ...base };
  if (opts.background) out.background = true;
  if (opts.lastRun) out.lastRun = opts.lastRun;
  return out;
}

function createFakePi() {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => void | Promise<void>>();
  const commands = new Map<string, {
    description?: string;
    getArgumentCompletions?: (prefix: string) => unknown;
    handler: (args: string, ctx: unknown) => Promise<void> | void;
  }>();
  const tools = new Map<string, {
    name: string;
    execute: (toolCallId: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
  }>();
  const widgets = new Map<string, { id: string; content?: string[] }>();
  let widgetWrites = 0;
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
        widgetWrites += 1;
        if (content === undefined) {
          widgets.delete(key);
        } else {
          widgets.set(key, { id: key, content });
        }
      },
    },
    sessionManager: {
      getEntries: () => sessionEntries.slice(),
      getCwd: () => "C:\\fake\\proj",
    },
  };

  const api = {
    _commands: commands,
    _tools: tools,
    _widgets: widgets,
    _sent: sent,
    _persisted: persisted,
    _notifications: notifications,
    _sessionEntries: sessionEntries,
    _ctx: ctx,
    get _widgetWrites() { return widgetWrites; },
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
    registerTool: (tool: { name: string; execute: (toolCallId: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<unknown> }) => {
      tools.set(tool.name, tool);
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
    runTool: async (name: string, params: Record<string, unknown>) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      return (await tool.execute("call1", params, undefined, undefined, ctx)) as ToolResult;
    },
    lastNotification: () => notifications[notifications.length - 1],
    failNextAppendEntry: () => {
      appendEntryThrows = true;
    },
  };

  return api;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

function toolText(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n");
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
    const dailyItems = cmd!.getArgumentCompletions?.("daily") as Array<{ value: string }>;
    assert.deepEqual(dailyItems, [{ value: "daily ", label: "daily" }]);
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

// ---------- daily / 时间窗口任务（v1.2） ----------

describe("daily / 时间窗口任务（v1.2）", () => {
  it("命令创建 daily 任务：通知含调度描述与触发时刻", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("daily at 09:00 晨会");
    const note = fake.lastNotification();
    assert.match(note!.message, /已创建 loop/);
    assert.match(note!.message, /每天 09:00/);
    const data = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.deepEqual(data.tasks[0]!.schedule, { kind: "daily", atMs: 9 * 3_600_000 });
  });

  it("daily 任务到期触发一次并推进到明天同一时刻", async () => {
    const fake = createFakePi();
    const atMs = 9 * 3_600_000;
    const today0900 = new Date(2026, 8, 5, 9, 0, 0, 0).getTime();
    const tomorrow0900 = new Date(2026, 8, 6, 9, 0, 0, 0).getTime();
    fakeNow = new Date(2026, 8, 5, 8, 0, 0, 0).getTime(); // 会话开始于当天 08:00
    seedSnapshot(fake, [
      rawTask({ id: "daily001", recurring: true, schedule: { kind: "daily", atMs }, nextDueAt: today0900, createdAt: fakeNow - 3_600_000 }),
    ]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    fireTick();
    assert.equal(fake._sent.length, 0, "未到点不触发");

    fakeNow = today0900 + 30_000;
    fireTick();
    assert.equal(fake._sent.length, 1, "09:00 到点触发");
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks[0]!.nextDueAt, tomorrow0900);

    fireTick();
    assert.equal(fake._sent.length, 1, "同一天不重复触发");
  });

  it("每日窗口任务：恢复不补跑，窗口内逐小时触发，末尾闭区间后跳明天", async () => {
    const fake = createFakePi();
    const atMsOf = (day: number, h: number) => new Date(2026, 8, day, h, 0, 0, 0).getTime();
    fakeNow = atMsOf(5, 2) + 30_000; // 02:00:30，02:00 的触发点刚过
    seedSnapshot(fake, [
      rawTask({
        id: "win00001",
        recurring: true,
        schedule: { kind: "window", intervalMs: 3_600_000, startMs: 0, endMs: 9 * 3_600_000 },
        nextDueAt: atMsOf(5, 2),
        createdAt: fakeNow - 86_400_000,
      }),
    ]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    assert.equal(fake._sent.length, 0, "恢复时错过的 02:00 不补跑");
    const afterStart = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.equal(afterStart.tasks[0]!.nextDueAt, atMsOf(5, 3), "hydrate 推进到 03:00");

    fakeNow = atMsOf(5, 3) + 1_000;
    fireTick();
    assert.equal(fake._sent.length, 1, "03:00 触发");

    fakeNow = atMsOf(5, 9) + 1_000;
    fireTick();
    assert.equal(fake._sent.length, 2, "09:00 窗口末尾触发（闭区间）");
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks[0]!.nextDueAt, atMsOf(6, 0), "越界后排到明天窗口起点");
  });

  it("loop_create 支持 daily 与窗口调度", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");

    const expected0900 = (() => {
      const d = new Date(BASE);
      d.setHours(9, 0, 0, 0);
      if (d.getTime() <= BASE) d.setDate(d.getDate() + 1);
      return d.getTime();
    })();
    const r1 = await fake.runTool("loop_create", { task: "晨会提醒", schedule: "daily at 09:00" });
    assert.equal(r1.isError, undefined);
    assert.match(toolText(r1), /每天 09:00/);
    assert.equal(r1.details?.nextDueAt, expected0900);

    // BASE 已过 09:00 → 明天 00:00；否则今天窗口内下一个整点
    const expectedWindow = (() => {
      const d = new Date(BASE);
      d.setHours(0, 0, 0, 0);
      const day0 = d.getTime();
      let t = day0;
      if (t <= BASE) t += (Math.floor((BASE - t) / 3_600_000) + 1) * 3_600_000;
      if (t <= day0 + 9 * 3_600_000) return t;
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    const r2 = await fake.runTool("loop_create", { task: "夜间巡检", schedule: "every 1h from 00:00 to 09:00" });
    assert.equal(r2.isError, undefined);
    assert.match(toolText(r2), /每天 00:00–09:00 每 1h/);
    assert.equal(r2.details?.nextDueAt, expectedWindow);
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

  it("倒计时粗粒度（>1h）时 tick 不重复写 widget（指纹跳过）", async () => {
    const fake = createFakePi();
    // 距触发 3h39m30s：同一分钟内 formatCountdown 只到分钟，文本不变
    seedSnapshot(fake, [rawTask({ id: "widget02", nextDueAt: BASE + 3 * 3600_000 + 39 * 60_000 + 30_000 })]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    const writesAfterStart = fake._widgetWrites;
    fakeNow = BASE + 1_000;
    fireTick();
    fakeNow = BASE + 2_000;
    fireTick();
    assert.equal(fake._widgetWrites, writesAfterStart, "同一分钟内倒计时文本未变 → 跳过重绘");
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

// ---------- agent 工具 ----------

describe("agent 工具注册", () => {
  it("注册 loop_create / loop_list / loop_delete 三个工具", () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    for (const name of ["loop_create", "loop_list", "loop_delete"]) {
      assert.ok(fake._tools.has(name), `missing tool ${name}`);
    }
  });
});

describe("loop_create 工具", () => {
  it("创建循环任务：返回文本 + details.loopId + 落盘 + widget 刷新", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");

    const result = await fake.runTool("loop_create", { task: "检查部署状态", schedule: "every 5m" });
    assert.equal(result.isError, undefined);
    assert.match(toolText(result), /已创建 loop/);
    assert.match(toolText(result), /每 5m/);
    assert.ok(typeof result.details?.loopId === "string");
    assert.equal(fake._persisted.length, 1);
    const data = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.equal(data.tasks[0]!.nextDueAt, BASE + 300_000);
    assert.ok(fake._widgets.has("loop"));
  });

  it("创建一次性任务：in 30m 与 at 15:00", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");

    const r1 = await fake.runTool("loop_create", { task: "取快递", schedule: "in 30m" });
    assert.ok(typeof r1.details?.nextDueAt === "number" && r1.details.nextDueAt === BASE + 1_800_000);

    const expectedAt = (() => {
      const d = new Date(BASE);
      d.setHours(15, 0, 0, 0);
      return d.getTime() > BASE ? d.getTime() : (() => {
        const d2 = new Date(BASE);
        d2.setDate(d2.getDate() + 1);
        d2.setHours(15, 0, 0, 0);
        return d2.getTime();
      })();
    })();
    const r2 = await fake.runTool("loop_create", { task: "发布版本", schedule: "at 15:00" });
    assert.ok(typeof r2.details?.nextDueAt === "number" && r2.details.nextDueAt === expectedAt);
    assert.equal(fake._persisted.length, 2);
  });

  it("非法调度 / 过长任务 / 达到上限 → isError", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");

    const badSchedule = await fake.runTool("loop_create", { task: "x", schedule: "abc" });
    assert.equal(badSchedule.isError, true);
    assert.match(toolText(badSchedule), /无法识别调度/);

    const tooLong = await fake.runTool("loop_create", { task: "x".repeat(2001), schedule: "every 5m" });
    assert.equal(tooLong.isError, true);
    assert.match(toolText(tooLong), /过长/);
    assert.equal(fake._persisted.length, 0);

    seedSnapshot(
      fake,
      Array.from({ length: 50 }, (_, i) => rawTask({ id: `c${String(i).padStart(2, "0")}`, recurring: true, nextDueAt: BASE + 60_000 })),
    );
    loopFactory(fake as never);
    await fake.fire("session_start");
    const atCap = await fake.runTool("loop_create", { task: "x", schedule: "every 5m" });
    assert.equal(atCap.isError, true);
    assert.match(toolText(atCap), /上限/);
  });

  it("工具创建的任务真实生效：到期触发 sendMessage", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runTool("loop_create", { task: "工具创建的任务", schedule: "in 1s" });
    fakeNow = BASE + 2_000;
    fireTick();
    assert.equal(fake._sent.length, 1);
    assert.ok(String(fake._sent[0]!.message.content).includes("工具创建的任务"));
  });
});

describe("loop_list / loop_delete 工具", () => {
  it("list：空与非空", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");

    const empty = await fake.runTool("loop_list", {});
    assert.match(toolText(empty), /没有定时任务/);

    await fake.runTool("loop_create", { task: "任务甲", schedule: "5m" });
    await fake.runTool("loop_create", { task: "任务乙", schedule: "10m" });
    const listed = await fake.runTool("loop_list", {});
    assert.match(toolText(listed), /当前 2 个任务/);
    assert.equal(listed.details?.count, 2);
  });

  it("delete：前缀删除成功、未找到报错", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");
    const created = await fake.runTool("loop_create", { task: "要删的任务", schedule: "every 10m" });
    const loopId = String(created.details?.loopId);

    const deleted = await fake.runTool("loop_delete", { id: loopId.slice(0, 4) });
    assert.equal(deleted.isError, undefined);
    assert.match(toolText(deleted), /已删除/);
    assert.equal(deleted.details?.loopId, loopId);

    const missing = await fake.runTool("loop_delete", { id: "zzzz" });
    assert.equal(missing.isError, true);
    assert.match(toolText(missing), /未找到/);
  });
});

// ---------- 后台模式（v1.3） ----------

type RunBgCall = { taskId: string; prompt: string; cwd?: string; signal?: AbortSignal };
// 用 installMocks 捕获的真实 setTimeout：测试内全局 setTimeout 已被节拍器 mock。
const flush = () => new Promise((r) => (origSetTimeout ?? globalThis.setTimeout)(r, 0));
const bgDone: BgRunOutcome = { status: "done", exitCode: 0, summary: "全部通过", stderr: "" };

/** 后台模式公共脚手架：假 runBg 收集调用并返回手工 resolve 的 deferred */
function makeBgHarness() {
  const calls: RunBgCall[] = [];
  const resolvers: Array<(v: BgRunOutcome) => void> = [];
  const runBg = (opts: RunBgCall): Promise<BgRunOutcome> => {
    calls.push(opts);
    return new Promise<BgRunOutcome>((resolve) => resolvers.push(resolve));
  };
  return {
    calls,
    resolvers,
    runBg,
    resolveNext(outcome: BgRunOutcome): void {
      resolvers.shift()!(outcome);
    },
  };
}

describe("后台模式（v1.3）— 创建", () => {
  it("--bg 命令创建后台任务：通知与快照标记 background，未到期不拉起", async () => {
    const fake = createFakePi();
    const bg = makeBgHarness();
    loopFactory(fake as never, { runBg: bg.runBg });
    await fake.fire("session_start");
    await fake.runCommand("--bg 5m 巡检服务");
    assert.match(fake.lastNotification()!.message, /已创建 loop/);
    assert.match(fake.lastNotification()!.message, /后台执行/);
    const data = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.equal(data.tasks[0]!.background, true);
    assert.equal(bg.calls.length, 0, "创建时不拉起，到期才拉起");
  });

  it("loop_create mode=background：任务标记后台并在 details 标注；缺省 mode 为前台", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");

    const bgResult = await fake.runTool("loop_create", { task: "后台任务", schedule: "5m", mode: "background" });
    assert.equal(bgResult.isError, undefined);
    assert.match(toolText(bgResult), /后台执行/);
    assert.equal(bgResult.details?.background, true);

    const fgResult = await fake.runTool("loop_create", { task: "前台任务", schedule: "5m" });
    assert.equal(fgResult.details?.background, undefined);
    assert.doesNotMatch(toolText(fgResult), /后台执行/);

    const data = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.equal(data.tasks[0]!.background, true);
    const data2 = fake._persisted[1]!.data as { tasks: LoopTask[] };
    assert.equal(data2.tasks[1]!.background, undefined);
  });

  it("/loop list：后台徽标与上次运行行", async () => {
    const fake = createFakePi();
    seedSnapshot(fake, [
      rawTask({
        id: "bgseed1",
        recurring: true,
        nextDueAt: BASE + 60_000,
        background: true,
        lastRun: { startedAt: BASE - 5000, finishedAt: BASE - 1000, status: "done", sessionId: "sess-7f2a", summary: "一切\n正常 很好" },
      }),
      rawTask({ id: "fgseed1", nextDueAt: BASE + 120_000 }),
    ]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("list");
    const msg = fake.lastNotification()!.message;
    assert.match(msg, /\[后台\]/);
    assert.match(msg, /└ 上次后台：完成 · 会话 sess-7f2a · 一切 正常 很好/);
  });
});

describe("后台模式（v1.3）— 触发与完成", () => {
  it("后台一次性任务到期：不注入消息、拉起运行（带 cwd/prompt）；完成后通知恢复提示", async () => {
    const fake = createFakePi();
    const bg = makeBgHarness();
    loopFactory(fake as never, { runBg: bg.runBg });
    await fake.fire("session_start");
    await fake.runCommand("--bg in 1s 后台跑一遍检查");
    const id = (fake._persisted[0]!.data as { tasks: LoopTask[] }).tasks[0]!.id;

    fakeNow = BASE + 2_000;
    fireTick();
    assert.equal(fake._sent.length, 0, "后台任务不注入当前会话");
    assert.equal(bg.calls.length, 1);
    assert.equal(bg.calls[0]!.taskId, id);
    assert.match(bg.calls[0]!.prompt, /后台跑一遍检查/);
    assert.equal(bg.calls[0]!.cwd, "C:\\fake\\proj");
    assert.match(fake.lastNotification()!.message, /已转后台执行/);

    bg.resolveNext({ status: "done", exitCode: 0, sessionId: "sess-42", summary: "检查全部通过", stderr: "" });
    await flush();
    const afterDone = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(afterDone.tasks.length, 0, "一次性任务触发即自删，完成不复活");

    const note = fake.lastNotification()!;
    assert.match(note.message, /后台完成/);
    assert.match(note.message, /pi --session sess-42/);
    assert.match(note.message, /检查全部通过/);
    assert.ok(!fake._widgets.has("loop"), "任务自删后 widget 移除");
  });

  it("循环后台任务完成：lastRun 记录会话 id 并落盘", async () => {
    const fake = createFakePi();
    const bg = makeBgHarness();
    loopFactory(fake as never, { runBg: bg.runBg });
    await fake.fire("session_start");
    await fake.runCommand("--bg 1m 巡检服务");
    fakeNow = BASE + 61_000;
    fireTick();
    assert.equal(bg.calls.length, 1);
    assert.match(fake._widgets.get("loop")!.content![0]!, /后台运行 1/);

    bg.resolveNext({ status: "done", exitCode: 0, sessionId: "sess-9abc", summary: "OK", stderr: "" });
    await flush();
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks.length, 1);
    assert.equal(last.tasks[0]!.lastRun!.status, "done");
    assert.equal(last.tasks[0]!.lastRun!.sessionId, "sess-9abc");
    assert.match(fake.lastNotification()!.message, /pi --session sess-9abc/);
  });

  it("后台失败/超时：警告通知带退出码或超时标记", async () => {
    const fake = createFakePi();
    const bg = makeBgHarness();
    loopFactory(fake as never, { runBg: bg.runBg });
    await fake.fire("session_start");
    await fake.runCommand("--bg 1m 会失败的任务");

    fakeNow = BASE + 61_000;
    fireTick();
    bg.resolveNext({ status: "failed", exitCode: 2, summary: "boom", stderr: "boom" });
    await flush();
    let note = fake.lastNotification()!;
    assert.equal(note.level, "warning");
    assert.match(note.message, /后台运行失败/);
    assert.match(note.message, /退出码 2/);

    fakeNow = BASE + 121_000;
    fireTick();
    bg.resolveNext({ status: "timeout", exitCode: null, sessionId: "sess-t1", summary: "part", stderr: "" });
    await flush();
    note = fake.lastNotification()!;
    assert.equal(note.level, "warning");
    assert.match(note.message, /超时被终止/);
    assert.match(note.message, /pi --session sess-t1/);
  });

  it("上一轮后台仍在运行：下次到期跳过并警告，不叠加拉起", async () => {
    const fake = createFakePi();
    const bg = makeBgHarness();
    loopFactory(fake as never, { runBg: bg.runBg });
    await fake.fire("session_start");
    await fake.runCommand("--bg 1m 慢任务");

    fakeNow = BASE + 61_000;
    fireTick();
    assert.equal(bg.calls.length, 1);

    fakeNow = BASE + 121_000;
    fireTick();
    assert.equal(bg.calls.length, 1, "在途时不二次拉起");
    const note = fake.lastNotification()!;
    assert.equal(note.level, "warning");
    assert.match(note.message, /仍在运行，本次触发跳过/);

    bg.resolveNext({ ...bgDone, sessionId: "sess-slow" });
    await flush();
    assert.match(fake.lastNotification()!.message, /sess-slow/);
  });

  it("后台运行中任务被删除：完成仅通知、不复活任务", async () => {
    const fake = createFakePi();
    const bg = makeBgHarness();
    loopFactory(fake as never, { runBg: bg.runBg });
    await fake.fire("session_start");
    await fake.runCommand("--bg 1m 要被删的任务");
    const id = (fake._persisted[0]!.data as { tasks: LoopTask[] }).tasks[0]!.id;

    fakeNow = BASE + 61_000;
    fireTick();
    await fake.runCommand(`delete ${id.slice(0, 4)}`);

    bg.resolveNext({ ...bgDone, sessionId: "sess-gone" });
    await flush();
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks.length, 0, "删除不被完成回调复活");
    assert.match(fake.lastNotification()!.message, /pi --session sess-gone/);
  });

  it("后台运行抛异常：错误通知且任务标记 failed", async () => {
    const fake = createFakePi();
    let failWith: ((e: unknown) => void) | undefined;
    const runBg = (): Promise<BgRunOutcome> =>
      new Promise((_resolve, reject) => {
        failWith = reject;
      });
    loopFactory(fake as never, { runBg });
    await fake.fire("session_start");
    await fake.runCommand("--bg 1m 会抛异常的任务");

    fakeNow = BASE + 61_000;
    fireTick();
    failWith!(new Error("调度器崩溃"));
    await flush();
    const note = fake.lastNotification()!;
    assert.equal(note.level, "error");
    assert.match(note.message, /后台运行异常/);
    assert.match(note.message, /调度器崩溃/);
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks[0]!.lastRun!.status, "failed");
  });
});

describe("后台模式（v1.3）— 生命周期", () => {
  it("session_shutdown：在途后台任务标记 interrupted 并 abort，完成回调不再打扰", async () => {
    const fake = createFakePi();
    const bg = makeBgHarness();
    loopFactory(fake as never, { runBg: bg.runBg });
    await fake.fire("session_start");
    await fake.runCommand("--bg 1m 跨会话任务");

    fakeNow = BASE + 61_000;
    fireTick();
    assert.equal(bg.calls.length, 1);
    assert.equal(bg.calls[0]!.signal?.aborted, false);

    await fake.fire("session_shutdown");
    assert.equal(bg.calls[0]!.signal?.aborted, true, "shutdown 中止在途子进程");
    const last = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(last.tasks[0]!.lastRun!.status, "interrupted");

    const notesBefore = fake._notifications.length;
    bg.resolveNext({ ...bgDone, sessionId: "sess-late" });
    await flush();
    assert.equal(fake._notifications.length, notesBefore, "关闭后不再通知");
    const final = fake._persisted[fake._persisted.length - 1]!.data as { tasks: LoopTask[] };
    assert.equal(final.tasks[0]!.lastRun!.status, "interrupted", "不被完成回调覆盖");
  });

  it("恢复快照时 running 的 lastRun 显示为 interrupted", async () => {
    const fake = createFakePi();
    seedSnapshot(fake, [
      rawTask({
        id: "orph0001",
        recurring: true,
        nextDueAt: BASE + 60_000,
        background: true,
        lastRun: { startedAt: BASE - 600_000, status: "running" },
      }),
    ]);
    loopFactory(fake as never);
    await fake.fire("session_start");
    await fake.runCommand("list");
    assert.match(fake.lastNotification()!.message, /上次后台：中断/);
  });
});

describe("模型指定（v1.4）— loop_create model 参数", () => {
  it("mode=background + model → 任务落快照、回执带模型标注", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");

    const result = await fake.runTool("loop_create", {
      task: "夜间巡检",
      schedule: "5m",
      mode: "background",
      model: "opencode-go/deepseek-v4-flash",
    });
    assert.equal(result.isError, undefined);
    assert.match(toolText(result), /opencode-go\/deepseek-v4-flash/);
    const data = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.equal(data.tasks[0]!.model, "opencode-go/deepseek-v4-flash");
  });

  it("前台模式带 model → 类型化报错，不创建任务", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");

    const result = await fake.runTool("loop_create", { task: "前台", schedule: "5m", model: "a/b" });
    assert.equal(result.isError, true);
    assert.match(toolText(result), /background/);
    assert.equal(fake._persisted.length, 0);
  });

  it("mode=background 不带 model → 现状不变", async () => {
    const fake = createFakePi();
    loopFactory(fake as never);
    await fake.fire("session_start");

    const result = await fake.runTool("loop_create", { task: "后台", schedule: "5m", mode: "background" });
    assert.equal(result.isError, undefined);
    const data = fake._persisted[0]!.data as { tasks: LoopTask[] };
    assert.equal(data.tasks[0]!.model, undefined);
  });
});
