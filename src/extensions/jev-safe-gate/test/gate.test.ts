/**
 * 判定层单测（注入端口，无宿主、无网络、无时钟等待）：
 * 锁的是**调用顺序与放行语义**——非候选零 classify、solo 零介入、
 * 可疑才弹框、判定安全也不授予任何权限、各类 fail-open 全部可观测。
 *
 * 边界：分类器是网络/鉴权边界，这里用可观察计数桩（真机宿主路径见 index-host.test.ts）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClassifierAnswer, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import {
  CLASSIFIER_QUESTION_ID,
  FailOpenReasons,
  MAX_COMMAND_CHARS,
  buildClassifierContext,
  classifyCommand,
  judgeToolCall,
  readJudgement,
  type ClassifierVerdict,
  type FailOpenReason,
  type GateCall,
  type ClassifierRegistryLike,
  type GatePorts,
} from "../gate.ts";
import { findCandidates } from "../candidates.ts";

function choiceAnswer(choice: string, confidence: number, probabilities?: Record<string, number>): ClassifierAnswer {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: probabilities ?? { safe: 1 - confidence, destructive: confidence },
  };
}

function classifierResult(answers: ClassifierResult["answers"], stopReason: ClassifierResult["stopReason"] = "stop"): ClassifierResult {
  return { api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", answers, stopReason, timestamp: 0 };
}

interface PortOptions {
  solo?: boolean;
  hasUI?: boolean;
  screen?: (command: string) => string[];
  classify?: (context: ClassifierContext) => Promise<ClassifierVerdict> | ClassifierVerdict;
  confirm?: () => Promise<boolean> | boolean;
  release?: (reason: FailOpenReason) => void;
}

/** 端口桩：**无论测试覆盖了哪个端口，调用计数都照记**（计数本身就是被测行为）。 */
function makePorts(options: PortOptions = {}) {
  const calls = {
    solo: 0,
    screen: 0,
    classify: 0,
    confirm: 0,
    release: [] as FailOpenReason[],
    contexts: [] as ClassifierContext[],
    messages: [] as string[],
  };
  const ports: GatePorts = {
    isSoloActive: () => {
      calls.solo += 1;
      return options.solo ?? false;
    },
    hasUI: () => options.hasUI ?? true,
    screen: (command) => {
      calls.screen += 1;
      return (options.screen ?? findCandidates)(command);
    },
    classify: async (context) => {
      calls.classify += 1;
      calls.contexts.push(context);
      if (options.classify) return options.classify(context);
      return DEFAULT_SAFE_ANSWER;
    },
    confirm: async (_title, message) => {
      calls.confirm += 1;
      calls.messages.push(message);
      return options.confirm ? await options.confirm() : true;
    },
    release: (reason) => {
      calls.release.push(reason);
      options.release?.(reason);
    },
  };
  return { ports, calls };
}

const DEFAULT_SAFE_ANSWER: ClassifierVerdict = { kind: "answer", answer: choiceAnswer("safe", 0.97, { safe: 0.97, destructive: 0.03 }) };

function bashCall(command: string): GateCall {
  return { toolName: "bash", command, cwd: "/repo", annotations: () => undefined };
}

/** 带注解读取计数的调用（惰性读是「非候选不碰宿主 getAllTools」的判据）。 */
function callWithAnnotations(command: string, annotations?: ToolAnnotations) {
  const state = { reads: 0 };
  const call: GateCall = {
    toolName: "bash",
    command,
    cwd: "/repo",
    annotations: () => {
      state.reads += 1;
      return annotations;
    },
  };
  return { call, state };
}

test("非 bash 工具：直接跳过，零端口调用（write/edit 一概不看）", async () => {
  const { ports, calls } = makePorts();
  const outcome = await judgeToolCall({ toolName: "write", command: "rm -rf /", cwd: "/repo", annotations: () => undefined }, ports);
  assert.deepEqual(outcome, { kind: "skip", why: "not-bash" });
  assert.equal(calls.solo, 0, "非 bash 连 solo 状态都不查");
  assert.equal(calls.screen, 0);
  assert.equal(calls.classify, 0);
  assert.equal(calls.confirm, 0);
  assert.deepEqual(calls.release, []);
});

test("非候选命令：零 classify 调用、零注解读取（不拖慢日常的硬指标）", async () => {
  const { ports, calls } = makePorts();
  const { call, state } = callWithAnnotations("npm test", { destructiveHint: true });
  const outcome = await judgeToolCall(call, ports);
  assert.deepEqual(outcome, { kind: "skip", why: "not-candidate" });
  assert.equal(calls.screen, 1, "候选筛必须跑（它才是决定要不要花钱的那步）");
  assert.equal(calls.classify, 0);
  assert.equal(calls.confirm, 0);
  assert.equal(state.reads, 0, "注解只在候选路径读（宿主 getAllTools 不便宜）");
  assert.deepEqual(calls.release, []);
});

