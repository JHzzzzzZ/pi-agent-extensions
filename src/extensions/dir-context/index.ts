/**
 * dir-context — 目录作用域上下文注入（Pi extension entry）
 *
 * 补上 pi 原生加载范围的一格：`loadProjectContextFiles()` 只走 **agent dir + cwd +
 * cwd 的祖先链**，子树一概不读。本扩展在模型**触碰某个目录**时（read/write/edit/
 * ls/bash 单文件读），把该目录到 cwd 之间严格位于 cwd 之下的 `AGENTS.override.md` /
 * `AGENTS.md` / `CLAUDE.md` 追加到当次工具结果里——语义对齐 Claude Code 的
 * on-demand nested CLAUDE.md（官方原文：*"loads each one once Claude reads, writes,
 * or edits another file in that subdirectory"*），并多覆盖 `ls` 与「写新文件」。
 *
 * 设计要点（决策记录见 todos/align/dir-context-todo#1.md 与 docs/adr/0011）：
 * - 注入通道 = `tool_result` 追加 text block（最窄的公开接缝；失败不影响工具本身）。
 * - 会话内每绝对路径只注入一次；`session_compact` 后清空（compact 会把之前的注入
 *   从上下文里抹掉，必须允许按需重载，否则那段上下文永久丢失）。
 * - cwd 之外的触碰、失败结果、嵌套工具调用一律零注入（fail-open 降级，绝不改坏
 *   原结果）。嵌套调用（codemode 脚本发起）的补偿路径：**嵌套事件带完整入参**，按顶层调用 id
 *   缓冲，等**顶层** codemode 结果到达时与 `details.calls`（截断预览，兜底）取并集，再复用同一套
 *   发现/去重/预算（ADR-0012 及其 v1.2 补充 / 工单 dir-context-todo#3）。
 * - **远端调用**（入参带 `remote`，来自 remote-tools 一类插件）零注入：`path` 在远端解析，
 *   与本地 cwd 无关，按本地解锚点会错注入（见 remote.ts / 工单 dir-context-todo#4）。
 */
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { resolveAnchor } from "./anchor.ts";
import { createNestedTouchBuffer, dedupeTouches, detectCodemodeTouches, isCodemodeResult, type NestedTouchBuffer } from "./codemode.ts";
import { discoverContextFilesForAnchors } from "./discover.ts";
import { ErrorCodes, type DirContextError } from "./errors.ts";
import { buildInjection, type ContextFileContent } from "./inject.ts";
import { canonicalize, toDisplayPath } from "./paths.ts";
import { isRemoteCall, REMOTE_NOTICE } from "./remote.ts";
import { writeBand } from "./status-band.ts";
import { detectTouch, type Touch } from "./touch.ts";

/** footer 排序带键（契约见 docs/cross/status-bar.md，带号 70 = jev-safe-gate 之后）。 */
export const STATUS_KEY = "70:dir-context";
export const COMMAND = "dir-context";
export const COMMAND_STATUS = "dir-context:status";

interface LoadedFile {
  relativePath: string;
  truncated: boolean;
  bytes: number;
}

