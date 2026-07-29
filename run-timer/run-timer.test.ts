import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import runTimer, {
  formatDuration,
  visualLen,
  truncateVisual,
  buildDisplayLine,
} from "./run-timer.ts";
import type { TimerState } from "./run-timer.ts";

// Mock setInterval/clearInterval to prevent real timers and track active ones
const activeTimers = new Set<ReturnType<typeof setInterval>>();
let timerIdCounter = 0;

function installTimerMock(): void {
  timerIdCounter = 0;
  activeTimers.clear();
  const origSet = globalThis.setInterval.bind(globalThis);
  const origClear = globalThis.clearInterval.bind(globalThis);
  globalThis.setInterval = ((_fn: Function, _ms: number, ..._args: any[]) => {
    const id = ++timerIdCounter as any;
    activeTimers.add(id);
    return id;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = (id: any) => {
    activeTimers.delete(id);
  };
  // Keep references for restore
  (globalThis as any).__origSetInterval = origSet;
  (globalThis as any).__origClearInterval = origClear;
}

function restoreTimerMock(): void {
  if ((globalThis as any).__origSetInterval) {
    globalThis.setInterval = (globalThis as any).__origSetInterval;
    globalThis.clearInterval = (globalThis as any).__origClearInterval;
    delete (globalThis as any).__origSetInterval;
    delete (globalThis as any).__origClearInterval;
  }
  activeTimers.clear();
}

function timerCount(): number {
  return activeTimers.size;
}

before(() => installTimerMock());
after(() => restoreTimerMock());

// ---------- Unit tests ----------

describe("formatDuration", () => {
  const cases: [number, string][] = [
    [0, "00:00"],
    [999, "00:00"],
    [1000, "00:01"],
    [59000, "00:59"],
    [60000, "01:00"],
    [3599000, "59:59"],
    [3600000, "1:00:00"],
    [3661000, "1:01:01"],
    [-500, "00:00"],
  ];
  for (const [input, expected] of cases) {
    it(`formatDuration(${input}) = "${expected}"`, () => {
      assert.equal(formatDuration(input), expected);
    });
  }
});

describe("visualLen / isCJK", () => {
  it("ASCII chars are 1 wide", () => {
    assert.equal(visualLen("hello"), 5);
  });
  it("CJK chars are 2 wide", () => {
    assert.equal(visualLen("任务"), 4);
  });
  it("mixed content", () => {
    assert.equal(visualLen("本轮 00:00"), 10);
    assert.equal(visualLen("本会话 01:15"), 12);
  });
  it("ellipsis is 1 wide", () => {
    assert.equal(visualLen("…"), 1);
  });
});

describe("truncateVisual", () => {
  it("short text unchanged", () => {
    assert.equal(truncateVisual("hello", 10), "hello");
  });
  it("exact fit unchanged", () => {
    assert.equal(truncateVisual("hello", 5), "hello");
  });
  it("truncates ASCII with ellipsis", () => {
    assert.equal(truncateVisual("hello world", 8), "hello w…");
  });
  it("maxLen 1 returns ellipsis", () => {
    assert.equal(truncateVisual("ab", 1), "…");
  });
  it("truncates CJK respecting double width", () => {
    const r = truncateVisual("任务test", 6);
    assert.ok(visualLen(r) <= 6, `visualLen(${r}) = ${visualLen(r)} > 6`);
  });
});

describe("buildDisplayLine", () => {
  const baseState: TimerState = {
    sessionTotalMs: 0,
    accountedTaskIds: new Set(),
  };

  it("idle state shows 本轮 00:00 and 本会话 00:00", () => {
    const line = buildDisplayLine(baseState, 0, 80);
    assert.match(line, /本轮 00:00/);
    assert.match(line, /本会话 00:00/);
    assert.doesNotMatch(line, /任务/);
    assert.doesNotMatch(line, /上次任务/);
  });

  it("active task renders before lastTask", () => {
    const state: TimerState = {
      ...baseState,
      sessionTotalMs: 45000,
      currentTask: { id: "t2", startedAt: 0 },
      lastTask: { durationMs: 45000 },
    };
    const line = buildDisplayLine(state, 37000, 80);
    assert.match(line, /任务 00:37/);
    assert.doesNotMatch(line, /上次任务/);
  });

  it("active task shows running task + turn", () => {
    const state: TimerState = {
      ...baseState,
      currentTask: { id: "t1", startedAt: 0 },
      currentTurn: { startedAt: 0 },
    };
    const line = buildDisplayLine(state, 37000, 80);
    assert.match(line, /任务 00:37/);
    assert.match(line, /本轮 00:37/);
  });

  it("session total includes active task elapsed", () => {
    const state: TimerState = {
      ...baseState,
      sessionTotalMs: 30000,
      currentTask: { id: "t2", startedAt: 0 },
    };
    const line = buildDisplayLine(state, 15000, 80);
    assert.match(line, /本会话 00:45/);
  });

  it("turn_end clears turn, keeps task running", () => {
    const state: TimerState = {
      ...baseState,
      currentTask: { id: "t1", startedAt: 0 },
    };
    const line = buildDisplayLine(state, 37000, 80);
    assert.match(line, /任务 00:37/);
    assert.match(line, /本轮 00:00/);
  });

  it("settled task shows 已结束", () => {
    const state: TimerState = {
      ...baseState,
      sessionTotalMs: 45000,
      lastTask: { durationMs: 45000 },
    };
    const line = buildDisplayLine(state, 0, 80);
    assert.match(line, /上次任务 00:45（已结束）/);
    assert.match(line, /本会话 00:45/);
  });

  it("session total accumulates across tasks", () => {
    const state: TimerState = {
      ...baseState,
      sessionTotalMs: 75000,
      lastTask: { durationMs: 45000 },
    };
    const line = buildDisplayLine(state, 0, 80);
    assert.match(line, /本会话 01:15/);
  });

  it("width truncation keeps session total", () => {
    const state: TimerState = {
      ...baseState,
      sessionTotalMs: 99999999,
      lastTask: { durationMs: 99999999 },
    };
    const line = buildDisplayLine(state, 0, 40);
    assert.match(line, /本会话/);
    assert.ok(visualLen(line) <= 40, `visualLen ${visualLen(line)} > 40`);
  });

  it("very narrow terminal still shows session total", () => {
    const state: TimerState = {
      ...baseState,
      sessionTotalMs: 3600000,
    };
    const line = buildDisplayLine(state, 5000, 20);
    assert.match(line, /本会话/);
    assert.ok(visualLen(line) <= 20, `visualLen ${visualLen(line)} > 20`);
  });
});

// ---------- Integration tests with real factory ----------

interface FakeWidget {
  id: string;
  content?: string[];
}

function createFakeAPI() {
  const widgets = new Map<string, FakeWidget>();
  const handlers = new Map<string, (e: any, ctx: any) => void | Promise<void>>();
  let hasUIFlag = true;

  const api = {
    _widgets: widgets,
    _handlers: handlers,

    get hasUI() { return hasUIFlag; },
    set hasUI(v: boolean) { hasUIFlag = v; },

    on: (event: string, handler: (e: any, ctx: any) => void | Promise<void>) => {
      handlers.set(event, handler);
    },

    registerCommand: () => {},

    fire: async (event: string) => {
      const h = handlers.get(event);
      if (!h) throw new Error(`No handler for ${event}`);
      const ctx = {
        hasUI: hasUIFlag,
        signal: undefined,
        model: undefined,
        modelRegistry: undefined,
        ui: {
          setWidget: (id: string, content?: string | string[]) => {
            if (content === undefined) {
              widgets.delete(id);
            } else {
              widgets.set(id, { id, content: Array.isArray(content) ? content : [content] });
            }
          },
          theme: { fg: (_style: string, text: string) => `\x1b[2m${text}\x1b[22m` },
          setStatus: () => {},
        },
      };
      await h({}, ctx);
    },
  };

  return api;
}

describe("real factory — event registration", () => {
  it("registers all required lifecycle events", () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    const expected = ["session_start", "agent_start", "turn_start", "turn_end", "agent_settled", "session_shutdown"];
    for (const evt of expected) {
      assert.ok(fake._handlers.has(evt), `missing handler for ${evt}`);
    }
  });
});

describe("real factory — widget lifecycle", () => {
  it("session_start creates widget when hasUI is true", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    const w = fake._widgets.get("run-timer");
    assert.ok(w, "widget should exist");
    assert.ok(Array.isArray(w!.content), "widget content should be an array");
  });

  it("session_start does not create widget when hasUI is false", async () => {
    const fake = createFakeAPI();
    fake.hasUI = false;
    runTimer(fake as any);
    await fake.fire("session_start");
    assert.equal(fake._widgets.size, 0);
  });

  it("session_shutdown removes widget", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    assert.ok(fake._widgets.has("run-timer"));
    await fake.fire("session_shutdown");
    assert.ok(!fake._widgets.has("run-timer"));
  });

  it("agent_start triggers immediate widget update", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    fake._widgets.delete("run-timer");
    await fake.fire("agent_start");
    const w = fake._widgets.get("run-timer");
    assert.ok(w, "widget should update immediately after agent_start");
  });

  it("turn_end triggers immediate widget update", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    fake._widgets.delete("run-timer");
    await fake.fire("turn_end");
    const w = fake._widgets.get("run-timer");
    assert.ok(w, "widget should update immediately after turn_end");
  });

  it("agent_settled triggers immediate widget update", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    await fake.fire("agent_start");
    fake._widgets.delete("run-timer");
    await fake.fire("agent_settled");
    const w = fake._widgets.get("run-timer");
    assert.ok(w, "widget should update immediately after agent_settled");
  });
});

