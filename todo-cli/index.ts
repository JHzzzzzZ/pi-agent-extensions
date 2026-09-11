/**
 * todo-cli — Pi 扩展：把仓库 `todos/` 工作流（登记 / 领取 / 完成 / 盘点 / 交接扫描）
 * 变成 agent 可直接调用的原子操作，取代 skill 里的人工 grep + edit 步骤。
 *
 * 能力（实现源见 ./core.ts，与仓库 CLI `tools/todo.mjs` 同一套逻辑）：
 *   todo 工具（agent 调用，作用于当前会话工作目录的 todos/）
 *     action="summary"  按文件汇总（open/processing/done/total）
 *     action="list"     条目列表，可过滤 status / file
 *     action="add"      登记新需求（跨全部文件查重，重复拒绝且不写入）
 *     action="claim"    领取并标注 processing（可带分支引用）
 *     action="complete" 完成：勾选 [x]、去 processing、可加完成注记
 *     action="triage"   只读交接扫描：worktree 事实 × 条目关联
 *     action="lint"     校验「注册扩展 ↔ todos 文件」一一对应
 *   人类命令（冒号命名空间，对齐仓库 commands-colon 约定）
 *     /todo              盘点摘要 + 用法提示
 *     /todo:list [状态]  /todo:add <文件> <描述>
 *     /todo:claim <文件> <子串> [--branch feat/x]
 *     /todo:complete <文件> <子串> [--note 说明]
 *     /todo:triage       /todo:lint
 *
 * 边界：只读写工作目录 `todos/` 下的文件（路径穿越拒绝）；绝不自动 commit；
 * 登记（add）不标 processing，领取（claim）才标——动作显式分离。
 *
 * 安装：把本目录复制到 ~/.pi/agent/extensions/todo-cli/（全局）或
 *       <项目>/.pi/extensions/todo-cli/（项目级），在 Pi 中执行 /reload。
 * 测试：cd todo-cli && npm test
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { main } from "./core.ts";

export const TODO_TOOL = "todo";
export const TODO_COMMAND = "todo";

/** 冒号子命令（独立静态注册；裸 /todo 只做盘点摘要与用法提示）。 */
export const TODO_SUBCOMMANDS = {
  list: "todo:list",
  add: "todo:add",
  claim: "todo:claim",
  complete: "todo:complete",
  triage: "todo:triage",
  lint: "todo:lint",
} as const;

/** 旧空格写法 → 新命令：只提示改名，绝不执行（对齐 commands-colon 约定）。 */
export const RETIRED_TODO_SUBCOMMANDS: Record<string, string> = {
  list: TODO_SUBCOMMANDS.list,
  add: TODO_SUBCOMMANDS.add,
  claim: TODO_SUBCOMMANDS.claim,
  complete: TODO_SUBCOMMANDS.complete,
  triage: TODO_SUBCOMMANDS.triage,
  lint: TODO_SUBCOMMANDS.lint,
};

export const TODO_USAGE = [
  "用法：",
  "  /todo                    盘点摘要",
  "  /todo:list [open|processing|done]",
  "  /todo:add <文件> <需求描述>        例：/todo:add general 支持导出",
  "  /todo:claim <文件> <条目子串> [--branch feat/x]",
  "  /todo:complete <文件> <条目子串> [--note 说明]",
  "  /todo:triage             只读：worktree 事实 × 条目关联",
  "  /todo:lint               校验注册扩展 ↔ todos 文件",
].join("\n");

/** 测试注入点；缺省走真实 git（仅 triage 的只读事实收集会用到）。 */
export interface TodoCliOverrides {
  execGit?: (args: string[], cwd?: string) => string;
}

const TODO_STATUSES = ["open", "processing", "done"] as const;
type TodoStatus = (typeof TODO_STATUSES)[number];
type TodoAction = "summary" | "list" | "add" | "claim" | "complete" | "triage" | "lint";

interface TodoToolParams {
  action: TodoAction;
  file?: string;
  text?: string;
  match?: string;
  branch?: string;
  note?: string;
  status?: TodoStatus;
}

type ArgvResult = { ok: true; value: string[] } | { ok: false; message: string };

