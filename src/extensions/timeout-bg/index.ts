/**
 * timeout-bg — shell 工具超时转后台 + 默认超时（timeout-bg-todo#1）
 *
 * 宿主 `bash` / `powershell` 工具的 `timeout` 语义是「超时即整树 kill」，且缺省
 * 没有超时。本扩展经公开接缝改两件事：
 *   ① 命中超时（显式或默认 300s）不再杀进程，转入后台继续运行，输出继续写日志，
 *      本次 tool call 立刻以「已转后台 + jobId + 日志路径」的结果结束；
 *   ② 未显式传 timeout 时施加默认超时（`PI_TIMEOUT_BG_DEFAULT` 秒覆盖，0 = 关闭）。
 *
 * 后台任务只活在本会话（session_shutdown 全部杀掉）；自然结束时经
 * `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` 送一条结果。
 * 人工管理命令面：`/bg`（列表）、`/bg:kill <jobId>`、`/bg:clear`。
 *
 * 边界：只覆盖**当前启用**的 shell 工具（active 里没有的不注册，不给用户凭空加工具）；
 * 不碰 `user_bash`（用户手敲的 `!` 命令）与其它带 timeoutMs 的工具（调度语义不同）；
 * 不改宿主、不打宿主补丁。
 *
 * 日志目录：`<PI_TIMEOUT_BG_DIR 或 ~/.pi/agent/bg-jobs>/<pi pid>/<jobId>.log`。
 * 安装：复制本目录到 `~/.pi/agent/extensions/timeout-bg/` 或 `<项目>/.pi/extensions/timeout-bg/`，
 *      Pi 内 `/reload`。测试：`npm test`（cwd = 本目录）。
 */
import { spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import {
  createBashTool,
  createPowerShellTool,
  getAgentDir,
  getPowerShellConfig,
  getShellConfig,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveDefaultTimeout } from "./config.ts";
import { createJobRegistry, type JobRecord } from "./jobs.ts";
import { pruneJobLogs, tailFileSync } from "./logs.ts";
import { createTimeoutOps, type ShellConfig, type SpawnLike } from "./shell-ops.ts";
import { followUpText, formatJobList, shellToolDescription, TIMEOUT_BG_CUSTOM_TYPE, timeoutParamDescription } from "./text.ts";

/** 日志根目录覆盖环境变量（测试隔离 / 多实例隔离）。 */
export const LOG_ROOT_ENV = "PI_TIMEOUT_BG_DIR";
/** 覆盖的 shell 工具集合。 */
export const SHELL_KINDS = ["bash", "powershell"] as const;
export type ShellKind = (typeof SHELL_KINDS)[number];

/** 命令面（冒号子命令 = 独立静态命令名）。 */
export const BG_COMMANDS = { list: "bg", kill: "bg:kill", clear: "bg:clear" } as const;

export interface TimeoutBgDeps {
  env: Record<string, string | undefined>;
  spawn: SpawnLike;
  killTree: (pid: number) => void;
  logRoot: string;
  shellConfig: (kind: ShellKind) => ShellConfig;
  platform?: NodeJS.Platform;
  /** 时钟注入（确定性测试用）；缺省 Date.now。 */
  now?: () => number;
}

/** 终止整棵进程树：Windows 走 taskkill /T /F；其余平台杀进程组（spawn 时 detached 建组）。 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* 进程可能已退出 */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 进程可能已退出 */
    }
  }
}

/** 只改 timeout 参数说明（宿主原文写着 "no default timeout"，与插件语义冲突）。 */
function withTimeoutParamDescription(parameters: unknown, defaultSeconds: number | undefined): unknown {
  if (typeof parameters !== "object" || parameters === null) return parameters;
  const source = parameters as { properties?: Record<string, unknown> };
  const properties = source.properties;
  if (typeof properties !== "object" || properties === null) return parameters;
  const timeoutSchema = properties.timeout;
  if (typeof timeoutSchema !== "object" || timeoutSchema === null) return parameters;
  return {
    ...source,
    properties: { ...properties, timeout: { ...(timeoutSchema as object), description: timeoutParamDescription(defaultSeconds) } },
  };
}

function notify(ctx: ExtensionContext, text: string): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
  } catch {
    /* UI 异常不破坏会话 */
  }
}

