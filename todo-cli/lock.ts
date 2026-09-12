/**
 * todo-cli/lock.ts — 跨进程写锁 + 原子写（方案 C 的并发安全原语，todos/todo-cli-todo.md:17）
 *
 * 为什么存在：markdown 时代的跨进程互斥由 node:sqlite 的 BEGIN IMMEDIATE 承担（L14）；
 * 方案 C 去掉 sqlite 后，读写互斥自研为每文件一把锁（L17「自研锁 stale/重入/中断释放」）：
 *   - 获取：`fs.openSync(lockPath, "wx")`（O_EXCL）原子创建，内容 `{pid, startedAt}`；
 *   - 忙：静默重试（100ms 退避 / deadline 上限）→ 用尽返回 LOCK_TIMEOUT（CLI exit 1
 *     静态消息，保住「stderr 恒空」契约）；
 *   - stale：锁内容损坏、pid 已死、或存活但超 stale 阈值 → 残留锁可被抢占
 *     （SIGKILL 中断的释放路径——进程被杀时任何 handler 都不会跑）；
 *   - 重入：同进程同文件直接放行（Node 单线程，进程内无竞争）；
 *   - 中断释放：installProcessHooks 在 exit/SIGINT/SIGTERM 时清自持锁（SIGKILL 除外，
 *     由 stale 抢占兜底）；钩子由 core.main 显式安装，本模块 import 无副作用。
 *
 * 原子写（atomicWriteFile）：temp+rename，temp 放 `todos/.todo-cli/tmp/`（同卷、已
 * gitignore，崩溃残留不脏工作区），写前清理 10 分钟过期的崩溃残留。
 *
 * 边界：本模块不解析 todo 内容、不关心业务；now/alive/sleep/deadlineMs/staleMs 可注入
 * 供测试确定性。锁目录固定 `todos/.todo-cli/locks/`（该目录整体 gitignore）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** 锁忙重试的退避间隔（ms）。 */
const LOCK_RETRY_DELAY_MS = 100;
/** 锁忙重试的默认总 deadline（ms）：有界等待，用尽即失败而非无限挂起。 */
const LOCK_DEADLINE_MS = 30_000;
/** 锁 stale 默认阈值（ms）：持锁者存活但超过该时长视为挂死残留，可抢占。 */
const LOCK_STALE_MS = 60_000;

export interface LockDeps {
  /** 墙钟毫秒（stale 判定与 deadline）；测试注入固定值。 */
  now?: () => number;
  /** pid 存活探测；默认 process.kill(pid, 0)。 */
  alive?: (pid: number) => boolean;
  /** 同步退避；默认 Atomics.wait。 */
  sleep?: (ms: number) => void;
  /** stale 阈值覆盖。 */
  staleMs?: number;
  /** busy 等待上限覆盖。 */
  deadlineMs?: number;
}

export type LockFailure = { ok: false; code: "LOCK_TIMEOUT"; message: string };

export const LOCK_TIMEOUT_MESSAGE = "todo 文件忙（锁被占用），请重试";

/** 运行时目录：`todos/.todo-cli/`（gitignore；锁与 tmp 的家，index.db 历史遗留也在此）。 */
export function runtimeDir(repoRoot: string): string {
  return path.join(repoRoot, "todos", ".todo-cli");
}

/** 锁文件路径：`todos/.todo-cli/locks/<名>.lock`。 */
export function lockFileFor(repoRoot: string, name: string): string {
  return path.join(runtimeDir(repoRoot), "locks", `${name}.lock`);
}

/** tmp 目录：`todos/.todo-cli/tmp/`。 */
export function tmpDirFor(repoRoot: string): string {
  return path.join(runtimeDir(repoRoot), "tmp");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LockContent {
  pid: number;
  startedAt: number;
}

function readStaleReason(lockPath: string, deps: Required<Pick<LockDeps, "now" | "alive">> & { staleMs: number }): "dead" | "corrupt" | "aged" | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null; // 锁刚好被释放/被别人抢占：按正常忙处理，下一轮重试
  }
  let content: LockContent;
  try {
    content = JSON.parse(raw) as LockContent;
  } catch {
    return "corrupt";
  }
  if (typeof content.pid !== "number" || typeof content.startedAt !== "number") return "corrupt";
  if (!deps.alive(content.pid)) return "dead";
  if (deps.now() - content.startedAt > deps.staleMs) return "aged";
  return null;
}

// ---------------------------------------------------------------------------
// 进程内持锁登记 + 中断释放钩子
// ---------------------------------------------------------------------------

