/**
 * btw 入口逻辑单测：直接调 `createBtwExtension` 并注入 deps / 结构 fake 的 ctx。
 *
 * 覆盖宿主事件路径之外的边界：超时看门狗、单飞（busy）、无模型、无 UI、会话
 * 切换重置、`/btw:model` 的解析与查找。真实加载（jiti 走 index.ts）+ 真实
 * ExtensionRunner + 真实命令上下文在 index-host.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createBtwExtension } from "../index.ts";

const MAIN_MODEL = { provider: "p", id: "main" };
const ALT_MODEL = { provider: "alt", id: "cheap" };

interface RegisteredCommand {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface Harness {
  commands: Map<string, RegisteredCommand>;
  handlers: Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void>>;
  run: (name: string, args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function makeHarness(deps: { timeoutMs?: number } = {}): Harness {
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void>>();
  const pi = {
    registerCommand: (name: string, options: RegisteredCommand) => {
      commands.set(name, options);
    },
    on: (event: string, handler: (e: unknown, c: ExtensionCommandContext) => Promise<void>) => {
      handlers.set(event, handler);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  createBtwExtension(pi, deps);
  return {
    commands,
    handlers,
    run: async (name, args, ctx) => {
      const command = commands.get(name);
      assert.ok(command, `命令 ${name} 必须已注册`);
      await command.handler(args, ctx);
    },
  };
}

interface CtxOptions {
  hasUI?: boolean;
  hasModel?: boolean;
  model?: unknown;
  entries?: unknown[];
  streamSimple?: (model: unknown, context: unknown, options: Record<string, unknown>) => AsyncIterable<unknown>;
  find?: (provider: string, id: string) => unknown;
}

function makeCtx(options: CtxOptions = {}): {
  ctx: ExtensionCommandContext;
  notifies: Array<{ message: string; type?: string }>;
} {
  const notifies: Array<{ message: string; type?: string }> = [];
  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: "rpc",
    model: options.hasModel === false ? undefined : (options.model ?? MAIN_MODEL),
    modelRegistry: {
      find:
        options.find ??
        ((provider: string, id: string) => (provider === ALT_MODEL.provider && id === ALT_MODEL.id ? ALT_MODEL : undefined)),
      streamSimple: options.streamSimple ?? (() => (async function* () {})()),
    },
    sessionManager: { buildContextEntries: () => options.entries ?? [], getSessionId: () => "sess-unit" },
    ui: {
      notify: (message: string, type?: string) => notifies.push({ message, type }),
    },
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, notifies };
}

function doneStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: "text_delta", delta: text };
    yield { type: "done", message: { content: [{ type: "text", text }] } };
  })();
}

function promptOf(context: unknown): string {
  return String((context as { messages: Array<{ content: unknown }> }).messages[0]!.content);
}

test("空参数：给用法提示，且不触发任何模型调用", async () => {
  const h = makeHarness();
  const { ctx, notifies } = makeCtx();
  await h.run("btw", "   ", ctx);
  assert.equal(notifies.length, 1);
  assert.match(notifies[0]!.message, /用法：\/btw <问题>/);
  assert.match(notifies[0]!.message, /btw:clear/);
});

test("提问超长：拒绝且不触发模型调用", async () => {
  const h = makeHarness();
  let called = 0;
  const { ctx, notifies } = makeCtx({
    streamSimple: () => {
      called += 1;
      return doneStream("x");
    },
  });
  await h.run("btw", "x".repeat(4001), ctx);
  assert.equal(called, 0);
  assert.match(notifies[0]!.message, /提问过长/);
  assert.equal(notifies[0]!.type, "warning");
});

test("无模型：明确提示不静默", async () => {
  const h = makeHarness();
  const { ctx, notifies } = makeCtx({ hasModel: false });
  await h.run("btw", "在干啥", ctx);
  assert.match(notifies[0]!.message, /没有可用模型/);
});

test("无 UI（print/json）：写 stderr 且零模型调用", async () => {
  const h = makeHarness();
  let called = 0;
  const { ctx } = makeCtx({
    hasUI: false,
    streamSimple: () => {
      called += 1;
      return doneStream("x");
    },
  });
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await h.run("btw", "在干啥", ctx);
  } finally {
    console.error = original;
  }
  assert.equal(called, 0, "没有 UI 就不花这次钱");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /没有可展示侧对话的 UI/);
});

test("RPC 降级通道：跑完 notify 答案，且答案进侧线程（下一轮带前文）", async () => {
  const h = makeHarness();
  const prompts: string[] = [];
  const { ctx, notifies } = makeCtx({
    streamSimple: (_model, context) => {
      prompts.push(promptOf(context));
      return doneStream("在做 X");
    },
  });
  await h.run("btw", "第一问", ctx);
  assert.equal(notifies.at(-1)!.message, "在做 X");
  await h.run("btw", "第二问", ctx);
  assert.match(prompts[1]!, /SIDE CHAT SO FAR/);
  assert.match(prompts[1]!, /Q: 第一问/);
  assert.match(prompts[1]!, /A: 在做 X/);
});

test("超时看门狗：provider 挂住也能有界结束并提示超时", async () => {
  const h = makeHarness({ timeoutMs: 20 });
  const { ctx, notifies } = makeCtx({
    streamSimple: () =>
      (async function* () {
        await new Promise(() => {}); // 永不产出、永不结束（也不理 signal）
      })(),
  });
  await h.run("btw", "在干啥", ctx);
  assert.match(notifies.at(-1)!.message, /超时/);
  assert.equal(notifies.at(-1)!.type, "warning");
});

test("单飞：上一个侧调用未结束时的第二次提问被拒绝且不产生第二次调用", async () => {
  const h = makeHarness();
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { ctx, notifies } = makeCtx({
    streamSimple: () => {
      calls += 1;
      return (async function* () {
        await gate;
        yield { type: "done", message: { content: [{ type: "text", text: "late" }] } };
      })();
    },
  });
  const first = h.run("btw", "第一问", ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await h.run("btw", "第二问", ctx);
  assert.equal(calls, 1);
  assert.match(notifies.at(-1)!.message, /还在跑/);
  release?.();
  await first;
});

test("session_start 清空侧线程（会话切换不带旧前文）", async () => {
  const h = makeHarness();
  const prompts: string[] = [];
  const { ctx } = makeCtx({
    streamSimple: (_model, context) => {
      prompts.push(promptOf(context));
      return doneStream("答");
    },
  });
  await h.run("btw", "第一问", ctx);
  await h.handlers.get("session_start")!({}, ctx);
  await h.run("btw", "第二问", ctx);
  assert.ok(!prompts[1]!.includes("SIDE CHAT SO FAR"));
});

test("会话重置发生在飞行中：旧调用落定不得写进新线程，也不放行并发第二单", async () => {
  const h = makeHarness();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const prompts: string[] = [];
  const { ctx, notifies } = makeCtx({
    streamSimple: (_model, context) => {
      prompts.push(promptOf(context));
      return (async function* () {
        await gate;
        yield { type: "done", message: { content: [{ type: "text", text: "旧答案" }] } };
      })();
    },
  });
  const first = h.run("btw", "旧问题", ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await h.handlers.get("session_start")!({}, ctx);
  await h.run("btw", "新问题", ctx);
  assert.equal(prompts.length, 1, "旧调用未落定前不放行并发第二单（单飞不被重置放行）");
  assert.match(notifies.at(-1)!.message, /还在跑/);
  release?.();
  await first;
  await h.run("btw", "新问题", ctx);
  assert.ok(!prompts[1]!.includes("SIDE CHAT SO FAR"), "旧轮次不得写进新会话的线程");
  assert.ok(!prompts[1]!.includes("旧答案"), "旧答案不得出现在新会话线程里");
});

test("/btw:model：无参数显示当前值；命中则覆盖；default 恢复跟随", async () => {
  const h = makeHarness();
  const models: unknown[] = [];
  const { ctx, notifies } = makeCtx({
    streamSimple: (model) => {
      models.push(model);
      return doneStream("答");
    },
  });
  await h.run("btw:model", "", ctx);
  assert.match(notifies.at(-1)!.message, /跟随主会话 p\/main/);
  await h.run("btw:model", "alt/cheap", ctx);
  assert.match(notifies.at(-1)!.message, /已切到 alt\/cheap/);
  await h.run("btw", "问", ctx);
  assert.equal(models.at(-1), ALT_MODEL);
  await h.run("btw:model", "default", ctx);
  await h.run("btw", "再问", ctx);
  assert.equal(models.at(-1), MAIN_MODEL);
});

test("/btw:model 输入非法或找不到模型：只提示不动状态", async () => {
  const h = makeHarness();
  const models: unknown[] = [];
  const { ctx, notifies } = makeCtx({
    streamSimple: (model) => {
      models.push(model);
      return doneStream("答");
    },
  });
  await h.run("btw:model", "没有斜杠", ctx);
  assert.match(notifies.at(-1)!.message, /格式应为/);
  await h.run("btw:model", "nope/missing", ctx);
  assert.match(notifies.at(-1)!.message, /找不到模型 nope\/missing/);
  await h.run("btw", "问", ctx);
  assert.equal(models.at(-1), MAIN_MODEL, "失败不改变模型（仍跟随主会话）");
});

test("/btw:clear：清空后下一轮不再带前文", async () => {
  const h = makeHarness();
  const prompts: string[] = [];
  const { ctx } = makeCtx({
    streamSimple: (_model, context) => {
      prompts.push(promptOf(context));
      return doneStream("答");
    },
  });
  await h.run("btw", "第一问", ctx);
  await h.run("btw:clear", "", ctx);
  await h.run("btw", "第二问", ctx);
  assert.ok(!prompts[1]!.includes("SIDE CHAT SO FAR"));
});
