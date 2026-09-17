/**
 * .agents/skills/todo-cli/todo-cli/core.ts — agentic todo 核心（GOAL.md §2「自己这把」+ AGENTS.md 需求登记纪律）
 *
 * 本文件是 CLI 的唯一实现源：导出纯函数 + `main(argv, deps)`，无任何 Pi/宿主依赖。
 * 工具住在仓库内的 skill 目录里（不再在仓库根的 tools/ 或 todo-cli/），所以仓库根不能
 * 再靠脚本位置推断：解析顺序 = `deps.repoRoot`（测试注入）→ `--root <dir>` →
 * `git rev-parse --show-toplevel`（以 `process.cwd()` 为工作目录，仓库子目录亦可）→
 * 都拿不到就 fail-closed 中止（静态消息 + exit 1）。命令面其余部分与 cwd 无关。
 *
 * 存储形态（方案 C，todos/todo-cli-todo.md:17）：`todos/<名>.json` 是唯一持久真相，
 * markdown 已退出（逃生回滚走 `migrate to-md`）。本模块负责：
 *   - 十个子命令：summary / list / add / claim / align / complete / reopen / dep / lint / triage；
 *   - 状态机五态对齐门（todo-cli-todo:11，ADR-0003）：open → aligning → aligned →
 *     processing → done。首次 claim 进 aligning（必须先写对齐文档、经人工确认），
 *     `align` 结构校验文档后进 aligned，再次 claim 才进 processing；processing 起到
 *     收口无人值守。反向通道是 `reopen`（todo-cli-todo:14，ADR-0007）：aligning/aligned/
 *     processing 一律退回 open，陈旧对齐文档归档为 `.reopened-<UTC 紧凑>.md`。
 *     对齐文档契约（路径派生/必填小节）在 align.ts；模板在
 *     docs/tools/todo-cli.md。
 *   - 开工依赖门（todo-cli-todo:10，ADR-0005）：条目可声明 `dependsOn`（规范引用
 *     `文件基名#id`，`add --dep` 登记、`dep add/remove` 增删）。依赖未完成（status ≠ done）
 *     时第二次 claim fail-closed（DEP_BLOCKED，条目留在 aligned）；首次 claim 与 align
 *     不受阻。引用归一/环检测/阻塞判定全在 depends.ts（纯函数）。
 *   - 统一全局 id（todo-cli-todo:16）：条目 globalId 由 `todos/.todo-cli/next-id` 计数器
 *     在 id 锁内发号（全台账唯一、永不回收；计数器不入库，缺失时按台账存量自愈）。
 *     存量按 `migrate global-id` 一次性迁移；六个写命令在缺号台账上 fail-closed
 *     （GLOBAL_ID_PENDING），读命令容忍 null 瞬态；只有 `list --json` 输出 globalId。
 *   - 全部写操作经 `todos/.todo-cli/locks/<名>.lock` 跨进程互斥 + temp+rename 原子落盘
 *     （lock.ts；sqlite 索引层已删除，`--claimed-since` 等时间维度成为一等公民）；
 *   - 只读写仓库 `todos/` 目录内的文件，路径穿越直接拒绝；不自动 commit；
 *   - 登记（add）不做状态标注，领取（claim）才改状态——动作显式分离；
 *   - `lint` 只校验「根 package.json pi.extensions 注册的扩展都有同名 todo 文件」
 *     这一个方向（未实现插件的 todo 文件合法，不报）。
 *
 * 用法（任意 git 仓库任意 cwd；入口固定为 <仓库>/.agents/skills/todo-cli/todo-cli/todo.mjs）：
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs summary [--json]
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs list [--status open|aligning|aligned|processing|done] [--file general]
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs list [--branch <ref>] [--tag <词>] [--text <关键词>] [--claimed-since <YYYY-MM-DD>] [--json]
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs add --file general "需求描述" [--tag 词1,词2] [--dep 文件#id,...]
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs claim --file general --match "需求描述" [--branch feat/x]
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs align --file general --match "需求描述" [--note "说明"]
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs complete --file general --match "需求描述" [--note "feat/x：说明"]
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs reopen --file general --match "需求描述" [--note "撤销原因"]
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs dep add|remove --file general --match "需求描述" --on 文件#id,...
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs lint
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs triage [--json]           # 只读：worktree 事实 × 条目关联
 *   node .agents/skills/todo-cli/todo-cli/todo.mjs migrate from-md [--dry-run] [--force] | to-md | global-id [--dry-run]
 * 任意子命令前置 `--root <dir>` 可显式指定仓库根（跳过 git 发现；对非 git 目录也适用）。
 *
 * 纯函数（findDuplicateHits / resolveTodoPath / parseWorktrees / parseMergedBranches /
 * triageRepo / resolveRepoRoot）导出给单测；`main` 同时供测试在临时目录上闭环演练。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { emptyTodoData, nextId, normalizeText, normalizeTodoName, parseTodoJson, serializeTodo } from "./schema.ts";
import type { EntryStatus, TodoEntry, TodoFileData } from "./schema.ts";
import { ALIGN_SECTIONS, alignDocPath, alignDocRelPath, archiveStamp, reopenArchivePath, reopenArchiveRelPath, validateAlignDoc } from "./align.ts";
import { blockedByMap, blockingDeps, checkDepWrite, DepProblemCodes, dependentsOf, findDepProblems, normalizeDepRef } from "./depends.ts";
import type { DepEntry, DepProblem } from "./depends.ts";
import { atomicWriteFile, installProcessHooks, tmpDirFor, withTodoLock } from "./lock.ts";
import { allocateGlobalId, findGlobalIdProblems } from "./globalid.ts";
import type { GlobalIdDoc, GlobalIdProblem } from "./globalid.ts";
import { migrateFromMd, migrateGlobalId, migrateToMd } from "./migrate.ts";
import { applyEntryFilter, parseFilterOptions, serializeEntries, sortQueryEntries } from "./query.ts";
import type { QueryEntry } from "./query.ts";

export { normalizeText } from "./schema.ts";

// ---------------------------------------------------------------------------
// 仓库根发现（工具在 skill 目录里 → 脚本位置不再等于仓库根）
// ---------------------------------------------------------------------------

/** git 默认执行器：`git -C <cwd> …`；stderr 吞掉（非 git 目录不该往终端喷 fatal）。 */
function defaultExecGit(args: string[], cwd: string): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * 解析仓库根：`--root <dir>`（相对 cwd 解析、必须是已存在目录）优先，否则用
 * `git rev-parse --show-toplevel`（cwd 起）。失败返回静态消息，由调用方 fail-closed。
 * 纯入口：cwd / execGit 均可注入。
 */
