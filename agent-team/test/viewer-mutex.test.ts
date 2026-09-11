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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { serializeTeam } from "../config.ts";
import { RUN_ENTRY_TYPE } from "../types.ts";
import { stripAnsi } from "../viewer.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, waitForChild, type FakeSpawnHandle, isolateRunsDir } from "./helpers.ts";

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

isolateRunsDir();

test("team view 互斥：viewer 打开期间再进入不开第二个 overlay", async () => {
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
    assert.ok(view, "cockpit 应注册 /team:view 命令");

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

/**
 * 焦点接线捕获（可选）：factory 形态 setWidget 的调用方是宿主，这里用假 TUI
 * 顶替——factory 调用次数、捕获到的宿主 TUI 引用、onTerminalInput handlers
 * 与推入的亮块行都记录下供断言。
 */
interface WidgetFocusCapture {
  factoryCalls: number;
  tui: { focusedComponent?: unknown };
  inputHandlers: Array<(data: string) => { consume?: boolean } | undefined>;
  pushed: Array<string[] | undefined>;
}

/** 带记录 setWidget 的 session ctx（widget 隐藏/恢复都走这里）。 */
function widgetSessionCtx(timeline: string[], cwd: string, capture?: WidgetFocusCapture) {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: (): boolean => true,
    ui: {
      getEditorText: (): string => "",
      setWidget: (_key: string, content: unknown): void => {
        if (typeof content === "function") {
          if (capture) {
            capture.factoryCalls += 1;
            (content as (tui: unknown) => unknown)(capture.tui);
          }
          timeline.push("factory");
          return;
        }
        if (capture) capture.pushed.push(content as string[] | undefined);
        timeline.push(content === undefined ? "hide" : "draw");
      },
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined): (() => void) => {
        capture?.inputHandlers.push(handler);
        return () => {};
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

/**
 * 挂好 widget 的会话：真实派一个后台 run（fake leader 子进程常开不回）
 * 让 ensureRunWidget 走真实挂载路径。水合不再从终态记录挂 widget
 * （/team:clear + 水合门控语义），所以这里必须经真实派单挂载。
 */
async function mountedSession(timeline: string[], capture?: WidgetFocusCapture): Promise<{
  pi: ReturnType<typeof fakePi>;
  child: Awaited<ReturnType<typeof waitForChild>>;
  sessionCtx: unknown;
  spawn: FakeSpawnHandle;
  projectDir: string;
  stop: () => Promise<void>;
}> {
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-mutex-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "proj-team", description: "互斥观测团队", filePath: "", notes: undefined });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "proj-team.md"), serializeTeam(team));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const sessionCtx = widgetSessionCtx(timeline, projectDir, capture);
  await pi.fire("session_start", sessionCtx);
  const run = pi.tools.get("team_run") as unknown as {
    execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<unknown>;
  };
  const started = (await run.execute("call-run", { team: "proj-team", task: "viewer 互斥观测任务" }, undefined, undefined, sessionCtx)) as {
    isError?: boolean;
  };
  assert.notEqual(started.isError, true, "后台派单应成功（widget 挂载前置）");
  const child = await waitForChild(spawn, 0); // 常开不回 → run 保持 running
  const stop = async (): Promise<void> => {
    await pi.fire("session_shutdown", sessionCtx); // 停 run + 停 widget + 清亮块
    fs.rmSync(projectDir, { recursive: true, force: true });
    resetDoubleLoadGuardForTests();
  };
  return { pi, child, sessionCtx, spawn, projectDir, stop };
}

type ViewerComponentLike = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
};

/** 一次模拟的宿主 select 调用：测试可控解答/取消。 */
interface SelectCallCapture {
  title: string;
  options: string[];
  /** 用户作答（宿主 promise 语义：首次落定生效）。 */
  resolve: (value: string | undefined) => void;
  /** 模拟 Esc/取消（selector onCancel）。 */
  cancel: () => void;
}

/**
 * 可关闭的 /team:view ctx：custom 捕获真实 TranscriptViewer 实例 + done
 * 回调（记 resolvedCustoms）；select 捕获标题/选项并暴露可控落定。测试经
 * component.handleInput("\x03") 关闭 overlay，驱动 openViewer 的 finally
 * （widget 恢复）完整跑完。
 */
