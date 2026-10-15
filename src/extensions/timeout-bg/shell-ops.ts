/**
 * timeout-bg — shell 工具的执行接缝：超时不再杀进程，而是转后台（timeout-bg-todo#1）
 *
 * 宿主 `createBashTool` / `createPowerShellTool` 的 `operations` 是公开接缝：
 * 我们实现宿主 `BashOperations` 契约的 `exec`，把「超时 → killProcessTree」换成
 * 「超时 → 进程继续跑、输出继续落盘、本次 tool call 结束并报出日志路径」。
 *
 * 与宿主行为保持一致的其余部分：cwd 存在性校验、非法 timeout 的文案、abort（Esc）
 * 仍然整树 kill、非零退出码交给宿主工具层报错。
 *
 * 进程边界注入：`spawn` 与 `killTree` 由 index.ts 传真实实现，测试传 fake。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { resolveTimeoutMs } from "./config.ts";
import type { JobRegistry } from "./jobs.ts";
import { resolveJobLogPath, stripControlChars } from "./logs.ts";
import { backgroundResultText, firstLine, timeoutResultText } from "./text.ts";

/** 与宿主 `ShellConfig` 同形（自带定义，避免依赖宿主内部模块路径）。 */
export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio: Array<"ignore" | "pipe" | "inherit">;
  windowsHide: boolean;
}

/** 只声明我们用到的子进程面（测试用 EventEmitter 即可替身）。 */
export interface SpawnedProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: { end(text: string): void; on(event: "error", listener: () => void): unknown } | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnLike = (file: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

/** 进后台注册表的来源：命中超时（既有语义）或调用方主动要求（timeout-bg-todo#5）。 */
export type JobOrigin = "timeout" | "background";

/** 进后台注册表所需的最小信息（本地 job 只填前四项；远端 job 另有目标主机与终止钩子）。 */
export interface BackgroundJob {
  id: string;
  pid: number | null;
  command: string;
  logPath: string;
  target?: string | undefined;
  terminate?: (() => void) | undefined;
  /** 来源（缺省 `"timeout"`：既有调用点无需改动，展示口径不变）。 */
  origin?: JobOrigin | undefined;
}

export interface TimeoutOpsDeps {
  spawn: SpawnLike;
  shellConfig: () => ShellConfig;
  /** 报错文案里的 shell 名（与宿主一致：bash / powershell）。 */
  shellName: string;
  registry: JobRegistry;
  /** 终止整棵进程树（abort / 会话关闭用；与 registry 的 killTree 同实现）。 */
  killTree: (pid: number) => void;
  newJobId: () => string;
  logRoot: string;
  /** 未显式传 timeout 时的默认秒数；undefined = 不施加默认超时。 */
  defaultTimeoutSeconds: number | undefined;
  platform: NodeJS.Platform;
  /**
   * 本 ops 实例的模式（构造期固定；缺省 `"timeout"` = 既有语义）：
   *   - `"timeout"`：命中超时（显式或默认）才转后台；
   *   - `"background"`：spawn 成功即登记转后台，本次调用立刻结束（`run_in_background: true`）。
   * 模式由 index.ts 的两份工具定义各持一份，**不用哨兵值**（`timeout: 0` 在本插件里已是
   * 「关闭默认超时」，`-1` 是魔法数；对齐文档 `todos/align/timeout-bg-todo#5.md`）。
   */
  mode?: TimeoutMode | undefined;
}

export type TimeoutMode = "timeout" | "background";

/** 超时结果里附带的最近输出上限（字节）。 */
export const TIMEOUT_TAIL_BYTES = 2000;
export function createTimeoutOps(deps: TimeoutOpsDeps): BashOperations {
  const exec: BashOperations["exec"] = async (command, cwd, options) => {
    const timeoutMs = resolveTimeoutMs(options.timeout, deps.defaultTimeoutSeconds);
    if (options.signal?.aborted) throw new Error("aborted");
    try {
      fs.accessSync(cwd, fs.constants.F_OK);
    } catch {
      throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${deps.shellName} commands.`);
    }

    const shell = deps.shellConfig();
    const jobId = deps.newJobId();
    const logPath = resolveJobLogPath(deps.logRoot, jobId);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    // 写盘失败（磁盘满 / 权限）只让日志变不完整，绝不能变成未捕获的 'error' 事件把会话炸掉。
    logStream.on("error", () => {});

    const fromStdin = shell.commandTransport === "stdin";
    let child: SpawnedProcess;
    try {
      child = deps.spawn(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
        cwd,
        env: options.env,
        detached: deps.platform !== "win32",
        stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      logStream.end();
      throw error;
    }

    if (fromStdin && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(command);
    }

    return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false;
      let backgrounded = false;
      let aborted = false;
      let exitSeen = false;
      let recentTail = "";
      let timer: NodeJS.Timeout | undefined;

      const onAbort = () => {
        aborted = true;
        if (child.pid !== undefined) deps.killTree(child.pid);
      };

      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        finish();
      };

      const write = (chunk: Buffer) => {
        // 内存里保留尾部：超时那一刻日志流可能还没落盘，消息不能等 IO。
        recentTail = (recentTail + chunk.toString("utf8")).slice(-TIMEOUT_TAIL_BYTES);
        logStream.write(chunk);
        if (!backgrounded) options.onData(chunk);
      };

      child.stdout?.on("data", write);
      child.stderr?.on("data", write);

      child.on("exit", (code) => {
        exitSeen = true;
        logStream.end(() => {
          // 已经转后台：本次 tool call 早已结束，这里只更新注册表并触发完成通知。
          if (backgrounded) {
            deps.registry.markExited(jobId, code);
            return;
          }
          settle(() => {
            if (aborted) reject(new Error("aborted"));
            else resolve({ exitCode: code });
          });
        });
      });

      child.on("error", (error) => {
        logStream.end();
        // 已转后台（超时或主动）：本次 tool call 早已结束（settle 是 no-op）⇒ 必须自己收口。
        // spawn 异步失败（shell 二进制 ENOENT/EACCES 等）只发 error、不保证发 exit，
        // 不收口就会留下永久 running 的僵尸 job（状态条卡住、永远没有完成通知）——
        // 主动后台把登记提前到 spawn 之后，这条路径从「罕见」变成「必然要处理」。
        if (backgrounded && !exitSeen) {
          deps.registry.markExited(jobId, null);
          return;
        }
        settle(() => reject(error));
      });

      // 主动后台（timeout-bg-todo#5）：不等超时。handler 先挂完再登记——exit 事件在同一 tick 内
      // 不可能被派发，因此登记一定早于任何退出处理（否则 job 会永久停在 running）。
      if (deps.mode === "background") {
        backgrounded = true;
        const job = deps.registry.background({
          id: jobId,
          pid: child.pid ?? null,
          command: firstLine(command, 400),
          logPath,
          origin: "background",
        });
        settle(() => reject(new Error(backgroundResultText(job))));
        return;
      }

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled || backgrounded || exitSeen) return;
          backgrounded = true;
          const job = deps.registry.background({ id: jobId, pid: child.pid ?? null, command: firstLine(command, 400), logPath });
          settle(() => reject(new Error(timeoutResultText(timeoutMs / 1000, job, stripControlChars(recentTail).trimEnd()))));
        }, timeoutMs);
      }

      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  };

  return { exec };
}
