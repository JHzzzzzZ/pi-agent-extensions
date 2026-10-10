/**
 * 宿主事件路径集成测试：**真实发现+加载（jiti 走 index.ts）+ 真实 ExtensionRunner 事件分发**。
 *
 * 为什么不用纸面替身直接调内部函数：本扩展的风险全在宿主接缝上——`tool_result`
 * 返回值的合并语义（`content` 替换 vs `undefined` 透传）、`event.input` 字段名、
 * `parentToolCallId`（嵌套调用）、`session_compact` 的时序、`ctx.cwd` 与真实
 * realpath 的关系。这里走宿主自己的 `discoverAndLoadExtensions`（pi main() 同一条
 * 路径）加载真实入口文件，再把**真实形状**的工具结果事件喂进真实 runner。
 *
 * 边界 fake：`sessionManager` / `modelRegistry` / actions（本扩展不读它们，用结构
 * fake）；文件系统是真实的临时目录树（路径与 realpath 语义正是被测对象）。
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
  ExtensionContextActions,
  ExtensionUIContext,
  ModelRegistry,
  SessionManager,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { STATUS_KEY } from "../index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, "..");

interface Seen {
  statuses: Array<string | undefined>;
  notifies: string[];
}

function makeUi(): { ui: ExtensionUIContext; seen: Seen } {
  const seen: Seen = { statuses: [], notifies: [] };
  const ui = {
    setStatus: (key: string, text: string | undefined) => {
      if (key === STATUS_KEY) seen.statuses.push(text);
    },
    notify: (message: string) => {
      seen.notifies.push(message);
    },
    setWidget: () => {},
    select: async () => undefined,
    input: async () => undefined,
    confirm: async () => true,
  } as unknown as ExtensionUIContext;
  return { ui, seen };
}

/** 一棵真实的小项目树：src/AGENTS.md + src/components/{AGENTS.md,Button.tsx}。 */
function makeProject(): { cwd: string; cleanup: () => void } {
  // realpath 归一：与 canonicalize 同一坐标系（Windows 临时目录大小写差异会造成假红）。
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dir-context-host-")));
  fs.mkdirSync(path.join(cwd, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "根约定（pi 已加载，插件不得重复注入）");
  fs.writeFileSync(path.join(cwd, "src", "AGENTS.md"), "src 约定");
  fs.writeFileSync(path.join(cwd, "src", "components", "AGENTS.md"), "组件约定");
  fs.writeFileSync(path.join(cwd, "src", "components", "Button.tsx"), "export const Button = 1;\n");
  fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export {};\n");
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

async function startHarness(t: TestContext, cwd: string) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "dir-context-agent-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([EXT_DIR], cwd, agentDir, createEventBus());
  assert.deepEqual(loaded.errors, [], "扩展加载必须无错（jiti 走真实 index.ts）");
  assert.equal(loaded.extensions.length, 1);

  const actions = { getAllTools: () => [] } as unknown as ExtensionActions;
  const contextActions: ExtensionContextActions = {
    getModel: () => undefined,
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
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, {} as SessionManager, {} as ModelRegistry);
  runner.bindCore(actions, contextActions);
  const { ui, seen } = makeUi();
  runner.setUIContext(ui, "tui");
  await runner.emit({ type: "session_start", reason: "startup" });
  return { runner, seen };
}

function toolResult(input: {
  toolName: ToolResultEvent["toolName"];
  toolInput: Record<string, unknown>;
  text?: string;
  isError?: boolean;
  parentToolCallId?: string;
}): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-1",
    toolName: input.toolName,
    input: input.toolInput,
    content: [{ type: "text", text: input.text ?? "工具原始输出" }],
    isError: input.isError ?? false,
    details: undefined,
    ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
  } as ToolResultEvent;
}

function injectedText(result: { content?: unknown } | undefined): string {
  assert.ok(result?.content, "必须返回替换后的 content");
  const blocks = result.content as Array<{ type: string; text: string }>;
  return blocks
    .slice(1)
    .map((b) => b.text)
    .join("\n");
}

test("read 深层文件：注入祖先链（由外向内），原内容逐字保留为前缀", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const result = await h.runner.emitToolResult(
    toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, text: "export const Button = 1;\n" }),
  );
  const blocks = (result?.content ?? []) as Array<{ type: string; text: string }>;
  assert.equal(blocks[0]?.text, "export const Button = 1;\n", "原结果必须是第一个块且逐字未改");
  const text = injectedText(result);
  assert.match(text, /Loaded src\/AGENTS\.md/);
  assert.match(text, /Loaded src\/components\/AGENTS\.md/);
  assert.match(text, /<dir-context path="src\/components\/AGENTS\.md">/);
  assert.ok(text.indexOf("src 约定") < text.indexOf("组件约定"), "由外向内：祖先在前");
  assert.doesNotMatch(text, /根约定/, "cwd 自身的上下文文件 pi 已加载，不得重复注入");
  assert.doesNotMatch(text, /Loaded AGENTS\.md\n/, "更不得注入 cwd 根文件");
});

