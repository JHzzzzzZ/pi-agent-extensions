/**
 * todo-cli/store.ts — 结构化索引存储层（node:sqlite）
 *
 * L14 持久化改造的落点：`todos/*.md` 仍是唯一权威（markdown 权威 + DB 派生索引），
 * DB 只是 per-checkout 的结构化索引与跨进程写协调层。本模块负责：
 *   - 打开/创建 `<root>/todos/.todo-cli/index.db`（schema 私有，PRAGMA WAL + busy_timeout）；
 *   - 串行临界区 `writeTxn`（BEGIN IMMEDIATE / COMMIT / ROLLBACK）；
 *   - markdown → 行级 upsert（`reimportFile`，时间戳按归一化文本迁移）；
 *   - stat 漂移检测（`driftedFiles`）与文件原子写（`atomicWriteFile`）。
 *
 * 与 core.ts 是函数级循环 import（W4 接线后）：本模块只 import core 的
 * parseTodoFile/normalizeText，且在函数体内调用——双方顶层均不得调用对方导出，
 * ESM live binding 下安全。与 migrate.ts 方向固定：migrate → store，store 不反向 import。
 *
 * 红线（10-design §1.1/§1.4）：零 npm 依赖、只用 node:*；node:sqlite 实验面失败一律降级；
 * ExperimentalWarning 在首次触库前压制（removeAllListeners 后注册自家监听，
 * 只吞 sqlite 实验警告，其余 console.error 转发保底）。
 *
 * 边界：本模块不写任何 `.md`（写文件由上层 core 负责），不做重建/回滚编排（migrate.ts）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

import { normalizeText, parseTodoFile } from "./core.ts";

/** 注入时钟：返回 ISO 8601 UTC 字符串（如 2026-09-11T09:45:00.000Z）；测试注入固定值保证确定性。 */
export type NowFn = () => string;

/** 单个 markdown 文件的 fs.stat 摘要（driftedFiles 的输入）。 */
export interface FileStat {
  name: string;
  size: number;
  mtimeMs: number;
}

