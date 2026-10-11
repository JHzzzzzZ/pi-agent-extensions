/**
 * index.ts 接线测试：工具覆盖 + 命令面 + 会话生命周期（timeout-bg-todo#1）
 * 另含 codemode 视角的结构化结果锁定（timeout-bg-todo#2：脚本调 tools.bash 的返回值）。
 *
 * 边界说明：被测逻辑是"扩展如何接线到宿主"，因此 fake 的只有 pi API 表面
 * （事件/命令注册、sendMessage 记录）与进程边界（spawn），工具本体是宿主真实的
 * `createBashTool(..., { operations })` —— 超时路径确实走到宿主工具的错误渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createTimeoutBgExtension } from "../index.ts";
import { SHELL_CAPABILITY_CHANNEL } from "../shell-capability.ts";
import type { SpawnedProcess } from "../shell-ops.ts";

class FakeChild extends EventEmitter {
  pid = 9_001;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = null;
  emitData(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }
  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

interface SentMessage {
  message: { customType?: string; content?: unknown };
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

/** 脚本视角能看到的工具结果面（宿主 createBashTool 的返回值 + 结构化字段）。 */
interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  details?: { truncation?: { truncated?: boolean }; fullOutputPath?: string };
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  description?: string;
  promptGuidelines?: string[];
  parameters?: { properties?: Record<string, unknown> };
  outputSchema?: { properties?: Record<string, unknown> };
  execute: (...args: unknown[]) => Promise<unknown>;
}

/** 预置在 `getAllTools()` 里的工具（模拟别的扩展已注册 / 加载顺序更早）。 */
interface SeededTool {
  name: string;
  description?: string;
  path?: string;
}

interface FakePiSeed {
  tools?: SeededTool[];
  /** true = 预置工具在宿主 first-wins 语义下赢（预置名字的注册被丢弃）。 */
  foreignWins?: boolean;
  events?: EventBus;
}

function makeFakePi(activeTools: string[], seed: FakePiSeed = {}) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, RegisteredTool>();
  const seeded = new Map((seed.tools ?? []).map((tool) => [tool.name, tool]));
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: SentMessage[] = [];
  const notices: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (text: string) => notices.push(text) } };

  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (tool: RegisteredTool & { name: string }) => {
      if (seed.foreignWins === true && seeded.has(tool.name)) return;
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options);
    },
    getActiveTools: () => [...activeTools],
    /** 模拟宿主 `getAllTools()` 的**有效注册表**（同名先注册者胜）。 */
    getAllTools: () => [
      ...[...seeded.values()].map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: {},
        promptGuidelines: [],
        sourceInfo: { path: tool.path ?? "<seeded:test>" },
      })),
      ...[...tools.entries()].map(([name, tool]) => ({
        name,
        description: tool.description ?? "",
        parameters: {},
        promptGuidelines: [],
        sourceInfo: { path: "<test:registered>" },
      })),
    ],
    events: seed.events,
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const fire = async (event: string): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, reason: "quit" }, ctx);
  };
  const run = async (name: string, args = ""): Promise<void> => {
    const command = commands.get(name);
    assert.ok(command, `命令未注册：${name}`);
    await command.handler(args, ctx);
  };
  return { api, fire, run, tools, commands, sent, notices, uiCtx: ctx };
}