test("候选命令：一次 classify，判定可疑 → 弹一次确认 → 用户拒绝 → 阻止", async () => {
  const { ports, calls } = makePorts({
    classify: () => ({ kind: "answer", answer: choiceAnswer("destructive", 0.9) }),
    confirm: () => false,
  });
  const outcome = await judgeToolCall(bashCall("rm -rf /tmp/build"), ports);
  assert.deepEqual(outcome, { kind: "block", candidates: ["rm-recursive-or-force"] });
  assert.equal(calls.classify, 1);
  assert.equal(calls.confirm, 1, "只弹一次");
  assert.deepEqual(calls.release, [], "用户拒绝不是 fail-open");
});

test("候选命令：用户同意 → 放行（命令文本原样，判定层不碰它）", async () => {
  const command = "rm -rf /tmp/build";
  const { ports } = makePorts({
    classify: () => ({ kind: "answer", answer: choiceAnswer("destructive", 0.9) }),
    confirm: () => true,
  });
  const call = bashCall(command);
  const outcome = await judgeToolCall(call, ports);
  assert.deepEqual(outcome, { kind: "allow", candidates: ["rm-recursive-or-force"] });
  assert.equal(call.command, command, "判定层不得改写命令");
});

test("判定安全且置信度高 → 不弹框；但返回值只是放行，不授予任何权限", async () => {
  const { ports, calls } = makePorts();
  const outcome = await judgeToolCall(bashCall("rm -rf /tmp/build"), ports);
  assert.deepEqual(outcome, { kind: "allow", candidates: ["rm-recursive-or-force"] });
  assert.equal(calls.confirm, 0);
  assert.deepEqual(calls.release, []);
});

test("置信度低于阈值（choice 说安全但拿不准）→ 弹确认", async () => {
  const { ports, calls } = makePorts({
    classify: () => ({ kind: "answer", answer: choiceAnswer("safe", 0.2, { safe: 0.6, destructive: 0.4 }) }),
    confirm: () => false,
  });
  const outcome = await judgeToolCall(bashCall("git reset --hard HEAD~3"), ports);
  assert.equal(outcome.kind, "block");
  assert.equal(calls.confirm, 1);
});

test("概率超阈值（choice 说安全但 destructive 概率高）→ 弹确认", async () => {
  const { ports, calls } = makePorts({
    classify: () => ({ kind: "answer", answer: choiceAnswer("safe", 0.9, { safe: 0.45, destructive: 0.55 }) }),
    confirm: () => false,
  });
  const outcome = await judgeToolCall(bashCall("git reset --hard HEAD~3"), ports);
  assert.equal(outcome.kind, "block");
  assert.equal(calls.confirm, 1);
});

test("答案不可判读（非 choice 结构）→ 交给人：弹确认而非当作安全", async () => {
  const { ports, calls } = makePorts({
    classify: () => ({ kind: "answer", answer: { type: "bool", probability: 0.1 } }),
    confirm: () => false,
  });
  const outcome = await judgeToolCall(bashCall("git push --force"), ports);
  assert.equal(outcome.kind, "block");
  assert.equal(calls.confirm, 1);
  assert.deepEqual(calls.release, [], "读不懂 ≠ 分类器不可用：不当成放行");
});

test("答案缺失（stop 但无该问题答案）→ 交给人：弹确认", async () => {
  const { ports, calls } = makePorts({
    classify: () => ({ kind: "answer", answer: undefined }),
    confirm: () => false,
  });
  const outcome = await judgeToolCall(bashCall("git push --force"), ports);
  assert.equal(outcome.kind, "block");
  assert.equal(calls.confirm, 1);
});

test("fail-open：classify 抛错 → 放行 + release(classify-error) 可观测", async () => {
  const { ports, calls } = makePorts({
    classify: () => {
      throw new Error("boom");
    },
  });
  const outcome = await judgeToolCall(bashCall("rm -rf /tmp/build"), ports);
  assert.deepEqual(outcome, { kind: "release", failOpen: FailOpenReasons.classifyError });
  assert.deepEqual(calls.release, [FailOpenReasons.classifyError]);
  assert.equal(calls.confirm, 0, "判定不可用时绝不弹框");
});

