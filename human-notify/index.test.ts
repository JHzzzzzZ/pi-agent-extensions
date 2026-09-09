/**
 * human-notify 扩展测试:node:test + assert/strict,全部使用手写 fake(spawn/平台/时钟),无网络。
 * 运行:node --experimental-strip-types --test human-notify/index.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { spawn as nodeSpawnType } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEBOUNCE_MS,
  DONE_TITLE,
  MAX_SUMMARY,
  MAX_SUMMARY_TAIL,
  NOTIFY_KINDS,
  PROMPT_TITLE,
  WAITING_TOOL_NAMES,
  buildToastScript,
  createHumanNotifyExtension,
  extractAssistantText,
  extractWaitingQuestion,
  shouldNotify,
  truncateSummary,
  truncateTailSummary,
} from "./index.ts";

// ===== 手写 fake =====

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: unknown;
}

function makeFakeSpawn(behavior: "ok" | "throw" = "ok") {
  const calls: SpawnCall[] = [];
  let unrefCalls = 0;
  const errorHandlers: Array<() => void> = [];
  const spawn = ((cmd: string, args: string[], opts: unknown) => {
    calls.push({ cmd, args, opts });
    if (behavior === "throw") throw new Error("spawn 炸了");
    return {
      unref: () => {
        unrefCalls += 1;
      },
      on: (event: string, listener: () => void) => {
        if (event === "error") errorHandlers.push(listener);
      },
    };
  }) as unknown as typeof nodeSpawnType;
  return { spawn, calls, errorHandlers, unrefCalls: () => unrefCalls };
}

function makeFakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
  };
  return { pi, handlers };
}

/** 固定时钟 2026-08-05T12:00:00Z,手动推进,便于断言防抖窗口 */
function makeClock() {
  let now = Date.parse("2026-08-05T12:00:00Z");
  return { nowMs: () => now, advance: (ms: number) => { now += ms; } };
}

function boot(options: { platform?: string; env?: Record<string, string | undefined>; spawnBehavior?: "ok" | "throw" } = {}) {
  const fake = makeFakePi();
  const spawned = makeFakeSpawn(options.spawnBehavior ?? "ok");
  const clock = makeClock();
  createHumanNotifyExtension(fake.pi as unknown as ExtensionAPI, {
    spawn: spawned.spawn,
    platform: options.platform ?? "win32",
    nowMs: clock.nowMs,
    env: options.env ?? {},
  });
  const ctx = {};
  return { fake, spawned, clock, ctx };
}

function firePrompt(fake: ReturnType<typeof makeFakePi>, kind: string, title?: string, ctx: unknown = {}) {
  return fake.handlers.get("ui_prompt_start")!({ type: "ui_prompt_start", reason: "ui_prompt", kind, title }, ctx);
}

function fireSettled(fake: ReturnType<typeof makeFakePi>, ctx: unknown = {}) {
  return fake.handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
}

function fireTool(fake: ReturnType<typeof makeFakePi>, toolName: string, args: unknown = {}, ctx: unknown = {}) {
  return fake.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "call_1", toolName, args }, ctx);
}

function fireMessageEnd(fake: ReturnType<typeof makeFakePi>, role: string, content: unknown, ctx: unknown = {}) {
  return fake.handlers.get("message_end")!({ type: "message_end", message: { role, content } }, ctx);
}

function fireSessionStart(fake: ReturnType<typeof makeFakePi>, ctx: unknown = {}) {
  return fake.handlers.get("session_start")!({ type: "session_start" }, ctx);
}

function lastScript(spawned: ReturnType<typeof makeFakeSpawn>): string {
  return (spawned.calls.at(-1)?.args.at(-1) ?? "") as string;
}

// ===== 接线 =====

test("注册 ui_prompt_start 与 agent_settled 两个 hook", () => {
  const { fake } = boot();
  assert.ok(fake.handlers.has("ui_prompt_start"), "缺少 ui_prompt_start hook");
  assert.ok(fake.handlers.has("agent_settled"), "缺少 agent_settled hook");
  assert.ok(fake.handlers.has("tool_execution_start"), "缺少 tool_execution_start hook");
});

