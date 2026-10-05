/**
 * 宿主事件路径集成测试：**真实发现+加载（jiti 走 index.ts）+ 真实 ExtensionRunner 事件分发**。
 *
 * 为什么不用纸面替身直接调 `judgeToolCall`：本扩展的风险全在宿主接缝上——
 * `pi.on("tool_call")` 的返回值语义（`block` / `undefined`）、`ctx.hasUI`、
 * `ctx.ui.confirm`、`ctx.modelRegistry.classify`，以及「只加摩擦」要证明的
 * 「别的 tool_call 处理器照旧能 block」。这里走宿主自己的
 * `discoverAndLoadExtensions`（pi main() 用的同一条路径）加载真实入口文件。
 *
 * 边界 fake：`modelRegistry`（网络/鉴权边界，用可观察计数桩；真实 provider 调用只能真机验）、
 * `sessionManager` 与 actions（本扩展不读，用结构 fake）。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExtensionRunner,
  createEventBus,
  discoverAndLoadExtensions,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionActions,
  ExtensionContextActions,
  ExtensionUIContext,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { STATUS_KEY } from "../observability.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, "..");
const MODEL = { type: "classifier", id: "jev-latest", provider: "typesafe", api: "typesafe-system-one" } as unknown as ClassifierModel<ClassifierApi>;

/** 「既有审批门」替身：一个独立的宿主扩展，用全局计数让调用可见。 */
const LEGACY_GATE_SOURCE = `
const calls = () => (globalThis.__jevLegacyGateCalls ??= 0);
export default (pi) => {
  pi.on("tool_call", () => {
    globalThis.__jevLegacyGateCalls = calls() + 1;
    return { block: true, reason: "既有审批门：需人工确认" };
  });
};
`;
declare global {
  // eslint-disable-next-line no-var
  var __jevLegacyGateCalls: number | undefined;
}

function classifierResult(answers: ClassifierResult["answers"], stopReason: ClassifierResult["stopReason"] = "stop"): ClassifierResult {
  return { api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", answers, stopReason, timestamp: 0 };
}

/** 分类器桩：真实契约是「不抛错，失败走 stopReason」，默认返回一条 safe 高置信度答案。 */
function makeClassifier(config: { handler?: (context: ClassifierContext, options?: { signal?: AbortSignal }) => Promise<ClassifierResult> | ClassifierResult; noModel?: boolean } = {}) {
  const calls = { getModel: 0, classify: 0, contexts: [] as ClassifierContext[], modelRefs: [] as string[] };
  const registry = {
    getModelOfType: (type: string, provider: string, modelId: string) => {
      calls.getModel += 1;
      calls.modelRefs.push(`${type}:${provider}/${modelId}`);
      return config.noModel ? undefined : MODEL;
    },
    classify: async (_model: unknown, context: ClassifierContext, requestOptions?: { signal?: AbortSignal }) => {
      calls.classify += 1;
      calls.contexts.push(context);
      if (config.handler) return config.handler(context, requestOptions);
      return classifierResult({
        irreversible_damage: { type: "choice", choice: "safe", confidence: 0.97, probabilities: { safe: 0.97, destructive: 0.03 } },
      });
    },
  };
  return { registry: registry as unknown as ModelRegistry, calls };
}

function makeUi(confirmAnswer: boolean | (() => Promise<boolean>)) {
  const seen = { statuses: [] as Array<string | undefined>, notifies: [] as string[], confirms: [] as Array<{ title: string; message: string }> };
  const ui = {
    confirm: async (title: string, message: string) => {
      seen.confirms.push({ title, message });
      return typeof confirmAnswer === "boolean" ? confirmAnswer : confirmAnswer();
    },
    notify: (message: string) => {
      seen.notifies.push(message);
    },
    setStatus: (key: string, text: string | undefined) => {
      if (key === STATUS_KEY) seen.statuses.push(text);
    },
    select: async () => undefined,
    input: async () => undefined,
  } as unknown as ExtensionUIContext;
  return { ui, seen };
}

interface HarnessOptions {
  hasUI?: boolean;
  confirm?: boolean | (() => Promise<boolean>);
  classifier?: (context: ClassifierContext, options?: { signal?: AbortSignal }) => Promise<ClassifierResult> | ClassifierResult;
  /** 目录里没有分类器模型（getModelOfType 返回 undefined）。 */
  noModel?: boolean;
  /** 追加一个独立的「既有审批门」扩展（证明只加摩擦）。 */
  legacyGate?: boolean;
}

async function startHarness(t: TestContext, options: HarnessOptions = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-safe-gate-host-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const sources = [EXT_DIR];
  globalThis.__jevLegacyGateCalls = 0;
  if (options.legacyGate) {
    const legacyPath = path.join(tmp, "legacy-gate.ts");
    fs.writeFileSync(legacyPath, LEGACY_GATE_SOURCE, "utf8");
    sources.push(legacyPath);
  }
  // 真实宿主发现路径：项目级 .pi/extensions（这里不存在）+ 空 agentDir + 显式源目录。
  // agentDir 指向临时目录，绝不碰用户真实 ~/.pi/agent。
  const loaded = await discoverAndLoadExtensions(sources, EXT_DIR, path.join(tmp, "agent"), createEventBus());
  assert.deepEqual(loaded.errors, [], "扩展加载必须无错（jiti 走真实 index.ts）");
  assert.equal(loaded.extensions.length, sources.length);

  const classifier = makeClassifier({ handler: options.classifier, noModel: options.noModel });
  const counters = { getAllTools: 0 };
  const actions = {
    getAllTools: () => {
      counters.getAllTools += 1;
      return [];
    },
  } as unknown as ExtensionActions;
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
  // sessionManager 只被 ctx.sessionManager 引用，本扩展不读它（会话持久化不在测试范围）。
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, EXT_DIR, {} as SessionManager, classifier.registry);
  runner.bindCore(actions, contextActions);
  const ui = makeUi(options.confirm ?? true);
  if (options.hasUI ?? true) runner.setUIContext(ui.ui, "tui");
  return { runner, classifier, counters, ui: ui.seen };
}

