/**
 * loop — 任务状态机（纯逻辑，时钟 nowMs 由调用方注入，便于测试）。
 *
 * 调度语义（对齐 Claude Code scheduled tasks）：
 *   - 错过的时间点不补跑，只触发一次
 *   - 一次性任务触发后自删
 *   - 重复任务创建 7 天后过期（到期则最后触发一次再删除）
 *   - 暂停的任务不触发；恢复时错过的循环间隔直接跳过
 *   - v1.2：daily（每天固定时刻）/ window（每日时间窗口闭区间内按间隔循环）调度，
 *     推进按"now 之后（严格大于）的下一个触发点"计算，跨天用本地 Date rollover
 *   - v1.3：后台模式（background）——到期拉起独立子 pi 进程（见 runner.ts），
 *     会话落盘可用 pi --session 恢复
 *   - v1.8：同一任务的后台轮次允许重叠（不再「上一轮在跑就跳过」），轮次记录为
 *     每条 `runs` 数组：内存态装本次会话全部轮次，快照只持久化运行中的轮次
 *     （activeRuns），已完成轮次由 index.ts 写 append-only 条目 loop-run-v1 承载
 *     ——否则每次全量快照叠加全量轮次会让会话文件 O(n²) 膨胀
 */
import {
  DAY_MS,
  formatInterval,
  nextDailyOccurrence,
  nextWindowOccurrence,
  type RecurringSchedule,
} from "./parse.ts";

export interface LoopTask {
  id: string;
  task: string;
  recurring: boolean;
  /** 循环间隔（interval 模式 recurring 时必有） */
  intervalMs?: number;
  /** v1.2：daily/window 调度（存在时优先于 intervalMs；缺省即固定间隔模式，兼容旧快照） */
  schedule?: RecurringSchedule;
  /** 下次触发时刻（epoch ms） */
  nextDueAt: number;
  /** 创建时刻（epoch ms），7 天过期的起算点 */
  createdAt: number;
  paused: boolean;
  /** v1.3：后台模式——到期拉起独立子 pi 进程执行（会话落盘可 resume），不注入当前会话 */
  background?: boolean;
  /** v1.4：后台任务模型指定（provider/id 或 pi model pattern，透传子 pi --model）；缺省用 pi 默认模型 */
  model?: string;
  /**
   * v1.8：本次会话内的全部后台轮次（升序）。内存态展示用：
   * 快照只持久化 status==="running" 的轮次（activeRuns），已完成轮次在 loop-run-v1 条目里。
   */
  runs?: BgRunRecord[];
}

/** v1.3：后台任务最近一次运行的状态 */
export type BgRunStatus = "running" | "done" | "failed" | "timeout" | "interrupted";

const BG_RUN_STATUSES: readonly BgRunStatus[] = ["running", "done", "failed", "timeout", "interrupted"];

export interface BgRunRecord {
  /** v1.8：轮次标识（并发下唯一；运行中记录、条目回放、去重都靠它关联） */
  runId: string;
  /** 本次后台运行启动时刻（epoch ms） */
  startedAt: number;
  finishedAt?: number;
  status: BgRunStatus;
  /** 子 pi 会话 id（pi --session <id> 可恢复对话记录） */
  sessionId?: string;
  /** 会话文件绝对路径（best-effort 定位） */
  sessionPath?: string;
  /** 结果摘要：最后一条 assistant 文本（截断） */
  summary?: string;
}

/** 后台运行摘要的持久化上限（超出截断） */
export const MAX_BG_SUMMARY_LEN = 500;

/** /loop:list 里已完成轮次的展示上限（更早的折成一行计数；历史本身全量保留在条目里） */
export const BG_HISTORY_DISPLAY = 10;

export const MAX_TASKS = 50;
export const MAX_TASK_LEN = 2000;
export const RECURRING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_INTERVAL_MS = 60_000;

export type CreateTaskInput = {
  task: string;
  recurring: boolean;
  intervalMs?: number;
  /** v1.2：daily/window 调度（存在时可省略 intervalMs） */
  schedule?: RecurringSchedule;
  /** v1.3：后台模式（缺省 = 前台注入当前会话） */
  background?: boolean;
  /** v1.4：后台任务模型指定（仅 background=true 时有意义） */
  model?: string;
  /** 首次触发时刻（epoch ms） */
  fireAtMs: number;
  nowMs: number;
};

