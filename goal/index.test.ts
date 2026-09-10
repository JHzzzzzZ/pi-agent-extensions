/**
 * goal 扩展测试:node:test + assert/strict,全部使用手写 fake(pi 宿主/评估器/时钟),无网络。
 * 运行:node --experimental-strip-types --test goal/index.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EvaluatorResult } from "./index.ts";
import {
  GOAL_CONTINUE_MESSAGE,
  GOAL_RESULT_ENTRY,
  GOAL_STATE_ENTRY,
  MAX_GOAL_LENGTH,
  STATUS_KEY,
  buildContinueMessage,
  buildEvaluatorPrompt,
  buildStatusLine,
  createGoalExtension,
  createModelEvaluator,
  extractAssistantText,
  extractJsonObject,
  formatElapsed,
  GOAL_SUBCOMMANDS,
  parseGoalArgs,
  parseVerdict,
  RETIRED_GOAL_SUBCOMMANDS,
  truncateText,
} from "./index.ts";

// ===== 手写 fake:pi 宿主 =====

interface SentMessage {
  message: { customType: string; content: string; display: boolean };
  options?: { triggerTurn?: boolean; deliverAs?: string };
}

function makeFakePi(sessionEntries: unknown[] = []) {
  let waitForIdleCalls = 0;
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const sent: SentMessage[] = [];
  const userMessages: string[] = [];
  const entries: Array<{ customType: string; data?: unknown }> = [];
  const statuses: Array<string | undefined> = [];
  const statusKeys: string[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options);
    },
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      sent.push({ message, options });
    },
    sendUserMessage: (content: string) => {
      userMessages.push(content);
    },
    appendEntry: (customType: string, data?: unknown) => {
      entries.push({ customType, data });
    },
  };
  const makeCtx = (overrides: Record<string, unknown> = {}) => ({
    hasUI: true,
    mode: "tui",
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statusKeys.push(key);
        statuses.push(text);
      },
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      theme: undefined,
    },
    sessionManager: { getEntries: () => sessionEntries },
    signal: undefined,
    waitForIdle: async () => {
      waitForIdleCalls += 1;
    },
    ...overrides,
  });
  return {
    pi,
    handlers,
    commands,
    sent,
    userMessages,
    entries,
    statuses,
    statusKeys,
    notifications,
    makeCtx,
    waitForIdleCalls: () => waitForIdleCalls,
  };
}

// 固定时钟 2026-08-05T12:00:00Z,每次调用 +1s,便于断言时长
function makeClock() {
  let now = Date.parse("2026-08-05T12:00:00Z");
  return () => (now += 1000);
}

// ---------- 定时器 mock：对齐节拍器（aligned-ticker）捕获回调，测试手动触发 tick ----------

const timers = new Map<number, () => void>();
let timerSeq = 0;
let origSetTimeout: typeof globalThis.setTimeout | undefined;
let origClearTimeout: typeof globalThis.clearTimeout | undefined;

function installTimerMocks(): void {
  origSetTimeout = globalThis.setTimeout;
  origClearTimeout = globalThis.clearTimeout;
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
}

function restoreTimerMocks(): void {
  if (origSetTimeout) globalThis.setTimeout = origSetTimeout;
  if (origClearTimeout) globalThis.clearTimeout = origClearTimeout;
  timers.clear();
}

function fireTick(): void {
  for (const fn of [...timers.values()]) fn();
}

function timerCount(): number {
  return timers.size;
}

before(() => installTimerMocks());
after(() => restoreTimerMocks());

function boot(options: { sessionEntries?: unknown[]; evaluate?: (input: any, ctx: any) => Promise<any> } = {}) {
  const fake = makeFakePi(options.sessionEntries ?? []);
  const evaluateCalls: Array<{ input: any; ctx: any }> = [];
  const evaluateImpl = options.evaluate ?? (async () => ({ ok: true, met: false, reason: "尚未达成" }));
  const evaluate = async (input: any, ctx: any) => {
    evaluateCalls.push({ input, ctx });
    return evaluateImpl(input, ctx);
  };
  createGoalExtension(fake.pi as unknown as ExtensionAPI, { evaluate, nowMs: makeClock() });
  return { fake, evaluateCalls };
}

// ===== 纯函数:parseGoalArgs =====

test("parseGoalArgs:空参数是查询状态", () => {
  assert.deepEqual(parseGoalArgs(""), { action: "status" });
  assert.deepEqual(parseGoalArgs("   "), { action: "status" });
});

test("parseGoalArgs:旧管理词不再是子命令（回落为目标文本）", () => {
  // 裸命令只剩 status/set；clear 等管理词经裸入口时先被改名提示拦截（见接线测试），
  // parseGoalArgs 本身不再识别它们。
  for (const alias of ["clear", "stop", "off", "reset", "none", "cancel", "resume"]) {
    assert.deepEqual(parseGoalArgs(alias), { action: "set", goal: alias });
  }
  // `/goal status` 仍是目标文本（既有语义不变，status 不在退役表）。
  assert.deepEqual(parseGoalArgs("status"), { action: "set", goal: "status" });
});

test("RETIRED_GOAL_SUBCOMMANDS 映射旧词到冒号命令；6 别名共享 clear", () => {
  for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"] as const) {
    assert.equal(RETIRED_GOAL_SUBCOMMANDS[alias]?.command, GOAL_SUBCOMMANDS[alias]);
    assert.equal(GOAL_SUBCOMMANDS[alias], `goal:${alias}`);
  }
  assert.equal(RETIRED_GOAL_SUBCOMMANDS.resume?.command, "goal:resume");
  assert.equal(RETIRED_GOAL_SUBCOMMANDS.status, undefined, "status 不是退役子命令");
  assert.equal(GOAL_SUBCOMMANDS.status, "goal:status");
  assert.equal(GOAL_SUBCOMMANDS.resume, "goal:resume");
});

test("parseGoalArgs:其余文本整体作为目标并保留内部空格", () => {
  assert.deepEqual(parseGoalArgs("  all tests pass  and lint is clean "), {
    action: "set",
    goal: "all tests pass  and lint is clean",
  });
});

test("parseGoalArgs:超过 4000 字符拒绝,恰好 4000 允许", () => {
  assert.equal(parseGoalArgs("x".repeat(MAX_GOAL_LENGTH + 1)).action, "invalid");
  assert.deepEqual(parseGoalArgs("x".repeat(MAX_GOAL_LENGTH)), { action: "set", goal: "x".repeat(MAX_GOAL_LENGTH) });
});

// ===== 纯函数:extractJsonObject / parseVerdict =====

test("extractJsonObject:截取第一个括号平衡块,字符串内大括号不干扰", () => {
  assert.equal(extractJsonObject('前言 {"a":1} 后记'), '{"a":1}');
  assert.equal(extractJsonObject('{"met": true, "reason": "含 } 与 { 的说明"}'), '{"met": true, "reason": "含 } 与 { 的说明"}');
  assert.equal(extractJsonObject("没有 JSON"), undefined);
  assert.equal(extractJsonObject('{"未闭合": 1'), undefined);
});

test("parseVerdict:裸 JSON", () => {
  assert.deepEqual(parseVerdict('{"met": true, "reason": "所有测试通过"}'), { ok: true, met: true, reason: "所有测试通过" });
});

test("parseVerdict:code fence 包裹", () => {
  assert.deepEqual(parseVerdict('```json\n{"met": false, "reason": "2 个测试失败"}\n```'), {
    ok: true,
    met: false,
    reason: "2 个测试失败",
  });
});

test("parseVerdict:前后夹杂文字仍可解析", () => {
  const v = parseVerdict('评估结果:{"met": false, "reason": "还差一个模块"} 完。');
  assert.deepEqual(v, { ok: true, met: false, reason: "还差一个模块" });
});

test("parseVerdict:met 非布尔或缺字段拒绝", () => {
  assert.equal(parseVerdict('{"met": "true", "reason": "x"}').ok, false);
  assert.equal(parseVerdict('{"reason": "x"}').ok, false);
  assert.equal(parseVerdict("[]").ok, false);
});

test("parseVerdict:垃圾输入拒绝", () => {
  assert.equal(parseVerdict("完全没有 JSON").ok, false);
  assert.equal(parseVerdict('{"met": true, ').ok, false);
  assert.equal(parseVerdict("").ok, false);
});

test("parseVerdict:reason 缺省空串,超长截断到 500", () => {
  assert.deepEqual(parseVerdict('{"met": true}'), { ok: true, met: true, reason: "" });
  const long = parseVerdict(JSON.stringify({ met: false, reason: "r".repeat(600) }));
  assert.ok(long.ok);
  if (long.ok) assert.equal(long.reason.length, 500);
});

// ===== 纯函数:prompt / 续跑消息 / 状态行 =====

test("buildEvaluatorPrompt:包含目标、证据与 JSON 指令;lastReason 可选", () => {
  const p1 = buildEvaluatorPrompt({ goal: "测试全绿", evidence: "npm test 输出:全部通过" });
  assert.ok(p1.includes("测试全绿") && p1.includes("npm test 输出:全部通过"));
  assert.ok(p1.includes('"met"'));
  assert.ok(!p1.includes("PREVIOUS"));
  const p2 = buildEvaluatorPrompt({ goal: "g", evidence: "", lastReason: "上次差一个文件" });
  assert.ok(p2.includes("上次差一个文件") && p2.includes("(no assistant output captured)"));
});

test("buildContinueMessage:包含目标/原因/轮数与证据要求", () => {
  const m = buildContinueMessage("目标A", "还差一个模块", 3);
  assert.ok(m.includes("[goal]") && m.includes("目标A") && m.includes("还差一个模块") && m.includes("第 3 轮"));
});

test("buildStatusLine:active/paused 形态、轮数与时长", () => {
  const line = buildStatusLine({ phase: "active", goal: "修复全部测试", turns: 4, startedAtMs: 0 }, 65_000);
  assert.ok(line.includes("◎") && line.includes("修复全部测试") && line.includes("第4轮") && line.includes("1m05s"));
  const paused = buildStatusLine({ phase: "paused", goal: "g", turns: 2, startedAtMs: 0 }, 1000);
  assert.ok(paused.includes("已暂停") && paused.includes("⏸"));
});

test("buildStatusLine:超长目标截断", () => {
  const line = buildStatusLine({ phase: "active", goal: "字".repeat(60), turns: 1, startedAtMs: 0 }, 0);
  assert.ok(line.includes("…"));
  assert.ok(line.length < 80);
});

test("formatElapsed:各量级", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(42_000), "42s");
  assert.equal(formatElapsed(65_000), "1m05s");
  assert.equal(formatElapsed(3_723_000), "1h02m");
});

test("truncateText:按码点截断", () => {
  assert.equal(truncateText("abcdef", 6), "abcdef");
  assert.equal(truncateText("abcdef", 5), "abcd…");
});

test("extractAssistantText:只取 assistant 文本,忽略 thinking/toolResult,超限取尾部", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "第一段" }, { type: "thinking", thinking: "不应出现" }] },
    { role: "toolResult", content: [{ type: "text", text: "工具结果" }] },
    { role: "assistant", content: [{ type: "text", text: "第二段" }] },
  ];
  const text = extractAssistantText(messages);
  assert.ok(text.includes("第一段") && text.includes("第二段"));
  assert.ok(!text.includes("不应出现") && !text.includes("工具结果"));
  const tail = extractAssistantText([{ role: "assistant", content: [{ type: "text", text: "x".repeat(13_000) }] }]);
  assert.equal(tail.length, 12_000);
});

// ===== 接线 =====

test("createGoalExtension:注册 goal 命令、冒号子命令与预期 hooks", () => {
  const { fake } = boot();
  assert.deepEqual(
    [...fake.commands.keys()].sort(),
    ["goal", "goal:cancel", "goal:clear", "goal:none", "goal:off", "goal:reset", "goal:resume", "goal:status", "goal:stop"],
  );
  for (const name of fake.commands.keys()) {
    assert.ok((fake.commands.get(name)?.description ?? "").length > 0, `${name} has a description`);
  }
  for (const event of ["session_start", "agent_start", "turn_end", "agent_end", "agent_settled", "session_shutdown"]) {
    assert.ok(fake.handlers.has(event), `缺少 ${event} hook`);
  }
});

test("裸 /goal 的旧管理词只提示改名，绝不设置目标", async () => {
  const { fake } = boot();
  for (const head of ["clear", "stop", "resume", "none"]) {
    await fake.commands.get("goal")!.handler(head, fake.makeCtx());
    const note = fake.notifications.at(-1)!;
    assert.equal(note.type, "warning");
    assert.match(note.message, new RegExp(`「/goal ${head}」已改名为「/goal:${head}」`));
  }
  assert.equal(fake.entries.length, 0, "改名提示不落盘");
  assert.equal(fake.userMessages.length, 0, "改名提示不开回合");
});

// ===== 设置 / 查询 / 清除 / 恢复 =====

test("/goal <条件>:等待空闲→持久化→sendUserMessage 开第一轮→状态行", async () => {
  const { fake } = boot();
  await fake.commands.get("goal")!.handler(" 修复全部测试 ", fake.makeCtx());
  assert.equal(fake.waitForIdleCalls(), 1);
  assert.deepEqual(fake.entries, [{ customType: GOAL_STATE_ENTRY, data: { goal: "修复全部测试" } }]);
  assert.deepEqual(fake.userMessages, ["修复全部测试"]);
  assert.ok(fake.notifications.some((n) => n.message.includes("已设置")));
  assert.ok(fake.statuses.at(-1)!.includes("◎"));
});

test("/goal 超长目标:警告且不落盘、不开回合", async () => {
  const { fake } = boot();
  await fake.commands.get("goal")!.handler("x".repeat(MAX_GOAL_LENGTH + 1), fake.makeCtx());
  assert.equal(fake.entries.length, 0);
  assert.equal(fake.userMessages.length, 0);
  assert.equal(fake.notifications[0]?.type, "warning");
});

test("/goal 查询:idle 与 active 两种文案", async () => {
  const { fake } = boot();
  await fake.commands.get("goal")!.handler("", fake.makeCtx());
  assert.ok(fake.notifications[0].message.includes("没有活跃"));
  await fake.commands.get("goal")!.handler("写完文档", fake.makeCtx());
  fake.notifications.length = 0;
  await fake.commands.get("goal")!.handler("", fake.makeCtx());
  assert.ok(fake.notifications[0].message.includes("写完文档"));
  assert.ok(fake.notifications[0].message.includes("已评估轮数"));
});

test("/goal:clear:落盘 {goal:null} 并清状态行;idle 时只提示", async () => {
  const { fake } = boot();
  await fake.commands.get("goal")!.handler("任务", fake.makeCtx());
  await fake.commands.get("goal:stop")!.handler("", fake.makeCtx());
  assert.deepEqual(fake.entries.at(-1), { customType: GOAL_STATE_ENTRY, data: { goal: null } });
  assert.ok(fake.notifications.some((n) => n.message.includes("已清除")));
  assert.equal(fake.statuses.at(-1), undefined);
  fake.entries.length = 0;
  await fake.commands.get("goal:clear")!.handler("", fake.makeCtx());
  assert.equal(fake.entries.length, 0);
  assert.ok(fake.notifications.at(-1)!.message.includes("没有活跃"));
});

test("/goal:resume:paused 恢复并立即续跑;active 时提示无需恢复", async () => {
  const { fake, evaluateCalls } = boot();
  const ctx = fake.makeCtx();
  await fake.commands.get("goal")!.handler("任务", ctx);
  fake.handlers.get("turn_end")!({}, { ...ctx, signal: { aborted: true } });
  fake.handlers.get("agent_end")!({ messages: [] }, { ...ctx, signal: { aborted: true } });
  await fake.handlers.get("agent_settled")!({}, ctx);
  assert.ok(fake.notifications.some((n) => n.message.includes("已暂停")));
  assert.equal(evaluateCalls.length, 0); // 中断路径不做评估
  fake.sent.length = 0;
  await fake.commands.get("goal:resume")!.handler("", ctx);
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].options?.triggerTurn, true);
  assert.equal(fake.sent[0].options?.deliverAs, "followUp");
  await fake.commands.get("goal:resume")!.handler("", ctx);
  assert.ok(fake.notifications.at(-1)!.message.includes("无需恢复"));
});

// ===== 评估循环 =====

test("agent_settled:未达成→继续消息(triggerTurn+followUp,含原因与轮数)", async () => {
  const { fake, evaluateCalls } = boot({ evaluate: async () => ({ ok: true, met: false, reason: "还差 2 个测试" }) });
  const ctx = fake.makeCtx();
  await fake.commands.get("goal")!.handler("测试全绿", ctx);
  fake.handlers.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text: "改了 3 个文件" }] }] }, ctx);
  await fake.handlers.get("agent_settled")!({}, ctx);
  assert.equal(evaluateCalls.length, 1);
  assert.equal(evaluateCalls[0].input.goal, "测试全绿");
  assert.ok(evaluateCalls[0].input.evidence.includes("改了 3 个文件"));
  assert.equal(fake.sent.length, 1);
  const { message, options } = fake.sent[0];
  assert.equal(message.customType, GOAL_CONTINUE_MESSAGE);
  assert.equal(message.display, true);
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
  assert.ok(message.content.includes("测试全绿") && message.content.includes("还差 2 个测试") && message.content.includes("第 1 轮"));
  assert.ok(fake.statuses.at(-1)!.includes("第1轮"));
  assert.equal(fake.entries.filter((e) => e.customType === GOAL_STATE_ENTRY).length, 1); // 循环中不重复落盘状态
});

test("agent_settled:达成→结果条目+通知,不再续跑,后续 settle 无动作", async () => {
  const { fake } = boot({ evaluate: async () => ({ ok: true, met: true, reason: "测试全部通过" }) });
  const ctx = fake.makeCtx();
  await fake.commands.get("goal")!.handler("测试全绿", ctx);
  fake.handlers.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text: "全部通过" }] }] }, ctx);
  await fake.handlers.get("agent_settled")!({}, ctx);
  assert.equal(fake.sent.length, 0);
  const result = fake.entries.find((e) => e.customType === GOAL_RESULT_ENTRY);
  assert.ok(result);
  assert.equal((result!.data as any).turns, 1);
  assert.equal((result!.data as any).reason, "测试全部通过");
  assert.ok(fake.notifications.at(-1)!.message.includes("已达成"));
  assert.equal(fake.statuses.at(-1), undefined);
  fake.handlers.get("agent_end")!({ messages: [] }, ctx);
  await fake.handlers.get("agent_settled")!({}, ctx);
  assert.equal(fake.entries.filter((e) => e.customType === GOAL_RESULT_ENTRY).length, 1);
  assert.equal(fake.sent.length, 0);
});

test("agent_settled:评估器连续失败 3 次才暂停,前两次继续", async () => {
  const { fake } = boot({
    evaluate: async () => ({ ok: false, code: "evaluator-error", message: "超时" }),
  });
  const ctx = fake.makeCtx();
  await fake.commands.get("goal")!.handler("任务", ctx);
  for (let i = 1; i <= 2; i++) {
    fake.handlers.get("agent_end")!({ messages: [] }, ctx);
    await fake.handlers.get("agent_settled")!({}, ctx);
    assert.equal(fake.sent.length, i, `第 ${i} 次瞬时失败应继续`);
  }
  fake.handlers.get("agent_end")!({ messages: [] }, ctx);
  await fake.handlers.get("agent_settled")!({}, ctx);
  assert.equal(fake.sent.length, 2); // 第 3 次失败暂停,不再续跑
  assert.ok(fake.notifications.some((n) => n.type === "error" && n.message.includes("已暂停")));
  await fake.handlers.get("agent_settled")!({}, ctx); // 暂停后 settle 无动作
  assert.equal(fake.sent.length, 2);
});

test("agent_settled:评估期间目标被清除→本轮作废不续跑", async () => {
  const { fake } = boot({
    evaluate: async () => {
      await fake.commands.get("goal:clear")!.handler("", fake.makeCtx());
      return { ok: true, met: false, reason: "r" };
    },
  });
  const ctx = fake.makeCtx();
  await fake.commands.get("goal")!.handler("任务", ctx);
  fake.handlers.get("agent_end")!({ messages: [] }, ctx);
  await fake.handlers.get("agent_settled")!({}, ctx);
  assert.equal(fake.sent.length, 0);
  assert.ok(fake.notifications.some((n) => n.message.includes("已清除")));
});

test("agent_settled:评估期间设置新目标→旧评估作废,新目标已启动", async () => {
  const { fake } = boot({
    evaluate: async () => {
      await fake.commands.get("goal")!.handler("新目标", fake.makeCtx());
      return { ok: true, met: false, reason: "r" };
    },
  });
  const ctx = fake.makeCtx();
  await fake.commands.get("goal")!.handler("旧目标", ctx);
  fake.handlers.get("agent_end")!({ messages: [] }, ctx);
  await fake.handlers.get("agent_settled")!({}, ctx);
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(fake.userMessages, ["旧目标", "新目标"]);
});

test("agent_settled:无目标时零动作", async () => {
  const { fake, evaluateCalls } = boot();
  await fake.handlers.get("agent_settled")!({}, fake.makeCtx());
  assert.equal(evaluateCalls.length, 0);
  assert.equal(fake.sent.length, 0);
});

test("agent_settled:重入保护(评估未返回前再次 settle 不重复评估)", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { fake } = boot({
    evaluate: async () => {
      calls += 1;
      await gate;
      return { ok: true, met: false, reason: "r" };
    },
  });
  const ctx = fake.makeCtx();
  await fake.commands.get("goal")!.handler("任务", ctx);
  fake.handlers.get("agent_end")!({ messages: [] }, ctx);
  const first = fake.handlers.get("agent_settled")!({}, ctx);
  const second = fake.handlers.get("agent_settled")!({}, ctx);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(fake.sent.length, 1);
});

test("agent_settled:评估抛异常被兜底捕获并通知", async () => {
  const { fake } = boot({
    evaluate: async () => {
      throw new Error("网络炸了");
    },
  });
  const ctx = fake.makeCtx();
  await fake.commands.get("goal")!.handler("任务", ctx);
  fake.handlers.get("agent_end")!({ messages: [] }, ctx);
  await fake.handlers.get("agent_settled")!({}, ctx);
  assert.equal(fake.sent.length, 0);
  assert.ok(fake.notifications.at(-1)!.message.includes("网络炸了"));
});

// ===== 水合与生命周期 =====

test("session_start:从条目水合活跃目标(计数重置),随后正常续跑", async () => {
  const { fake, evaluateCalls } = boot({
    sessionEntries: [
      { type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: "历史目标" } },
      { type: "custom", customType: GOAL_RESULT_ENTRY, data: { goal: "更早已完成", turns: 3 } },
      { type: "message" },
    ],
    evaluate: async () => ({ ok: true, met: false, reason: "继续" }),
  });
  await fake.handlers.get("session_start")!({ reason: "resume" }, fake.makeCtx());
  assert.ok(fake.statuses.at(-1)!.includes("历史目标"));
  fake.handlers.get("agent_end")!({ messages: [] }, fake.makeCtx());
  await fake.handlers.get("agent_settled")!({}, fake.makeCtx());
  assert.equal(evaluateCalls.length, 1);
  assert.ok(fake.sent[0].message.content.includes("历史目标"));
});

test("session_start:{goal:null} 视为无目标", async () => {
  const { fake } = boot({ sessionEntries: [{ type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: null } }] });
  await fake.handlers.get("session_start")!({}, fake.makeCtx());
  assert.equal(fake.statuses.at(-1), undefined);
  await fake.handlers.get("agent_settled")!({}, fake.makeCtx());
  assert.equal(fake.sent.length, 0);
});

test("session_start:多条目取最后一条,坏数据视为已清除", async () => {
  const { fake } = boot({
    sessionEntries: [
      { type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: "旧目标" } },
      { type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: 42 } },
    ],
  });
  await fake.handlers.get("session_start")!({}, fake.makeCtx());
  assert.ok(!fake.statuses.at(-1)?.includes("旧目标"));
});

test("session_shutdown:清理状态与运行态,此后 settle 无动作", async () => {
  const { fake, evaluateCalls } = boot();
  const ctx = fake.makeCtx();
  await fake.commands.get("goal")!.handler("任务", ctx);
  fake.handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  assert.equal(fake.statuses.at(-1), undefined);
  fake.handlers.get("agent_end")!({ messages: [] }, ctx);
  await fake.handlers.get("agent_settled")!({}, ctx);
  assert.equal(evaluateCalls.length, 0);
});

// ===== 真实评估器(结构化 fake,无网络) =====

function makeEvaluatorCtx(model: unknown, registry: unknown): ExtensionContext {
  return { model, modelRegistry: registry, signal: undefined } as unknown as ExtensionContext;
}

function assertErrCode(result: EvaluatorResult, code: string): void {
  assert.ok(!result.ok, `期望错误 ${code},实际成功:${JSON.stringify(result)}`);
  assert.equal(result.code, code);
}

test("createModelEvaluator:正常解析 done 事件 JSON,过滤 thinking", async () => {
  const evaluate = createModelEvaluator({ nowMs: () => 0 });
  const provider = {
    stream: async function* () {
      yield {
        type: "done",
        message: { content: [{ type: "thinking", thinking: "内部思考" }, { type: "text", text: '{"met": true, "reason": "完成"}' }] },
      };
    },
  };
  const registry = {
    getProvider: (id: string) => (id === "p1" ? provider : undefined),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
  };
  const result = await evaluate({ goal: "g", evidence: "e" }, makeEvaluatorCtx({ provider: "p1" }, registry));
  assert.deepEqual(result, { ok: true, met: true, reason: "完成" });
});

test("createModelEvaluator:各失败路径返回结构化错误码", async () => {
  const evaluate = createModelEvaluator({ nowMs: () => 0 });
  const noModel = await evaluate({ goal: "g", evidence: "e" }, makeEvaluatorCtx(undefined, {}));
  assertErrCode(noModel, "no-model");

  const noProvider = await evaluate({ goal: "g", evidence: "e" }, makeEvaluatorCtx(
    { provider: "p" },
    { getProvider: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true }) },
  ));
  assertErrCode(noProvider, "no-provider");

  const authFail = await evaluate({ goal: "g", evidence: "e" }, makeEvaluatorCtx(
    { provider: "p" },
    { getProvider: () => ({}), getApiKeyAndHeaders: async () => ({ ok: false, error: "未配置 API key" }) },
  ));
  assertErrCode(authFail, "auth");

  const streamError = await evaluate({ goal: "g", evidence: "e" }, makeEvaluatorCtx(
    { provider: "p" },
    {
      getProvider: () => ({ stream: async function* () { yield { type: "error", error: { errorMessage: "boom" } }; } }),
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
  ));
  assertErrCode(streamError, "evaluator-error");

  const syncThrow = await evaluate({ goal: "g", evidence: "e" }, makeEvaluatorCtx(
    { provider: "p" },
    {
      getProvider: () => {
        throw new Error("sync boom");
      },
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
  ));
  assertErrCode(syncThrow, "evaluator-error");

  const junk = await evaluate({ goal: "g", evidence: "e" }, makeEvaluatorCtx(
    { provider: "p" },
    {
      getProvider: () => ({ stream: async function* () { yield { type: "done", message: { content: [{ type: "text", text: "不是 JSON" }] } }; } }),
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
  ));
  assertErrCode(junk, "bad-verdict");
});

// ===== 真实评估器:opencode 会话头注入 =====

interface CapturedStreamOptions {
  headers?: Record<string, string>;
}

function makeCaptureProvider(): { provider: unknown; captured: CapturedStreamOptions[] } {
  const captured: CapturedStreamOptions[] = [];
  const provider = {
    stream: async function* (_model: unknown, _options: unknown, streamOptions: CapturedStreamOptions) {
      captured.push(streamOptions);
      yield { type: "done", message: { content: [{ type: "text", text: '{"met": true, "reason": "完成"}' }] } };
    },
  };
  return { provider, captured };
}

test("createModelEvaluator:opencode-go 模型注入 x-opencode-session/x-opencode-client 会话头", async () => {
  const evaluate = createModelEvaluator({ nowMs: () => 0 });
  const { provider, captured } = makeCaptureProvider();
  const registry = {
    getProvider: (id: string) => (id === "opencode-go" ? provider : undefined),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: { Authorization: "Bearer k" } }),
  };
  const model = { provider: "opencode-go" };
  const ctx = { model, modelRegistry: registry, signal: undefined, sessionManager: { getSessionId: () => "s-123" } } as unknown as ExtensionContext;
  const result = await evaluate({ goal: "g", evidence: "e" }, ctx);
  assert.deepEqual(result, { ok: true, met: true, reason: "完成" });
  const headers = captured[0]?.headers ?? {};
  assert.equal(headers["x-opencode-session"], "s-123");
  assert.equal(headers["x-opencode-client"], "pi");
  // auth.headers 在后,保持宿主合并顺序(请求头覆盖会话头)
  assert.equal(headers.Authorization, "Bearer k");
});

test("createModelEvaluator:opencode 模型同样注入会话头", async () => {
  const evaluate = createModelEvaluator({ nowMs: () => 0 });
  const { provider, captured } = makeCaptureProvider();
  const registry = {
    getProvider: (id: string) => (id === "opencode" ? provider : undefined),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
  };
  const ctx = {
    model: { provider: "opencode" },
    modelRegistry: registry,
    signal: undefined,
    sessionManager: { getSessionId: () => "s-abc" },
  } as unknown as ExtensionContext;
  const result = await evaluate({ goal: "g", evidence: "e" }, ctx);
  assert.ok(result.ok);
  assert.equal(captured[0]?.headers?.["x-opencode-session"], "s-abc");
  assert.equal(captured[0]?.headers?.["x-opencode-client"], "pi");
});

test("createModelEvaluator:baseUrl host 为 opencode.ai 时也注入会话头", async () => {
  const evaluate = createModelEvaluator({ nowMs: () => 0 });
  const { provider, captured } = makeCaptureProvider();
  const registry = {
    getProvider: (id: string) => (id === "p1" ? provider : undefined),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
  };
  const ctx = {
    model: { provider: "p1", baseUrl: "https://opencode.ai/v1/chat" },
    modelRegistry: registry,
    signal: undefined,
    sessionManager: { getSessionId: () => "s-host" },
  } as unknown as ExtensionContext;
  const result = await evaluate({ goal: "g", evidence: "e" }, ctx);
  assert.ok(result.ok);
  assert.equal(captured[0]?.headers?.["x-opencode-session"], "s-host");
});

test("createModelEvaluator:非 opencode 模型不注入任何 x-opencode-* 头", async () => {
  const evaluate = createModelEvaluator({ nowMs: () => 0 });
  const { provider, captured } = makeCaptureProvider();
  const registry = {
    getProvider: (id: string) => (id === "p1" ? provider : undefined),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
  };
  const ctx = {
    model: { provider: "p1" },
    modelRegistry: registry,
    signal: undefined,
    sessionManager: { getSessionId: () => "s-123" },
  } as unknown as ExtensionContext;
  const result = await evaluate({ goal: "g", evidence: "e" }, ctx);
  assert.ok(result.ok);
  const keys = Object.keys(captured[0]?.headers ?? {});
  assert.ok(!keys.some((k) => k.startsWith("x-opencode-")), `不应含 x-opencode-* 头,实际:${keys}`);
});

test("createModelEvaluator:无 sessionId(缺失/抛异常)时不注入会话头且不崩溃", async () => {
  const evaluate = createModelEvaluator({ nowMs: () => 0 });
  const { provider, captured } = makeCaptureProvider();
  const registry = {
    getProvider: (id: string) => (id === "opencode-go" ? provider : undefined),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
  };
  // sessionManager 缺失
  const noManager = { model: { provider: "opencode-go" }, modelRegistry: registry, signal: undefined } as unknown as ExtensionContext;
  const r1 = await evaluate({ goal: "g", evidence: "e" }, noManager);
  assert.ok(r1.ok);
  assert.equal(captured[0]?.headers?.["x-opencode-session"], undefined);
  // getSessionId 抛异常
  const throwing = {
    model: { provider: "opencode-go" },
    modelRegistry: registry,
    signal: undefined,
    sessionManager: { getSessionId: () => { throw new Error("boom"); } },
  } as unknown as ExtensionContext;
  const r2 = await evaluate({ goal: "g", evidence: "e" }, throwing);
  assert.ok(r2.ok);
  assert.equal(captured[1]?.headers?.["x-opencode-session"], undefined);
});

// ===== 状态条对齐节拍（docs/cross/status-bar.md） =====

test("STATUS_KEY 带排序带前缀（10:goal）", () => {
  assert.equal(STATUS_KEY, "10:goal");
});

test("active 期间启动对齐节拍：tick 刷新“已运行”时长", async () => {
  const { fake } = boot();
  const ctx = fake.makeCtx();
  timers.clear();
  await fake.commands.get("goal")!.handler("写文档", ctx);
  assert.equal(timerCount(), 1, "active 后开启节拍");
  const writes = fake.statuses.length;
  fireTick();
  assert.ok(fake.statuses.length > writes, "tick 写新状态");
  assert.ok(fake.statuses.at(-1)!.includes("◎ goal"));
  assert.ok(
    fake.statusKeys.every((key) => key === STATUS_KEY),
    "所有状态都写排序带键",
  );
});

test("clear 后节拍停止并清状态", async () => {
  const { fake } = boot();
  const ctx = fake.makeCtx();
  timers.clear();
  await fake.commands.get("goal")!.handler("任务", ctx);
  assert.equal(timerCount(), 1);
  await fake.commands.get("goal:clear")!.handler("", ctx);
  assert.equal(timerCount(), 0, "idle 后节拍停止");
  assert.equal(fake.statuses.at(-1), undefined);
});

test("session_shutdown 停止节拍并清状态", async () => {
  const { fake } = boot();
  const ctx = fake.makeCtx();
  timers.clear();
  await fake.commands.get("goal")!.handler("任务", ctx);
  assert.equal(timerCount(), 1);
  await fake.handlers.get("session_shutdown")!({}, ctx);
  assert.equal(timerCount(), 0);
  assert.equal(fake.statuses.at(-1), undefined);
});

test("无 UI 不开节拍", async () => {
  const { fake } = boot();
  timers.clear();
  await fake.commands.get("goal")!.handler("任务", fake.makeCtx({ hasUI: false }));
  assert.equal(timerCount(), 0);
});

test("状态文本不变时 tick 不重复写（setStatus 指纹）", async () => {
  const fake = makeFakePi();
  createGoalExtension(fake.pi as unknown as ExtensionAPI, {
    evaluate: async () => ({ ok: true, met: false, reason: "尚未达成" }),
    nowMs: () => Date.parse("2026-08-05T12:00:00Z"),
  });
  const ctx = fake.makeCtx();
  timers.clear();
  await fake.commands.get("goal")!.handler("任务", ctx);
  const writes = fake.statuses.length;
  fireTick();
  fireTick();
  assert.equal(fake.statuses.length, writes, "固定时钟下文本不变 → 跳过 setStatus");
});

test("session_start 水合出 active：立即恢复节拍", async () => {
  const { fake } = boot({
    sessionEntries: [{ type: "custom", customType: GOAL_STATE_ENTRY, data: { goal: "历史目标" } }],
  });
  const ctx = fake.makeCtx();
  timers.clear();
  await fake.handlers.get("session_start")!({ reason: "resume" }, ctx);
  assert.equal(timerCount(), 1, "水合 active 后开启节拍");
  assert.ok(fake.statuses.at(-1)!.includes("历史目标"));
});
