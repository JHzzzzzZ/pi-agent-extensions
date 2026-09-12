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
import { TranscriptViewer, plainStyles, stripAnsi, type ViewerData } from "../viewer.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, waitForChild, type FakeSpawnHandle } from "./helpers.ts";

// ---------------------------------------------------------------------------
// ① viewerStopAction 映射（fake coordinator，结构性类型即可）
// ---------------------------------------------------------------------------

function fakeCoordinator(opts: {
  active?: string[];
  records?: Record<string, string>;
  outcome?: { settled: boolean; record: { durationMs?: number } | null };
  reject?: boolean;
}) {
  const activeIds = opts.active ?? [];
  const settled: string[] = [];
  const coordinator = {
    calls: settled,
    isRunActive: (runId: string) => activeIds.includes(runId),
    terminalStatus: (runId: string) => opts.records?.[runId] ?? null,
    stopAndSettle: async (runId: string) => {
      settled.push(runId);
      if (opts.reject) throw new Error("boom");
      return opts.outcome ?? { settled: true, record: null };
    },
  };
  return coordinator;
}

test("viewerStopAction：settled → success 文案（含 runId 与秒数）", async () => {
  const coordinator = fakeCoordinator({
    active: ["run-1"],
    outcome: { settled: true, record: { durationMs: 3200 } },
  });
  const result = await viewerStopAction(coordinator as never, "run-1");
  assert.equal(result.kind, "success");
  assert.equal(result.text, "run run-1 已停止（aborted · 3.2s）；该 run 的报告不再送达");
  assert.deepEqual(coordinator.calls, ["run-1"], "stopAndSettle 定向到请求的 runId");
});

test("viewerStopAction：settled 无 durationMs → success 文案不带秒数", async () => {
  const result = await viewerStopAction(
    fakeCoordinator({ active: ["run-1"], outcome: { settled: true, record: null } }) as never,
    "run-1",
  );
  assert.equal(result.kind, "success");
  assert.equal(result.text, "run run-1 已停止（aborted）；该 run 的报告不再送达");
});

test("viewerStopAction：未落定 → warning 文案", async () => {
  const result = await viewerStopAction(
    fakeCoordinator({ active: ["run-1"], outcome: { settled: false, record: null } }) as never,
    "run-1",
  );
  assert.equal(result.kind, "warning");
  assert.equal(result.text, "已向 run run-1 发送中止信号，leader 仍在收尾；稍后用 /team:status 确认终态");
});

test("viewerStopAction：已结束 run → error 提示（带 runId），不调 stopAndSettle", async () => {
  const coordinator = fakeCoordinator({ records: { "run-9": "failed" } });
  const result = await viewerStopAction(coordinator as never, "run-9");
  assert.equal(result.kind, "error");
  assert.equal(result.text, "run run-9 已结束（failed），无需停止");
  assert.deepEqual(coordinator.calls, [], "no stop signal for a finished run");
});

test("viewerStopAction：未知 runId → error 提示（带 runId）", async () => {
  const coordinator = fakeCoordinator({});
  const result = await viewerStopAction(coordinator as never, "run-x");
  assert.equal(result.kind, "error");
  assert.equal(result.text, "没有找到 runId run-x 的 run，无需停止");
  assert.deepEqual(coordinator.calls, []);
});

test("viewerStopAction：空 runId → 无活动 run 提示，不调 stopAndSettle", async () => {
  const coordinator = fakeCoordinator({});
  const result = await viewerStopAction(coordinator as never, "  ");
  assert.equal(result.kind, "error");
  assert.equal(result.text, "当前没有正在运行的 run，无需停止");
  assert.deepEqual(coordinator.calls, []);
});