export function resolveRepoRoot(
  input: { rootFlag?: unknown; cwd?: string; execGit?: (args: string[], cwd: string) => string } = {},
): { ok: true; root: string } | { ok: false; message: string } {
  const cwd = input.cwd ?? process.cwd();
  if (input.rootFlag !== undefined) {
    if (typeof input.rootFlag !== "string" || input.rootFlag.trim() === "") {
      return { ok: false, message: "缺少 --root 的目录（用法：--root <dir>）" };
    }
    const root = path.resolve(cwd, input.rootFlag);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { ok: false, message: `--root 指向的目录不存在：${input.rootFlag}` };
    }
    return { ok: true, root };
  }
  const execGit = input.execGit ?? defaultExecGit;
  let stdout: string;
  try {
    stdout = execGit(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return { ok: false, message: "找不到仓库根：当前目录不在 git 仓库内（可用 --root <dir> 指定）" };
  }
  const trimmed = String(stdout).trim();
  if (trimmed === "") return { ok: false, message: "找不到仓库根：git 未返回仓库路径（可用 --root <dir> 指定）" };
  return { ok: true, root: path.resolve(trimmed) };
}

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
 * 归一规则单源在 schema.ts 的 normalizeTodoName（依赖引用解析共用同一口径）。
 */
export function resolveTodoPath(nameOrFile: string, repoRoot: string): string | null {
  const base = normalizeTodoName(nameOrFile);
  return base === null ? null : path.join(repoRoot, "todos", `${base}.json`);
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

function countStatus(entries: TodoEntry[], status: EntryStatus): number {
  return entries.filter((entry) => entry.status === status).length;
}

/** 全量 docs → 依赖图节点投影（跨文件引用靠它解析）。 */
function depIndex(docs: LoadedDoc[]): DepEntry[] {
  return docs.flatMap((doc) =>
    doc.data.entries.map((entry) => ({ file: doc.name, id: entry.id, status: entry.status, dependsOn: entry.dependsOn })),
  );
}

/** 写入路径的依赖问题 → 静态终止消息（与 --dep/--on 的引用错误同一模板族）。 */
function depProblemMessage(problem: DepProblem): string {
  if (problem.code === DepProblemCodes.notFound) return `DEP_NOT_FOUND：依赖目标不存在 ${problem.detail}`;
  if (problem.code === DepProblemCodes.self) return `DEP_SELF：条目不能依赖自身 ${problem.detail}`;
  return `DEP_CYCLE：依赖成环 ${problem.detail}`;
}

/** lint 的问题行（带归属条目，供人读扫描）。 */
function depProblemLine(problem: DepProblem): string {
  const label =
    problem.code === DepProblemCodes.notFound
      ? "依赖目标不存在"
      : problem.code === DepProblemCodes.self
        ? "自引用依赖"
        : "依赖成环";
  return `✗ ${problem.owner} ${label}：${problem.detail}`;
}

/** 全局 id 问题行（lint 人读扫描；main 统一加 `✗ ` 前缀）。 */
function globalIdProblemLine(problem: GlobalIdProblem): string {
  return problem.code === "GLOBAL_ID_MISSING" ? `globalId 缺失：${problem.detail}（未迁移）` : `globalId 重复：${problem.detail}`;
}

/**
 * 写路径的全局 id 门禁：已读到的 docs 里任一条目缺 globalId 就 fail-closed（静态消息、
 * 零写盘零取号）。只在写路径挂——list/summary/triage/lint 在迁移期间必须照常可读
 * （可观测性不倒）。
 */
function globalIdGateMessage(docs: readonly GlobalIdDoc[]): string | null {
  const missing = findGlobalIdProblems(docs).filter((problem) => problem.code === "GLOBAL_ID_MISSING");
  if (missing.length === 0) return null;
  const first = docs.find((doc) => doc.data.entries.some((entry) => entry.globalId === null));
  return `GLOBAL_ID_PENDING：仍有 ${missing.length} 条条目缺 globalId（如 todos/${first?.name ?? ""}.json），先运行 migrate global-id`;
}

/**
 * `--dep a#1,b#2` / `--on a#1,b#2` → 归一引用清单（去重保序）；任一项非法即整体失败。
 * 逗号分隔与 --tag 同构（parseArgs 对重复 flag 只留最后一个，不预留重复 flag 形态）。
 */
function parseDepRefsOption(value: unknown, flag: string): { ok: true; refs: string[] } | { ok: false; message: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  const refs: string[] = [];
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (trimmed === "") continue;
    const ref = normalizeDepRef(trimmed);
    if (ref === null) return { ok: false, message: `DEP_REF_INVALID：${flag} 需要 文件#id 引用（如 general-todo#11）` };
    if (!refs.includes(ref)) refs.push(ref);
  }
  if (refs.length === 0) return { ok: false, message: `DEP_REF_INVALID：${flag} 需要 文件#id 引用（如 general-todo#11）` };
  return { ok: true, refs };
}