/** 一条真实形状的 bash tool_call 事件（input 可变，正好用来证明我们没改它）。 */
function bashEvent(command: string) {
  return { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash" as const, input: { command } };
}

const CANDIDATE = "rm -rf /tmp/jev-gate-host-test";

test("真实入口文件被宿主加载：无加载错误、tool_call 处理器已注册", async (t) => {
  const h = await startHarness(t);
  assert.equal(h.runner.hasHandlers("tool_call"), true, "tool_call 处理器必须注册（不然门是空的）");
});

test("非候选命令：真实事件路径放行，零 classify、零 getAllTools", async (t) => {
  const h = await startHarness(t);
  const result = await h.runner.emitToolCall(bashEvent("npm test"));
  assert.equal(result, undefined, "非候选直接放行（handler 返回 undefined）");
  assert.equal(h.classifier.calls.classify, 0, "零 Jev 调用是硬指标");
  assert.equal(h.classifier.calls.getModel, 0);
  assert.equal(h.counters.getAllTools, 0, "连注解读取都不发生");
  assert.deepEqual(h.ui.confirms, []);
  assert.deepEqual(h.classifier.calls.modelRefs, [], "非候选连模型目录都不查");
});

test("非 bash 工具：完全不介入（write 覆盖文件也不看）", async (t) => {
  const h = await startHarness(t);
  const result = await h.runner.emitToolCall({ type: "tool_call", toolCallId: "c2", toolName: "write", input: { path: "x", content: "rm -rf /" } });
  assert.equal(result, undefined);
  assert.equal(h.classifier.calls.classify, 0);
  assert.equal(h.counters.getAllTools, 0);
});

test("候选命令 + 用户拒绝：调用被阻止（block），命令文本未被改写", async (t) => {
  const h = await startHarness(t, {
    confirm: false,
    classifier: () => classifierResult({ irreversible_damage: { type: "choice", choice: "destructive", confidence: 0.93, probabilities: { safe: 0.07, destructive: 0.93 } } }),
  });
  const event = bashEvent(CANDIDATE);
  const before = JSON.stringify(event.input);
  const result = await h.runner.emitToolCall(event);
  assert.equal(result?.block, true, "用户拒绝 → 宿主拦截这次调用");
  assert.match(String(result?.reason), /拒绝/);
  assert.equal(h.classifier.calls.classify, 1);
  assert.equal(h.ui.confirms.length, 1, "只弹一次确认");
  assert.match(h.ui.confirms[0].message, /rm -rf \/tmp\/jev-gate-host-test/, "确认框必须让用户看见原文");
  assert.deepEqual(h.classifier.calls.modelRefs, ["classifier:typesafe/jev-latest"], "分类器身份锁死在内置 typesafe/jev-latest");
  assert.equal(JSON.stringify(event.input), before, "扩展绝不改写命令（含不追加参数）");
});

test("候选命令 + 用户同意：放行（undefined）且命令原样交给宿主执行", async (t) => {
  const h = await startHarness(t, {
    confirm: true,
    classifier: () => classifierResult({ irreversible_damage: { type: "choice", choice: "destructive", confidence: 0.9, probabilities: { safe: 0.1, destructive: 0.9 } } }),
  });
  const event = bashEvent("git reset --hard HEAD~1");
  const before = JSON.stringify(event.input);
  const result = await h.runner.emitToolCall(event);
  assert.equal(result, undefined);
  assert.equal(h.ui.confirms.length, 1);
  assert.equal(JSON.stringify(event.input), before);
  assert.equal(h.classifier.calls.contexts[0].state.cwd, EXT_DIR, "上下文带真实 cwd");
});

test("判定安全：不弹框、不加摩擦，且**不阻止**既有审批门（只加摩擦）", async (t) => {
  const h = await startHarness(t, { legacyGate: true, confirm: false });
  const result = await h.runner.emitToolCall(bashEvent(CANDIDATE));
  assert.equal(result?.block, true, "既有审批门仍然生效（我们没替它放行）");
  assert.match(String(result?.reason), /既有审批门/);
  assert.equal(globalThis.__jevLegacyGateCalls, 1, "既有门照常被跑到");
  assert.equal(h.ui.confirms.length, 0, "判定安全就不该再弹框");
});

test("fail-open：classify 抛错 → 放行 + 状态条可见（计数 + 原因）+ 一次 notify", async (t) => {
  const h = await startHarness(t, {
    classifier: () => {
      throw new Error("分类器炸了");
    },
  });
  const result = await h.runner.emitToolCall(bashEvent(CANDIDATE));
  assert.equal(result, undefined, "fail-open：放行");
  assert.equal(h.ui.confirms.length, 0);
  assert.match(String(h.ui.statuses.at(-1)), /放行1/, "状态条出现放行计数");
  assert.match(String(h.ui.statuses.at(-1)), /报错/, "状态条带最近原因");
  assert.equal(h.ui.notifies.length, 1, "首次放行给一次提示");
});

test("fail-open：分类器模型不存在 → 放行 + 状态条可见（无分类器 = 判定不可用）", async (t) => {
  const h = await startHarness(t, { noModel: true });
  const result = await h.runner.emitToolCall(bashEvent(CANDIDATE));
  assert.equal(result, undefined, "没有分类器 → fail-open 放行");
  assert.equal(h.classifier.calls.classify, 0, "模型都没有就不该发请求");
  assert.match(String(h.ui.statuses.at(-1)), /放行1/);
  assert.match(String(h.ui.statuses.at(-1)), /无分类器/, "状态条带最近原因");
  assert.equal(h.ui.notifies.length, 1);
});

test("fail-open：headless（无 UI）→ 放行、零 classify，且 stderr 留痕（不允许静默失效）", async (t) => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  const h = await startHarness(t, { hasUI: false });
  const result = await h.runner.emitToolCall(bashEvent(CANDIDATE));
  assert.equal(result, undefined);
  assert.equal(h.classifier.calls.classify, 0, "没有 UI 就问不了人 → 不花这次钱");
  assert.equal(logs.length, 1, "无 UI 时唯一通道是 stderr（默认 deps），必须真的写");
  assert.match(logs[0], /no-ui/);
});