/** entries 表的一行（时间戳为 DB 列值；markdown 派生路径下为 null）。 */
export interface EntryRow {
  file: string;
  line: number;
  status: "open" | "processing" | "done";
  text: string;
  claimedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

/** 存储句柄：打开即完成建目录/建表/PRAGMA；调用方负责 close。 */
export interface TodoStore {
  /**
   * 串行临界区：BEGIN IMMEDIATE → fn() → COMMIT；fn 抛错 ROLLBACK 后重抛。
   * 取锁 busy 时有界重试（只重试 BEGIN，绝不重跑 fn——fn 有写文件等副作用）。
   */
  writeTxn<T>(fn: () => T): T;
  /** 全量条目行（file/line 升序）。 */
  listEntryRows(): EntryRow[];
  /** stat 与 files 表不一致（或无记录）的文件 name 列表；磁盘有而表无 → 也算漂移。 */
  driftedFiles(stats: FileStat[]): string[];
  /**
   * markdown → 行级 upsert：
   * 先按 normalizeText 迁移该文件旧行时间戳（同文本多行取行号最近者），
   * DELETE 该文件旧行 → 重插 parseTodoFile 行；files 表登记 fs.statSync(todos/<name>.md)。
   * 文件已删（stat 失败）→ 该文件行清空、stat 记 size=-1/mtimeMs=0。
   */
  reimportFile(name: string, content: string, now: NowFn): void;
  /**
   * 按 (file, normalizeText) 给行打时间戳；归一化文本唯一命中才写。
   * 命中返回 true；未命中或歧义（归一化后同文本多条）返回 false——绝不猜行。
   */
  stampEntry(file: string, normalizedText: string, field: "claimedAt" | "completedAt", now: string): boolean;
  close(): void;
}

// ---------------------------------------------------------------------------
// node:sqlite 的最小结构类型（实验 API 只用 exec/prepare/run/get/all + close）
// ---------------------------------------------------------------------------

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null | undefined;

/**
 * 惰性加载 node:sqlite（createRequire 同步加载，保持 main 同步签名）。
 * 返回 null = 本进程 node:sqlite 不可用（调用方走 markdown 降级路径）。
 *
 * 首次调用前压制 ExperimentalWarning（设计 §1.1 已实证）：默认 warning 监听器由
 * bootstrap 注册，`process.on` 只会追加（默认处理器仍打印），必须先
 * `removeAllListeners("warning")` 再注册自家监听；只吞 sqlite 实验警告，
 * 其余警告 console.error 转发保底。惰性执行：不触库的命令不装监听、不受影响。
 *
 * 注：这是 store/migrate 共用的内部辅助导出（不属于 10-design §3.2 冻结面）。
 */
export function loadSqliteModule(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;
  suppressSqliteExperimentalWarning();
  try {
    const require = createRequire(import.meta.url);
    sqliteModule = require("node:sqlite") as SqliteModule;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

function suppressSqliteExperimentalWarning(): void {
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    const message = warning instanceof Error ? warning.message : String(warning);
    if (warning.name === "ExperimentalWarning" && /sqlite/i.test(message)) return;
    console.error(warning);
  });
}

// ---------------------------------------------------------------------------
// schema 与路径
// ---------------------------------------------------------------------------

/** schema 私有，仅本模块可见（10-design §3.2 字节级固定）。 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(
  name TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries(
  file TEXT NOT NULL, line INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','processing','done')),
  text TEXT NOT NULL, created_at TEXT, claimed_at TEXT, completed_at TEXT,
  PRIMARY KEY(file, line));
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
`;

const LIST_ROWS_SQL = `SELECT file, line, status, text,
  created_at AS createdAt, claimed_at AS claimedAt, completed_at AS completedAt
  FROM entries ORDER BY file, line`;

/** 索引目录：`<root>/todos/.todo-cli`（纯派生物，W5 统一 gitignore，不入库）。 */
export function storeDir(repoRoot: string): string {
  return path.join(repoRoot, "todos", ".todo-cli");
}

/** 索引文件：`<root>/todos/.todo-cli/index.db`。 */
export function storeFile(repoRoot: string): string {
  return path.join(storeDir(repoRoot), "index.db");
}

// ---------------------------------------------------------------------------
// 打开 / 降级 / 损坏自愈
// ---------------------------------------------------------------------------

/** 打开库的锁等待上限（ms）：内核 timeout 与 PRAGMA busy_timeout 同值。 */
const BUSY_TIMEOUT_MS = 5000;
/** busy 重试总 deadline（ms）：用尽才返回 null 降级，保证调用方有界等待而非无限挂起。 */
const BUSY_RETRY_DEADLINE_MS = 30_000;
/** busy 重试的同步退避间隔（ms）。 */
const BUSY_RETRY_DELAY_MS = 100;

/**
 * 打开或创建索引库（建目录、建表、PRAGMA busy_timeout/WAL）。
 * 返回 null：node:sqlite 不可用（SQLITE_UNAVAILABLE，上层降级），
 * 或库损坏（打开/建表抛非 busy 错 → 关连接后挪 index.db 为 index.db.corrupt，覆盖旧 .corrupt，
 * 并清掉 WAL/SHM 伴生文件，本次返回 null、下次 open 自动重建）。
 *
 * 并发写者持锁（SQLITE_BUSY=5 / SQLITE_LOCKED=6）不是损坏：不 quarantine、不降级，
 * 内核 timeout 等待 + 退避重试（总 deadline BUSY_RETRY_DEADLINE_MS），成功即正常打开；
 * 只有 deadline 用尽才返回 null。
 */
export function openTodoStore(repoRoot: string): TodoStore | null {
  const sqlite = loadSqliteModule();
  if (!sqlite) return null;

  const file = storeFile(repoRoot);
  const deadline = Date.now() + BUSY_RETRY_DEADLINE_MS;
  for (;;) {
    const attempt = openStoreAttempt(sqlite, repoRoot, file);
    if (attempt.kind === "ok") return makeStore(repoRoot, attempt.db);
    if (attempt.kind === "corrupt") {
      quarantineCorruptDb(file);
      return null;
    }
    // busy：写者持锁（不是损坏）——等待是首选，deadline 用尽才降级。
    if (Date.now() >= deadline) return null;
    sleepSync(BUSY_RETRY_DELAY_MS);
  }
}

type OpenAttempt = { kind: "ok"; db: SqliteDatabase } | { kind: "busy" } | { kind: "corrupt" };

/** 单次 open 尝试：busy 错误原样上报重试循环，其余错误按损坏处理。 */
function openStoreAttempt(sqlite: SqliteModule, repoRoot: string, file: string): OpenAttempt {
  let db: SqliteDatabase | null = null;
  try {
    fs.mkdirSync(storeDir(repoRoot), { recursive: true });
    // timeout 让构造期也等待锁；PRAGMA busy_timeout 必须在 journal_mode 之前，
    // 否则持锁写者会让 journal_mode/schema 在设置 busy_timeout 之前就报 busy。
    db = new sqlite.DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1')").run();
    return { kind: "ok", db };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // 关连接失败不阻断重试/隔离
    }
    return isSqliteBusy(error) ? { kind: "busy" } : { kind: "corrupt" };
  }
}

