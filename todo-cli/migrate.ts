/**
 * todo-cli/migrate.ts — 索引迁移编排（状态探测 / 全量重建 / 回滚）
 *
 * 设计（10-design §1.3/§1.4/§3.3）：迁移不写任何 `.md`（可逆性 = 结构性保证）；
 * 回滚 = dropStore 删索引文件，CLI 回到纯 markdown 行为（降级与回滚是同一条路径）。
 * 本模块是 docs 与 CLI 的桥：dbStatus 只读探测（无副作用），rebuildStore 幂等全量导入，
 * dropStore 幂等清场。方向固定：migrate → store，不反向 import。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadSqliteModule, openTodoStore, storeDir, storeFile } from "./store.ts";
import type { NowFn } from "./store.ts";

export type DbUnavailableReason = "NO_DB" | "SQLITE_UNAVAILABLE" | "CORRUPT";

export interface DbStatusInfo {
  available: boolean;
  reason: DbUnavailableReason | null;
  files: number;
  entries: number;
  schemaVersion: number | null;
}

function unavailable(reason: DbUnavailableReason): DbStatusInfo {
  return { available: false, reason, files: 0, entries: 0, schemaVersion: null };
}

/**
 * 只读探测：不创建库文件（storeFile 不存在 → NO_DB）；node:sqlite 不可用 → SQLITE_UNAVAILABLE；
 * 打开即抛 → CORRUPT（不挪文件，探测无副作用）。
 */
export function dbStatus(repoRoot: string): DbStatusInfo {
  const file = storeFile(repoRoot);
  if (!fs.existsSync(file)) return unavailable("NO_DB");
  const sqlite = loadSqliteModule();
  if (!sqlite) return unavailable("SQLITE_UNAVAILABLE");

  let db = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const entriesRow = db.prepare("SELECT COUNT(*) AS n FROM entries").get();
    const filesRow = db.prepare("SELECT COUNT(DISTINCT file) AS n FROM entries").get();
    const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return {
      available: true,
      reason: null,
      files: filesRow ? Number(filesRow.n) : 0,
      entries: entriesRow ? Number(entriesRow.n) : 0,
      schemaVersion: versionRow ? Number(versionRow.value) : null,
    };
  } catch {
    return unavailable("CORRUPT");
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // 只读探测的连接关闭失败无需上报
      }
    }
  }
}

/**
 * 全量重建：逐 doc（{name, content}，name 无 .md）在 writeTxn 内 reimportFile。
 * 幂等（时间戳按归一化文本迁移保留）；不写任何 `.md`。
 * node:sqlite 不可用 → {ok:false, reason:"SQLITE_UNAVAILABLE"}；库损坏（openTodoStore 已隔离）
 * → {ok:false, reason:"CORRUPT"}，下一次 rebuild 自动重建。
 */
export function rebuildStore(
  repoRoot: string,
  docs: Array<{ name: string; content: string }>,
  now: NowFn,
): { ok: boolean; reason: DbUnavailableReason | null } {
  if (!loadSqliteModule()) return { ok: false, reason: "SQLITE_UNAVAILABLE" };
  const store = openTodoStore(repoRoot);
  if (!store) return { ok: false, reason: "CORRUPT" };
  try {
    store.writeTxn(() => {
      for (const doc of docs) store.reimportFile(doc.name, doc.content, now);
    });
    return { ok: true, reason: null };
  } finally {
    store.close();
  }
}

/** dropStore 的清理面：主库 + WAL/SHM 伴生文件 + 损坏留证。 */
const DROP_FILES = ["index.db", "index.db-wal", "index.db-shm", "index.db.corrupt"];

/**
 * 回滚：删 index.db / index.db-wal / index.db-shm / index.db.corrupt（存在才删）。
 * 返回 removed 相对 repoRoot 的路径列表（/ 分隔）；幂等，恒 {ok:true}——
 * 单个文件删除失败（如被占用）不阻断其它文件，removed 只记录实际删除项。
 */
export function dropStore(repoRoot: string): { ok: boolean; removed: string[] } {
  const removed: string[] = [];
  for (const name of DROP_FILES) {
    const file = path.join(storeDir(repoRoot), name);
    try {
      if (!fs.existsSync(file)) continue;
      fs.rmSync(file, { force: true });
      removed.push(path.relative(repoRoot, file).split(path.sep).join("/"));
    } catch {
      // 删除失败（占用/权限）不阻断其它文件
    }
  }
  return { ok: true, removed };
}