function makeExtension(activeTools: string[], env: Record<string, string> = {}, child = new FakeChild(), seed: FakePiSeed = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-bg-idx-"));
  const killCalls: number[] = [];
  let spawnCalls = 0;
  const fakePi = makeFakePi(activeTools, seed);
  const factory = createTimeoutBgExtension({
    env,
    spawn: ((file: string, args: readonly string[]) => {
      spawnCalls += 1;
      assert.equal(file, "bash");
      assert.equal(args[0], "-lc");
      return child as unknown as SpawnedProcess;
    }) as never,
    now: () => 1_000,
    killTree: (pid) => killCalls.push(pid),
    logRoot: path.join(dir, "bg-jobs"),
    shellConfig: () => ({ shell: "bash", args: ["-lc"] }),
  });
  factory(fakePi.api);
  return { ...fakePi, dir, killCalls, child, spawnCalls: () => spawnCalls };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 宿主工具读 ctx.sessionManager / ctx.model 注入 PI_* 环境变量，fake ctx 必须给全这几项。 */
function toolCtx(cwd: string, uiCtx?: { hasUI: boolean; ui: { notify: (text: string) => void } }): never {
  return {
    cwd,
    hasUI: uiCtx?.hasUI ?? false,
    ui: uiCtx?.ui,
    model: { provider: "fake-provider", id: "fake-model" },
    thinkingLevel: "medium",
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => null },
  } as never;
}

test("只覆盖当前启用的 shell 工具：active 里没有的工具不注册（不给用户凭空加工具）", async () => {
  const onlyBash = makeExtension(["bash"]);
  await onlyBash.fire("session_start");
  assert.deepEqual([...onlyBash.tools.keys()], ["bash"]);

  const both = makeExtension(["bash", "powershell"]);
  await both.fire("session_start");
  assert.deepEqual([...both.tools.keys()].sort(), ["bash", "powershell"]);
});

test("超时：工具以错误结束并给出日志路径；进程随后退出 → 收到 followUp 通知", async () => {
  const ext = makeExtension(["bash"]);
  await ext.fire("session_start");
  const tool = ext.tools.get("bash")!;
  const error = await tool
    .execute("call-1", { command: "sleep 400", timeout: 0.05 }, undefined, undefined, toolCtx(ext.dir))
    .then(
      () => null,
      (e: unknown) => e as Error,
    );
  assert.ok(error instanceof Error, "超时结束本次 tool call");
  assert.ok(error.message.includes(path.join(ext.dir, "bg-jobs")), "错误文本含日志路径");
  assert.deepEqual(ext.killCalls, [], "不杀进程");

  ext.child.exit(0);
  await wait(50);
  assert.equal(ext.sent.length, 1, "后台任务结束送一条 followUp");
  assert.equal(ext.sent[0]!.message.customType, "timeout-bg");
  assert.equal(ext.sent[0]!.options?.deliverAs, "followUp");
  assert.equal(ext.sent[0]!.options?.triggerTurn, true);
  assert.match(String(ext.sent[0]!.message.content), /退出码 0|exit code 0/);
});

test("命令面：/bg 列出后台任务，/bg:kill 杀进程树，/bg:clear 清已结束记录", async () => {
  const ext = makeExtension(["bash"]);
  await ext.fire("session_start");
  const tool = ext.tools.get("bash")!;
  await tool
    .execute("call-1", { command: "sleep 400", timeout: 0.05 }, undefined, undefined, toolCtx(ext.dir))
    .catch(() => undefined);

  await ext.run("bg");
  assert.equal(ext.notices.length, 1);
  assert.match(ext.notices[0]!, /bg-1/);
  assert.match(ext.notices[0]!, /running|运行中/);

  await ext.run("bg:kill", "bg-1");
  assert.deepEqual(ext.killCalls, [9_001]);
  assert.match(ext.notices.at(-1)!, /bg-1/);

  ext.child.exit(0);
  await wait(30);
  await ext.run("bg:clear");
  assert.match(ext.notices.at(-1)!, /清除|清理/);
  await ext.run("bg");
  assert.match(ext.notices.at(-1)!, /没有|空/);
});

test("session_shutdown：杀掉本会话遗留的后台任务", async () => {
  const ext = makeExtension(["bash"]);
  await ext.fire("session_start");
  await ext.tools
    .get("bash")!
    .execute("call-1", { command: "sleep 400", timeout: 0.05 }, undefined, undefined, toolCtx(ext.dir))
    .catch(() => undefined);
  await ext.fire("session_shutdown");
  assert.deepEqual(ext.killCalls, [9_001]);
});