/** SQLITE_BUSY(5)/SQLITE_LOCKED(6)：并发争锁，不是损坏——绝不 quarantine。 */
function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (errcode === 5 || errcode === 6) return true;
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(
    String((error as { message?: unknown }).message ?? ""),
  );
}

/** 同步退避（open/writeTxn 都是同步 API）：Atomics.wait 阻塞等待，不引入异步签名。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 损坏库隔离：挪为 .corrupt 留证（覆盖旧件），清 WAL/SHM 避免新库误恢复旧日志。 */
function quarantineCorruptDb(file: string): void {
  try {
    fs.rmSync(`${file}.corrupt`, { force: true });
  } catch {
    // 旧 .corrupt 删不掉也不影响主文件隔离
  }
  try {
    fs.renameSync(file, `${file}.corrupt`);
  } catch {
    // 文件不存在/被占用：下次 open 仍会尝试自愈
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true });
    } catch {
      // 伴生文件清理失败不阻断
    }
  }
}

// ---------------------------------------------------------------------------
// store 实现
// ---------------------------------------------------------------------------

function makeStore(repoRoot: string, db: SqliteDatabase): TodoStore {
  return {
    writeTxn(fn) {
      beginImmediateWithRetry(db);
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // 回滚失败时保留原始异常（连接状态交给调用方处理）
        }
        throw error;
      }
    },

    listEntryRows() {
      return db.prepare(LIST_ROWS_SQL).all().map(toEntryRow);
    },

    driftedFiles(stats) {
      const drifted: string[] = [];
      const getStat = db.prepare("SELECT size, mtime_ms FROM files WHERE name = ?");
      for (const stat of stats) {
        const row = getStat.get(stat.name);
        if (!row || Number(row.size) !== stat.size || Number(row.mtime_ms) !== stat.mtimeMs) drifted.push(stat.name);
      }
      return drifted;
    },

    reimportFile(name, content, now) {
      const oldRows = db
        .prepare("SELECT line, text, created_at, claimed_at, completed_at FROM entries WHERE file = ? ORDER BY line")
        .all(name)
        .map((row) => ({
          line: Number(row.line),
          normalized: normalizeText(String(row.text)),
          createdAt: optionalText(row.created_at),
          claimedAt: optionalText(row.claimed_at),
          completedAt: optionalText(row.completed_at),
        }));
      const byText = new Map<string, typeof oldRows>();
      for (const row of oldRows) {
        const bucket = byText.get(row.normalized);
        if (bucket) bucket.push(row);
        else byText.set(row.normalized, [row]);
      }

      const importedAt = now();
      const stat = statTodoFile(repoRoot, name);
      if (stat.size === -1) {
        // 文件已删：行清空（传入 content 不再有意义），stat 记 size=-1/mtimeMs=0
        db.prepare("DELETE FROM entries WHERE file = ?").run(name);
        db.prepare("INSERT OR REPLACE INTO files(name, size, mtime_ms, updated_at) VALUES (?, ?, ?, ?)").run(
          name,
          -1,
          0,
          importedAt,
        );
        return;
      }

      db.prepare("DELETE FROM entries WHERE file = ?").run(name);
      const insert = db.prepare(
        "INSERT INTO entries(file, line, status, text, created_at, claimed_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const entry of parseTodoFile(content)) {
        const old = nearestLine(byText.get(normalizeText(entry.text)), entry.line);
        insert.run(
          name,
          entry.line,
          entry.status,
          entry.text,
          old ? old.createdAt : importedAt,
          old ? old.claimedAt : null,
          old ? old.completedAt : null,
        );
      }
      db.prepare("INSERT OR REPLACE INTO files(name, size, mtime_ms, updated_at) VALUES (?, ?, ?, ?)").run(
        name,
        stat.size,
        stat.mtimeMs,
        importedAt,
      );
    },

    stampEntry(file, normalizedText, field, now) {
      const column = field === "claimedAt" ? "claimed_at" : "completed_at";
      const candidates = db
        .prepare("SELECT line, text FROM entries WHERE file = ? ORDER BY line")
        .all(file)
        .filter((row) => normalizeText(String(row.text)) === normalizedText);
      if (candidates.length !== 1) return false;
      db.prepare(`UPDATE entries SET ${column} = ? WHERE file = ? AND line = ?`).run(now, file, Number(candidates[0].line));
      return true;
    },

    close() {
      db.close();
    },
  };
}

