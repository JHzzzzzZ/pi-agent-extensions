/**
 * agent-manager — pi 子进程运行器（W2）。
 *
 * 本模块是 agent-manager（独立 Node 前端工具，不 import 宿主 SDK）的进程
 * 管理面：只管理本工具经 pi CLI 启动的 agent 子进程（start/list/get/output/
 * stop），独立于 agent 运行；外部终端里跑的 pi 不做发现——与本工具无关。
 * 零运行时依赖，只依赖 node 内置模块。
 *
 * JSON 事件归约对齐仓库既有 pi 子进程先例（pwr/runner/pi.ts、loop/runner.ts），
 * 抄思路不 import；进程树杀（win32 taskkill /T、posix 进程组 -pid）为本仓库新能力。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type AgentRunKind = "new" | "resume" | "fork";
export type AgentStatus = "running" | "exited" | "failed" | "stopped";

export interface PiInvocation {
  command: string;
  prefixArgs: string[];
}

/**
 * pi 调用解析（纯函数，platform 注入以便双分支可测）：
 * 1) piPath 以 .js/.mjs/.cjs 结尾 → node 直启 { command: process.execPath, prefixArgs: [piPath] }
 *    （推荐形态：绕开 win32 的 cmd.exe 包装与引号问题）；
 * 2) piPath 其他值 → win32: { command: "cmd.exe", prefixArgs: ["/d","/s","/c",piPath] }；
 *    其他平台: { command: piPath, prefixArgs: [] }；
 * 3) 未配置 → 同 2，但目标为 "pi"。
 * 注：win32 对 .cmd/.bat 必须经 cmd.exe（Node ≥18 禁止无 shell 直 spawn）。
 */
export function resolvePiCommand(piPath: string | undefined, platform: NodeJS.Platform): PiInvocation {
  const target = piPath && piPath.trim() ? piPath.trim() : "pi";
  if (/\.(js|mjs|cjs)$/i.test(target)) {
    return { command: process.execPath, prefixArgs: [target] };
  }
  if (platform === "win32") {
    return { command: "cmd.exe", prefixArgs: ["/d", "/s", "/c", target] };
  }
  return { command: target, prefixArgs: [] };
}

export interface AgentStartSpec {
  /** 必须存在的绝对路径 */
  cwd: string;
  /** 非空 */
  prompt: string;
  /** --model（provider/id 或 pattern）；缺省用子 pi 默认模型 */
  model?: string;
  /** --name 显示名；缺省 "agent-manager-<runId>" */
  name?: string;
  /** resume/fork 必须带 sessionRef；new 不得带 */
  kind: AgentRunKind;
  /** 宿主 --session/--fork 的 <path|id>（前端传列表里的完整会话 id） */
  sessionRef?: string;
}

export interface AgentRecord {
  id: string;
  spec: AgentStartSpec;
  status: AgentStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** 从 json 流会话头行捕获（loop/runner.ts 同法） */
  sessionId?: string;
  /** 最后一条 assistant 文本（截断） */
  lastText: string;
  /** spawn 失败/异常信息 */
  error?: string;
}

export interface OutputLine {
  seq: number;
  at: string;
  kind: "user" | "assistant" | "tool" | "error" | "info";
  text: string;
}

export const AgentErrorCodes = {
  BAD_SPEC: "AGENT_BAD_SPEC",
  NOT_FOUND: "AGENT_NOT_FOUND",
  NOT_RUNNING: "AGENT_NOT_RUNNING",
  SPAWN_FAILED: "AGENT_SPAWN_FAILED",
} as const;

type AgentErrorCode = (typeof AgentErrorCodes)[keyof typeof AgentErrorCodes];

