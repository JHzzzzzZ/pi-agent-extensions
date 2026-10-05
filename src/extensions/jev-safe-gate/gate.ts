/**
 * jev-safe-gate — 判定层（注入了端口的纯逻辑，无宿主、无网络）
 *
 * 本扩展的全部语义都在这里，且只有一条：**判定结果只加摩擦**。
 *
 * - 判定「安全」= 不弹框 + 返回放行（handler 返回 undefined）——它**不授予任何权限**，
 *   别的 `tool_call` 处理器（宿主既有审批门）照常运行、照常可以 block；
 * - 判定「可疑 / 拿不准 / 读不懂」= 弹**一次**确认；用户拒绝才 block；
 * - 判定「不可用」（classify 抛错、超时、无分类器模型、无 UI、弹框崩溃）= fail-open
 *   放行，但每一次都经 `ports.release()` 记一次可观测放行（对齐文档的不可协商要求：
 *   不允许门静默失效）。
 *
 * 绝不修改命令文本：`GateCall.command` 只读，同意即原样执行。
 * solo 免审批模式开启时本函数在第一步就退出（连候选筛都不跑）。
 */
import type { ClassifierAnswer, ClassifierContext, ClassifierModel, ClassifierApi, ClassifierQuestion, ClassifierResult, JsonObject } from "@earendil-works/pi-ai";
import type { ToolAnnotations } from "@earendil-works/pi-coding-agent";
import { findCandidates } from "./candidates.ts";

/** 唯一被拦的工具（用户口径：第一版只拦 bash）。 */
export const GATED_TOOL = "bash";

/** 分类器模型：内置目录里的 `typesafe/jev-latest`（typesafe 扩展已退休，无需 API key 录入）。 */
export const JEV_CLASSIFIER = { provider: "typesafe", modelId: "jev-latest" } as const;

/** 问题 id 与两个互斥标签（choice：既给 choice 也给 confidence/probabilities）。 */
export const CLASSIFIER_QUESTION_ID = "irreversible_damage";
export const QUESTION_SAFE = "safe";
export const QUESTION_DESTRUCTIVE = "destructive";

/** 可疑阈值：destructive 概率达到即弹框。 */
export const SUSPICIOUS_PROBABILITY = 0.5;
/** 置信度阈值：低于它也弹框（"拿不准"也算需要人看一眼）。 */
export const MIN_CONFIDENCE = 0.6;
/** 命令原文进上下文的截断上限（分类器窗口 64k，留足余量，且保头部）。 */
export const MAX_COMMAND_CHARS = 2000;
/** 判断超时（毫秒）：到点 abort → fail-open + 可观测。 */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 4000;

export const CONFIRM_TITLE = "Jev 风险判断：这条 bash 命令可能需要你确认";

/** 阻止这次调用时给模型的静态理由（不回显命令内容，避免把敏感串写进转录）。 */
export const BLOCK_REASON =
  "jev-safe-gate：用户拒绝执行这条 bash 命令——命令未执行，请不要自动重试或换写法绕过，先向用户确认意图。";

/** fail-open 原因码（放行也必须可观测，见 observability.ts）。 */
export const FailOpenReasons = {
  noUI: "no-ui",
  classifierUnavailable: "classifier-unavailable",
  classifyError: "classify-error",
  classifyTimeout: "classify-timeout",
  confirmError: "confirm-error",
  internalError: "internal-error",
} as const;
export type FailOpenReason = (typeof FailOpenReasons)[keyof typeof FailOpenReasons];

/** 状态条用的短标签（footer 宽度有限，原因码留给日志与 notify）。 */
export const FAIL_OPEN_LABELS: Record<FailOpenReason, string> = {
  "no-ui": "无界面",
  "classifier-unavailable": "无分类器",
  "classify-error": "报错",
  "classify-timeout": "超时",
  "confirm-error": "弹框失败",
  "internal-error": "门报错",
};

