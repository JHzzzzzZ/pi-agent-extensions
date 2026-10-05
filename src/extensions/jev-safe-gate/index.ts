/**
 * jev-safe-gate — Pi 扩展入口（jev-safe-gate-todo#1）
 *
 * 在 tool call **发生前**插一道便宜的 Jev 风险判断：只拦 `bash`，先过正则候选筛
 * （非候选零分类调用、零额外延迟），候选才构造上下文交给内置 `typesafe/jev-latest`
 * 分类器判断；可疑（或置信度低于阈值）时弹**一次**宿主确认——用户拒绝则阻止这次
 * 调用，同意则命令**原样**执行（不改写文本、不追加参数）。
 *
 * 不可协商的两条边界：
 *   ① **只加摩擦**——判定「安全」不授予任何权限，别的 tool_call 处理器（宿主既有
 *      审批门）照常运行；本扩展永不因判定安全而跳过或弱化任何门。
 *   ② **fail-open 但必须可观测**（用户口径）：classify 抛错 / 超时 / 无分类器模型 /
 *      无 UI（headless）/ 弹框崩溃 / 门自身异常 ⇒ 放行，且每一次都计进状态条
 *      （`60:jev-safe-gate`，带最近原因）、首次额外 notify 一次、并落一行日志
 *      （无 UI 时日志是唯一通道）——不允许门静默失效。
 *
 * solo 免审批模式开启时**完全不介入**：不筛候选、不调 classify、不弹框（solo 的
 * 语义就是本会话不要摩擦）；solo 状态只经跨扩展契约 docs/cross/solo-approval-gate.md
 * 读（同构 `solo-gate.ts`，fail-closed）。
 *
 * 安装：复制本目录到 `~/.pi/agent/extensions/jev-safe-gate/` 或 `<项目>/.pi/extensions/`，
 *      Pi 内 `/reload`。测试：`npm test`（cwd = 本目录）。
 */
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolAnnotations, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { findCandidates } from "./candidates.ts";
import {
  BLOCK_REASON,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  FailOpenReasons,
  classifyCommand,
  judgeToolCall,
  type GateCall,
  type GatePorts,
} from "./gate.ts";
import { STATUS_KEY, createReleaseObserver, type ReleaseSink } from "./observability.ts";
import { isSoloActive } from "./solo-gate.ts";
import { writeBand } from "./status-band.ts";

export interface JevSafeGateDeps {
  /** solo 状态读取（契约：每次现读，不缓存）；默认读状态文件。 */
  isSoloActive?: () => boolean;
  /** 判断超时（毫秒）；到点按 fail-open 放行并记录。 */
  classifyTimeoutMs?: number;
  /** 观测出口：仅在无 UI（headless）时被调用；默认 stderr。 */
  log?: (line: string) => void;
}

/** headless 下唯一能留下证据的通道。 */
function logToStderr(line: string): void {
  try {
    console.error(line);
  } catch {
    /* 输出失败不破坏会话 */
  }
}

/** 读来源工具的注解（宿主 `getAllTools()` 不便宜 ⇒ 只在候选路径上被调用一次）。 */
function readAnnotations(pi: ExtensionAPI, toolName: string): ToolAnnotations | undefined {
  try {
    return pi.getAllTools().find((tool) => tool.name === toolName)?.annotations;
  } catch {
    return undefined;
  }
}

export function createJevSafeGateExtension(deps: JevSafeGateDeps = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    const observer = createReleaseObserver();
    const log = deps.log ?? logToStderr;

    /** 本事件的观测出口：状态条走排序带；日志只在没有 UI 时输出（有 UI 时它会被状态条覆盖）。 */
    const sinkFor = (ctx: ExtensionContext): ReleaseSink => ({
      setStatus: (text) => {
        try {
          writeBand(STATUS_KEY, text, (rendered) => ctx.ui.setStatus(STATUS_KEY, rendered));
        } catch {
          /* UI 异常不破坏会话 */
        }
      },
      notify: (text) => {
        try {
          ctx.ui.notify(text, "warning");
        } catch {
          /* UI 异常不破坏会话 */
        }
      },
      log: (line) => {
        if (!ctx.hasUI) log(line);
      },
    });

    const portsFor = (ctx: ExtensionContext): GatePorts => ({
      isSoloActive: deps.isSoloActive ?? (() => isSoloActive()),
      hasUI: () => ctx.hasUI,
      screen: findCandidates,
      classify: (context) => classifyCommand(ctx.modelRegistry, context, deps.classifyTimeoutMs ?? DEFAULT_CLASSIFY_TIMEOUT_MS),
      confirm: (title, message) => ctx.ui.confirm(title, message),
      release: (reason) => observer.record(reason, sinkFor(ctx)),
    });

    pi.on("tool_call", async (event, ctx) => {
      // 事件对象只读：本扩展绝不改写 event.input（同意 = 原样执行）。
      const call: GateCall = {
        toolName: event.toolName,
        command: readCommand(event),
        cwd: ctx.cwd,
        annotations: () => readAnnotations(pi, event.toolName),
      };
      try {
        const outcome = await judgeToolCall(call, portsFor(ctx));
        return outcome.kind === "block" ? { block: true, reason: BLOCK_REASON } : undefined;
      } catch {
        // 门自身异常也按 fail-open 处理，且必须可观测（抛回宿主会打断整个工具批次）。
        observer.record(FailOpenReasons.internalError, sinkFor(ctx));
        return undefined;
      }
    });

    pi.on("session_start", (_event, ctx) => {
      observer.reset(sinkFor(ctx));
    });

    pi.on("session_shutdown", (_event, ctx) => {
      observer.reset(sinkFor(ctx));
    });
  };
}

/** 命令原文读取：非 bash 工具没有命令（判定层随后按工具名直接跳过）。 */
function readCommand(event: ToolCallEvent): string {
  if (!isToolCallEventType("bash", event)) return "";
  const command = event.input.command;
  return typeof command === "string" ? command : "";
}

/** 宿主入口：默认 deps（solo 读契约文件、超时默认 4s、日志走 stderr）。 */
export default createJevSafeGateExtension();