// ===== win32 触发 =====

test("win32 + prompt 各 kind 均触发 spawn 且脚本含 Pi 等待你确认", async () => {
  for (const kind of NOTIFY_KINDS) {
    const { fake, spawned } = boot();
    await firePrompt(fake, kind, "请确认");
    assert.equal(spawned.calls.length, 1, `kind=${kind} 应触发一次`);
    const script = (spawned.calls[0].args.at(-1) ?? "") as string;
    assert.ok(script.includes(PROMPT_TITLE), `kind=${kind} 脚本应含标题`);
  }
});

test("win32 + 名单内等人工具触发 spawn 且脚本含 Pi 等待你确认", async () => {
  assert.ok((WAITING_TOOL_NAMES as readonly string[]).includes("plan_mode_question"), "名单应含 plan_mode_question");
  for (const toolName of WAITING_TOOL_NAMES) {
    const { fake, spawned } = boot();
    await fireTool(fake, toolName);
    assert.equal(spawned.calls.length, 1, `tool=${toolName} 应触发一次`);
    const script = (spawned.calls[0].args.at(-1) ?? "") as string;
    assert.ok(script.includes(PROMPT_TITLE), `tool=${toolName} 脚本应含标题`);
  }
});

test("非名单工具零 spawn 且不消耗防抖窗口", async () => {
  const { fake, spawned } = boot();
  for (const toolName of ["bash", "read", "edit", "subagent", "todo"]) {
    await fireTool(fake, toolName);
  }
  assert.equal(spawned.calls.length, 0, "非名单工具应零调用");
  await fireTool(fake, "plan_mode_question");
  assert.equal(spawned.calls.length, 1, "防抖窗口不应被非名单工具消耗,名单命中应立即发送");
});

test("等人工具同样受平台门控与一键关闭约束", async () => {
  const offPlatform = boot({ platform: "linux" });
  await fireTool(offPlatform.fake, "plan_mode_question");
  assert.equal(offPlatform.spawned.calls.length, 0);
  const killed = boot({ env: { PI_HUMAN_NOTIFY: "0" } });
  await fireTool(killed.fake, "plan_mode_question");
  assert.equal(killed.spawned.calls.length, 0);
});

test("win32 + agent_settled 触发 Pi 任务完成", async () => {
  const { fake, spawned } = boot();
  await fireSettled(fake);
  assert.equal(spawned.calls.length, 1);
  const script = (spawned.calls[0].args.at(-1) ?? "") as string;
  assert.ok(script.includes(DONE_TITLE));
});

test("spawn 形态:powershell.exe + Hidden + detached/ignore + unref 不持有会话", async () => {
  const { fake, spawned } = boot();
  await fireSettled(fake);
  assert.equal(spawned.calls.length, 1);
  const call = spawned.calls[0];
  assert.equal(call.cmd, "powershell.exe");
  assert.ok(call.args.includes("-Command"), "应经 -Command 传入脚本");
  assert.ok(call.args.includes("Hidden"), "应隐藏窗口");
  const opts = call.opts as { detached?: boolean; stdio?: string };
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, "ignore");
  assert.equal(spawned.unrefCalls(), 1, "应 unref,不持有会话资源");
  assert.equal(spawned.errorHandlers.length, 1, "应注册 noop error 监听防未捕获抛错");
});

// ===== no-op 路径 =====

test("非 win32 全 no-op:prompt 与 settled 均零 spawn", async () => {
  for (const platform of ["linux", "darwin"]) {
    const { fake, spawned } = boot({ platform });
    await firePrompt(fake, "confirm", "请确认");
    await fireSettled(fake);
    assert.equal(spawned.calls.length, 0, `platform=${platform} 应零调用`);
  }
});

