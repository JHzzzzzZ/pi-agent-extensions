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

    const first = view.handler("", viewCtx as never); // 第一次：打开 overlay（pending）
    await view.handler("", viewCtx as never); // 第二次：互斥，直接返回
    assert.equal(customCalls.length, 1, "第二个 viewer 不得调用 ui.custom");
    assert.equal(customCalls[0]?.length, 2, "overlay 调用保持 (factory, { overlay, overlayOptions }) 形状");
    void first; // 第一个 overlay 仍开着：刻意不 await
  } finally {
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
    resetDoubleLoadGuardForTests();
  }
});
