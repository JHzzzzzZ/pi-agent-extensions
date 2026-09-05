/**
 * loop — 任务状态机（纯逻辑，时钟 nowMs 由调用方注入，便于测试）。
 *
 * 调度语义（对齐 Claude Code scheduled tasks）：
 *   - 错过的时间点不补跑，只触发一次
 *   - 一次性任务触发后自删
 *   - 重复任务创建 7 天后过期（到期则最后触发一次再删除）
 *   - 暂停的任务不触发；恢复时错过的循环间隔直接跳过
 */
import { formatInterval } from "./parse.ts";

export interface LoopTask {
  id: string;
  task: string;
  recurring: boolean;
  /** 循环间隔（recurring 时必有） */
  intervalMs?: number;
  /** 下次触发时刻（epoch ms） */
  nextDueAt: number;
  /** 创建时刻（epoch ms），7 天过期的起算点 */
  createdAt: number;
  paused: boolean;
}

export const MAX_TASKS = 50;
export const RECURRING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_INTERVAL_MS = 60_000;

export type CreateTaskInput = {
  task: string;
  recurring: boolean;
  intervalMs?: number;
  /** 首次触发时刻（epoch ms） */
  fireAtMs: number;
  nowMs: number;
};

export function createTask(
  tasks: LoopTask[],
  input: CreateTaskInput,
  genId: () => string,
): { ok: true; task: LoopTask } | { ok: false; message: string } {
  if (tasks.length >= MAX_TASKS) {
    return { ok: false, message: `已达上限（每会话最多 ${MAX_TASKS} 个任务），请先用 /loop delete 清理` };
  }
  const task: LoopTask = {
    id: genId(),
    task: input.task,
    recurring: input.recurring,
    intervalMs: input.recurring ? input.intervalMs : undefined,
    nextDueAt: input.fireAtMs,
    createdAt: input.nowMs,
    paused: false,
  };
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
  return { ok: false, message: `未找到任务 "${idOrPrefix}"，用 /loop list 查看现有任务` };
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

export function resumeTask(
  tasks: LoopTask[],
  idOrPrefix: string,
  nowMs: number,
): { ok: true; task: LoopTask } | { ok: false; message: string } {
  const r = resolveOrMessage(tasks, idOrPrefix);
  if (!r.ok) return r;
  r.task.paused = false;
  // 循环任务错过的间隔不补跑：暂停期间到期的直接排到下一个间隔之后
  if (r.task.recurring && r.task.nextDueAt <= nowMs) {
    r.task.nextDueAt = nowMs + (r.task.intervalMs ?? FALLBACK_INTERVAL_MS);
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
      const interval = t.intervalMs ?? FALLBACK_INTERVAL_MS;
      const missed = Math.floor((nowMs - t.nextDueAt) / interval) + 1;
      t.nextDueAt += missed * interval;
    } else {
      tasks.splice(i, 1);
    }
  }

  due.sort((a, b) => a.nextDueAt - b.nextDueAt);
  return { due, changed };
}

export type TaskSnapshot = { tasks: LoopTask[] };

export function serializeTasks(tasks: LoopTask[]): TaskSnapshot {
  return { tasks: tasks.map((t) => ({ ...t })) };
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
      if (t.nextDueAt <= nowMs) t.nextDueAt = nowMs + (t.intervalMs ?? FALLBACK_INTERVAL_MS);
    } else if (t.nextDueAt <= nowMs) {
      continue;
    }
    out.push(t);
  }
  return out;
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
  if (recurring && intervalMs === undefined) return undefined;
  return {
    id: r.id,
    task: r.task,
    recurring,
    intervalMs: recurring ? intervalMs : undefined,
    nextDueAt: r.nextDueAt,
    createdAt: r.createdAt,
    paused: r.paused === true,
  };
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

/** /loop list 与裸 /loop 的任务列表行，按触发先后排序 */
export function formatTaskLines(tasks: LoopTask[], nowMs: number): string[] {
  const sorted = [...tasks].sort((a, b) => a.nextDueAt - b.nextDueAt);
  return sorted.map((t) => {
    const schedule = t.paused
      ? "⏸ 已暂停"
      : t.recurring
        ? `每 ${formatInterval(t.intervalMs ?? FALLBACK_INTERVAL_MS)}`
        : "一次性";
    const next = t.paused ? "—" : formatClock(t.nextDueAt);
    const taskText = t.task.length > 40 ? `${t.task.slice(0, 39)}…` : t.task;
    return `${t.id}  ${schedule}  ${next}  ${taskText}`;
  });
}
