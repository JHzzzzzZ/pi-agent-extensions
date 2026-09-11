/**
 * agent-team — widget 生命周期宿主接线（数据驱动挂载/卸载 + 事件刷新）
 *
 * 前车之鉴（repo 约定：宿主/进程边界上"纸面正确"的纯函数测试抓不住真问题）：
 * widget 的挂载不变量与刷新触发都在 index.ts 的接线层——纯投影/reducer 测试
 * 绿不代表派单后亮块真的出现、落定后真的消失。本文件用假 ExtensionAPI +
 * 假 ctx.ui（记录 setWidget 帧/onTerminalInput handler/getEditorText）+ 脚本化
 * fake leader 子进程把真实 entry 接起来，锁定：
 * ① session_start 无 run 也挂 controller（factory 一次），但不推帧；
 * ② 派单 → 立即推折叠帧（不等 1s tick）；展开后 leader 事件到达 → 同步推树帧；
 * ③ run 落定 → 自动推 undefined 卸载；
 * ④ 链式派单（viewer 排队消息）间隙不闪卸载——refreshWidget 在
 *    chat.onRunFinalized 之后，新 run 已 claim，帧序列里没有 undefined。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import { WIDGET_ID } from "../types.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { fixtureTeam } from "./fixtures.ts";
import {
  makeFakeSpawn,
  messageEndLine,
  sleep,
  toolExecutionStartLine,
  waitForChild,
  type FakeSpawnHandle,
  isolateRunsDir,
} from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function fakePi() {
  const tools = new Map<string, unknown>();
  const commands = new Map<string, { handler: (args: unknown, ctx: unknown) => Promise<unknown> }>();
  const handlers = new Map<string, Handler[]>();
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  return {
    tools,
    commands,
    sentMessages,
    appendedEntries,
    registerTool: (tool: { name: string }): void => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: { handler: (args: unknown, ctx: unknown) => Promise<unknown> }): void => {
      commands.set(name, command);
    },
    registerEntryRenderer: (): void => {},
    appendEntry: (type: string, data: unknown) => {
      appendedEntries.push({ type, data });
      return {};
    },
    sendMessage: (message: unknown, options?: unknown) => {
      sentMessages.push({ message, options });
      return {};
    },
    on: (event: string, handler: Handler): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async fire(event: string, ctx: unknown): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
  };
}

interface Capture {
  factoryCalls: number;
  frames: Array<string[] | undefined>;
  inputHandlers: Array<(data: string) => { consume?: boolean } | undefined>;
  notifications: Array<{ text: string; level?: string }>;
  /** Viewer overlays opened via /team:view 或 widget enter（真实 TranscriptViewer 实例）。 */
  viewerComponents: Array<{ render: (width: number) => string[] }>;
  customCalls: number;
}

function editorShape(): Record<string, unknown> {
  return { render: () => [], invalidate: () => {}, handleInput: () => {}, getText: () => "", setText: () => {} };
}

function widgetCapture(): Capture {
  return { factoryCalls: 0, frames: [], inputHandlers: [], notifications: [], viewerComponents: [], customCalls: 0 };
}

function sessionCtx(cwd: string, capture: Capture) {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: (): boolean => true,
    ui: {
      theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
      notify: (text: string, level?: string) => capture.notifications.push({ text, level }),
      getEditorText: (): string => "",
      setWidget: (_key: string, content: unknown): void => {
        if (typeof content === "function") {
          capture.factoryCalls += 1;
          // 宿主把 factory 同步调用并传入 TUI；假 TUI 提供编辑器形状焦点。
          (content as (tui: unknown) => unknown)({ focusedComponent: editorShape() });
          return;
        }
        capture.frames.push(content as string[] | undefined);
      },
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined): (() => void) => {
        capture.inputHandlers.push(handler);
        return () => {};
      },
      custom: (...args: unknown[]): Promise<unknown> => {
        capture.customCalls += 1;
        const factory = args[0] as (tui: unknown, theme: unknown, keybindings: unknown, done: (r: unknown) => void) => unknown;
        capture.viewerComponents.push(
          factory({}, { fg: (_c: string, t: string) => t }, undefined, () => {}) as { render: (width: number) => string[] },
        );
        return new Promise<unknown>(() => {}); // overlay 常开不关
      },
    },
    sessionManager: { getEntries: (): unknown[] => [] },
  };
}

interface Host {
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  capture: Capture;
  ctx: ReturnType<typeof sessionCtx>;
  cleanup: () => Promise<void>;
}

