/**
 * loop — /loop 参数解析（纯函数，时钟 nowMs 由调用方注入）。
 *
 * 语法（命令面冒号化 v1.6.0：裸 /loop 只管创建，管理走 /loop:* 独立命令）：
 *   /loop 5m <任务>            固定间隔循环（单位 s/m/h/d，最小 1 分钟，秒向上取整）
 *   /loop in 30m <任务>        一次性提醒（相对时间）
 *   /loop at 15:00 <任务>      一次性提醒（本地时刻，已过则排到明天）
 *   /loop daily at 09:00 <任务>                每天固定时刻循环（= every day at）
 *   /loop every 1h from 00:00 to 09:00 <任务>  每日时间窗口 [start, end] 闭区间内按间隔循环
 *   /loop --bg <上述任意创建形态>  v1.3：后台模式——到期拉起独立子 pi 进程执行（会话可 resume）
 *   /loop:list | /loop:pause <id> | /loop:resume <id> | /loop:delete <id> | /loop:clear
 */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** v1.2 新增调度：每天固定时刻 / 每日时间窗口内按间隔（时刻均为距本地午夜的毫秒数） */
export type RecurringSchedule =
  | { kind: "daily"; atMs: number }
  | { kind: "window"; intervalMs: number; startMs: number; endMs: number };

export interface CreateSpec {
  recurring: boolean;
  /** 循环间隔（interval 模式 recurring 时必有，已归一化到 >= 1 分钟） */
  intervalMs?: number;
  /** 一次性任务的触发时刻 / daily・window 模式的首次触发时刻（epoch ms） */
  fireAtMs?: number;
  /** daily・window 调度描述（存在时优先于 intervalMs） */
  schedule?: RecurringSchedule;
  /** v1.3：后台模式（缺省 = 前台注入当前会话） */
  background?: boolean;
  /** v1.4：后台任务模型指定（provider/id 或 pi 模型 pattern，透传子 pi --model）；仅后台模式支持 */
  model?: string;
  task: string;
}

export type LoopCommand =
  | { kind: "create"; spec: CreateSpec }
  | { kind: "usage" };

/** 冒号子命令（v1.6.0）：独立静态注册命令名。 */
export const LOOP_SUBCOMMANDS = {
  list: "loop:list",
  pause: "loop:pause",
  resume: "loop:resume",
  delete: "loop:delete",
  clear: "loop:clear",
} as const;

/**
 * 旧空格子命令 → 新命令 + 用法。裸 `/loop` 命中时只提示改名、绝不执行
 * （防止 `/loop pause 3` 被误当成任务文本）。
 */
export const RETIRED_LOOP_SUBCOMMANDS: Record<string, { command: string; usage: string }> = {
  list: { command: LOOP_SUBCOMMANDS.list, usage: "/loop:list" },
  pause: { command: LOOP_SUBCOMMANDS.pause, usage: "/loop:pause <id>" },
  resume: { command: LOOP_SUBCOMMANDS.resume, usage: "/loop:resume <id>" },
  delete: { command: LOOP_SUBCOMMANDS.delete, usage: "/loop:delete <id>" },
  clear: { command: LOOP_SUBCOMMANDS.clear, usage: "/loop:clear" },
};

export const MIN_INTERVAL_MS = 60_000;
export const DAY_MS = 86_400_000;

const UNIT_MS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: DAY_MS, day: DAY_MS, days: DAY_MS,
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

/** "HH:MM" → 距本地午夜的毫秒数；非法返回 undefined */
export function parseTimeOfDayMs(token: string): number | undefined {
  const m = AT_RE.exec(token);
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return undefined;
  return (hh * 60 + mm) * 60_000;
}

/** 本地 atMs 时刻在 nowMs 之后（严格大于）的下一次出现；当天已过则排到明天 */
export function nextDailyOccurrence(atMs: number, nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(Math.floor(atMs / 3_600_000), Math.floor((atMs % 3_600_000) / 60_000), 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * 每日窗口 [startMs, endMs]（闭区间）内、锚定在窗口起点的间隔网格上，
 * nowMs 之后（严格大于）的下一个触发点；当天网格走完则排到明天窗口起点。
 * start < end 由创建/清洗校验保证，明天起点必然命中，两轮足够。
 */
export function nextWindowOccurrence(
  intervalMs: number,
  startMs: number,
  endMs: number,
  nowMs: number,
): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const dayStart = d.getTime();
    let candidate = dayStart + startMs;
    if (candidate <= nowMs) {
      candidate += (Math.floor((nowMs - candidate) / intervalMs) + 1) * intervalMs;
    }
    if (candidate <= dayStart + endMs) return candidate;
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  }
  return d.getTime() + startMs;
}

/** v1.3：--bg 前缀标志（大小写不敏感）——本次任务走后台 agent */
function takeBackgroundFlag(tokens: string[]): { background: boolean; rest: string[] } {
  if (tokens[0]?.toLowerCase() === "--bg") return { background: true, rest: tokens.slice(1) };
  return { background: false, rest: tokens };
}

