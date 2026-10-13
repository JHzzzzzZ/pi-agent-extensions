/*
 * 跨扩展组合测试：remote-tools × timeout-bg（remote-tools-todo#9 / timeout-bg-todo#3）。
 *
 * 为什么不用替身：本变更的全部风险都在「两个扩展抢同一个工具名时谁生效、远端能力有没有并进
 * 生效的那一份」——这只有在宿主自己的加载路径上才成立：真实 `discoverAndLoadExtensions`
 * （jiti 走两个扩展的真实 index.ts）+ 真实 `createEventBus` + 真实 `ExtensionRunner`
 * （同名工具 first-wins 的注册表语义）。fake 的只有工具执行要用的 ctx 表面。
 *
 * 进程边界（真机在 remote-tools 的 opt-in 用例里）：
 *   - 远端分支用**非法 remote 形态**验证「确实走了远端分支」（校验先于 ssh ⇒ 零 ssh 进程）；
 *   - 本地分支用**非法 timeout**验证「确实走了 timeout-bg 的 ops」（解析先于 spawn ⇒ 零 spawn）。
 */

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionUIContext,
  ExtensionRunner,
  type ModelRegistry,
  type SessionManager,
  createEventBus,
  discoverAndLoadExtensions,
} from "@earendil-works/pi-coding-agent";

import { type RemoteJobPort, SHELL_JOB_HOST_CHANNEL } from "../capability.ts";
import { ErrorCodes } from "../errors.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REMOTE_TOOLS_DIR = path.resolve(HERE, "..");
const TIMEOUT_BG_DIR = path.resolve(HERE, "..", "..", "timeout-bg");

async function startHarness(t: TestContext, order: "timeout-bg-first" | "remote-tools-first") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "shell-composition-cwd-"));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-composition-agent-"));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-composition-bg-"));
  // timeout-bg 的日志根在模块加载时读 env：指到临时目录，绝不动用户的 ~/.pi/agent。
  const previousLogRoot = process.env.PI_TIMEOUT_BG_DIR;
  process.env.PI_TIMEOUT_BG_DIR = logDir;
  // 真实 index.ts 会读远端目标登记表（默认 ~/.pi/agent/remote-targets.json）：指到临时目录里的不存在文件，
  // 否则开发机上的登记表（或它的损坏）会漏进测试——隔离口径与 PI_TIMEOUT_BG_DIR 一致。
  const previousTargetsFile = process.env.PI_REMOTE_TARGETS_FILE;
  process.env.PI_REMOTE_TARGETS_FILE = path.join(agentDir, "remote-targets.json");
  t.after(() => {
    if (previousLogRoot === undefined) delete process.env.PI_TIMEOUT_BG_DIR;
    else process.env.PI_TIMEOUT_BG_DIR = previousLogRoot;
    if (previousTargetsFile === undefined) delete process.env.PI_REMOTE_TARGETS_FILE;
    else process.env.PI_REMOTE_TARGETS_FILE = previousTargetsFile;
    for (const dir of [cwd, agentDir, logDir]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const paths = order === "timeout-bg-first" ? [TIMEOUT_BG_DIR, REMOTE_TOOLS_DIR] : [REMOTE_TOOLS_DIR, TIMEOUT_BG_DIR];
  const bus = createEventBus();
  const loaded = await discoverAndLoadExtensions(paths, cwd, agentDir, bus);
  assert.deepEqual(loaded.errors, [], "两个扩展都必须加载成功（jiti 走真实 index.ts）");
  assert.equal(loaded.extensions.length, 2);

  let runner: ExtensionRunner | undefined;
  const actions = {
    getActiveTools: () => ["bash"],
    /** 宿主真正做的是「刷新工具注册表」；测试里不需要副作用，但必须存在（否则 registerTool 会抛）。 */
    refreshTools: () => undefined,
    /** 模拟宿主 agent-session 的有效注册表（同名 first-wins），供冲突可见性自检读取。 */
    getAllTools: () =>
      (runner?.getAllRegisteredTools() ?? []).map(({ definition, sourceInfo }) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        promptGuidelines: definition.promptGuidelines ?? [],
        exposure: "direct",
        sourceInfo,
      })),
  } as unknown as ExtensionActions;
  const contextActions = {
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
  } as unknown as ExtensionContextActions;

  runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, {} as SessionManager, {} as ModelRegistry);
  runner.bindCore(actions, contextActions);
  const notifies: string[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  runner.setUIContext(
    {
      notify: (message: string) => notifies.push(message),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
    } as unknown as ExtensionUIContext,
    "tui",
  );
  await runner.emit({ type: "session_start", reason: "startup" });
  return { runner, bus, notifies, statuses, cwd };
}