/** 本进程当前持有的锁（key = lockPath）。重入判定与钩子清理都用它。 */
const heldLocks = new Map<string, string>();

let hooksInstalled = false;

function releaseAllHeld(): void {
  for (const lockPath of heldLocks.values()) {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // 释放失败不掩盖原始流程；残留由其他写者的 stale 抢占兜底
    }
  }
  heldLocks.clear();
}

/**
 * 安装中断释放钩子（exit / SIGINT / SIGTERM；幂等）。由 core.main 在 CLI 入口调用；
 * 库本身 import 无副作用，测试脚本可显式调用以验证 exit 释放。
 * SIGKILL 不经过任何钩子——残留锁由后续写者的 stale 抢占兜底。
 */
export function installProcessHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", releaseAllHeld);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      process.on(signal, () => {
        releaseAllHeld();
        process.exit(1);
      });
    } catch {
      // 个别环境对某些信号只读：跳过，残留由 stale 抢占兜底
    }
  }
}

// ---------------------------------------------------------------------------
// 获取 / 释放 / 临界区
// ---------------------------------------------------------------------------

/** 获取 `<name>.lock`；成功返回 release，忙到 deadline 返回失败。残留锁（stale）就地抢占。 */
export function acquireTodoLock(repoRoot: string, name: string, deps: LockDeps = {}): { ok: true; release: () => void } | LockFailure {
  const now = deps.now ?? (() => Date.now());
  const alive = deps.alive ?? defaultAlive;
  const sleep = deps.sleep ?? sleepSync;
  const staleMs = deps.staleMs ?? LOCK_STALE_MS;
  const deadlineMs = deps.deadlineMs ?? LOCK_DEADLINE_MS;
  const lockPath = lockFileFor(repoRoot, name);
  if (heldLocks.has(lockPath)) return { ok: true, release: () => {} }; // 重入：同进程单线程，无竞争
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const deadline = now() + deadlineMs;
  for (;;) {
    let created = false;
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now() }));
      } finally {
        fs.closeSync(fd);
      }
      created = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "EEXIST") throw error;
    }

    if (created) {
      heldLocks.set(lockPath, lockPath);
      return {
        ok: true,
        release: () => {
          if (heldLocks.delete(lockPath)) {
            try {
              fs.rmSync(lockPath, { force: true });
            } catch {
              // 删除失败留残留：后续写者 stale 抢占兜底
            }
          }
        },
      };
    }

    const stale = readStaleReason(lockPath, { now, alive, staleMs });
    if (stale !== null) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // 抢占删除失败（他人正好释放/接管）：下一轮 openSync 重新竞争
      }
      continue;
    }
    if (now() >= deadline) return { ok: false, code: "LOCK_TIMEOUT", message: LOCK_TIMEOUT_MESSAGE };
    sleep(LOCK_RETRY_DELAY_MS);
  }
}

/** 临界区：获取 → fn() → 释放（fn 抛错也释放，错误原样重抛给调用方）。 */
export function withTodoLock<T>(repoRoot: string, name: string, fn: () => T, deps: LockDeps = {}): { ok: true; value: T } | LockFailure {
  const acquired = acquireTodoLock(repoRoot, name, deps);
  if (!acquired.ok) return acquired;
  try {
    return { ok: true, value: fn() };
  } finally {
    acquired.release();
  }
}

// ---------------------------------------------------------------------------
// 原子写
// ---------------------------------------------------------------------------

const TMP_MAX_AGE_MS = 10 * 60 * 1000;

function cleanupStaleTmp(dir: string, now: () => number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = now() - TMP_MAX_AGE_MS;
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const target = path.join(dir, name);
    try {
      if (fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { force: true });
    } catch {
      // 并发写者刚改名/刚删除：跳过
    }
  }
}

/**
 * 原子写：先写 `<tmpDir>/<file 名>.<pid>.<rand>.tmp` 再 renameSync 覆盖目标（同卷才原子；
 * todo JSON 的 tmpDir 与目标同在仓库盘）。写前清理过期崩溃残留；新鲜 .tmp 不动
 * （可能属于并发写者）。写/改名失败清掉自己的临时文件再重抛。
 */
export function atomicWriteFile(file: string, content: string, opts: { tmpDir?: string; now?: () => number } = {}): void {
  const tmpDir = opts.tmpDir ?? path.dirname(file);
  const now = opts.now ?? (() => Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  cleanupStaleTmp(tmpDir, now);
  const tmp = path.join(tmpDir, `${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 临时文件清理失败不掩盖原始异常
    }
    throw error;
  }
}