test("fail-open：classify 超时 → 放行 + release(classify-timeout) 可观测", async () => {
  const { ports, calls } = makePorts({ classify: () => ({ kind: "error", timedOut: true }) });
  const outcome = await judgeToolCall(bashCall("rm -rf /tmp/build"), ports);
  assert.deepEqual(outcome, { kind: "release", failOpen: FailOpenReasons.classifyTimeout });
  assert.deepEqual(calls.release, [FailOpenReasons.classifyTimeout]);
});

test("fail-open：分类器模型不存在 → 放行 + release(classifier-unavailable)", async () => {
  const { ports, calls } = makePorts({ classify: () => ({ kind: "unavailable" }) });
  const outcome = await judgeToolCall(bashCall("rm -rf /tmp/build"), ports);
  assert.deepEqual(outcome, { kind: "release", failOpen: FailOpenReasons.classifierUnavailable });
  assert.deepEqual(calls.release, [FailOpenReasons.classifierUnavailable]);
});

test("fail-open：无 UI（headless）→ 放行 + release(no-ui)，且连 classify 都不调", async () => {
  const { ports, calls } = makePorts({ hasUI: false });
  const outcome = await judgeToolCall(bashCall("rm -rf /tmp/build"), ports);
  assert.deepEqual(outcome, { kind: "release", failOpen: FailOpenReasons.noUI });
  assert.deepEqual(calls.release, [FailOpenReasons.noUI]);
  assert.equal(calls.classify, 0, "问不了人就没有判断的意义（省钱且省延迟）");
  assert.equal(calls.confirm, 0);
});

test("fail-open：弹框本身抛错 → 放行 + release(confirm-error)", async () => {
  const { ports, calls } = makePorts({
    classify: () => ({ kind: "answer", answer: choiceAnswer("destructive", 0.9) }),
    confirm: () => {
      throw new Error("对话框崩了");
    },
  });
  const outcome = await judgeToolCall(bashCall("rm -rf /tmp/build"), ports);
  assert.deepEqual(outcome, { kind: "release", failOpen: FailOpenReasons.confirmError });
  assert.deepEqual(calls.release, [FailOpenReasons.confirmError]);
  assert.equal(calls.classify, 1);
});

test("solo 开启：零候选筛、零 classify、零弹框、零 release（本门完全不介入）", async () => {
  const { ports, calls } = makePorts({ solo: true });
  const outcome = await judgeToolCall(bashCall("rm -rf /tmp/build"), ports);
  assert.deepEqual(outcome, { kind: "skip", why: "solo" });
  assert.equal(calls.solo, 1, "solo 状态只读一次，判完立刻退出");
  assert.equal(calls.screen, 0, "不筛候选");
  assert.equal(calls.classify, 0);
  assert.equal(calls.confirm, 0);
  assert.deepEqual(calls.release, [], "solo 是用户显式选择，不是放行事故");
});

test("solo 关闭时同一条候选命令恢复拦截（同一逻辑单元对照）", async () => {
  let solo = true;
  const { ports, calls } = makePorts({
    classify: () => ({ kind: "answer", answer: choiceAnswer("destructive", 0.9) }),
    confirm: () => false,
  });
  // solo 状态可切换：契约要求每次现读，不缓存（docs/cross/solo-approval-gate.md）
  const soloPorts: GatePorts = { ...ports, isSoloActive: () => solo };
  assert.equal((await judgeToolCall(bashCall("rm -rf /tmp/build"), soloPorts)).kind, "skip");
  assert.equal(calls.classify, 0);
  solo = false;
  const outcome = await judgeToolCall(bashCall("rm -rf /tmp/build"), soloPorts);
  assert.equal(outcome.kind, "block");
  assert.equal(calls.confirm, 1);
  assert.equal(calls.classify, 1);
});

test("classify 收到的是构造好的上下文：工具名 + 命令原文 + cwd + 问题定义 + 注解（惰性读一次）", async () => {
  const { ports, calls } = makePorts();
  const { call, state } = callWithAnnotations("rm -rf /tmp/build", { destructiveHint: true });
  await judgeToolCall({ ...call, cwd: "/repo/sub" }, ports);
  assert.equal(calls.contexts.length, 1);
  const context = calls.contexts[0];
  assert.equal(context.state.tool, "bash");
  assert.equal(context.state.command, "rm -rf /tmp/build");
  assert.equal(context.state.cwd, "/repo/sub");
  assert.deepEqual(context.state.annotations, { destructiveHint: true });
  const question = context.questions[CLASSIFIER_QUESTION_ID];
  assert.equal(question.type, "choice", "答案必须可判读（bool 拿不到 confidence）");
  assert.equal(state.reads, 1, "注解只在候选路径读一次");
});