/** createTask 入参校验：返回错误消息或 undefined（合法） */
function validateSchedule(schedule: RecurringSchedule | undefined): string | undefined {
  if (schedule === undefined) return undefined;
  const alignedMinute = (v: number) => v % 60_000 === 0;
  if (schedule.kind === "daily") {
    if (!Number.isFinite(schedule.atMs) || schedule.atMs < 0 || schedule.atMs >= DAY_MS || !alignedMinute(schedule.atMs)) {
      return "每天调度的时刻无效（应为当日 0:00–24:00 内的整分钟）";
    }
    return undefined;
  }
  if (
    !Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0 ||
    !Number.isFinite(schedule.startMs) || !Number.isFinite(schedule.endMs) ||
    schedule.startMs < 0 || schedule.endMs >= DAY_MS || schedule.startMs >= schedule.endMs ||
    !alignedMinute(schedule.startMs) || !alignedMinute(schedule.endMs)
  ) {
    return "时间窗口调度无效（起点需早于终点，且均为当日 0:00–24:00 内的整分钟）";
  }
  return undefined;
}

export function createTask(
  tasks: LoopTask[],
  input: CreateTaskInput,
  genId: () => string,
): { ok: true; task: LoopTask } | { ok: false; message: string } {
  if (tasks.length >= MAX_TASKS) {
    return { ok: false, message: `已达上限（每会话最多 ${MAX_TASKS} 个任务），请先用 /loop:delete 清理` };
  }
  if (input.task.length > MAX_TASK_LEN) {
    return { ok: false, message: `任务内容过长（最多 ${MAX_TASK_LEN} 字符）` };
  }
  if (input.recurring && input.schedule === undefined && (input.intervalMs === undefined || input.intervalMs <= 0)) {
    return { ok: false, message: "循环任务必须提供正的间隔" };
  }
  const badSchedule = input.recurring ? validateSchedule(input.schedule) : undefined;
  if (badSchedule) return { ok: false, message: badSchedule };
  const model = input.model?.trim();
  if (input.model !== undefined && !model) return { ok: false, message: "模型参数不能为空" };
  const task: LoopTask = {
    id: genId(),
    task: input.task,
    recurring: input.recurring,
    intervalMs: input.recurring ? input.intervalMs : undefined,
    nextDueAt: input.fireAtMs,
    createdAt: input.nowMs,
    paused: false,
  };
  // schedule/background/model 依序追加在末尾，键顺序与 hydrate 侧（toSnapshotTask）一致（快照 JSON 稳定可比）
  if (input.schedule !== undefined) task.schedule = input.schedule;
  if (input.background === true) task.background = true;
  if (model) task.model = model;
  tasks.push(task);
  return { ok: true, task };
}

export type ResolveResult =
  | { status: "found"; task: LoopTask }
  | { status: "not_found" }
  | { status: "ambiguous" };

/** 先精确匹配 id，再按前缀匹配；前缀命中多个视为歧义 */
export function resolveTask(tasks: LoopTask[], idOrPrefix: string): ResolveResult {
  const exact = tasks.find((t) => t.id === idOrPrefix);
  if (exact) return { status: "found", task: exact };
  const matches = tasks.filter((t) => t.id.startsWith(idOrPrefix));
  if (matches.length === 1) return { status: "found", task: matches[0]! };
  return matches.length === 0 ? { status: "not_found" } : { status: "ambiguous" };
}

function resolveOrMessage(
  tasks: LoopTask[],
  idOrPrefix: string,
): { ok: true; task: LoopTask } | { ok: false; message: string } {
  const r = resolveTask(tasks, idOrPrefix);
  if (r.status === "found") return { ok: true, task: r.task };
  if (r.status === "ambiguous") {
    return { ok: false, message: `"${idOrPrefix}" 匹配到多个任务，请用更长的 ID` };
  }
  return { ok: false, message: `未找到任务 "${idOrPrefix}"，用 /loop:list 查看现有任务` };
}

export function pauseTask(
  tasks: LoopTask[],
  idOrPrefix: string,
): { ok: true; task: LoopTask } | { ok: false; message: string } {
  const r = resolveOrMessage(tasks, idOrPrefix);
  if (!r.ok) return r;
  r.task.paused = true;
  return { ok: true, task: r.task };
}

/** daily/window：nowMs 之后（严格大于）的下一个触发点；固定间隔模式返回 undefined 由调用方处理 */
function nextScheduledOccurrence(t: LoopTask, nowMs: number): number | undefined {
  const s = t.schedule;
  if (s?.kind === "daily") return nextDailyOccurrence(s.atMs, nowMs);
  if (s?.kind === "window") return nextWindowOccurrence(s.intervalMs, s.startMs, s.endMs, nowMs);
  return undefined;
}

