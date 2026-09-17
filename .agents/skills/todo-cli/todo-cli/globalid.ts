/**
 * todo-cli/globalid.ts — 全局 id 计数器与全台账健康判定（todo-cli-todo:16 统一全局 id）
 *
 * 为什么存在：`todos/*.json` 的文件内 id 是 max+1（schema.ts nextId），跨文件重号——
 * 查重提示 / dependsOn 引用 / 对齐文档命名 / 合并冲突仲裁全靠 `文件#id` 复合键人肉消歧。
 * `globalId` 是**全台账唯一、永不回收**的统一主键：文件内 id 继续承担人类契约（展示/
 * 依赖/文档命名），globalId 只进 `list --json` 与机器判定（lint 查重、合并按 globalId 判同）。
 *
 * 计数器（数据契约见 docs/specs/todo-cli-global-id.md）：
 *   - 文件 `todos/.todo-cli/next-id`，内容是**下一个待发号**（十进制 ASCII + LF）；
 *   - 只经 atomicWriteFile 原子写、只在 `locks/id.lock` 临界区内读改写（跨文件取号的
 *     唯一互斥点；锁名 "id" 复用 lock.ts 的 O_EXCL/stale/重入全套语义，零新锁代码）；
 *   - 计数器被 gitignore（不入库）→ 文件缺失时**自愈初始化**为
 *     `max(全台账条目 id, 全台账条目 globalId, 0) + 1`——必须取两类字段的最大值：
 *     fresh clone 无计数器但 JSON 里有存量 globalId，只按文件内 id 会重发号撞车；
 *   - 损坏（trim 后非纯数字 / 非正整数）fail-closed，提示删除该文件后重试（自愈重建）；
 *   - **只前进，永不回收**：complete/reopen 不归还；迁移中止/写盘失败烧掉的号留缺口。
 *
 * 锁序不变量（全库唯二嵌套点：core 的 runAdd 与 migrate 的两个迁移命令）：
 * 文件锁 → id 锁；不存在反向路径，无死锁窗口。本模块不 import core/migrate（无环）。
 *
 * 导出面：allocateGlobalId（取号）/ peekNextGlobalId（只读预看，dry-run 用）/
 * findGlobalIdProblems（lint + 迁移预检两个消费方）/ verifyGlobalIdMigration
 * （迁移等价自检的可测内核，风格对应 from-md 的 roundTripEqual——比对方向是迁移前后快照）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { parseTodoJson } from "./schema.ts";
import type { TodoFileData } from "./schema.ts";
import { atomicWriteFile, runtimeDir, tmpDirFor, withTodoLock } from "./lock.ts";

/** 全局锁名：`todos/.todo-cli/locks/id.lock`（只护计数器读改写，不跨文件写持锁）。 */
const GLOBAL_ID_LOCK_NAME = "id";
/** 计数器文件名（`todos/.todo-cli/next-id`；该目录整体 gitignore，不入版本库）。 */
const COUNTER_FILE_NAME = "next-id";

const ID_COUNTER_CORRUPT_MESSAGE =
  "全局 id 计数器损坏：todos/.todo-cli/next-id 不是正整数；删除该文件后重试将自愈重建";
const ID_SELF_HEAL_FAILED_MESSAGE =
  "全局 id 计数器损坏：无法从台账推断下一个号（先修复或迁移 todos/ 下的文件）";

/** 本模块消费的最小文档投影（core 的 LoadedDoc 结构上兼容，避免 import core 成环）。 */
export interface GlobalIdDoc {
  name: string;
  data: TodoFileData;
}

export type AllocateGlobalIdResult =
  | { ok: true; value: number }
  | { ok: false; code: "ID_COUNTER_CORRUPT" | "LOCK_TIMEOUT"; message: string };

export type GlobalIdProblemCode = "GLOBAL_ID_MISSING" | "GLOBAL_ID_DUP";

export interface GlobalIdProblem {
  code: GlobalIdProblemCode;
  /** 人读细节：缺失 = `名#id`；重复 = `号（名甲#id甲 与 名乙#id乙）`。 */
  detail: string;
}

function counterFileFor(repoRoot: string): string {
  return path.join(runtimeDir(repoRoot), COUNTER_FILE_NAME);
}

/** 计数器内容解析：纯十进制数字且 ≥ 1（trim 由调用方做，容忍行尾）。 */
function parseCounterValue(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
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
 * 只读预看下一个待发号（零写盘零取号，dry-run 用）：计数器在场取现值，缺失走自愈初值。
 * 损坏 fail-closed——真实迁移会在这里取号，dry-run 报同样的错比假报成功诚实。
 */
export function peekNextGlobalId(
  repoRoot: string,
  docs: readonly GlobalIdDoc[],
): { ok: true; value: number } | { ok: false; code: "ID_COUNTER_CORRUPT"; message: string } {
  const counterFile = counterFileFor(repoRoot);
  if (!fs.existsSync(counterFile)) return { ok: true, value: maxExistingId(docs) + 1 };
  const value = parseCounterValue(fs.readFileSync(counterFile, "utf8").trim());
  if (value === null) return { ok: false, code: "ID_COUNTER_CORRUPT", message: ID_COUNTER_CORRUPT_MESSAGE };
  return { ok: true, value };
}

/**
 * 取一个全局 id：id 锁内读计数器 → 原子写 N+1 → 返回 N。计数器缺失时自愈初始化。
 * 唯一性的保证只在这里（文件锁不护它）——跨文件并发取号的全部安全性压在这把锁上。
 */
export function allocateGlobalId(repoRoot: string): AllocateGlobalIdResult {
  const counterFile = counterFileFor(repoRoot);
  const locked = withTodoLock(
    repoRoot,
    GLOBAL_ID_LOCK_NAME,
    (): { ok: true; value: number } | { ok: false; code: "ID_COUNTER_CORRUPT"; message: string } => {
      let next: number;
      if (fs.existsSync(counterFile)) {
        const value = parseCounterValue(fs.readFileSync(counterFile, "utf8").trim());
        if (value === null) return { ok: false, code: "ID_COUNTER_CORRUPT", message: ID_COUNTER_CORRUPT_MESSAGE };
        next = value;
      } else {
        const loaded = readGlobalIdDocs(repoRoot);
        if (!loaded.ok) return { ok: false, code: "ID_COUNTER_CORRUPT", message: ID_SELF_HEAL_FAILED_MESSAGE };
        next = maxExistingId(loaded.docs) + 1;
      }
      atomicWriteFile(counterFile, `${next + 1}\n`, { tmpDir: tmpDirFor(repoRoot) });
      return { ok: true, value: next };
    },
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
 * 迁移等价自检（纯函数）：逐条目按数组序配对比对——标题不变、条目数不变、
 * 除 globalId 外全字段 zero 漂移、null 条目都取到正整数、新号在数组序内单调递增、
 * 既有非 null 号不被改写。返回问题描述或 null（迁移中止的唯一判定口）。
 */
export function verifyGlobalIdMigration(before: TodoFileData, after: TodoFileData): string | null {
  if (before.title !== after.title) return "title 漂移";
  if (before.entries.length !== after.entries.length) return "条目数变化";
  let previousAllocated = 0;
  for (let i = 0; i < before.entries.length; i += 1) {
    const oldEntry = before.entries[i];
    const newEntry = after.entries[i];
    const { globalId: oldGlobalId, ...oldRest } = oldEntry;
    const { globalId: newGlobalId, ...newRest } = newEntry;
    if (JSON.stringify(oldRest) !== JSON.stringify(newRest)) return `条目 #${i + 1} 字段漂移`;
    if (oldGlobalId !== null) {
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