/** 按文件汇总五态计数（name 为不带 .json 的文件名）。 */
export function summarizeData(docs: LoadedDoc[]) {
  return docs.map((doc) => ({
    name: doc.name,
    open: countStatus(doc.data.entries, "open"),
    aligning: countStatus(doc.data.entries, "aligning"),
    aligned: countStatus(doc.data.entries, "aligned"),
    processing: countStatus(doc.data.entries, "processing"),
    done: countStatus(doc.data.entries, "done"),
    total: doc.data.entries.length,
  }));
}

/** lint：根 package.json 注册的扩展都应有同名 todo 文件 + 依赖图全量扫描（悬空/自引用/环）。 */
export function lintTodos(repoRoot: string): string[] {
  const manifestPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(manifestPath)) return ["找不到根 package.json"];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dirs = (manifest.pi?.extensions ?? []).map((e) => path.basename(path.dirname(String(e))));
  const problems: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(repoRoot, "todos", `${dir}-todo.json`))) problems.push(`扩展 ${dir} 缺少 todos/${dir}-todo.json`);
  }
  // 依赖图兜底：跨分支合并能造出写路径没见过的悬空引用与环（ADR-0005）。
  const all = readTodoDocs(repoRoot);
  if (!all.ok) problems.push(all.message);
  else {
    problems.push(...findDepProblems(depIndex(all.docs)).map(depProblemLine));
    // 全局 id 兜底：跨分支合并能造出重复号，写门禁之外由 lint 兜住漏网（todo-cli-todo:16）。
    problems.push(...findGlobalIdProblems(all.docs).map(globalIdProblemLine));
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
  /** 在途态分段（aligning/aligned/processing 同构）：branch 与存活 worktree 分支精确相等。 */
  const stageOf = (status: EntryStatus) => {
    const rows = pending
      .filter((entry) => entry.status === status)
      .map((entry) => {
        const ref = entry.branch;
        const kind = ref && ref.includes("/") ? (liveBranches.has(ref) ? "active" : "stale") : "no-ref";
        return { name: entry.name, id: entry.id, text: entry.text, ref, kind };
      });
    return {
      total: rows.length,
      active: rows.filter((p) => p.kind === "active"),
      stale: rows.filter((p) => p.kind === "stale"),
      noRef: rows.filter((p) => p.kind === "no-ref"),
    };
  };

  return {
    main: main ? { path: main.path, head: main.head, branch: main.branch } : null,
    worktrees: listed,
    aligning: stageOf("aligning"),
    aligned: stageOf("aligned"),
    processing: stageOf("processing"),
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
  const depOption = opts.dep;
  const parsedDeps =
    depOption === undefined || depOption === "" ? { ok: true as const, refs: [] as string[] } : parseDepRefsOption(depOption, "--dep");
  if (!parsedDeps.ok) {
    log(parsedDeps.message);
    return 1;
  }
  const all = readTodoDocs(repoRoot);
  if (!all.ok) {
    log(all.message);
    return 1;
  }
  // 写门禁：未迁移台账上登记会被挡下（不烧号、不写盘），先 migrate global-id。
  const gate = globalIdGateMessage(all.docs);
  if (gate !== null) {
    log(gate);
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
  // 依赖校验只在真的声明了依赖时才建索引（普通登记不得为此变慢）。
  const entryIndex = parsedDeps.refs.length > 0 ? depIndex(all.docs) : [];
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
    // 临界区内新鲜 parse 后再判一次：堵住「锁外读到已迁移、锁内已被重写回未迁移」的竞态窗口。
    const gate = globalIdGateMessage([{ name, data }]);
    if (gate !== null) return { ok: false, message: gate };
    const id = nextId(data.entries);
    // 依赖写在落盘前校验（目标存在 / 非自身 / 不成环）——_fail-closed，不给 --force 旁路。
    const problems = checkDepWrite({ file: name, id, dependsOn: parsedDeps.refs }, entryIndex);
    if (problems.length > 0) return { ok: false, message: problems.map(depProblemMessage).join("\n") };
    // 取号在依赖校验之后：普通登记失败（依赖/锁）不烧号；取号后写盘失败留缺口（永不回收）。
    const allocated = allocateGlobalId(repoRoot);
    if (!allocated.ok) return { ok: false, message: allocated.message };
    const entry = {
      id,
      globalId: allocated.value,
      text,
      status: "open" as const,
      branch: null,
      tags: parseTagsOption(opts.tag),
      dependsOn: parsedDeps.refs,
      notes: [],
      createdAt: now(),
      claimedAt: null,
      completedAt: null,
      alignedAt: null,
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
  const depSuffix = parsedDeps.refs.length > 0 ? `（依赖 ${parsedDeps.refs.join(", ")}）` : "";
  log(`已登记到 todos/${name}.json：${text}${depSuffix}`);
  return 0;
}

/** 唯一定位含 match 的条目；--match 只匹配纯描述 text（标注/注记在 notes，不参与）。 */
function locateEntry(data: TodoFileData, match: string) {
  const hits = data.entries.filter((entry) => entry.text.includes(match));
  if (hits.length === 0) return { code: "NOT_FOUND" as const };
  if (hits.length > 1) return { code: "AMBIGUOUS" as const };
  return { entry: hits[0] };
}

/**
 * 两段式领取（迁移表见 ADR-0003；开工依赖门见 ADR-0005）：open → aligning（写 branch 与
 * claimedAt，输出对齐文档路径 + 必填小节）；aligning/processing 幂等（不写盘）；
 * aligned → processing（依赖全部 done 才放行；提供了 --branch 才覆盖），done 拒绝。
 */
function runClaim(deps: WriteDeps): number {
  const { repoRoot, opts, now, log } = deps;
  const file = resolveTodoPath(String(opts.file), repoRoot) as string;
  const name = path.basename(file, ".json");
  const match = String(opts.match ?? "");
  type ClaimOutcome =
    | { ok: true; changed: boolean; id: number; status: EntryStatus }
    | { ok: false; message: string };
  const result = withTodoLock(repoRoot, name, (): ClaimOutcome => {
    // 依赖门要解析跨文件引用——读全量台账（任一文件损坏整体 fail-closed，与其它命令同口径）。
    const all = readTodoDocs(repoRoot);
    if (!all.ok) return { ok: false, message: all.message };
    const gate = globalIdGateMessage(all.docs);
    if (gate !== null) return { ok: false, message: gate };
    const doc = all.docs.find((item) => item.name === name);
    if (doc === undefined) return { ok: false, message: `找不到 todo 文件：${opts.file}` };
    const located = locateEntry(doc.data, match);
    if (!("entry" in located)) {
      return { ok: false, message: `${located.code}：${located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围"}` };
    }
    const entry = located.entry;
    if (entry.status === "done") return { ok: false, message: "ALREADY_DONE：条目已完成，不能再领取" };
    if (entry.status === "processing" || entry.status === "aligning") {
      return { ok: true, changed: false, id: entry.id, status: entry.status };
    }
    const branch = typeof opts.branch === "string" && opts.branch !== "" ? opts.branch : null;
    if (entry.status === "open") {
      entry.status = "aligning";
      entry.branch = branch;
      if (entry.claimedAt === null) entry.claimedAt = now();
    } else {
      const blocking = blockingDeps(entry, depIndex(all.docs));
      if (blocking.length > 0) {
        const waits = blocking.map((item) => `  ${item.ref}（${item.status ?? "不存在"}）`);
        return { ok: false, message: ["DEP_BLOCKED：依赖未完成，不能开工", ...waits].join("\n") };
      }
      entry.status = "processing";
      if (branch !== null) entry.branch = branch;
    }
    writeTodoData(repoRoot, file, doc.data);
    return { ok: true, changed: true, id: entry.id, status: entry.status };
  });
  if (!result.ok) {
    log(result.message);
    return 1;
  }
  if (!result.value.ok) {
    log(result.value.message);
    return 1;
  }
  const { changed, id, status } = result.value;
  log(`已领取（${changed ? "已写入" : "状态未变"}）：${opts.file} · ${match}`);
  if (status === "aligning") {
    const sections = ALIGN_SECTIONS.map((section) => `## ${section}`).join("、");
    log(`下一步：写对齐文档 ${alignDocRelPath(name, id)}（必填小节：${sections}），人工确认后运行 align`);
  }
  if (status === "processing") log("对齐已确认，进入 processing（此后无人值守至收口）");
  return 0;
}

/**
 * 对齐确认：aligning + 对齐文档结构校验通过 → aligned（写 alignedAt，--note 逐字进
 * notes）；aligned 幂等；其余状态 NOT_ALIGNING。文档缺失/不完整均 fail-closed 不写盘。
 */
function runAlign(deps: WriteDeps): number {
  const { repoRoot, opts, now, log } = deps;
  const file = resolveTodoPath(String(opts.file), repoRoot) as string;
  const name = path.basename(file, ".json");
  const match = String(opts.match ?? "");
  type AlignOutcome = { ok: true; changed: boolean } | { ok: false; message: string };
  const result = withTodoLock(repoRoot, name, (): AlignOutcome => {
    if (!fs.existsSync(file)) return { ok: false, message: `找不到 todo 文件：${opts.file}` };
    const parsed = parseTodoJson(fs.readFileSync(file, "utf8"), `todos/${name}.json`);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const gate = globalIdGateMessage([{ name, data: parsed.data }]);
    if (gate !== null) return { ok: false, message: gate };
    const located = locateEntry(parsed.data, match);
    if (!("entry" in located)) {
      return { ok: false, message: `${located.code}：${located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围"}` };
    }
    const entry = located.entry;
    if (entry.status === "aligned") return { ok: true, changed: false };
    if (entry.status !== "aligning") return { ok: false, message: "NOT_ALIGNING：条目不在 aligning 状态，无法确认对齐" };
    const docPath = alignDocPath(repoRoot, name, entry.id);
    if (!fs.existsSync(docPath)) {
      return { ok: false, message: `ALIGN_DOC_MISSING：缺少对齐文档 ${alignDocRelPath(name, entry.id)}` };
    }
    const validation = validateAlignDoc(fs.readFileSync(docPath, "utf8"), { name, id: entry.id });
    if (!validation.ok) {
      return { ok: false, message: `ALIGN_DOC_INCOMPLETE：对齐文档缺少小节：${validation.missing.join("、")}` };
    }
    entry.status = "aligned";
    entry.alignedAt = now();
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
  log(`已对齐（${result.value.changed ? "已写入" : "状态未变"}）：${opts.file} · ${match}`);
  return 0;
}

/**
 * 收口：→ done（对齐阶段收口必带 --note）；完成后反查直接依赖本条目且未完成的条目，
 * 输出一行提示——done 即解锁（含取消/搁置），下游的前提是否仍成立要人工重判（ADR-0005）。
 */
function runComplete(deps: WriteDeps): number {
  const { repoRoot, opts, now, log } = deps;
  const file = resolveTodoPath(String(opts.file), repoRoot) as string;
  const name = path.basename(file, ".json");
  const match = String(opts.match ?? "");
  type CompleteOutcome = { ok: true; changed: boolean; dependents: DepEntry[] } | { ok: false; message: string };
  const result = withTodoLock(repoRoot, name, (): CompleteOutcome => {
    const all = readTodoDocs(repoRoot);
    if (!all.ok) return { ok: false, message: all.message };
    const gate = globalIdGateMessage(all.docs);
    if (gate !== null) return { ok: false, message: gate };
    const doc = all.docs.find((item) => item.name === name);
    if (doc === undefined) return { ok: false, message: `找不到 todo 文件：${opts.file}` };
    const located = locateEntry(doc.data, match);
    if (!("entry" in located)) {
      return { ok: false, message: `${located.code}：${located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围"}` };
    }
    const entry = located.entry;
    if (entry.status === "done") return { ok: true, changed: false, dependents: [] };
    const note = opts.note;
    const hasNote = typeof note === "string" && note !== "";
    // 取消/搁置 = 从对齐阶段收口，必须留原因（对齐门的人工留痕）
    if ((entry.status === "aligning" || entry.status === "aligned") && !hasNote) {
      return { ok: false, message: "NOTE_REQUIRED：从对齐阶段收口必须带 --note 说明原因" };
    }
    entry.status = "done";
    entry.completedAt = now();
    if (hasNote) entry.notes.push(note as string);
    writeTodoData(repoRoot, file, doc.data);
    return { ok: true, changed: true, dependents: dependentsOf(`${name}#${entry.id}`, depIndex(all.docs)) };
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
  if (result.value.dependents.length > 0) {
    const list = result.value.dependents.map((item) => `${item.file}#${item.id}（${item.status}）`).join("、");
    log(`提示：以下未完成条目依赖本条目：${list}`);
  }
  return 0;
}

/**
 * 撤销：在途条目退回未领取（todo-cli-todo:14，ADR-0007）。五态是前向机，而台账会撞上
 * 「零 claim / 零分支 / 零文档的虚空 processing」——`reopen` 是唯一受支持的回退通道。
 * 来源 aligning/aligned/processing 一律 → open，清 branch/claimedAt/alignedAt，其余字段
 * （id/text/createdAt/tags/dependsOn/历史 notes）原样；从对齐阶段撤销必须带 --note
 * （与 complete 的对齐阶段收口同口径）；done 拒绝、已是 open 幂等。陈旧对齐文档先归档
 * （`.reopened-<UTC 紧凑>.md`）再写 JSON：归档失败整体中止、不写盘。
 * 不碰依赖语义（来源状态本来都不是 done）与 git/worktree。
 */
function runReopen(deps: WriteDeps): number {
  const { repoRoot, opts, now, log } = deps;
  const file = resolveTodoPath(String(opts.file), repoRoot) as string;
  const name = path.basename(file, ".json");
  const match = String(opts.match ?? "");
  type ReopenOutcome =
    | { ok: true; changed: boolean; archived: string | null }
    | { ok: false; message: string };
  const result = withTodoLock(repoRoot, name, (): ReopenOutcome => {
    const all = readTodoDocs(repoRoot);
    if (!all.ok) return { ok: false, message: all.message };
    const gate = globalIdGateMessage(all.docs);
    if (gate !== null) return { ok: false, message: gate };
    const doc = all.docs.find((item) => item.name === name);
    if (doc === undefined) return { ok: false, message: `找不到 todo 文件：${opts.file}` };
    const located = locateEntry(doc.data, match);
    if (!("entry" in located)) {
      return { ok: false, message: `${located.code}：${located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围"}` };
    }
    const entry = located.entry;
    if (entry.status === "open") return { ok: true, changed: false, archived: null };
    if (entry.status === "done") return { ok: false, message: "ALREADY_DONE：条目已完成，撤销已完成条目请另条登记" };
    const source = entry.status;
    const note = opts.note;
    const hasNote = typeof note === "string" && note !== "";
    // 撤销对齐阶段的条目 = 推翻对齐结论，必须留原因（人工门的留痕）；
    // processing 已开工，撤销原因由注记前缀承载，--note 可选。
    if (!hasNote && (source === "aligning" || source === "aligned")) {
      return { ok: false, message: "NOTE_REQUIRED：从对齐阶段撤销必须带 --note 说明原因" };
    }

    // 归档先于写盘：规范路径腾空后，重新 claim → align 必须重写新文档，
    // 否则旧文档会零人工二次过门。文档不存在（虚空 processing 即是）跳过、正常通过。
    const stamp = now();
    let archived: string | null = null;
    const docPath = alignDocPath(repoRoot, name, entry.id);
    if (fs.existsSync(docPath)) {
      const archive = archiveStamp(stamp);
      const rel = reopenArchiveRelPath(name, entry.id, archive);
      const target = reopenArchivePath(repoRoot, name, entry.id, archive);
      if (fs.existsSync(target)) return { ok: false, message: `ALIGN_ARCHIVE_FAILED：归档目标已存在 ${rel}` };
      try {
        fs.renameSync(docPath, target);
      } catch {
        return { ok: false, message: `ALIGN_ARCHIVE_FAILED：归档失败 ${rel}` };
      }
      archived = rel;
    }

    entry.status = "open";
    entry.branch = null;
    entry.claimedAt = null;
    entry.alignedAt = null;
    entry.notes.push(`撤销 ${stamp.slice(0, 10)}：从 ${source} 回到未领取${hasNote ? `；${note}` : ""}`);
    writeTodoData(repoRoot, file, doc.data);
    return { ok: true, changed: true, archived };
  });
  if (!result.ok) {
    log(result.message);
    return 1;
  }
  if (!result.value.ok) {
    log(result.value.message);
    return 1;
  }
  const { changed, archived } = result.value;
  log(`已撤销（${changed ? "已写入" : "状态未变"}）：${opts.file} · ${match}`);
  if (archived !== null) log(`对齐文档已归档：${archived}`);
  return 0;
}

/**
 * dep add / dep remove：增删直接依赖（todo-cli-todo:10）。与 add/claim 同一条锁 + 原子写；
 * add 去重保序追加且落盘前校验（悬空/自引用/环），remove 只删已声明的引用（否则 DEP_ABSENT）；
 * 两者都不动时间戳，变更后无变化则幂等返回「状态未变」。
 */
function runDep(deps: WriteDeps): number {
  const { repoRoot, opts, log } = deps;
  const sub = String((opts._ as string[])[1] ?? "");
  if (sub !== "add" && sub !== "remove") {
    log(`未知 dep 子命令：${sub}（可用：add --file <名> --match "子串" --on a#1,b#2 | remove ...）`);
    return 1;
  }
  const on = opts.on;
  if (on === undefined || on === "") {
    log("缺少 --on <文件#id>（逗号分隔多个）");
    return 1;
  }
  const parsed = parseDepRefsOption(on, "--on");
  if (!parsed.ok) {
    log(parsed.message);
    return 1;
  }
  const file = resolveTodoPath(String(opts.file), repoRoot) as string;
  const name = path.basename(file, ".json");
  const match = String(opts.match ?? "");
  type DepOutcome = { ok: true; changed: boolean; id: number } | { ok: false; message: string };
  const result = withTodoLock(repoRoot, name, (): DepOutcome => {
    const all = readTodoDocs(repoRoot);
    if (!all.ok) return { ok: false, message: all.message };
    const gate = globalIdGateMessage(all.docs);
    if (gate !== null) return { ok: false, message: gate };
    const doc = all.docs.find((item) => item.name === name);
    if (doc === undefined) return { ok: false, message: `找不到 todo 文件：${opts.file}` };
    const located = locateEntry(doc.data, match);
    if (!("entry" in located)) {
      return { ok: false, message: `${located.code}：${located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围"}` };
    }
    const entry = located.entry;
    const before = entry.dependsOn;
    if (sub === "add") {
      const merged = [...before];
      for (const ref of parsed.refs) if (!merged.includes(ref)) merged.push(ref);
      if (merged.length === before.length) return { ok: true, changed: false, id: entry.id };
      const problems = checkDepWrite({ file: name, id: entry.id, dependsOn: merged }, depIndex(all.docs));
      if (problems.length > 0) return { ok: false, message: problems.map(depProblemMessage).join("\n") };
      entry.dependsOn = merged;
    } else {
      const absent = parsed.refs.find((ref) => !before.includes(ref));
      if (absent !== undefined) return { ok: false, message: `DEP_ABSENT：该条目未声明依赖 ${absent}` };
      entry.dependsOn = before.filter((ref) => !parsed.refs.includes(ref));
    }
    writeTodoData(repoRoot, file, doc.data);
    return { ok: true, changed: true, id: entry.id };
  });
  if (!result.ok) {
    log(result.message);
    return 1;
  }
  if (!result.value.ok) {
    log(result.value.message);
    return 1;
  }
  const verb = sub === "add" ? "已更新依赖" : "已移除依赖";
  log(`${verb}（${result.value.changed ? "已写入" : "状态未变"}）：${name}#${result.value.id} · ${parsed.refs.join(", ")}`);
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
        // 值标志：下一个 token 作为值；缺失或以 -- 开头则记空串（让下游报「缺少」而非静默 undefined）。
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) opts[key] = "";
        else {
          opts[key] = value;
          i += 1;
        }
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
  // --file 归一：resolveTodoPath 解析出规范文件后，用 docs 里的真实归属名回填 filter。
  // 缺了这一步，`--file general` 会与 doc.name（general-todo）精确比较落空 → 静默空结果；
  // 大小写不符等解析不出的输入落进同一句明确报错，不倒向「空结果」。
  const fileOpt = typeof opts.file === "string" && opts.file !== "" ? opts.file : undefined;
  const resolvedFile = fileOpt === undefined ? undefined : resolveTodoPath(fileOpt, repoRoot);
  const doc = resolvedFile === undefined ? undefined : all.docs.find((item) => item.file === resolvedFile);
  if (fileOpt !== undefined && doc === undefined) {
    log(`找不到 todo 文件：${fileOpt}`);
    return 1;
  }
  const docs = doc === undefined ? all.docs : [doc];
  const parsed = parseFilterOptions(opts);
  if (!parsed.ok) {
    log(parsed.message);
    return 1;
  }
  if (doc !== undefined) parsed.filter.file = doc.name;
  const blocked = blockedByMap(depIndex(all.docs));
  const entries: QueryEntry[] = docs.flatMap((doc) =>
    doc.data.entries.map((entry) => ({
      ...entry,
      file: doc.name,
      // 阻塞是派生字段：非 done 且存在未完成（或悬空）的直接依赖；done 条目不算阻塞。
      blockedBy: entry.status === "done" ? [] : (blocked.get(`${doc.name}#${entry.id}`) ?? []),
    })),
  );
  const sorted = sortQueryEntries(applyEntryFilter(entries, parsed.filter));
  for (const line of serializeEntries(sorted, { json: parsed.json })) log(line);
  return 0;
}

function runTriage(repoRoot: string, opts: Record<string, unknown>, deps: Record<string, unknown>, log: (line: string) => void): number {
  const execGit =
    (deps.execGit as ((args: string[], cwd?: string) => string) | undefined) ??
    ((args: string[], cwd?: string) =>
      execFileSync("git", ["-C", cwd ?? repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  // triage 的事实全部来自 git；根不是仓库（--root 指到非 git 目录）时 fail-closed 而非抛栈。
  let worktrees: ReturnType<typeof parseWorktrees> = [];
  let mergedBranches: string[] = [];
  try {
    worktrees = parseWorktrees(execGit(["worktree", "list", "--porcelain"]));
    const mainWorktree = worktrees.find((w) => !w.bare) ?? null;
    mergedBranches = mainWorktree?.branch
      ? parseMergedBranches(execGit(["branch", "--merged", String(mainWorktree.branch)]))
      : [];
  } catch {
    log(`triage 失败：${repoRoot} 不是 git 仓库（或 git 不可用）`);
    return 1;
  }
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
  const stages: Array<[string, typeof p]> = [
    ["aligning", report.aligning],
    ["aligned", report.aligned],
    ["processing", report.processing],
  ];
  for (const [label, stage] of stages) {
    log(`${label} 条目：${stage.total}（有工作台 ${stage.active.length} · 引用分支已消失 ${stage.stale.length} · 无分支引用 ${stage.noRef.length}）`);
    for (const item of stage.stale) log(`  ⚠ ${item.name}#${item.id} 引用 ${item.ref}，已无对应 worktree`);
    for (const item of stage.noRef) log(`  · ${item.name}#${item.id} 无分支引用（人工确认状态）`);
  }
  log(report.orphanDirs.length === 0 ? "孤儿目录：无" : `孤儿目录：${report.orphanDirs.join("、")}`);
  return 0;
}

const USAGE = `用法：
  node .agents/skills/todo-cli/todo-cli/todo.mjs summary [--json]
  node .agents/skills/todo-cli/todo-cli/todo.mjs list [--status open|aligning|aligned|processing|done] [--file <name>]
  node .agents/skills/todo-cli/todo-cli/todo.mjs add --file <name> "需求描述" [--tag 词1,词2] [--dep 文件#id,...]
  node .agents/skills/todo-cli/todo-cli/todo.mjs claim --file <name> --match "子串" [--branch feat/x]
  node .agents/skills/todo-cli/todo-cli/todo.mjs align --file <name> --match "子串" [--note "说明"]
  node .agents/skills/todo-cli/todo-cli/todo.mjs complete --file <name> --match "子串" [--note "说明"]
  node .agents/skills/todo-cli/todo-cli/todo.mjs reopen --file <name> --match "子串" [--note "原因"]
  node .agents/skills/todo-cli/todo-cli/todo.mjs dep add|remove --file <name> --match "子串" --on 文件#id,...
  node .agents/skills/todo-cli/todo-cli/todo.mjs lint
  node .agents/skills/todo-cli/todo-cli/todo.mjs triage [--json]
  node .agents/skills/todo-cli/todo-cli/todo.mjs list [--branch <ref>] [--tag <词>] [--text <关键词>] [--claimed-since <YYYY-MM-DD>] [--json]
  node .agents/skills/todo-cli/todo-cli/todo.mjs migrate from-md [--dry-run] [--force] | to-md | global-id [--dry-run]

仓库根默认由 git 自动发现（cwd 起）；也可在任意子命令前追加 --root <dir> 显式指定。`;

/** 需要仓库根的子命令（help / 裸调用 / 未知命令都不要求 cwd 在 git 仓库内）。 */
const REPO_COMMANDS = new Set(["summary", "list", "add", "claim", "align", "complete", "reopen", "dep", "lint", "triage", "migrate"]);

/**
 * 执行一次 CLI 调用，返回退出码（测试在临时仓库上闭环）。
 * repoRoot / log / now / execGit 可注入；文件读写始终走真实 fs（锁 + 原子写是
 * 被测行为本身，不做注入替身）。
 */
export function main(argv: string[], deps: Record<string, unknown> = {}): number {
  const log = (deps.log as ((line: string) => void) | undefined) ?? ((line: string) => console.log(line));
  const now = (deps.now as (() => string) | undefined) ?? (() => new Date().toISOString());
  installProcessHooks();
  const opts = parseArgs(argv);
  const command = (opts._ as string[])[0] ?? (opts.help ? "help" : "");

  if (command === "help" || command === "") {
    log(USAGE);
    return command === "" && !opts.help ? 1 : 0;
  }

  if (!REPO_COMMANDS.has(command)) {
    log(`未知命令：${command}\n${USAGE}`);
    return 1;
  }

  // 仓库根：deps.repoRoot（测试注入）> --root <dir> > git 自动发现；都拿不到就 fail-closed。
  const injectedRoot = deps.repoRoot as string | undefined;
  const resolvedRoot =
    injectedRoot === undefined
      ? resolveRepoRoot({
          rootFlag: opts.root,
          cwd: deps.cwd as string | undefined,
          execGit: deps.execGit as ((args: string[], cwd: string) => string) | undefined,
        })
      : { ok: true as const, root: injectedRoot };
  if (!resolvedRoot.ok) {
    log(resolvedRoot.message);
    return 1;
  }
  const repoRoot = resolvedRoot.root;

  if (command === "summary") {
    const all = readTodoDocs(repoRoot);
    if (!all.ok) {
      log(all.message);
      return 1;
    }
    const rows = summarizeData(all.docs);
    if (opts.json) log(JSON.stringify(rows, null, 2));
    else for (const r of rows) log(`${r.name.padEnd(24)} open ${r.open}  aligning ${r.aligning}  aligned ${r.aligned}  processing ${r.processing}  done ${r.done}  total ${r.total}`);
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
    if (sub === "global-id") return migrateGlobalId(repoRoot, { log, dryRun: opts["dry-run"] === true });
    log(`未知 migrate 子命令：${sub ?? ""}（可用：from-md [--dry-run] [--force] | to-md | global-id [--dry-run]）`);
    return 1;
  }

  if (command === "add" || command === "claim" || command === "align" || command === "complete" || command === "reopen" || command === "dep") {
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
    if (command === "dep") return runDep({ repoRoot, opts, log });
    if (command === "claim") return runClaim({ repoRoot, opts, now, log });
    if (command === "align") return runAlign({ repoRoot, opts, now, log });
    if (command === "reopen") return runReopen({ repoRoot, opts, now, log });
    return runComplete({ repoRoot, opts, now, log });
  }

  // REPO_COMMANDS 已在上方穷举，走到这里说明命令表与分派漂移了（防御性兜底，非用户路径）。
  log(`未知命令：${command}\n${USAGE}`);
  return 1;
}