export function resumeTask(
  tasks: LoopTask[],
  idOrPrefix: string,
  nowMs: number,
): { ok: true; task: LoopTask } | { ok: false; message: string } {
  const r = resolveOrMessage(tasks, idOrPrefix);
  if (!r.ok) return r;
  r.task.paused = false;
  // 循环任务错过的间隔不补跑：暂停期间到期的直接排到下一个触发点
  if (r.task.recurring && r.task.nextDueAt <= nowMs) {
    r.task.nextDueAt = nextScheduledOccurrence(r.task, nowMs)
      ?? nowMs + (r.task.intervalMs ?? FALLBACK_INTERVAL_MS);
  }
  return { ok: true, task: r.task };
}

export function deleteTask(
  tasks: LoopTask[],
  idOrPrefix: string,
): { ok: true; task: LoopTask } | { ok: false; message: string } {
  const r = resolveOrMessage(tasks, idOrPrefix);
  if (!r.ok) return r;
  tasks.splice(tasks.indexOf(r.task), 1);
  return { ok: true, task: r.task };
}

export function clearTasks(tasks: LoopTask[]): number {
  const n = tasks.length;
  tasks.length = 0;
  return n;
}

export type PollResult = { due: LoopTask[]; changed: boolean };

/** 收割到期任务：推进循环任务的 nextDueAt、自删一次性/过期任务。返回的 due 按到期先后排序 */
export function pollDue(tasks: LoopTask[], nowMs: number): PollResult {
  const due: LoopTask[] = [];
  let changed = false;

  // 先剔除过期任务；恰好到期的最后触发一次
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i]!;
    if (t.recurring && nowMs >= t.createdAt + RECURRING_TTL_MS) {
      if (!t.paused && t.nextDueAt <= nowMs) due.push(t);
      tasks.splice(i, 1);
      changed = true;
    }
  }

  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i]!;
    if (t.paused || t.nextDueAt > nowMs) continue;
    due.push(t);
    changed = true;
    if (t.recurring) {
      const next = nextScheduledOccurrence(t, nowMs);
      if (next !== undefined) {
        // daily/window：跳过错过的触发点，推进到 now 之后的下一个触发点（不补跑）
        t.nextDueAt = next;
      } else {
        const interval = t.intervalMs ?? FALLBACK_INTERVAL_MS;
        const missed = Math.floor((nowMs - t.nextDueAt) / interval) + 1;
        t.nextDueAt += missed * interval;
      }
    } else {
      tasks.splice(i, 1);
    }
  }

  due.sort((a, b) => a.nextDueAt - b.nextDueAt);
  return { due, changed };
}

export type TaskSnapshot = { tasks: PersistedTask[] };

/**
 * 快照里的任务形态：runs 只保留运行中的轮次（activeRuns）。
 * 已完成轮次全量在 loop-run-v1 条目里——all-in-snapshot 会让会话文件随轮次 O(n²) 膨胀。
 */
export interface PersistedTask extends Omit<LoopTask, "runs"> {
  activeRuns?: BgRunRecord[];
}

/** 白名单序列化：键顺序固定，且 runs 只留运行中的轮次 */
function toSnapshotTask(t: LoopTask): PersistedTask {
  const out: PersistedTask = {
    id: t.id,
    task: t.task,
    recurring: t.recurring,
    intervalMs: t.recurring ? t.intervalMs : undefined,
    nextDueAt: t.nextDueAt,
    createdAt: t.createdAt,
    paused: t.paused,
  };
  if (t.schedule !== undefined) out.schedule = t.schedule;
  if (t.background === true) out.background = true;
  if (t.model) out.model = t.model;
  const active = t.runs?.filter((r) => r.status === "running");
  if (active && active.length > 0) out.activeRuns = active.map((r) => ({ ...r }));
  return out;
}

export function serializeTasks(tasks: LoopTask[]): TaskSnapshot {
  return { tasks: tasks.map(toSnapshotTask) };
}

/** 从会话条目恢复。防御式清洗：坏条目跳过；过期任务剔除；错过的一次性不再触发；错过的循环间隔跳过 */
export function hydrateTasks(data: unknown, nowMs: number): LoopTask[] {
  if (!data || typeof data !== "object") return [];
  const rawTasks = (data as { tasks?: unknown }).tasks;
  if (!Array.isArray(rawTasks)) return [];
  const out: LoopTask[] = [];
  for (const raw of rawTasks) {
    const t = sanitizeTask(raw);
    if (!t) continue;
    if (t.recurring) {
      if (nowMs >= t.createdAt + RECURRING_TTL_MS) continue;
      if (t.nextDueAt <= nowMs) {
        t.nextDueAt = nextScheduledOccurrence(t, nowMs)
          ?? nowMs + (t.intervalMs ?? FALLBACK_INTERVAL_MS);
      }
    } else if (t.nextDueAt <= nowMs) {
      continue;
    }
    out.push(t);
  }
  return out;
}

