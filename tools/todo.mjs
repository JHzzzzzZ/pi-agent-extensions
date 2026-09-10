/**
 * tools/todo.mjs — agentic todo CLI（GOAL.md §2「自己这把」+ AGENTS.md 需求登记纪律）
 *
 * 背景：todos/ 工作流的规则（查重、路由、processing 标注、完成收口）目前只写在
 * skill 里，靠 agent 人工 grep + edit 执行——格式破坏、漏查重、错文件都发生过风险。
 * 本工具把「读/写 todos/ 文件」变成可重复的原子操作：解析、状态判定、跨文件查重、
 * 追加、领取标注、完成勾选与 lint 全部是纯函数，CLI 只做参数解析与文件落地。
 *
 * 设计边界（对齐 AGENTS.md 规则 2/7）：
 *   - 只读写仓库 `todos/` 目录内的文件，路径穿越直接拒绝；
 *   - 不自动 commit，不碰 `todos/` 之外的任何文件；
 *   - 登记（add）不做 processing 标注，领取（claim）才标注——动作显式分离；
 *   - `lint` 只校验「根 package.json pi.extensions 注册的扩展都有同名 todo 文件」
 *     这一个方向（未实现插件的 todo 文件合法，不报）。
 *
 * 用法（仓库根）：
 *   node tools/todo.mjs summary [--json]
 *   node tools/todo.mjs list [--status open|processing|done] [--file general]
 *   node tools/todo.mjs add --file general "需求描述"        # 跨全部文件查重
 *   node tools/todo.mjs claim --file general --match "需求描述" [--branch feat/x]
 *   node tools/todo.mjs complete --file general --match "需求描述" [--note "feat/x：说明"]
 *   node tools/todo.mjs lint
 *   node tools/todo.mjs triage [--json]           # 只读：worktree 事实 × 条目关联
 *
 * 纯函数（parseTodoFile / summarize / findDuplicates / appendEntry / setProcessing /
 * completeEntry / resolveTodoPath / normalizeText / parseWorktrees / parseMergedBranches /
 * triageRepo）导出给 `test/todo-cli.test.ts` 单测；`main` 同时供测试在临时目录上闭环演练。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

const ENTRY_RE = /^\s*-\s+\[([ xX])\]\s+(.*)$/;
const PROCESSING_RE = /[（(]processing[^）)]*[）)]/;

/** 行尾探测：真实 todos/ 多为 CRLF，读写都必须保持原样（否则整文件 diff）。 */
function detectEol(content) {
  return String(content).includes("\r\n") ? "\r\n" : "\n";
}

/** 拆行并剥掉尾 \r（正则的 `.*$` 匹配不到 \r），写回时用 eol 还原。 */
function splitLines(content) {
  const lines = String(content).split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  return { lines, eol: detectEol(content) };
}

// ---------------------------------------------------------------------------
// 解析与状态
// ---------------------------------------------------------------------------

/** 解析一个 todo 文件的条目（忽略不带 checkbox 的缩进说明行）。 */
export function parseTodoFile(content) {
  const entries = [];
  const { lines } = splitLines(content);
  for (let i = 0; i < lines.length; i += 1) {
    const match = ENTRY_RE.exec(lines[i]);
    if (!match) continue;
    const text = match[2].trim();
    const checked = match[1] !== " ";
    const processing = !checked && PROCESSING_RE.test(text);
    entries.push({
      line: i + 1,
      checked,
      processing,
      status: checked ? "done" : processing ? "processing" : "open",
      text,
    });
  }
  return entries;
}

/** 按文件汇总三态计数（name 为不带 .md 的文件名）。 */
export function summarize(docs) {
  return docs.map((doc) => {
    const entries = parseTodoFile(doc.content);
    return {
      name: doc.name,
      open: entries.filter((e) => e.status === "open").length,
      processing: entries.filter((e) => e.status === "processing").length,
      done: entries.filter((e) => e.status === "done").length,
      total: entries.length,
    };
  });
}

// ---------------------------------------------------------------------------
// 查重
// ---------------------------------------------------------------------------

/** 归一化：去掉标注括号、空白与句读，转小写——"同一需求换个说法"要能撞上。 */
export function normalizeText(text) {
  return String(text)
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/[\s\u3000]/g, "")
    .replace(/[。！？!?.,，、;；:：]/g, "")
    .toLowerCase();
}

/**
 * 跨文件查重：归一化全等 = exact，一方包含另一方（长度 ≥ 8）= similar。
 * 返回 [{ name, line, status, text, kind }]。
 */
