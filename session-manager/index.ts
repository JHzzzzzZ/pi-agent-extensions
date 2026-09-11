/**
 * session-manager — Pi 扩展：管理落盘会话（`~/.pi/agent/sessions/`）的只读浏览与检索。
 *
 * 能力（实现源见 ./core.ts）：
 *   session 工具（agent 调用，作用于当前会话的会话根目录）
 *     action="list"    列会话（id/时间/大小/模型/标题/目录，按最近修改排序）
 *     action="search"  在用户/助手文本与会话名上全文检索（工具输出不搜）
 *     action="preview" 查看单条会话元数据 + 最近消息 + 宿主接续/分支命令
 *   人类命令（冒号命名空间，对齐仓库 commands-colon 约定）
 *     /session-manager             当前项目会话列表 + 用法提示
 *     /session-manager:list [current|all]
 *     /session-manager:search <检索词>
 *     /session-manager:preview <id 前缀|文件名前缀>
 *
 * 边界：只读，绝不写会话文件；接续/分支交给宿主 `pi --session/--fork`（只输出命令，
 * 不 spawn、不做「第二个主界面」）；删除/重命名等写操作留给后续增量并默认 dry-run。
 *
 * 安装：把本目录复制到 ~/.pi/agent/extensions/session-manager/（全局）或
 *       <项目>/.pi/extensions/session-manager/（项目级），在 Pi 中执行 /reload。
 * 测试：cd session-manager && node --test core.test.ts index.test.ts
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  formatList,
  formatPreview,
  formatSearch,
  listSessions,
  previewSession,
  searchSessions,
  sessionRootOf,
  type SessionResult,
} from "./core.ts";

export const SESSION_TOOL = "session";
export const SESSION_COMMAND = "session-manager";

/** 冒号子命令（独立静态注册；裸 /session-manager 只列当前项目会话）。 */
export const SESSION_SUBCOMMANDS = {
  list: "session-manager:list",
  search: "session-manager:search",
  preview: "session-manager:preview",
} as const;

/** 旧空格写法 → 新命令：只提示改名，绝不执行（对齐 commands-colon 约定）。 */
export const RETIRED_SESSION_SUBCOMMANDS: Record<string, string> = {
  list: SESSION_SUBCOMMANDS.list,
  search: SESSION_SUBCOMMANDS.search,
  preview: SESSION_SUBCOMMANDS.preview,
};

export const SESSION_USAGE = [
  "用法：",
  "  /session-manager                    当前项目会话列表",
  "  /session-manager:list [current|all] 列会话（默认 all）",
  "  /session-manager:search <检索词>    检索历史会话（用户/助手文本）",
  "  /session-manager:preview <id 前缀>  会话详情 + 宿主接续命令",
].join("\n");

/** 测试注入点：rootDir 覆盖会话根目录（默认由宿主 sessionManager 推导）。 */
export interface SessionManagerOverrides {
  rootDir?: string;
}

const TYPES = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("search"), Type.Literal("preview")], {
    description: "list=列会话；search=全文检索；preview=单条详情与接续命令",
  }),
  query: Type.Optional(Type.String({ description: "search 专用：检索词（大小写不敏感）" })),
  ref: Type.Optional(Type.String({ description: "preview 专用：会话 id 前缀或文件名前缀（8 位 id 片段即可）" })),
  scope: Type.Optional(
    Type.Union([Type.Literal("current"), Type.Literal("all")], {
      description: "list/search 专用：current=仅当前工作目录，all=全部（默认）",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "search 专用：最多返回多少个会话（默认 20）" })),
});

interface SessionToolParams {
  action: "list" | "search" | "preview";
  query?: string;
  ref?: string;
  scope?: "current" | "all";
  limit?: number;
}

/** 宿主差异全部 try/catch 兜底：任何形态下都给出可用的根目录，不因宿主差异崩掉。 */
function currentCwd(ctx: ExtensionContext | undefined): string {
  try {
    const cwd = ctx?.sessionManager?.getCwd?.();
    if (cwd) return cwd;
  } catch {
    // 回退进程 cwd
  }
  return process.cwd();
}

function sessionRoot(ctx: ExtensionContext | undefined, overrides: SessionManagerOverrides): string {
  if (overrides.rootDir) return overrides.rootDir;
  try {
    const dir = ctx?.sessionManager?.getSessionDir?.();
    if (dir) return sessionRootOf(dir);
  } catch {
    // 回退默认路径
  }
  return join(homedir(), ".pi", "agent", "sessions");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (!ctx?.hasUI) return;
  try {
    ctx.ui.notify(message, level);
  } catch {
    // TUI 失败不影响只读结果
  }
}

