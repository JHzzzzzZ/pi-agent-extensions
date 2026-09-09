/**
 * agent-team — viewer 打开互斥（host 接线层行为测试）
 *
 * 真机堆叠的另一半根因：互斥缺失时，连点 enter（widget confirm）或开
 * 着 viewer 又敲 /team:view 会叠出第二个 overlay；两个实例几何稍有偏
 * 差即互相露边（见 viewer-host.test.ts 头注与 zz 机制验证：双实例在
 * 真实合成器里稳定复现出 2 标题/2 页签/2 底边）。本文件用假
 * ExtensionAPI + 假 ctx 把 cockpit 接起来，断言第二次进入不开新
 * overlay（`openViewer` early-return）。
 */

import * as assert from "node:assert/strict";
import * as os from "node:os";
import { test } from "node:test";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { RUN_ENTRY_TYPE } from "../types.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function fakePi() {
  const tools = new Map<string, unknown>();
  const commands = new Map<string, { handler: (args: unknown, ctx: unknown) => Promise<unknown> }>();
  const handlers = new Map<string, Handler[]>();
  return {
    tools,
    commands,
    registerTool: (tool: { name: string }): void => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: { handler: (args: unknown, ctx: unknown) => Promise<unknown> }): void => {
      commands.set(name, command);
    },
    registerEntryRenderer: (): void => {},
    on: (event: string, handler: Handler): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async fire(event: string, ctx: unknown): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
  };
}

function hydratedSessionCtx() {
  return {
    cwd: os.tmpdir(),
    hasUI: true,
    mode: "tui",
    isProjectTrusted: (): boolean => false,
    ui: {
      setWidget: (): void => {},
      notify: (): void => {},
      theme: { fg: (_color: string, text: string): string => text },
    },
    sessionManager: {
      getEntries: (): unknown[] => [
        {
          type: "custom",
          customType: RUN_ENTRY_TYPE,
          data: {
            runId: "run-1",
            team: "count-duet",
            task: "从1数到10",
            startedAt: "2026-09-06T12:00:00Z",
            finishedAt: "2026-09-06T12:01:25Z",
            status: "completed",
            members: [],
            totalCost: 0,
            totalTokens: 0,
          },
        },
      ],
    },
  };
}

test("team:view 互斥：viewer 打开期间再进入不开第二个 overlay", async () => {
  resetDoubleLoadGuardForTests();
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  process.env.PI_AGENT_TEAM_WIDGET = "0"; // 本用例不测 widget：跳过它的 1s 真定时器
  try {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    await pi.fire("session_start", hydratedSessionCtx());

    const customCalls: unknown[][] = [];
    const viewCtx = {
      hasUI: true,
      mode: "tui",
      ui: {
        notify: (): void => {},
        theme: { fg: (_color: string, text: string): string => text },
        custom: (...args: unknown[]): Promise<unknown> => {
          customCalls.push(args);
          return new Promise<unknown>(() => {}); // overlay 常开不关
        },
      },
    };
    const view = pi.commands.get("team:view");
    assert.ok(view, "cockpit 应注册 /team:view");

    void view.handler("", viewCtx as never); // 第一次：打开 overlay（pending，不 await）
    // 第二次：互斥应让它在短时间内直接返回。若互斥缺失，第二次会真的再
    // 开一个永不关闭的 overlay 并永久 await——race 超时让旧行为快速失败
    // 而不是把测试套件挂死（旧版实测挂 300s）。
    await Promise.race([
      view.handler("", viewCtx as never),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("互斥缺失：第二个 viewer 调用未在 500ms 内返回（= 双 overlay 永久打开）")), 500),
      ),
    ]);
    assert.equal(customCalls.length, 1, "第二个 viewer 不得调用 ui.custom");
    assert.equal(customCalls[0]?.length, 2, "overlay 调用保持 (factory, { overlay, overlayOptions }) 形状");
  } finally {
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
    resetDoubleLoadGuardForTests();
  }
});

// ---------------------------------------------------------------------------
// Slice 6：接线语义集成锁（真实 openViewer/ensureRunWidget + fake ctx.ui）
// ---------------------------------------------------------------------------
// 防重影核心：① viewer 打开 → widget 隐藏（setWidget(undefined) 先于 custom）；
// ② 关闭 → widget 恢复并立即重绘一次；③ 打开期间再进入 → custom 只进一次。