export function findDuplicates(text, docs) {
  const norm = normalizeText(text);
  if (norm.length === 0) return [];
  const hits = [];
  for (const doc of docs) {
    for (const entry of parseTodoFile(doc.content)) {
      const other = normalizeText(entry.text);
      if (other.length === 0) continue;
      if (other === norm) {
        hits.push({ name: doc.name, line: entry.line, status: entry.status, text: entry.text, kind: "exact" });
      } else if (norm.length >= 8 && other.includes(norm)) {
        hits.push({ name: doc.name, line: entry.line, status: entry.status, text: entry.text, kind: "similar" });
      } else if (other.length >= 8 && norm.includes(other)) {
        hits.push({ name: doc.name, line: entry.line, status: entry.status, text: entry.text, kind: "similar" });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 写操作（纯函数，输入输出都是文件内容字符串）
// ---------------------------------------------------------------------------

/** 追加一条未领取条目（`- [ ]`），保留原文件行尾与尾行。 */
export function appendEntry(content, text) {
  const base = String(content);
  const eol = detectEol(base);
  const head = base === "" || base.endsWith("\n") ? base : `${base}${eol}`;
  return `${head}- [ ] ${text}${eol}`;
}

/** 唯一定位含 match 的条目；返回 { entry, lines, eol } 或 { code }。 */
function locateEntry(content, match) {
  const { lines, eol } = splitLines(content);
  const hits = parseTodoFile(content).filter((e) => e.text.includes(match));
  if (hits.length === 0) return { code: "NOT_FOUND" };
  if (hits.length > 1) return { code: "AMBIGUOUS", hits };
  return { entry: hits[0], lines, eol };
}

/** 领取：给唯一条目标注 `（processing [@ feat/branch]）`；已标注时幂等。 */
export function setProcessing(content, match, ref) {
  const located = locateEntry(content, match);
  if (!located.entry) {
    return { ok: false, code: located.code, message: located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围" };
  }
  const { entry, lines, eol } = located;
  if (entry.processing) return { ok: true, content, changed: false };
  const marker = ref ? `（processing @ ${String(ref).replace(/[）)]/g, " ")}）` : "（processing）";
  lines[entry.line - 1] = `${lines[entry.line - 1]}${marker}`;
  return { ok: true, content: lines.join(eol), changed: true };
}

/** 完成：勾选 `[x]`、去掉 processing 标注，可附 `（完成 <note>）`。 */
export function completeEntry(content, match, note) {
  const located = locateEntry(content, match);
  if (!located.entry) {
    return { ok: false, code: located.code, message: located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围" };
  }
  const { entry, lines, eol } = located;
  if (entry.checked) return { ok: true, content, changed: false };
  let line = lines[entry.line - 1].replace(/\[ \]/, "[x]").replace(PROCESSING_RE, "");
  if (note) line += `（完成 ${String(note).replace(/[）)]/g, " ")}）`;
  lines[entry.line - 1] = line;
  return { ok: true, content: lines.join(eol), changed: true };
}

// ---------------------------------------------------------------------------
// 路径与读取
// ---------------------------------------------------------------------------

/** todo 文件路径解析：只允许 `todos/` 下的一层文件名，拒绝穿越。 */
export function resolveTodoPath(nameOrFile, repoRoot = REPO_ROOT) {
  const clean = String(nameOrFile).trim();
  if (clean === "" || clean.includes("/") || clean.includes("\\") || clean.includes("..")) return null;
  const file = clean.endsWith(".md") ? clean : clean.endsWith("-todo") ? `${clean}.md` : `${clean}-todo.md`;
  return path.join(repoRoot, "todos", file);
}

/** 读取 `todos/` 全部 .md 文件（按文件名排序），name = 去 .md。 */
export function loadTodos(repoRoot = REPO_ROOT) {
  const dir = path.join(repoRoot, "todos");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f.slice(0, -3), file: path.join(dir, f), content: fs.readFileSync(path.join(dir, f), "utf8") }));
}

/** lint：根 package.json 注册的扩展都应有同名 todo 文件。返回问题清单。 */
export function lintTodos(repoRoot = REPO_ROOT) {
  const manifestPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(manifestPath)) return ["找不到根 package.json"];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dirs = (manifest.pi?.extensions ?? []).map((e) => path.basename(path.dirname(String(e))));
  const problems = [];
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(repoRoot, "todos", `${dir}-todo.md`))) problems.push(`扩展 ${dir} 缺少 todos/${dir}-todo.md`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// triage：git worktree 事实 × todos 条目（只读）
// ---------------------------------------------------------------------------

/** 解析 `git worktree list --porcelain`：块间空行分隔，branch 去掉 refs/heads/ 前缀。 */
export function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
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
export function parseMergedBranches(stdout) {
  return String(stdout)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line).replace(/^[*+]?\s*/, "").trim())
    .filter((b) => b !== "" && !b.startsWith("remotes/") && !b.startsWith("("));
}

const PROCESSING_REF_RE = /@\s*([^\s：:，,）)]+)/;

