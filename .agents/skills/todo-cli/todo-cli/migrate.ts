/**
 * todo-cli/migrate.ts — markdown ↔ JSON 双向迁移（方案 C，todos/todo-cli-todo.md:17）
 *
 * 两个方向、两种定位：
 *   - `migrate from-md`（一次性权威切换）：todos/*.md → todos/*.json，等价自检通过后
 *     删除 md 与遗留 node:sqlite 索引（todos/.todo-cli/index.db*）。自检 = 逐文件
 *     「渲染 → 再解析 → 再构建」与首次构建 deepEqual（文本/状态/分支/注记零丢失），
 *     任何文件不过关就整体中止、一个字节都不写；落盘时每文件锁内逐条取全局 id，
 *     一步到位产 v4 完备台账（不产生 v3 中间态）。
 *   - `migrate to-md`（常驻逃生回滚，不是视图）：todos/*.json → 规范形态 md（条目 +
 *     `（aligning|aligned|processing…）`标记 + 注记作缩进子行），JSON 保留不动；配合 git
 *     历史里的旧版 CLI 即可回到纯 markdown 工作流。规范形态 ≠ 迁移前原文件（rawText 已按
 *     方案 C 放弃，手写标注由 notes 承载）；md 无 globalId 语法（渲染函数按字段取用，自动忽略）。
 *   - `migrate global-id [--dry-run]`（todo-cli-todo:16）：存量条目一次性取全局 id。逐文件
 *     锁内新鲜重读 → 数组序逐条取号 → 等价自检（逐字段零漂移/新号单调）→ 落盘；
 *     幂等（无缺口即零动作零写盘）；已有重复号先中止交人工仲裁（lint 同一口径）。
 *
 * 解析规则（等价口径 = 「全部文本零丢失」）：
 *   - 顶层条目 = 行首 `- [x]/[ ]`；一切缩进行（带不带 checkbox）并入上一条顶层条目
 *     的 notes（L17「缩进子行迁移进 notes」；此前带 checkbox 的缩进行被旧解析器
 *     计为独立条目，方案 C 起条目只指顶层，顶层 211 → 171）；
 *   - 正文里以 `aligning` / `aligned` / `processing` / `完成` 开头的顶层括号组是标注：
 *     三个阶段组 → 状态与 branch（纯 `@ feat/x` 形态入 branch 字段，其余内容进 notes
 *     保真），完成组 → notes；其余括号组是正文，原地保留；
 *   - 时间戳尽力回填：node:sqlite 可读的遗留 index.db 按（文件，归一化文本）匹配；
 *     不可读/无记录 → null（绝不伪造）。
 *   - priority（todo-cli-todo:15）：md 无优先级语法 ⇒ from-md 条目一律 5，to-md 不渲染
 *     （往返抹平非 5 是可接受的逃生降级，记入卡片已知坑）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

import { normalizeText, parseTodoJson, serializeTodo } from "./schema.ts";
import type { TodoEntry, TodoFileData } from "./schema.ts";
import { acquireTodoLock, atomicWriteFile, runtimeDir, tmpDirFor, withTodoLock } from "./lock.ts";
import { allocateGlobalId, findGlobalIdProblems, peekNextGlobalId, verifyGlobalIdMigration } from "./globalid.ts";
import type { GlobalIdDoc } from "./globalid.ts";

// ---------------------------------------------------------------------------
// 旧 markdown 解析（纯函数）
// ---------------------------------------------------------------------------

/** 旧 md 的一个顶层条目（标注已剥出，原文保底在 raw）。 */
export interface LegacyEntry {
  /** 勾选标记后的原始文本（含标注），时间戳回填的匹配键。 */
  raw: string;
  /** 剥掉标注括号组后的纯描述（serializeTodo 的 text 字段口径）。 */
  text: string;
  checked: boolean;
  /** 是否出现阶段标注（aligning/aligned/processing）。 */
  state: "open" | "aligning" | "aligned" | "processing";
  /** 纯 `@ feat/x` 形态的 processing 标注（或组内容里首个含 `/` 的 @ 引用）。 */
  branch: string | null;
  /** 标注内容注记（processing 非纯引用的内容 + 完成组内容，按出现序）。 */
  annotationNotes: string[];
  /** 缩进子行（带不带 checkbox 都算），保序。 */
  sublines: string[];
}