test("buildClassifierContext：问题只有一条 choice，两个互斥标签都给了判据", () => {
  const context = buildClassifierContext(bashCall("ls"));
  assert.deepEqual(Object.keys(context.questions), [CLASSIFIER_QUESTION_ID]);
  const question = context.questions[CLASSIFIER_QUESTION_ID];
  if (question.type !== "choice") throw new Error("问题类型必须是 choice");
  assert.deepEqual(Object.keys(question.criteria).sort(), ["destructive", "safe"]);
});

test("buildClassifierContext：超长命令截断到上限（不把上下文撑爆），并留标注", () => {
  const command = "rm -rf " + "a".repeat(MAX_COMMAND_CHARS * 2);
  const context = buildClassifierContext(bashCall(command));
  const stored = String(context.state.command);
  assert.equal(stored.length, MAX_COMMAND_CHARS);
  assert.ok(stored.startsWith("rm -rf "), "保头部（危险动作通常在开头）");
  assert.equal(context.state.commandTruncated, true);
});

test("buildClassifierContext：无注解时不塞 annotations 字段（少一个噪声键）", () => {
  const context = buildClassifierContext(bashCall("rm -rf /"));
  assert.equal(Object.hasOwn(context.state, "annotations"), false);
});

test("readJudgement：四种判决（可疑 / 低置信度 / 安全 / 不可判读）都是显式分支", () => {
  assert.equal(readJudgement(choiceAnswer("destructive", 0.99)).kind, "suspicious");
  assert.equal(readJudgement(choiceAnswer("safe", 0.2, { safe: 0.55, destructive: 0.45 })).kind, "low-confidence");
  assert.equal(readJudgement(choiceAnswer("safe", 0.99, { safe: 0.99, destructive: 0.01 })).kind, "safe");
  assert.equal(readJudgement(undefined).kind, "unreadable");
  assert.equal(readJudgement({ type: "score", score: 3, confidence: 0.9 }).kind, "unreadable");
});


// ---------- classifyCommand：宿主契约的机械收口（网络边界只能真机验，这里验信号与分流） ----------

const STUB_MODEL = { type: "classifier", id: "jev-latest", provider: "typesafe", api: "typesafe-system-one" } as never;

function stubRegistry(
  handler: (options?: { signal?: AbortSignal }) => Promise<ClassifierResult> | ClassifierResult,
  options: { noModel?: boolean } = {},
) {
  const calls = { getModel: 0, classify: 0 };
  const registry: ClassifierRegistryLike = {
    getModelOfType: () => {
      calls.getModel += 1;
      return options.noModel ? undefined : (STUB_MODEL as ClassifierModel<ClassifierApi>);
    },
    classify: async (_model, _context, options) => {
      calls.classify += 1;
      return handler(options);
    },
  };
  return { registry, calls };
}

test("classifyCommand：模型不在目录里 → unavailable（不发起请求）", async () => {
  const { registry, calls } = stubRegistry(() => classifierResult({}), { noModel: true });
  const verdict = await classifyCommand(registry, buildClassifierContext(bashCall("rm -rf /")), 20);
  assert.deepEqual(verdict, { kind: "unavailable" });
  assert.equal(calls.classify, 0);
});

test("classifyCommand：到点 abort → error/timedOut（超时 fail-open 的机械保证）", async () => {
  const { registry } = stubRegistry(
    (options) =>
      new Promise<ClassifierResult>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(classifierResult({}, "aborted")));
      }),
  );
  const verdict = await classifyCommand(registry, buildClassifierContext(bashCall("rm -rf /")), 20);
  assert.deepEqual(verdict, { kind: "error", timedOut: true });
});

test("classifyCommand：stopReason=error → error/非超时（宿主自己不抛错）", async () => {
  const { registry } = stubRegistry(() => classifierResult({}, "error"));
  const verdict = await classifyCommand(registry, buildClassifierContext(bashCall("rm -rf /")), 200);
  assert.deepEqual(verdict, { kind: "error", timedOut: false });
});

test("classifyCommand：成功 → 取该问题的答案", async () => {
  const answer = choiceAnswer("destructive", 0.8);
  const { registry } = stubRegistry(() => classifierResult({ [CLASSIFIER_QUESTION_ID]: answer }));
  const verdict = await classifyCommand(registry, buildClassifierContext(bashCall("rm -rf /")), 200);
  assert.deepEqual(verdict, { kind: "answer", answer });
});

test("classifyCommand：实现违约抛错 → error（不把异常抛回宿主事件循环）", async () => {
  const { registry } = stubRegistry(() => {
    throw new Error("契约违约");
  });
  const verdict = await classifyCommand(registry, buildClassifierContext(bashCall("rm -rf /")), 200);
  assert.deepEqual(verdict, { kind: "error", timedOut: false });
});

