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
 * 设计要点（决策记录见 todos/align/dir-context-todo#1.md 与 docs/adr/0010）：
 * - 注入通道 = `tool_result` 追加 text block（最窄的公开接缝；失败不影响工具本身）。
 * - 会话内每绝对路径只注入一次；`session_compact` 后清空（compact 会把之前的注入
 *   从上下文里抹掉，必须允许按需重载，否则那段上下文永久丢失）。
 * - cwd 之外的触碰、失败结果、嵌套工具调用一律零注入（fail-open 降级，绝不改坏
 *   原结果）。
 */
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAnchor } from "./anchor.ts";
import { discoverContextFiles } from "./discover.ts";
import { buildInjection, type ContextFileContent } from "./inject.ts";
import { canonicalize, toDisplayPath } from "./paths.ts";
import { writeBand } from "./status-band.ts";
import { detectTouch } from "./touch.ts";

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
  const loaded: LoadedFile[] = [];
  let readFailureReported = false;

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
    loaded.length = 0;
    readFailureReported = false;
    renderStatus(ctx);
  };

  const notifyWarn = (ctx: ExtensionContext, message: string): void => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, "warning");
    } catch {
      /* UI 异常隔离 */
    }
  };

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_compact", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    injected.clear();
    loaded.length = 0;
    if (!ctx.hasUI) return;
    try {
      writeBand(STATUS_KEY, undefined, (rendered) => ctx.ui.setStatus(STATUS_KEY, rendered));
    } catch {
      /* UI 异常隔离 */
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || event.parentToolCallId) return undefined;
    const touch = detectTouch(event.toolName, event.input);
    if (!touch) return undefined;

    const anchor = resolveAnchor({ rawPath: touch.rawPath, kind: touch.kind, cwd: ctx.cwd });
    if (!anchor.ok) return undefined;
    if (anchor.anchorDir === null) return undefined;

    const root = canonicalize(ctx.cwd);
    const pending = discoverContextFiles({ anchorDir: anchor.anchorDir, rootDir: root }).filter((file) => !injected.has(file));
    if (pending.length === 0) return undefined;

    const contents: ContextFileContent[] = [];
    for (const absolutePath of pending) {
      const content = readContextFile(absolutePath);
      if (content === null) {
        // 读不出来就不标记已注入：下个触碰还能重试（fail-open，但可观测一次）。
        if (!readFailureReported) {
          readFailureReported = true;
          notifyWarn(ctx, "dir-context：有上下文文件读取失败，本次跳过；详情见工单 docs/extensions/dir-context.md");
        }
        continue;
      }
      injected.add(absolutePath);
      contents.push({ absolutePath, relativePath: toDisplayPath(root, absolutePath), content });
    }
    if (contents.length === 0) return undefined;

    const injection = buildInjection(contents);
    for (const file of injection.injected) {
      loaded.push({ relativePath: file.relativePath, truncated: file.truncated, bytes: file.bytes });
    }
    renderStatus(ctx);

    // 只追加一个 text block：原内容逐字保留在前，注入内容在后（模型读到的顺序即此）。
    return { content: [...event.content, { type: "text", text: injection.text }] };
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

function readContextFile(absolutePath: string): string | null {
  try {
    return fs.readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
}

function describeLoaded(loaded: LoadedFile[]): string {
  if (loaded.length === 0) return "dir-context：本会话还没有注入任何嵌套目录上下文";
  const lines = loaded.map((file) => `- ${file.relativePath}${file.truncated ? `（已截断，注入 ${file.bytes} 字节）` : ""}`);
  return [`dir-context：本会话已注入 ${loaded.length} 个嵌套上下文文件`, ...lines].join("\n");
}