/** 工具参数 → CLI argv（两个入口共用一套实现与错误文案）。 */
function buildArgv(params: TodoToolParams): ArgvResult {
  switch (params.action) {
    case "summary":
      return { ok: true, value: ["summary"] };
    case "triage":
      return { ok: true, value: ["triage"] };
    case "lint":
      return { ok: true, value: ["lint"] };
    case "list": {
      const argv = ["list"];
      if (params.status) argv.push("--status", params.status);
      if (params.file) argv.push("--file", params.file);
      return { ok: true, value: argv };
    }
    case "add": {
      if (!params.file) return { ok: false, message: "add 缺少 file：todos/ 下的文件名（不含 .md）" };
      if (!params.text) return { ok: false, message: "add 缺少 text：需求描述" };
      return { ok: true, value: ["add", "--file", params.file, params.text] };
    }
    case "claim":
    case "complete": {
      if (!params.file) return { ok: false, message: `${params.action} 缺少 file` };
      if (!params.match) return { ok: false, message: `${params.action} 缺少 match：唯一定位条目的子串` };
      const argv = [params.action, "--file", params.file, "--match", params.match];
      if (params.action === "claim" && params.branch) argv.push("--branch", params.branch);
      if (params.action === "complete" && params.note) argv.push("--note", params.note);
      return { ok: true, value: argv };
    }
  }
}

/**
 * 会话工作目录 = todos/ 所在仓库根。宿主差异用 try/catch 兜底：
 * sessionManager 缺失时回退进程 cwd（扩展在任何形态下都不因宿主差异崩掉）。
 */
function repoRootOf(ctx: ExtensionContext | undefined): string {
  try {
    const cwd = ctx?.sessionManager?.getCwd?.();
    if (cwd) return cwd;
  } catch {
    // 回退进程 cwd
  }
  return process.cwd();
}

/** 执行一次 core.main 并收走输出（工具/命令共用的唯一执行通道）。 */
function run(argv: string[], repoRoot: string, overrides: TodoCliOverrides): { code: number; text: string } {
  const lines: string[] = [];
  const code = main(argv, {
    repoRoot,
    log: (line: string) => lines.push(String(line)),
    execGit: overrides.execGit,
  });
  return { code, text: lines.join("\n") };
}

function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (!ctx?.hasUI) return;
  try {
    ctx.ui.notify(message, level);
  } catch {
    // TUI 失败不影响已落盘结果
  }
}

function firstToken(args: string | undefined): string {
  return (args ?? "").trim().split(/\s+/)[0] ?? "";
}