test("viewerStopAction：stopAndSettle 异常 → error 文案，不上抛", async () => {
  const result = await viewerStopAction(fakeCoordinator({ active: ["run-1"], reject: true }) as never, "run-1");
  assert.equal(result.kind, "error");
  assert.equal(result.text, "停止失败；稍后用 /team:stop 重试");
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

/** 捕获真实 TranscriptViewer 实例的 closable /team:view ctx。 */
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

// ---------------------------------------------------------------------------
// ③ 多 run：stop/onMessage 回调携带当前查看 run 的 runId（设计 §6.1）
// ---------------------------------------------------------------------------

function dualRunLoad(runId: string | undefined): ViewerData {
  const runs = [
    { runId: "run-A", team: "a-team", status: "running" },
    { runId: "run-B", team: "b-team", status: "running" },
  ];
  const viewingB = runId === "run-B";
  return {
    team: viewingB ? "b-team" : "a-team",
    runId: viewingB ? "run-B" : "run-A",
    runStatus: "running",
    actors: [
      { actor: "_leader", label: "leader", status: "running" },
      { actor: "front", label: "front", status: "running" },
    ],
    entries: new Map(),
    runs,
  };
}

test("viewer 多 run：`[` 切到 run-B 后 stop(runId) 与确认横幅都指向当前查看 run", async () => {
  const stopped: string[] = [];
  const viewer = new TranscriptViewer({
    load: dualRunLoad,
    done: () => {},
    styles: plainStyles(),
    rows: () => 40,
    refreshMs: 60_000,
    stop: async (runId) => {
      stopped.push(runId);
      return { text: `run ${runId} 已停止`, kind: "success" };
    },
  });
  try {
    viewer.handleInput("[");
    assert.match(stripAnsi(viewer.render(100).join("\n")), /Run: run-B/, "`[` 切到 run-B");
    viewer.handleInput("D");
    assert.match(stripAnsi(viewer.render(100).join("\n")), /确认停止 run run-B？/, "确认横幅带当前 runId");
    viewer.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(stopped, ["run-B"], "stop 回调收到当前查看 run 的 runId");
  } finally {
    viewer.dispose();
  }
});

test("viewer 多 run：钉选 run 从列表消失→刷新时回退默认 run", () => {
  let gone = false;
  const viewer = new TranscriptViewer({
    load: (runId) => {
      const data = dualRunLoad(runId);
      return gone ? { ...data, runs: [{ runId: "run-A", team: "a-team", status: "running" }] } : data;
    },
    done: () => {},
    styles: plainStyles(),
    rows: () => 40,
    refreshMs: 60_000,
  });
  try {
    viewer.handleInput("[");
    assert.match(stripAnsi(viewer.render(100).join("\n")), /Run: run-B/, "先钉选 run-B");
    gone = true; // run-B 从 runs 列表消失（记录被挤出/会话变更）
    assert.match(stripAnsi(viewer.render(100).join("\n")), /Run: run-A/, "列表变化后回退默认 run");
  } finally {
    viewer.dispose();
  }
});

test("viewer 多 run：`[` 切到 run-B 后 onMessage target 带当前 runId", () => {
  const targets: Array<{ runId: string; actor: string; label: string }> = [];
  const viewer = new TranscriptViewer({
    load: dualRunLoad,
    done: () => {},
    styles: plainStyles(),
    rows: () => 40,
    refreshMs: 60_000,
    onMessage: (target, message) => {
      targets.push(target);
      return { text: `已发送 ${message}`, kind: "success" };
    },
  });
  try {
    viewer.handleInput("[");
    viewer.handleInput("m");
    viewer.handleInput("hi");
    viewer.handleInput("\r");
    assert.deepEqual(targets, [{ runId: "run-B", actor: "_leader", label: "leader" }], "target 带当前 runId");
  } finally {
    viewer.dispose();
  }
});

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
      const view = pi.commands.get("team:view");
      assert.ok(view);
      const closable = closableViewCtx();
      void view.handler("", closable.ctx as never);
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
      assert.match(frame, /run run-\d+ 已停止（aborted/, "settled notice 上屏（带 runId）");
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
