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
 *   node tools/todo.mjs claim --file general --match "需求描述"
 *   node tools/todo.mjs complete --file general --match "需求描述" [--note "feat/x：说明"]
 *   node tools/todo.mjs lint
 *
 * 纯函数（parseTodoFile / summarize / findDuplicates / appendEntry / setProcessing /
 * completeEntry / resolveTodoPath / normalizeText）导出给 `test/todo-cli.test.ts` 单测；
 * `main` 同时供测试在临时目录上闭环演练。
 */

import * as fs from "node:fs";
import * as path from "node:path";
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

/** 领取：给唯一条目标注 `（processing）`；已标注时幂等。 */
export function setProcessing(content, match) {
  const located = locateEntry(content, match);
  if (!located.entry) {
    return { ok: false, code: located.code, message: located.code === "NOT_FOUND" ? "没有匹配条目" : "匹配到多条，请缩小范围" };
  }
  const { entry, lines, eol } = located;
  if (entry.processing) return { ok: true, content, changed: false };
  lines[entry.line - 1] = `${lines[entry.line - 1]}（processing）`;
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
  node tools/todo.mjs claim --file <name> --match "子串"
  node tools/todo.mjs complete --file <name> --match "子串" [--note "说明"]
  node tools/todo.mjs lint`;

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
    const result = command === "claim" ? setProcessing(content, match) : completeEntry(content, match, opts.note);
    if (!result.ok) {
      log(`${result.code}：${result.message}`);
      return 1;
    }
    if (result.changed) writeFile(file, result.content);
    log(`${command === "claim" ? "已领取" : "已完成"}（${result.changed ? "已写入" : "状态未变"}）：${opts.file} · ${match}`);
    return 0;
  }

  log(`未知命令：${command}\n${USAGE}`);
  return 1;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
