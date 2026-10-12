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
 *
 * 远端调用（入参带 `remote`）也走这套真实路径：判据只看字段，但「命中后到底还注不注入」
 * 必须在真实 runner 上锁——纸面单测盖不住 handler 的分流。
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
import { REMOTE_CONTEXT_CHANNEL } from "../remote-context.ts";
import { REMOTE_NOTICE } from "../remote.ts";

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

/** 一棵真实的小项目树：src/AGENTS.md + src/components/{AGENTS.md,Button.tsx} + docs/AGENTS.md。 */
function makeProject(): { cwd: string; cleanup: () => void } {
  // realpath 归一：与 canonicalize 同一坐标系（Windows 临时目录大小写差异会造成假红）。
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dir-context-host-")));
  fs.mkdirSync(path.join(cwd, "src", "components"), { recursive: true });
  // docs/ 是给「远端触碰不得泄进注入」那组用例的诱饵：它不在任何本地触碰的目录链上。
  fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "根约定（pi 已加载，插件不得重复注入）");
  fs.writeFileSync(path.join(cwd, "src", "AGENTS.md"), "src 约定");
  fs.writeFileSync(path.join(cwd, "src", "components", "AGENTS.md"), "组件约定");
  fs.writeFileSync(path.join(cwd, "src", "components", "Button.tsx"), "export const Button = 1;\n");
  fs.writeFileSync(path.join(cwd, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(cwd, "docs", "AGENTS.md"), "docs 约定（只在被本地触碰时该出现）");
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

async function startHarness(t: TestContext, cwd: string, offerRemoteContext?: (box: Record<string, unknown>) => void) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "dir-context-agent-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  // 假的远端取文件能力必须**先**订阅再让 index.ts 在 session_start 广播盒子（真实握手时序）。
  const bus = createEventBus();
  if (offerRemoteContext !== undefined) {
    bus.on(REMOTE_CONTEXT_CHANNEL, (box) => offerRemoteContext(box as Record<string, unknown>));
  }
  const loaded = await discoverAndLoadExtensions([EXT_DIR], cwd, agentDir, bus);
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
  /** 宿主真实形状：read/bash 都产出结构化结果（回归用）。 */
  structuredContent?: unknown;
  /** 扩展工具的 details（如 codemode 的嵌套调用明细）。 */
  details?: unknown;
  /** 顶层调用 id（默认 call-1）；嵌套事件的 `parentToolCallId` 要指向它才能归到同一组。 */
  toolCallId?: string;
  /** false = 无文本内容（纯图片结果），用于验证不注入。 */
  hasText?: boolean;
}): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: input.toolCallId ?? "call-1",
    toolName: input.toolName,
    input: input.toolInput,
    content:
      input.hasText === false
        ? [{ type: "image" as const, data: "aGk=", mimeType: "image/png" }]
        : [{ type: "text" as const, text: input.text ?? "工具原始输出" }],
    isError: input.isError ?? false,
    details: input.details,
    ...(input.structuredContent !== undefined ? { structuredContent: input.structuredContent as never } : {}),
    ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
  } as ToolResultEvent;
}

/**
 * 真实 `CodemodeToolDetails` 形状：calls 是宿主的嵌套调用明细（`previewArgs` 的紧凑 JSON）。
 * 传字符串则原样当 `args` 用（用于锁定截断/非法 JSON 的降级）。
 */function codemodeDetails(calls: Array<{ name: string; args: unknown; status?: string }>): unknown {
  return {
    calls: calls.map((call, index) => ({
      id: `call-1/${index + 1}`,
      name: call.name,
      args: typeof call.args === "string" ? call.args : JSON.stringify(call.args),
      status: call.status ?? "ok",
    })),
  };
}

/**
 * 真实嵌套调用的 tool_result 事件形状（宿主 `_afterToolCall(…, parentToolCallId)`）：
 * `input` 是**完整**入参，`toolCallId` 形如 `<顶层 id>/<n>`，`parentToolCallId` = 顶层 id。
 */
function nestedCall(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  parentToolCallId: string;
  index?: number;
  isError?: boolean;
}): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: `${input.parentToolCallId}/${input.index ?? 1}`,
    toolName: input.toolName,
    input: input.toolInput,
    content: [{ type: "text" as const, text: "工具原始输出" }],
    isError: input.isError ?? false,
    details: undefined,
    parentToolCallId: input.parentToolCallId,
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

test("同 turn 重复触碰同一目录：第二次起只补一行指针，不再静默（dir-context-todo#10）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const target = { toolName: "read" as const, toolInput: { path: "src/components/Button.tsx" } };
  const first = await h.runner.emitToolResult(toolResult({ ...target, toolCallId: "call-1" }));
  assert.ok(first?.content, "首次必须注入");
  assert.match(injectedText(first), /<dir-context path="src\/components\/AGENTS\.md">/, "首次给正文");

  const second = await h.runner.emitToolResult(toolResult({ ...target, toolCallId: "call-2" }));
  const pointer = injectedText(second);
  assert.match(pointer, /<dir-context ref="src\/AGENTS\.md" /, "同 turn 的后续触碰：祖先链补指针");
  assert.match(pointer, /<dir-context ref="src\/components\/AGENTS\.md" /);
  assert.doesNotMatch(pointer, /src 约定|组件约定/, "指针不带正文（正文已在同一 turn 的另一个结果里）");
  assert.equal(
    h.seen.statuses.filter((text) => text !== undefined).length,
    1,
    "指针不进状态段计数（同一份文件只算一次）",
  );
});