/**
 * v1.4：--bg 后可选 --model <provider/id>——后台子 pi 的模型指定。
 * 缺值/值像旗标 → 报错；不带 --bg 用 --model → 显式报错（前台注入当前会话，无法指定模型）。
 */
function takeModelFlag(tokens: string[], background: boolean): ParseResult<{ model?: string; rest: string[] }> {
  if (tokens[0]?.toLowerCase() !== "--model") return { ok: true, value: { rest: tokens } };
  const value = tokens[1];
  if (value === undefined || value.startsWith("-")) {
    return { ok: false, message: "--model 需要一个模型参数（provider/id 格式，如 opencode-go/deepseek-v4-flash）" };
  }
  if (!background) {
    return { ok: false, message: "--model 仅后台模式支持：/loop --bg --model <provider/id> <创建形态>" };
  }
  return { ok: true, value: { model: value, rest: tokens.slice(2) } };
}

function specWithFlags(spec: CreateSpec, background: boolean, model?: string): CreateSpec {
  if (!background) return spec;
  return model !== undefined ? { ...spec, background: true, model } : { ...spec, background: true };
}

export function parseLoopCommand(args: string, nowMs: number): ParseResult<LoopCommand> {
  const trimmed = args.trim();
  if (!trimmed) return { ok: true, value: { kind: "usage" } };

  const tokens = trimmed.split(/\s+/);

  // 管理子命令已拆为独立冒号命令（/loop:list 等）；旧管理词在这里不再匹配，
  // 与任意其它文本一样落到 usage（裸命令入口会先提示改名，见 index.ts）。
  const bg = takeBackgroundFlag(tokens);
  const mdl = takeModelFlag(bg.rest, bg.background);
  if (!mdl.ok) return mdl;
  let rest = mdl.value.rest;
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
      value: { kind: "create", spec: specWithFlags({ recurring: false, fireAtMs: nowMs + taken.durationMs, task }, bg.background, mdl.value.model) },
    };
  }

  // at HH:MM <任务>
  if (!hadEvery && rest[0]?.toLowerCase() === "at") {
    const atMs = parseTimeOfDayMs(rest[1] ?? "");
    if (atMs === undefined) return { ok: false, message: `无效时间 "${rest[1] ?? ""}"，应为 HH:MM（24 小时制）` };
    const fireAtMs = nextDailyOccurrence(atMs, nowMs);
    const task = rest.slice(2).join(" ");
    if (!task) return { ok: false, message: "请提供任务内容，例如：/loop at 15:00 发布版本" };
    return {
      ok: true,
      value: { kind: "create", spec: specWithFlags({ recurring: false, fireAtMs, task }, bg.background, mdl.value.model) },
    };
  }

  // daily at HH:MM <任务> / every day at HH:MM <任务>：每天固定时刻循环
  const head = rest[0]?.toLowerCase();
  const dailyAt = hadEvery
    ? head === "day" && rest[1]?.toLowerCase() === "at"
    : head === "daily" && rest[1]?.toLowerCase() === "at";
  if (dailyAt) {
    const atMs = parseTimeOfDayMs(rest[2] ?? "");
    if (atMs === undefined) return { ok: false, message: `无效时间 "${rest[2] ?? ""}"，应为 HH:MM（24 小时制）` };
    const task = rest.slice(3).join(" ");
    if (!task) return { ok: false, message: "请提供任务内容，例如：/loop daily at 09:00 晨会提醒" };
    return {
      ok: true,
      value: {
        kind: "create",
        spec: specWithFlags(
          { recurring: true, schedule: { kind: "daily", atMs }, fireAtMs: nextDailyOccurrence(atMs, nowMs), task },
          bg.background,
          mdl.value.model,
        ),
      },
    };
  }
  if (head === "daily" || (hadEvery && head === "day")) {
    return { ok: false, message: "用法：/loop daily at 09:00 <任务>（每天固定时刻循环）" };
  }

  // [every] <时长> <任务> / [every] <时长> from HH:MM to HH:MM <任务>
  if (rest[0] !== undefined) {
    const taken = takeDuration(rest);
    if (taken && taken.rest[0]?.toLowerCase() === "from" && taken.rest[2]?.toLowerCase() === "to") {
      const startTok = taken.rest[1];
      const endTok = taken.rest[3];
      const startMs = startTok !== undefined ? parseTimeOfDayMs(startTok) : undefined;
      if (startMs === undefined) return { ok: false, message: `无效时间 "${startTok ?? ""}"，应为 HH:MM（24 小时制）` };
      const endMs = endTok !== undefined ? parseTimeOfDayMs(endTok) : undefined;
      if (endMs === undefined) return { ok: false, message: `无效时间 "${endTok ?? ""}"，应为 HH:MM（24 小时制）` };
      if (startMs >= endMs) return { ok: false, message: "窗口起点需早于终点，例如 from 00:00 to 09:00" };
      const task = taken.rest.slice(4).join(" ");
      if (!task) return { ok: false, message: "请提供任务内容，例如：/loop every 1h from 00:00 to 09:00 服务巡检" };
      const intervalMs = normalizeRecurringInterval(taken.durationMs);
      return {
        ok: true,
        value: {
          kind: "create",
          spec: specWithFlags(
            {
              recurring: true,
              schedule: { kind: "window", intervalMs, startMs, endMs },
              fireAtMs: nextWindowOccurrence(intervalMs, startMs, endMs, nowMs),
              task,
            },
            bg.background,
            mdl.value.model,
          ),
        },
      };
    }
    if (taken) {
      const task = taken.rest.join(" ");
      if (!task) return { ok: false, message: "请提供任务内容，例如：/loop 5m 检查部署状态" };
      return {
        ok: true,
        value: {
          kind: "create",
          spec: specWithFlags({ recurring: true, intervalMs: normalizeRecurringInterval(taken.durationMs), task }, bg.background, mdl.value.model),
        },
      };
    }
    if (hadEvery) return { ok: false, message: "无法识别间隔，例如：/loop every 30m <任务>" };
  }

  return { ok: true, value: { kind: "usage" } };
}