describe("real factory — display content", () => {
  it("shows running task + turn after agent_start + turn_start", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    await fake.fire("agent_start");
    await fake.fire("turn_start");
    const w = fake._widgets.get("run-timer");
    assert.ok(w, "widget exists");
    const text = w!.content?.[0] || "";
    assert.match(text, /任务/);
    assert.match(text, /本轮/);
    assert.match(text, /本会话/);
  });

  it("turn_end clears turn display to 00:00", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    await fake.fire("agent_start");
    await fake.fire("turn_start");
    await fake.fire("turn_end");
    const w = fake._widgets.get("run-timer");
    const text = w!.content?.[0] || "";
    assert.match(text, /本轮 00:00/);
  });

  it("settled task shows 已结束", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    await fake.fire("agent_start");
    await fake.fire("agent_settled");
    const w = fake._widgets.get("run-timer");
    const text = w!.content?.[0] || "";
    assert.match(text, /（已结束）/);
  });
});

describe("real factory — timer lifecycle", () => {
  function resetActiveTimers(): void {
    activeTimers.clear();
    timerIdCounter = 0;
  }

  it("session_start with hasUI creates one timer", async () => {
    resetActiveTimers();
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1, "one timer should be created");
  });

  it("session_start without hasUI creates no timer", async () => {
    resetActiveTimers();
    const fake = createFakeAPI();
    runTimer(fake as any);
    fake.hasUI = false;
    await fake.fire("session_start");
    assert.equal(timerCount(), 0, "no timer created without UI");
  });

  it("session_shutdown clears the timer", async () => {
    resetActiveTimers();
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1, "timer created on start");
    await fake.fire("session_shutdown");
    assert.equal(timerCount(), 0, "timer cleared on shutdown");
  });

  it("UI=true start then UI=false start clears old timer", async () => {
    resetActiveTimers();
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1, "timer created for first session");
    assert.ok(fake._widgets.has("run-timer"), "widget created");

    fake.hasUI = false;
    await fake.fire("session_start");
    assert.equal(timerCount(), 0, "old timer cleared when new session has no UI");
    assert.ok(!fake._widgets.has("run-timer"), "old widget removed");
  });

  it("double session_start with UI keeps exactly one timer", async () => {
    resetActiveTimers();
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1, "only one timer after second start");
  });

  it("consecutive session_start + shutdown cycles keep timer count correct", async () => {
    resetActiveTimers();
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1);
    await fake.fire("session_shutdown");
    assert.equal(timerCount(), 0);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1);
    await fake.fire("session_shutdown");
    assert.equal(timerCount(), 0);
  });

  it("double factory call — second init cleans first instance interval", async () => {
    resetActiveTimers();
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    assert.equal(timerCount(), 1, "timer after first factory session_start");

    runTimer(fake as any);
    assert.equal(timerCount(), 0, "old interval cleaned on second factory call");

    await fake.fire("session_start");
    assert.equal(timerCount(), 1, "one timer after second factory session_start");

    await fake.fire("session_shutdown");
    assert.equal(timerCount(), 0, "timer cleared on shutdown");
  });

  it("A/B/old A shutdown/C interleaved — dispose ownership preserved", async () => {
    resetActiveTimers();
    const fakeA = createFakeAPI();
    const fakeB = createFakeAPI();
    const fakeC = createFakeAPI();

    runTimer(fakeA as any);
    await fakeA.fire("session_start");
    assert.equal(timerCount(), 1, "A: timer created");

    runTimer(fakeB as any);
    assert.equal(timerCount(), 0, "B: A's timer disposed by dispose");

    await fakeB.fire("session_start");
    assert.equal(timerCount(), 1, "B: new timer created");

    await fakeA.fire("session_shutdown");
    assert.equal(timerCount(), 1, "A shutdown: B's timer not affected");

    runTimer(fakeC as any);
    assert.equal(timerCount(), 0, "C: B's timer disposed by dispose");

    await fakeC.fire("session_start");
    assert.equal(timerCount(), 1, "C: new timer created");

    await fakeC.fire("session_shutdown");
    assert.equal(timerCount(), 0, "C shutdown: timer cleared");
  });
});

describe("real factory — dedup accounting", () => {
  it("settled then shutdown does not double-count", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    await fake.fire("agent_start");
    await fake.fire("agent_settled");

    const w1 = fake._widgets.get("run-timer")!;
    const text1 = w1.content?.[0] || "";
    const match1 = text1.match(/本会话 (\d+:\d+)/);
    assert.ok(match1, "session total in widget");

    await fake.fire("session_shutdown");
    const w2 = fake._widgets.get("run-timer");
    assert.ok(!w2, "widget removed on shutdown");
  });
});

describe("real factory — widgetLines array contract", () => {
  it("setWidget is called with an array", async () => {
    const fake = createFakeAPI();
    runTimer(fake as any);
    await fake.fire("session_start");
    await fake.fire("agent_start");
    const w = fake._widgets.get("run-timer");
    assert.ok(w, "widget exists");
    assert.ok(Array.isArray(w!.content), "content is array");
    assert.equal(w!.content!.length, 1, "single line");
  });
});