test("新 turn（turn_start）后同一目录：零注入（跨 turn 去重保留）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  assert.ok((await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" } })))?.content);
  await h.runner.emit({ type: "turn_start", turnIndex: 2, timestamp: Date.now() });
  const next = await h.runner.emitToolResult(
    toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, toolCallId: "call-2" }),
  );
  assert.equal(next, undefined, "跨 turn 已注入过 ⇒ 透传原结果（不再重复唠叨，也不出指针）");
});

test("同一条消息里的并发触碰：恰好一个结果拿正文、另一个拿指针（dir-context-todo#10）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const target = { toolName: "read" as const, toolInput: { path: "src/components/Button.tsx" } };
  const [a, b] = await Promise.all([
    h.runner.emitToolResult(toolResult({ ...target, toolCallId: "call-1" })),
    h.runner.emitToolResult(toolResult({ ...target, toolCallId: "call-2" })),
  ]);
  const texts = [injectedText(a), injectedText(b)];
  assert.equal(texts.filter((text) => text.includes('<dir-context path="src/AGENTS.md">')).length, 1, "恰好一个结果带正文");
  assert.equal(texts.filter((text) => text.includes('<dir-context ref="src/AGENTS.md" ')).length, 1, "另一个结果必须带指针");
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

test("宿主契约回归：注入后 structuredContent 必须原样保留（read/bash 都产出它）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  // 宿主明文契约：替换 content 而不回传 structuredContent 会把它删掉
  //（ToolResultEventResult + runner 的 delete）——丢弃结构化结果 = 静默改坏原结果。
  const structured = { file: { path: "src/components/Button.tsx" }, truncated: false };
  const result = await h.runner.emitToolResult(
    toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, structuredContent: structured }),
  );
  assert.ok(result?.content, "必须注入");
  assert.deepEqual(result.structuredContent, structured, "structuredContent 必须逐字保留");
});

test("无文本内容的结果（纯图片）：不注入", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  assert.equal(
    await h.runner.emitToolResult(
      toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, hasText: false }),
    ),
    undefined,
  );
});

const COMPACT_EVENT = {
  type: "session_compact",
  compactionEntry: {} as never,
  fromExtension: false,
  reason: "manual",
  willRetry: false,
} as const;

test("远端相对路径：零注入本机上下文 + 一行提示（dir-context-todo#4 核心回归）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  // 本机**确实存在** src/components/AGENTS.md：修复前这条远端调用会按本地 cwd 解析
  // 并把它注入进去（把本机约定当远端目录的约定喂给模型）。
  const structured = { file: { path: "src/components/Button.tsx" } };
  const result = await h.runner.emitToolResult(
    toolResult({
      toolName: "read",
      toolInput: { path: "src/components/Button.tsx", remote: "prod" },
      text: "远端文件内容",
      structuredContent: structured,
    }),
  );

  const blocks = (result?.content ?? []) as Array<{ type: string; text: string }>;
  assert.equal(blocks.length, 2, "只追加一个 text block");
  assert.equal(blocks[0]?.text, "远端文件内容", "原结果必须是第一个块且逐字未改");
  assert.match(blocks[1]?.text ?? "", /远端调用/, "首次远端触碰给一行提示");
  assert.doesNotMatch(blocks[1]?.text ?? "", /Loaded|dir-context path=/, "远端路径不得按本机 cwd 注入");
  assert.deepEqual(result?.structuredContent, structured, "structuredContent 必须逐字保留");
  assert.deepEqual(h.seen.statuses.filter((text) => text !== undefined), [], "远端调用不写注入状态");
});

test("远端绝对路径：同样零注入（同样不看 path）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const result = await h.runner.emitToolResult(
    toolResult({ toolName: "read", toolInput: { path: "/srv/app/docs/x.md", remote: "prod" } }),
  );
  const text = injectedText(result);
  assert.doesNotMatch(text, /Loaded/, "远端绝对路径本就不该注入");
  assert.match(text, /远端调用/);
});

test("本地调用逐字不变：字段缺失 / 空串 / 纯空白 / 缺省值字面量 / 非字符串都照常注入", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const variants: Array<Record<string, unknown>> = [
    { path: "src/components/Button.tsx" }, // 没装 remote-tools 时的形状（字段根本不存在）
    { path: "src/components/Button.tsx", remote: "" },
    { path: "src/components/Button.tsx", remote: "   " },
    { path: "src/components/Button.tsx", remote: "null" },
    { path: "src/components/Button.tsx", remote: "None" },
    { path: "src/components/Button.tsx", remote: 42 },
  ];
  for (const toolInput of variants) {
    // compact 只为清空「已注入」缓存，让每个变体都真的走一次注入路径（与本用例无关的提示同时重置）。
    await h.runner.emit(COMPACT_EVENT);
    const text = injectedText(await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput })));
    assert.match(text, /Loaded src\/components\/AGENTS\.md/, JSON.stringify(toolInput));
    assert.doesNotMatch(text, /远端调用/, `本地调用不得出现远端提示：${JSON.stringify(toolInput)}`);
  }
});