/** 子进程最小适配面（默认实现包装 node:child_process.spawn；测试注入手写 fake）。 */
export interface RunnerChildProcess {
  pid?: number;
  stdout: { on(event: "data", cb: (chunk: unknown) => void): void };
  stderr: { on(event: "data", cb: (chunk: unknown) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export interface RunnerDeps {
  spawn?: (command: string, args: string[], opts: { cwd: string }) => RunnerChildProcess;
  now?: () => string;
  /** run id（8 hex） */
  makeId?: () => string;
  killTree?: (pid: number) => Promise<void>;
  /** 合并覆盖 process.env（e2e 用 PI_CODING_AGENT_SESSION_DIR 隔离） */
  env?: Record<string, string>;
  /** 默认 1000（环形，超出丢最旧，seq 单调不复用） */
  maxOutputLines?: number;
}

type StartResult =
  | { ok: true; value: AgentRecord }
  | { ok: false; code: AgentErrorCode; message: string };

type StopResult =
  | { ok: true; value: { status: AgentStatus } }
  | { ok: false; code: AgentErrorCode; message: string };

const DEFAULT_MAX_OUTPUT_LINES = 1000;
/** 退出记录保留条数（运行中记录不受限） */
const HISTORY_CAP = 50;
/** 单行输出字符上限 */
const MAX_OUTPUT_CHARS = 2000;
/** 优雅终止到强杀之间的宽限期 */
const KILL_GRACE_MS = 5000;
const KILL_POLL_MS = 50;

/** 运行器传给注入 spawn 的选项（冻结注入缝只声明 cwd，运行期携带完整项）。 */
interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: ["ignore", "pipe", "pipe"];
  windowsHide?: boolean;
  detached?: boolean;
}

function defaultSpawn(command: string, args: string[], options: SpawnOptions): RunnerChildProcess {
  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: options.windowsHide ?? true,
    detached: options.detached ?? process.platform !== "win32",
  });
  return {
    pid: child.pid,
    stdout: {
      on(_event, cb) {
        child.stdout?.on("data", (chunk: Buffer) => cb(chunk));
      },
    },
    stderr: {
      on(_event, cb) {
        child.stderr?.on("data", (chunk: Buffer) => cb(chunk));
      },
    },
    on(event, cb) {
      if (event === "close") child.on("close", (code) => (cb as (code: number | null) => void)(code));
      else child.on("error", (err) => (cb as (err: Error) => void)(err));
    },
  };
}

/**
 * 默认进程树杀（导出以便真实进程树测试直测）：
 * win32: spawn("taskkill", ["/PID", pid, "/T", "/F"])（不带 shell）；posix: process.kill(-pid,"SIGTERM")。
 * 均带 graceMs（默认 5000）兜底 SIGKILL。绝不 reject（进程已消失视为成功）。
 */
export function defaultKillTree(pid: number, options?: { graceMs?: number }): Promise<void> {
  const graceMs = options?.graceMs ?? KILL_GRACE_MS;
  if (process.platform === "win32") return killProcessTreeWindows(pid);
  return killProcessGroupPosix(pid, graceMs);
}

function killProcessTreeWindows(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof nodeSpawn> | undefined;
    try {
      child = nodeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      killPidForcefully(pid);
      resolve();
      return;
    }
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      // taskkill 失败/残留兜底：仅当 pid 仍存活时补一发 SIGKILL（win32 上不携树）。
      killPidForcefully(pid);
      resolve();
    };
    child.on("error", settle);
    child.on("close", settle);
  });
}

