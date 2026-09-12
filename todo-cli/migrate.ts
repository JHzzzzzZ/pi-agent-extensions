/**
 * todo-cli/migrate.ts — markdown ↔ JSON 双向迁移（方案 C，todos/todo-cli-todo.md:17）
 *
 * 两个方向、两种定位：
 *   - `migrate from-md`（一次性权威切换）：todos/*.md → todos/*.json，等价自检通过后
 *     删除 md 与遗留 node:sqlite 索引（todos/.todo-cli/index.db*）。自检 = 逐文件
 *     「渲染 → 再解析 → 再构建」与首次构建 deepEqual（文本/状态/分支/注记零丢失），
 *     任何文件不过关就整体中止、一个字节都不写。
 *   - `migrate to-md`（常驻逃生回滚，不是视图）：todos/*.json → 规范形态 md（条目 +
 *     `（processing…）`标记 + 注记作缩进子行），JSON 保留不动；配合 git 历史里的旧版
 *     CLI 即可回到纯 markdown 工作流。规范形态 ≠ 迁移前原文件（rawText 已按方案 C
 *     放弃，手写标注由 notes 承载）。
 *
 * 解析规则（等价口径 = 「全部文本零丢失」）：
 *   - 顶层条目 = 行首 `- [x]/[ ]`；一切缩进行（带不带 checkbox）并入上一条顶层条目
 *     的 notes（L17「缩进子行迁移进 notes」；此前带 checkbox 的缩进行被旧解析器
 *     计为独立条目，方案 C 起条目只指顶层，顶层 211 → 171）；
 *   - 正文里以 `processing` / `完成` 开头的顶层括号组是标注：processing 组 → 状态与
 *     branch（纯 `@ feat/x` 形态入 branch 字段，其余内容进 notes 保真），完成组 → notes；
 *     其余括号组是正文，原地保留；
 *   - 时间戳尽力回填：node:sqlite 可读的遗留 index.db 按（文件，归一化文本）匹配；
 *     不可读/无记录 → null（绝不伪造）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

import { normalizeText, parseTodoJson, serializeTodo } from "./schema.ts";
import type { TodoEntry, TodoFileData } from "./schema.ts";
import { acquireTodoLock, atomicWriteFile, runtimeDir, tmpDirFor } from "./lock.ts";

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
  /** 是否出现 processing 标注组（open/processing 判定依据）。 */
  processing: boolean;
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

const ANNOTATION_RE = /^(processing|完成)/;
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
    let processing = false;
    let branch: string | null = null;
    const annotationNotes: string[] = [];
    for (const group of [...groups].reverse()) {
      text = `${text.slice(0, group.start)}${text.slice(group.end)}`;
      const content = group.inner.trim();
      if (content.startsWith("processing")) {
        processing = true;
        const payload = content.replace(/^processing\s*/, "").trim();
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
    current = { raw, text: text.trim(), checked: entryMatch[1] !== " ", processing, branch, annotationNotes, sublines: [] };
    doc.entries.push(current);
  }
  return doc;
}

/** LegacyDoc → TodoFileData（timestamps：`名\u0000归一化原文` → 三时间戳）。 */
export function buildTodoData(name: string, doc: LegacyDoc, timestamps?: ReadonlyMap<string, { createdAt: string | null; claimedAt: string | null; completedAt: string | null }>): TodoFileData {
  const entries: TodoEntry[] = [];
  let id = 0;
  for (const legacy of doc.entries) {
    id += 1;
    const seeded = timestamps?.get(`${name}\u0000${normalizeText(legacy.raw)}`);
    entries.push({
      id,
      text: legacy.text,
      status: legacy.checked ? "done" : legacy.processing ? "processing" : "open",
      branch: legacy.checked ? null : legacy.branch,
      tags: [],
      notes: [...legacy.annotationNotes, ...legacy.sublines],
      createdAt: seeded?.createdAt ?? null,
      claimedAt: seeded?.claimedAt ?? null,
      completedAt: seeded?.completedAt ?? null,
    });
  }
  return { version: 1, title: doc.title ?? `${name} TODO`, entries };
}

// ---------------------------------------------------------------------------
// 规范 markdown 渲染（to-md 回滚形态）
// ---------------------------------------------------------------------------

/** JSON → 规范 md：条目行 + processing 标记还原 + notes 作缩进子行（roundtrip 稳定）。 */
export function renderMarkdown(data: TodoFileData): string {
  const lines: string[] = [`# ${data.title}`, ""];
  for (const entry of data.entries) {
    const mark = entry.status === "done" ? "[x]" : "[ ]";
    const suffix =
      entry.status === "processing" ? (entry.branch ? `（processing @ ${entry.branch}）` : "（processing）") : "";
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

function countEntries(docs: TodoFileData[]): { total: number; open: number; processing: number; done: number; notes: number } {
  const counts = { total: 0, open: 0, processing: 0, done: 0, notes: 0 };
  for (const data of docs) {
    for (const entry of data.entries) {
      counts.total += 1;
      counts[entry.status] += 1;
      counts.notes += entry.notes.length;
    }
  }
  return counts;
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
    deps.log(`演练：将迁移 ${built.length} 个文件 · 顶层条目 ${counts.total}（open ${counts.open} / processing ${counts.processing} / done ${counts.done}）· 注记 ${counts.notes} 条`);
    return 0;
  }

  for (const item of built) {
    const lock = acquireTodoLock(repoRoot, item.name);
    if (!lock.ok) {
      deps.log(lock.message);
      return 1;
    }
    try {
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
  deps.log(`已迁移 ${built.length} 个文件 · 顶层条目 ${counts.total}（open ${counts.open} / processing ${counts.processing} / done ${counts.done}）· 注记 ${counts.notes} 条`);
  deps.log("markdown 权威已删除（回滚：node tools/todo.mjs migrate to-md）");
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
