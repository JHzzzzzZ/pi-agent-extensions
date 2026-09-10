/**
 * agent-team — viewer 直接对话宿主接线（host 行为测试）
 *
 * 真实 cockpit + fake leader 子进程 + 真实 TranscriptViewer，隔离
 * PI_AGENT_TEAM_RUNS_DIR。锁三件事：
 * ① run 运行中提交 → 入队 notice；run 落定（completed）后链式派出新 run，
 *    新 leader 的 task 含用户消息与上一 run 的 transcript 尾部；
 * ② viewer D 停止 → 排队消息一并丢弃（无第二个 run）；
 * ③ 团队定义消失（resolveTeam 失败）→ error notice，链式派出也不发生。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { serializeTeam } from "../config.ts";
import { fixtureTeam } from "./fixtures.ts";
import { isolateRunsDir, makeFakeSpawn, sleep, waitForChild, type FakeSpawnHandle } from "./helpers.ts";

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

function sessionCtx(cwd: string) {
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

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.ok(false, `等待超时：${what}`);
}

interface HostFixture {
  spawn: FakeSpawnHandle;
  pi: ReturnType<typeof fakePi>;
  sessionCtx: ReturnType<typeof sessionCtx>;
  projectDir: string;
  teamFile: string;
  cleanup: () => Promise<void>;
}

async function setupHost(): Promise<HostFixture> {
  const runsDir = isolateRunsDir();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-chat-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "chat-team", description: "对话观测团队", filePath: "", notes: undefined });
  const teamFile = path.join(projectDir, ".pi", "teams", "chat-team.md");
  fs.writeFileSync(teamFile, serializeTeam(team));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const sessionCtxValue = sessionCtx(projectDir);
  await pi.fire("session_start", sessionCtxValue);
  return {
    spawn,
    pi,
    sessionCtx: sessionCtxValue,
    projectDir,
    teamFile,
    cleanup: async () => {
      await pi.fire("session_shutdown", sessionCtxValue);
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(runsDir, { recursive: true, force: true });
      delete process.env.PI_AGENT_TEAM_RUNS_DIR;
      resetDoubleLoadGuardForTests();
    },
  };
}

async function startBackgroundRun(host: HostFixture): Promise<void> {
  const run = host.pi.tools.get("team_run") as unknown as {
    execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<unknown>;
  };
  const started = (await run.execute("call-run", { team: "chat-team", task: "首轮任务" }, undefined, undefined, host.sessionCtx)) as {
    isError?: boolean;
  };
  assert.notEqual(started.isError, true);
  await waitForChild(host.spawn, 0);
}

async function openViewer(host: HostFixture): Promise<ViewerComponentLike> {
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  process.env.PI_AGENT_TEAM_WIDGET = "0";
  try {
    const view = host.pi.commands.get("team:view");
    assert.ok(view);
    const closable = closableViewCtx();
    void view.handler("", closable.ctx as never);
    await sleep(30);
    return closable.component();
  } finally {
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
  }
}

test("链式派出：run 运行中提交 → 排队 notice；run 落定后自动派出含用户消息的新 run", async () => {
  const host = await setupHost();
  try {
    await startBackgroundRun(host);
    const viewer = await openViewer(host);

    // leader 选中态直接发消息：run 运行中 → 排队。
    viewer.handleInput("m");
    viewer.handleInput("你");
    viewer.handleInput("好");
    viewer.handleInput("\r");
    const queuedFrame = viewer.render(100).join("\n");
    assert.match(queuedFrame, /消息已排队/, "运行中提交 → 排队 notice");
    assert.equal(host.spawn.children.length, 1, "排队期间不派新 run");

    // 首个 run 落定（completed）→ 链式派出新 run，task 含用户消息 + 上文尾部。
    const first = host.spawn.children[0];
    assert.ok(first);
    first.emitClose(0);
    await waitFor(() => host.spawn.records.length >= 2, "链式派出第二个 leader");
    const secondArgs = host.spawn.records[1]?.args.join(" ") ?? "";
    assert.match(secondArgs, /【用户消息】/, "新 run 的 task 携带用户消息模板");
    assert.match(secondArgs, /你好/, "新 run 的 task 携带消息原文");
    assert.match(secondArgs, /最近会话尾部/, "新 run 的 task 携带上一 run transcript 尾部");
    viewer.dispose();
  } finally {
    await host.cleanup();
  }
});

test("viewer D 停止：排队消息一并丢弃，无链式派出", async () => {
  const host = await setupHost();
  try {
    await startBackgroundRun(host);
    const viewer = await openViewer(host);

    viewer.handleInput("m");
    viewer.handleInput("被");
    viewer.handleInput("停");
    viewer.handleInput("\r");
    assert.match(viewer.render(100).join("\n"), /消息已排队/);

    // D → Enter 停止 run；停止路径清空队列 → leader 收尾后无第二个 run。
    viewer.handleInput("D");
    viewer.handleInput("\r");
    const first = host.spawn.children[0];
    assert.ok(first);
    await sleep(20);
    first.emitClose(0);
    await sleep(200);
    assert.equal(host.spawn.records.length, 1, "aborted 后排队消息丢弃，不链发");
    const frame = viewer.render(100).join("\n");
    assert.match(frame, /run 已停止（aborted/);
    viewer.dispose();
  } finally {
    await host.cleanup();
  }
});

test("团队定义消失：已结束 run 上提交 → 发送失败 notice，无派单", async () => {
  const host = await setupHost();
  try {
    await startBackgroundRun(host);
    const first = host.spawn.children[0];
    assert.ok(first);
    first.emitClose(0);
    await sleep(100); // 首个 run 落定（completed）

    const viewer = await openViewer(host);
    fs.rmSync(host.teamFile);
    viewer.handleInput("m");
    viewer.handleInput("找");
    viewer.handleInput("不");
    viewer.handleInput("\r");
    const frame = viewer.render(100).join("\n");
    assert.match(frame, /发送失败/, "resolveTeam 失败 → error notice");
    await sleep(150);
    assert.equal(host.spawn.records.length, 1, "失败路径不派新 run");
    viewer.dispose();
  } finally {
    await host.cleanup();
  }
});

test("已完成 run 上发消息：立即派单（不排队）", async () => {
  const host = await setupHost();
  try {
    await startBackgroundRun(host);
    const first = host.spawn.children[0];
    assert.ok(first);
    first.emitClose(0);
    await sleep(100); // 让首个 run 落定（completed）

    const viewer = await openViewer(host);
    viewer.handleInput("m");
    viewer.handleInput("新");
    viewer.handleInput("\r");
    const frame = viewer.render(100).join("\n");
    assert.match(frame, /已发送给 leader/, "已结束的 run 上直接派新 run");
    await waitFor(() => host.spawn.records.length >= 2, "立即派第二个 leader");
    assert.match(host.spawn.records[1]?.args.join(" ") ?? "", /新/);
    viewer.dispose();
  } finally {
    await host.cleanup();
  }
});