async function killProcessGroupPosix(pid: number, graceMs: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pid)) return;
    await sleep(KILL_POLL_MS);
  }
  signalGroup(pid, "SIGKILL");
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* 进程组已消失/无权限，交给调用方的兜底路径 */
  }
}

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 仅当 pid 仍存活时补一发 SIGKILL。 */
function killPidForcefully(pid: number): void {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已消失/无权限，忽略 */
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunState {
  record: AgentRecord;
  child?: RunnerChildProcess;
  lines: OutputLine[];
  nextSeq: number;
  stdoutBuffer: string;
  stderrBuffer: string;
  /** stop 已发起：close 时状态归 stopped（不按 exitCode 判定） */
  stopping: boolean;
  /** spawn/子进程 error 已发生：close 时保持 failed */
  spawnErrored: boolean;
}

interface PiEvent {
  type?: string;
  id?: unknown;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  toolName?: string;
  args?: unknown;
  result?: { content?: Array<{ type?: string; text?: string }> };
}

export class AgentRunner {
  private readonly invocation: PiInvocation;
  private readonly spawn: NonNullable<RunnerDeps["spawn"]>;
  private readonly now: () => string;
  private readonly makeId: () => string;
  private readonly killTree: (pid: number) => Promise<void>;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly maxOutputLines: number;
  private readonly states = new Map<string, RunState>();

  constructor(options: { invocation: PiInvocation } & RunnerDeps) {
    this.invocation = options.invocation;
    this.spawn = options.spawn ?? defaultSpawn;
    this.now = options.now ?? (() => new Date().toISOString());
    this.makeId = options.makeId ?? (() => randomUUID().slice(0, 8));
    this.killTree = options.killTree ?? defaultKillTree;
    this.childEnv = options.env ? { ...process.env, ...options.env } : process.env;
    this.maxOutputLines =
      options.maxOutputLines && options.maxOutputLines > 0
        ? options.maxOutputLines
        : DEFAULT_MAX_OUTPUT_LINES;
  }

  /**
   * 同步校验（BAD_SPEC，非法输入绝不 spawn）；spawn 同步抛错 → ok:true +
   * status "failed" 记录（错误进 record.error，不炸调用方）。
   */
  start(spec: AgentStartSpec): StartResult {
    const invalid = validateSpec(spec);
    if (invalid !== undefined) {
      return { ok: false, code: AgentErrorCodes.BAD_SPEC, message: invalid };
    }

    const id = this.makeId();
    const record: AgentRecord = {
      id,
      spec: { ...spec },
      status: "running",
      startedAt: this.now(),
      lastText: "",
    };
    const state: RunState = {
      record,
      lines: [],
      nextSeq: 1,
      stdoutBuffer: "",
      stderrBuffer: "",
      stopping: false,
      spawnErrored: false,
    };
    this.states.set(id, state);

    const args = this.buildArgs(spec, id);
    const spawnOptions: SpawnOptions = {
      cwd: spec.cwd,
      env: this.childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    };

    let child: RunnerChildProcess;
    try {
      child = this.spawn(this.invocation.command, args, spawnOptions);
    } catch (err) {
      record.status = "failed";
      record.endedAt = this.now();
      record.error = `无法启动 pi 进程：${errorText(err)}`;
      this.appendLine(state, "error", record.error);
      return { ok: true, value: snapshot(record) };
    }

    record.pid = child.pid;
    state.child = child;
    this.wireChild(state, child);
    return { ok: true, value: snapshot(record) };
  }

  /** 运行中在前，各段按启动时间倒序；退出记录保留最近 HISTORY_CAP 条。 */
  list(): AgentRecord[] {
    const records = [...this.states.values()].map((state) => snapshot(state.record));
    const rank = (record: AgentRecord): number => (record.status === "running" ? 0 : 1);
    return records.sort(
      (a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt),
    );
  }

  get(id: string): AgentRecord | undefined {
    const state = this.states.get(id);
    return state ? snapshot(state.record) : undefined;
  }

  /** 增量输出：seq 单调；sinceSeq 之后的行；环形丢最旧后 total 仍为累计条数。 */
  output(id: string, sinceSeq?: number): { lines: OutputLine[]; total: number } | undefined {
    const state = this.states.get(id);
    if (!state) return undefined;
    const lines = state.lines
      .filter((line) => sinceSeq === undefined || line.seq > sinceSeq)
      .map((line) => ({ ...line }));
    return { lines, total: state.nextSeq - 1 };
  }

  /** 只对 running 记录有效（否则 NOT_RUNNING）；killTree 失败记录 error 行，不吞。 */
  async stop(id: string): Promise<StopResult> {
    const state = this.states.get(id);
    if (!state) {
      return { ok: false, code: AgentErrorCodes.NOT_FOUND, message: "agent 不存在" };
    }
    if (state.record.status !== "running") {
      return { ok: false, code: AgentErrorCodes.NOT_RUNNING, message: "agent 不在运行中" };
    }
    state.stopping = true;
    const pid = state.record.pid;
    if (pid !== undefined) {
      try {
        await this.killTree(pid);
      } catch (err) {
        state.record.error = `停止 agent 失败：${errorText(err)}`;
        this.appendLine(state, "error", state.record.error);
      }
    }
    return { ok: true, value: { status: state.record.status } };
  }

  private buildArgs(spec: AgentStartSpec, id: string): string[] {
    const name = spec.name && spec.name.trim() ? spec.name : `agent-manager-${id}`;
    const args = [...this.invocation.prefixArgs, "--mode", "json", "-p"];
    if (spec.model) args.push("--model", spec.model);
    args.push("--name", name);
    if (spec.kind === "resume") args.push("--session", spec.sessionRef ?? "");
    else if (spec.kind === "fork") args.push("--fork", spec.sessionRef ?? "");
    args.push(spec.prompt);
    return args;
  }

  private wireChild(state: RunState, child: RunnerChildProcess): void {
    child.stdout.on("data", (chunk) => {
      state.stdoutBuffer += String(chunk);
      const lines = state.stdoutBuffer.split("\n");
      state.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) this.ingestJsonLine(state, line);
    });
    child.stderr.on("data", (chunk) => {
      state.stderrBuffer += String(chunk);
      const lines = state.stderrBuffer.split("\n");
      state.stderrBuffer = lines.pop() ?? "";
      for (const line of lines) this.appendStderrLine(state, line);
    });
    child.on("error", (err) => this.handleChildError(state, err));
    child.on("close", (code) => this.handleChildClose(state, code));
  }

  private ingestJsonLine(state: RunState, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // 坏行跳过（stdout 可能混入非 JSON 日志）
    }
    if (event === null || typeof event !== "object") return;
    this.handleEvent(state, event as PiEvent);
  }

  private handleEvent(state: RunState, event: PiEvent): void {
    if (event.type === "session") {
      if (typeof event.id === "string" && event.id && !state.record.sessionId) {
        state.record.sessionId = event.id;
      }
      return;
    }
    if (event.type === "message_end") {
      const role = event.message?.role;
      if (role !== "user" && role !== "assistant") return;
      const text = normalizeText(contentText(event.message?.content));
      if (!text) return; // 仅工具调用的空 assistant 回合不产出噪音行
      this.appendLine(state, role, text);
      if (role === "assistant") state.record.lastText = text;
      return;
    }
    if (event.type === "tool_execution_start") {
      const toolName = toolNameOf(event);
      if (!toolName) return;
      this.appendLine(state, "tool", normalizeText(`${toolName} ${summarize(event.args)}`));
      return;
    }
    if (event.type === "tool_execution_end") {
      const toolName = toolNameOf(event);
      if (!toolName) return;
      const resultText = event.result ? contentText(event.result.content) : "";
      this.appendLine(state, "tool", normalizeText(`${toolName} ${resultText}`));
      return;
    }
    if (event.type === "agent_end") {
      this.appendLine(state, "info", "agent 运行结束");
    }
  }

  private handleChildError(state: RunState, err: Error): void {
    if (state.record.status !== "running") return;
    state.spawnErrored = true;
    state.record.status = "failed";
    state.record.endedAt = this.now();
    state.record.error = `无法启动 pi 进程：${err.message}`;
    this.appendLine(state, "error", state.record.error);
  }

  private handleChildClose(state: RunState, code: number | null): void {
    if (state.stdoutBuffer.trim()) this.ingestJsonLine(state, state.stdoutBuffer);
    if (state.stderrBuffer.trim()) this.appendStderrLine(state, state.stderrBuffer);
    state.stdoutBuffer = "";
    state.stderrBuffer = "";
    state.child = undefined;
    state.record.endedAt = this.now();
    state.record.exitCode = code;
    if (state.stopping) state.record.status = "stopped";
    else if (state.spawnErrored) state.record.status = "failed";
    else state.record.status = code === 0 ? "exited" : "failed";
    this.pruneHistory();
  }

  private appendStderrLine(state: RunState, line: string): void {
    const text = line.trim();
    if (text) this.appendLine(state, "error", text);
  }

  private appendLine(state: RunState, kind: OutputLine["kind"], text: string): void {
    const bounded = text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
    state.lines.push({ seq: state.nextSeq, at: this.now(), kind, text: bounded });
    state.nextSeq += 1;
    if (state.lines.length > this.maxOutputLines) state.lines.shift();
  }

  private pruneHistory(): void {
    const finished = [...this.states.values()].filter((state) => state.record.status !== "running");
    if (finished.length <= HISTORY_CAP) return;
    finished.sort((a, b) =>
      (a.record.endedAt ?? a.record.startedAt).localeCompare(b.record.endedAt ?? b.record.startedAt),
    );
    for (const state of finished.slice(0, finished.length - HISTORY_CAP)) {
      this.states.delete(state.record.id);
    }
  }
}

