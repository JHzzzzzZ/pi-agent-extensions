/**
 * loop — /loop 参数解析（纯函数，时钟 nowMs 由调用方注入）。
 *
 * 语法：
 *   /loop 5m <任务>            固定间隔循环（单位 s/m/h/d，最小 1 分钟，秒向上取整）
 *   /loop in 30m <任务>        一次性提醒（相对时间）
 *   /loop at 15:00 <任务>      一次性提醒（本地时刻，已过则排到明天）
 *   /loop list | pause <id> | resume <id> | delete <id> | clear
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface CreateSpec {
  recurring: boolean;
  /** 循环间隔（recurring 时必有，已归一化到 >= 1 分钟） */
  intervalMs?: number;
  /** 一次性任务的触发时刻（epoch ms） */
  fireAtMs?: number;
  task: string;
}

export type LoopCommand =
  | { kind: "create"; spec: CreateSpec }
  | { kind: "list" }
  | { kind: "pause"; id: string }
  | { kind: "resume"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "clear" }
  | { kind: "usage" };

export const MIN_INTERVAL_MS = 60_000;

const UNIT_MS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

// 注意 alternation 顺序：长词在前，避免 "min" 被 "m" 截走
const DURATION_RE = /^(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)$/i;
const AT_RE = /^(\d{1,2}):(\d{2})$/;

function parseDurationMs(token: string): number | undefined {
  const m = DURATION_RE.exec(token);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = UNIT_MS[m[2].toLowerCase()];
  if (!Number.isFinite(n) || n <= 0 || unit === undefined) return undefined;
  return n * unit;
}

/** 取下一段时长描述：支持 "30m" 连写与 "2 hours" 分写（数字、单位各占一个词） */
function takeDuration(tokens: string[]): { durationMs: number; rest: string[] } | undefined {
  if (tokens.length === 0) return undefined;
  const single = parseDurationMs(tokens[0]!);
  if (single !== undefined) return { durationMs: single, rest: tokens.slice(1) };
  if (tokens.length >= 2) {
    const combined = parseDurationMs(`${tokens[0]} ${tokens[1]}`);
    if (combined !== undefined) return { durationMs: combined, rest: tokens.slice(2) };
  }
  return undefined;
}

/** 循环间隔归一化：秒向上取整到分钟，且不小于 1 分钟 */
function normalizeRecurringInterval(ms: number): number {
  return Math.max(Math.ceil(ms / 60_000) * 60_000, MIN_INTERVAL_MS);
}

