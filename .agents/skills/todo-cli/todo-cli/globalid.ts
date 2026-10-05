/**
 * todo-cli/globalid.ts — 全局 id 计数器与全台账健康判定（todo-cli-todo:16 统一全局 id）
 *
 * 为什么存在：`todos/*.json` 的文件内 id 是 max+1（schema.ts nextId），跨文件重号——
 * 查重提示 / dependsOn 引用 / 对齐文档命名 / 合并冲突仲裁全靠 `文件#id` 复合键人肉消歧。
 * `globalId` 是**全台账唯一、永不回收**的统一主键：文件内 id 继续承担人类契约（展示/
 * 依赖/文档命名），globalId 只进 `list --json` 与机器判定（lint 查重、合并按 globalId 判同）。
 *
 * 计数器（todo-cli-todo:18 修订；数据契约见 docs/specs/todo-cli-global-id.md）：
 *   - 位置 = **git 公共目录**下 `<git-common-dir>/todo-cli/next-id`（`git rev-parse
 *     --git-common-dir`）：主工作区与所有 worktree 共享同一份号源；非 git 根（或
 *     repoRoot 不是仓库根，如 --root 指到仓库子目录）fail-soft 回退检出内的旧布局
 *     `todos/.todo-cli/next-id`。内容是**下一个待发号**（十进制 ASCII + LF）；
 *   - 只经 atomicWriteFile 原子写、只在**同目录**的 `locks/id.lock` 临界区内读改写
 *     （跨检出取号的唯一互斥点；锁名 "id" 复用 lock.ts 的 O_EXCL/stale/重入全套语义，
 *     零新锁代码）——锁跟着计数器走：只挪计数器会让并发取号失去互斥；
 *   - 发号下界 = `max(计数器现值, 旧布局计数器现值, 全台账(条目 id, globalId) 最大值 + 1)`：
 *     台账对齐负责「与另一 clone/分支合并进来的号」（共享目录治不了跨 clone），旧文件
 *     折叠负责「升级前已发过的号」（取 max，不忽略不报错）；计数器缺失时同一式子即自愈
 *     初始化（fresh clone 无计数器但 JSON 里有存量 globalId，只按文件内 id 会重发号撞车）；
 *   - 损坏（trim 后非纯数字 / 非正整数）fail-closed，提示删除该文件后重试（自愈重建）；
 *   - **只前进，永不回收**：complete/reopen 不归还；迁移中止/写盘失败烧掉的号留缺口。
 *
 * 锁序不变量（全库唯二嵌套点：core 的 runAdd 与 migrate 的两个迁移命令）：
 * 文件锁 → id 锁；不存在反向路径，无死锁窗口。本模块不 import core/migrate（无环）。
 *
 * 导出面：allocateGlobalId（取号）/ peekNextGlobalId（只读预看，dry-run 用）/ 
 * globalIdRuntimeDir + globalIdCounterFile + globalIdLockFile（共享布局路径，测试断言契约用）/ 
 * findGlobalIdProblems（lint + 迁移预检两个消费方）/ verifyGlobalIdMigration
 * （迁移/修复等价自检的可测内核，风格对应 from-md 的 roundTripEqual——比对方向是迁移前后快照）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { parseTodoJson } from "./schema.ts";
import type { TodoFileData } from "./schema.ts";
import { atomicWriteFile, runtimeDir, withTodoLock } from "./lock.ts";

/** 全局锁名：共享目录下 `locks/id.lock`（只护计数器读改写，不跨文件写持锁）。 */
const GLOBAL_ID_LOCK_NAME = "id";
/** 计数器文件名（共享目录下 `next-id`；旧布局在 `todos/.todo-cli/next-id`）。 */
const COUNTER_FILE_NAME = "next-id";
/** 共享目录名：`<git-common-dir>/todo-cli/`（计数器 + id 锁 + tmp 同居）。 */
const SHARED_DIR_NAME = "todo-cli";

const ID_COUNTER_CORRUPT_MESSAGE =
  "全局 id 计数器损坏：计数器文件不是正整数；删除该文件后重试将自愈重建";
const ID_LEDGER_UNREADABLE_MESSAGE =
  "全局 id 无法对齐台账：todos/ 下存在无法解析的文件；先修复或迁移后再取号";