test("非法 PI_TIMEOUT_BG_DEFAULT：启动时提示一次，回退默认值", async () => {
  const ext = makeExtension(["bash"], { PI_TIMEOUT_BG_DEFAULT: "oops" });
  await ext.fire("session_start");
  assert.equal(ext.notices.length, 1);
  assert.match(ext.notices[0]!, /PI_TIMEOUT_BG_DEFAULT/);
});

/**
 * codemode 视角（timeout-bg-todo#2）：脚本调 `tools.bash` 拿到的是**本扩展注册的工具**，
 * 结构化字段由宿主 `createBashTool` 层生成（扩展只 spread 它并覆盖 description/parameters/
 * promptGuidelines）—— 这两条测试锁定该契约不被后续重构悄悄改掉。
 */
test("codemode 视角：结构化字段形状（空输出为空串，未截断时无 full_output_path）", async () => {
  const empty = makeExtension(["bash"]);
  await empty.fire("session_start");
  const emptyTool = empty.tools.get("bash")!;
  assert.ok(emptyTool.outputSchema, "覆盖工具必须保留宿主声明的 outputSchema");
  assert.deepEqual(
    Object.keys(emptyTool.outputSchema.properties ?? {}).sort(),
    ["exit_code", "full_output_path", "output", "truncated", "wall_time_seconds"],
    "字段名与宿主 structuredContent 契约逐字一致",
  );

  const pending = emptyTool.execute("call-1", { command: "true" }, undefined, undefined, toolCtx(empty.dir));
  empty.child.exit(0);
  const result = (await pending) as ToolResult;
  const structured = result.structuredContent!;
  assert.equal(structured.output, "", "空输出是空串，不是模型侧的 '(no output)' 占位");
  assert.equal(structured.truncated, false);
  assert.equal(structured.exit_code, 0);
  assert.equal(typeof structured.wall_time_seconds, "number");
  assert.equal("full_output_path" in structured, false, "未截断时不带 full_output_path");
  assert.equal(result.isError, undefined, "退出码 0 不是错误结果");

  const small = makeExtension(["bash"]);
  await small.fire("session_start");
  const smallPending = small.tools
    .get("bash")!
    .execute("call-1", { command: "echo hi" }, undefined, undefined, toolCtx(small.dir));
  small.child.emitData("hi\n");
  small.child.exit(0);
  const smallStructured = ((await smallPending) as ToolResult).structuredContent!;
  assert.equal(smallStructured.output, "hi\n");
  assert.equal(smallStructured.truncated, false);
  assert.equal(smallStructured.exit_code, 0);
  assert.equal("full_output_path" in smallStructured, false);
});