/** 工具执行用的最小 ctx（宿主 shell 工具读它注入 PI_* 环境变量）。 */
function toolCtx(cwd: string): never {
  return {
    cwd,
    hasUI: false,
    model: { provider: "fake-provider", id: "fake-model" },
    thinkingLevel: "medium",
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => null },
  } as never;
}

function failureOf(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

function parameterNames(tool: { parameters: unknown }): string[] {
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(properties).sort();
}

test("组合后生效的 bash = 合并版：远端三参数 + timeout-bg 的语义，且两边分派都真的接上了", async (t) => {
  const { runner, cwd, notifies } = await startHarness(t, "timeout-bg-first");
  const bash = runner.getToolDefinition("bash");
  assert.ok(bash !== undefined, "bash 必须注册");

  assert.deepEqual(parameterNames(bash), ["command", "remote", "remoteCwd", "remotePort", "timeout"]);
  assert.match(bash.description, /keeps running in the background/, "生效的必须是 timeout-bg 的文案（合并发生在 owner 侧）");
  assert.ok((bash.promptGuidelines ?? []).some((line) => line.includes("远端主机")), "远端指南必须拼进 promptGuidelines");
  assert.deepEqual(notifies, [], "正常组合不应有任何冲突提示");

  const ctx = toolCtx(cwd);
  const remoteError = await failureOf(() => bash.execute("call-1", { command: "uname -s", remote: "bad host" }, undefined, undefined, ctx));
  assert.match(remoteError, new RegExp(ErrorCodes.INVALID_REMOTE_TARGET), "远端意图必须进远端分支（校验先于 ssh ⇒ 零 ssh）");

  const localError = await failureOf(() => bash.execute("call-2", { command: "echo hi", timeout: -1 }, undefined, undefined, ctx));
  assert.match(localError, /Invalid timeout/, "本地调用必须进 timeout-bg 的 ops（解析先于 spawn ⇒ 零 spawn）");
});

test("跨扩展 job 托管（timeout-bg#4）：真加载两扩展就能索取到端口，注册的远端 job 进 /bg 与状态条段", async (t) => {
  const { runner, bus, statuses } = await startHarness(t, "timeout-bg-first");

  // 提供方（remote-tools）的索取路径：同步 emit 空盒子，owner（timeout-bg）在回调里填好。
  const box: { host?: unknown } = {};
  bus.emit(SHELL_JOB_HOST_CHANNEL, box);
  const host = box.host as RemoteJobPort | undefined;
  assert.ok(host !== undefined, "timeout-bg 必须在托管频道上应答（两个真实扩展 + 真实事件总线）");

  const ticket = host.allocate();
  const text = host.register({
    id: ticket.id,
    logPath: ticket.logPath,
    command: "sleep 15; echo MARK",
    target: "deploy@host",
    timeoutSeconds: 3,
    tail: "partial-output",
    terminate: () => {},
  });
  assert.match(text, /命令超时（3 秒）/, "超时文本由 owner 单源提供");
  assert.match(text, /remote deploy@host/);
  assert.deepEqual(statuses.at(-1), { key: "80:timeout-bg", text: "⏱ 1 bg" }, "远端 job 计入状态条段");

  const command = runner.getCommand("bg");
  assert.ok(command !== undefined, "/bg 命令面必须注册");
  const notices: string[] = [];
  await command.handler("", { hasUI: true, ui: { notify: (message: string) => notices.push(message) } } as never);
  assert.match(notices[0] ?? "", new RegExp(ticket.id), "远端 job 进统一列表");
  assert.match(notices[0] ?? "", /remote deploy@host/);

  host.settle(ticket.id, 0);
  assert.deepEqual(statuses.at(-1), { key: "80:timeout-bg", text: undefined }, "任务结束后清段");
});

test("加载顺序相反时：宿主 first-wins 让 remote-tools 的 bash 生效（timeout-bg 语义丢失），且 timeout-bg 提示冲突而不是静默", async (t) => {
  const { runner, notifies } = await startHarness(t, "remote-tools-first");
  const bash = runner.getToolDefinition("bash");
  assert.ok(bash !== undefined);
  assert.doesNotMatch(bash.description, /keeps running in the background/, "顺序相反时生效的是 remote-tools 那份（本仓文档明确要求 timeout-bg 在前）");
  assert.ok((bash.promptGuidelines ?? []).some((line) => line.includes("远端")), "remote-tools 的 bash 仍可用（远端能力没丢）");
  assert.ok(
    notifies.some((message) => message.includes("加载顺序更早")),
    `顺序问题必须可见：${notifies.join(" | ")}`,
  );
});
