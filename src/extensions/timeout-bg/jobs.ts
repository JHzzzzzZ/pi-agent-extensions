/**
 * timeout-bg — 后台任务注册表（timeout-bg-todo#1）
 *
 * 只有「命中超时、被转入后台继续运行」的命令才进这里；正常结束的命令不进。
 * 状态机很小：running → exited（自然结束，触发一次完成通知）
 *                     → killed（用户 /kill 或会话关闭时杀掉，不通知）。
 *
 * 依赖注入：`now`（确定性时间）、`killTree`（进程树终止是进程边界，测试注入 fake）、
 * `onExit`（完成通知出口，由 index.ts 接到 pi.sendMessage）。
 */
import type { BackgroundJob } from "./shell-ops.ts";

/** 注册表条目：后台命令的可查询状态。 */
export interface JobRecord {
  id: string;
  /** 子进程 pid（spawn 失败时为 null）。 */
  pid: number | null;
  /** 命令首行（人类可读，列表用）。 */
  command: string;
  logPath: string;
  startedAtMs: number;
  endedAtMs: number | null;
  exitCode: number | null;
  status: "running" | "exited" | "killed";
}

export interface JobRegistryDeps {
  now: () => number;
  killTree: (pid: number) => void;
  /** 自然结束（非用户 kill）时回调一次。 */
  onExit: (job: JobRecord) => void;
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

  const registry: JobRegistry = {
    background(input) {
      const record: JobRecord = {
        id: input.id,
        pid: input.pid,
        command: input.command,
        logPath: input.logPath,
        startedAtMs: deps.now(),
        endedAtMs: null,
        exitCode: null,
        status: "running",
      };
      jobs.set(record.id, record);
      return record;
    },
    markExited(id, exitCode) {
      const job = jobs.get(id);
      if (!job || job.status !== "running") return;
      job.status = "exited";
      job.exitCode = exitCode;
      job.endedAtMs = deps.now();
      deps.onExit(job);
    },
    markKilled(id) {
      const job = jobs.get(id);
      if (!job || job.status !== "running") return;
      job.status = "killed";
      job.endedAtMs = deps.now();
    },
    kill(id) {
      const job = jobs.get(id);
      if (!job || job.status !== "running") return false;
      if (job.pid !== null) deps.killTree(job.pid);
      registry.markKilled(id);
      return true;
    },
    killAll() {
      let killed = 0;
      for (const job of jobs.values()) {
        if (job.status === "running") {
          if (job.pid !== null) deps.killTree(job.pid);
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
      return removed;
    },
  };

  return registry;
}