/** 带记录 setWidget 的 session ctx（widget 挂载 + 隐藏/恢复都走这里）。 */
function widgetSessionCtx(timeline: string[]) {
  return {
    cwd: os.tmpdir(),
    hasUI: true,
    mode: "tui",
    isProjectTrusted: (): boolean => false,
    ui: {
      setWidget: (_key: string, lines: string[] | undefined): void => {
        timeline.push(lines === undefined ? "hide" : "draw");
      },
      notify: (): void => {},
      theme: { fg: (_color: string, text: string): string => text },
    },
    sessionManager: {
      getEntries: (): unknown[] => [
        {
          type: "custom",
          customType: RUN_ENTRY_TYPE,
          data: {
            runId: "run-1",
            team: "count-duet",
            task: "从1数到10",
            startedAt: "2026-09-06T12:00:00Z",
            finishedAt: "2026-09-06T12:01:25Z",
            status: "completed",
            members: [],
            totalCost: 0,
            totalTokens: 0,
          },
        },
      ],
    },
  };
}

type ViewerComponentLike = { handleInput: (data: string) => void };

/**
 * 可关闭的 /team:view ctx：custom 捕获真实 TranscriptViewer 实例 + done
 * 回调；测试经 component.handleInput("\x03") 关闭 overlay，驱动 openViewer
 * 的 finally（widget 恢复）完整跑完。
 */
function closableViewCtx(opts: { timeline?: string[]; customCalls?: unknown[][] }) {
  const timeline = opts.timeline ?? [];
  const customCalls = opts.customCalls ?? [];
  let viewerComponent: ViewerComponentLike | undefined;
  let resolveCustom: ((v: unknown) => void) | undefined;
  const ui = {
    notify: (): void => {},
    theme: { fg: (_color: string, text: string): string => text },
    custom: (...args: unknown[]): Promise<unknown> => {
      customCalls.push(args);
      timeline.push("custom");
      const factory = args[0] as (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (r: unknown) => void,
      ) => unknown;
      viewerComponent = factory({}, { fg: (_c: string, t: string) => t }, undefined, (r) => resolveCustom?.(r)) as never;
      return new Promise<unknown>((resolve) => {
        resolveCustom = resolve;
      });
    },
  };
  return {
    ctx: { hasUI: true, mode: "tui", ui },
    close: (): void => {
      assert.ok(viewerComponent, "关闭前应已有 viewer 组件实例");
      viewerComponent!.handleInput("\x03"); // ctrl+c 关闭（对齐 fleet close 键集）
    },
  };
}

test("接线：viewer 打开时 widget 隐藏（setWidget(undefined) 先于 custom 进入），关闭后恢复并立即重绘", async () => {
  resetDoubleLoadGuardForTests();
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  delete process.env.PI_AGENT_TEAM_WIDGET; // 让 widget 挂载（1s unref timer，不阻塞退出）
  try {
    const timeline: string[] = [];
    const pi = fakePi();
    agentTeamExtension(pi as never);
    await pi.fire("session_start", widgetSessionCtx(timeline));

    const customCalls: unknown[][] = [];
    const view = pi.commands.get("team:view");
    assert.ok(view);
    const closable = closableViewCtx({ timeline, customCalls });

    void view.handler("", closable.ctx as never); // 打开 overlay（pending）
    await new Promise((resolve) => setTimeout(resolve, 30)); // 等 openViewer 跑到 custom
    assert.equal(customCalls.length, 1, "应恰好打开一个 overlay");
    const hideAt = timeline.indexOf("hide");
    const customAt = timeline.indexOf("custom");
    assert.ok(hideAt >= 0 && customAt >= 0, `timeline 应有 hide 与 custom，实得 ${JSON.stringify(timeline)}`);
    assert.ok(hideAt < customAt, `widget 隐藏应先于 custom 进入（防双 surface 同屏），timeline=${JSON.stringify(timeline)}`);

    closable.close(); // ctrl+c 关闭 overlay
    await new Promise((resolve) => setTimeout(resolve, 30)); // 等 openViewer 的 finally 收尾
    assert.ok(timeline[timeline.length - 1] === "draw", `关闭后应立即重绘一帧亮块，timeline=${JSON.stringify(timeline)}`);
    const restoreAt = timeline.lastIndexOf("draw");
    assert.ok(restoreAt > customAt, "恢复重绘应在 custom 之后");
  } finally {
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
    resetDoubleLoadGuardForTests();
  }
});

test("接线：viewer 打开期间再次 /team:view → custom 只进一次（widget 挂载态下仍互斥）", async () => {
  resetDoubleLoadGuardForTests();
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  delete process.env.PI_AGENT_TEAM_WIDGET;
  try {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    await pi.fire("session_start", widgetSessionCtx([]));

    const customCalls: unknown[][] = [];
    const view = pi.commands.get("team:view");
    assert.ok(view);
    const closable = closableViewCtx({ customCalls });

    void view.handler("", closable.ctx as never);
    await Promise.race([
      view.handler("", closable.ctx as never), // 第二次：互斥应 early-return
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("互斥缺失：widget 挂载态下第二个 viewer 未在 500ms 内返回")), 500),
      ),
    ]);
    assert.equal(customCalls.length, 1, "widget 挂载态下第二个 viewer 也不得调用 ui.custom");
  } finally {
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
    resetDoubleLoadGuardForTests();
  }
});