/** `/todo:claim general 子串 --branch feat/x` → { head, file, rest, option }。 */
function parseFileRest(args: string | undefined, flag?: string) {
  const trimmed = (args ?? "").trim();
  const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) return { file: "", rest: "", option: undefined as string | undefined };
  let rest = m[2].trim();
  let option: string | undefined;
  if (flag) {
    const om = rest.match(new RegExp(`^(.*?)\\s*--${flag}\\s+([\\s\\S]+)$`));
    if (om && om[1].trim()) {
      rest = om[1].trim();
      option = om[2].trim();
    }
  }
  return { file: m[1], rest, option };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function todoCli(pi: ExtensionAPI, overrides: TodoCliOverrides = {}): void {
  const execute = (ctx: ExtensionContext | undefined, argv: string[]): { code: number; text: string } =>
    run(argv, repoRootOf(ctx), overrides);

  pi.registerTool({
    name: TODO_TOOL,
    label: "Todo",
    description: [
      "读写当前项目 `todos/` 工作流文件（`todos/<插件名>-todo.md`）：盘点、登记（跨文件查重）、领取（processing 标注）、完成（勾选 + 注记）、交接扫描（triage）、lint。",
      "agent 的自有工作流：新需求先 add 登记（拒绝重复）；开工先 claim 领取；收尾 complete 并写完成注记；新工作段开始用 triage 盘点 worktree 与遗留条目。",
      "只作用于工作目录下的 todos/，不自动 commit。",
    ].join(" "),
    promptGuidelines: [
      "登记新需求前先用 action=\"list\" 或 action=\"add\"（add 自带跨文件查重，重复会拒绝并给出行号），不要手动编辑 todos/ 文件。",
      "领取/完成用 add/claim/complete 的 match 精确定位条目；完成时在 note 里写分支与验证结论，保持 todos/ 反映真实状态。",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("summary"),
          Type.Literal("list"),
          Type.Literal("add"),
          Type.Literal("claim"),
          Type.Literal("complete"),
          Type.Literal("triage"),
          Type.Literal("lint"),
        ],
        {
          description:
            "summary=按文件汇总；list=条目列表；add=登记新需求；claim=领取（标 processing）；complete=完成（勾选去标注）；triage=只读交接扫描；lint=注册扩展↔todo 文件校验",
        },
      ),
      file: Type.Optional(
        Type.String({ description: "todos/ 下的文件名，不含 .md（如 general、pwr、todo-cli）" }),
      ),
      text: Type.Optional(Type.String({ description: "add 专用：需求描述（写进条目）" })),
      match: Type.Optional(Type.String({ description: "claim/complete 专用：唯一定位条目的子串" })),
      branch: Type.Optional(Type.String({ description: "claim 专用：分支引用（写进 processing 标注，如 feat/x）" })),
      note: Type.Optional(Type.String({ description: "complete 专用：完成注记（如 `feat/x：说明`）" })),
      status: Type.Optional(
        Type.Union([Type.Literal("open"), Type.Literal("processing"), Type.Literal("done")], {
          description: "list 专用：按状态过滤",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const argv = buildArgv(params as TodoToolParams);
      if (!argv.ok) {
        return { content: [{ type: "text", text: argv.message }], details: undefined, isError: true };
      }
      try {
        const { code, text } = execute(ctx, argv.value);
        return {
          content: [{ type: "text", text: text || `（无输出，退出码 ${code}）` }],
          details: { action: params.action, exitCode: code },
          isError: code !== 0,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `todo 执行失败：${describeError(error)}` }],
          details: { action: params.action },
          isError: true,
        };
      }
    },
  });

  /** 命令处理器与工具共用执行通道；失败输出按 warning 提示。 */
  const runCommand = (ctx: ExtensionContext, argv: string[]): void => {
    try {
      const { code, text } = execute(ctx, argv);
      notify(ctx, text || "（无输出）", code === 0 ? "info" : "warning");
    } catch (error) {
      notify(ctx, `执行失败：${describeError(error)}`, "error");
    }
  };

  pi.registerCommand(TODO_COMMAND, {
    description: "todos/ 工作流盘点（/todo:list|add|claim|complete|triage|lint 为管理子命令）",
    handler: async (args, ctx) => {
      const head = firstToken(args);
      const renamed = RETIRED_TODO_SUBCOMMANDS[head];
      if (renamed) {
        notify(ctx, `「/todo ${head}」已改名为「/${renamed}」`, "warning");
        return;
      }
      if (head && head !== "summary") {
        notify(ctx, TODO_USAGE, "warning");
        return;
      }
      runCommand(ctx, ["summary"]);
    },
  });

  pi.registerCommand(TODO_SUBCOMMANDS.list, {
    description: "列出 todos/ 条目：/todo:list [open|processing|done]",
    handler: async (args, ctx) => {
      const status = firstToken(args);
      if (status && !TODO_STATUSES.includes(status as TodoStatus)) {
        notify(ctx, `状态只能是 ${TODO_STATUSES.join(" | ")}（或留空=全部）`, "warning");
        return;
      }
      runCommand(ctx, status ? ["list", "--status", status] : ["list"]);
    },
  });

  pi.registerCommand(TODO_SUBCOMMANDS.add, {
    description: "登记需求（跨文件查重）：/todo:add <文件> <需求描述>",
    handler: async (args, ctx) => {
      const { file, rest } = parseFileRest(args);
      if (!file || !rest) {
        notify(ctx, "用法：/todo:add <文件> <需求描述>（文件不含 .md，如 general）", "warning");
        return;
      }
      runCommand(ctx, ["add", "--file", file, rest]);
    },
  });

  pi.registerCommand(TODO_SUBCOMMANDS.claim, {
    description: "领取条目并标注 processing：/todo:claim <文件> <条目子串> [--branch feat/x]",
    handler: async (args, ctx) => {
      const { file, rest, option } = parseFileRest(args, "branch");
      if (!file || !rest) {
        notify(ctx, "用法：/todo:claim <文件> <条目子串> [--branch feat/x]", "warning");
        return;
      }
      const argv = ["claim", "--file", file, "--match", rest];
      if (option) argv.push("--branch", option);
      runCommand(ctx, argv);
    },
  });

  pi.registerCommand(TODO_SUBCOMMANDS.complete, {
    description: "完成条目（勾选 + 去标注）：/todo:complete <文件> <条目子串> [--note 说明]",
    handler: async (args, ctx) => {
      const { file, rest, option } = parseFileRest(args, "note");
      if (!file || !rest) {
        notify(ctx, "用法：/todo:complete <文件> <条目子串> [--note 说明]", "warning");
        return;
      }
      const argv = ["complete", "--file", file, "--match", rest];
      if (option) argv.push("--note", option);
      runCommand(ctx, argv);
    },
  });

  pi.registerCommand(TODO_SUBCOMMANDS.triage, {
    description: "只读交接扫描：worktree 事实 × 条目关联（活跃/可清理/孤儿/processing 遗留）",
    handler: async (_args, ctx) => runCommand(ctx, ["triage"]),
  });

  pi.registerCommand(TODO_SUBCOMMANDS.lint, {
    description: "校验「根 package.json 注册扩展 ↔ todos/<扩展>-todo.md」一一对应",
    handler: async (_args, ctx) => runCommand(ctx, ["lint"]),
  });
}