test("codemode 视角：>1MiB 输出保首尾两半 + truncated/full_output_path（模型侧仍是 2000 行 / 50KB 口径）", async () => {
  const ext = makeExtension(["bash"]);
  await ext.fire("session_start");
  const raw = Array.from({ length: 4000 }, (_, i) => `line-${i + 1} ${"x".repeat(360)}`).join("\n") + "\n";
  assert.ok(raw.length > 1024 * 1024, "样本必须超过 1MiB 上限");

  const pending = ext.tools
    .get("bash")!
    .execute("call-1", { command: "many-lines" }, undefined, undefined, toolCtx(ext.dir));
  ext.child.emitData(raw);
  ext.child.exit(0);
  const result = (await pending) as ToolResult;
  const structured = result.structuredContent!;

  assert.equal(structured.truncated, true);
  assert.equal(structured.exit_code, 0);
  const fullOutputPath = structured.full_output_path as string;
  assert.equal(typeof fullOutputPath, "string", "截断时必须给出落盘路径");
  assert.equal(fs.statSync(fullOutputPath).size, Buffer.byteLength(raw, "utf8"), "落盘的是完整输出");
  assert.equal(result.details?.fullOutputPath, fullOutputPath, "details 与结构化字段同一路径");
  assert.equal(result.details?.truncation?.truncated, true);

  const output = structured.output as string;
  assert.ok(output.length >= 1024 * 1024, "脚本侧 output 按 1MiB 上限保留");
  assert.ok(output.startsWith("line-1 "), "保留首部（模型侧看不到）");
  assert.ok(output.trimEnd().endsWith("x".repeat(360)), "保留尾部");
  assert.match(output, /\[\.\.\. \d+ bytes omitted \.\.\.\]/, "中间以省略标记收口");

  const modelText = result.content?.[0]?.text ?? "";
  assert.ok(modelText.length < 60 * 1024, `模型侧仍是 50KB 口径，实际 ${modelText.length} 字节`);
  assert.match(modelText, /\[Showing lines \d+-\d+ of 4000/);
  assert.ok(!modelText.includes("line-1 "), "模型侧只看到尾部");
});

/**
 * 跨扩展组合（timeout-bg-todo#3）：用**宿主真实的 createEventBus** 把能力载荷交给本扩展，
 * 断言合并后的 bash 同时具备「远端分派」与「本扩展的超时→后台执行」两条路。
 * 边界：事件总线真实；能力载荷是自己造的契约形状（remote-tools 侧的真实现另测）。
 */
function busWithCapability(value: unknown): EventBus {
  const bus = createEventBus();
  bus.on(SHELL_CAPABILITY_CHANNEL, (box) => {
    (box as { bash?: unknown }).bash = value;
  });
  return bus;
}

test("跨扩展组合：能力载荷 ⇒ schema 合并 + 按参数分派（远端转交能力、本地走超时→后台）", async () => {
  const remoteCalls: unknown[][] = [];
  const capability = {
    parameters: { remote: { type: "string" }, remotePort: { type: "number" }, remoteCwd: { type: "string" } },
    isRemoteCall: (params: unknown) => (params as { remote?: unknown }).remote === "deploy@host",
    executeRemote: async (...args: unknown[]) => {
      remoteCalls.push(args);
      return { content: [{ type: "text", text: "remote-ok" }] };
    },
    guideline: "远端 bash 指南",
  };
  const ext = makeExtension(["bash"], {}, new FakeChild(), { events: busWithCapability(capability) });
  await ext.fire("session_start");

  const tool = ext.tools.get("bash")!;
  for (const key of ["command", "timeout", "remote", "remotePort", "remoteCwd"]) {
    assert.ok(key in (tool.parameters?.properties ?? {}), `合并后的 schema 缺参数 ${key}`);
  }
  assert.ok((tool.promptGuidelines ?? []).includes("远端 bash 指南"), "能力指南必须拼进 promptGuidelines");
  assert.match(tool.description ?? "", /keeps running in the background/, "description 仍是 timeout-bg 的文案");

  const remote = (await tool.execute("call-1", { command: "uname -s", remote: "deploy@host" }, undefined, undefined, toolCtx(ext.dir))) as ToolResult;
  assert.equal(remoteCalls.length, 1, "远端意图必须交给能力执行");
  assert.equal((remoteCalls[0]![1] as { command: string }).command, "uname -s");
  assert.equal(remote.content?.[0]?.text, "remote-ok");
  assert.equal(ext.spawnCalls(), 0, "远端调用不得 spawn 本地 shell");

  const pending = tool.execute("call-2", { command: "echo hi" }, undefined, undefined, toolCtx(ext.dir));
  ext.child.emitData("hi\n");
  ext.child.exit(0);
  const local = (await pending) as ToolResult;
  assert.equal(local.structuredContent?.output, "hi\n", "本地调用仍走 timeout-bg 自己的 ops（结构化结果不变）");
  assert.equal(ext.spawnCalls(), 1);
});

test("跨扩展组合：畸形载荷/判定抛错/执行抛错各自可见，且远端意图绝不回退到本机", async () => {
  const malformed = makeExtension(["bash"], {}, new FakeChild(), { events: busWithCapability({ parameters: {}, isRemoteCall: "nope" }) });
  await malformed.fire("session_start");
  assert.ok(malformed.notices.some((n) => n.includes("畸形")), malformed.notices.join("|"));
  assert.equal(malformed.tools.get("bash")?.parameters?.properties?.remote, undefined, "畸形载荷不得并进 schema");

  // 收到过载荷（哪怕畸形）+ 当前 bash 不是内置 ⇒ 只报「畸形」，不再说「未知扩展接管」（那是误导）。
  const malformedWithForeign = makeExtension(["bash"], {}, new FakeChild(), {
    events: busWithCapability({ parameters: {}, isRemoteCall: "nope" }),
    tools: [{ name: "bash", path: "<other>/index.ts", description: "other bash" }],
  });
  await malformedWithForeign.fire("session_start");
  assert.ok(malformedWithForeign.notices.some((n) => n.includes("畸形")));
  assert.deepEqual(
    malformedWithForeign.notices.filter((n) => n.includes("已被另一个扩展接管")),
    [],
    "收到过载荷就不再报「未知接管」（那条只说给真的没提供方的场景）",
  );

  const throwingJudgement = makeExtension(["bash"], {}, new FakeChild(), {
    events: busWithCapability({
      parameters: { remote: {} },
      isRemoteCall: () => {
        throw new Error("judgement boom");
      },
      executeRemote: async () => ({}),
    }),
  });
  await throwingJudgement.fire("session_start");
  const refused = await throwingJudgement.tools
    .get("bash")!
    .execute("call-1", { command: "echo hi" }, undefined, undefined, toolCtx(throwingJudgement.dir, throwingJudgement.uiCtx))
    .then(() => null, (error: unknown) => error as Error);
  assert.match(String(refused), /拒绝执行/);
  assert.equal(throwingJudgement.spawnCalls(), 0, "判定失败时不得在本机跑");
  assert.ok(throwingJudgement.notices.some((n) => n.includes("能力判定失败")));

  const throwingRemote = makeExtension(["bash"], {}, new FakeChild(), {
    events: busWithCapability({
      parameters: { remote: {} },
      isRemoteCall: () => true,
      executeRemote: async () => {
        throw new Error("REMOTE_EXEC_FAILED");
      },
    }),
  });
  await throwingRemote.fire("session_start");
  const failed = await throwingRemote.tools
    .get("bash")!
    .execute("call-1", { command: "echo hi" }, undefined, undefined, toolCtx(throwingRemote.dir, throwingRemote.uiCtx))
    .then(() => null, (error: unknown) => error as Error);
  assert.match(String(failed), /REMOTE_EXEC_FAILED/);
  assert.equal(throwingRemote.spawnCalls(), 0, "远端执行失败绝不回退到本机");
  assert.ok(throwingRemote.notices.some((n) => n.includes("远端 shell 能力执行出错")));
});

test("冲突可见：未知扩展接管 bash（注册前）与注册被加载顺序丢掉（注册后）都 notify 一次", async () => {
  const takeover = makeExtension(["bash"], {}, new FakeChild(), { tools: [{ name: "bash", path: "<other>/index.ts", description: "other bash" }] });
  await takeover.fire("session_start");
  assert.equal(takeover.notices.length, 1, takeover.notices.join("|"));
  assert.match(takeover.notices[0]!, /接管/);

  const lateOwner = makeExtension(["bash"], {}, new FakeChild(), {
    tools: [{ name: "bash", path: "<partner>/index.ts", description: "partner bash" }],
    foreignWins: true,
    events: busWithCapability({ parameters: { remote: {} }, isRemoteCall: () => false, executeRemote: async () => ({}) }),
  });
  await lateOwner.fire("session_start");
  assert.equal(lateOwner.notices.length, 1, lateOwner.notices.join("|"));
  assert.match(lateOwner.notices[0]!, /加载顺序更早/);
});
