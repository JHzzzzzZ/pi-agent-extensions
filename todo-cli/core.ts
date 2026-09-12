/**
 * todo-cli/core.ts — agentic todo 核心（GOAL.md §2「自己这把」+ AGENTS.md 需求登记纪律）
 *
 * 本文件是仓库 CLI（`node tools/todo.mjs`）的唯一实现源：导出纯函数 + `main(argv, deps)`，
 * 无任何 Pi/宿主依赖，任意 cwd 可调用（REPO_ROOT 由脚本位置解析）。
 *
 * 存储形态（方案 C，todos/todo-cli-todo.md:17）：`todos/<名>.json` 是唯一持久真相，
 * markdown 已退出（逃生回滚走 `migrate to-md`）。本模块负责：
 *   - 七个子命令契约不变：summary / list / add / claim / complete / lint / triage；
 *   - 全部写操作经 `todos/.todo-cli/locks/<名>.lock` 跨进程互斥 + temp+rename 原子落盘
 *     （lock.ts；sqlite 索引层已删除，`--claimed-since` 等时间维度成为一等公民）；
 *   - 只读写仓库 `todos/` 目录内的文件，路径穿越直接拒绝；不自动 commit；
 *   - 登记（add）不做 processing 标注，领取（claim）才改状态——动作显式分离；
 *   - `lint` 只校验「根 package.json pi.extensions 注册的扩展都有同名 todo 文件」
 *     这一个方向（未实现插件的 todo 文件合法，不报）。
 *
 * 用法（仓库根）：
 *   node tools/todo.mjs summary [--json]
 *   node tools/todo.mjs list [--status open|processing|done] [--file general]
 *   node tools/todo.mjs list [--branch <ref>] [--tag <词>] [--text <关键词>] [--claimed-since <YYYY-MM-DD>] [--json]
 *   node tools/todo.mjs add --file general "需求描述" [--tag 词1,词2]   # 跨全部文件查重
 *   node tools/todo.mjs claim --file general --match "需求描述" [--branch feat/x]
 *   node tools/todo.mjs complete --file general --match "需求描述" [--note "feat/x：说明"]
 *   node tools/todo.mjs lint
 *   node tools/todo.mjs triage [--json]           # 只读：worktree 事实 × 条目关联
 *   node tools/todo.mjs migrate from-md [--dry-run] [--force] | to-md
 *
 * 纯函数（findDuplicateHits / resolveTodoPath / parseWorktrees / parseMergedBranches /
 * triageRepo）导出给单测；`main` 同时供测试在临时目录上闭环演练。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { emptyTodoData, nextId, normalizeText, parseTodoJson, serializeTodo } from "./schema.ts";
import type { TodoFileData } from "./schema.ts";
import { atomicWriteFile, installProcessHooks, tmpDirFor, withTodoLock } from "./lock.ts";
import { migrateFromMd, migrateToMd } from "./migrate.ts";
import { applyEntryFilter, parseFilterOptions, serializeEntries, sortQueryEntries } from "./query.ts";
import type { QueryEntry } from "./query.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

export { normalizeText } from "./schema.ts";

// ---------------------------------------------------------------------------
// 查重（口径与 markdown 时代逐字节一致，仅 line → id）
// ---------------------------------------------------------------------------

/**
 * 行级查重核心：归一化全等 = exact，一方包含另一方（长度 ≥ 8）= similar。
 * entries 输入为 {name, id, status, text} 投影，返回 [{ name, id, status, text, kind }]。
 */