test("远端提示：会话内只给一次（compact 后可再来一次）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  assert.match(
    injectedText(await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "a.md", remote: "prod" } }))),
    /远端调用/,
  );
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "b.md", remote: "prod" } })),
    undefined,
    "第二次远端调用：纯透传（不再提示、也不注入）",
  );
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "ls", toolInput: { path: "src", remote: "prod" } })),
    undefined,
    "ls 与 read 同一视同仁（判据覆盖全部触发工具）",
  );

  await h.runner.emit(COMPACT_EVENT);
  assert.match(
    injectedText(await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "c.md", remote: "prod" } }))),
    /远端调用/,
    "compact 会把之前的注入从上下文里抹掉，提示同理要能重放",
  );
});

test("远端提示不污染失败结果与纯图片结果，也不消耗「首次」配额", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  assert.equal(
    await h.runner.emitToolResult(
      toolResult({ toolName: "read", toolInput: { path: "a.md", remote: "prod" }, isError: true }),
    ),
    undefined,
    "isError：尾部追加只会污染错误诊断",
  );
  assert.equal(
    await h.runner.emitToolResult(
      toolResult({ toolName: "read", toolInput: { path: "b.md", remote: "prod" }, hasText: false }),
    ),
    undefined,
    "无文本内容：追加没有落点",
  );
  assert.match(
    injectedText(await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "c.md", remote: "prod" } }))),
    /远端调用/,
    "前两次没消耗配额：第一个可用结果仍能提示",
  );
});

test("codemode 脚本里的远端调用：不注入本机同名路径，提示落到顶层结果", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  // 宿主真实形状：嵌套 tool_result 先到（input 是完整入参），顶层 codemode 结果后到。
  await h.runner.emitToolResult(
    nestedCall({
      toolName: "read",
      toolInput: { path: "src/components/Button.tsx", remote: "prod" },
      parentToolCallId: "call-9",
    }),
  );
  const top = await h.runner.emitToolResult(
    toolResult({ toolName: "codemode", toolInput: { code: "export default 1" }, toolCallId: "call-9", details: codemodeDetails([]) }),
  );
  const text = injectedText(top);
  assert.doesNotMatch(text, /Loaded/, "嵌套的远端触碰不得在顶层结果里注入本机上下文");
  assert.match(text, /远端调用/, "脚本内的结果模型看不到，提示必须落到顶层结果");

  // details 是独立于嵌套事件的第二条来源，同样要拦。
  assert.equal(
    await h.runner.emitToolResult(
      toolResult({
        toolName: "codemode",
        toolInput: { code: "export default 1" },
        toolCallId: "call-10",
        details: codemodeDetails([{ name: "read", args: { path: "src/index.ts", remote: "prod" } }]),
      }),
    ),
    undefined,
    "details 里的远端调用不注入（提示已发过 ⇒ 纯透传）",
  );
});

test("远端调用不限定工具：顶层 remote bash 与 grep 同样零注入、同样只给一次提示", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  // grep 不在触发面上（恒零注入）；带 remote 时它照样吃那行提示（附着面按字段，不按工具）。
  const grep = await h.runner.emitToolResult(
    toolResult({ toolName: "grep", toolInput: { pattern: "x", path: "src", remote: "prod" } }),
  );
  const grepText = injectedText(grep);
  assert.doesNotMatch(grepText, /Loaded/, "grep 本就不在触发面上");
  assert.match(grepText, /远端调用/, "带 remote 的 grep 结果同样吃那行提示（附着面按字段）");

  // bash 在触发面上但命中远端 ⇒ 零注入；提示已用掉 ⇒ 纯透传。
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "bash", toolInput: { command: "cat src/index.ts", remote: "prod" } })),
    undefined,
    "远端 bash：既不注入、也不再重复提示",
  );
});

test("codemode 混合：本地触碰照注入、远端触碰对注入内容零贡献（只多一行提示）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);

  /**
   * 同一棵树跑两次：一次只有本地嵌套读，一次再叠一条远端嵌套读。
   *
   * 远端那条必须挑一个**不在本地触碰目录链上**的路径（docs/），否则「既记又标」（嵌套分支漏
   * `return`：远端触碰既 markRemote 又 record）这种错误会被去重抹平，等式照样成立——断言就形同
   * 虚设（评审 round 2 的 P2-3）。
   */
  const run = async (withRemote: boolean): Promise<string> => {
    const h = await startHarness(t, project.cwd);
    await h.runner.emitToolResult(
      nestedCall({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, parentToolCallId: "call-m", index: 1 }),
    );
    if (withRemote) {
      await h.runner.emitToolResult(
        nestedCall({ toolName: "read", toolInput: { path: "docs/remote-only.ts", remote: "prod" }, parentToolCallId: "call-m", index: 2 }),
      );
    }
    const top = await h.runner.emitToolResult(
      toolResult({ toolName: "codemode", toolInput: { code: "export default 1" }, toolCallId: "call-m", details: codemodeDetails([]) }),
    );
    return injectedText(top);
  };

  const localOnly = await run(false);
  const mixed = await run(true);
  assert.match(localOnly, /Loaded src\/AGENTS\.md/);
  assert.match(localOnly, /Loaded src\/components\/AGENTS\.md/);
  assert.doesNotMatch(localOnly, /docs\/AGENTS\.md/, "对照组里 docs/ 不该出现（它只被远端触碰过）");
  assert.equal(mixed, `${localOnly}\n${REMOTE_NOTICE}`, "远端触碰对注入内容零贡献：只在末尾多一行提示");
});