/** 问题定义是静态常量（每次判断复用，不随命令变化——判据必须在提示词里写死）。 */
const QUESTIONS: Record<string, ClassifierQuestion> = {
  [CLASSIFIER_QUESTION_ID]: {
    type: "choice",
    instructions:
      "判断这条 bash 命令是否会直接造成不可逆后果。只按命令本身判断，不考虑用户意图或上下文承诺。",
    criteria: {
      [QUESTION_SAFE]: "只读取信息、只在本仓库产生可重建的产物，或后果可用 git / 备份 / 重跑找回。",
      [QUESTION_DESTRUCTIVE]:
        "销毁数据、丢弃改动、覆盖远端历史、写入块设备/文件系统，或把来源不可信的网络内容直接交给 shell 执行——事后无法完整找回。",
    },
  },
};

export interface GateCall {
  /** 工具名（只有 `GATED_TOOL` 会被处理）。 */
  toolName: string;
  /** 命令原文（只读：本扩展绝不改写它）。 */
  command: string;
  /** 会话 cwd（进判断上下文）。 */
  cwd: string;
  /** 惰性读工具注解：宿主 `getAllTools()` 不便宜，只在候选路径上取一次。 */
  annotations: () => ToolAnnotations | undefined;
}

/** 分类端口的结果（把宿主"不抛错、失败走 stopReason"的契约收成三种情形）。 */
export type ClassifierVerdict =
  | { kind: "answer"; answer: ClassifierAnswer | undefined }
  | { kind: "unavailable" }
  | { kind: "error"; timedOut: boolean };

/** `ctx.modelRegistry` 里本扩展真正用到的那一小面（真实 ModelRegistry 结构上满足它）。 */
export interface ClassifierRegistryLike {
  getModelOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
  classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: { signal?: AbortSignal }): Promise<ClassifierResult>;
}

export interface GatePorts {
  /** 跨扩展契约：solo 状态（docs/cross/solo-approval-gate.md，fail-closed，每次现读）。 */
  isSoloActive: () => boolean;
  /** 能不能弹框（headless ⇒ 无法征得同意，fail-open）。 */
  hasUI: () => boolean;
  /** 便宜候选筛（非候选零分类调用）。 */
  screen: (command: string) => string[];
  classify: (context: ClassifierContext) => Promise<ClassifierVerdict>;
  confirm: (title: string, message: string) => Promise<boolean>;
  /** 记一次 fail-open 放行（可观测的唯一出口）。 */
  release: (reason: FailOpenReason) => void;
}

export type GateOutcome =
  | { kind: "skip"; why: "not-bash" | "solo" | "not-candidate" }
  | { kind: "release"; failOpen: FailOpenReason }
  | { kind: "allow"; candidates: string[] }
  | { kind: "block"; candidates: string[] };

export type Judgement =
  | { kind: "suspicious"; why: string }
  | { kind: "low-confidence"; why: string }
  | { kind: "safe" }
  | { kind: "unreadable" };

/** 把分类器答案读成判决：可疑 / 拿不准 / 安全 / 读不懂（读不懂 ⇒ 交给人，绝不当成安全）。 */
export function readJudgement(answer: ClassifierAnswer | undefined): Judgement {
  if (answer === undefined || answer.type !== "choice") return { kind: "unreadable" };
  const probability = answer.probabilities?.[QUESTION_DESTRUCTIVE] ?? (answer.choice === QUESTION_DESTRUCTIVE ? 1 : 0);
  if (answer.choice === QUESTION_DESTRUCTIVE) return { kind: "suspicious", why: `choice=${QUESTION_DESTRUCTIVE}` };
  if (probability >= SUSPICIOUS_PROBABILITY) return { kind: "suspicious", why: `p=${probability}` };
  if (answer.confidence < MIN_CONFIDENCE) return { kind: "low-confidence", why: `confidence=${answer.confidence}` };
  return { kind: "safe" };
}

/** 构造分类器上下文：工具名 + 命令原文（截断）+ cwd + 来源工具注解。 */
export function buildClassifierContext(call: GateCall): ClassifierContext {
  const truncated = call.command.length > MAX_COMMAND_CHARS;
  const command = truncated ? call.command.slice(0, MAX_COMMAND_CHARS) : call.command;
  const state: JsonObject = { tool: call.toolName, command, cwd: call.cwd };
  if (truncated) state.commandTruncated = true;
  const annotations = call.annotations();
  if (annotations !== undefined) state.annotations = annotations as unknown as JsonObject;
  return { state, questions: QUESTIONS };
}

