/**
 * agent-team — viewer 停止动作接线（host 行为测试）
 *
 * v1.4.0：viewer 内 D 停止整个 run。两条线各测一遍：
 * ① `viewerStopAction` 纯接线映射（fake coordinator）：stopAndSettle 的
 *    settled/unsettled/异常与无活动 run 四路分别映射为 success/warning/
 *    error notice 文案——不派真实子进程，避免 7s settle 窗口拖慢测试；
 * ② 全链路：真实 cockpit + fake leader 子进程 + 真实 TranscriptViewer，
 *    D→Enter 触发 stopAndSettle，leader 收尾落定后 notice 显示 aborted
 *    终态文案（busy 守卫下 stop 回调恰调一次）。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import agentTeamExtension, { resetDoubleLoadGuardForTests, viewerStopAction } from "../index.ts";
import { serializeTeam } from "../config.ts";
import { RUN_ENTRY_TYPE } from "../types.ts";
import { TranscriptViewer, plainStyles } from "../viewer.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, waitForChild, type FakeSpawnHandle } from "./helpers.ts";

// ---------------------------------------------------------------------------
// ① viewerStopAction 映射（fake coordinator，结构性类型即可）
// ---------------------------------------------------------------------------

function fakeCoordinator(opts: {
  progress?: { runId: string } | null;
  lastRecord?: { status: string; runId: string } | null;
  outcome?: { settled: boolean; record: { durationMs?: number } | null };
  reject?: boolean;
}) {
  return {
    getStatus: () => ({ running: opts.progress !== undefined && opts.progress !== null, progress: opts.progress ?? null, lastRecord: opts.lastRecord ?? null }),
    stopAndSettle: async () => {
      if (opts.reject) throw new Error("boom");
      return opts.outcome ?? { settled: true, record: null };
    },
  };
}

test("viewerStopAction：settled → success 文案（含 aborted 与秒数）", async () => {
  const result = await viewerStopAction(fakeCoordinator({
    progress: { runId: "run-1" },
    outcome: { settled: true, record: { durationMs: 3200 } },
  }) as never);
  assert.equal(result.kind, "success");
  assert.equal(result.text, "run 已停止（aborted · 3.2s）；该 run 的报告不再送达");
});

test("viewerStopAction：settled 无 durationMs → success 文案不带秒数", async () => {
  const result = await viewerStopAction(fakeCoordinator({
    progress: { runId: "run-1" },
    outcome: { settled: true, record: null },
  }) as never);
  assert.equal(result.kind, "success");
  assert.equal(result.text, "run 已停止（aborted）；该 run 的报告不再送达");
});

test("viewerStopAction：未落定 → warning 文案", async () => {
  const result = await viewerStopAction(fakeCoordinator({
    progress: { runId: "run-1" },
    outcome: { settled: false, record: null },
  }) as never);
  assert.equal(result.kind, "warning");
  assert.equal(result.text, "已发送中止信号，leader 仍在收尾；稍后用 /team status 确认终态");
});

test("viewerStopAction：无活动 run（有终态记录）→ error 提示，不调 stopAndSettle", async () => {
  let stopCalls = 0;
  const coordinator = fakeCoordinator({ lastRecord: { status: "failed", runId: "run-9" } });
  const wrapped = {
    getStatus: coordinator.getStatus,
    stopAndSettle: async (): Promise<never> => {
      stopCalls += 1;
      throw new Error("should not be called");
    },
  };
  void stopCalls;
  const result = await viewerStopAction(wrapped as never);
  assert.equal(result.kind, "error");
  assert.equal(result.text, "run 已结束（failed），无需停止");
});

test("viewerStopAction：无活动 run（无记录）→ error 提示", async () => {
  const result = await viewerStopAction(fakeCoordinator({}) as never);
  assert.equal(result.kind, "error");
  assert.equal(result.text, "当前没有正在运行的 run，无需停止");
});

test("viewerStopAction：stopAndSettle 异常 → error 文案，不上抛", async () => {
  const result = await viewerStopAction(fakeCoordinator({ progress: { runId: "run-1" }, reject: true }) as never);
  assert.equal(result.kind, "error");
  assert.equal(result.text, "停止失败；稍后用 /team stop 重试");
});

// ---------------------------------------------------------------------------
// ② 全链路：真实 cockpit + fake leader 子进程 + 真实 TranscriptViewer
// ---------------------------------------------------------------------------

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

function runningSessionCtx(cwd: string) {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: (): boolean => true,
    ui: {
      setWidget: (): void => {},
      notify: (): void => {},
      theme: { fg: (_color: string, text: string): string => text },
    },
    sessionManager: { getEntries: (): unknown[] => [] },
  };
}

type ViewerComponentLike = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
  dispose: () => void;
};

/** 捕获真实 TranscriptViewer 实例的 closable /team view ctx。 */
function closableViewCtx() {
  let viewerComponent: ViewerComponentLike | undefined;
  let resolveCustom: ((v: unknown) => void) | undefined;
  const ui = {
    notify: (): void => {},
    theme: { fg: (_c: string, t: string) => t },
    custom: (...args: unknown[]): Promise<unknown> => {
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
    component: (): ViewerComponentLike => {
      assert.ok(viewerComponent, "viewer 组件应已实例化");
      return viewerComponent!;
    },
  };
}

test("全链路：viewer D→Enter 触发真实 stopAndSettle，落定后 notice 显示 aborted 终态", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-stop-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "stop-team", description: "停止观测团队", filePath: "", notes: undefined });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "stop-team.md"), serializeTeam(team));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const sessionCtx = runningSessionCtx(projectDir);
  try {
    await pi.fire("session_start", sessionCtx);
    const run = pi.tools.get("team_run") as unknown as {
      execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<unknown>;
    };
    const started = (await run.execute("call-run", { team: "stop-team", task: "停止观测任务" }, undefined, undefined, sessionCtx)) as {
      isError?: boolean;
    };
    assert.notEqual(started.isError, true);
    await waitForChild(spawn, 0); // leader 常开不回 → run 保持 running

    const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
    process.env.PI_AGENT_TEAM_WIDGET = "0";
    try {
      const view = pi.commands.get("team");
      assert.ok(view);
      const closable = closableViewCtx();
      void view.handler("view", closable.ctx as never);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const component = closable.component();

      component.handleInput("D");
      const armedFrame = component.render(100).join("\n");
      assert.match(armedFrame, /确认停止 run /, "运行中 D 进入确认态并渲染横幅");
      component.handleInput("\r");

      // stopAndSettle 已发出中止信号；让 leader 子进程收尾落定。
      const child = spawn.children[0];
      assert.ok(child, "leader 子进程应存在");
      await new Promise((resolve) => setTimeout(resolve, 20));
      child.emitClose(0);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const frame = component.render(100).join("\n");
      assert.match(frame, /run 已停止（aborted/, "settled notice 上屏");
      assert.doesNotMatch(frame, /确认停止 run/, "确认横幅已撤");
      assert.doesNotMatch(frame, /停止中…/, "busy 横幅已撤");
      component.dispose();
    } finally {
      if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
      else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
    }
  } finally {
    await pi.fire("session_shutdown", sessionCtx);
    fs.rmSync(projectDir, { recursive: true, force: true });
    resetDoubleLoadGuardForTests();
  }
});