test("codemode 顶层结果失败：组照旧消费（不跨结果残留），远端提示的配额不消耗", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  await h.runner.emitToolResult(
    nestedCall({
      toolName: "read",
      toolInput: { path: "src/components/Button.tsx", remote: "prod" },
      parentToolCallId: "call-f",
    }),
  );
  assert.equal(
    await h.runner.emitToolResult(
      toolResult({ toolName: "codemode", toolInput: { code: "export default 1" }, toolCallId: "call-f", isError: true, details: codemodeDetails([]) }),
    ),
    undefined,
    "失败的顶层结果不追加任何文本",
  );
  // 同一组已被取走：即使该次结果失败，下一条本地触碰也不会平白多出注入。
  assert.match(
    injectedText(await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/index.ts" } }))),
    /Loaded src\/AGENTS\.md/,
    "组已消费（不残留）+ 本地正常注入（src/components 尚未注过）",
  );
  // 配额未消耗：后面真正的远端调用仍能拿到提示。
  assert.match(
    injectedText(await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "a.md", remote: "prod" } }))),
    /远端调用/,
    "失败结果不消耗「首次」配额",
  );
});

/**
 * 假提供方：直接挂在真实 `EventBus` 的收集频道上，形状与 remote-tools 的 `context.ts` 一致
 * （只省掉真 ssh）。真机对照见交付报告。
 */
function remoteProvider(files: Array<[string, string]>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    offer: (box: Record<string, unknown>): void => {
      box.remoteContext = {
        fetchRemoteContext: async (request: Record<string, unknown>) => {
          calls.push(request);
          return { ok: true, dir: "/home/u/docs", files: files.map(([path, content]) => ({ path, content })) };
        },
      };
    },
  };
}

test("远端上下文自动注入：块头带来源、不再出现提示行、本机同名路径零泄漏", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const provider = remoteProvider([["/home/u/docs/AGENTS.md", "远端 docs 约定"]]);
  const h = await startHarness(t, project.cwd, provider.offer);

  // 本机**确实存在** docs/AGENTS.md（诱饵）：注入的必须是远端那份，绝不能是同名本机文件。
  const result = await h.runner.emitToolResult(
    toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" }, text: "远端文件内容" }),
  );
  const text = injectedText(result);
  assert.match(text, /Loaded prod:\/home\/u\/docs\/AGENTS\.md/);
  assert.match(text, /<dir-context remote="prod" path="\/home\/u\/docs\/AGENTS\.md">/);
  assert.match(text, /远端 docs 约定/);
  assert.doesNotMatch(text, /Loaded docs\/AGENTS\.md/, "本机同名路径的诱饵绝不出现（dir-context-todo#4 的不回归）");
  assert.doesNotMatch(text, /远端调用/, "注入成功就不再有那行提示");
  assert.deepEqual(provider.calls, [{ remote: "prod", path: "docs/x.md", kind: "file" }], "请求带原始路径与 kind（由提供方解析）");
  assert.equal(h.seen.statuses.filter((status) => status !== undefined).length, 1, "远端注入也计进状态段");
});

test("远端能力取不到（ok:false）⇒ 不注入、退回那行提示", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd, (box) => {
    box.remoteContext = { fetchRemoteContext: async () => ({ ok: false, code: "BOOM", message: "ssh 挂了" }) };
  });

  const text = injectedText(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" } })),
  );
  assert.doesNotMatch(text, /Loaded/);
  assert.match(text, /远端调用/);
});

test("同一远端目录第二次调用：纯透传（已注入过不是失败，也不再提示）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const provider = remoteProvider([["/home/u/docs/AGENTS.md", "远端 docs 约定"]]);
  const h = await startHarness(t, project.cwd, provider.offer);

  assert.match(
    injectedText(await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" } }))),
    /Loaded prod:/,
  );
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/y.md", remote: "prod" } })),
    undefined,
    "没有新内容可注 ⇒ 既不重复注入也不弹提示",
  );
  assert.equal(provider.calls.length, 2, "仍然照常问了一次（对端只是没给新东西）");
});

test("不在触发面上的工具（grep）带 remote：不花那趟 ssh，只给提示", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const provider = remoteProvider([["/home/u/AGENTS.md", "x"]]);
  const h = await startHarness(t, project.cwd, provider.offer);

  const text = injectedText(
    await h.runner.emitToolResult(toolResult({ toolName: "grep", toolInput: { pattern: "x", path: "src", remote: "prod" } })),
  );
  assert.match(text, /远端调用/);
  assert.equal(provider.calls.length, 0, "不在触发面上就不取远端上下文");
});