export function formatInterval(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * 供 agent 工具（loop_create）解析独立的调度描述，语法与 /loop 命令一致：
 *   "every 5m" / "5m" / "2 hours"           → 固定间隔循环
 *   "daily at 09:00" / "every day at 09:00" → 每天固定时刻循环
 *   "every 1h from 00:00 to 09:00"          → 每日时间窗口内按间隔循环（闭区间）
 *   "in 30m"                                → 延时一次性
 *   "at 15:00"                              → 本地时刻一次性（已过则排到明天）
 * 整串必须恰好是一个调度描述（多余的词视为错误）。
 */
export type ScheduleSpec = {
  recurring: boolean;
  /** interval 模式的间隔（daily/window 模式缺省） */
  intervalMs?: number;
  /** daily/window 调度描述 */
  schedule?: RecurringSchedule;
  /** 首次触发时刻（epoch ms） */
  fireAtMs: number;
};

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
    const atMs = parseTimeOfDayMs(tokens[1]!);
    if (atMs === undefined) return { ok: false, message: `无效时间 "${tokens[1]}"，应为 HH:MM（24 小时制）` };
    return { ok: true, value: { recurring: false, fireAtMs: nextDailyOccurrence(atMs, nowMs) } };
  }

  // daily at HH:MM / every day at HH:MM
  const head = tokens[0]?.toLowerCase();
  const dailyAt = hadEvery
    ? head === "day" && tokens[1]?.toLowerCase() === "at"
    : head === "daily" && tokens[1]?.toLowerCase() === "at";
  if (dailyAt) {
    if (tokens.length !== 3) return { ok: false, message: '无法识别调度，例如 "daily at 09:00"' };
    const atMs = parseTimeOfDayMs(tokens[2] ?? "");
    if (atMs === undefined) return { ok: false, message: `无效时间 "${tokens[2] ?? ""}"，应为 HH:MM（24 小时制）` };
    return {
      ok: true,
      value: { recurring: true, schedule: { kind: "daily", atMs }, fireAtMs: nextDailyOccurrence(atMs, nowMs) },
    };
  }
  if (head === "daily" || (hadEvery && head === "day")) {
    return { ok: false, message: '无法识别调度，例如 "daily at 09:00"' };
  }

  // [every] <时长> from HH:MM to HH:MM
  const taken = takeDuration(tokens);
  if (taken && taken.rest[0]?.toLowerCase() === "from") {
    const startTok = taken.rest[1];
    const endTok = taken.rest[3];
    if (taken.rest.length !== 4 || taken.rest[2]?.toLowerCase() !== "to" || startTok === undefined || endTok === undefined) {
      return { ok: false, message: '无法识别调度，例如 "every 1h from 00:00 to 09:00"' };
    }
    const startMs = parseTimeOfDayMs(startTok);
    if (startMs === undefined) return { ok: false, message: `无效时间 "${startTok}"，应为 HH:MM（24 小时制）` };
    const endMs = parseTimeOfDayMs(endTok);
    if (endMs === undefined) return { ok: false, message: `无效时间 "${endTok}"，应为 HH:MM（24 小时制）` };
    if (startMs >= endMs) return { ok: false, message: "窗口起点需早于终点，例如 from 00:00 to 09:00" };
    const intervalMs = normalizeRecurringInterval(taken.durationMs);
    return {
      ok: true,
      value: {
        recurring: true,
        schedule: { kind: "window", intervalMs, startMs, endMs },
        fireAtMs: nextWindowOccurrence(intervalMs, startMs, endMs, nowMs),
      },
    };
  }

  if (taken && taken.rest.length === 0) {
    const intervalMs = normalizeRecurringInterval(taken.durationMs);
    return { ok: true, value: { recurring: true, intervalMs, fireAtMs: nowMs + intervalMs } };
  }
  return { ok: false, message: '无法识别调度，例如 "every 5m"、"daily at 09:00"、"in 30m"、"at 15:00"' };
}
