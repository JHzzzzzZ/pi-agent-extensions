/**
 * todo-cli/migrate.ts 单测 —— 真实临时目录 + 真实 node:sqlite（迁移/回滚只在真边界上验证）。
 *
 * 锁四件事：dbStatus 无副作用探测（不建库、损坏不挪文件）、rebuild 不写 markdown（迁移可逆的根基）、
 * drop 完整回滚且幂等、entries 行集 = parseTodoFile 像（markdown 权威不变量，10-design §4）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseTodoFile } from "../core.ts";
import { openTodoStore, storeFile } from "../store.ts";
import { dbStatus, dropStore, rebuildStore } from "../migrate.ts";

const NOW = () => "2026-09-11T09:45:00.000Z";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-migrate-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  return root;
}

function writeTodo(root, name, content) {
  fs.writeFileSync(path.join(root, "todos", `${name}.md`), content);
}

test("dbStatus：无库 NO_DB → rebuild → 可用且计数正确 → drop → NO_DB", () => {
  const root = makeRoot();
  const docs = [
    { name: "a-todo", content: "- [ ] 甲\n- [x] 乙\n" },
    { name: "b-todo", content: "- [ ] 丙（processing 2026-09-11 @ feat/x）\n" },
  ];
  for (const doc of docs) writeTodo(root, doc.name, doc.content);

  assert.deepEqual(
    dbStatus(root),
    { available: false, reason: "NO_DB", files: 0, entries: 0, schemaVersion: null },
    "无库报 NO_DB",
  );
  assert.equal(fs.existsSync(storeFile(root)), false, "探测不得创建库文件");

  assert.deepEqual(rebuildStore(root, docs, NOW), { ok: true, reason: null });
  assert.deepEqual(dbStatus(root), { available: true, reason: null, files: 2, entries: 3, schemaVersion: 1 });

  const dropped = dropStore(root);
  assert.equal(dropped.ok, true);
  assert.ok(dropped.removed.includes("todos/.todo-cli/index.db"));
  assert.deepEqual(dbStatus(root), { available: false, reason: "NO_DB", files: 0, entries: 0, schemaVersion: null });
});

test("dbStatus：损坏库报 CORRUPT 且不挪文件（探测无副作用）", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "todos", ".todo-cli"), { recursive: true });
  const file = storeFile(root);
  fs.writeFileSync(file, "this is not a sqlite database");

  assert.deepEqual(dbStatus(root), { available: false, reason: "CORRUPT", files: 0, entries: 0, schemaVersion: null });
  assert.equal(fs.readFileSync(file, "utf8"), "this is not a sqlite database", "探测不得改动库文件");
  assert.equal(fs.existsSync(`${file}.corrupt`), false, "探测不得挪文件");
});

test("rebuildStore：markdown 原文字节不变（前后全量内容比对）、幂等重复执行一致", () => {
  const root = makeRoot();
  const fixture = [
    { name: "a-todo", content: "# a\r\n\r\n- [ ] 甲\r\n- [x] 乙\r\n" },
    { name: "b-todo", content: "- [ ] 丙（processing 2026-09-11 @ feat/x）\r\n" },
  ];
  for (const doc of fixture) writeTodo(root, doc.name, doc.content);
  const before = fixture.map((doc) => fs.readFileSync(path.join(root, "todos", `${doc.name}.md`)));

  assert.equal(rebuildStore(root, fixture, NOW).ok, true);
  for (let i = 0; i < fixture.length; i += 1) {
    assert.deepEqual(fs.readFileSync(path.join(root, "todos", `${fixture[i].name}.md`)), before[i], "rebuild 不得写 .md");
  }

  const store1 = openTodoStore(root);
  const rows1 = store1.listEntryRows();
  store1.close();
  assert.equal(rebuildStore(root, fixture, NOW).ok, true);
  const store2 = openTodoStore(root);
  const rows2 = store2.listEntryRows();
  store2.close();
  assert.deepEqual(rows2, rows1, "重复 rebuild 结果一致（时间戳按归一化文本迁移保留）");
});

test("dropStore：删 db/-wal/-shm/-corrupt，幂等", () => {
  const root = makeRoot();
  const dir = path.join(root, "todos", ".todo-cli");
  assert.equal(rebuildStore(root, [{ name: "a-todo", content: "- [ ] 甲\n" }], NOW).ok, true);
  for (const extra of ["index.db-wal", "index.db-shm", "index.db.corrupt"]) {
    fs.writeFileSync(path.join(dir, extra), "placeholder");
  }

  const first = dropStore(root);
  assert.equal(first.ok, true);
  assert.deepEqual(
    [...first.removed].sort(),
    [
      "todos/.todo-cli/index.db",
      "todos/.todo-cli/index.db-wal",
      "todos/.todo-cli/index.db-shm",
      "todos/.todo-cli/index.db.corrupt",
    ].sort(),
  );
  assert.deepEqual(fs.readdirSync(dir), [], "索引文件全清（WAL 伴生文件不残留）");
  assert.deepEqual(dropStore(root), { ok: true, removed: [] }, "幂等");
});

test("rebuildStore 对含中文/标注/缩进子说明的 fixture：entries 行集 = parseTodoFile 像", () => {
  const root = makeRoot();
  const content = [
    "# todo-cli TODO",
    "",
    "- [ ] 未领取：中文条目",
    "- [x] 已完成（完成 2026-09-11 @ feat/x）",
    "- [ ] 进行中（processing 2026-09-11 @ feat/y：在做）",
    "  - 子说明不是条目",
    "- [ ] 另一条",
    "",
  ].join("\r\n");
  writeTodo(root, "todo-cli-todo", content);
  const fixed = "2026-09-11T09:45:00.000Z";

  assert.deepEqual(rebuildStore(root, [{ name: "todo-cli-todo", content }], () => fixed), { ok: true, reason: null });
  const store = openTodoStore(root);
  const rows = store.listEntryRows();
  store.close();

  const expected = parseTodoFile(content).map((entry) => ({
    file: "todo-cli-todo",
    line: entry.line,
    status: entry.status,
    text: entry.text,
    claimedAt: null,
    completedAt: null,
    createdAt: fixed,
  }));
  assert.deepEqual(rows, expected);
  assert.equal(rows.length, 4, "缩进子说明不进库");
});