test("codemode 脚本里的远端触碰：在**顶层**结果注入（脚本内的结果模型看不到）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const provider = remoteProvider([["/home/u/docs/AGENTS.md", "远端 docs 约定"]]);
  const h = await startHarness(t, project.cwd, provider.offer);

  await h.runner.emitToolResult(
    nestedCall({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" }, parentToolCallId: "call-r" }),
  );
  const top = await h.runner.emitToolResult(
    toolResult({ toolName: "codemode", toolInput: { code: "export default 1" }, toolCallId: "call-r", details: codemodeDetails([]) }),
  );
  const text = injectedText(top);
  assert.match(text, /Loaded prod:\/home\/u\/docs\/AGENTS\.md/);
  assert.doesNotMatch(text, /远端调用/, "注入成功就不再有提示");
});

test("远端请求去重与 kind 传递：同一脚本重复碰同目录只问一次，ls 传 directory", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const provider = remoteProvider([["/home/u/docs/AGENTS.md", "远端 docs 约定"]]);
  const h = await startHarness(t, project.cwd, provider.offer);

  // 同一脚本里两次碰**同一个**远端文件（路径 + kind 全同）⇒ 去重成一次请求。
  await h.runner.emitToolResult(
    nestedCall({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" }, parentToolCallId: "call-d", index: 1 }),
  );
  await h.runner.emitToolResult(
    nestedCall({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" }, parentToolCallId: "call-d", index: 2 }),
  );
  await h.runner.emitToolResult(
    toolResult({ toolName: "codemode", toolInput: { code: "export default 1" }, toolCallId: "call-d", details: codemodeDetails([]) }),
  );
  assert.deepEqual(provider.calls, [{ remote: "prod", path: "docs/x.md", kind: "file" }], "同路径同 kind 只问一次");

  // `ls` 带 remote ⇒ kind 必须传 directory（提供方据此把该目录**自身**当锚点）。
  const ls = remoteProvider([["/home/u/docs/AGENTS.md", "远端 docs 约定"]]);
  const h2 = await startHarness(t, project.cwd, ls.offer);
  assert.match(
    injectedText(await h2.runner.emitToolResult(toolResult({ toolName: "ls", toolInput: { path: "docs", remote: "prod" } }))),
    /Loaded prod:/,
  );
  assert.deepEqual(ls.calls, [{ remote: "prod", path: "docs", kind: "directory" }]);
});

test("部分失败：只要有请求取不到且这次什么都没注成 ⇒ 退回提示行（不猜成「远端没有约定文件」）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const calls: Array<Record<string, unknown>> = [];
  const h = await startHarness(t, project.cwd, (box) => {
    box.remoteContext = {
      fetchRemoteContext: async (request: Record<string, unknown>) => {
        calls.push(request);
        return request.path === "docs/a.md"
          ? { ok: false, code: "BOOM", message: "这一条 ssh 挂了" }
          : { ok: true, dir: "/home/u/docs", files: [] };
      },
    };
  });

  await h.runner.emitToolResult(
    nestedCall({ toolName: "read", toolInput: { path: "docs/a.md", remote: "prod" }, parentToolCallId: "call-p", index: 1 }),
  );
  await h.runner.emitToolResult(
    nestedCall({ toolName: "read", toolInput: { path: "docs/b.md", remote: "prod" }, parentToolCallId: "call-p", index: 2 }),
  );
  const top = await h.runner.emitToolResult(
    toolResult({ toolName: "codemode", toolInput: { code: "export default 1" }, toolCallId: "call-p", details: codemodeDetails([]) }),
  );
  assert.equal(calls.length, 2, "两个不同路径各问一次");
  const text = injectedText(top);
  assert.doesNotMatch(text, /Loaded/);
  assert.match(text, /远端调用/, "取不到就说取不到");
});

test("远端注入与本地共用预算：超 32 KiB 按同一口径码点截断", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const provider = remoteProvider([["/home/u/docs/AGENTS.md", "x".repeat(40 * 1024)]]);
  const h = await startHarness(t, project.cwd, provider.offer);

  const text = injectedText(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" } })),
  );
  assert.match(text, /\[truncated to 32768 bytes of 40960 bytes\]/);
});

test("畸形能力载荷：notify 一次并退回提示行（不抛、不破坏会话）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd, (box) => {
    box.remoteContext = "垃圾";
  });

  assert.equal(h.seen.notifies.length, 1);
  assert.match(h.seen.notifies[0] ?? "", /畸形/);
  const text = injectedText(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" } })),
  );
  assert.match(text, /远端调用/);
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

// —— codemode 补偿路径（v1.1 / ADR-0012）：脚本里的嵌套调用本身不注入，但它的**顶层**
// codemode 结果带着 `details.calls`，在那里把「脚本碰了哪些目录」翻译回同一套触碰语义。

test("预算耗尽被丢弃的文件不算已注入：下次触碰仍能注入（并集让这条路径成为常态）", async (t) => {
  // 五级目录 × 各 32 KiB（单文件上限）⇒ 合计 160 KiB > 单次 128 KiB 上限，
  // 最后一个（最靠近锚点的）被预算丢弃。它元数据进了 injected 的话，
  // 后续触碰会因「已注入」而永久拿不到那份上下文——与读取失败的重试语义矛盾。
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dir-context-budget-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const deep = path.join(cwd, "a", "b", "c", "d", "e");
  fs.mkdirSync(deep, { recursive: true });
  const filler = "x".repeat(32 * 1024);
  const dirOf = { a: path.join(cwd, "a"), b: path.join(cwd, "a", "b"), c: path.join(cwd, "a", "b", "c"), d: path.join(cwd, "a", "b", "c", "d"), e: deep };
  for (const [name, dir] of Object.entries(dirOf)) fs.writeFileSync(path.join(dir, "AGENTS.md"), `${name}${filler}`);

  const h = await startHarness(t, cwd);
  const first = await h.runner.emitToolResult(
    toolResult({ toolName: "read", toolInput: { path: "a/b/c/d/e/x.ts" } }),
  );
  const firstText = injectedText(first);
  assert.doesNotMatch(firstText, /Loaded a\/b\/c\/d\/e\/AGENTS\.md/, "最后一份超过单次预算，本次必然被丢弃");
  assert.match(firstText, /skipped \(injection budget exhausted\): a\/b\/c\/d\/e\/AGENTS\.md/, "丢弃必须在块内留标记");

  // 清单与去重缓存同源：被丢弃的那份不得出现在 /dir-context 的已注入清单里（计数 = 4）。
  const command = h.runner.getCommand("dir-context:status");
  assert.ok(command, "命令必须可解析");
  await command.handler("", h.runner.createCommandContext());
  const listed = h.seen.notifies.at(-1) ?? "";
  assert.match(listed, /已注入 4 个嵌套上下文文件/, `清单计数必须只数真正注入的文件：${listed}`);
  assert.doesNotMatch(listed, /a\/b\/c\/d\/e\/AGENTS\.md/, "被预算丢弃的不算已注入");

  const second = await h.runner.emitToolResult(
    toolResult({ toolName: "read", toolInput: { path: "a/b/c/d/e/y.ts" } }),
  );
  assert.match(injectedText(second), /Loaded a\/b\/c\/d\/e\/AGENTS\.md/, "被预算丢弃 ≠ 已注入：下次触碰应当补上");
  await command.handler("", h.runner.createCommandContext());
  assert.match(h.seen.notifies.at(-1) ?? "", /已注入 5 个嵌套上下文文件/, "补上后清单计数跟进（4 → 5）");
});

test("codemode 顶层结果：按 details.calls 一次注入并集，原 content 与 details 逐字保留", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const original = "Script completed\nWall time 0.1 seconds\nOutput:\n已读完\n";
  const details = codemodeDetails([
    { name: "read", args: { path: "src/components/Button.tsx" } },
    { name: "bash", args: { command: "cat src/index.ts" } },
  ]);
  const result = await h.runner.emitToolResult(
    toolResult({ toolName: "codemode", toolInput: { code: "…" }, text: original, details }),
  );

  const blocks = (result?.content ?? []) as Array<{ type: string; text: string }>;
  assert.equal(blocks.length, 2, "只追加一个 text block（一次注入）");
  assert.equal(blocks[0]?.text, original, "原内容逐字保留在前");
  const text = blocks[1]?.text ?? "";
  assert.match(text, /Loaded src\/AGENTS\.md/);
  assert.match(text, /Loaded src\/components\/AGENTS\.md/);
  assert.equal(text.split("Loaded src/AGENTS.md").length - 1, 1, "并集：两个触碰共享的祖先只注入一次");
  assert.ok(text.indexOf("src 约定") < text.indexOf("组件约定"), "由外向内");
  assert.deepEqual(result?.details, details, "details 必须原样保留（宿主 runner 只替换显式返回的字段）");
});