function normalizePath(p) {
  return String(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

/**
 * 只读 triage：把 worktree 事实与 todos 条目互相映射。
 * facts：{ worktrees, mergedBranches, docs, exists(path), dirty(path), orphanDirs }
 * 判定优先级：missing > merged-dirty > cleanup > orphan > active；条目关联靠
 * “‘条目文本包含该分支名”匹配（processing 注记里的 `@ feat/<plugin>-<事项>` 是现有纪律）。
 */
export function triageRepo(facts = {}) {
  const worktrees = facts.worktrees ?? [];
  const mergedSet = new Set(facts.mergedBranches ?? []);
  const dirExists = facts.exists ?? (() => true);
  const dirtyCount = facts.dirty ?? (() => 0);
  const main = worktrees.find((w) => !w.bare) ?? null;
  const mainPath = main ? normalizePath(main.path) : null;
  const entries = (facts.docs ?? []).flatMap((doc) => parseTodoFile(doc.content).map((e) => ({ ...e, name: doc.name })));
  const pending = entries.filter((e) => !e.checked);

  const listed = worktrees
    .filter((w) => !mainPath || normalizePath(w.path) !== mainPath)
    .map((w) => {
      const linked = w.branch ? pending.filter((e) => e.text.includes(w.branch)) : [];
      const exists = dirExists(w.path);
      const dirty = exists ? dirtyCount(w.path) : 0;
      const merged = Boolean(w.branch && mergedSet.has(w.branch));
      const flags = [];
      if (!w.branch) flags.push(w.detached ? "detached" : "no-branch");
      if (!exists) flags.push("missing-dir");
      if (merged) flags.push("merged");
      if (dirty > 0) flags.push("dirty");
      if (w.branch && linked.length === 0) flags.push("no-todo");
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
        branch: w.branch,
        detached: w.detached,
        exists,
        merged,
        dirty,
        state,
        flags,
        entries: linked.map((e) => ({ name: e.name, line: e.line, text: e.text })),
      };
    });

  const liveBranches = new Set(listed.filter((w) => w.branch && w.exists).map((w) => w.branch));
  const processing = pending
    .filter((e) => e.processing)
    .map((e) => {
      const match = PROCESSING_REF_RE.exec(e.text);
      const ref = match ? match[1] : null;
      const kind = ref && ref.includes("/") ? (liveBranches.has(ref) ? "active" : "stale") : "no-ref";
      return { name: e.name, line: e.line, text: e.text, ref, kind };
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
    orphanDirs: facts.orphanDirs ?? [],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const STATUS_MARK = { done: "[x]", processing: "[~]", open: "[ ]" };

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "json" || key === "force" || key === "help") opts[key] = true;
      else {
        opts[key] = argv[i + 1];
        i += 1;
      }
    } else opts._.push(arg);
  }
  return opts;
}

const USAGE = `用法：
  node tools/todo.mjs summary [--json]
  node tools/todo.mjs list [--status open|processing|done] [--file <name>]
  node tools/todo.mjs add --file <name> "需求描述"
  node tools/todo.mjs claim --file <name> --match "子串" [--branch feat/x]
  node tools/todo.mjs complete --file <name> --match "子串" [--note "说明"]
  node tools/todo.mjs lint
  node tools/todo.mjs triage [--json]`;

/**
 * 执行一次 CLI 调用，返回退出码（测试在临时仓库上闭环）。
 * readFile/writeFile 可注入用于测试；默认走真实文件系统。
 */