/** 弹框正文：让用户看见原文与判据（不回显进模型可见的错误信息）。 */
function confirmBody(call: GateCall, judgement: Exclude<Judgement, { kind: "safe" }>): string {
  const why =
    judgement.kind === "suspicious"
      ? `Jev 判定这条命令可能造成不可逆破坏（${judgement.why}）`
      : judgement.kind === "low-confidence"
        ? `Jev 拿不准这条命令会不会造成不可逆破坏（${judgement.why}）`
        : "Jev 没能给出可判读的答案（读不懂就不当它安全）";
  return [
    why,
    "",
    `工具：${call.toolName}`,
    `目录：${call.cwd}`,
    "命令：",
    call.command.length > MAX_COMMAND_CHARS ? `${call.command.slice(0, MAX_COMMAND_CHARS)}…（已截断）` : call.command,
    "",
    "同意 → 命令原样执行（本扩展不改写命令）；拒绝 → 这次调用被阻止。",
  ].join("\n");
}

/** 真判断入口：顺序即成本顺序（非 bash → solo → 无 UI → 非候选 → 分类 → 弹框）。 */
export async function judgeToolCall(call: GateCall, ports: GatePorts): Promise<GateOutcome> {
  if (call.toolName !== GATED_TOOL) return { kind: "skip", why: "not-bash" };
  if (ports.isSoloActive()) return { kind: "skip", why: "solo" };
  if (!ports.hasUI()) return releaseOpen(ports, FailOpenReasons.noUI);

  const candidates = ports.screen(call.command);
  if (candidates.length === 0) return { kind: "skip", why: "not-candidate" };

  let verdict: ClassifierVerdict;
  try {
    verdict = await ports.classify(buildClassifierContext(call));
  } catch {
    return releaseOpen(ports, FailOpenReasons.classifyError);
  }
  if (verdict.kind === "unavailable") return releaseOpen(ports, FailOpenReasons.classifierUnavailable);
  if (verdict.kind === "error") {
    return releaseOpen(ports, verdict.timedOut ? FailOpenReasons.classifyTimeout : FailOpenReasons.classifyError);
  }

  const judgement = readJudgement(verdict.answer);
  if (judgement.kind === "safe") return { kind: "allow", candidates };

  const approved = await askUser(ports, call, judgement);
  if (approved === undefined) return releaseOpen(ports, FailOpenReasons.confirmError);
  return approved ? { kind: "allow", candidates } : { kind: "block", candidates };
}

function releaseOpen(ports: GatePorts, reason: FailOpenReason): GateOutcome {
  ports.release(reason);
  return { kind: "release", failOpen: reason };
}

/** 弹一次确认；弹框本身崩溃 ⇒ undefined（调用方按 fail-open 处理）。 */
async function askUser(ports: GatePorts, call: GateCall, judgement: Exclude<Judgement, { kind: "safe" }>): Promise<boolean | undefined> {
  try {
    return await ports.confirm(CONFIRM_TITLE, confirmBody(call, judgement));
  } catch {
    return undefined;
  }
}

/**
 * 调分类器：查模型 → 带超时调用 → 把宿主契约（不抛错、失败走 stopReason）收成 ClassifierVerdict。
 * 超时用 `signal` 实现（宿主分类 API 只有 signal 这一个取消口），到点 abort 即 fail-open。
 */
export async function classifyCommand(registry: ClassifierRegistryLike, context: ClassifierContext, timeoutMs: number): Promise<ClassifierVerdict> {
  const model = registry.getModelOfType("classifier", JEV_CLASSIFIER.provider, JEV_CLASSIFIER.modelId);
  if (model === undefined) return { kind: "unavailable" };
  const controller = new AbortController();
  // 不能用 unref：这个计时器就是「到点放行」的唯一推动力，进程若没有别的待办
  // （headless 收尾）会先退出，await 永远不返回。（计时器在 finally 清掉，不会泄漏。）
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await registry.classify(model, context, { signal: controller.signal });
    if (result.stopReason === "stop") return { kind: "answer", answer: result.answers[CLASSIFIER_QUESTION_ID] };
    return { kind: "error", timedOut: controller.signal.aborted };
  } catch {
    return { kind: "error", timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}