export function createTimeoutBgExtension(deps: TimeoutBgDeps): (pi: ExtensionAPI) => void {
  return (pi) => {
    const now = deps.now ?? Date.now;
    const defaultTimeout = resolveDefaultTimeout(deps.env);
    let jobSeq = 0;
    const registered = new Set<ShellKind>();

    const deliverExit = (job: JobRecord): void => {
      try {
        pi.sendMessage(
          {
            customType: TIMEOUT_BG_CUSTOM_TYPE,
            content: followUpText(job, tailFileSync(job.logPath, 2000)),
            display: true,
            details: { jobId: job.id, exitCode: job.exitCode, logPath: job.logPath },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch {
        /* 送达失败不破坏会话 */
      }
    };

    const registry = createJobRegistry({ now, killTree: deps.killTree, onExit: deliverExit });

    const registerShellTool = (kind: ShellKind): void => {
      if (registered.has(kind)) return;
      registered.add(kind);
      const operations = createTimeoutOps({
        spawn: deps.spawn,
        shellConfig: () => deps.shellConfig(kind),
        shellName: kind,
        registry,
        killTree: deps.killTree,
        newJobId: () => `bg-${++jobSeq}`,
        logRoot: deps.logRoot,
        defaultTimeoutSeconds: defaultTimeout.seconds,
        platform: deps.platform ?? process.platform,
      });
      const base =
        kind === "bash"
          ? createBashTool(process.cwd(), { operations })
          : createPowerShellTool(process.cwd(), { operations });
      const baseGuidelines = (base as { promptGuidelines?: string[] }).promptGuidelines ?? [];
      pi.registerTool({
        ...base,
        description: shellToolDescription(kind, defaultTimeout.seconds),
        parameters: withTimeoutParamDescription(base.parameters, defaultTimeout.seconds),
        promptGuidelines: [
          ...baseGuidelines,
          `Use ${kind} with an explicit timeout for long commands: on timeout the command is moved to the background (log path in the result) instead of being killed.`,
        ],
      } as unknown as ToolDefinition);
    };

    pi.on("session_start", (_event, ctx) => {
      try {
        pruneJobLogs(deps.logRoot, now());
      } catch {
        /* 清理失败不影响会话 */
      }
      let active: string[] = [];
      try {
        active = pi.getActiveTools();
      } catch {
        /* 拿不到 active 列表时不覆盖任何工具（fail-closed，不凭空加工具） */
      }
      for (const kind of SHELL_KINDS) {
        if (active.includes(kind)) registerShellTool(kind);
      }
      if (defaultTimeout.warning !== null) notify(ctx, defaultTimeout.warning);
    });

    pi.on("session_shutdown", () => {
      try {
        registry.killAll();
      } catch {
        /* 清理失败不破坏收尾 */
      }
    });

    pi.registerCommand(BG_COMMANDS.list, {
      description: "列出本会话超时转入后台的任务",
      handler: async (_args, ctx) => {
        notify(ctx, formatJobList(registry.list(), now()));
      },
    });

    pi.registerCommand(BG_COMMANDS.kill, {
      description: "停止一个后台任务：/bg:kill <jobId>",
      handler: async (args, ctx) => {
        const id = args.trim();
        if (id.length === 0) {
          notify(ctx, "用法：/bg:kill <jobId>（jobId 见 /bg）");
          return;
        }
        const job = registry.get(id);
        if (job === undefined) {
          notify(ctx, `没有这个后台任务：${id}（用 /bg 看列表）`);
          return;
        }
        if (job.status !== "running") {
          notify(ctx, `${id} 已经结束，无需再停`);
          return;
        }
        registry.kill(id);
        notify(ctx, `已停止 ${id}（pid ${job.pid ?? "?"}）及其子进程`);
      },
    });

    pi.registerCommand(BG_COMMANDS.clear, {
      description: "清理已结束的后台任务记录：/bg:clear",
      handler: async (_args, ctx) => {
        const removed = registry.clear();
        notify(ctx, removed === 0 ? "没有可清理的后台任务记录" : `已清理 ${removed} 条已结束的后台任务记录`);
      },
    });
  };
}

/** 日志根目录：`PI_TIMEOUT_BG_DIR` > `~/.pi/agent/bg-jobs`（取不到 agent 目录时退到系统临时目录）。 */
export function resolveLogRoot(env: Record<string, string | undefined>): string {
  const override = env[LOG_ROOT_ENV]?.trim();
  if (override !== undefined && override.length > 0) return override;
  try {
    return path.join(getAgentDir(), "bg-jobs");
  } catch {
    return path.join(os.tmpdir(), "pi-bg-jobs");
  }
}

export default createTimeoutBgExtension({
  env: process.env,
  spawn: spawn as unknown as SpawnLike,
  killTree: killProcessTree,
  logRoot: resolveLogRoot(process.env),
  shellConfig: (kind) => (kind === "bash" ? getShellConfig() : getPowerShellConfig()),
});
