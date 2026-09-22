/**
 * index.ts 接线测试：工具覆盖 + 命令面 + 会话生命周期（timeout-bg-todo#1）
 *
 * 边界说明：被测逻辑是"扩展如何接线到宿主"，因此 fake 的只有 pi API 表面
 * （事件/命令注册、sendMessage 记录）与进程边界（spawn），工具本体是宿主真实的
 * `createBashTool(..., { operations })` —— 超时路径确实走到宿主工具的错误渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTimeoutBgExtension } from "../index.ts";
import type { SpawnedProcess } from "../shell-ops.ts";

class FakeChild extends EventEmitter {
  pid = 9_001;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = null;
  emitData(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }
  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

interface SentMessage {
  message: { customType?: string; content?: unknown };
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

function makeFakePi(activeTools: string[]) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: SentMessage[] = [];
  const notices: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (text: string) => notices.push(text) } };

  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options);
    },
    getActiveTools: () => [...activeTools],
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const fire = async (event: string): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, reason: "quit" }, ctx);
  };
  const run = async (name: string, args = ""): Promise<void> => {
    const command = commands.get(name);
    assert.ok(command, `命令未注册：${name}`);
    await command.handler(args, ctx);
  };
  return { api, fire, run, tools, commands, sent, notices };
}

function makeExtension(activeTools: string[], env: Record<string, string> = {}, child = new FakeChild()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-bg-idx-"));
  const killCalls: number[] = [];
  const fakePi = makeFakePi(activeTools);
  const factory = createTimeoutBgExtension({
    env,
    spawn: ((file: string, args: readonly string[]) => {
      assert.equal(file, "bash");
      assert.equal(args[0], "-lc");
      return child as unknown as SpawnedProcess;
    }) as never,
    now: () => 1_000,
    killTree: (pid) => killCalls.push(pid),
    logRoot: path.join(dir, "bg-jobs"),
    shellConfig: () => ({ shell: "bash", args: ["-lc"] }),
  });
  factory(fakePi.api);
  return { ...fakePi, dir, killCalls, child };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 宿主工具读 ctx.sessionManager / ctx.model 注入 PI_* 环境变量，fake ctx 必须给全这几项。 */
function toolCtx(cwd: string): never {
  return {
    cwd,
    model: { provider: "fake-provider", id: "fake-model" },
    thinkingLevel: "medium",
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => null },
  } as never;
}

test("只覆盖当前启用的 shell 工具：active 里没有的工具不注册（不给用户凭空加工具）", async () => {
  const onlyBash = makeExtension(["bash"]);
  await onlyBash.fire("session_start");
  assert.deepEqual([...onlyBash.tools.keys()], ["bash"]);

  const both = makeExtension(["bash", "powershell"]);
  await both.fire("session_start");
  assert.deepEqual([...both.tools.keys()].sort(), ["bash", "powershell"]);
});

test("超时：工具以错误结束并给出日志路径；进程随后退出 → 收到 followUp 通知", async () => {
  const ext = makeExtension(["bash"]);
  await ext.fire("session_start");
  const tool = ext.tools.get("bash")!;
  const error = await tool
    .execute("call-1", { command: "sleep 400", timeout: 0.05 }, undefined, undefined, toolCtx(ext.dir))
    .then(
      () => null,
      (e: unknown) => e as Error,
    );
  assert.ok(error instanceof Error, "超时结束本次 tool call");
  assert.ok(error.message.includes(path.join(ext.dir, "bg-jobs")), "错误文本含日志路径");
  assert.deepEqual(ext.killCalls, [], "不杀进程");

  ext.child.exit(0);
  await wait(50);
  assert.equal(ext.sent.length, 1, "后台任务结束送一条 followUp");
  assert.equal(ext.sent[0]!.message.customType, "timeout-bg");
  assert.equal(ext.sent[0]!.options?.deliverAs, "followUp");
  assert.equal(ext.sent[0]!.options?.triggerTurn, true);
  assert.match(String(ext.sent[0]!.message.content), /退出码 0|exit code 0/);
});

test("命令面：/bg 列出后台任务，/bg:kill 杀进程树，/bg:clear 清已结束记录", async () => {
  const ext = makeExtension(["bash"]);
  await ext.fire("session_start");
  const tool = ext.tools.get("bash")!;
  await tool
    .execute("call-1", { command: "sleep 400", timeout: 0.05 }, undefined, undefined, toolCtx(ext.dir))
    .catch(() => undefined);

  await ext.run("bg");
  assert.equal(ext.notices.length, 1);
  assert.match(ext.notices[0]!, /bg-1/);
  assert.match(ext.notices[0]!, /running|运行中/);

  await ext.run("bg:kill", "bg-1");
  assert.deepEqual(ext.killCalls, [9_001]);
  assert.match(ext.notices.at(-1)!, /bg-1/);

  ext.child.exit(0);
  await wait(30);
  await ext.run("bg:clear");
  assert.match(ext.notices.at(-1)!, /清除|清理/);
  await ext.run("bg");
  assert.match(ext.notices.at(-1)!, /没有|空/);
});

test("session_shutdown：杀掉本会话遗留的后台任务", async () => {
  const ext = makeExtension(["bash"]);
  await ext.fire("session_start");
  await ext.tools
    .get("bash")!
    .execute("call-1", { command: "sleep 400", timeout: 0.05 }, undefined, undefined, toolCtx(ext.dir))
    .catch(() => undefined);
  await ext.fire("session_shutdown");
  assert.deepEqual(ext.killCalls, [9_001]);
});

test("非法 PI_TIMEOUT_BG_DEFAULT：启动时提示一次，回退默认值", async () => {
  const ext = makeExtension(["bash"], { PI_TIMEOUT_BG_DEFAULT: "oops" });
  await ext.fire("session_start");
  assert.equal(ext.notices.length, 1);
  assert.match(ext.notices[0]!, /PI_TIMEOUT_BG_DEFAULT/);
});
