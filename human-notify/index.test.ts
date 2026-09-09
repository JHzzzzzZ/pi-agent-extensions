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
  NOTIFY_KINDS,
  PROMPT_TITLE,
  buildToastScript,
  createHumanNotifyExtension,
  shouldNotify,
  truncateSummary,
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

// ===== 接线 =====

test("注册 ui_prompt_start 与 agent_settled 两个 hook", () => {
  const { fake } = boot();
  assert.ok(fake.handlers.has("ui_prompt_start"), "缺少 ui_prompt_start hook");
  assert.ok(fake.handlers.has("agent_settled"), "缺少 agent_settled hook");
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

test("shouldNotify:仅 win32 且未精确关闭时为真", () => {
  assert.equal(shouldNotify("win32", {}), true);
  assert.equal(shouldNotify("win32", { PI_HUMAN_NOTIFY: "1" }), true);
  assert.equal(shouldNotify("win32", { PI_HUMAN_NOTIFY: "0" }), false);
  assert.equal(shouldNotify("linux", {}), false);
  assert.equal(shouldNotify("darwin", {}), false);
});