async function setupHost(teamName = "proj-team"): Promise<Host> {
  resetDoubleLoadGuardForTests();
  const runsDir = isolateRunsDir();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-widget-lifecycle-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".pi", "teams", `${teamName}.md`),
    serializeTeam(fixtureTeam({ name: teamName, description: "生命周期观测团队", filePath: "", notes: undefined })),
  );
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const capture = widgetCapture();
  const ctx = sessionCtx(projectDir, capture);
  await pi.fire("session_start", ctx);
  return {
    pi,
    spawn,
    capture,
    ctx,
    cleanup: async () => {
      await pi.fire("session_shutdown", ctx);
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(runsDir, { recursive: true, force: true });
      delete process.env.PI_AGENT_TEAM_RUNS_DIR;
      resetDoubleLoadGuardForTests();
    },
  };
}

async function dispatch(host: Host, task: string): Promise<void> {
  const run = host.pi.tools.get("team_run") as unknown as {
    execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<unknown>;
  };
  const started = (await run.execute("call-run", { team: "proj-team", task }, undefined, undefined, host.ctx)) as { isError?: boolean };
  assert.notEqual(started.isError, true, "派单应成功");
}

const lastFrame = (capture: Capture): string[] | undefined => capture.frames.at(-1);

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) await sleep(5);
}

test("session_start 无 run：controller 已挂载（factory 一次）但不推帧", async () => {
  const host = await setupHost();
  try {
    assert.equal(host.capture.factoryCalls, 1, "会话启动即挂载 controller（TUI + 未禁用）");
    assert.ok(host.capture.frames.every((frame) => frame === undefined), "无活跃 run 不推亮块帧（仅 session_start 清理帧）");
  } finally {
    await host.cleanup();
  }
});

test("派单立即推折叠帧；展开后 leader 事件同步刷新成员树（事件驱动，不等 1s tick）", async () => {
  const host = await setupHost();
  try {
    await dispatch(host, "修复登录 bug");
    assert.deepEqual(lastFrame(host.capture)?.map((line) => line.trimEnd()), ["agent-team proj-team · ↓/← 查看详情"], "派单后立即出折叠帧");

    const child = await waitForChild(host.spawn, 0);
    assert.equal(host.capture.inputHandlers.length, 1, "onTerminalInput 已接线");
    assert.equal(host.capture.inputHandlers[0]!("\x1b[B")?.consume, true, "空编辑器 + 编辑器焦点 → ↓ 激活");
    const expanded = lastFrame(host.capture)!;
    assert.equal(expanded[0]?.trimEnd(), "▸ main");
    assert.match(expanded[1]!, /leader proj-team · 修复登录 bug ▶ running/);
    assert.match(expanded[2]!, /^\s+├─ frontend · queued\s*$/);
    assert.match(expanded[3]!, /^\s+╰─ backend · queued\s*$/);
    assert.equal(expanded.length, 5, "树行 4（main/leader/2 成员）+ 底部提示行 1；任务摘要已在 leader 行");

    // leader 派发事件 → coordinator render → refreshWidget 同步推帧（无 1s 等待）。
    child.emitLine(JSON.stringify({ type: "tool_execution_start", toolName: "team_dispatch", args: { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] } }));
    const afterEvent = lastFrame(host.capture)!;
    assert.equal(afterEvent[0]?.trimEnd(), "▸ main");
    assert.match(afterEvent[2]!, /^\s+├─ frontend ● running\s*$/);
    assert.match(afterEvent[3]!, /^\s+╰─ backend ● running\s*$/);
  } finally {
    await host.cleanup();
  }
});

test("run 落定：自动推 undefined 卸载亮块（无终态行常驻）", async () => {
  const host = await setupHost();
  try {
    await dispatch(host, "跑完");
    const child = await waitForChild(host.spawn, 0);
    const dispatchAt = host.capture.frames.findIndex(Array.isArray);
    assert.ok(dispatchAt >= 0, "运行中亮块帧存在");

    child.autoRespond(
      [
        messageEndLine("assistant", {
          content: [{ type: "text", text: "FINAL REPORT" }],
          usage: { input: 10, output: 5, cost: { total: 0.01 }, totalTokens: 15 },
        }),
      ],
      0,
      5,
    );
    await waitFor(() => host.pi.sentMessages.length > 0);
    assert.equal(lastFrame(host.capture), undefined, "落定帧为 setWidget(undefined)");
    assert.equal(
      host.capture.frames.slice(dispatchAt).filter((frame) => frame === undefined).length,
      1,
      "卸载帧只推一次（数据驱动卸载）",
    );
  } finally {
    await host.cleanup();
  }
});

