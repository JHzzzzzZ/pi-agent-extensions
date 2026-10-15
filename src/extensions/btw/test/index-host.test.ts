/**
 * 宿主事件路径集成测试：**真实发现+加载（jiti 走 index.ts）+ 真实 ExtensionRunner
 * + 真实命令上下文 + 真实面板组件（只 fake 终端）**。
 *
 * 为什么必须走这条路：本扩展的风险全在宿主接缝上——命令能否被真实解析到、
 * `ctx.ui.custom` 拿到的 `tui`/`theme` 形状、`ctx.mode` 分叉、命令处理器的
 * `ExtensionCommandContext` 面，以及**零写入**（不 appendEntry / 不 sendMessage /
 * 不碰 sessionManager 写路径）。
 *
 * 边界 fake：`streamSimple`（网络/鉴权边界；本扩展真正用到的那一小面）、
 * `sessionManager`（只读 `buildContextEntries` / `getSessionId`）、`ExtensionActions`
 * （把写调用变成计数器）、`ui`（记录 notify 与组件，渲染管线本身不在本测试范围）。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionRunner, createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionActions,
  ExtensionCommandContextActions,
  ExtensionContextActions,
  ExtensionUIContext,
  ModelRegistry,
  SessionManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, "..");
const MAIN_MODEL = { provider: "main", id: "m" };
const ALT_MODEL = { provider: "alt", id: "cheap" };

interface PanelLike extends Component {
  handleInput(data: string): void;
}

function userEntry(text: string): unknown {
  return { type: "message", message: { role: "user", content: text } };
}

function assistantEntry(text: string): unknown {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function eventsStream(text: string, opts: { hold?: Promise<void>; error?: string } = {}): AsyncIterable<unknown> {
  return (async function* () {
    if (opts.hold) await opts.hold;
    if (opts.error) {
      yield { type: "error", reason: "error", error: { errorMessage: opts.error, stopReason: "error" } };
      return;
    }
    yield { type: "text_delta", delta: text };
    yield { type: "done", message: { content: [{ type: "text", text }] } };
  })();
}

const THEME_STUB = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

interface HarnessOptions {
  mode?: "tui" | "rpc";
  hasUI?: boolean;
  entries?: unknown[];
  text?: string;
  error?: string;
  hold?: Promise<void>;
}

interface Harness {
  runner: ExtensionRunner;
  calls: Array<{ model: unknown; content: string; options: Record<string, unknown> }>;
  writes: { appendEntry: number; sendMessage: number; sendUserMessage: number };
  notifies: Array<{ message: string; type?: string }>;
  components: PanelLike[];
  run: (name: string, args: string) => Promise<void>;
}

function makeUi(harness: Pick<Harness, "notifies" | "components">): ExtensionUIContext {
  return {
    notify: (message: string, type?: string) => harness.notifies.push({ message, type }),
    setStatus: () => {},
    custom: async (factory: unknown, _options?: unknown) =>
      await new Promise((resolve) => {
        const create = factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: unknown) => void,
        ) => Component;
        const component = create(
          { terminal: { rows: 40 }, requestRender: () => {} },
          THEME_STUB,
          {},
          (value) => resolve(value),
        );
        harness.components.push(component as PanelLike);
      }),
  } as unknown as ExtensionUIContext;
}

async function startHarness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "btw-host-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([EXT_DIR], EXT_DIR, path.join(tmp, "agent"), createEventBus());
  assert.deepEqual(loaded.errors, [], "扩展加载必须无错（jiti 走真实 index.ts）");

  const calls: Harness["calls"] = [];
  const registry = {
    streamSimple: (model: unknown, context: { messages: Array<{ content: unknown }> }, opts: Record<string, unknown>) => {
      calls.push({ model, content: String(context.messages[0]!.content), options: opts ?? {} });
      return eventsStream(options.text ?? "侧答：正在读文件", { hold: options.hold, error: options.error }) as never;
    },
    find: (provider: string, id: string) =>
      provider === ALT_MODEL.provider && id === ALT_MODEL.id ? ALT_MODEL : undefined,
  } as unknown as ModelRegistry;

  const writes = { appendEntry: 0, sendMessage: 0, sendUserMessage: 0 };
  const actions = {
    appendEntry: () => {
      writes.appendEntry += 1;
      return "entry-1";
    },
    sendMessage: () => {
      writes.sendMessage += 1;
    },
    sendUserMessage: () => {
      writes.sendUserMessage += 1;
    },
    getAllTools: () => [],
  } as unknown as ExtensionActions;

  const contextActions: ExtensionContextActions = {
    getModel: () => MAIN_MODEL as never,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  };

  const sessionManager = {
    buildContextEntries: () => options.entries ?? [],
    getSessionId: () => "btw-session-1",
  } as unknown as SessionManager;

  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, EXT_DIR, sessionManager, registry);
  runner.bindCore(actions, contextActions);
  runner.bindCommandContext({ waitForIdle: async () => {} } as unknown as ExtensionCommandContextActions);
  const notifies: Harness["notifies"] = [];
  const components: Harness["components"] = [];
  const ui = makeUi({ notifies, components });
  if (options.hasUI ?? true) runner.setUIContext(ui, options.mode ?? "tui");

  const harness: Harness = {
    runner,
    calls,
    writes,
    notifies,
    components,
    run: async (name, args) => {
      const command = runner.getCommand(name);
      assert.ok(command, `命令 ${name} 必须已注册`);
      await command.handler(args, runner.createCommandContext());
    },
  };
  return harness;
}

async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 超时");
}

/** TUI 一轮问答：等面板出现 → 等侧调用落定（默认等「已完成」）→ Esc 关闭 → 命令返回 */
async function runPanelTurn(harness: Harness, question: string, opts: { until?: string } = {}): Promise<void> {
  const before = harness.components.length;
  const running = harness.run("btw", question);
  await waitFor(() => harness.components.length > before);
  const panel = harness.components.at(-1)!;
  const needle = opts.until ?? "已完成";
  await waitFor(() => panel.render(80).join("\n").includes(needle));
  assert.ok(panel.render(80).length > 0);
  panel.handleInput("\x1b");
  await running;
}