test("PI_HUMAN_NOTIFY=0 全 no-op:prompt 与 settled 均零 spawn", async () => {
  const { fake, spawned } = boot({ env: { PI_HUMAN_NOTIFY: "0" } });
  await firePrompt(fake, "confirm", "请确认");
  await fireSettled(fake);
  assert.equal(spawned.calls.length, 0);
});

test("未知 prompt kind 不触发", async () => {
  const { fake, spawned } = boot();
  await firePrompt(fake, "banner", "横幅");
  assert.equal(spawned.calls.length, 0);
});

// ===== 异常隔离 =====

test("spawn 同步抛错不向外抛、不破坏会话", async () => {
  const { fake, spawned, clock } = boot({ spawnBehavior: "throw" });
  await fireSettled(fake);
  assert.equal(spawned.calls.length, 1, "仍尝试派生一次");
  // 防抖计时已推进的反证:窗口内再次触发不再尝试派生(而非每次都抛)
  clock.advance(DEBOUNCE_MS);
  await fireSettled(fake);
  assert.equal(spawned.calls.length, 2);
});

test("子进程 error 事件被静默吞掉", async () => {
  const { fake, spawned } = boot();
  await fireSettled(fake);
  assert.equal(spawned.errorHandlers.length, 1);
  spawned.errorHandlers[0](); // 若未处理会抛,能执行到此即通过
});

// ===== 防抖 =====

test("5s 内重复事件去重,窗口外恢复", async () => {
  const { fake, spawned, clock } = boot();
  await firePrompt(fake, "confirm", "请确认删除");
  await fireSettled(fake); // 紧随其后的 settle 应被去重
  assert.equal(spawned.calls.length, 1);
  clock.advance(DEBOUNCE_MS - 1);
  await fireSettled(fake);
  assert.equal(spawned.calls.length, 1, "窗口内仍去重");
  clock.advance(1); // 恰好走出窗口
  await fireSettled(fake);
  assert.equal(spawned.calls.length, 2, "窗口外恢复发送");
  const second = (spawned.calls[1].args.at(-1) ?? "") as string;
  assert.ok(second.includes(DONE_TITLE));
});

// ===== 截断与安全 =====

test("truncateSummary:超长截断到 120 并追加 …,多行压单行", () => {
  assert.equal(truncateSummary("abc"), "abc");
  assert.equal(truncateSummary("x".repeat(MAX_SUMMARY)), "x".repeat(MAX_SUMMARY));
  const long = truncateSummary("y".repeat(MAX_SUMMARY + 50));
  assert.equal(Array.from(long).length, MAX_SUMMARY);
  assert.ok(long.endsWith("…"));
  assert.equal(truncateSummary("第一行\n第二行\r\n第三行"), "第一行 第二行 第三行");
  assert.equal(truncateSummary("  两端空格  "), "两端空格");
});

test("正文截断:超长标题 Toast 仍受 120 约束", async () => {
  const { fake, spawned } = boot();
  await firePrompt(fake, "confirm", "超长标题".repeat(60));
  assert.equal(spawned.calls.length, 1);
  const script = (spawned.calls[0].args.at(-1) ?? "") as string;
  assert.ok(!script.includes("超长标题".repeat(60)), "不应透传完整超长原文");
  assert.ok(script.includes("…"), "应有截断标记");
});

test("buildToastScript:加载 WinRT 双程序集并用 ::new 构造(真机验证过的形态)", () => {
  const script = buildToastScript(PROMPT_TITLE, "正文");
  assert.ok(script.includes("Windows.UI.Notifications, ContentType=WindowsRuntime"), "应加载通知程序集");
  assert.ok(script.includes("Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime"), "应加载 XML 程序集");
  assert.ok(script.includes("[Windows.UI.Notifications.ToastNotification]::new($xml)"), "应用 ::new 构造(Windows PowerShell 5.1 下 New-Object 无法绑定该构造)");
  assert.ok(script.includes("CreateToastNotifier"), "应经 ToastNotifier 发送");
});

