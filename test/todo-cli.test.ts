/**
 * todo CLI 的纯逻辑 + 临时目录功能单测（工具本体见 tools/todo.mjs；方案 C 存储）。
 *
 * 边界说明：这里覆盖查重/路径解析/命令闭环/triage 可在文件系统边界内验证的行为；
 * 存储是 `todos/<名>.json`（方案 C：JSON 唯一权威），写操作走锁 + temp+rename 原子
 * 落盘——并发/中断边界在 todo-cli/test/{lock,concurrency,interrupt}.test.ts 用真实
 * 进程覆盖。本文件只在临时 fixture 目录演练写操作，不触碰仓库真实 todos/；末尾三个
 * 进程边界 E2E 只跑只读命令（summary/--help/未知命令）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  findDuplicateHits,
  main,
  normalizeText,
  parseMergedBranches,
  parseWorktrees,
  resolveTodoPath,
  triageRepo,
} from "../tools/todo.mjs";
import { emptyTodoData, parseTodoJson, serializeTodo } from "../todo-cli/schema.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODO_CLI = path.join(REPO_ROOT, "tools", "todo.mjs");
const runCli = (args, cwd) =>
  spawnSync(process.execPath, [TODO_CLI, ...args], { cwd, encoding: "utf8", timeout: 30_000 });

/** 临时仓库 fixture：写入 todos/<名>.json；不传 content 则建空文件数据。 */
function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-main-"));
  fs.mkdirSync(path.join(root, "todos"));
  for (const [name, data] of Object.entries(files)) {
    const content = data === undefined ? emptyTodoData(name) : data;
    fs.writeFileSync(path.join(root, "todos", `${name}.json`), serializeTodo(content));
  }
  return root;
}

function readRepoData(root, name) {
  const parsed = parseTodoJson(fs.readFileSync(path.join(root, "todos", `${name}.json`), "utf8"), "test");
  assert.equal(parsed.ok, true, `${name}.json 必须始终可解析（原子写不留半态）`);
  return parsed.ok ? parsed.data : null;
}

test("normalizeText / findDuplicateHits：归一化查重口径不变（标注/空白/大小写/句读差异不算新）", () => {
  assert.equal(normalizeText("做点事情（processing）"), normalizeText("做点事情"));
  const entries = [
    { name: "a-todo", id: 1, status: "open", text: "另一个需求描述更长一些" },
    { name: "a-todo", id: 2, status: "open", text: "全新的需求描述在这里" },
  ];
  assert.deepEqual(findDuplicateHits("另一个需求描述更长一些", entries).map((h) => h.kind), ["exact"]);
  assert.deepEqual(findDuplicateHits("另一个需求描述更长", entries).map((h) => [h.id, h.kind]), [[1, "similar"]], "短边 ≥8 的包含算 similar");
  assert.equal(findDuplicateHits("完全无关的新需求", entries).length, 0);
  assert.equal(findDuplicateHits("", entries).length, 0);
});

test("resolveTodoPath：四种输入归一到 todos/<名>.json，拒绝路径穿越", () => {
  const root = path.resolve("/tmp/todo-cli-root");
  const expected = path.join(root, "todos", "general-todo.json");
  assert.equal(resolveTodoPath("general", root), expected);
  assert.equal(resolveTodoPath("general-todo", root), expected);
  assert.equal(resolveTodoPath("general-todo.md", root), expected, "旧 md 引用向后兼容");
  assert.equal(resolveTodoPath("general-todo.json", root), expected);
  assert.equal(resolveTodoPath("../package.json", root), null);
  assert.equal(resolveTodoPath("a/b", root), null);
  assert.equal(resolveTodoPath("", root), null);
});