/** BEGIN IMMEDIATE 的 busy 有界重试：只重试取锁本身（不重跑 fn，避免副作用二次执行）。 */
function beginImmediateWithRetry(db: SqliteDatabase): void {
  const deadline = Date.now() + BUSY_RETRY_DEADLINE_MS;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      sleepSync(BUSY_RETRY_DELAY_MS);
    }
  }
}

function toEntryRow(row: Record<string, unknown>): EntryRow {
  return {
    file: String(row.file),
    line: Number(row.line),
    status: row.status as EntryRow["status"],
    text: String(row.text),
    claimedAt: optionalText(row.claimedAt),
    completedAt: optionalText(row.completedAt),
    createdAt: optionalText(row.createdAt),
  };
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** 同归一化文本多行时取行号最近者；无候选返回 null。 */
function nearestLine(rows: Array<{ line: number }> | undefined, line: number): { line: number } | null {
  let best: { line: number } | null = null;
  for (const row of rows ?? []) {
    if (best === null || Math.abs(row.line - line) < Math.abs(best.line - line)) best = row;
  }
  return best;
}

/** 读 markdown 文件的 stat；文件不存在/不可读 → size=-1/mtimeMs=0（reimportFile 的删除信号）。 */
function statTodoFile(repoRoot: string, name: string): { size: number; mtimeMs: number } {
  try {
    const st = fs.statSync(path.join(repoRoot, "todos", `${name}.md`));
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { size: -1, mtimeMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// 原子写
// ---------------------------------------------------------------------------

const TMP_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * 原子写：同目录临时文件 `<file>.<pid>.<rand>.tmp` → fs.renameSync 覆盖（Windows 已实证可覆盖）。
 * 写前清理同目录 mtime 超过 10 分钟的 `*.tmp` 崩溃残留；新鲜 .tmp 不动（可能属于并发写者）。
 * 写/改名失败时清掉自己的临时文件再重抛。
 */
export function atomicWriteFile(file: string, content: string): void {
  const dir = path.dirname(file);
  cleanupStaleTmp(dir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
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

function cleanupStaleTmp(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - TMP_MAX_AGE_MS;
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