test("同会话重复触碰同一目录：第二次起零注入", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const first = await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" } }));
  assert.ok(first?.content, "首次必须注入");
  const second = await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" } }));
  assert.equal(second, undefined, "同文件重复读：handler 返回 undefined（透传原结果）");
});

test("session_compact 后：缓存清空，同一文件可再次注入（= Claude 的按需重载）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  assert.ok((await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" } })))?.content);
  await h.runner.emit({ type: "session_compact", compactionEntry: {} as never, fromExtension: false, reason: "manual", willRetry: false });
  const after = await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" } }));
  assert.ok(after?.content, "compact 后必须重新注入（否则那段上下文永久丢失）");
});

test("write 到尚不存在的新文件：同样触发（两个现成扩展没有的能力）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const result = await h.runner.emitToolResult(
    toolResult({ toolName: "write", toolInput: { path: "src/components/New.tsx", content: "x" }, text: "已写入" }),
  );
  const text = injectedText(result);
  assert.match(text, /Loaded src\/components\/AGENTS\.md/);
});

test("ls 目录：算触碰，注入该目录的祖先链", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const ls = await h.runner.emitToolResult(toolResult({ toolName: "ls", toolInput: { path: "src/components" } }));
  const text = injectedText(ls);
  assert.match(text, /Loaded src\/AGENTS\.md/);
  assert.match(text, /Loaded src\/components\/AGENTS\.md/);
});

test("bash 单文件读：算触碰（cat/head/tail）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const bash = await h.runner.emitToolResult(toolResult({ toolName: "bash", toolInput: { command: "cat src/index.ts" } }));
  assert.match(injectedText(bash), /Loaded src\/AGENTS\.md/);
});

test("bash 非读命令：零注入（不会因为出现在命令里就认定碰了目录）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  assert.equal(await h.runner.emitToolResult(toolResult({ toolName: "bash", toolInput: { command: "npm test -- src/index.ts" } })), undefined);
});

test("edit：触发所在目录链", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const result = await h.runner.emitToolResult(
    toolResult({ toolName: "edit", toolInput: { path: "src/index.ts", edits: [{ oldText: "a", newText: "b" }] } }),
  );
  assert.match(injectedText(result), /Loaded src\/AGENTS\.md/);
});

test("失败结果 / 非触发工具 / cwd 之外 / 嵌套调用：逐字不变（返回 undefined）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, isError: true })),
    undefined,
    "isError 结果不注入",
  );
  assert.equal(await h.runner.emitToolResult(toolResult({ toolName: "grep", toolInput: { pattern: "x", path: "src" } })), undefined);
  assert.equal(await h.runner.emitToolResult(toolResult({ toolName: "find", toolInput: { pattern: "x", path: "src" } })), undefined);
  assert.equal(await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "../outside.ts" } })), undefined, "cwd 之外零注入");
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "AGENTS.md" } })),
    undefined,
    "cwd 直属文件（含 cwd 自己的 AGENTS.md）：无嵌套链可注，零注入",
  );
  assert.equal(
    await h.runner.emitToolResult(
      toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, parentToolCallId: "parent-1" }),
    ),
    undefined,
    "嵌套调用（codemode 等）：结果只回到调用方工具，注入无意义",
  );
});

test("状态条：注入后写一个计数状态（走 status-band 前缀协调）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);
  assert.deepEqual(h.seen.statuses.filter((text) => text !== undefined), [], "会话启动期不写可见状态（写 undefined 只是清登记）");

  await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" } }));
  assert.equal(h.seen.statuses.filter((text) => text !== undefined).length, 1);
  assert.match(h.seen.statuses.at(-1) ?? "", /dir-context/);
});

test("命令面：裸 dir-context 与 dir-context:status 都已注册且能列清单", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const names = h.runner.getRegisteredCommands().map((c) => c.name);
  assert.ok(names.includes("dir-context"), `缺少裸命令：${names.join(",")}`);
  assert.ok(names.includes("dir-context:status"), `缺少 dir-context:status：${names.join(",")}`);

  await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" } }));
  const command = h.runner.getCommand("dir-context:status");
  assert.ok(command, "命令必须可解析");
  await command.handler("", h.runner.createCommandContext());
  assert.ok(
    h.seen.notifies.some((message) => message.includes("src/components/AGENTS.md")),
    `命令输出必须列出已注入文件：${JSON.stringify(h.seen.notifies)}`,
  );
});
