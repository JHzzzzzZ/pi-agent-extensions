/**
 * timeout-bg — 后台任务注册表（timeout-bg-todo#1 / #5）
 *
 * 进这里的是「转入后台继续运行」的命令：命中超时的（`origin: "timeout"`）与调用方主动
 * 要求后台的（`origin: "background"`，timeout-bg-todo#5）；正常前台结束的命令不进。
 * 状态机很小：running → exited（自然结束，触发一次完成通知）
 *                     → killed（用户 /kill 或会话关闭时杀掉，不通知）。
 *
 * 依赖注入：`now`（确定性时间）、`killTree`（进程树终止是进程边界，测试注入 fake）、
 * `onExit`（完成通知出口，由 index.ts 接到 pi.sendMessage）。
 */
import type { BackgroundJob, JobOrigin } from "./shell-ops.ts";

/** 注册表条目：后台命令的可查询状态。 */
export interface JobRecord {
  id: string;
  /** 子进程 pid（spawn 失败时为 null）；远端 job 为 null（本地只有 ssh 进程，见 terminate）。 */
  pid: number | null;
  /** 命令首行（人类可读，列表用）。 */
  command: string;
  logPath: string;
  /** 远端 job 的目标主机（展示用；本地 job 为 undefined）。 */
  target?: string | undefined;
  /** 来源：命中超时 / 调用方主动要求（`/bg` 列表里的 `[超时]` / `[后台]`）。 */
  origin: JobOrigin;
  startedAtMs: number;
  endedAtMs: number | null;
  exitCode: number | null;
  status: "running" | "exited" | "killed";
  /**
   * 远端 job 的终止钩子（由提供方自带：尽力杀远端进程组 + 断开本地 ssh）。
   * 本地 job 为 undefined ⇒ 走 `killTree(pid)`。 */
  terminate?: (() => void) | undefined;
}

export interface JobRegistryDeps {
  now: () => number;
  killTree: (pid: number) => void;
  /** 自然结束（非用户 kill）时回调一次。 */
  onExit: (job: JobRecord) => void;
  /** 状态发生变化（新增/结束/被杀/清理）时回调，供状态条段等观察者刷新。 */
  onChange?: (() => void) | undefined;
}

export interface JobRegistry {
  background(input: BackgroundJob): JobRecord;
  markExited(id: string, exitCode: number | null): void;
  markKilled(id: string): void;
  kill(id: string): boolean;
  killAll(): number;
  get(id: string): JobRecord | undefined;
  list(): JobRecord[];
  running(): JobRecord[];
  /** 清掉已结束的记录，返回清除条数。 */
  clear(): number;
}

export function createJobRegistry(deps: JobRegistryDeps): JobRegistry {
  const jobs = new Map<string, JobRecord>();

  const notifyChanged = (): void => {
    if (deps.onChange === undefined) return;
    try {
      deps.onChange();
    } catch {
      /* 观察者异常不影响注册表本身（UI 隔离） */
    }
  };

  /** 终止一个运行中的 job：远端 job 走自带钩子（尽力杀远端 + 断开 ssh），本地 job 走 killTree。 */
  const terminateJob = (job: JobRecord): void => {
    if (job.terminate !== undefined) {
      try {
        job.terminate();
      } catch {
        /* 尽力而为：终止失败不能破坏命令面 */
      }
      return;
    }
    if (job.pid !== null) deps.killTree(job.pid);
  };

  const registry: JobRegistry = {
    background(input) {
      const record: JobRecord = {
        id: input.id,
        pid: input.pid,
        command: input.command,
        logPath: input.logPath,
        target: input.target,
        origin: input.origin ?? "timeout",
        startedAtMs: deps.now(),
        endedAtMs: null,
        exitCode: null,
        status: "running",
        terminate: input.terminate,
      };
      jobs.set(record.id, record);
      notifyChanged();
      return record;
    },
    markExited(id, exitCode) {
      const job = jobs.get(id);
      if (!job || job.status !== "running") return;
      job.status = "exited";
      job.exitCode = exitCode;
      job.endedAtMs = deps.now();
      notifyChanged();
      deps.onExit(job);
    },
    markKilled(id) {
      const job = jobs.get(id);
      if (!job || job.status !== "running") return;
      job.status = "killed";
      job.endedAtMs = deps.now();
      notifyChanged();
    },
    kill(id) {
      const job = jobs.get(id);
      if (!job || job.status !== "running") return false;
      terminateJob(job);
      registry.markKilled(id);
      return true;
    },
    killAll() {
      let killed = 0;
      for (const job of jobs.values()) {
        if (job.status === "running") {
          terminateJob(job);
          registry.markKilled(job.id);
          killed += 1;
        }
      }
      return killed;
    },
    get: (id) => jobs.get(id),
    list: () => [...jobs.values()].sort((a, b) => b.startedAtMs - a.startedAtMs),
    running: () => registry.list().filter((job) => job.status === "running"),
    clear() {
      let removed = 0;
      for (const [id, job] of jobs) {
        if (job.status !== "running") {
          jobs.delete(id);
          removed += 1;
        }
      }
      if (removed > 0) notifyChanged();
      return removed;
    },
  };

  return registry;
}
