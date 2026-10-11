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
import { collectRemoteContext, toContextFiles, type RemoteContextCapability, type RemoteContextRequest } from "./remote-context.ts";
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
  /** 远端取文件能力（`session_start` 协商一次；没有提供方就是 null ⇒ 行为退回「一行提示」）。 */
  let remoteContext: RemoteContextCapability | null = null;

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

  /**
   * 能力协商（跨扩展契约 docs/cross/remote-context-capability.md）：在 `session_start` 广播盒子，
   * 提供方（remote-tools）在同步回调里填槽。畸形载荷 / 没装对端 ⇒ 拿不到能力，只 notify 一次。
   */
  const connectRemoteContext = (ctx: ExtensionContext): void => {
    const offer = collectRemoteContext(pi.events);
    remoteContext = offer.capability;
    if (offer.warning === null || !ctx.hasUI) return;
    try {
      ctx.ui.notify(`dir-context：${offer.warning}`, "warning");
    } catch {
      /* UI 异常隔离 */
    }
  };

  pi.on("session_start", (_event, ctx) => {
    reset(ctx);
    connectRemoteContext(ctx);
  });
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

  /**
   * 远端触碰 → 注入文本。三态分开，只说该说的话：
   * - `injected`：真的注入了（追加文本，**不再**给提示——用户决定：注入成功就删掉提示）；
   * - `nothing`：取到了但没有可注入的**新**内容（已经注入过 / 远端那个目录根本没有约定文件）
   *   —— 不是失败，也不给提示（重复调用同一目录不应被当成出错）；
   * - `unavailable`：**取不到**（没装 remote-tools / 对端出错 / ssh 失败 / 其中任何一个请求失败且这次
   *   什么都没注成）—— 退回那行提示（取不到就说取不到，不猜成「远端没有约定文件」）。
   *
   * 去重键与本地共用一个集合但**前缀不同**（`remote:<host>\0<路径>`）：同一台机的远端路径与
   * 本机路径在字符串上可能一模一样。预算/截断/块格式全走 `inject.ts`，规则只有一份。
   */
  const injectRemoteContext = async (
    requests: readonly RemoteContextRequest[],
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): Promise<RemoteInjection> => {
    if (remoteContext === null) return { kind: "unavailable" };
    if (event.isError) return { kind: "nothing" };
    if (!event.content.some((block) => block.type === "text")) return { kind: "nothing" };

    const contents: ContextFileContent[] = [];
    let failed = 0;
    for (const request of dedupeRemoteRequests(requests)) {
      const outcome = await remoteContext.fetchRemoteContext(request);
      if (!outcome.ok) {
        failed += 1;
        continue;
      }
      for (const file of toContextFiles(request.remote, outcome.files)) {
        if (!injected.has(file.absolutePath)) contents.push(file);
      }
    }
    if (contents.length === 0) return failed > 0 ? { kind: "unavailable" } : { kind: "nothing" };

    // 与本地同一条口径：「已注入」只标记真正进了文本的文件（被预算丢弃的下次还能重试）。
    const injection = buildInjection(contents);
    for (const file of injection.injected) {
      injected.add(file.absolutePath);
      loaded.push({ relativePath: file.relativePath, truncated: file.truncated, bytes: file.bytes });
    }
    renderStatus(ctx);
    return { kind: "injected", text: injection.text };
  };

  pi.on("tool_result", async (event, ctx) => {
    // 嵌套调用（codemode 脚本的 tools.*）：结果只回到调用方工具、不进 transcript，往这里注入没意义；
    // 但它的 `input` 是**完整入参**（宿主不截断），记下来供发起它的那次**顶层** codemode 结果使用。
    // 不看 `isError`：文件可能已被读写，注入与这次嵌套调用的成败无关（对齐决策 1）。
    if (event.parentToolCallId) {
      // 远端嵌套调用不记触碰：记了就会在顶层结果里按本机 cwd 注入同名路径的上下文，
      // 正是 dir-context-todo#4 要修的错注入。只留记号（外加取上下文的请求），让顶层那次结果处理。
      if (isRemoteCall(event.input)) {
        nestedTouches.markRemote(event.parentToolCallId);
        const request = toRemoteRequest(event.toolName, event.input);
        if (request !== null) nestedTouches.recordRemoteRequest(event.parentToolCallId, request);
        return undefined;
      }
      const touch = detectTouch(event.toolName, event.input);
      if (touch) nestedTouches.record(event.parentToolCallId, touch);
      return undefined;
    }

    // 远端调用（`remote` 字段来自 remote-tools 一类插件，判据见 remote.ts）：`path` 在**远端**解析、
    // 与本地 cwd 无关 ⇒ 本机上下文一律不参与（fail-closed）。判据只看入参字段：不 import 任何插件、
    // 不共享代码；没装 remote-tools 时这个字段根本不存在，行为与今天逐字一致。
    // 注：内置 codemode 的入参只有 `code`，不会带 `remote`，两条分支互斥。假设破裂（第三方同名工具
    // 带 remote）的后果只是该组缓冲不被 take——驻留到 8 组上限被淘汰，方向仍是少注入。
    // 提示按入参字段附着，不限定工具：带 remote 的 grep/find（不在触发面上）结果也会拿到那行提示。
    const remoteCall = isRemoteCall(event.input);
    const request = remoteCall ? toRemoteRequest(event.toolName, event.input) : null;
    const collected = remoteCall
      ? { touches: [] as Touch[], remote: true, remoteRequests: request === null ? [] : [request] }
      : collectTouches(event, nestedTouches);

    const injectedText = collected.touches.length === 0 ? undefined : injectLocalContext(collected.touches, ctx);
    // 没有可取上下文的触碰（`grep`/`find` 这类不在触发面上的工具带 remote）⇒ 按「取不到」处理，保留提示。
    const remote =
      collected.remoteRequests.length === 0
        ? { kind: "unavailable" as const }
        : await injectRemoteContext(collected.remoteRequests, event, ctx);
    // 提示只在**取不到**远端上下文时出现（注入成功不必说；没东西可注也不必说）。
    const notice = remote.kind === "unavailable" && collected.remote ? takeRemoteNotice(event) : undefined;

    // 只追加 text block：原内容逐字保留在前，注入内容与提示在后（模型读到的顺序即此）。
    // 宿主契约：替换 `content` 而不回传 `structuredContent` 会**丢掉**结构化结果
    //（`ToolResultEventResult` 明文警告 + runner 真的 delete），而 `read` / `bash` 都产出
    // structuredContent —— 必须原样回传，否则 transcript 里的结构化数据静默丢失。
    const appended = [injectedText, remote.kind === "injected" ? remote.text : undefined, notice].filter(
      (text): text is string => text !== undefined,
    );
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

/** 远端注入的三态（见 `injectRemoteContext`）：只有 `unavailable` 才退回提示行。 */
type RemoteInjection = { kind: "injected"; text: string } | { kind: "nothing" } | { kind: "unavailable" };

interface CollectedTouches {
  touches: Touch[];
  /** 对应的 codemode 分组里出现过远端调用（普通工具恒 false；远端顶层调用不走这个函数）。 */
  remote: boolean;
  /** 该结果里要取远端上下文的触碰（不在触发面上的工具不进这里）。 */
  remoteRequests: RemoteContextRequest[];
}

/**
 * 远端触碰 → 取上下文的请求。不在触发面上的工具（`grep` / `find` 等）⇒ null：
 * 它们**不取**远端上下文（但提示仍按入参字段附着，见 remote.ts）。
 */
function toRemoteRequest(toolName: string, input: Record<string, unknown>): RemoteContextRequest | null {
  const touch = detectTouch(toolName, input);
  const remote = input.remote;
  if (touch === null || typeof remote !== "string" || remote.length === 0) return null;
  const remotePort = input.remotePort;
  return {
    remote,
    ...(typeof remotePort === "number" ? { remotePort } : {}),
    path: touch.rawPath,
    kind: touch.kind,
  };
}

/** 同一个结果里的重复请求（脚本多次碰同一目录）只取一次。 */
function dedupeRemoteRequests(requests: readonly RemoteContextRequest[]): RemoteContextRequest[] {
  const seen = new Set<string>();
  const kept: RemoteContextRequest[] = [];
  for (const request of requests) {
    const key = `${request.remote}\u0000${request.remotePort ?? ""}\u0000${request.kind}\u0000${request.path ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(request);
  }
  return kept;
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
  const empty: CollectedTouches = { touches: [], remote: false, remoteRequests: [] };
  // 判「是不是 codemode」只认工具名（与 details 形状解耦）：无论 details 长什么样，该组缓冲都要在
  // 这次结果处取走，也都要给缓冲触碰一个上场的时机（details 不可用时它就是唯一来源）。
  if (isCodemodeResult(event.toolName)) {
    const buffered = nestedTouches.take(event.toolCallId);
    if (event.isError) return empty;
    if (!event.content.some((block) => block.type === "text")) return empty;
    return {
      touches: dedupeTouches([...buffered.touches, ...(detectCodemodeTouches(event.toolName, event.details) ?? [])]),
      remote: buffered.remote,
      remoteRequests: buffered.remoteRequests,
    };
  }

  if (event.isError) return empty;
  if (!event.content.some((block) => block.type === "text")) return empty;
  const touch = detectTouch(event.toolName, event.input);
  return { touches: touch ? [touch] : [], remote: false, remoteRequests: [] };
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