test("真实入口加载：btw / btw:clear / btw:model 都已注册（jiti 走真实 index.ts）", async (t) => {
  const harness = await startHarness(t);
  for (const name of ["btw", "btw:clear", "btw:model"]) {
    assert.ok(harness.runner.getCommand(name), `${name} 必须已注册`);
  }
  assert.equal(harness.runner.getCommand("btw")!.description?.includes("旁路对话"), true);
});

test("TUI：/btw 建面板、答案上屏、上下文进 prompt，且主会话零写入", async (t) => {
  const harness = await startHarness(t, { entries: [userEntry("帮我修 bug"), assistantEntry("我先读文件")] });
  await runPanelTurn(harness, "现在在干啥");

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0]!.model, MAIN_MODEL);
  assert.match(harness.calls[0]!.content, /\[用户\] 帮我修 bug/);
  assert.match(harness.calls[0]!.content, /\[助手\] 我先读文件/);
  assert.equal(harness.calls[0]!.options.sessionId, "btw-session-1");
  assert.equal(typeof harness.calls[0]!.options.maxTokens, "number");
  assert.equal(harness.writes.appendEntry, 0, "不写会话条目");
  assert.equal(harness.writes.sendMessage, 0, "不注入自定义消息");
  assert.equal(harness.writes.sendUserMessage, 0, "不注入用户消息");
});

test("TUI：面板内容含答案与提问；流式增量实时上屏", async (t) => {
  const harness = await startHarness(t, { text: "正在跑 npm test" });
  const running = harness.run("btw", "现在在干啥");
  await waitFor(() => harness.components.length === 1);
  const panel = harness.components[0]!;
  await waitFor(() => panel.render(80).join("\n").includes("正在跑 npm test"));
  const text = panel.render(80).join("\n");
  assert.ok(text.includes("btw 旁路对话"));
  assert.ok(text.includes("现在在干啥"));
  panel.handleInput("\x1b");
  await running;
});

