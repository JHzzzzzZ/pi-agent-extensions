/**
 * loop — 后台 agent 运行器（v1.3）。
 *
 * 到期的后台任务拉起独立子 pi 进程执行：与 PWR runner 同源的 spawn 策略，
 * 但关键差异是【不带 --no-session】——子进程会话落盘到
 * ~/.pi/agent/sessions/--<cwd>--/，随时可用 pi --session <id>（或交互式 pi -r）
 * 恢复对话记录；--name loop-<taskId> 让会话在选择器中可辨识。
 *
 * JSON 模式 stdout 第一行是会话头 {"type":"session","id":"<uuid>",...}，
 * 捕获 id 记入任务状态；最后一条 assistant 文本作为结果摘要。
 * 超时 SIGTERM → 宽限期后 SIGKILL（对齐 PWR KILL_GRACE_MS）。
 * spawn 以依赖注入传入，测试用假子进程替代（不触碰真实进程/网络）。
 */
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_BG_SUMMARY_LEN } from "./tasks.ts";

/** SIGTERM 与 SIGKILL 之间的宽限期 */
export const KILL_GRACE_MS = 5000;

/** 单次后台运行的超时上限（超时 SIGTERM→SIGKILL） */
export const BG_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export interface BgChildProcess {
  stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal: string): boolean;
}

export type BgSpawn = (command: string, args: string[], opts: { cwd?: string }) => BgChildProcess;

/** Resolve the pi invocation: same strategy as the pi host itself (and PWR runner). */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

export function defaultBgSpawn(): BgSpawn {
  return (command, args, opts) => {
    const child = nodeSpawn(command, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      stdout: {
        on(event, cb) {
          if (event === "data") child.stdout?.on("data", (chunk: Buffer) => cb(chunk));
        },
      },
      stderr: {
        on(event, cb) {
          if (event === "data") child.stderr?.on("data", (chunk: Buffer) => cb(chunk));
        },
      },
      on(event, cb) {
        if (event === "close") child.on("close", (code) => (cb as (code: number | null) => void)(code));
        else if (event === "error") child.on("error", (err) => (cb as (err: Error) => void)(err));
      },
      kill(signal) {
        try {
          return child.kill(signal as NodeJS.Signals);
        } catch {
          return false;
        }
      },
    };
  };
}

export interface BgRunOptions {
  taskId: string;
  /** 到期要执行的任务内容（作为子 pi 的初始 prompt） */
  prompt: string;
  /** 子进程工作目录（= 宿主会话 cwd，保证会话落在该项目的 sessions 目录、pi -r 可见） */
  cwd?: string;
  spawn?: BgSpawn;
  /** 中止信号：abort 即杀子进程（会话关闭/任务删除时用） */
  signal?: AbortSignal;
  /** 超时毫秒数，默认 BG_RUN_TIMEOUT_MS；测试注入短值 */
  timeoutMs?: number;
  /** SIGTERM→SIGKILL 宽限期，默认 KILL_GRACE_MS；测试注入短值 */
  killGraceMs?: number;
}

export type BgRunStatus = "done" | "failed" | "timeout";

export interface BgRunOutcome {
  status: BgRunStatus;
  exitCode: number | null;
  /** 子 pi 会话 id（从 JSON 输出会话头捕获；未捕获则缺省） */
  sessionId?: string;
  /** 会话文件绝对路径（best-effort 定位；找不到则缺省） */
  sessionPath?: string;
  /** 结果摘要：最后一条 assistant 文本，兜底 stderr */
  summary: string;
  stderr: string;
}

interface StreamedMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface PiEvent {
  type?: string;
  id?: unknown;
  message?: StreamedMessage;
}

function parseLine(line: string): PiEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as PiEvent;
  } catch {
    return null;
  }
}

function messageText(msg: StreamedMessage): string | undefined {
  for (const part of msg.content ?? []) {
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) return part.text;
  }
  return undefined;
}

function truncateSummary(s: string): string {
  return s.length > MAX_BG_SUMMARY_LEN ? `${s.slice(0, MAX_BG_SUMMARY_LEN)}…` : s;
}

/**
 * best-effort 按 pi 会话目录布局定位会话文件：
 * <agentDir>/sessions/--<cwd 中 / \ : 替换为 - >--/<timestamp>_<sessionId>.jsonl。
 * 目录不存在 / 布局变化一律返回 undefined（调用方只用 id 也能恢复）。
 */
export function findSessionFile(sessionId: string, cwd: string, agentDir?: string): string | undefined {
  if (!sessionId || !cwd) return undefined;
  try {
    const root = agentDir ?? path.join(os.homedir(), ".pi", "agent");
    // 与 pi 内部布局一致：<agentDir>/sessions/--<cwd 去前导斜杠、/\: 换 - >--
    const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const dir = path.join(root, "sessions", safePath);
    const hit = fs.readdirSync(dir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
    return hit ? path.join(dir, hit) : undefined;
  } catch {
    return undefined;
  }
}

/** 拉起一次后台子 pi 进程并等到退出。绝不 reject：失败也以 outcome 返回。 */
export function runBgAgent(options: BgRunOptions): Promise<BgRunOutcome> {
  const spawnFn = options.spawn ?? defaultBgSpawn();
  const timeoutMs = options.timeoutMs ?? BG_RUN_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const { command, args } = getPiInvocation([
    "--mode",
    "json",
    "-p",
    "--name",
    `loop-${options.taskId}`,
    options.prompt,
  ]);

  return new Promise((resolve) => {
    const signal = options.signal;
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let child: BgChildProcess | undefined;

    let sessionId: string | undefined;
    let lastText = "";
    let stderr = "";

    const settle = (outcome: BgRunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const killChild = (): void => {
      child?.kill("SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = null;
        child?.kill("SIGKILL");
      }, killGraceMs);
    };

    const onAbort = (): void => killChild();

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    try {
      child = spawnFn(command, args, { cwd: options.cwd });
    } catch (err) {
      settle({
        status: "failed",
        exitCode: null,
        summary: `无法启动 pi 进程：${err instanceof Error ? err.message : String(err)}`,
        stderr: "",
      });
      return;
    }

    // 中止接线放在 spawn 之后：预中止的信号也能命中真实子进程
    if (signal?.aborted) killChild();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      settle({
        status: "failed",
        exitCode: null,
        summary: `无法启动 pi 进程：${err.message}`,
        stderr,
      });
    });

    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      const sessionPath = sessionId && options.cwd ? findSessionFile(sessionId, options.cwd) : undefined;
      settle({
        status: timedOut ? "timeout" : code === 0 ? "done" : "failed",
        exitCode: code,
        ...(sessionId ? { sessionId } : {}),
        ...(sessionPath ? { sessionPath } : {}),
        summary: truncateSummary(lastText || stderr.trim() || "(无输出)"),
        stderr,
      });
    });

    function processLine(line: string): void {
      const event = parseLine(line);
      if (!event) return;
      if (event.type === "session" && typeof event.id === "string" && event.id) {
        sessionId = event.id;
        return;
      }
      const msg = event.message;
      if (!msg) return;
      if (msg.role === "assistant") {
        const text = messageText(msg);
        if (text) lastText = text;
      }
    }
  });
}