test("solo 开启：候选命令零 classify、零弹框；关掉 solo 同一条命令恢复拦截", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-safe-gate-solo-"));
  const file = path.join(dir, "solo-mode.json");
  const previous = process.env.PI_SOLO_MODE_FILE;
  process.env.PI_SOLO_MODE_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SOLO_MODE_FILE;
    else process.env.PI_SOLO_MODE_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const h = await startHarness(t, {
    confirm: false,
    classifier: () => classifierResult({ irreversible_damage: { type: "choice", choice: "destructive", confidence: 0.9, probabilities: { safe: 0.1, destructive: 0.9 } } }),
  });

  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, activatedAt: "2026-10-05T00:00:00Z" }), "utf8");
  assert.equal(await h.runner.emitToolCall(bashEvent(CANDIDATE)), undefined, "solo：直接放行");
  assert.equal(h.classifier.calls.classify, 0, "solo：零 classify");
  assert.equal(h.ui.confirms.length, 0, "solo：不弹框");
  assert.deepEqual(h.ui.statuses, [], "solo 不是事故，不写 fail-open 状态");

  fs.rmSync(file);
  const blocked = await h.runner.emitToolCall(bashEvent(CANDIDATE));
  assert.equal(blocked?.block, true, "关掉 solo 后同一条命令恢复确认式拦截");
  assert.equal(h.ui.confirms.length, 1);
});

test("阻止理由与提示文案都是静态模板（不透传命令原文）", async (t) => {
  const h = await startHarness(t, {
    confirm: false,
    classifier: () => classifierResult({ irreversible_damage: { type: "choice", choice: "destructive", confidence: 0.9, probabilities: { safe: 0.1, destructive: 0.9 } } }),
  });
  const secretish = "rm -rf /tmp/sk-live-abcdef123456";
  const result = await h.runner.emitToolCall(bashEvent(secretish));
  assert.equal(result?.block, true);
  assert.equal(String(result?.reason).includes(secretish), false, "阻止理由不得回显命令内容");
  assert.equal(h.ui.notifies.length, 0);
});
