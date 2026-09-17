/**
 * todo-cli/migrate.test.ts — markdown ↔ JSON 迁移单测（方案 C，todos/todo-cli-todo.md:17）。
 *
 * 覆盖：旧 md 解析（标注剥出/缩进子行归并/嵌套括号/CRLF）、规范渲染 roundtrip 恒等、
 * from-md 编排（落盘/删 md/清遗留索引/dry-run/拒绝覆盖/等价自检失败中止/时间戳回填）、
 * 覆盖：旧 md 解析（标注剥出/缩进子行归并/嵌套括号/CRLF）、规范渲染 roundtrip 恒等、
 * from-md 编排（落盘/删 md/清遗留索引/dry-run/拒绝覆盖/等价自检失败中止/时间戳回填）、
 * to-md 编排（还原 md、保留 JSON）、migrate global-id 编排（dry-run/稳定顺序取号/
 * 逐字段保全/幂等/重复号预检中止）。全部在 mkdtemp 临时仓库上执行，不碰真实 todos/。
 * priority（todo-cli-todo:15）：md 无优先级语法 ⇒ 迁移条目一律 5，to-md 不渲染该字段。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import { buildTodoData, migrateFromMd, migrateToMd, parseLegacyMarkdown, renderMarkdown } from "../migrate.ts";
import { parseTodoJson } from "../schema.ts";
import { main } from "../todo.mjs";

const NOW = () => "2026-09-12T00:00:00.000Z";

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-migrate-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  return root;
}

function writeMd(root: string, name: string, content: string): void {
  fs.writeFileSync(path.join(root, "todos", `${name}.md`), content);
}

function readJson(root: string, name: string) {
  const parsed = parseTodoJson(fs.readFileSync(path.join(root, "todos", `${name}.json`), "utf8"), "test");
  assert.equal(parsed.ok, true);
  return parsed.ok ? parsed.data : null;
}

test("parseLegacyMarkdown：标题/顶层条目/缩进子行/标注剥出", () => {
  const md = [
    "# 通用 TODO",
    "",
    "- [ ] 未领取的条目：做点事情",
    "  - 子说明一（缩进无 checkbox）",
    "  - [x] 带勾的缩进子行也并入 notes",
    "- [ ] 进行中的条目（processing）",
    "- [ ] 带引用的进行中（processing @ feat/branch-x）",
    "- [ ] 手写注解（processing 2026-09-10 @ route A：材料已备，待提交上游）",
    "- [x] 已完成的条目（完成 2026-09-11 @ merge 9db7983：收敛完成）",
    "",
  ].join("\n");
  const doc = parseLegacyMarkdown(md);
  assert.equal(doc.title, "通用 TODO");
  assert.equal(doc.entries.length, 5);

  assert.equal(doc.entries[0].text, "未领取的条目：做点事情");
  assert.equal(doc.entries[0].checked, false);
  assert.deepEqual(doc.entries[0].sublines, ["子说明一（缩进无 checkbox）", "带勾的缩进子行也并入 notes"]);

  assert.equal(doc.entries[1].state, "processing");
  assert.equal(doc.entries[1].branch, null);

  assert.equal(doc.entries[2].state, "processing");
  assert.equal(doc.entries[2].branch, "feat/branch-x");
  assert.deepEqual(doc.entries[2].annotationNotes, []);

  // 手写注解：ref 无 / 不入 branch；内容整体进 notes 保真
  assert.equal(doc.entries[3].state, "processing");
  assert.equal(doc.entries[3].branch, null);
  assert.deepEqual(doc.entries[3].annotationNotes, ["2026-09-10 @ route A：材料已备，待提交上游"]);

  assert.equal(doc.entries[4].checked, true);
  assert.deepEqual(doc.entries[4].annotationNotes, ["2026-09-11 @ merge 9db7983：收敛完成"]);
});

test("parseLegacyMarkdown：嵌套括号的完成注记整体剥出；非标注括号留在正文；孤立（processing）残留丢弃", () => {
  const md = [
    "- [x] 嵌套括号（完成 已删三处 env -u（leader/writer/checker）；前提=根治 638eb0f）",
    "- [x] 正文含普通括号（JHL-16）不动（完成 收尾）",
    "- [x] 孤立残留（processing）（完成 真注记）",
    "- [x] 括号不闭合的坏行（完成 半态 ——",
  ].join("\n");
  const doc = parseLegacyMarkdown(md);
  assert.equal(doc.entries[0].text, "嵌套括号");
  assert.deepEqual(doc.entries[0].annotationNotes, ["已删三处 env -u（leader/writer/checker）；前提=根治 638eb0f"]);
  assert.equal(doc.entries[1].text, "正文含普通括号（JHL-16）不动");
  assert.deepEqual(doc.entries[1].annotationNotes, ["收尾"]);
  assert.equal(doc.entries[2].text, "孤立残留");
  assert.deepEqual(doc.entries[2].annotationNotes, ["真注记"]);
  // 未闭合组不剥出：坏行文本整体保留（零丢失），结构层放弃
  assert.ok(doc.entries[3].text.includes("（完成 半态 ——"));
});

test("parseLegacyMarkdown：aligning / aligned 标注识别（纯引用入 branch，杂注进 notes）", () => {
  const doc = parseLegacyMarkdown(
    [
      "- [ ] 对齐中（aligning）",
      "- [ ] 对齐中有引用（aligning @ feat/align-x）",
      "- [ ] 已对齐（aligned @ feat/align-y）",
      "- [ ] aligned 带说明（aligned 2026-09-14 @ feat/align-z：已与人工确认）",
      "- [ ] 普通条目",
    ].join("\n"),
  );
  assert.deepEqual(
    doc.entries.map((entry) => [entry.state, entry.branch]),
    [
      ["aligning", null],
      ["aligning", "feat/align-x"],
      ["aligned", "feat/align-y"],
      ["aligned", "feat/align-z"],
      ["open", null],
    ],
  );
  assert.deepEqual(doc.entries[0].annotationNotes, []);
  assert.deepEqual(doc.entries[1].annotationNotes, []);
  assert.deepEqual(doc.entries[3].annotationNotes, ["2026-09-14 @ feat/align-z：已与人工确认"]);
});

test("parseLegacyMarkdown：CRLF 与无标题文件；前无条目的孤立说明行兜底为顶层条目", () => {
  const doc = parseLegacyMarkdown("# t\r\n\r\n- [ ] 一条\r\n  - 子行\r\n");
  assert.equal(doc.entries.length, 1);
  assert.deepEqual(doc.entries[0].sublines, ["子行"]);

  const noHeader = parseLegacyMarkdown("  孤立说明行在最前\n");
  assert.equal(noHeader.title, null);
  assert.equal(noHeader.entries.length, 1);
  assert.equal(noHeader.entries[0].text, "孤立说明行在最前");
});

test("renderMarkdown → parseLegacyMarkdown → buildTodoData：五态 roundtrip 语义恒等（时间戳除外）", () => {
  const md = [
    "# 通用 TODO",
    "",
    "- [ ] 未领取的条目：做点事情",
    "  - 子说明一",
    "- [ ] 对齐中的条目（aligning @ feat/branch-x）",
    "- [ ] 已对齐的条目（aligned）",
    "- [ ] 进行中的条目（processing @ feat/branch-x）",
    "  - 旧注解留在 notes",
    "- [x] 已完成的条目",
    "  - feat/x：做完",
  ].join("\n");
  const first = buildTodoData("general-todo", parseLegacyMarkdown(md));
  assert.equal(first.version, 4, "buildTodoData 产出 v4（globalId 为 null，由 from-md 编排取号）");
  assert.deepEqual(first.entries.map((e) => e.alignedAt), [null, null, null, null, null]);
  assert.deepEqual(
    first.entries.map((e) => e.dependsOn),
    [[], [], [], [], []],
    "md 无依赖语法 → 迁移条目的 dependsOn 一律空（不回填、不猜）",
  );
  assert.deepEqual(
    first.entries.map((e) => e.status),
    ["open", "aligning", "aligned", "processing", "done"],
  );
  const second = buildTodoData("general-todo", parseLegacyMarkdown(renderMarkdown(first)));
  assert.deepEqual(second, first);
  // id 重新分配恒等（数组序不变）
  assert.deepEqual(second.entries.map((e) => e.id), [1, 2, 3, 4, 5]);
});

test("migrateFromMd：落盘 JSON + 删 md + 清遗留索引；拒绝已存在的 json；--dry-run 不写", () => {
  const root = makeRepo();
  writeMd(root, "general-todo", "# 通用 TODO\r\n\r\n- [ ] 甲\r\n- [x] 乙（完成 收尾）\r\n");
  writeMd(root, "a-todo", "# a TODO\n\n- [ ] 丙\n");
  fs.mkdirSync(path.join(root, "todos", ".todo-cli"), { recursive: true });
  fs.writeFileSync(path.join(root, "todos", ".todo-cli", "index.db"), "legacy");

  const dry = [];
  assert.equal(migrateFromMd(root, { now: NOW, log: (l) => dry.push(l), dryRun: true, force: false }), 0);
  assert.match(dry.join("\n"), /演练：将迁移 2 个文件 · 顶层条目 3/);
  assert.ok(fs.existsSync(path.join(root, "todos", "general-todo.md")), "dry-run 不写不删");

  const refuse = [];
  writeMd(root, "b-todo", "- [ ] 丁\n");
  fs.writeFileSync(path.join(root, "todos", "b-todo.json"), "{}\n");
  assert.equal(migrateFromMd(root, { now: NOW, log: (l) => refuse.push(l), dryRun: false, force: false }), 1);
  assert.match(refuse.join("\n"), /已存在 b-todo\.json/);
  fs.rmSync(path.join(root, "todos", "b-todo.json"));
  fs.rmSync(path.join(root, "todos", "b-todo.md"));

  const out: string[] = [];
  assert.equal(migrateFromMd(root, { now: NOW, log: (l) => out.push(l), dryRun: false, force: false }), 0);
  assert.match(out.join("\n"), /已迁移 2 个文件 · 顶层条目 3（open 2 \/ aligning 0 \/ aligned 0 \/ processing 0 \/ done 1）· 注记 1 条/);
  assert.match(out.join("\n"), /回滚：node \.agents\/skills\/todo-cli\/todo-cli\/todo\.mjs migrate to-md/);
  assert.equal(fs.existsSync(path.join(root, "todos", "general-todo.md")), false, "迁移后 md 删除");
  assert.equal(fs.existsSync(path.join(root, "todos", ".todo-cli", "index.db")), false, "遗留索引清理");

  const data = readJson(root, "general-todo");
  assert.equal(data.title, "通用 TODO");
  assert.deepEqual(
    data.entries.map((e) => [e.id, e.text, e.status]),
    [
      [1, "甲", "open"],
      [2, "乙", "done"],
    ],
  );
  assert.deepEqual(data.entries[1].notes, ["收尾"]);
});

test("migrateFromMd：时间戳回填——可读的遗留 index.db 按（文件，归一化原文）匹配", () => {
  const root = makeRepo();
  writeMd(root, "general-todo", "# 通用 TODO\n\n- [ ] 一号条目\n- [x] 二号条目（完成 收尾）\n");
  let sqlite: { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => { exec: (sql: string) => void; prepare: (sql: string) => { run: (...params: unknown[]) => unknown }; close: () => void } };
  try {
    sqlite = createRequire(import.meta.url)("node:sqlite");
  } catch {
    return; // node:sqlite 不可用的环境：回填静默放弃（null），不做断言
  }
  const dbPath = path.join(root, "todos", ".todo-cli", "index.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("CREATE TABLE entries(file TEXT, line INTEGER, status TEXT, text TEXT, created_at TEXT, claimed_at TEXT, completed_at TEXT)");
  db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)").run("general-todo", 1, "open", "一号条目", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", null);
  db.prepare("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)").run("general-todo", 2, "done", "二号条目（完成 收尾）", "2026-09-01T00:00:00.000Z", null, "2026-09-03T00:00:00.000Z");
  db.close();

  const out: string[] = [];
  assert.equal(migrateFromMd(root, { now: NOW, log: (l) => out.push(l), dryRun: false, force: false }), 0);
  const data = readJson(root, "general-todo");
  assert.deepEqual(
    data.entries.map((e) => [e.createdAt, e.claimedAt, e.completedAt]),
    [
      ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", null],
      ["2026-09-01T00:00:00.000Z", null, "2026-09-03T00:00:00.000Z"],
    ],
  );
});

test("migrateToMd：JSON → 规范 md（processing 标记还原、notes 作缩进子行），JSON 保留", () => {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "todos", "general-todo.json"),
    JSON.stringify({
      version: 1,
      title: "通用 TODO",
      entries: [
        { id: 1, text: "对齐中条目", status: "aligning", branch: "feat/x", tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null, alignedAt: null },
        { id: 2, text: "已对齐条目", status: "aligned", branch: "feat/x", tags: [], notes: ["待开工"], createdAt: null, claimedAt: null, completedAt: null, alignedAt: "2026-09-14T00:00:00.000Z" },
        { id: 3, text: "进行中条目", status: "processing", branch: "feat/x", tags: [], notes: ["注记一"], createdAt: null, claimedAt: null, completedAt: null, alignedAt: null },
        { id: 4, text: "完成条目", status: "done", branch: null, tags: [], notes: ["收尾说明"], createdAt: null, claimedAt: null, completedAt: null, alignedAt: null },
        { id: 5, text: "无分支进行中", status: "processing", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null, alignedAt: null },
      ],
    }),
  );
  const out: string[] = [];
  assert.equal(migrateToMd(root, { now: NOW, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /已还原 1 个 markdown/);
  const md = fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8");
  assert.equal(
    md,
    [
      "# 通用 TODO",
      "",
      "- [ ] 对齐中条目（aligning @ feat/x）",
      "- [ ] 已对齐条目（aligned @ feat/x）",
      "  - 待开工",
      "- [ ] 进行中条目（processing @ feat/x）",
      "  - 注记一",
      "- [x] 完成条目",
      "  - 收尾说明",
      "- [ ] 无分支进行中（processing）",
      "",
    ].join("\n"),
  );
  assert.ok(fs.existsSync(path.join(root, "todos", "general-todo.json")), "to-md 不删 JSON");
  // 还原的 md 再迁移回去必须语义恒等（roundtrip 稳定）
  const round = buildTodoData("general-todo", parseLegacyMarkdown(md));
  assert.equal(round.version, 4);
  assert.deepEqual(round.entries.map((e) => e.alignedAt), [null, null, null, null, null]);
  const original = parseTodoJson(fs.readFileSync(path.join(root, "todos", "general-todo.json"), "utf8"), "t");
  assert.equal(original.ok, true);
  if (original.ok) {
    assert.deepEqual(
      round.entries.map((e) => [e.text, e.status, e.branch, e.notes]),
      original.data.entries.map((e) => [e.text, e.status, e.branch, e.notes]),
    );
  }
});

test("migrateToMd：损坏 JSON fail-closed 整体中止，一个 md 都不写", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "todos", "bad-todo.json"), "{ not json\n");
  fs.writeFileSync(
    path.join(root, "todos", "good-todo.json"),
    JSON.stringify({ version: 1, title: "g", entries: [] }),
  );
  const out: string[] = [];
  assert.equal(migrateToMd(root, { now: NOW, log: (l) => out.push(l) }), 1);
  assert.match(out.join("\n"), /不是合法 JSON/);
  assert.equal(fs.existsSync(path.join(root, "todos", "good-todo.md")), false, "任一损坏即中止");
});

test("buildTodoData：md 无优先级语法 ⇒ 迁移条目 priority 一律 5", () => {
  const first = buildTodoData("general-todo", parseLegacyMarkdown("- [ ] 甲\n- [x] 乙（完成 收尾）\n"));
  assert.deepEqual(first.entries.map((entry) => entry.priority), [5, 5]);
});

test("migrateToMd：带 priority（含非 5）照常渲染；md 无优先级语法，往返抹平为 5", () => {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, "todos", "general-todo.json"),
    JSON.stringify({
      version: 3,
      title: "通用 TODO",
      entries: [
        {
          id: 1,
          text: "高优先条目",
          status: "open",
          branch: null,
          tags: [],
          priority: 9,
          dependsOn: [],
          notes: [],
          createdAt: null,
          claimedAt: null,
          completedAt: null,
          alignedAt: null,
        },
        {
          id: 2,
          text: "低优先条目",
          status: "open",
          branch: null,
          tags: [],
          priority: 1,
          dependsOn: [],
          notes: [],
          createdAt: null,
          claimedAt: null,
          completedAt: null,
          alignedAt: null,
        },
      ],
    }),
  );
  const out: string[] = [];
  assert.equal(migrateToMd(root, { now: NOW, log: (l) => out.push(l) }), 0);
  const md = fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8");
  assert.equal(md, ["# 通用 TODO", "", "- [ ] 高优先条目", "- [ ] 低优先条目", ""].join("\n"), "渲染不受 priority 影响");
  assert.equal(md.includes("priority"), false, "md 无优先级语法");
  assert.doesNotMatch(md, /\[p\d+\]/);
  const round = buildTodoData("general-todo", parseLegacyMarkdown(md));
  assert.deepEqual(round.entries.map((entry) => entry.priority), [5, 5], "to-md → from-md 往返抹平非 5（记入卡片已知坑）");
});

// ---------------------------------------------------------------------------
// migrate global-id（todo-cli-todo:16）：存量一次性取号
// ---------------------------------------------------------------------------

/** v3 条目（未迁移形态：没有 globalId 字段；显式带号时写 globalId）。 */
function legacy(id: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    text,
    status: "open",
    branch: null,
    tags: [],
    dependsOn: [],
    notes: [],
    createdAt: null,
    claimedAt: null,
    completedAt: null,
    alignedAt: null,
    ...extra,
  };
}