export interface LegacyDoc {
  title: string | null;
  entries: LegacyEntry[];
}

interface ParenGroup {
  start: number;
  end: number;
  inner: string;
}

/** 扫描文本中的深度平衡括号组（全/半角同权计数）；孤立右括号与未闭合组留在正文。 */
function scanParenGroups(text: string): ParenGroup[] {
  const groups: ParenGroup[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "（" || ch === "(") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "）" || ch === ")") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        groups.push({ start, end: i + 1, inner: text.slice(start + 1, i) });
        start = -1;
      }
    }
  }
  return groups;
}

const ANNOTATION_RE = /^(processing|aligning|aligned|完成)/;
const STAGE_RE = /^(processing|aligning|aligned)\s*/;
type Stage = Exclude<LegacyEntry["state"], "open">;
const PURE_REF_RE = /^@\s*(\S+)$/;
const REF_TOKEN_RE = /@\s*([^\s：:，,）)（(]+)/g;

/** 括号组是否为标注（内容以 processing/完成 开头）；组内嵌套组不再二次判定。 */
function isAnnotationGroup(inner: string): boolean {
  return ANNOTATION_RE.test(inner.trim());
}

function extractBranchFromText(content: string): string | null {
  for (const match of content.matchAll(REF_TOKEN_RE)) {
    if (match[1].includes("/")) return match[1];
  }
  return null;
}

/** 行首顶层条目：`- [x] `/`- [ ] `（缩进 checkbox 行不算顶层，属子行）。 */
const LEGACY_ENTRY_RE = /^- \[([ xX])\]\s?(.*)$/;
const LEGACY_HEADER_RE = /^#\s+(.+)$/;

/** 子行的列表符号剥除：`- [x] ` / `- ` / `* ` 前缀不进 notes（checkbox 子行本就无状态语义）。 */
const SUBLINE_CHECKBOX_RE = /^-\s+\[[ xX]\]\s*/;
const SUBLINE_BULLET_RE = /^[-*]\s+/;

function stripSublineBullet(line: string): string {
  return line.trim().replace(SUBLINE_CHECKBOX_RE, "").replace(SUBLINE_BULLET_RE, "").trim();
}

/** 解析旧 markdown：顶层条目 + 标注剥出 + 缩进子行归并（标题取首个 `# ` 行）。 */
export function parseLegacyMarkdown(content: string): LegacyDoc {
  const lines = String(content).split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const doc: LegacyDoc = { title: null, entries: [] };
  let current: LegacyEntry | null = null;

  const pushSubline = (line: string): void => {
    const stripped = stripSublineBullet(line);
    if (stripped === "") return;
    if (current) current.sublines.push(stripped);
    else {
      // 前无顶层条目的孤立说明行：兜底为 open 顶层条目（零丢失）
      current = { raw: stripped, text: stripped, checked: false, processing: false, branch: null, annotationNotes: [], sublines: [] };
      doc.entries.push(current);
    }
  };

  for (const line of lines) {
    if (line.trim() === "") continue;
    if (line.startsWith(" ") || line.startsWith("\t")) {
      pushSubline(line);
      continue;
    }
    const header = LEGACY_HEADER_RE.exec(line);
    if (header && !current && doc.entries.length === 0 && doc.title === null) {
      doc.title = header[1].trim();
      continue;
    }
    const entryMatch = LEGACY_ENTRY_RE.exec(line);
    if (!entryMatch) {
      pushSubline(line);
      continue;
    }
    const raw = entryMatch[2].trim();
    const groups = scanParenGroups(raw).filter((group) => isAnnotationGroup(group.inner));
    let text = raw;
    let state: LegacyEntry["state"] = "open";
    let branch: string | null = null;
    const annotationNotes: string[] = [];
    for (const group of [...groups].reverse()) {
      text = `${text.slice(0, group.start)}${text.slice(group.end)}`;
      const content = group.inner.trim();
      const stage = STAGE_RE.exec(content);
      if (stage) {
        state = stage[1] as Stage;
        const payload = content.slice(stage[0].length).trim();
        const pure = payload === "" ? null : PURE_REF_RE.exec(payload);
        if (pure) {
          if (pure[1].includes("/") && branch === null) branch = pure[1];
          else if (!pure[1].includes("/")) annotationNotes.push(payload);
        } else if (payload !== "") {
          annotationNotes.push(payload);
          if (branch === null) branch = extractBranchFromText(payload);
        }
      } else {
        const payload = content.replace(/^完成\s*/, "").trim();
        if (payload !== "") annotationNotes.push(payload);
      }
    }
    // 标注按文本出现序入 notes（倒序剥离后恢复）
    annotationNotes.reverse();
    current = { raw, text: text.trim(), checked: entryMatch[1] !== " ", state, branch, annotationNotes, sublines: [] };
    doc.entries.push(current);
  }
  return doc;
}