function unwrap<T>(result: SessionResult<T>, format: (value: T) => string): { code: number; text: string } {
  return result.ok ? { code: 0, text: format(result.value) } : { code: 1, text: result.message };
}

function runAction(params: SessionToolParams, root: string, cwd: string): { code: number; text: string } {
  const filter = params.scope === "current" ? { cwd } : {};
  switch (params.action) {
    case "list":
      return unwrap(listSessions(root, filter), formatList);
    case "search": {
      if (!params.query) return { code: 1, text: "search 缺少 query：检索词" };
      return unwrap(searchSessions(root, params.query, { ...filter, limit: params.limit }), formatSearch);
    }
    case "preview": {
      if (!params.ref) return { code: 1, text: "preview 缺少 ref：会话 id 前缀或文件名前缀" };
      return unwrap(previewSession(root, params.ref), formatPreview);
    }
  }
}

function firstToken(args: string | undefined): string {
  return (args ?? "").trim().split(/\s+/)[0] ?? "";
}

export default function sessionManager(pi: ExtensionAPI, overrides: SessionManagerOverrides = {}): void {
  pi.registerTool({
    name: SESSION_TOOL,
    label: "Session",
    description: [
      "只读浏览/检索 Pi 落盘会话（~/.pi/agent/sessions/）：list 列会话、search 在用户/助手文本中全文检索、preview 看单条详情与最近消息。",
      "preview 输出宿主接续命令 `pi --session <id>` 与分支命令 `pi --fork <id>`——接续/分支交给宿主，本工具不 spawn 进程、不改会话文件。",
      "需要「上次那个任务聊到哪了」时先 search，再用 preview 拿接续方式。",
    ].join(" "),
    promptGuidelines: [
      "找历史会话用 action=\"search\"（工具输出不参与检索，别搜命令回显）；查看详情用 action=\"preview\" 传 8 位 id 片段。",
      "不要用本工具删除/修改会话；写操作尚未提供，需要时用宿主 /resume 内 Ctrl+R/Ctrl+D。",
    ],
    parameters: TYPES,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const p = params as SessionToolParams;
        const { code, text } = runAction(p, sessionRoot(ctx, overrides), currentCwd(ctx));
        return {
          content: [{ type: "text", text: text || `（无输出，退出码 ${code}）` }],
          details: { action: p.action, exitCode: code },
          isError: code !== 0,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `session 执行失败：${describeError(error)}` }],
          details: { action: (params as SessionToolParams).action },
          isError: true,
        };
      }
    },
  });

  const runCommand = (ctx: ExtensionContext, params: SessionToolParams): void => {
    try {
      const { code, text } = runAction(params, sessionRoot(ctx, overrides), currentCwd(ctx));
      notify(ctx, text || "（无输出）", code === 0 ? "info" : "warning");
    } catch (error) {
      notify(ctx, `执行失败：${describeError(error)}`, "error");
    }
  };

  pi.registerCommand(SESSION_COMMAND, {
    description: "当前项目会话列表（/session-manager:list|search|preview 为子命令）",
    handler: async (args, ctx) => {
      const head = firstToken(args);
      const renamed = RETIRED_SESSION_SUBCOMMANDS[head];
      if (renamed) {
        notify(ctx, `「/session-manager ${head}」已改名为「/${renamed}」`, "warning");
        return;
      }
      if (head && head !== "current") {
        notify(ctx, SESSION_USAGE, "warning");
        return;
      }
      runCommand(ctx, { action: "list", scope: "current" });
    },
  });

  pi.registerCommand(SESSION_SUBCOMMANDS.list, {
    description: "列会话：/session-manager:list [current|all]（默认 all）",
    handler: async (args, ctx) => {
      const scope = firstToken(args);
      if (scope && scope !== "current" && scope !== "all") {
        notify(ctx, "范围只能是 current 或 all（或留空=all）", "warning");
        return;
      }
      runCommand(ctx, { action: "list", scope: scope === "current" ? "current" : "all" });
    },
  });

  pi.registerCommand(SESSION_SUBCOMMANDS.search, {
    description: "检索历史会话：/session-manager:search <检索词>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        notify(ctx, "用法：/session-manager:search <检索词>", "warning");
        return;
      }
      runCommand(ctx, { action: "search", query, scope: "all" });
    },
  });

  pi.registerCommand(SESSION_SUBCOMMANDS.preview, {
    description: "会话详情 + 宿主接续命令：/session-manager:preview <id 前缀>",
    handler: async (args, ctx) => {
      const ref = args.trim();
      if (!ref) {
        notify(ctx, "用法：/session-manager:preview <id 前缀|文件名前缀>", "warning");
        return;
      }
      runCommand(ctx, { action: "preview", ref });
    },
  });
}