function writeLegacyJson(root: string, name: string, entries: Array<Record<string, unknown>>): void {
  fs.writeFileSync(path.join(root, "todos", `${name}.json`), `${JSON.stringify({ version: 3, title: `${name} TODO`, entries }, null, 2)}\n`);
}

function counterPath(root: string): string {
  return path.join(root, "todos", ".todo-cli", "next-id");
}

/** 除 globalId 外的逐字段快照（迁移等价比较用）。 */
function stripGlobalId(data: { version: number; title: string; entries: Array<Record<string, unknown>> }): string {
  return JSON.stringify({ ...data, entries: data.entries.map(({ globalId, ...rest }) => rest) });
}

test("migrate global-id：dry-run 零写盘零取号；稳定顺序取号 71..74 + 逐字段保全 + 计数器就位", (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  writeLegacyJson(root, "a-todo", [
    legacy(1, "甲", {
      tags: ["cli", "性能"],
      dependsOn: ["b-todo#70"],
      notes: ["注记一", "注记二"],
      createdAt: "2026-08-01T00:00:00.000Z",
    }),
    legacy(2, "乙", { status: "aligned", branch: "feat/a", alignedAt: "2026-09-01T00:00:00.000Z", dependsOn: ["a-todo#1"] }),
    legacy(3, "丙", { status: "done", dependsOn: ["a-todo#2"], completedAt: "2026-09-02T00:00:00.000Z", notes: ["feat/a：做完"] }),
  ]);
  writeLegacyJson(root, "b-todo", [legacy(70, "丁", { dependsOn: ["a-todo#1"] })]);

  const bytes = () => ["a-todo", "b-todo"].map((name) => fs.readFileSync(path.join(root, "todos", `${name}.json`), "utf8"));
  const before = bytes();

  const dry: string[] = [];
  assert.equal(main(["migrate", "global-id", "--dry-run"], { repoRoot: root, log: (l) => dry.push(l) }), 0);
  assert.match(dry.join("\n"), /演练：将迁移 2 个文件 · 4 条条目（起始号 71）/);
  assert.deepEqual(bytes(), before, "dry-run 零写盘");
  assert.equal(fs.existsSync(counterPath(root)), false, "dry-run 零取号");

  const out: string[] = [];
  assert.equal(main(["migrate", "global-id"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /已迁移全局 id：2 个文件 · 4 条条目取号 71\.\.74（等价自检通过）/);

  const aBefore = parseTodoJson(before[0], "a");
  const bBefore = parseTodoJson(before[1], "b");
  assert.equal(aBefore.ok, true);
  assert.equal(bBefore.ok, true);
  const afterA = readJson(root, "a-todo");
  const afterB = readJson(root, "b-todo");
  if (aBefore.ok) assert.equal(stripGlobalId(afterA), stripGlobalId(aBefore.data), "a-todo 除 globalId 外逐字段零漂移");
  if (bBefore.ok) assert.equal(stripGlobalId(afterB), stripGlobalId(bBefore.data), "b-todo 除 globalId 外逐字段零漂移");
  assert.equal(afterA.version, 4, "迁移后写出一律 v4");
  assert.deepEqual(afterA.entries.map((e) => e.globalId), [71, 72, 73], "文件名 sort + 数组序稳定取号");
  assert.deepEqual(afterB.entries.map((e) => e.globalId), [74]);
  assert.equal(fs.readFileSync(counterPath(root), "utf8"), "75\n", "计数器就位到 max+1");
});

test("migrate global-id：幂等（重跑零动作零写盘、计数器不动）+ 重复号预检中止零写盘", (t) => {
  const root = makeRepo();
  const dupRoot = makeRepo();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    fs.rmSync(dupRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  writeLegacyJson(root, "a-todo", [legacy(1, "甲")]);
  writeLegacyJson(root, "b-todo", [legacy(2, "乙", { globalId: 40 })]);

  const out: string[] = [];
  assert.equal(main(["migrate", "global-id"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /已迁移全局 id：1 个文件 · 1 条条目取号 41\.\.41/);
  const bytes = () => ["a-todo", "b-todo"].map((name) => fs.readFileSync(path.join(root, "todos", `${name}.json`), "utf8"));
  const migrated = bytes();
  const counter = fs.readFileSync(counterPath(root), "utf8");

  out.length = 0;
  assert.equal(main(["migrate", "global-id"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /没有需要迁移的条目/);
  assert.deepEqual(bytes(), migrated, "幂等：零写盘");
  assert.equal(fs.readFileSync(counterPath(root), "utf8"), counter, "幂等：计数器不动");

  // 合并产物重号：预检中止，一个字节都不写、不动计数器（先手工仲裁）
  writeLegacyJson(dupRoot, "a-todo", [legacy(1, "甲", { globalId: 7 })]);
  writeLegacyJson(dupRoot, "b-todo", [legacy(1, "乙", { globalId: 7 })]);
  const dupBytes = ["a-todo", "b-todo"].map((name) => fs.readFileSync(path.join(dupRoot, "todos", `${name}.json`), "utf8"));
  const dupOut: string[] = [];
  assert.equal(main(["migrate", "global-id"], { repoRoot: dupRoot, log: (l) => dupOut.push(l) }), 1);
  assert.match(dupOut.join("\n"), /globalId 重复：7（a-todo#1 与 b-todo#1）/);
  assert.deepEqual(
    ["a-todo", "b-todo"].map((name) => fs.readFileSync(path.join(dupRoot, "todos", `${name}.json`), "utf8")),
    dupBytes,
    "重复号预检中止：零写盘",
  );
  assert.equal(fs.existsSync(counterPath(dupRoot)), false, "重复号预检中止：零取号");
});

test("migrateFromMd 产 v4 完备（逐条 globalId + 计数器就位）；to-md 对 v4 照常工作（globalId 不进 md）", (t) => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  writeMd(root, "general-todo", "# 通用 TODO\n\n- [ ] 甲\n- [x] 乙（完成 收尾）\n");

  const out: string[] = [];
  assert.equal(migrateFromMd(root, { now: NOW, log: (l) => out.push(l), dryRun: false, force: false }), 0);
  const data = readJson(root, "general-todo");
  assert.equal(data.version, 4, "from-md 一步到位 v4，不产生 v3 中间态");
  assert.deepEqual(data.entries.map((e) => e.globalId), [1, 2], "每文件锁内逐条取号");
  assert.equal(fs.readFileSync(counterPath(root), "utf8"), "3\n", "计数器就位（下一个待发号）");

  const mdOut: string[] = [];
  assert.equal(migrateToMd(root, { now: NOW, log: (l) => mdOut.push(l) }), 0);
  const md = fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8");
  assert.equal(md, ["# 通用 TODO", "", "- [ ] 甲", "- [x] 乙", "  - 收尾", ""].join("\n"), "globalId 不进 md（逃生舱只装人类契约）");

});