/** LegacyDoc → TodoFileData（timestamps：`名\u0000归一化原文` → 三时间戳）；globalId 先置 null，由 from-md 编排取号。 */
export function buildTodoData(name: string, doc: LegacyDoc, timestamps?: ReadonlyMap<string, { createdAt: string | null; claimedAt: string | null; completedAt: string | null }>): TodoFileData {
  const entries: TodoEntry[] = [];
  let id = 0;
  for (const legacy of doc.entries) {
    id += 1;
    const seeded = timestamps?.get(`${name}\u0000${normalizeText(legacy.raw)}`);
    entries.push({
      id,
      globalId: null,
      text: legacy.text,
      status: legacy.checked ? "done" : legacy.state,
      branch: legacy.checked ? null : legacy.branch,
      tags: [],
      priority: 5,
      notes: [...legacy.annotationNotes, ...legacy.sublines],
      createdAt: seeded?.createdAt ?? null,
      claimedAt: seeded?.claimedAt ?? null,
      completedAt: seeded?.completedAt ?? null,
      dependsOn: [],
      alignedAt: null,
    });
  }
  return { version: 4, title: doc.title ?? `${name} TODO`, entries };
}

// ---------------------------------------------------------------------------
// 规范 markdown 渲染（to-md 回滚形态）
// ---------------------------------------------------------------------------