test("buildToastScript:XML 元字符被转义,不透传原始尖括号", () => {
  const script = buildToastScript(PROMPT_TITLE, "<script>alert(1)</script> & \"引用\"");
  assert.ok(script.includes(PROMPT_TITLE));
  assert.ok(!script.includes("<script>"), "不应透传原始尖括号");
  assert.ok(script.includes("&lt;script&gt;"), "应转义尖括号");
  assert.ok(script.includes("&amp;"), "应转义 &");
  assert.ok(!script.includes("\n") || script.length > 0, "脚本为单次 -Command 参数");
});

// ===== 差异化通知:纯函数 =====

test("extractAssistantText:拼接 text 块,忽略 thinking/非文本块,非数组返回空", () => {
  const content = [
    { type: "thinking", thinking: "内心独白不应出现" },
    { type: "text", text: "第一段" },
    { type: "toolResult", content: "工具输出不应出现" },
    { type: "text", text: "第二段" },
    { type: "text", text: "   " },
  ];
  assert.equal(extractAssistantText(content), "第一段\n\n第二段");
  assert.equal(extractAssistantText("不是数组"), "");
  assert.equal(extractAssistantText([{ type: "text", text: 42 }]), "");
});

test("extractWaitingQuestion:plan_mode_question 取 questions[0].question,其余形态回退 undefined", () => {
  assert.equal(extractWaitingQuestion("plan_mode_question", { questions: [{ question: "选哪个方案？" }] }), "选哪个方案？");
  assert.equal(extractWaitingQuestion("plan_mode_question", { questions: [{ question: "   " }] }), undefined);
  assert.equal(extractWaitingQuestion("plan_mode_question", { questions: [{ question: 42 }] }), undefined);
  assert.equal(extractWaitingQuestion("plan_mode_question", { questions: [] }), undefined);
  assert.equal(extractWaitingQuestion("plan_mode_question", { questions: "nope" }), undefined);
  assert.equal(extractWaitingQuestion("plan_mode_question", null), undefined);
  assert.equal(extractWaitingQuestion("plan_mode_question", {}), undefined);
  assert.equal(extractWaitingQuestion("bash", { questions: [{ question: "不该提取" }] }), undefined);
});

test("truncateTailSummary:按码点截到 80 并追加 …,多行压单行", () => {
  assert.equal(truncateTailSummary("短的"), "短的");
  const long = truncateTailSummary("z".repeat(MAX_SUMMARY_TAIL + 30));
  assert.equal(Array.from(long).length, MAX_SUMMARY_TAIL);
  assert.ok(long.endsWith("…"));
  assert.equal(truncateTailSummary("第一行\n第二行"), "第一行 第二行");
});

// ===== 差异化通知:缓存与正文 =====

test("message_end(assistant)更新缓存:settle 正文含本轮结论摘要", () => {
  const { fake, spawned } = boot();
  fireMessageEnd(fake, "assistant", [{ type: "text", text: "已修复 3 个测试" }]);
  fireSettled(fake);
  assert.equal(spawned.calls.length, 1);
  assert.ok(lastScript(spawned).includes("本轮结论：已修复 3 个测试"), "settle 正文应含摘要");
});

test("message_end:多段 text 拼接进摘要,thinking 块不透传", () => {
  const { fake, spawned } = boot();
  fireMessageEnd(fake, "assistant", [
    { type: "thinking", thinking: "秘密推理" },
    { type: "text", text: "全部通过" },
  ]);
  fireSettled(fake);
  const script = lastScript(spawned);
  assert.ok(script.includes("本轮结论：全部通过"));
  assert.ok(!script.includes("秘密推理"), "thinking 不应透传");
});

test("message_end:user/无 text 块不更新缓存", () => {
  const { fake, spawned } = boot();
  fireMessageEnd(fake, "user", [{ type: "text", text: "用户消息不算结论" }]);
  fireMessageEnd(fake, "assistant", [{ type: "thinking", thinking: "只有思考没有正文" }]);
  fireSettled(fake);
  assert.equal(spawned.calls.length, 1);
  assert.ok(lastScript(spawned).includes("Agent 运行已结束"), "缓存为空应回退静态模板");
});