function resolveAtTime(hh: number, mm: number, nowMs: number): number | undefined {
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return undefined;
  const d = new Date(nowMs);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function parseLoopCommand(args: string, nowMs: number): ParseResult<LoopCommand> {
  const trimmed = args.trim();
  if (!trimmed) return { ok: true, value: { kind: "usage" } };

  const tokens = trimmed.split(/\s+/);

  // 子命令仅在整体形态完全匹配时生效，避免与任务文本冲突（如 "5m list pods"）
  if (tokens.length === 1) {
    if (tokens[0] === "list") return { ok: true, value: { kind: "list" } };
    if (tokens[0] === "clear") return { ok: true, value: { kind: "clear" } };
  }
  if (tokens.length === 2 && (tokens[0] === "pause" || tokens[0] === "resume" || tokens[0] === "delete")) {
    return { ok: true, value: { kind: tokens[0], id: tokens[1]! } };
  }

  let rest = tokens;
  let hadEvery = false;
  if (rest[0]?.toLowerCase() === "every") {
    hadEvery = true;
    rest = rest.slice(1);
  }

  // in <时长> <任务>
  if (!hadEvery && rest[0]?.toLowerCase() === "in") {
    const taken = takeDuration(rest.slice(1));
    if (!taken) {
      return { ok: false, message: "用法：/loop in 30m <任务>" };
    }
    const task = taken.rest.join(" ");
    if (!task) return { ok: false, message: "请提供任务内容，例如：/loop in 30m 检查部署状态" };
    return {
      ok: true,
      value: { kind: "create", spec: { recurring: false, fireAtMs: nowMs + taken.durationMs, task } },
    };
  }

  // at HH:MM <任务>
  if (!hadEvery && rest[0]?.toLowerCase() === "at") {
    const at = rest[1] !== undefined ? AT_RE.exec(rest[1]) : null;
    if (!at) return { ok: false, message: `无效时间 "${rest[1] ?? ""}"，应为 HH:MM（24 小时制）` };
    const fireAtMs = resolveAtTime(Number(at[1]), Number(at[2]), nowMs);
    if (fireAtMs === undefined) return { ok: false, message: `无效时间 "${rest[1]}"，应为 HH:MM（24 小时制）` };
    const task = rest.slice(2).join(" ");
    if (!task) return { ok: false, message: "请提供任务内容，例如：/loop at 15:00 发布版本" };
    return {
      ok: true,
      value: { kind: "create", spec: { recurring: false, fireAtMs, task } },
    };
  }

  // [every] <时长> <任务>
  if (rest[0] !== undefined) {
    const taken = takeDuration(rest);
    if (taken) {
      const task = taken.rest.join(" ");
      if (!task) return { ok: false, message: "请提供任务内容，例如：/loop 5m 检查部署状态" };
      return {
        ok: true,
        value: {
          kind: "create",
          spec: { recurring: true, intervalMs: normalizeRecurringInterval(taken.durationMs), task },
        },
      };
    }
    if (hadEvery) return { ok: false, message: "无法识别间隔，例如：/loop every 30m <任务>" };
  }

  return { ok: true, value: { kind: "usage" } };
}

export function formatInterval(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

export type ScheduleSpec = { recurring: true; intervalMs: number } | { recurring: false; fireAtMs: number };

/**
 * 供 agent 工具（loop_create）解析独立的调度描述，语法与 /loop 命令一致：
 *   "every 5m" / "5m" / "2 hours"  → 循环
 *   "in 30m"                       → 延时一次性
 *   "at 15:00"                     → 本地时刻一次性（已过则排到明天）
 * 整串必须恰好是一个调度描述（多余的词视为错误）。
 */
export function parseSchedule(raw: string, nowMs: number): ParseResult<ScheduleSpec> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: "缺少调度描述" };

  const tokens = trimmed.split(/\s+/);
  let hadEvery = false;
  if (tokens[0]?.toLowerCase() === "every") {
    hadEvery = true;
    tokens.shift();
  }

  if (!hadEvery && tokens[0]?.toLowerCase() === "in") {
    const taken = takeDuration(tokens.slice(1));
    if (!taken || taken.rest.length > 0) return { ok: false, message: '无法识别延时，例如 "in 30m"' };
    return { ok: true, value: { recurring: false, fireAtMs: nowMs + taken.durationMs } };
  }

  if (!hadEvery && tokens[0]?.toLowerCase() === "at") {
    const at = tokens.length === 2 && tokens[1] !== undefined ? AT_RE.exec(tokens[1]) : null;
    if (!at) return { ok: false, message: '无法识别时刻，例如 "15:00"（24 小时制）' };
    const fireAtMs = resolveAtTime(Number(at[1]), Number(at[2]), nowMs);
    if (fireAtMs === undefined) return { ok: false, message: `无效时间 "${tokens[1]}"，应为 HH:MM（24 小时制）` };
    return { ok: true, value: { recurring: false, fireAtMs } };
  }

  const taken = takeDuration(tokens);
  if (taken && taken.rest.length === 0) {
    return { ok: true, value: { recurring: true, intervalMs: normalizeRecurringInterval(taken.durationMs) } };
  }
  return { ok: false, message: '无法识别调度，例如 "every 5m"、"in 30m"、"at 15:00"' };
}