test("codemode 与顶层共用同一份去重缓存：顶层注入过的文件在脚本里改出指针", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  assert.ok((await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" } })))?.content);
  const script = await h.runner.emitToolResult(
    toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: codemodeDetails([{ name: "read", args: { path: "src/components/Button.tsx" } }]) }),
  );
  const text = injectedText(script);
  assert.match(text, /<dir-context ref="src\/components\/AGENTS\.md" /, "同一 turn 内已注入 ⇒ 只补指针");
  assert.doesNotMatch(text, /组件约定/, "不重复正文");
  assert.equal(text.split("Loaded src/components/AGENTS.md").length - 1, 0, "指针不用 Loaded 前缀（正文计数保持可判）");

  await h.runner.emit({ type: "session_compact", compactionEntry: {} as never, fromExtension: false, reason: "manual", willRetry: false });
  assert.ok(
    (await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "src/components/Button.tsx" } })))?.content,
    "compact 后两者一并解禁（按需重载）",
  );
});

test("codemode 降级：失败脚本 / 空 calls / 截断 args / 非触碰工具 ⇒ 零注入，原结果透传", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);
  const emit = (details: unknown, isError = false) =>
    h.runner.emitToolResult(toolResult({ toolName: "codemode", toolInput: { code: "…" }, isError, details }));

  assert.equal(
    await emit(codemodeDetails([{ name: "read", args: { path: "src/components/Button.tsx" } }]), true),
    undefined,
    "脚本失败（isError）的 codemode 结果不注入",
  );
  assert.equal(await emit({ calls: [] }), undefined, "脚本没碰任何可认的路径");
  assert.equal(
    await emit(codemodeDetails([{ name: "grep", args: { pattern: "x", path: "src" } }, { name: "chat", args: "opencode-go/x" }])),
    undefined,
    "非触碰工具（含 models.*）零注入",
  );
  const truncated = `${JSON.stringify({ path: "src/components/Button.tsx", content: "x".repeat(400) }).slice(0, 197)}...`;
  assert.equal(await emit(codemodeDetails([{ name: "write", args: truncated }])), undefined, "args 截断 ⇒ 跳过该条（少注入，不误注入）");
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "some-tool", toolInput: {}, details: codemodeDetails([{ name: "read", args: { path: "src/components/Button.tsx" } }]) })),
    undefined,
    "同名形状但不是 codemode（工具名不同）⇒ 走普通路径，零注入",
  );
});