/** JSON → 规范 md：条目行 + 在途态标记还原（aligning/aligned/processing + branch）+ notes 作缩进子行。 */
export function renderMarkdown(data: TodoFileData): string {
  const lines: string[] = [`# ${data.title}`, ""];
  for (const entry of data.entries) {
    const mark = entry.status === "done" ? "[x]" : "[ ]";
    const staged =
      entry.status === "processing" || entry.status === "aligning" || entry.status === "aligned";
    const suffix = staged ? (entry.branch ? `（${entry.status} @ ${entry.branch}）` : `（${entry.status}）`) : "";
    lines.push(`- ${mark} ${entry.text}${suffix}`);
    for (const note of entry.notes) lines.push(`  - ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 迁移编排（文件系统 + 锁 + 原子写）
// ---------------------------------------------------------------------------

export interface MigrateDeps {
  now: () => string;
  log: (line: string) => void;
}

/** 遗留索引文件（from-md 成功后清理；index.db 是 md 时代的派生物）。 */
const LEGACY_INDEX_FILES = ["index.db", "index.db-wal", "index.db-shm", "index.db.corrupt"];

interface SeedTimestamps {
  createdAt: string | null;
  claimedAt: string | null;
  completedAt: string | null;
}

/** 从遗留 index.db 尽力回填时间戳（node:sqlite 只读；任何失败 → null，不阻断迁移）。 */
function seedLegacyTimestamps(repoRoot: string): ReadonlyMap<string, SeedTimestamps> | null {
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> }; close: () => void } };
    const dbPath = path.join(runtimeDir(repoRoot), "index.db");
    if (!fs.existsSync(dbPath)) return null;
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const map = new Map<string, SeedTimestamps>();
      for (const row of db.prepare("SELECT file, text, created_at, claimed_at, completed_at FROM entries").all()) {
        const key = `${String(row.file)}\u0000${normalizeText(String(row.text))}`;
        if (map.has(key)) continue;
        map.set(key, {
          createdAt: row.created_at === null ? null : String(row.created_at),
          claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
          completedAt: row.completed_at === null ? null : String(row.completed_at),
        });
      }
      return map;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** 等价自检：渲染后再解析再构建，与首次构建必须 deepEqual（时间戳除外）。 */
function roundTripEqual(name: string, doc: LegacyDoc, data: TodoFileData): boolean {
  const reparsed = parseLegacyMarkdown(renderMarkdown({ ...data, entries: data.entries.map((entry) => ({ ...entry, createdAt: null, claimedAt: null, completedAt: null })) }));
  const rebuilt = buildTodoData(name, reparsed);
  const strip = (value: TodoFileData) => value.entries.map((entry) => ({ text: entry.text, status: entry.status, branch: entry.branch, notes: entry.notes }));
  return JSON.stringify(strip(rebuilt)) === JSON.stringify(strip(data)) && rebuilt.title === data.title;
}

interface StatusCounts {
  total: number;
  open: number;
  aligning: number;
  aligned: number;
  processing: number;
  done: number;
  notes: number;
}

function countEntries(docs: TodoFileData[]): StatusCounts {
  const counts: StatusCounts = { total: 0, open: 0, aligning: 0, aligned: 0, processing: 0, done: 0, notes: 0 };
  for (const data of docs) {
    for (const entry of data.entries) {
      counts.total += 1;
      counts[entry.status] += 1;
      counts.notes += entry.notes.length;
    }
  }
  return counts;
}

function formatCounts(counts: StatusCounts): string {
  return `open ${counts.open} / aligning ${counts.aligning} / aligned ${counts.aligned} / processing ${counts.processing} / done ${counts.done}`;
}

/** md → JSON：校验（json 已存在则中止）→ 逐文件构建 + 等价自检 → 落盘 → 删 md 与遗留索引。 */
export function migrateFromMd(repoRoot: string, deps: MigrateDeps & { dryRun: boolean; force: boolean }): number {
  const dir = path.join(repoRoot, "todos");
  const mdFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
  if (mdFiles.length === 0) {
    deps.log("没有可迁移的 markdown 文件");
    return 0;
  }
  for (const mdFile of mdFiles) {
    const jsonPath = path.join(dir, `${mdFile.slice(0, -3)}.json`);
    if (fs.existsSync(jsonPath) && !deps.force) {
      deps.log(`已存在 ${path.basename(jsonPath)}——确认覆盖加 --force，或先清理后重试`);
      return 1;
    }
  }

  const seeds = seedLegacyTimestamps(repoRoot);
  const built: Array<{ name: string; file: string; data: TodoFileData }> = [];
  for (const mdFile of mdFiles) {
    const name = mdFile.slice(0, -3);
    const doc = parseLegacyMarkdown(fs.readFileSync(path.join(dir, mdFile), "utf8"));
    const data = buildTodoData(name, doc, seeds ?? undefined);
    if (!roundTripEqual(name, doc, data)) {
      deps.log(`等价校验失败：todos/${mdFile}（渲染再解析与原始构建不一致，中止迁移）`);
      return 1;
    }
    built.push({ name, file: path.join(dir, `${name}.json`), data });
  }

  const counts = countEntries(built.map((item) => item.data));
  if (deps.dryRun) {
    deps.log(`演练：将迁移 ${built.length} 个文件 · 顶层条目 ${counts.total}（${formatCounts(counts)}）· 注记 ${counts.notes} 条`);
    return 0;
  }

  for (const item of built) {
    const lock = acquireTodoLock(repoRoot, item.name);
    if (!lock.ok) {
      deps.log(lock.message);
      return 1;
    }
    try {
      // 每文件锁内逐条取号：from-md 产出 v4 完备台账（一步到位，不留 v3 中间态）。
      for (const entry of item.data.entries) {
        if (entry.globalId !== null) continue;
        const allocated = allocateGlobalId(repoRoot);
        if (!allocated.ok) {
          deps.log(allocated.message);
          return 1;
        }
        entry.globalId = allocated.value;
      }
      atomicWriteFile(item.file, serializeTodo(item.data), { tmpDir: tmpDirFor(repoRoot) });
    } finally {
      lock.release();
    }
  }
  for (const mdFile of mdFiles) {
    try {
      fs.rmSync(path.join(dir, mdFile), { force: true });
    } catch {
      // md 删除失败不回滚 JSON（内容已在 JSON + git 历史），报告即可
      deps.log(`警告：todos/${mdFile} 删除失败，可手工清理`);
    }
  }
  for (const legacy of LEGACY_INDEX_FILES) {
    try {
      fs.rmSync(path.join(runtimeDir(repoRoot), legacy), { force: true });
    } catch {
      // 遗留索引清理失败不影响迁移结果
    }
  }
  deps.log(`已迁移 ${built.length} 个文件 · 顶层条目 ${counts.total}（${formatCounts(counts)}）· 注记 ${counts.notes} 条`);
  deps.log("markdown 权威已删除（回滚：node .agents/skills/todo-cli/todo-cli/todo.mjs migrate to-md）");
  return 0;
}

/** JSON → 规范 md（逃生回滚）：只写 md，绝不删 JSON。 */
export function migrateToMd(repoRoot: string, deps: MigrateDeps): number {
  const dir = path.join(repoRoot, "todos");
  const jsonFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  if (jsonFiles.length === 0) {
    deps.log("没有可还原的 todo JSON 文件");
    return 0;
  }
  const rendered: Array<{ name: string; file: string; content: string }> = [];
  for (const jsonFile of jsonFiles) {
    const parsed = parseTodoJson(fs.readFileSync(path.join(dir, jsonFile), "utf8"), `todos/${jsonFile}`);
    if (!parsed.ok) {
      deps.log(parsed.message);
      return 1;
    }
    rendered.push({ name: jsonFile.slice(0, -5), file: path.join(dir, `${jsonFile.slice(0, -5)}.md`), content: renderMarkdown(parsed.data) });
  }
  for (const item of rendered) {
    const lock = acquireTodoLock(repoRoot, item.name);
    if (!lock.ok) {
      deps.log(lock.message);
      return 1;
    }
    try {
      atomicWriteFile(item.file, item.content, { tmpDir: tmpDirFor(repoRoot) });
    } finally {
      lock.release();
    }
  }
  deps.log(`已还原 ${rendered.length} 个 markdown（todos/*.json 保留不动；彻底回到 md 工作流需切回旧版 CLI）`);
  return 0;
}

// ---------------------------------------------------------------------------
// migrate global-id（todo-cli-todo:16）：存量一次性取号
// ---------------------------------------------------------------------------

/** 读 `todos/` 全部 JSON（按文件名排序）；迁移预检/收尾复检与 core 同口径（避免 import core 成环）。 */
function readAllTodoDocs(repoRoot: string): { ok: true; docs: GlobalIdDoc[] } | { ok: false; message: string } {
  const dir = path.join(repoRoot, "todos");
  if (!fs.existsSync(dir)) return { ok: true, docs: [] };
  const docs: GlobalIdDoc[] = [];
  for (const fileName of fs.readdirSync(dir).sort()) {
    if (!fileName.endsWith(".json")) continue;
    const parsed = parseTodoJson(fs.readFileSync(path.join(dir, fileName), "utf8"), `todos/${fileName}`);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    docs.push({ name: fileName.slice(0, -5), data: parsed.data });
  }
  return { ok: true, docs };
}

/**
 * `migrate global-id [--dry-run]`：给存量未迁移条目一次性发全局 id。
 * 稳定顺序 = 文件名 sort（readdirSync）→ 文件内数组序（单次运行下确定可复现；并发运行时
 * 唯一性仍由计数器保证，仅全局顺序不再确定）。逐文件临界区内新鲜重读（JSON 自身是权威），
 * 等价自检不过则该文件零写、整体中止（已写文件保留 + 号已烧不回收——幂等重跑接续）。
 */
export function migrateGlobalId(repoRoot: string, deps: { log: (line: string) => void; dryRun: boolean }): number {
  const loaded = readAllTodoDocs(repoRoot);
  if (!loaded.ok) {
    deps.log(loaded.message);
    return 1;
  }
  const duplicated = findGlobalIdProblems(loaded.docs).filter((problem) => problem.code === "GLOBAL_ID_DUP");
  if (duplicated.length > 0) {
    for (const problem of duplicated) deps.log(`globalId 重复：${problem.detail}`);
    deps.log("先手工仲裁重复的 globalId（合并冲突按 globalId 判同条目），再重跑 migrate global-id");
    return 1;
  }
  const pending = loaded.docs
    .map((doc) => ({ name: doc.name, missing: doc.data.entries.filter((entry) => entry.globalId === null).length }))
    .filter((item) => item.missing > 0);
  if (pending.length === 0) {
    deps.log("没有需要迁移的条目");
    return 0;
  }
  const total = pending.reduce((sum, item) => sum + item.missing, 0);
  const peek = peekNextGlobalId(repoRoot, loaded.docs);
  if (!peek.ok) {
    deps.log(peek.message);
    return 1;
  }
  if (deps.dryRun) {
    deps.log(`演练：将迁移 ${pending.length} 个文件 · ${total} 条条目（起始号 ${peek.value}）`);
    return 0;
  }

  let files = 0;
  let allocatedCount = 0;
  let firstId = 0;
  let lastId = 0;
  for (const item of pending) {
    const file = path.join(repoRoot, "todos", `${item.name}.json`);
    const locked = withTodoLock(
      repoRoot,
      item.name,
      (): { ok: true; allocated: number[] } | { ok: false; message: string } => {
        const parsed = parseTodoJson(fs.readFileSync(file, "utf8"), `todos/${item.name}.json`);
        if (!parsed.ok) return { ok: false, message: parsed.message };
        const before = structuredClone(parsed.data);
        const allocated: number[] = [];
        for (const entry of parsed.data.entries) {
          if (entry.globalId !== null) continue;
          const next = allocateGlobalId(repoRoot);
          if (!next.ok) return { ok: false, message: next.message };
          entry.globalId = next.value;
          allocated.push(next.value);
        }
        const problem = verifyGlobalIdMigration(before, parsed.data);
        if (problem !== null) return { ok: false, message: `等价校验失败：todos/${item.name}.json（${problem}，中止迁移）` };
        atomicWriteFile(file, serializeTodo(parsed.data), { tmpDir: tmpDirFor(repoRoot) });
        return { ok: true, allocated };
      },
    );
    if (!locked.ok) {
      deps.log(locked.message);
      return 1;
    }
    if (!locked.value.ok) {
      deps.log(locked.value.message);
      return 1;
    }
    if (locked.value.allocated.length === 0) continue;
    files += 1;
    allocatedCount += locked.value.allocated.length;
    const min = Math.min(...locked.value.allocated);
    const max = Math.max(...locked.value.allocated);
    if (firstId === 0 || min < firstId) firstId = min;
    if (max > lastId) lastId = max;
  }

  // 收尾全台账复检：不漏下一个还缺号/重号的条目。
  const recheck = readAllTodoDocs(repoRoot);
  if (!recheck.ok) {
    deps.log(recheck.message);
    return 1;
  }
  const remaining = findGlobalIdProblems(recheck.docs);
  if (remaining.length > 0) {
    for (const problem of remaining) {
      deps.log(problem.code === "GLOBAL_ID_MISSING" ? `globalId 缺失：${problem.detail}（未迁移）` : `globalId 重复：${problem.detail}`);
    }
    return 1;
  }
  deps.log(`已迁移全局 id：${files} 个文件 · ${allocatedCount} 条条目取号 ${firstId}..${lastId}（等价自检通过）`);
  return 0;
}