test("session_start 重置摘要缓存,不跨会话泄漏", () => {
  const { fake, spawned } = boot();
  fireMessageEnd(fake, "assistant", [{ type: "text", text: "上一轮结论" }]);
  fireSessionStart(fake);
  fireSettled(fake);
  assert.ok(lastScript(spawned).includes("Agent 运行已结束"), "重置后应回退静态模板");
});

test("审批通知正文含 assistant 尾部摘要;缓存为空回退现模板", () => {
  const withCache = boot();
  fireMessageEnd(withCache.fake, "assistant", [{ type: "text", text: "需要你确认删除范围" }]);
  firePrompt(withCache.fake, "confirm", "请确认");
  assert.equal(withCache.spawned.calls.length, 1);
  assert.ok(lastScript(withCache.spawned).includes("收到确认请求，请回到终端处理：需要你确认删除范围"));

  const empty = boot();
  firePrompt(empty.fake, "confirm", "请确认");
  assert.ok(lastScript(empty.spawned).includes("收到确认请求，请回到终端处理：请确认"), "无缓存回退现标题后缀模板");
});

test("等人工具:args 有 question 用问题文本", () => {
  const { fake, spawned } = boot();
  fireTool(fake, "plan_mode_question", { questions: [{ question: "选 A 还是 B？" }] });
  assert.equal(spawned.calls.length, 1);
  assert.ok(lastScript(spawned).includes("收到问题，请回到终端处理：选 A 还是 B？"));
});

test("等人工具:args 缺失/非 string 回退 assistant 尾部", () => {
  const fromArgs = boot();
  fireMessageEnd(fromArgs.fake, "assistant", [{ type: "text", text: "计划已就绪" }]);
  fireTool(fromArgs.fake, "plan_mode_question", { questions: [{ question: 42 }] });
  assert.equal(fromArgs.spawned.calls.length, 1);
  assert.ok(lastScript(fromArgs.spawned).includes("收到问题，请回到终端处理：计划已就绪"));
});

test("等人工具:args 与缓存皆空回退现静态正文", () => {
  const { fake, spawned } = boot();
  fireTool(fake, "plan_mode_question");
  assert.equal(spawned.calls.length, 1);
  assert.ok(lastScript(spawned).includes("收到问题，请回到终端处理"));
  assert.ok(!lastScript(spawned).includes("：收到"), "不应出现空摘要残留");
});

test("settle 缓存为空回退 DONE 静态正文", () => {
  const { fake, spawned } = boot();
  fireSettled(fake);
  assert.ok(lastScript(spawned).includes("Agent 运行已结束"));
  assert.ok(!lastScript(spawned).includes("本轮结论"));
});

test("摘要超长:先截到 80 码点,正文整体仍受 120 约束", () => {
  const { fake, spawned } = boot();
  fireMessageEnd(fake, "assistant", [{ type: "text", text: "长".repeat(200) }]);
  fireSettled(fake);
  const script = lastScript(spawned);
  assert.ok(script.includes("…"), "摘要应有截断标记");
  assert.ok(!script.includes("长".repeat(85)), "摘要不应超过 80 码点");
});

test("摘要照旧 XML 转义,不透传原始尖括号", () => {
  const { fake, spawned } = boot();
  fireTool(fake, "plan_mode_question", { questions: [{ question: "<b>加粗</b> & \"引号\"?" }] });
  const script = lastScript(spawned);
  assert.ok(script.includes("&lt;b&gt;加粗&lt;/b&gt; &amp; &quot;引号&quot;?"));
  assert.ok(!script.includes("<b>"));
});

test("shouldNotify:仅 win32 且未精确关闭时为真", () => {
  assert.equal(shouldNotify("win32", {}), true);
  assert.equal(shouldNotify("win32", { PI_HUMAN_NOTIFY: "1" }), true);
  assert.equal(shouldNotify("win32", { PI_HUMAN_NOTIFY: "0" }), false);
  assert.equal(shouldNotify("linux", {}), false);
  assert.equal(shouldNotify("darwin", {}), false);
});