test("codemode 里触碰 cwd 之外 / 已注入过的组合：只注入未注入的部分", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  const result = await h.runner.emitToolResult(
    toolResult({
      toolName: "codemode",
      toolInput: { code: "…" },
      details: codemodeDetails([
        { name: "read", args: { path: "../outside.ts" } },
        { name: "ls", args: { path: "src/components" } },
      ]),
    }),
  );
  const text = injectedText(result);
  assert.match(text, /Loaded src\/components\/AGENTS\.md/);
  assert.doesNotMatch(text, /outside/, "cwd 之外的触碰不产生注入");
});

// —— 嵌套触碰缓冲（v1.2 / dir-context-todo#3）：主来源是嵌套 tool_result 事件的**完整 input**，
// `details.calls` 的截断预览降级为兜底。

test("嵌套调用的完整 input 是主来源：details.calls 为空（等价于 args 被截断）也照注入", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  // 脚本里的 tools.write 带 300 字符 content ⇒ 宿主的 previewArgs 截到 200 字符、不是合法 JSON；
  // 这里直接把 details.calls 喂空，模拟「预览不可用」——修复前必然零注入。
  await h.runner.emitToolResult(
    nestedCall({ toolName: "write", toolInput: { path: "src/components/New.tsx", content: "x".repeat(300) }, parentToolCallId: "call-1" }),
  );
  const result = await h.runner.emitToolResult(
    toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: { calls: [] } }),
  );
  const text = injectedText(result);
  assert.match(text, /Loaded src\/AGENTS\.md/);
  assert.match(text, /Loaded src\/components\/AGENTS\.md/);
});

test("嵌套调用自身零注入（结果只回脚本），其触碰被缓冲到顶层结果", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  assert.equal(
    await h.runner.emitToolResult(
      nestedCall({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, parentToolCallId: "call-1" }),
    ),
    undefined,
    "嵌套调用不改自己的结果",
  );
  assert.ok(
    (await h.runner.emitToolResult(toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: { calls: [] } })))?.content,
    "缓冲在顶层结果上兑现",
  );
});

test("两个来源取并集：details 的 read 路径 + 嵌套事件的 write 路径都算，同路径只注入一次", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  await h.runner.emitToolResult(
    nestedCall({ toolName: "write", toolInput: { path: "src/components/New.tsx", content: "x".repeat(300) }, parentToolCallId: "call-1" }),
  );
  const result = await h.runner.emitToolResult(
    toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: codemodeDetails([{ name: "read", args: { path: "src/index.ts" } }]) }),
  );
  const text = injectedText(result);
  assert.match(text, /Loaded src\/AGENTS\.md/);
  assert.match(text, /Loaded src\/components\/AGENTS\.md/);
  assert.equal(text.split("Loaded src/AGENTS.md").length - 1, 1, "两个触碰共享的祖先只注入一次");
});

test("归组隔离：另一个顶层调用的缓冲不串味（嵌套事件只归到自己的 parentToolCallId）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  await h.runner.emitToolResult(
    nestedCall({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, parentToolCallId: "call-A" }),
  );
  assert.equal(
    await h.runner.emitToolResult(
      toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: { calls: [] }, toolCallId: "call-B" }),
    ),
    undefined,
    "call-B 的顶层结果不得拿到 call-A 的缓冲",
  );
  assert.ok(
    (await h.runner.emitToolResult(
      toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: { calls: [] }, toolCallId: "call-A" }),
    ))?.content,
    "call-A 自己的顶层结果仍能兑现",
  );
});

test("缓冲在顶层结果处取走即清：失败的顶层结果也消费掉该组（不跨结果残留）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  await h.runner.emitToolResult(
    nestedCall({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, parentToolCallId: "call-1" }),
  );
  assert.equal(
    await h.runner.emitToolResult(
      toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: { calls: [] }, isError: true }),
    ),
    undefined,
    "脚本失败（isError）不注入",
  );
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: { calls: [] } })),
    undefined,
    "该组已在上一次结果处消费，不再重复兑现",
  );
});

test("嵌套调用失败（isError）照算其触碰：文件可能已被读写", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  await h.runner.emitToolResult(
    nestedCall({ toolName: "edit", toolInput: { path: "src/components/Button.tsx" }, parentToolCallId: "call-1", isError: true }),
  );
  assert.match(
    injectedText(await h.runner.emitToolResult(toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: { calls: [] } }))),
    /Loaded src\/components\/AGENTS\.md/,
  );
});

test("session_compact 清空缓冲：compact 后再来的顶层结果不再兑现旧触碰", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  await h.runner.emitToolResult(
    nestedCall({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, parentToolCallId: "call-1" }),
  );
  await h.runner.emit({ type: "session_compact", compactionEntry: {} as never, fromExtension: false, reason: "manual", willRetry: false });
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: { calls: [] } })),
    undefined,
    "compact 已清缓冲，且注入缓存也清了但这里没有触碰可注",
  );
});

