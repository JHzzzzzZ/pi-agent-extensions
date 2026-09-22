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
import { stripControlChars } from "./logs.ts";
import { firstLine, timeoutResultText } from "./text.ts";

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

/** 进后台注册表所需的最小信息。 */
export interface BackgroundJob {
  id: string;
  pid: number | null;
  command: string;
  logPath: string;
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
}

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
    const logDir = path.join(deps.logRoot, String(process.pid));
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${jobId}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

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
        settle(() => reject(error));
      });

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