function closableViewCtx(opts: { timeline?: string[]; customCalls?: unknown[][]; selectCalls?: SelectCallCapture[] }) {
  const timeline = opts.timeline ?? [];
  const customCalls = opts.customCalls ?? [];
  const selectCalls = opts.selectCalls ?? [];
  let viewerComponent: ViewerComponentLike | undefined;
  let resolveCustom: ((v: unknown) => void) | undefined;
  let resolvedCustoms = 0;
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
      viewerComponent = factory({}, { fg: (_c: string, t: string) => t }, undefined, (r) => {
        resolvedCustoms += 1;
        resolveCustom?.(r);
      }) as never;
      return new Promise<unknown>((resolve) => {
        resolveCustom = resolve;
      });
    },
    select: (title: string, options: string[], selectOpts?: { signal?: AbortSignal }): Promise<string | undefined> =>
      new Promise<string | undefined>((resolve) => {
        let settled = false;
        const settle = (value: string | undefined): void => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        selectCalls.push({ title, options, resolve: settle, cancel: () => settle(undefined) });
        selectOpts?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
      }),
  };
  return {
    ctx: { hasUI: true, mode: "tui", ui },
    close: (): void => {
      assert.ok(viewerComponent, "关闭前应已有 viewer 组件实例");
      viewerComponent!.handleInput("\x03"); // ctrl+c 关闭（对齐 fleet close 键集）
    },
    render: (width: number): string[] => {
      assert.ok(viewerComponent, "渲染前应已有 viewer 组件实例");
      return viewerComponent!.render(width);
    },
    /** openTranscriptViewer 的 custom promise 已落定的次数（= viewer 收起次数）。 */
    resolvedCustoms: (): number => resolvedCustoms,
    selectCalls,
  };
}

test("接线：viewer 打开时 widget 隐藏（setWidget(undefined) 先于 custom 进入），关闭后恢复并立即重绘", async () => {
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  delete process.env.PI_AGENT_TEAM_WIDGET; // 让 widget 挂载（1s unref timer，不阻塞退出）
  const timeline: string[] = [];
  const mounted = await mountedSession(timeline);
  try {
    const { pi } = mounted;
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
    await mounted.stop();
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
  }
});

test("接线：viewer 打开期间再次 /team:view → custom 只进一次（widget 挂载态下仍互斥）", async () => {
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  delete process.env.PI_AGENT_TEAM_WIDGET;
  const mounted = await mountedSession([]);
  try {
    const { pi } = mounted;

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
    await mounted.stop();
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
  }
});

// ---------------------------------------------------------------------------
// Slice 9：widget 焦点门控接线（真实 ensureRunWidget + 假 ctx.ui）
// ---------------------------------------------------------------------------
// index.ts 必须一次性捕获宿主 TUI（factory 形态 setWidget）并把
// probeEditorFocus 接到 controller；否则选择器焦点时裸 ↓ 仍被 widget 抢。

test("接线：widget 挂载一次性捕获宿主 TUI；焦点非编辑器时裸 ↓ 让行、焦点在主编辑器时照常选中", async () => {
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  delete process.env.PI_AGENT_TEAM_WIDGET;
  const capture: WidgetFocusCapture = { factoryCalls: 0, tui: {}, inputHandlers: [], pushed: [] };
  const mounted = await mountedSession([], capture);
  try {
    assert.equal(capture.factoryCalls, 1, "挂载时应恰一次 factory 调用（一次性捕获宿主 TUI）");
    assert.equal(capture.inputHandlers.length, 1, "应恰挂一个 onTerminalInput handler");

    // 焦点 = 选择器形状（无 getText/setText，如 /login 选择器）：widget 不介入。
    capture.tui.focusedComponent = { render: () => [], invalidate: () => {}, handleInput: () => {} };
    assert.equal(capture.inputHandlers[0]!("\x1b[B"), undefined, "选择器焦点时裸 ↓ 不消费");
    assert.equal(cursorRowOf(capture.pushed), -1, "不得进入选中");

    // 焦点 = 编辑器形状：空编辑器裸 ↓ 照常激活（接线没把 editorFocus 接反）。
    capture.tui.focusedComponent = {
      render: () => [],
      invalidate: () => {},
      handleInput: () => {},
      getText: () => "",
      setText: () => {},
    };
    assert.equal(capture.inputHandlers[0]!("\x1b[B")?.consume, true, "编辑器焦点时裸 ↓ 照常激活");
    assert.equal(cursorRowOf(capture.pushed), 0, "出现行光标");
  } finally {
    await mounted.stop();
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
  }
});

const cursorRowOf = (pushed: Array<string[] | undefined>): number => {
  const lines = pushed[pushed.length - 1] ?? [];
  return lines.findIndex((line) => line.startsWith("▸ "));
};

// ---------------------------------------------------------------------------
// Slice 10：活动行接线（真实 buildViewerData 烘焙，v1.17.0）
// ---------------------------------------------------------------------------

