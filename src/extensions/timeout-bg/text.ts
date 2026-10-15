/**
 * timeout-bg — 面向模型/人的文本模板（timeout-bg-todo#1）
 *
 * 全部静态模板：只插值插件自己产生的字（jobId / pid / 秒数 / 路径 / 退出码），
 * 命令原文只进日志与 `/bg` 列表（人类自看），不进错误消息。
 */
import type { JobRecord } from "./jobs.ts";

/** 自定义消息类型（跟随会话，模型可见）。 */
export const TIMEOUT_BG_CUSTOM_TYPE = "timeout-bg";

/** 命令首行（列表用；超长截断）。 */
export function firstLine(command: string, maxChars = 100): string {
  const line = command.split("\n", 1)[0]!.trim();
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/** shell 工具 description：超时语义已改，必须让模型看到（含新增的 `run_in_background`）。 */
export function shellToolDescription(shellName: string, defaultSeconds: number | undefined): string {
  const defaultText = defaultSeconds === undefined ? "no default timeout" : `default ${defaultSeconds}s`;
  return [
    `Execute a ${shellName} command in the current working directory. Returns stdout and stderr.`,
    `Output is truncated to the last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file.`,
    `Optionally provide a timeout in seconds (${defaultText}). On timeout the process is NOT killed: it keeps running in the background and its output keeps going to a log file — the result tells you the log path and a follow-up message arrives when it finishes. Do not re-run a command that timed out; read its log instead.`,
    `Set run_in_background to true to skip waiting altogether: the command starts in the background immediately (no timeout applies), the result tells you the job id and log path, and a follow-up message arrives when it finishes. Use it for long work (builds, full test runs, downloads, long polls) instead of giving a tiny timeout.`,
  ].join(" ");
}

/** timeout 参数说明（覆盖宿主那句 "no default timeout"）。 */
export function timeoutParamDescription(defaultSeconds: number | undefined): string {
  const suffix =
    defaultSeconds === undefined
      ? "no default timeout"
      : `default ${defaultSeconds}s when omitted`;
  return `Timeout in seconds (optional, ${suffix}). On timeout the command is moved to the background instead of being killed. Ignored when run_in_background is true.`;
}

/** `run_in_background` 参数说明（新增参数，本扩展独有）。 */
export function runInBackgroundParamDescription(): string {
  return "Move the command to the background immediately instead of waiting for it: the call returns at once with a job id and log path, and a follow-up message arrives when it finishes. Use for long work (builds, full test runs, downloads, long polls). When true, timeout is ignored.";
}

/** job 的位置描述：本地给 pid，远端给目标主机（远端 job 没有本地 pid）。 */
export function jobPlace(job: JobRecord): string {
  return job.target === undefined ? `pid ${job.pid ?? "未知"}` : `remote ${job.target}`;
}

/** 命中超时时替换宿主结果的文本（作为 tool error 呈现，附带最近输出）。 */
export function timeoutResultText(seconds: number, job: JobRecord, tail: string): string {
  const head = [
    `⏱ 命令超时（${seconds} 秒）：未杀死，已转入后台继续运行。`,
    `job: ${job.id}（${jobPlace(job)}）`,
    `日志: ${job.logPath}`,
    `进程仍在后台写日志；结束时会给会话发一条通知。不要重跑同一命令，需要中间结果就读日志。`,
  ].join("\n");
  return tail.length === 0 ? head : `${head}\n\n[最近输出]\n${tail}`;
}

/**
 * 主动转后台时替换宿主结果的文本（同样以 tool error 呈现）。
 *
 * 不复用超时文案：说「超时」会把「我主动要的后台」读成事故；也不能 resolve——宿主的
 * 结构化结果（exit_code / wall_time_seconds）没有「已后台」这一位，resolve 等于对脚本撒谎。
 */
export function backgroundResultText(job: JobRecord): string {
  return [
    `⏸ 已直接转入后台运行（未等待结果）。`,
    `job: ${job.id}（${jobPlace(job)}）`,
    `日志: ${job.logPath}`,
    `进程在后台继续写日志；结束时会给会话发一条通知。要看中间结果就读日志，不要重跑同一命令。`,
  ].join("\n");
}

/** 后台任务自然结束时注入会话的 followUp。 */
export function followUpText(job: JobRecord, tail: string): string {
  const duration = job.endedAtMs === null ? "" : `（耗时 ${Math.max(0, Math.round((job.endedAtMs - job.startedAtMs) / 1000))}s）`;
  const head = [
    `[timeout-bg ${job.id}] 后台命令已结束，退出码 ${job.exitCode ?? "未知"}${duration}`,
    `日志: ${job.logPath}`,
  ].join("\n");
  return tail.length === 0 ? head : `${head}\n\n[末尾输出]\n${tail}`;
}

function statusLabel(job: JobRecord): string {
  if (job.status === "running") return "▶ 运行中";
  if (job.status === "killed") return "⊘ 已停止";
  return job.exitCode === 0 ? "✓ 已结束（0）" : `✗ 已结束（${job.exitCode ?? "?"}）`;
}

/** 来源词：混合列表里一眼分出「我主动转的」与「超时转的」。 */
export function originLabel(job: JobRecord): string {
  return job.origin === "background" ? "[后台]" : "[超时]";
}

/** 单个任务行（人读）。 */
export function formatJobLine(job: JobRecord, nowMs: number): string {
  const end = job.endedAtMs ?? nowMs;
  const seconds = Math.max(0, Math.round((end - job.startedAtMs) / 1000));
  const place = job.target === undefined ? `pid ${job.pid ?? "?"}` : `remote ${job.target}`;
  return `${statusLabel(job)}  ${originLabel(job)}  ${job.id}  ${seconds}s  ${place}  ${firstLine(job.command)}\n    日志: ${job.logPath}`;
}

/** `/bg` 列表文本。 */
export function formatJobList(jobs: JobRecord[], nowMs: number): string {
  if (jobs.length === 0) return "没有后台任务。（命中超时或主动转后台的命令会出现在这里）";
  return [`后台任务 ${jobs.length} 个：`, ...jobs.map((job) => formatJobLine(job, nowMs))].join("\n");
}

/** 状态条段文本（本地 + 远端后台任务的运行中数量）；没有运行中的任务时本段不显示。 */
export function statusBandText(runningCount: number): string | undefined {
  return runningCount > 0 ? `⏱ ${runningCount} bg` : undefined;
}