export function findDuplicateHits(text: string, entries: Array<{ name: string; id: number; status: string; text: string }>) {
  const norm = normalizeText(text);
  if (norm.length === 0) return [];
  const hits = [];
  for (const entry of entries) {
    const other = normalizeText(entry.text);
    if (other.length === 0) continue;
    if (other === norm) {
      hits.push({ name: entry.name, id: entry.id, status: entry.status, text: entry.text, kind: "exact" });
    } else if (norm.length >= 8 && other.includes(norm)) {
      hits.push({ name: entry.name, id: entry.id, status: entry.status, text: entry.text, kind: "similar" });
    } else if (other.length >= 8 && norm.includes(other)) {
      hits.push({ name: entry.name, id: entry.id, status: entry.status, text: entry.text, kind: "similar" });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 路径、读取与保存
// ---------------------------------------------------------------------------

/**
 * todo 文件路径解析：只允许 `todos/` 下的一层文件名，拒绝穿越。
 * 兼容四种输入：`general` / `general-todo` / `general-todo.md`（旧引用）/ `general-todo.json`。
 */
export function resolveTodoPath(nameOrFile: string, repoRoot = REPO_ROOT): string | null {
  const clean = String(nameOrFile).trim();
  if (clean === "" || clean.includes("/") || clean.includes("\\") || clean.includes("..")) return null;
  let base = clean;
  if (base.endsWith(".json")) base = base.slice(0, -5);
  else if (base.endsWith(".md")) base = base.slice(0, -3);
  else if (!base.endsWith("-todo")) base = `${base}-todo`;
  return path.join(repoRoot, "todos", `${base}.json`);
}

export interface LoadedDoc {
  name: string;
  file: string;
  data: TodoFileData;
}

type DocsResult = { ok: true; docs: LoadedDoc[] } | { ok: false; message: string };

/** 读取 `todos/` 全部 .json 文件（按文件名排序）；任一损坏即整体失败（fail-closed）。 */
function readTodoDocs(repoRoot: string): DocsResult {
  const dir = path.join(repoRoot, "todos");
  if (!fs.existsSync(dir)) return { ok: true, docs: [] };
  const docs: LoadedDoc[] = [];
  for (const fileName of fs.readdirSync(dir).sort()) {
    if (!fileName.endsWith(".json")) continue;
    const file = path.join(dir, fileName);
    const parsed = parseTodoJson(fs.readFileSync(file, "utf8"), `todos/${fileName}`);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    docs.push({ name: fileName.slice(0, -5), file, data: parsed.data });
  }
  return { ok: true, docs };
}

/** 原子保存（锁由调用方持有）；两空格缩进 + LF，tmp 落 `todos/.todo-cli/tmp/`。 */
function writeTodoData(repoRoot: string, file: string, data: TodoFileData): void {
  atomicWriteFile(file, serializeTodo(data), { tmpDir: tmpDirFor(repoRoot) });
}

/** 按文件汇总三态计数（name 为不带 .json 的文件名）。 */
export function summarizeData(docs: LoadedDoc[]) {
  return docs.map((doc) => ({
    name: doc.name,
    open: doc.data.entries.filter((entry) => entry.status === "open").length,
    processing: doc.data.entries.filter((entry) => entry.status === "processing").length,
    done: doc.data.entries.filter((entry) => entry.status === "done").length,
    total: doc.data.entries.length,
  }));
}

/** lint：根 package.json 注册的扩展都应有同名 todo 文件。返回问题清单。 */
export function lintTodos(repoRoot = REPO_ROOT): string[] {
  const manifestPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(manifestPath)) return ["找不到根 package.json"];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dirs = (manifest.pi?.extensions ?? []).map((e) => path.basename(path.dirname(String(e))));
  const problems: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(repoRoot, "todos", `${dir}-todo.json`))) problems.push(`扩展 ${dir} 缺少 todos/${dir}-todo.json`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// triage：git worktree 事实 × todos 条目（只读）
// ---------------------------------------------------------------------------

/** 解析 `git worktree list --porcelain`：块间空行分隔，branch 去掉 refs/heads/ 前缀。 */
export function parseWorktrees(porcelain: string) {
  const out = [];
  let cur: Record<string, unknown> | null = null;
  for (const raw of String(porcelain).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { path: "", head: "", branch: null, detached: false, bare: false, locked: false, prunable: false };
    if (line.startsWith("worktree ")) cur.path = line.slice(9);
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line.startsWith("locked")) cur.locked = true;
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** 解析 `git branch --merged <主干>`：剥掉 `* `/`+ `/缩进，忽略 remotes/ 与 detached 行。 */
export function parseMergedBranches(stdout: string): string[] {
  return String(stdout)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line).replace(/^[*+]?\s*/, "").trim())
    .filter((b) => b !== "" && !b.startsWith("remotes/") && !b.startsWith("("));
}

function normalizePath(p: string): string {
  return String(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

/**
 * 只读 triage：把 worktree 事实与 todos 条目互相映射。
 * facts：{ worktrees, mergedBranches, docs, exists(path), dirty(path), orphanDirs }
 * 判定优先级：missing > merged-dirty > cleanup > orphan > active；条目关联 =
 * `entry.branch === worktree.branch` 精确相等（branch 是 claim --branch 写入的原生字段）。
 */
export function triageRepo(facts: Record<string, unknown> = {}) {
  const worktrees = (facts.worktrees as Array<Record<string, unknown>>) ?? [];
  const mergedSet = new Set((facts.mergedBranches as string[]) ?? []);
  const dirExists = (facts.exists as (p: string) => boolean) ?? (() => true);
  const dirtyCount = (facts.dirty as (p: string) => number) ?? (() => 0);
  const main = worktrees.find((w) => !w.bare) ?? null;
  const mainPath = main ? normalizePath(String(main.path)) : null;
  const entries = ((facts.docs as LoadedDoc[]) ?? []).flatMap((doc) =>
    doc.data.entries.map((entry) => ({ ...entry, name: doc.name })),
  );
  const pending = entries.filter((entry) => entry.status !== "done");

  const listed = worktrees
    .filter((w) => !mainPath || normalizePath(String(w.path)) !== mainPath)
    .map((w) => {
      const branch = w.branch as string | null;
      const linked = branch ? pending.filter((entry) => entry.branch === branch) : [];
      const exists = dirExists(String(w.path));
      const dirty = exists ? dirtyCount(String(w.path)) : 0;
      const merged = Boolean(branch && mergedSet.has(branch));
      const flags: string[] = [];
      if (!branch) flags.push(w.detached ? "detached" : "no-branch");
      if (!exists) flags.push("missing-dir");
      if (merged) flags.push("merged");
      if (dirty > 0) flags.push("dirty");
      if (branch && linked.length === 0) flags.push("no-todo");
      const state = !exists
        ? "missing"
        : merged && dirty > 0
          ? "merged-dirty"
          : merged
            ? "cleanup"
            : linked.length === 0
              ? "orphan"
              : "active";
      return {
        path: w.path,
        head: w.head,
        branch,
        detached: w.detached,
        exists,
        merged,
        dirty,
        state,
        flags,
        entries: linked.map((entry) => ({ name: entry.name, id: entry.id, text: entry.text })),
      };
    });

  const liveBranches = new Set(listed.filter((w) => w.branch && w.exists).map((w) => w.branch as string));
  const processing = pending
    .filter((entry) => entry.status === "processing")
    .map((entry) => {
      const ref = entry.branch;
      const kind = ref && ref.includes("/") ? (liveBranches.has(ref) ? "active" : "stale") : "no-ref";
      return { name: entry.name, id: entry.id, text: entry.text, ref, kind };
    });

  return {
    main: main ? { path: main.path, head: main.head, branch: main.branch } : null,
    worktrees: listed,
    processing: {
      total: processing.length,
      active: processing.filter((p) => p.kind === "active"),
      stale: processing.filter((p) => p.kind === "stale"),
      noRef: processing.filter((p) => p.kind === "no-ref"),
    },
    orphanDirs: (facts.orphanDirs as string[]) ?? [],
  };
}

// ---------------------------------------------------------------------------
// 写命令（add / claim / complete）
// ---------------------------------------------------------------------------

interface WriteDeps {
  repoRoot: string;
  opts: Record<string, unknown>;
  now: () => string;
  log: (line: string) => void;
}

/** `--tag a,b` → 去空去重标签。 */
function parseTagsOption(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const tags: string[] = [];
  for (const piece of value.split(",")) {
    const tag = piece.trim();
    if (tag !== "" && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function runAdd(deps: WriteDeps): number {
  const { repoRoot, opts, now, log } = deps;
  const text = (opts._ as string[]).slice(1).join(" ").trim();
  if (!text) {
    log("缺少需求描述");
    return 1;
  }
  const all = readTodoDocs(repoRoot);
  if (!all.ok) {
    log(all.message);
    return 1;
  }
  const duplicateInput = all.docs.flatMap((doc) =>
    doc.data.entries.map((entry) => ({ name: doc.name, id: entry.id, status: entry.status, text: entry.text })),
  );
  const hits = findDuplicateHits(text, duplicateInput);
  if (hits.length > 0 && opts.force !== true) {
    for (const hit of hits) log(`重复（${hit.kind}）：${hit.name}#${hit.id}  ${hit.text}`);
    log("如确认是新需求，加 --force 重新执行");
    return 1;
  }
  const file = resolveTodoPath(String(opts.file), repoRoot) as string;
  const name = path.basename(file, ".json");
  type WriteOutcome = { ok: true } | { ok: false; message: string };
  const locked = withTodoLock(repoRoot, name, (): WriteOutcome => {
    let data: TodoFileData;
    if (fs.existsSync(file)) {
      const parsed = parseTodoJson(fs.readFileSync(file, "utf8"), `todos/${name}.json`);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      data = parsed.data;
    } else {
      data = emptyTodoData(name);
    }
    const entry = {
      id: nextId(data.entries),
      text,
      status: "open" as const,
      branch: null,
      tags: parseTagsOption(opts.tag),
      notes: [],
      createdAt: now(),
      claimedAt: null,
      completedAt: null,
    };
    writeTodoData(repoRoot, file, { ...data, entries: [...data.entries, entry] });
    return { ok: true };
  });
  if (!locked.ok) {
    log(locked.message);
    return 1;
  }
  if (!locked.value.ok) {
    log(locked.value.message);
    return 1;
  }
  log(`已登记到 todos/${name}.json：${text}`);
  return 0;
}

/** 唯一定位含 match 的条目；--match 只匹配纯描述 text（标注/注记在 notes，不参与）。 */
function locateEntry(data: TodoFileData, match: string) {
  const hits = data.entries.filter((entry) => entry.text.includes(match));
  if (hits.length === 0) return { code: "NOT_FOUND" as const };
  if (hits.length > 1) return { code: "AMBIGUOUS" as const };
  return { entry: hits[0] };
}

function runClaim(deps: WriteDeps): number {
  const { repoRoot, opts, now, log } = deps;
  const file = resolveTodoPath(String(opts.file), repoRoot) as string;
  const name = path.basename(file, ".json");
  const match = String(opts.match ?? "");
  type ClaimOutcome = { ok: true; changed: boolean } | { ok: false; message: string };
  const result = withTodoLock(repoRoot, name, (): ClaimOutcome => {
    if (!fs.existsSync(file)) return { ok: false, message: `找不到 todo 文件：${opts.file}` };
    const parsed = parseTodoJson(fs.readFileSync(file, "utf8"), `todos/${name}.json`);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const located = locateEntry(parsed.data, match);
    if (!("entry" in located)) {
      return { ok: false, message: `${located.code}：${located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围"}` };
    }
    const entry = located.entry;
    if (entry.status === "done") return { ok: false, message: "ALREADY_DONE：条目已完成，不能再领取" };
    if (entry.status === "processing") return { ok: true, changed: false };
    entry.status = "processing";
    entry.branch = typeof opts.branch === "string" && opts.branch !== "" ? opts.branch : null;
    entry.claimedAt = now();
    writeTodoData(repoRoot, file, parsed.data);
    return { ok: true, changed: true };
  });
  if (!result.ok) {
    log(result.message);
    return 1;
  }
  if (!result.value.ok) {
    log(result.value.message);
    return 1;
  }
  log(`已领取（${result.value.changed ? "已写入" : "状态未变"}）：${opts.file} · ${match}`);
  return 0;
}

function runComplete(deps: WriteDeps): number {
  const { repoRoot, opts, now, log } = deps;
  const file = resolveTodoPath(String(opts.file), repoRoot) as string;
  const name = path.basename(file, ".json");
  const match = String(opts.match ?? "");
  type CompleteOutcome = { ok: true; changed: boolean } | { ok: false; message: string };
  const result = withTodoLock(repoRoot, name, (): CompleteOutcome => {
    if (!fs.existsSync(file)) return { ok: false, message: `找不到 todo 文件：${opts.file}` };
    const parsed = parseTodoJson(fs.readFileSync(file, "utf8"), `todos/${name}.json`);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const located = locateEntry(parsed.data, match);
    if (!("entry" in located)) {
      return { ok: false, message: `${located.code}：${located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围"}` };
    }
    const entry = located.entry;
    if (entry.status === "done") return { ok: true, changed: false };
    entry.status = "done";
    entry.completedAt = now();
    const note = opts.note;
    if (typeof note === "string" && note !== "") entry.notes.push(note);
    writeTodoData(repoRoot, file, parsed.data);
    return { ok: true, changed: true };
  });
  if (!result.ok) {
    log(result.message);
    return 1;
  }
  if (!result.value.ok) {
    log(result.value.message);
    return 1;
  }
  log(`已完成（${result.value.changed ? "已写入" : "状态未变"}）：${opts.file} · ${match}`);
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const opts: Record<string, unknown> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "json" || key === "force" || key === "help" || key === "dry-run") opts[key] = true;
      else {
        opts[key] = argv[i + 1];
        i += 1;
      }
    } else opts._.push(arg);
  }
  return opts;
}

function runList(repoRoot: string, opts: Record<string, unknown>, log: (line: string) => void): number {
  const all = readTodoDocs(repoRoot);
  if (!all.ok) {
    log(all.message);
    return 1;
  }
  let docs = all.docs;
  if (opts.file) {
    const resolvedFile = resolveTodoPath(String(opts.file), repoRoot);
    if (!resolvedFile || !fs.existsSync(resolvedFile)) {
      log(`找不到 todo 文件：${opts.file}`);
      return 1;
    }
    docs = docs.filter((doc) => doc.file === resolvedFile);
  }
  const parsed = parseFilterOptions(opts);
  if (!parsed.ok) {
    log(parsed.message);
    return 1;
  }
  const entries: QueryEntry[] = docs.flatMap((doc) =>
    doc.data.entries.map((entry) => ({ ...entry, file: doc.name })),
  );
  const sorted = sortQueryEntries(applyEntryFilter(entries, parsed.filter));
  for (const line of serializeEntries(sorted, { json: parsed.json })) log(line);
  return 0;
}

function runTriage(repoRoot: string, opts: Record<string, unknown>, deps: Record<string, unknown>, log: (line: string) => void): number {
  const execGit =
    (deps.execGit as ((args: string[], cwd?: string) => string) | undefined) ??
    ((args: string[], cwd?: string) => execFileSync("git", ["-C", cwd ?? repoRoot, ...args], { encoding: "utf8" }));
  const worktrees = parseWorktrees(execGit(["worktree", "list", "--porcelain"]));
  const main = worktrees.find((w) => !w.bare) ?? null;
  const mergedBranches = main?.branch ? parseMergedBranches(execGit(["branch", "--merged", String(main.branch)])) : [];
  const registered = new Set(worktrees.map((w) => normalizePath(String(w.path))));
  const wtDir = path.join(repoRoot, ".worktrees");
  const orphanDirs = !fs.existsSync(wtDir)
    ? []
    : fs
        .readdirSync(wtDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `.worktrees/${d.name}`)
        .filter((rel) => !registered.has(normalizePath(path.join(repoRoot, rel))));
  const all = readTodoDocs(repoRoot);
  if (!all.ok) {
    log(all.message);
    return 1;
  }
  const report = triageRepo({
    worktrees,
    mergedBranches,
    docs: all.docs,
    exists: (p) => fs.existsSync(p),
    dirty: (p) => {
      try {
        return execGit(["status", "--porcelain"], p)
          .split("\n")
          .filter((l) => l.trim() !== "" && !l.startsWith("??")).length;
      } catch {
        return 0;
      }
    },
    orphanDirs,
  });
  if (opts.json) {
    log(JSON.stringify(report, null, 2));
    return 0;
  }
  const STATE_LABEL: Record<string, string> = {
    active: "活跃",
    cleanup: "已并入主干·干净（清理候选）",
    "merged-dirty": "已并入主干·有未提交改动",
    orphan: "无关联条目",
    missing: "目录已不存在",
  };
  log(`# triage（只读：worktree 事实 × todos 条目关联）`);
  log(`主干：${report.main?.branch ?? "<未知>"} @ ${(report.main?.head as string ?? "?").slice(0, 7)}  ${report.main?.path ?? ""}`.trimEnd());
  if (report.worktrees.length === 0) log("worktree（主工作区除外）：无");
  else {
    log(`worktree（主工作区除外）：${report.worktrees.length} 个`);
    for (const w of report.worktrees) {
      log(`  [${w.state}·${STATE_LABEL[w.state]}] ${w.branch ?? "(detached)"} @ ${String(w.head).slice(0, 7)} · 关联条目 ${w.entries.length} · 未提交 ${w.dirty} · ${w.path}`);
    }
  }
  const p = report.processing;
  log(`processing 条目：${p.total}（有工作台 ${p.active.length} · 引用分支已消失 ${p.stale.length} · 无分支引用 ${p.noRef.length}）`);
  for (const item of p.stale) log(`  ⚠ ${item.name}#${item.id} 引用 ${item.ref}，已无对应 worktree`);
  for (const item of p.noRef) log(`  · ${item.name}#${item.id} 无分支引用（人工确认状态）`);
  log(report.orphanDirs.length === 0 ? "孤儿目录：无" : `孤儿目录：${report.orphanDirs.join("、")}`);
  return 0;
}

const USAGE = `用法：
  node tools/todo.mjs summary [--json]
  node tools/todo.mjs list [--status open|processing|done] [--file <name>]
  node tools/todo.mjs add --file <name> "需求描述" [--tag 词1,词2]
  node tools/todo.mjs claim --file <name> --match "子串" [--branch feat/x]
  node tools/todo.mjs complete --file <name> --match "子串" [--note "说明"]
  node tools/todo.mjs lint
  node tools/todo.mjs triage [--json]
  node tools/todo.mjs list [--branch <ref>] [--tag <词>] [--text <关键词>] [--claimed-since <YYYY-MM-DD>] [--json]
  node tools/todo.mjs migrate from-md [--dry-run] [--force] | to-md`;

/**
 * 执行一次 CLI 调用，返回退出码（测试在临时仓库上闭环）。
 * repoRoot / log / now / execGit 可注入；文件读写始终走真实 fs（锁 + 原子写是
 * 被测行为本身，不做注入替身）。
 */
export function main(argv: string[], deps: Record<string, unknown> = {}): number {
  const repoRoot = (deps.repoRoot as string | undefined) ?? REPO_ROOT;
  const log = (deps.log as ((line: string) => void) | undefined) ?? ((line: string) => console.log(line));
  const now = (deps.now as (() => string) | undefined) ?? (() => new Date().toISOString());
  installProcessHooks();
  const opts = parseArgs(argv);
  const command = (opts._ as string[])[0] ?? (opts.help ? "help" : "");

  if (command === "help" || command === "") {
    log(USAGE);
    return command === "" && !opts.help ? 1 : 0;
  }

  if (command === "summary") {
    const all = readTodoDocs(repoRoot);
    if (!all.ok) {
      log(all.message);
      return 1;
    }
    const rows = summarizeData(all.docs);
    if (opts.json) log(JSON.stringify(rows, null, 2));
    else for (const r of rows) log(`${r.name.padEnd(24)} open ${r.open}  processing ${r.processing}  done ${r.done}  total ${r.total}`);
    return 0;
  }

  if (command === "list") return runList(repoRoot, opts, log);

  if (command === "lint") {
    const problems = lintTodos(repoRoot);
    if (problems.length === 0) log("lint 通过：注册扩展与 todo 文件一一对应");
    else for (const p of problems) log(`✗ ${p}`);
    return problems.length === 0 ? 0 : 1;
  }

  if (command === "triage") return runTriage(repoRoot, opts, deps, log);

  if (command === "migrate") {
    const sub = (opts._ as string[])[1];
    if (sub === "from-md") {
      return migrateFromMd(repoRoot, { now, log, dryRun: opts["dry-run"] === true, force: opts.force === true });
    }
    if (sub === "to-md") return migrateToMd(repoRoot, { now, log });
    log(`未知 migrate 子命令：${sub ?? ""}（可用：from-md [--dry-run] [--force] | to-md）`);
    return 1;
  }

  if (command === "add" || command === "claim" || command === "complete") {
    if (!opts.file) {
      log("缺少 --file <name>");
      return 1;
    }
    const file = resolveTodoPath(String(opts.file), repoRoot);
    if (!file) {
      log("--file 只能是 todos/ 下的文件名");
      return 1;
    }
    if (command === "add") return runAdd({ repoRoot, opts, now, log });
    if (!opts.match) {
      log('缺少 --match "子串"');
      return 1;
    }
    return command === "claim" ? runClaim({ repoRoot, opts, now, log }) : runComplete({ repoRoot, opts, now, log });
  }

  log(`未知命令：${command}\n${USAGE}`);
  return 1;
}
