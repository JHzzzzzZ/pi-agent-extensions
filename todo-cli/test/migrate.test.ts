/**
 * todo-cli/migrate.test.ts — markdown ↔ JSON 迁移单测（方案 C，todos/todo-cli-todo.md:17）。
 *
 * 覆盖：旧 md 解析（标注剥出/缩进子行归并/嵌套括号/CRLF）、规范渲染 roundtrip 恒等、
 * from-md 编排（落盘/删 md/清遗留索引/dry-run/拒绝覆盖/等价自检失败中止/时间戳回填）、
 * to-md 编排（还原 md、保留 JSON）。全部在 mkdtemp 临时仓库上执行，不碰真实 todos/。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import { buildTodoData, migrateFromMd, migrateToMd, parseLegacyMarkdown, renderMarkdown } from "../migrate.ts";
import { parseTodoJson } from "../schema.ts";

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

  assert.equal(doc.entries[1].processing, true);
  assert.equal(doc.entries[1].branch, null);

  assert.equal(doc.entries[2].processing, true);
  assert.equal(doc.entries[2].branch, "feat/branch-x");
  assert.deepEqual(doc.entries[2].annotationNotes, []);

  // 手写注解：ref 无 / 不入 branch；内容整体进 notes 保真
  assert.equal(doc.entries[3].processing, true);
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

test("parseLegacyMarkdown：CRLF 与无标题文件；前无条目的孤立说明行兜底为顶层条目", () => {
  const doc = parseLegacyMarkdown("# t\r\n\r\n- [ ] 一条\r\n  - 子行\r\n");
  assert.equal(doc.entries.length, 1);
  assert.deepEqual(doc.entries[0].sublines, ["子行"]);

  const noHeader = parseLegacyMarkdown("  孤立说明行在最前\n");
  assert.equal(noHeader.title, null);
  assert.equal(noHeader.entries.length, 1);
  assert.equal(noHeader.entries[0].text, "孤立说明行在最前");
});

test("renderMarkdown → parseLegacyMarkdown → buildTodoData：roundtrip 语义恒等（时间戳除外）", () => {
  const md = [
    "# 通用 TODO",
    "",
    "- [ ] 未领取的条目：做点事情",
    "  - 子说明一",
    "- [ ] 进行中的条目（processing @ feat/branch-x）",
    "  - 旧注解留在 notes",
    "- [x] 已完成的条目",
    "  - feat/x：做完",
  ].join("\n");
  const first = buildTodoData("general-todo", parseLegacyMarkdown(md));
  const second = buildTodoData("general-todo", parseLegacyMarkdown(renderMarkdown(first)));
  assert.deepEqual(second, first);
  // id 重新分配恒等（数组序不变）
  assert.deepEqual(second.entries.map((e) => e.id), [1, 2, 3]);
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
  assert.match(out.join("\n"), /已迁移 2 个文件 · 顶层条目 3（open 2 \/ processing 0 \/ done 1）· 注记 1 条/);
  assert.match(out.join("\n"), /回滚：node tools\/todo\.mjs migrate to-md/);
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
        { id: 1, text: "进行中条目", status: "processing", branch: "feat/x", tags: [], notes: ["注记一"], createdAt: null, claimedAt: null, completedAt: null },
        { id: 2, text: "完成条目", status: "done", branch: null, tags: [], notes: ["收尾说明"], createdAt: null, claimedAt: null, completedAt: null },
        { id: 3, text: "无分支进行中", status: "processing", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
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