test("顶层结果没有 details（形状漂移）时：缓冲照样消费，且缓冲触碰仍生效", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  await h.runner.emitToolResult(
    nestedCall({ toolName: "write", toolInput: { path: "src/components/New.tsx", content: "x".repeat(300) }, parentToolCallId: "call-1" }),
  );
  // details 缺失：主来源（缓冲）必须仍然生效——判「是不是 codemode」只能看工具名，不能看 details 形状。
  const result = await h.runner.emitToolResult(toolResult({ toolName: "codemode", toolInput: { code: "…" } }));
  assert.match(injectedText(result), /Loaded src\/components\/AGENTS\.md/);

  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "codemode", toolInput: { code: "…" } })),
    undefined,
    "该组已在上面那次结果处消费，不跨结果残留",
  );
});

test("session_start 也清空缓冲（与 compact 共用 reset）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const h = await startHarness(t, project.cwd);

  await h.runner.emitToolResult(
    nestedCall({ toolName: "read", toolInput: { path: "src/components/Button.tsx" }, parentToolCallId: "call-1" }),
  );
  await h.runner.emit({ type: "session_start", reason: "new" });
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "codemode", toolInput: { code: "…" }, details: { calls: [] } })),
    undefined,
    "session_start 已清缓冲",
  );
});


// ---------- 协议 v2 的消费侧：空内容归 nothing（dir-context-todo#9）+ 按码分流提示（#8） ----------

test("空内容的约定文件：不注入空块、不出提示、不进「已注入」（随后写入内容时同会话能拿到）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  const provider = remoteProvider([["/home/u/docs/AGENTS.md", ""]]);
  const h = await startHarness(t, project.cwd, provider.offer);

  // 0 字节的约定文件：注入一个空块是纯噪声，而且会被标成已注入 ⇒ 后来写入内容本会话也拿不到。
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" } })),
    undefined,
    "空内容 ⇒ nothing：连块都不追加（不是追加一个空块）",
  );
  assert.deepEqual(h.seen.statuses.filter((status) => status !== undefined), [], "没注入就不该写状态段");
  assert.equal(provider.calls.length, 1, "仍然照常问了一次（提供方照实上报空文件）");

  // 同一会话里文件后来有内容了：因为上次没标记「已注入」，这次应当真的注入。
  const later = remoteProvider([["/home/u/docs/AGENTS.md", "终于有内容了"]]);
  const h2 = await startHarness(t, project.cwd, later.offer);
  const text = injectedText(
    await h2.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" } })),
  );
  assert.match(text, /Loaded prod:\/home\/u\/docs\/AGENTS\.md/, "文件有内容后同会话即可拿到（证明上一次没被误标记）");
  assert.match(text, /终于有内容了/);
});

test("提示按码分流：读不出走专属文案，未知码回落通用文案（不摘要对端 message）", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);

  const unreadable = await startHarness(t, project.cwd, (box) => {
    box.remoteContext = {
      fetchRemoteContext: async () => ({ ok: false, code: "REMOTE_CONTEXT_UNREADABLE", message: "对端随手写的文案" }),
    };
  });
  const asked = injectedText(
    await unreadable.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" } })),
  );
  assert.match(asked, /读不出/, "专属文案");
  assert.match(asked, /权限/, "说清是权限问题（使用者的下一步动作不同）");
  assert.doesNotMatch(asked, /对端随手写的文案/, "按码不按文案：对端 message 不进提示");
  assert.doesNotMatch(asked, /自行 read/, "不能与「没装 remote-tools」那条通用提示同形");

  const unknown = await startHarness(t, project.cwd, (box) => {
    box.remoteContext = {
      fetchRemoteContext: async () => ({ ok: false, code: "SOME_FUTURE_CODE", message: "未来新增的失败因" }),
    };
  });
  const generic = injectedText(
    await unknown.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" } })),
  );
  assert.match(generic, /自行 read/, "未知码回落通用提示（前向兼容：新码不会让使用者什么都看不到）");
  assert.doesNotMatch(generic, /权限/, "未知码不得冒充「权限」");
});

test("提示按原因各记一次：权限提示出现过，不妨碍之后的通用失败仍给一次提示", async (t) => {
  const project = makeProject();
  t.after(project.cleanup);
  let mode: "unreadable" | "boom" = "unreadable";
  const h = await startHarness(t, project.cwd, (box) => {
    box.remoteContext = {
      fetchRemoteContext: async () =>
        mode === "unreadable"
          ? { ok: false, code: "REMOTE_CONTEXT_UNREADABLE", message: "读不出" }
          : { ok: false, code: "BOOM", message: "ssh 挂了" },
    };
  });

  const first = injectedText(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/x.md", remote: "prod" } })),
  );
  assert.match(first, /权限/);
  assert.equal(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/y.md", remote: "prod" } })),
    undefined,
    "同一种原因只给一次：第二次连 content 都不替换",
  );

  mode = "boom";
  const other = injectedText(
    await h.runner.emitToolResult(toolResult({ toolName: "read", toolInput: { path: "docs/z.md", remote: "prod" } })),
  );
  assert.match(other, /自行 read/, "换了原因要给一次通用提示（不被前一条挡掉）");
});