test("main：add/dup/claim/complete 在临时仓库上闭环，JSON 字段原生落盘", () => {
  const root = makeRepo({ "general-todo": undefined });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-12T00:00:00.000Z" };

  assert.equal(main(["add", "--file", "general", "第一条需求"], deps), 0);
  let data = readRepoData(root, "general-todo");
  assert.equal(data.entries.length, 1);
  assert.deepEqual(data.entries[0], {
    id: 1,
    text: "第一条需求",
    status: "open",
    branch: null,
    tags: [],
    notes: [],
    createdAt: "2026-09-12T00:00:00.000Z",
    claimedAt: null,
    completedAt: null,
  });
  assert.match(out.join("\n"), /已登记到 todos\/general-todo\.json：第一条需求/);

  assert.equal(main(["add", "--file", "general", "第一条需求"], deps), 1, "查重拒绝");
  assert.match(out.join("\n"), /重复（exact）：general-todo#1/);
  assert.equal(data.entries.length, 1, "拒绝时不写入");
  assert.equal(main(["add", "--file", "general", "第二条需求", "--force"], deps), 0, "--force 放行");
  assert.equal(readRepoData(root, "general-todo").entries[1].id, 2, "id 取 max+1");

  assert.equal(main(["claim", "--file", "general", "--match", "第一条需求", "--branch", "feat/first"], deps), 0);
  data = readRepoData(root, "general-todo");
  assert.equal(data.entries[0].status, "processing");
  assert.equal(data.entries[0].branch, "feat/first");
  assert.equal(data.entries[0].claimedAt, "2026-09-12T00:00:00.000Z");

  assert.equal(main(["claim", "--file", "general", "--match", "第一条需求"], deps), 0);
  assert.match(out.join("\n"), /已领取（状态未变）/);
  assert.equal(main(["claim", "--file", "general", "--match", "不存在"], deps), 1);
  assert.match(out.join("\n"), /NOT_FOUND：没有匹配条目/);
  assert.equal(main(["claim", "--file", "general", "--match", "条"], deps), 1);
  assert.match(out.join("\n"), /AMBIGUOUS：匹配到多条/);

  assert.equal(main(["complete", "--file", "general", "--match", "第一条需求"], deps), 0);
  data = readRepoData(root, "general-todo");
  assert.equal(data.entries[0].status, "done");
  assert.equal(data.entries[0].completedAt, "2026-09-12T00:00:00.000Z");
  assert.deepEqual(data.entries[0].notes, [], "无 --note 不加注记");

  assert.equal(main(["claim", "--file", "general", "--match", "第一条需求"], deps), 1, "已完成条目不可领取");
  assert.match(out.join("\n"), /ALREADY_DONE：条目已完成，不能再领取/);
  assert.equal(main(["complete", "--file", "general", "--match", "第一条需求"], deps), 0);
  assert.match(out.join("\n"), /已完成（状态未变）/);
});

test("main：complete --note 原样进 notes——含全角括号、换行、超长备注都不解析不吞字（L16 收口）", () => {
  const root = makeRepo({ "general-todo": undefined });
  const deps = { repoRoot: root, log: () => {}, now: () => "2026-09-12T00:00:00.000Z" };
  assert.equal(main(["add", "--file", "general", "带坑备注的条目"], deps), 0);

  const note = "feat/x：见 statusTaskText(）与（完成 括号）混排\n第二行说明——（（嵌套））超长" + "尾".repeat(400);
  assert.equal(main(["complete", "--file", "general", "--match", "带坑备注", "--note", note], deps), 0);
  const data = readRepoData(root, "general-todo");
  assert.deepEqual(data.entries[0].notes, [note], "note 逐字节保真（不吞括号、不重复前缀）");

  assert.equal(main(["add", "--file", "general", "无备注条目"], deps), 0);
  assert.equal(main(["complete", "--file", "general", "--match", "无备注条目"], deps), 0);
  assert.deepEqual(readRepoData(root, "general-todo").entries[1].notes, []);
});

test("main：add --tag 原生标签字段 + list --tag 精确过滤", () => {
  const root = makeRepo({ "general-todo": undefined });
  const deps = { repoRoot: root, log: () => {}, now: () => "2026-09-12T00:00:00.000Z" };
  assert.equal(main(["add", "--file", "general", "标签条目", "--tag", "性能, 存储 ,性能"], deps), 0);
  assert.deepEqual(readRepoData(root, "general-todo").entries[0].tags, ["性能", "存储"], "去空格去重保序");

  const out = [];
  assert.equal(main(["list", "--tag", "性能"], { ...deps, log: (l) => out.push(l) }), 0);
  assert.deepEqual(out, ["[ ] general-todo#1  标签条目"]);
});

test("main：list 人读行 `${mark} ${file}#${id}  text`；--status/--text/--claimed-since 组合", () => {
  const root = makeRepo({
    "general-todo": {
      version: 1,
      title: "通用 TODO",
      entries: [
        { id: 1, text: "未领取", status: "open", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
        { id: 2, text: "进行中", status: "processing", branch: "feat/a", tags: [], notes: [], createdAt: null, claimedAt: "2026-09-12T00:00:00.000Z", completedAt: null },
        { id: 3, text: "已完成", status: "done", branch: null, tags: [], notes: ["收尾"], createdAt: null, claimedAt: "2026-09-11T00:00:00.000Z", completedAt: "2026-09-11T00:00:00.000Z" },
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l) };

  assert.equal(main(["list"], deps), 0);
  assert.deepEqual(out, ["[ ] general-todo#1  未领取", "[~] general-todo#2  进行中", "[x] general-todo#3  已完成"]);

  out.length = 0;
  assert.equal(main(["list", "--status", "done"], deps), 0);
  assert.deepEqual(out, ["[x] general-todo#3  已完成"]);

  out.length = 0;
  assert.equal(main(["list", "--branch", "feat/a", "--json"], deps), 0);
  const rows = JSON.parse(out.join("\n"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 2);
  assert.equal(rows[0].claimedAt, "2026-09-12T00:00:00.000Z");

  out.length = 0;
  assert.equal(main(["list", "--claimed-since", "2026-09-12"], deps), 0, "时间维度是一等公民（无降级）");
  assert.deepEqual(out, ["[~] general-todo#2  进行中"]);

  out.length = 0;
  assert.equal(main(["list", "--text", "注记内容不存在"], deps), 0);
  assert.deepEqual(out, [], "--match/--text 只匹配纯描述 text，不进 notes");
});

test("main：损坏 JSON fail-closed——summary/list/add 都明确报错退出 1，绝不静默修复", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-corrupt-"));
  fs.mkdirSync(path.join(root, "todos"));
  fs.writeFileSync(path.join(root, "todos", "bad-todo.json"), "<<<<<<< HEAD\n{}\n>>>>>>> other\n");
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  const out = [];
  for (const args of [["summary"], ["list"], ["add", "--file", "bad", "x"]]) {
    out.length = 0;
    assert.equal(main(args, { repoRoot: root, log: (l) => out.push(l) }), 1, `${args.join(" ")} 应 exit 1`);
    assert.match(out.join("\n"), /不是合法 JSON.*合并冲突/s);
  }
  assert.equal(fs.readFileSync(path.join(root, "todos", "bad-todo.json"), "utf8").includes("<<<<<<<"), true, "不写入不修复");
});

test("summary：按文件三态计数（.json 文件名）", () => {
  const root = makeRepo({
    "a-todo": {
      version: 1,
      title: "a",
      entries: [
        { id: 1, text: "甲", status: "open", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
        { id: 2, text: "乙", status: "done", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
      ],
    },
    "b-todo": {
      version: 1,
      title: "b",
      entries: [
        { id: 1, text: "丙", status: "processing", branch: "feat/x", tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
      ],
    },
  });
  const out = [];
  assert.equal(main(["summary"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /a-todo\s+open 1  processing 0  done 1  total 2/);
  assert.match(out.join("\n"), /b-todo\s+open 0  processing 1  done 0  total 1/);

  const json = [];
  assert.equal(main(["summary", "--json"], { repoRoot: root, log: (l) => json.push(l) }), 0);
  const rows = JSON.parse(json.join("\n"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "a-todo");
});

test("lint：注册扩展 ↔ todos/<名>-todo.json 一一对应（一个方向）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-lint-"));
  fs.mkdirSync(path.join(root, "todos"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./myext/index.ts"] } }));
  const out = [];
  assert.equal(main(["lint"], { repoRoot: root, log: (l) => out.push(l) }), 1);
  assert.match(out.join("\n"), /✗ 扩展 myext 缺少 todos\/myext-todo\.json/);
  fs.writeFileSync(path.join(root, "todos", "myext-todo.json"), serializeTodo(emptyTodoData("myext-todo")));
  out.length = 0;
  assert.equal(main(["lint"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /lint 通过/);
});

// ---------------------------------------------------------------------------
// triage：git worktree 事实 × todos 条目（branch 原生字段精确相等，只读）
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

const TRIAGE_DOCS = [
  {
    name: "a-todo",
    data: {
      version: 1,
      title: "a",
      entries: [
        { id: 1, text: "在做的需求", status: "processing", branch: "feat/live-thing", tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
        { id: 2, text: "已完成", status: "done", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
        { id: 3, text: "无分支引用的进行中", status: "processing", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
        { id: 4, text: "引用已消失的", status: "processing", branch: "feat/vanished", tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
      ],
    },
  },
];

test("parseWorktrees / parseMergedBranches：porcelain 与 merged 解析不变", () => {
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
  assert.deepEqual(parseMergedBranches("* dev-laptop\n+ feat/old\n  feat/new\n  remotes/origin/dev-laptop\n\n"), [
    "dev-laptop",
    "feat/old",
    "feat/new",
  ]);
});

test("triageRepo：worktree 状态判定 + processing 分类（branch 精确相等）+ 孤儿目录透传", () => {
  const report = triageRepo({
    worktrees: parseWorktrees(PORCELAIN),
    mergedBranches: ["dev-laptop", "feat/merged-thing", "feat/dirty-thing"],
    docs: TRIAGE_DOCS,
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
  assert.deepEqual(report.worktrees[0].entries.map((e) => [e.name, e.id]), [["a-todo", 1]]);

  assert.equal(report.processing.total, 3);
  assert.deepEqual(report.processing.active.map((p) => p.ref), ["feat/live-thing"]);
  assert.deepEqual(report.processing.stale.map((p) => [p.id, p.ref]), [[4, "feat/vanished"]]);
  assert.deepEqual(report.processing.noRef.map((p) => p.id), [3]);
  assert.deepEqual(report.orphanDirs, [".worktrees/orphan"]);
});

test("main triage：fake git 事实驱动只读报告，只读不写、--json 可解析", () => {
  const root = makeRepo({ "a-todo": TRIAGE_DOCS[0].data });
  fs.mkdirSync(path.join(root, ".worktrees", "live"), { recursive: true });
  const porcelain = [
    `worktree ${root}`,
    "HEAD aaaa1111",
    "branch refs/heads/dev-laptop",
    "",
    `worktree ${path.join(root, ".worktrees", "live")}`,
    "HEAD bbbb2222",
    "branch refs/heads/feat/live-thing",
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
  assert.equal(main(["triage", "--json"], { repoRoot: root, execGit, log: (l) => out.push(l) }), 0);
  const report = JSON.parse(out.join("\n"));
  assert.deepEqual(report.worktrees.map((w) => [w.branch, w.state]), [["feat/live-thing", "active"]]);
  assert.equal(report.processing.active[0].ref, "feat/live-thing");
  assert.deepEqual(readRepoData(root, "a-todo"), TRIAGE_DOCS[0].data, "triage 不得写 todos/");
  assert.ok(calls.includes("worktree") && calls.includes("branch"));

  const text = [];
  assert.equal(main(["triage"], { repoRoot: root, execGit, log: (l) => text.push(l) }), 0);
  assert.match(text.join("\n"), /feat\/live-thing/);
  assert.match(text.join("\n"), /active/);
  assert.match(text.join("\n"), /无分支引用 1/);
});

// ---------------------------------------------------------------------------
// 进程边界 E2E：真实子进程 + 陌生 cwd 跑 CLI 入口（只读，不写真实 todos/）
// ---------------------------------------------------------------------------

test("CLI E2E：任意 cwd 跑 summary 退出 0 且有输出、stderr 恒空", () => {
  const res = runCli(["summary"], os.tmpdir());
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  assert.ok(res.stdout.trim().length > 0, "summary 输出非空");
  assert.match(res.stdout, /-todo/);
});

test("CLI E2E：--help 退出 0 且含完整用法（migrate 替代 db）", () => {
  const res = runCli(["--help"], os.tmpdir());
  assert.equal(res.status, 0);
  assert.match(res.stdout, /用法/);
  for (const sub of ["summary", "list", "add", "claim", "complete", "lint", "triage", "migrate"]) {
    assert.ok(res.stdout.includes(sub), `用法含子命令 ${sub}`);
  }
  assert.equal(res.stdout.includes("db "), false, "db 子命令已删除");
});

test("CLI E2E：未知命令退出 1 并提示", () => {
  const res = runCli(["definitely-not-a-command"], os.tmpdir());
  assert.equal(res.status, 1);
  assert.match(res.stdout, /未知命令：definitely-not-a-command/);
  assert.match(res.stdout, /用法/);
  assert.equal(res.stderr, "");
});
