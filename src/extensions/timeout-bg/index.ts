/**
 * timeout-bg — shell 工具超时转后台 + 默认超时 + 主动转后台（timeout-bg-todo#1 / #5）
 *
 * 宿主 `bash` / `powershell` 工具的 `timeout` 语义是「超时即整树 kill」，且缺省
 * 没有超时。本扩展经公开接缝改三件事：
 *   ① 命中超时（显式或默认 300s）不再杀进程，转入后台继续运行，输出继续写日志，
 *      本次 tool call 立刻以「已转后台 + jobId + 日志路径」的结果结束；
 *   ② 未显式传 timeout 时施加默认超时（`PI_TIMEOUT_BG_DEFAULT` 秒覆盖，0 = 关闭）；
 *   ③ `run_in_background: true` 时不等超时，进程一启动就转入后台（timeout-bg-todo#5）。
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
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveDefaultTimeout } from "./config.ts";
import { createJobRegistry, type JobRecord } from "./jobs.ts";
import { pruneJobLogs, resolveJobLogPath, tailFileSync } from "./logs.ts";
import { createRunInBackgroundDispatch, withOwnParamDescriptions } from "./params.ts";
import { createTimeoutOps, type ShellConfig, type SpawnLike, type TimeoutMode, type TimeoutOpsDeps } from "./shell-ops.ts";
import {
  collectBashCapability,
  createBashDispatch,
  describeForeignBash,
  describeLostBashRegistration,
  mergeBashParameters,
} from "./shell-capability.ts";
import { createRemoteJobPort, offerRemoteJobPort } from "./shell-job-host.ts";
import { writeBand } from "./status-band.ts";
import {
  backgroundResultText,
  followUpText,
  formatJobList,
  jobPlace,
  shellToolDescription,
  statusBandText,
  TIMEOUT_BG_CUSTOM_TYPE,
  timeoutResultText,
} from "./text.ts";

/** footer 状态条键（排序带 80；见 docs/cross/status-bar.md）。 */
export const STATUS_KEY = "80:timeout-bg";

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
    const newJobId = (): string => `bg-${++jobSeq}`;
    /** 本会话的 UI 上下文（footer 状态条段写入口；headless / 会话外为 undefined）。 */
    let uiContext: ExtensionUIContext | undefined;
    const registered = new Set<ShellKind>();
    /** bash 归属冲突（未知接管者 / 本次注册被加载顺序丢掉）一次会话只提示一次。 */
    let bashConflictNotified = false;

    const notifyBashConflict = (ctx: ExtensionContext, message: string): void => {
      if (bashConflictNotified) return;
      bashConflictNotified = true;
      notify(ctx, message);
    };

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

    /** footer 状态条段：只显示运行中的后台任务数（本地 + 远端同一注册表），没有则清段。 */
    const refreshStatusBand = (): void => {
      const ui = uiContext;
      if (ui === undefined) return;
      writeBand(STATUS_KEY, statusBandText(registry.running().length), (rendered) => ui.setStatus(STATUS_KEY, rendered));
    };

    const registry = createJobRegistry({ now, killTree: deps.killTree, onExit: deliverExit, onChange: refreshStatusBand });

    // 远端 bash 的 job 托管端口（timeout-bg#4）：提供方（remote-tools）需要时同步索取，
    // 本扩展在回调里把端口放进盒子；没装对端时这个端口永远没人拿，行为与今天逐字一致。
    // 订阅随会话生命周期登记/退订（盒子先到先得：`/reload` 后旧实例的回调不能占着槽位）。
    const jobPort = createRemoteJobPort({
      newJobId,
      logPathFor: (id) => resolveJobLogPath(deps.logRoot, id),
      registry,
      timeoutText: timeoutResultText,
      backgroundText: backgroundResultText,
    });
    let detachJobPortOffer: () => void = () => undefined;

    interface BashOverrides {
      parameters: unknown;
      execute: ToolDefinition["execute"];
      guidelines: string[];
    }

    /** 收集远端 bash 能力并合并参数/分派/指南；没有可用能力时原样返回自己的配置。 */
    const negotiateBash = (ctx: ExtensionContext, own: BashOverrides): BashOverrides => {
      const offered = collectBashCapability(pi.events);
      if (offered.warning !== null) notify(ctx, offered.warning);
      if (offered.capability === null) {
        // 只有「确定没有提供方」时才做未知接管检查：收到过载荷（哪怕畸形）说明对端在场，
        // 再说「别的扩展接管」会误导（畸形载荷自己已经有提示）。
        const foreign = offered.warning === null ? describeForeignBash(pi) : null;
        if (foreign !== null) notifyBashConflict(ctx, foreign);
        return own;
      }
      const parameters = mergeBashParameters(own.parameters, offered.capability.parameters);
      if (parameters === null) {
        notify(ctx, "shell 能力载荷与 bash 自身参数冲突，已忽略该载荷（按本扩展原行为注册）。");
        return own;
      }
      const guideline = offered.capability.guideline;
      return {
        parameters,
        execute: createBashDispatch({
          local: own.execute,
          capability: offered.capability,
          notify,
          // 远端沿用本扩展的默认超时（用户只记一个数字），显式 timeout 原样透传。
          defaultTimeoutSeconds: defaultTimeout.seconds,
        }),
        guidelines: guideline === undefined ? own.guidelines : [...own.guidelines, guideline],
      };
    };

    const registerShellTool = (kind: ShellKind, ctx: ExtensionContext): void => {
      if (registered.has(kind)) return;
      registered.add(kind);
      const opsDeps: Omit<TimeoutOpsDeps, "mode"> = {
        spawn: deps.spawn,
        shellConfig: () => deps.shellConfig(kind),
        shellName: kind,
        registry,
        killTree: deps.killTree,
        newJobId,
        logRoot: deps.logRoot,
        defaultTimeoutSeconds: defaultTimeout.seconds,
        platform: deps.platform ?? process.platform,
      };
      // 两份宿主工具定义共享同一套 ops 依赖，唯一差别是模式（timeout-bg-todo#5）：
      // 宿主 execute 只把 command/timeout/env 交给 ops，新参数到不了那里，所以按参数选定义。
      const createShellTool = (mode: TimeoutMode) => {
        const operations = createTimeoutOps(mode === "background" ? { ...opsDeps, mode } : opsDeps);
        return kind === "bash"
          ? createBashTool(process.cwd(), { operations })
          : createPowerShellTool(process.cwd(), { operations });
      };
      const base = createShellTool("timeout");
      const backgroundBase = createShellTool("background");
      const description = shellToolDescription(kind, defaultTimeout.seconds);
      const own: BashOverrides = {
        parameters: withOwnParamDescriptions(base.parameters, defaultTimeout.seconds),
        execute: createRunInBackgroundDispatch({ timeout: base.execute, background: backgroundBase.execute }),
        guidelines: [
          ...((base as { promptGuidelines?: string[] }).promptGuidelines ?? []),
          `Use ${kind} with run_in_background: true for long commands (builds, full test runs, downloads, long polls): the call returns at once, the command keeps running in the background and a follow-up message arrives when it finishes.`,
          `Use ${kind} with an explicit timeout for long commands: on timeout the command is moved to the background (log path in the result) instead of being killed.`,
        ],
      };
      // shell 能力协商（timeout-bg-todo#3）：只有 bash 是两扩展共享的名字。
      const negotiated = kind === "bash" ? negotiateBash(ctx, own) : own;

      pi.registerTool({
        ...base,
        description,
        parameters: negotiated.parameters,
        promptGuidelines: negotiated.guidelines,
        execute: negotiated.execute,
      } as unknown as ToolDefinition);

      // 注册后自检：宿主对同名工具按扩展加载顺序 first-wins，顺序不对时刚注册的这份不会被采用。
      if (kind === "bash") {
        const lost = describeLostBashRegistration(pi, description);
        if (lost !== null) notifyBashConflict(ctx, lost);
      }
    };

    pi.on("session_start", (_event, ctx) => {
      try {
        pruneJobLogs(deps.logRoot, now());
      } catch {
        /* 清理失败不影响会话 */
      }
      uiContext = ctx.hasUI ? ctx.ui : undefined;
      refreshStatusBand();
      detachJobPortOffer();
      detachJobPortOffer = offerRemoteJobPort(pi.events, jobPort);
      let active: string[] = [];
      try {
        active = pi.getActiveTools();
      } catch {
        /* 拿不到 active 列表时不覆盖任何工具（fail-closed，不凭空加工具） */
      }
      for (const kind of SHELL_KINDS) {
        if (active.includes(kind)) registerShellTool(kind, ctx);
      }
      if (defaultTimeout.warning !== null) notify(ctx, defaultTimeout.warning);
    });

    pi.on("session_shutdown", () => {
      try {
        registry.killAll();
      } catch {
        /* 清理失败不破坏收尾 */
      }
      detachJobPortOffer();
      detachJobPortOffer = () => undefined;
      // 清段登记：否则 /reload / 会话切换后残留文本会干扰其它扩展的首段判定。
      const ui = uiContext;
      uiContext = undefined;
      if (ui !== undefined) writeBand(STATUS_KEY, undefined, (rendered) => ui.setStatus(STATUS_KEY, rendered));
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
        notify(ctx, `已停止 ${id}（${jobPlace(job)}）及其子进程`);
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
