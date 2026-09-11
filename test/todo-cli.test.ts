/**
 * todo CLI 的纯逻辑 + 临时目录功能单测（工具本体见 tools/todo.mjs）。
 *
 * 边界说明：这里覆盖解析/状态判定/查重/标注等可在文件系统边界内验证的行为；
 * 真实仓库 `todos/` 上的写操作只允许在临时 fixture 目录里演练，测试不触碰
 * 仓库真实条目（防止把跑测试变成改待办）。末尾三个进程边界 E2E 只跑只读命令
 * （summary/--help/未知命令），同样不在真实 `todos/` 写入；写操作边界由既有
 * in-process `main(deps)` + 临时 fixture 用例覆盖。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  appendEntry,
  completeEntry,
  findDuplicates,
  main,
  parseMergedBranches,
  parseTodoFile,
  parseWorktrees,
  resolveTodoPath,
  setProcessing,
  summarize,
  triageRepo,
} from "../tools/todo.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODO_CLI = path.join(REPO_ROOT, "tools", "todo.mjs");
const runCli = (args, cwd) =>
  spawnSync(process.execPath, [TODO_CLI, ...args], { cwd, encoding: "utf8", timeout: 30_000 });

const FIXTURE = [
  "# 某插件 TODO",
  "",
  "- [ ] 未领取的条目：做点事情",
  "- [x] 已完成的条目（完成 2026-09-11 @ feat/x）",
  "- [ ] 进行中的条目（processing 2026-09-11 @ feat/y：在做）",
  "  - 子说明不是条目",
  "- [ ] 另一条未领取",
  "",
].join("\n");

test("parseTodoFile：识别勾选/进行中/未领取，忽略缩进说明行", () => {
  const entries = parseTodoFile(FIXTURE);
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((e) => [e.status, e.line]),
    [
      ["open", 3],
      ["done", 4],
      ["processing", 5],
      ["open", 7],
    ],
  );
  assert.match(entries[0].text, /^未领取的条目/);
});

test("summarize：按文件汇总三态计数", () => {
  const summary = summarize([
    { name: "a-todo", content: FIXTURE },
    { name: "b-todo", content: "- [ ] 一条\n" },
  ]);
  assert.deepEqual(summary, [
    { name: "a-todo", open: 2, processing: 1, done: 1, total: 4 },
    { name: "b-todo", open: 1, processing: 0, done: 0, total: 1 },
  ]);
});

test("findDuplicates：跨文件归一化查重（空白/大小写/标注差异不算新）", () => {
  const docs = [
    { name: "general-todo", content: FIXTURE },
    { name: "loop-todo", content: "- [ ] 另一个需求（processing 2026-09-10 @ feat/z）\n" },
  ];
  const hit = findDuplicates("另一个需求", docs);
  assert.deepEqual(hit.map((h) => h.name), ["loop-todo"]);
  assert.equal(findDuplicates("全新的需求描述", docs).length, 0);
});

test("appendEntry：补尾行后追加，不破坏既有内容", () => {
  const out = appendEntry("# t\n\n- [ ] a\n", "b");
  assert.equal(out, "# t\n\n- [ ] a\n- [ ] b\n");
  const noTrailing = appendEntry("# t", "c");
  assert.equal(noTrailing, "# t\n- [ ] c\n");
});

test("setProcessing：唯一定位后加标注，重复标注幂等，缺失/歧义报错", () => {
  const ok = setProcessing(FIXTURE, "未领取的条目");
  assert.equal(ok.ok, true);
  assert.match(ok.content, /- \[ \] 未领取的条目：做点事情（processing）/);

  const withRef = setProcessing(FIXTURE, "未领取的条目", "feat/branch-x");
  assert.match(withRef.content, /（processing @ feat\/branch-x）/, "claim 记录分支引用，triage 才能互映射");

  const again = setProcessing(ok.content, "未领取的条目");
  assert.equal(again.ok, true);
  assert.equal(again.content, ok.content);

  const missing = setProcessing(FIXTURE, "不存在的条目");
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "NOT_FOUND");

  const ambiguous = setProcessing(FIXTURE, "条目");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, "AMBIGUOUS");
});

test("completeEntry：勾选并去 processing，可附完成注记", () => {
  const done = completeEntry(FIXTURE, "进行中的条目", "feat/y：做完");
  assert.equal(done.ok, true);
  assert.match(done.content, /- \[x\] 进行中的条目（完成 feat\/y：做完）/);
  assert.doesNotMatch(done.content, /processing/);

  const plain = completeEntry(FIXTURE, "另一条未领取");
  assert.match(plain.content, /- \[x\] 另一条未领取/);
});

test("CRLF 文件：解析与写回都保持 Windows 行尾（真实 todos/ 是 CRLF）", () => {
  const crlf = "# t\r\n\r\n- [ ] 一条需求\r\n";
  const entries = parseTodoFile(crlf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "一条需求");
  const claimed = setProcessing(crlf, "一条需求");
  assert.equal(claimed.ok, true);
  assert.equal(claimed.content, "# t\r\n\r\n- [ ] 一条需求（processing）\r\n");
  const completed = completeEntry(claimed.content, "一条需求", "feat/x");
  assert.equal(completed.content, "# t\r\n\r\n- [x] 一条需求（完成 feat/x）\r\n");
  assert.equal(appendEntry(crlf, "新条目"), "# t\r\n\r\n- [ ] 一条需求\r\n- [ ] 新条目\r\n");
});

test("resolveTodoPath：只允许 todos/ 内的文件，拒绝路径穿越", () => {
  const root = path.resolve("/tmp/todo-cli-root");
  assert.equal(resolveTodoPath("general", root), path.join(root, "todos", "general-todo.md"));
  assert.equal(resolveTodoPath("general-todo.md", root), path.join(root, "todos", "general-todo.md"));
  assert.equal(resolveTodoPath("../package.json", root), null);
  assert.equal(resolveTodoPath("a/b", root), null);
});

test("main：add/list/claim/complete 在临时仓库上闭环，写操作不外溢", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-"));
  fs.mkdirSync(path.join(root, "todos"));
  fs.writeFileSync(path.join(root, "todos", "general-todo.md"), "# 通用 TODO\n\n");
  const out = [];

  const add = main(["add", "--file", "general", "第一条需求"], { repoRoot: root, log: (l) => out.push(l) });
  assert.equal(add, 0);
  assert.match(fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8"), /- \[ \] 第一条需求\n$/);

  const dup = main(["add", "--file", "general", "第一条需求"], { repoRoot: root, log: (l) => out.push(l) });
  assert.equal(dup, 1);
  assert.match(out.join("\n"), /重复/);

  assert.equal(main(["claim", "--file", "general", "--match", "第一条需求", "--branch", "feat/first"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8"), /（processing @ feat\/first）/);

  assert.equal(main(["complete", "--file", "general", "--match", "第一条需求", "--note", "测试"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8"), /- \[x\] 第一条需求（完成 测试）/);

  assert.equal(main(["list", "--status", "done"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /第一条需求/);
});

// ---------------------------------------------------------------------------
// triage：git worktree 事实 × todos 条目（只读，不写任何文件）
// ---------------------------------------------------------------------------

const PORCELAIN = [
  "worktree C:/repo",
  "HEAD aaaa1111",
  "branch refs/heads/dev-laptop",
  "",
  "worktree C:/repo/.worktrees/live",
  "HEAD bbbb2222",
  "branch refs/heads/feat/live-thing",
  "",
  "worktree C:/repo/.worktrees/merged",
  "HEAD cccc3333",
  "branch refs/heads/feat/merged-thing",
  "",
  "worktree C:/repo/.worktrees/dirty",
  "HEAD dddd4444",
  "branch refs/heads/feat/dirty-thing",
  "",
  "worktree C:/repo/.worktrees/no-todo",
  "HEAD eeee5555",
  "branch refs/heads/feat/no-todo",
  "",
  "worktree C:/repo/.worktrees/gone",
  "HEAD ffff6666",
  "detached",
  "",
].join("\n");

test("parseWorktrees：解析 porcelain 的 path/head/branch/detached", () => {
  const wts = parseWorktrees(PORCELAIN);
  assert.equal(wts.length, 6);
  assert.deepEqual(wts[1], {
    path: "C:/repo/.worktrees/live",
    head: "bbbb2222",
    branch: "feat/live-thing",
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  });
  assert.equal(wts[5].detached, true);
  assert.equal(wts[5].branch, null);
  assert.equal(parseWorktrees("").length, 0);
});

test("parseMergedBranches：剥离 * / + 标记与缩进，忽略 remotes/", () => {
  const merged = parseMergedBranches("* dev-laptop\n+ feat/old\n  feat/new\n  remotes/origin/dev-laptop\n\n");
  assert.deepEqual(merged, ["dev-laptop", "feat/old", "feat/new"]);
});

test("triageRepo：worktree 状态判定 + processing 关联分类 + 孤儿目录透传", () => {
  const docs = [
    {
      name: "a-todo",
      content: [
        "- [ ] 在做的需求（processing 2026-09-11 @ feat/live-thing：在做）",
        "- [x] 已完成（完成 2026-09-11 @ feat/merged-thing）",
        "- [ ] 无分支引用的进行中（processing）",
        "- [ ] 引用已消失的（processing 2026-09-10 @ feat/vanished：等）",
        "",
      ].join("\n"),
    },
  ];
  const report = triageRepo({
    worktrees: parseWorktrees(PORCELAIN),
    mergedBranches: ["dev-laptop", "feat/merged-thing", "feat/dirty-thing"],
    docs,
    exists: (p) => !p.endsWith(".worktrees/gone"),
    dirty: (p) => (p.endsWith(".worktrees/dirty") ? 2 : 0),
    orphanDirs: [".worktrees/orphan"],
  });

  assert.equal(report.main.branch, "dev-laptop");
  assert.deepEqual(
    report.worktrees.map((w) => [w.branch, w.state]),
    [
      ["feat/live-thing", "active"],
      ["feat/merged-thing", "cleanup"],
      ["feat/dirty-thing", "merged-dirty"],
      ["feat/no-todo", "orphan"],
      [null, "missing"],
    ],
  );
  assert.deepEqual(report.worktrees[0].entries.map((e) => [e.name, e.line]), [["a-todo", 1]]);
  assert.ok(report.worktrees[1].flags.includes("merged"));
  assert.ok(report.worktrees[2].flags.includes("dirty"));
  assert.ok(report.worktrees[4].flags.includes("missing-dir"));

  assert.equal(report.processing.total, 3);
  assert.deepEqual(report.processing.active.map((p) => p.ref), ["feat/live-thing"]);
  assert.deepEqual(report.processing.stale.map((p) => [p.line, p.ref]), [[4, "feat/vanished"]]);
  assert.deepEqual(report.processing.noRef.map((p) => p.line), [3]);
  assert.deepEqual(report.orphanDirs, [".worktrees/orphan"]);
});

test("main triage：fake git 事实驱动只读报告，只读不写、--json 可解析", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-triage-"));
  fs.mkdirSync(path.join(root, "todos"));
  fs.writeFileSync(path.join(root, "todos", "a-todo.md"), "- [ ] 需求（processing 2026-09-11 @ feat/live：在做）\n");
  fs.mkdirSync(path.join(root, ".worktrees", "live"), { recursive: true });
  const before = fs.readFileSync(path.join(root, "todos", "a-todo.md"), "utf8");
  const porcelain = [
    `worktree ${root}`,
    "HEAD aaaa1111",
    "branch refs/heads/dev-laptop",
    "",
    `worktree ${path.join(root, ".worktrees", "live")}`,
    "HEAD bbbb2222",
    "branch refs/heads/feat/live",
    "",
  ].join("\n");
  const calls = [];
  const execGit = (args) => {
    calls.push(args[0]);
    if (args[0] === "worktree") return porcelain;
    if (args[0] === "branch") return "* dev-laptop\n";
    if (args[0] === "status") return "";
    throw new Error(`unexpected git: ${args.join(" ")}`);
  };
  const out = [];
  const code = main(["triage", "--json"], { repoRoot: root, execGit, log: (l) => out.push(l) });
  assert.equal(code, 0);
  const report = JSON.parse(out.join("\n"));
  assert.deepEqual(report.worktrees.map((w) => [w.branch, w.state]), [["feat/live", "active"]]);
  assert.equal(report.processing.active[0].ref, "feat/live");
  assert.equal(fs.readFileSync(path.join(root, "todos", "a-todo.md"), "utf8"), before, "triage 不得写 todos/");
  assert.ok(calls.includes("worktree") && calls.includes("branch"));

  const text = [];
  assert.equal(main(["triage"], { repoRoot: root, execGit, log: (l) => text.push(l) }), 0);
  assert.match(text.join("\n"), /feat\/live/);
  assert.match(text.join("\n"), /active/);
});

// ---------------------------------------------------------------------------
// 进程边界 E2E：真实子进程 + 陌生 cwd 跑 CLI 入口（只读，不写真实 todos/）
// ---------------------------------------------------------------------------

test("CLI E2E：任意 cwd 跑 summary 退出 0 且有输出", () => {
  const res = runCli(["summary"], os.tmpdir());
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  assert.ok(res.stdout.trim().length > 0, "summary 输出非空");
  assert.match(res.stdout, /-todo/);
});

test("CLI E2E：--help 退出 0 且含完整用法", () => {
  const res = runCli(["--help"], os.tmpdir());
  assert.equal(res.status, 0);
  assert.match(res.stdout, /用法/);
  for (const sub of ["summary", "list", "add", "claim", "complete", "lint", "triage"]) {
    assert.ok(res.stdout.includes(sub), `用法含子命令 ${sub}`);
  }
});

test("CLI E2E：未知命令退出 1 并提示", () => {
  const res = runCli(["definitely-not-a-command"], os.tmpdir());
  assert.equal(res.status, 1);
  assert.match(res.stdout, /未知命令：definitely-not-a-command/);
  assert.match(res.stdout, /用法/);
  assert.equal(res.stderr, "");
});