test("TUI：同一会话两轮追问带前文；/btw:clear 清空；session_start 重置", async (t) => {
  const harness = await startHarness(t);
  await runPanelTurn(harness, "第一问");
  await runPanelTurn(harness, "第二问");
  assert.match(harness.calls[1]!.content, /SIDE CHAT SO FAR/);
  assert.match(harness.calls[1]!.content, /Q: 第一问/);
  assert.match(harness.calls[1]!.content, /A: 侧答：正在读文件/);

  await harness.run("btw:clear", "");
  await runPanelTurn(harness, "第三问");
  assert.ok(!harness.calls[2]!.content.includes("SIDE CHAT SO FAR"), "clear 后不带前文");

  await runPanelTurn(harness, "第四问");
  await harness.runner.emit({ type: "session_start", reason: "new" });
  await runPanelTurn(harness, "第五问");
  assert.ok(!harness.calls[4]!.content.includes("SIDE CHAT SO FAR"), "session_start 后不带旧前文");
  assert.equal(harness.writes.appendEntry, 0);
  assert.equal(harness.writes.sendMessage, 0);
});

test("TUI：/btw:model 切换对下一次调用生效（真实命令上下文）", async (t) => {
  const harness = await startHarness(t);
  await harness.run("btw:model", "alt/cheap");
  await runPanelTurn(harness, "问");
  assert.equal(harness.calls[0]!.model, ALT_MODEL);
  await harness.run("btw:model", "default");
  await runPanelTurn(harness, "再问");
  assert.equal(harness.calls[1]!.model, MAIN_MODEL);
});

test("RPC：不自绘面板，降级 notify 完整答案，且零写入", async (t) => {
  const harness = await startHarness(t, { mode: "rpc", text: "在跑测试，马上改 X" });
  await harness.run("btw", "现在在干啥");
  assert.equal(harness.components.length, 0, "RPC 不建终端组件");
  assert.equal(harness.notifies.at(-1)!.message, "在跑测试，马上改 X");
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.writes.appendEntry + harness.writes.sendMessage + harness.writes.sendUserMessage, 0);
});

test("无 UI：写 stderr、零调用、零面板", async (t) => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  const harness = await startHarness(t, { hasUI: false });
  await harness.run("btw", "现在在干啥");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /没有可展示侧对话的 UI/);
  assert.equal(harness.calls.length, 0, "没有 UI 就不花这次钱");
  assert.equal(harness.components.length, 0);
});

test("单飞：第一轮挂住时第二轮被拒绝（真实命令路径）", async (t) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const harness = await startHarness(t, { hold: gate });
  const first = harness.run("btw", "第一问");
  await waitFor(() => harness.components.length === 1);
  await harness.run("btw", "第二问");
  assert.equal(harness.calls.length, 1);
  assert.match(harness.notifies.at(-1)!.message, /还在跑/);
  release?.();
  harness.components[0]!.handleInput("\x1b");
  await first;
});

test("错误：流内 error 在面板里可见（TUI）与 notify 里可见（RPC）", async (t) => {
  const tui = await startHarness(t, { error: "401 unauthorized" });
  await runPanelTurn(tui, "问", { until: "401 unauthorized" });
  assert.equal(tui.writes.appendEntry + tui.writes.sendMessage + tui.writes.sendUserMessage, 0);

  const rpc = await startHarness(t, { mode: "rpc", error: "401 unauthorized" });
  await rpc.run("btw", "问");
  assert.match(rpc.notifies.at(-1)!.message, /401 unauthorized/);
});

test("结构守卫：btw 源码不出现任何写会话 API（appendEntry / sendMessage / sendUserMessage）", () => {
  for (const file of ["index.ts", "side-call.ts", "panel.ts", "context.ts", "spec.ts", "errors.ts"]) {
    const source = fs.readFileSync(path.join(EXT_DIR, file), "utf8");
    for (const api of [
      "pi.appendEntry(",
      "pi.sendMessage(",
      "pi.sendUserMessage(",
      "appendCustomEntry(",
      "appendCustomMessageEntry(",
    ]) {
      assert.ok(!source.includes(api), `${file} 不得出现 ${api}（零写入是硬不变量）`);
    }
  }
});