/** 防御式清洗调度描述：未知形态/越界/非整分钟一律返回 undefined */
function sanitizeSchedule(raw: unknown): RecurringSchedule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const alignedMinute = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v < DAY_MS && v % 60_000 === 0;
  if (r.kind === "daily") {
    return alignedMinute(r.atMs) ? { kind: "daily", atMs: r.atMs } : undefined;
  }
  if (r.kind === "window") {
    const intervalMs = r.intervalMs;
    if (
      typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0 ||
      !alignedMinute(r.startMs) || !alignedMinute(r.endMs) ||
      (r.startMs as number) >= (r.endMs as number)
    ) {
      return undefined;
    }
    return { kind: "window", intervalMs, startMs: r.startMs as number, endMs: r.endMs as number };
  }
  return undefined;
}

/** 防御式清洗后台运行记录：字段非法/越界一律丢弃或截断；恢复时 running 视为 interrupted（宿主中途退出） */
function sanitizeRun(raw: unknown, fallbackRunId?: string): BgRunRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const runId = typeof r.runId === "string" && r.runId ? r.runId : fallbackRunId;
  if (!runId) return undefined;
  if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt)) return undefined;
  if (typeof r.status !== "string" || !BG_RUN_STATUSES.includes(r.status as BgRunStatus)) return undefined;
  const rec: BgRunRecord = {
    runId,
    startedAt: r.startedAt,
    status: r.status === "running" ? "interrupted" : (r.status as BgRunStatus),
  };
  if (typeof r.finishedAt === "number" && Number.isFinite(r.finishedAt)) rec.finishedAt = r.finishedAt;
  if (typeof r.sessionId === "string" && r.sessionId) rec.sessionId = r.sessionId;
  if (typeof r.sessionPath === "string" && r.sessionPath) rec.sessionPath = r.sessionPath;
  if (typeof r.summary === "string" && r.summary) rec.summary = r.summary.slice(0, MAX_BG_SUMMARY_LEN);
  return rec;
}

/** 清洗快照里的轮次：v1.8 的 activeRuns（数组）+ v1.7 及以前的 lastRun（单对象）两条路径都接 */
function sanitizeRuns(r: Record<string, unknown>, taskId: string): BgRunRecord[] | undefined {
  const out: BgRunRecord[] = [];
  if (Array.isArray(r.activeRuns)) {
    for (const raw of r.activeRuns) {
      const rec = sanitizeRun(raw);
      if (rec) out.push(rec);
    }
  }
  // 旧快照的单条 lastRun：runId 由任务 id 派生（确定性，重复水合按 runId 去重）
  const legacy = sanitizeRun(r.lastRun, `legacy-${taskId}`);
  if (legacy) out.push(legacy);
  return out.length > 0 ? out : undefined;
}

/** loop-run-v1 条目载荷：轮次记录 + 归属任务 */
export interface BgRunEntry extends BgRunRecord {
  taskId: string;
}

/** 解析 loop-run-v1 条目载荷（index.ts 启动时回放历史轮次） */
export function parseBgRunEntry(data: unknown): BgRunEntry | undefined {
  if (!data || typeof data !== "object") return undefined;
  const taskId = (data as { taskId?: unknown }).taskId;
  if (typeof taskId !== "string" || !taskId) return undefined;
  const record = sanitizeRun(data);
  return record ? { taskId, ...record } : undefined;
}