export default function dirContext(pi: ExtensionAPI): (() => void) | void {
  /** 本会话已注入过的绝对路径（compact/shutdown 时清空）。 */
  const injected = new Set<string>();
  /** codemode 的嵌套触碰缓冲（顶层结果到达即取走；reset 时清空）。 */
  const nestedTouches = createNestedTouchBuffer();
  const loaded: LoadedFile[] = [];
  let readFailureReported = false;
  /** 远端提示是否已给过（会话内一次，见 remote.ts 的 REMOTE_NOTICE）。 */
  let remoteNoticeShown = false;

  const renderStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    try {
      const text = loaded.length > 0 ? `${loaded.length} dir-context` : undefined;
      writeBand(STATUS_KEY, text, (rendered) => ctx.ui.setStatus(STATUS_KEY, rendered));
    } catch {
      /* UI 异常隔离：状态写入失败不影响注入 */
    }
  };

  const reset = (ctx: ExtensionContext): void => {
    injected.clear();
    nestedTouches.clear();
    loaded.length = 0;
    readFailureReported = false;
    remoteNoticeShown = false;
    renderStatus(ctx);
  };

  /** 读取失败只报一次（fail-open 降级 + 可观测），错误码来自本层 errors.ts。 */
  const reportReadFailure = (ctx: ExtensionContext, error: DirContextError): void => {
    if (readFailureReported || !ctx.hasUI) return;
    readFailureReported = true;
    try {
      ctx.ui.notify(`dir-context：${error.message}（${error.code}）`, "warning");
    } catch {
      /* UI 异常隔离 */
    }
  };

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_compact", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    injected.clear();
    nestedTouches.clear();
    loaded.length = 0;
    remoteNoticeShown = false;
    if (!ctx.hasUI) return;
    try {
      writeBand(STATUS_KEY, undefined, (rendered) => ctx.ui.setStatus(STATUS_KEY, rendered));
    } catch {
      /* UI 异常隔离 */
    }
  });

  /**
   * 本机触碰 → 注入文本（没有可注入的返回 undefined）。
   *
   * 远端触碰不进这个函数：它的 `path` 在远端解析，按本地 cwd 解锚点就是错注入。
   */
  const injectLocalContext = (touches: readonly Touch[], ctx: ExtensionContext): string | undefined => {
    const anchorDirs: string[] = [];
    for (const touch of touches) {
      const anchor = resolveAnchor({ rawPath: touch.rawPath, kind: touch.kind, cwd: ctx.cwd });
      if (!anchor.ok || anchor.anchorDir === null) continue;
      anchorDirs.push(anchor.anchorDir);
    }
    if (anchorDirs.length === 0) return undefined;

    const root = canonicalize(ctx.cwd);
    const pending = discoverContextFilesForAnchors({ anchorDirs, rootDir: root }).filter((file) => !injected.has(file));
    if (pending.length === 0) return undefined;

    const contents: ContextFileContent[] = [];
    for (const absolutePath of pending) {
      const read = readContextFile(absolutePath);
      if (!read.ok) {
        // 读不出来就不标记已注入：下个触碰还能重试（fail-open，但可观测一次）。
        reportReadFailure(ctx, read);
        continue;
      }
      contents.push({ absolutePath, relativePath: toDisplayPath(root, absolutePath), content: read.value });
    }
    if (contents.length === 0) return undefined;

    // 标记「已注入」必须等 buildInjection 之后，只认真正进了文本的那些：被预算丢弃的
    // 文件没有进上下文，标记了就等于承诺了没发生的事（后续触碰永久拿不到那份内容）。
    const injection = buildInjection(contents);
    for (const file of injection.injected) {
      injected.add(file.absolutePath);
      loaded.push({ relativePath: file.relativePath, truncated: file.truncated, bytes: file.bytes });
    }
    renderStatus(ctx);
    return injection.text;
  };

  /**
   * 远端提示（会话内一次）。只在有文本内容的非错误结果上追加——与注入同一条口径：
   * 失败结果（尾部追加指令只会污染错误诊断）与纯图片结果没有落点。
   */
  const takeRemoteNotice = (event: ToolResultEvent): string | undefined => {
    if (remoteNoticeShown || event.isError) return undefined;
    if (!event.content.some((block) => block.type === "text")) return undefined;
    remoteNoticeShown = true;
    return REMOTE_NOTICE;
  };

  pi.on("tool_result", async (event, ctx) => {
    // 嵌套调用（codemode 脚本的 tools.*）：结果只回到调用方工具、不进 transcript，往这里注入没意义；
    // 但它的 `input` 是**完整入参**（宿主不截断），记下来供发起它的那次**顶层** codemode 结果使用。
    // 不看 `isError`：文件可能已被读写，注入与这次嵌套调用的成败无关（对齐决策 1）。
    if (event.parentToolCallId) {
      // 远端嵌套调用不记触碰：记了就会在顶层结果里按本机 cwd 注入同名路径的上下文，
      // 正是 dir-context-todo#4 要修的错注入。只留记号，让顶层那次结果给一次提示。
      if (isRemoteCall(event.input)) {
        nestedTouches.markRemote(event.parentToolCallId);
        return undefined;
      }
      const touch = detectTouch(event.toolName, event.input);
      if (touch) nestedTouches.record(event.parentToolCallId, touch);
      return undefined;
    }

    // 远端调用（`remote` 字段来自 remote-tools 一类插件，判据见 remote.ts）：`path` 在**远端**解析、
    // 与本地 cwd 无关 ⇒ 本机上下文一律不参与（fail-closed）。判据只看入参字段：不 import 任何插件、
    // 不共享代码；没装 remote-tools 时这个字段根本不存在，行为与今天逐字一致。
    // 注：内置 codemode 的入参只有 `code`，不会带 `remote`，两条分支互斥。
    const remoteCall = isRemoteCall(event.input);
    const collected = remoteCall ? { touches: [] as Touch[], remote: true } : collectTouches(event, nestedTouches);

    const injectedText = collected.touches.length === 0 ? undefined : injectLocalContext(collected.touches, ctx);
    const notice = collected.remote ? takeRemoteNotice(event) : undefined;

    // 只追加 text block：原内容逐字保留在前，注入内容与提示在后（模型读到的顺序即此）。
    // 宿主契约：替换 `content` 而不回传 `structuredContent` 会**丢掉**结构化结果
    //（`ToolResultEventResult` 明文警告 + runner 真的 delete），而 `read` / `bash` 都产出
    // structuredContent —— 必须原样回传，否则 transcript 里的结构化数据静默丢失。
    const appended = [injectedText, notice].filter((text): text is string => text !== undefined);
    if (appended.length === 0) return undefined;
    return {
      content: [...event.content, ...appended.map((text) => ({ type: "text" as const, text }))],
      ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
    };
  });

  const statusHandler = async (_args: string, ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(describeLoaded(loaded), "info");
    } catch {
      /* UI 异常隔离 */
    }
  };

  pi.registerCommand(COMMAND, {
    description: "查看本会话已注入的嵌套目录上下文（dir-context）",
    handler: statusHandler,
  });
  pi.registerCommand(COMMAND_STATUS, {
    description: "查看本会话已注入的嵌套目录上下文（/dir-context 的冒号形式）",
    handler: statusHandler,
  });

  return () => {
    injected.clear();
    loaded.length = 0;
  };
}