test("接线：running 查看器活动行由 buildViewerData 从 transcript 推导（思考中 + 分桶时长）", async () => {
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  process.env.PI_AGENT_TEAM_WIDGET = "0";
  const mounted = await mountedSession([]);
  try {
    const view = mounted.pi.commands.get("team:view");
    assert.ok(view);
    const closable = closableViewCtx({});
    void view.handler("", closable.ctx as never);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = stripAnsi(closable.render(120).join("\n"));
    const activityLines = frame.split("\n").filter((line) => line.includes("活动:"));
    assert.match(
      frame,
      /活动: 思考中 · 距上次输出 (\d+m)?\d+s/,
      `活动行应由 buildViewerData 烘焙：${activityLines.join(" | ")}`,
    );
    closable.close();
  } finally {
    await mounted.stop();
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
  }
});

test("接线：终态 run 查看器活动行恒 `run 已结束`（回放，不带时长）", async () => {
  resetDoubleLoadGuardForTests();
  const pi = fakePi();
  agentTeamExtension(pi as never);
  await pi.fire("session_start", hydratedSessionCtx());
  const view = pi.commands.get("team:view");
  assert.ok(view);
  const closable = closableViewCtx({});
  void view.handler("", closable.ctx as never);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const frame = stripAnsi(closable.render(120).join("\n"));
  assert.match(frame, /活动: run 已结束/, `终态活动行恒 run 已结束：${frame.split("\n").filter((l) => l.includes("活动:")).join(" | ")}`);
  assert.doesNotMatch(frame, /距上次输出/, "终态不带时长（零时钟重绘）");
  closable.close();
  resetDoubleLoadGuardForTests();
});

// ---------------------------------------------------------------------------
// Slice 11：viewer ↔ leader 提问互斥接线（真机 bug：viewer overlay 盖住
// team_ask 宿主对话框，且焦点被 selector 抢走）
// ---------------------------------------------------------------------------

/** leader 提问 wire 行（形状同 cockpit-ask.test.ts；select 方法带选项）。 */
function askLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "extension_ui_request",
    id: "q1",
    method: "select",
    title: "[dev-team] 要发到哪个环境？",
    options: ["staging", "prod"],
    ...overrides,
  });
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(check(), `${label}（等待 2s 超时）`);
}

function leaderResponses(child: { writes: string[] }): Array<Record<string, unknown>> {
  return child.writes
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((message): message is Record<string, unknown> => message?.type === "extension_ui_response");
}

test("接线：leader 提问到达先收起 viewer，作答/取消后自动重开（三处调用点接线）", async () => {
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  process.env.PI_AGENT_TEAM_WIDGET = "0"; // 本用例不测 widget：跳过它的 1s 真定时器
  const mounted = await mountedSession([]);
  try {
    const { pi, child, sessionCtx } = mounted;
    const customCalls: unknown[][] = [];
    const selectCalls: SelectCallCapture[] = [];
    const closable = closableViewCtx({ customCalls, selectCalls });
    // 真机里 /team:view 与提问对话框共用同一个主会话 ctx.ui；mountedSession
    // 的会话 ctx 已持有 team_run 的 askPort（capture ctx 对象），把可观测的
    // viewer/dialog 表面接上去，三处调用点就都在真实接线上跑。
    Object.assign((sessionCtx as { ui: Record<string, unknown> }).ui, {
      custom: closable.ctx.ui.custom,
      select: closable.ctx.ui.select,
    });
    const view = pi.commands.get("team:view");
    assert.ok(view, "cockpit 应注册 /team:view 命令");

    void view.handler("", sessionCtx as never);
    await waitUntil(() => customCalls.length === 1, "/team:view 应打开 viewer overlay");
    assert.equal(closable.resolvedCustoms(), 0, "打开后 viewer 尚未收起");

    child.emitLine(askLine({ id: "q1" }));
    await waitUntil(() => selectCalls.length === 1, "提问应呈现为宿主对话框");
    assert.equal(selectCalls[0]?.title, "[dev-team] 要发到哪个环境？");
    assert.deepEqual(selectCalls[0]?.options, ["staging", "prod"]);
    assert.equal(closable.resolvedCustoms(), 1, "select 呈现前 viewer 已收起（custom 已落定）");

    selectCalls[0]!.resolve("staging");
    await waitUntil(() => customCalls.length === 2, "作答后 viewer 应自动重开");
    assert.deepEqual(
      leaderResponses(child),
      [{ type: "extension_ui_response", id: "q1", value: "staging" }],
      "答案应回写 leader stdin",
    );

    child.emitLine(askLine({ id: "q2" }));
    await waitUntil(() => selectCalls.length === 2, "第二次提问应再次呈现对话框");
    assert.equal(closable.resolvedCustoms(), 2, "第二次提问前 viewer 再次收起");
    selectCalls[1]!.cancel(); // Esc/取消
    await waitUntil(() => customCalls.length === 3, "取消后 viewer 应自动重开");
    assert.deepEqual(
      leaderResponses(child)[1],
      { type: "extension_ui_response", id: "q2", cancelled: true },
      "取消应回写 cancelled",
    );
  } finally {
    await mounted.stop();
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
  }
});