/** 本模块消费的最小文档投影（core 的 LoadedDoc 结构上兼容，避免 import core 成环）。 */
export interface GlobalIdDoc {
  name: string;
  data: TodoFileData;
}

export type AllocateGlobalIdResult =
  | { ok: true; value: number }
  | { ok: false; code: "ID_COUNTER_CORRUPT" | "ID_LEDGER_UNREADABLE" | "LOCK_TIMEOUT"; message: string };

export type GlobalIdProblemCode = "GLOBAL_ID_MISSING" | "GLOBAL_ID_DUP";

export interface GlobalIdProblem {
  code: GlobalIdProblemCode;
  /** 人读细节：缺失 = `名#id`；重复 = `号（名甲#id甲 与 名乙#id乙）`。 */
  detail: string;
}

function counterFileIn(runtimeDirPath: string): string {
  return path.join(runtimeDirPath, COUNTER_FILE_NAME);
}

function lockFileIn(runtimeDirPath: string): string {
  return path.join(runtimeDirPath, "locks", `${GLOBAL_ID_LOCK_NAME}.lock`);
}

function tmpDirIn(runtimeDirPath: string): string {
  return path.join(runtimeDirPath, "tmp");
}

/** 路径规范化（realpath + win32 大小写折叠）：git 输出与调用方路径的形态差异不该被当“不同仓库”。 */
function canonicalDir(dir: string): string {
  let resolved = path.resolve(dir);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // 目录不存在/无权限：退回解析后的路径
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * git 公共目录（`git rev-parse --git-common-dir`，以 repoRoot 起）。
 * 快路径（零子进程，绝大多数调用）：repoRoot 没有 `.git` ⇒ 不是 git 检出根（含 --root 指普通
 * 目录、临时目录落在外层仓库内）→ null 回退；`.git` 是目录 ⇒ repoRoot 就是仓库根，公共目录
 * 即它自己。慢路径（链接工作区/子模块，`.git` 是指针文件）：交给 git 解析并核对
 * `--show-toplevel` 就是 repoRoot——否则会把号源错挪进别人的 `.git`。
 * 任何失败（非 git / git 不可用 / 输出异常）一律 null（fail-soft 回退旧路径）。
 */
export function resolveGitCommonDir(repoRoot: string): string | null {
  const dotGit = path.join(repoRoot, ".git");
  try {
    if (!fs.existsSync(dotGit)) return null;
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return null;
  }
  let stdout: string;
  try {
    stdout = execFileSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length < 2) return null;
  const [topLevel, commonDir] = lines;
  if (canonicalDir(topLevel) !== canonicalDir(repoRoot)) return null;
  return path.resolve(repoRoot, commonDir);
}

/**
 * 全局 id 运行时目录：git 仓库根 → `<git-common-dir>/todo-cli/`（主工作区与所有 worktree
 * 共享同一份号源与同一把 id 锁）；非 git 根 fail-soft 回退检出内的 `todos/.todo-cli/`。
 */
export function globalIdRuntimeDir(repoRoot: string): string {
  const commonDir = resolveGitCommonDir(repoRoot);
  return commonDir === null ? runtimeDir(repoRoot) : path.join(commonDir, SHARED_DIR_NAME);
}

/** 计数器文件：共享目录下 `next-id`（非 git 根回退旧路径）。导出面给测试断言布局契约。 */
export function globalIdCounterFile(repoRoot: string): string {
  return counterFileIn(globalIdRuntimeDir(repoRoot));
}

/** id 锁文件：与计数器**同目录**（锁跟着计数器走）。导出面给测试断言「同源」契约。 */
export function globalIdLockFile(repoRoot: string): string {
  return lockFileIn(globalIdRuntimeDir(repoRoot));
}

/** 旧布局计数器（升级前的位置，检出内）：只读折叠，不再写入。 */
function legacyCounterFile(repoRoot: string): string {
  return path.join(runtimeDir(repoRoot), COUNTER_FILE_NAME);
}

/** 计数器内容解析：纯十进制数字且 ≥ 1（trim 由调用方做，容忍行尾）。 */
function parseCounterValue(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

type CounterState = { state: "absent" } | { state: "ok"; value: number } | { state: "corrupt" };

function readCounterState(file: string): CounterState {
  if (!fs.existsSync(file)) return { state: "absent" };
  const value = parseCounterValue(fs.readFileSync(file, "utf8").trim());
  return value === null ? { state: "corrupt" } : { state: "ok", value };
}

/** 读 `todos/` 全部 JSON（按文件名排序）；任一损坏即失败（自愈扫描与迁移预检共用口径）。 */
function readGlobalIdDocs(repoRoot: string): { ok: true; docs: GlobalIdDoc[] } | { ok: false } {
  const dir = path.join(repoRoot, "todos");
  if (!fs.existsSync(dir)) return { ok: true, docs: [] };
  const docs: GlobalIdDoc[] = [];
  for (const fileName of fs.readdirSync(dir).sort()) {
    if (!fileName.endsWith(".json")) continue;
    const parsed = parseTodoJson(fs.readFileSync(path.join(dir, fileName), "utf8"), `todos/${fileName}`);
    if (!parsed.ok) return { ok: false };
    docs.push({ name: fileName.slice(0, -5), data: parsed.data });
  }
  return { ok: true, docs };
}

/** 全台账已用号下界：文件内 id 与 globalId 取最大（fresh clone 自愈不得与存量撞车）。 */
function maxExistingId(docs: readonly GlobalIdDoc[]): number {
  let max = 0;
  for (const doc of docs) {
    for (const entry of doc.data.entries) {
      if (entry.id > max) max = entry.id;
      if (entry.globalId !== null && entry.globalId > max) max = entry.globalId;
    }
  }
  return max;
}

/**
 * 发号下界（id 锁内调用）：max(共享计数器, 旧布局计数器, 全台账(条目 id, globalId) 最大值 + 1)。
 * 计数器损坏 fail-closed；旧布局计数器损坏视为缺失（它已不权威，台账对齐兜底）；
 * 台账不可解析时 fail-closed（不猜号）。
 */
function effectiveNextId(
  repoRoot: string,
  runtimeDirPath: string,
): { ok: true; value: number } | { ok: false; code: "ID_COUNTER_CORRUPT" | "ID_LEDGER_UNREADABLE"; message: string } {
  const shared = readCounterState(counterFileIn(runtimeDirPath));
  if (shared.state === "corrupt") return { ok: false, code: "ID_COUNTER_CORRUPT", message: ID_COUNTER_CORRUPT_MESSAGE };
  const legacy = readCounterState(legacyCounterFile(repoRoot));
  const loaded = readGlobalIdDocs(repoRoot);
  if (!loaded.ok) return { ok: false, code: "ID_LEDGER_UNREADABLE", message: ID_LEDGER_UNREADABLE_MESSAGE };
  const counterNext = Math.max(shared.state === "ok" ? shared.value : 0, legacy.state === "ok" ? legacy.value : 0);
  return { ok: true, value: Math.max(counterNext, maxExistingId(loaded.docs) + 1) };
}

/** 折叠旧布局计数器：值已纳入发号下界，清掉旧文件（删除失败不影响正确性——下次取号仍按 max 折叠）。 */
function foldLegacyCounter(repoRoot: string, counterFile: string): void {
  const legacy = legacyCounterFile(repoRoot);
  if (legacy === counterFile) return;
  try {
    fs.rmSync(legacy, { force: true });
  } catch {
    // 残留无害
  }
}

/**
 * 只读预看下一个待发号（零写盘零取号，dry-run 用）：与取号同口径（计数器/旧文件/台账取 max）。
 * 损坏 fail-closed——真实迁移会在这里取号，dry-run 报同样的错比假报成功诚实。
 */
export function peekNextGlobalId(
  repoRoot: string,
  docs: readonly GlobalIdDoc[],
): { ok: true; value: number } | { ok: false; code: "ID_COUNTER_CORRUPT"; message: string } {
  const runtimeDirPath = globalIdRuntimeDir(repoRoot);
  const shared = readCounterState(counterFileIn(runtimeDirPath));
  if (shared.state === "corrupt") return { ok: false, code: "ID_COUNTER_CORRUPT", message: ID_COUNTER_CORRUPT_MESSAGE };
  const legacy = readCounterState(legacyCounterFile(repoRoot));
  const counterNext = Math.max(shared.state === "ok" ? shared.value : 0, legacy.state === "ok" ? legacy.value : 0);
  return { ok: true, value: Math.max(counterNext, maxExistingId(docs) + 1) };
}

/**
 * 取一个全局 id：共享 id 锁内算发号下界 → 原子写 N+1 → 返回 N；计数器缺失即自愈初始化。
 * 唯一性的保证只在这里（文件锁不护它）——跨检出并发取号的全部安全性压在这把锁上。
 */
export function allocateGlobalId(repoRoot: string): AllocateGlobalIdResult {
  const runtimeDirPath = globalIdRuntimeDir(repoRoot);
  const counterFile = counterFileIn(runtimeDirPath);
  const locked = withTodoLock(
    repoRoot,
    GLOBAL_ID_LOCK_NAME,
    (): { ok: true; value: number } | { ok: false; code: "ID_COUNTER_CORRUPT" | "ID_LEDGER_UNREADABLE"; message: string } => {
      const next = effectiveNextId(repoRoot, runtimeDirPath);
      if (!next.ok) return next;
      atomicWriteFile(counterFile, `${next.value + 1}\n`, { tmpDir: tmpDirIn(runtimeDirPath) });
      foldLegacyCounter(repoRoot, counterFile);
      return { ok: true, value: next.value };
    },
    { lockDir: path.dirname(lockFileIn(runtimeDirPath)) },
  );
  return locked.ok ? locked.value : locked;
}

/**
 * 全台账 globalId 健康判定（纯函数）：缺失（未迁移）与重复（合并产物漏仲裁）各报一条。
 * 两个消费方：lint 的问题行与 migrate global-id 的迁移前预检。
 */
export function findGlobalIdProblems(docs: readonly GlobalIdDoc[]): GlobalIdProblem[] {
  const problems: GlobalIdProblem[] = [];
  const seen = new Map<number, { name: string; id: number }>();
  for (const doc of docs) {
    for (const entry of doc.data.entries) {
      if (entry.globalId === null) {
        problems.push({ code: "GLOBAL_ID_MISSING", detail: `${doc.name}#${entry.id}` });
        continue;
      }
      const first = seen.get(entry.globalId);
      if (first === undefined) {
        seen.set(entry.globalId, { name: doc.name, id: entry.id });
        continue;
      }
      problems.push({ code: "GLOBAL_ID_DUP", detail: `${entry.globalId}（${first.name}#${first.id} 与 ${doc.name}#${entry.id}）` });
    }
  }
  return problems;
}

/**
 * 迁移/修复等价自检（纯函数）：逐条目按数组序配对比对——标题不变、条目数不变、
 * 除 globalId 外全字段 zero 漂移、null 条目都取到正整数、新号在数组序内单调递增、
 * 既有非 null 号不被改写（reissued 里的条目例外——repair 重发号必须换成新正整数）。
 * 返回问题描述或 null（迁移/修复中止的唯一判定口）。
 */
export function verifyGlobalIdMigration(before: TodoFileData, after: TodoFileData, reissued: ReadonlySet<number> = new Set()): string | null {
  if (before.title !== after.title) return "title 漂移";
  if (before.entries.length !== after.entries.length) return "条目数变化";
  let previousAllocated = 0;
  for (let i = 0; i < before.entries.length; i += 1) {
    const oldEntry = before.entries[i];
    const newEntry = after.entries[i];
    const { globalId: oldGlobalId, ...oldRest } = oldEntry;
    const { globalId: newGlobalId, ...newRest } = newEntry;
    if (JSON.stringify(oldRest) !== JSON.stringify(newRest)) return `条目 #${i + 1} 字段漂移`;
    if (reissued.has(oldEntry.id)) {
      // repair 重发号：允许改写既有号，但必须真的换成正整数新号（其余检查与取号同款）。
      if (newGlobalId === oldGlobalId) return `条目 #${i + 1} 重发号与原号相同`;
    } else if (oldGlobalId !== null) {
      if (newGlobalId !== oldGlobalId) return `条目 #${i + 1} 既有 globalId 被改写`;
      continue;
    }
    if (typeof newGlobalId !== "number" || !Number.isInteger(newGlobalId) || newGlobalId < 1) {
      return `条目 #${i + 1} 未取到正整数 globalId`;
    }
    if (newGlobalId <= previousAllocated) return `条目 #${i + 1} 新号非单调递增`;
    previousAllocated = newGlobalId;
  }
  return null;
}