test("成员行 enter 直达查看器并定位该成员（末行恒为成员，无任务行假成员陷阱）", async () => {
  const host = await setupHost();
  try {
    await dispatch(host, "修复登录 bug");
    await waitForChild(host.spawn, 0);

    const handler = host.capture.inputHandlers[0]!;
    handler("\x1b[B"); // 激活：cursor 0 = main
    handler("\x1b[B"); // cursor 1 = leader
    handler("\x1b[B"); // cursor 2 = frontend 成员行
    assert.match(lastFrame(host.capture)!.find((line) => line.startsWith("▸")) ?? "", /frontend/, "光标停在成员行");
    handler("\r");

    assert.equal(host.capture.customCalls, 1, "成员行 enter 应打开查看器");
    const frame = host.capture.viewerComponents[0]!.render(120).join("\n");
    assert.match(frame, /›.*frontend · frontend/, "roster 选中项应为该成员");
    assert.match(frame, /成员: frontend/, "右栏元信息头应定位该成员");
  } finally {
    await host.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 链式派单不闪卸载（viewer 排队消息 → run 落定 → 新 run 立即接上）
// ---------------------------------------------------------------------------

type ViewerComponentLike = { handleInput: (data: string) => void };

function closableViewCtx() {
  let viewerComponent: ViewerComponentLike | undefined;
  let resolveCustom: ((value: unknown) => void) | undefined;
  const ui = {
    notify: (): void => {},
    theme: { fg: (_c: string, t: string) => t },
    custom: (...args: unknown[]): Promise<unknown> => {
      const factory = args[0] as (tui: unknown, theme: unknown, keybindings: unknown, done: (r: unknown) => void) => unknown;
      viewerComponent = factory({}, { fg: (_c: string, t: string) => t }, undefined, (r) => resolveCustom?.(r)) as never;
      return new Promise<unknown>((resolve) => {
        resolveCustom = resolve;
      });
    },
  };
  return {
    ctx: { hasUI: true, mode: "tui", ui },
    component: (): ViewerComponentLike => {
      assert.ok(viewerComponent, "viewer 组件应已实例化");
      return viewerComponent!;
    },
    close: (): void => {
      assert.ok(viewerComponent, "关闭前应已有 viewer 组件实例");
      viewerComponent!.handleInput("\x03");
    },
  };
}

test("链式派单间隙不闪卸载：refreshWidget 在 chat.onRunFinalized 之后（新 run 已 claim）", async () => {
  const host = await setupHost("chat-team");
  try {
    const run = host.pi.tools.get("team_run") as unknown as {
      execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<unknown>;
    };
    const started = (await run.execute("call-run", { team: "chat-team", task: "首轮" }, undefined, undefined, host.ctx)) as { isError?: boolean };
    assert.notEqual(started.isError, true);
    const first = await waitForChild(host.spawn, 0);

    // viewer 中选定成员并排队一条消息（成员无 steer 通道 → run 运行中入队）。
    const view = host.pi.commands.get("team:view");
    assert.ok(view);
    const closable = closableViewCtx();
    void view.handler("", closable.ctx as never);
    await sleep(30);
    const viewer = closable.component();
    viewer.handleInput("j");
    viewer.handleInput("m");
    viewer.handleInput("你");
    viewer.handleInput("好");
    viewer.handleInput("\r");
    assert.equal(host.spawn.records.length, 1, "排队期间不派新 run");

    // 关闭 viewer（恢复亮块），记下恢复后的帧位置。
    closable.close();
    await sleep(30);
    await waitFor(() => Array.isArray(lastFrame(host.capture)));
    const mark = host.capture.frames.length;

    first.emitClose(0); // 首 run 落定（completed）→ 链式派出排队的消息
    await waitFor(() => host.spawn.records.length >= 2);
    await sleep(30);
    assert.ok(
      host.capture.frames.slice(mark).every((frame) => Array.isArray(frame)),
      `链式派单间隙不得出现卸载帧，实得 ${JSON.stringify(host.capture.frames.slice(mark))}`,
    );
    assert.match(
      String(JSON.parse(host.spawn.children[1]?.writes[0] ?? "{}").message ?? ""),
      /你好/,
      "排队的消息经链式派单送达第二个 run",
    );
  } finally {
    await host.cleanup();
  }
});