function validateSpec(spec: AgentStartSpec): string | undefined {
  if (spec.kind !== "new" && spec.kind !== "resume" && spec.kind !== "fork") {
    return "kind 必须是 new/resume/fork";
  }
  if (typeof spec.cwd !== "string" || !spec.cwd.trim()) return "cwd 不能为空";
  if (!path.isAbsolute(spec.cwd)) return "cwd 必须是绝对路径";
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(spec.cwd).isDirectory();
  } catch {
    return "cwd 不存在";
  }
  if (!isDirectory) return "cwd 不是目录";
  if (typeof spec.prompt !== "string" || !spec.prompt.trim()) return "prompt 不能为空";
  const sessionRef = typeof spec.sessionRef === "string" ? spec.sessionRef.trim() : "";
  if (spec.kind === "new") return sessionRef ? "kind=new 不能带 sessionRef" : undefined;
  return sessionRef ? undefined : "kind=resume/fork 必须带 sessionRef";
}

function contentText(parts: Array<{ type?: string; text?: string }> | undefined): string {
  return (parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : "";
  } catch {
    return "";
  }
}

function toolNameOf(event: PiEvent): string {
  return typeof event.toolName === "string" ? event.toolName.trim() : "";
}

/** 单行化 + 2000 字符截断（输出行与 lastText 共用同一口径）。 */
function normalizeText(raw: string): string {
  const single = raw.replace(/\s+/g, " ").trim();
  return single.length > MAX_OUTPUT_CHARS ? single.slice(0, MAX_OUTPUT_CHARS) : single;
}

function snapshot(record: AgentRecord): AgentRecord {
  return { ...record, spec: { ...record.spec } };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