/** 合并条目回放的历史与快照恢复的轮次：按 runId 去重（终态优先），按开始时刻升序 */
export function mergeRuns(history: BgRunRecord[], recovered: BgRunRecord[]): BgRunRecord[] {
  const byId = new Map<string, BgRunRecord>();
  for (const rec of [...history, ...recovered]) {
    const prev = byId.get(rec.runId);
    if (!prev || (prev.status === "running" && rec.status !== "running")) byId.set(rec.runId, rec);
  }
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

function sanitizeTask(raw: unknown): LoopTask | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return undefined;
  if (typeof r.task !== "string" || !r.task) return undefined;
  if (typeof r.nextDueAt !== "number" || !Number.isFinite(r.nextDueAt)) return undefined;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return undefined;
  const recurring = r.recurring === true;
  const intervalMs =
    typeof r.intervalMs === "number" && Number.isFinite(r.intervalMs) && r.intervalMs > 0
      ? r.intervalMs
      : undefined;
  const schedule = recurring ? sanitizeSchedule(r.schedule) : undefined;
  if (recurring && intervalMs === undefined && schedule === undefined) return undefined;
  const t: LoopTask = {
    id: r.id,
    task: r.task,
    recurring,
    intervalMs: recurring ? intervalMs : undefined,
    nextDueAt: r.nextDueAt,
    createdAt: r.createdAt,
    paused: r.paused === true,
  };
  // 依序追加在末尾，与 hydrate 侧（toSnapshotTask）的键顺序一致（快照 JSON 稳定可比）
  if (schedule !== undefined) t.schedule = schedule;
  if (r.background === true) t.background = true;
  if (typeof r.model === "string" && r.model) t.model = r.model;
  const runs = sanitizeRuns(r, t.id);
  if (runs !== undefined) t.runs = runs;
  return t;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 距本地午夜的毫秒数 → "HH:MM" */
export function formatTimeOfDay(msOfDay: number): string {
  const totalMin = Math.floor(msOfDay / 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(totalMin / 60) % 24)}:${p(totalMin % 60)}`;
}

/** 任务调度的人类描述（创建回执、/loop:list、loop_create 返回共用） */
export function describeRecurrence(t: {
  recurring: boolean;
  intervalMs?: number;
  schedule?: RecurringSchedule;
}): string {
  if (!t.recurring) return "一次性";
  const s = t.schedule;
  if (s?.kind === "daily") return `每天 ${formatTimeOfDay(s.atMs)}`;
  if (s?.kind === "window") {
    return `每天 ${formatTimeOfDay(s.startMs)}–${formatTimeOfDay(s.endMs)} 每 ${formatInterval(s.intervalMs)}`;
  }
  return `每 ${formatInterval(t.intervalMs ?? FALLBACK_INTERVAL_MS)}`;
}

/** 后台运行状态的人类描述（/loop:list 上次运行行共用） */
export function formatBgRunStatus(status: BgRunStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "done":
      return "完成";
    case "failed":
      return "失败";
    case "timeout":
      return "超时";
    case "interrupted":
      return "中断";
  }
}

/** 轮次起始时刻的短标签（本地 HHMM，拼进子会话名：并发多轮同名会话在选择器里分不清） */
export function formatRoundLabel(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 单轮后台记录的一行（运行中含已跑时长；完成行含会话与摘要） */
function formatRunLine(run: BgRunRecord, nowMs: number): string {
  const parts = [`└ ${formatBgRunStatus(run.status)}`, formatClock(run.startedAt)];
  if (run.status === "running") parts.push(`已跑 ${formatCountdown(nowMs - run.startedAt)}`);
  if (run.sessionId) parts.push(`会话 ${run.sessionId}`);
  if (run.summary) {
    const s = run.summary.replace(/\s+/g, " ");
    parts.push(s.length > 30 ? `${s.slice(0, 29)}…` : s);
  }
  return parts.join(" · ");
}

/**
 * 后台任务的轮次行：运行中**全部**列出（并发下每轮都要看得见）；
 * 已完成只列最近 BG_HISTORY_DISPLAY 条，更早的折成一行计数
 * （历史本身全量在 loop-run-v1 条目里，这里只是展示口径）。
 */
export function formatBgRunLines(t: LoopTask, nowMs: number): string[] {
  const runs = t.runs;
  if (!runs || runs.length === 0) return [];
  const running = runs.filter((r) => r.status === "running");
  const finished = runs.filter((r) => r.status !== "running");
  const shown = finished.slice(-BG_HISTORY_DISPLAY);
  const hidden = finished.length - shown.length;
  const lines: string[] = [];
  if (hidden > 0) lines.push(`└ 更早 ${hidden} 轮`);
  lines.push(...shown.map((r) => formatRunLine(r, nowMs)));
  lines.push(...running.map((r) => formatRunLine(r, nowMs)));
  return lines;
}

/** /loop:list 与裸 /loop 的任务列表行，按触发先后排序 */
export function formatTaskLines(tasks: LoopTask[], nowMs: number): string[] {
  const sorted = [...tasks].sort((a, b) => a.nextDueAt - b.nextDueAt);
  return sorted.flatMap((t) => {
    const schedule = t.paused ? "⏸ 已暂停" : `${describeRecurrence(t)}${t.model ? `@${t.model}` : ""}`;
    const next = t.paused ? "—" : formatClock(t.nextDueAt);
    const taskText = t.task.length > 40 ? `${t.task.slice(0, 39)}…` : t.task;
    const badge = t.background ? "[后台] " : "";
    const line = `${t.id}  ${badge}${schedule}  ${next}  ${taskText}`;
    return [line, ...(t.background ? formatBgRunLines(t, nowMs) : [])];
  });
}