interface CollectedTouches {
  touches: Touch[];
  /** 对应的 codemode 分组里出现过远端调用（普通工具恒 false；远端顶层调用不走这个函数）。 */
  remote: boolean;
}

/**
 * 一次顶层工具结果 → 被触碰的路径（可能多个）。三类路径：
 * - 普通工具：入参即触碰（完整入参）。
 * - codemode：嵌套调用的**完整入参**（从缓冲取走）+ `details.calls`（截断预览，兜底）取并集。
 *
 * 两类一律零注入：失败结果（尾部追加指令只会污染错误诊断）、无文本内容的结果（纯图片等，
 * 追加元信息没有落点）。嵌套调用自身在 handler 入口就分流了（不注入，只记触碰）。
 */
function collectTouches(event: ToolResultEvent, nestedTouches: NestedTouchBuffer): CollectedTouches {
  const empty: CollectedTouches = { touches: [], remote: false };
  // 判「是不是 codemode」只认工具名（与 details 形状解耦）：无论 details 长什么样，该组缓冲都要在
  // 这次结果处取走，也都要给缓冲触碰一个上场的时机（details 不可用时它就是唯一来源）。
  if (isCodemodeResult(event.toolName)) {
    const buffered = nestedTouches.take(event.toolCallId);
    if (event.isError) return empty;
    if (!event.content.some((block) => block.type === "text")) return empty;
    return {
      touches: dedupeTouches([...buffered.touches, ...(detectCodemodeTouches(event.toolName, event.details) ?? [])]),
      remote: buffered.remote,
    };
  }

  if (event.isError) return empty;
  if (!event.content.some((block) => block.type === "text")) return empty;
  const touch = detectTouch(event.toolName, event.input);
  return { touches: touch ? [touch] : [], remote: false };
}

function readContextFile(absolutePath: string): { ok: true; value: string } | DirContextError {
  try {
    return { ok: true, value: fs.readFileSync(absolutePath, "utf8") };
  } catch {
    return { ok: false, code: ErrorCodes.contextReadFailed, message: "上下文文件读取失败（权限/编码/竞态删除），本次跳过" };
  }
}

function describeLoaded(loaded: LoadedFile[]): string {
  if (loaded.length === 0) return "dir-context：本会话还没有注入任何嵌套目录上下文";
  const lines = loaded.map((file) => `- ${file.relativePath}${file.truncated ? `（已截断，注入 ${file.bytes} 字节）` : ""}`);
  return [`dir-context：本会话已注入 ${loaded.length} 个嵌套上下文文件`, ...lines].join("\n");
}