export function main(argv, deps = {}) {
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const log = deps.log ?? ((line) => console.log(line));
  const writeFile = deps.writeFile ?? ((file, content) => fs.writeFileSync(file, content));
  const opts = parseArgs(argv);
  const command = opts._[0] ?? (opts.help ? "help" : "");

  if (command === "help" || command === "") {
    log(USAGE);
    return command === "" && !opts.help ? 1 : 0;
  }

  if (command === "summary") {
    const rows = summarize(loadTodos(repoRoot));
    if (opts.json) log(JSON.stringify(rows, null, 2));
    else for (const r of rows) log(`${r.name.padEnd(24)} open ${r.open}  processing ${r.processing}  done ${r.done}  total ${r.total}`);
    return 0;
  }

  if (command === "list") {
    let docs = loadTodos(repoRoot);
    let file = null;
    if (opts.file) {
      file = resolveTodoPath(opts.file, repoRoot);
      if (!file || !fs.existsSync(file)) {
        log(`找不到 todo 文件：${opts.file}`);
        return 1;
      }
      docs = docs.filter((d) => d.file === file);
    }
    for (const doc of docs) {
      for (const entry of parseTodoFile(doc.content)) {
        if (opts.status && entry.status !== opts.status) continue;
        log(`${STATUS_MARK[entry.status]} ${doc.name}:${entry.line}  ${entry.text}`);
      }
    }
    return 0;
  }

  if (command === "lint") {
    const problems = lintTodos(repoRoot);
    if (problems.length === 0) log("lint 通过：注册扩展与 todo 文件一一对应");
    else for (const p of problems) log(`✗ ${p}`);
    return problems.length === 0 ? 0 : 1;
  }

  if (command === "add" || command === "claim" || command === "complete") {
    if (!opts.file) {
      log("缺少 --file <name>");
      return 1;
    }
    const file = resolveTodoPath(opts.file, repoRoot);
    if (!file) {
      log("--file 只能是 todos/ 下的文件名");
      return 1;
    }
    const exists = fs.existsSync(file);
    const docs = loadTodos(repoRoot);

    if (command === "add") {
      const text = opts._.slice(1).join(" ").trim();
      if (!text) {
        log("缺少需求描述");
        return 1;
      }
      const hits = findDuplicates(text, docs);
      if (hits.length > 0 && !opts.force) {
        for (const h of hits) log(`重复（${h.kind}）：${h.name}:${h.line}  ${h.text}`);
        log("如确认是新需求，加 --force 重新执行");
        return 1;
      }
      const content = exists ? fs.readFileSync(file, "utf8") : `# ${path.basename(file, ".md")} TODO\n\n`;
      writeFile(file, appendEntry(content, text));
      log(`已登记到 ${path.relative(repoRoot, file).replace(/\\/g, "/")}：${text}`);
      return 0;
    }

    if (!exists) {
      log(`找不到 todo 文件：${opts.file}`);
      return 1;
    }
    const match = opts.match;
    if (!match) {
      log("缺少 --match \"子串\"");
      return 1;
    }
    const content = fs.readFileSync(file, "utf8");
    const result = command === "claim" ? setProcessing(content, match, opts.branch) : completeEntry(content, match, opts.note);
    if (!result.ok) {
      log(`${result.code}：${result.message}`);
      return 1;
    }
    if (result.changed) writeFile(file, result.content);
    log(`${command === "claim" ? "已领取" : "已完成"}（${result.changed ? "已写入" : "状态未变"}）：${opts.file} · ${match}`);
    return 0;
  }

  if (command === "triage") {
    const execGit = deps.execGit ?? ((args, cwd) => execFileSync("git", ["-C", cwd ?? repoRoot, ...args], { encoding: "utf8" }));
    const worktrees = parseWorktrees(execGit(["worktree", "list", "--porcelain"]));
    const main = worktrees.find((w) => !w.bare) ?? null;
    const mergedBranches = main?.branch ? parseMergedBranches(execGit(["branch", "--merged", main.branch])) : [];
    const registered = new Set(worktrees.map((w) => normalizePath(w.path)));
    const wtDir = path.join(repoRoot, ".worktrees");
    const orphanDirs = !fs.existsSync(wtDir)
      ? []
      : fs
          .readdirSync(wtDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => `.worktrees/${d.name}`)
          .filter((rel) => !registered.has(normalizePath(path.join(repoRoot, rel))));
    const report = triageRepo({
      worktrees,
      mergedBranches,
      docs: loadTodos(repoRoot),
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
    const STATE_LABEL = {
      active: "活跃",
      cleanup: "已并入主干·干净（清理候选）",
      "merged-dirty": "已并入主干·有未提交改动",
      orphan: "无关联条目",
      missing: "目录已不存在",
    };
    log(`# triage（只读：worktree 事实 × todos 条目关联）`);
    log(`主干：${report.main?.branch ?? "<未知>"} @ ${(report.main?.head ?? "?").slice(0, 7)}  ${report.main?.path ?? ""}`.trimEnd());
    if (report.worktrees.length === 0) log("worktree（主工作区除外）：无");
    else {
      log(`worktree（主工作区除外）：${report.worktrees.length} 个`);
      for (const w of report.worktrees) {
        log(`  [${w.state}·${STATE_LABEL[w.state]}] ${w.branch ?? "(detached)"} @ ${w.head.slice(0, 7)} · 关联条目 ${w.entries.length} · 未提交 ${w.dirty} · ${w.path}`);
      }
    }
    const p = report.processing;
    log(`processing 条目：${p.total}（有工作台 ${p.active.length} · 引用分支已消失 ${p.stale.length} · 无分支引用 ${p.noRef.length}）`);
    for (const item of p.stale) log(`  ⚠ ${item.name}:${item.line} 引用 ${item.ref}，已无对应 worktree`);
    for (const item of p.noRef) log(`  · ${item.name}:${item.line} 无分支引用（人工确认状态）`);
    log(report.orphanDirs.length === 0 ? "孤儿目录：无" : `孤儿目录：${report.orphanDirs.join("、")}`);
    return 0;
  }

  log(`未知命令：${command}\n${USAGE}`);
  return 1;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
