/**
 * todo-cli/store.ts 单测 —— 真实临时目录 + 真实 node:sqlite（宿主边界必须真实实现，禁 fake：
 * 跨进程写互斥、原子写、漂移检测都发生在 sqlite/fs 的真边界上，纸面替身测不出问题）。
 *
 * 边界：所有用例在 mkdtemp 出来的临时仓库根上执行，只写临时目录，不触碰仓库真实 todos/；
 * 时间戳一律注入固定 NowFn，保证确定性。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { normalizeText } from "../core.ts";
import {
  atomicWriteFile,
  loadSqliteModule,
  openTodoStore,
  storeDir,
  storeFile,
} from "../store.ts";

const NOW = () => "2026-09-11T09:45:00.000Z";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-store-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  return root;
}

/** 写一个 markdown fixture，返回当前 stat（size/mtimeMs），供 driftedFiles 断言。 */
function writeTodo(root, name, content) {
  const file = path.join(root, "todos", `${name}.md`);
  fs.writeFileSync(file, content);
  const st = fs.statSync(file);
  return { name, size: st.size, mtimeMs: st.mtimeMs };
}

test("openTodoStore：建库建表幂等，schema_version=1", () => {
  const root = makeRoot();
  const first = openTodoStore(root);
  assert.ok(first, "首次 open 建库成功");
  first.close();
  const second = openTodoStore(root);
  assert.ok(second, "二次 open 不抛");
  assert.deepEqual(second.listEntryRows(), []);
  second.close();

  assert.equal(storeDir(root), path.join(root, "todos", ".todo-cli"));
  assert.ok(fs.existsSync(storeFile(root)));

  const sqlite = loadSqliteModule();
  assert.ok(sqlite, "验证机 node:sqlite 应可用");
  const db = new sqlite.DatabaseSync(storeFile(root), { readOnly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  db.close();
  assert.equal(row.value, "1");
  assert.deepEqual(tables, ["entries", "files", "meta"]);
});

test("writeTxn：fn 抛错回滚且重抛", () => {
  const root = makeRoot();
  const store = openTodoStore(root);
  assert.ok(store);
  writeTodo(root, "a", "- [ ] 甲\n- [ ] 乙\n");
  store.writeTxn(() => store.reimportFile("a", "- [ ] 甲\n- [ ] 乙\n", NOW));
  const before = store.listEntryRows();
  assert.equal(before.length, 2);

  assert.throws(
    () =>
      store.writeTxn(() => {
        store.reimportFile("a", "- [ ] 甲\n", NOW);
        throw new Error("boom");
      }),
    /boom/,
    "异常必须透传（临界区半途失败不留脏数据）",
  );
  assert.deepEqual(store.listEntryRows(), before, "回滚后行集不变");
  store.close();
});

test("reimportFile：CRLF 内容行集正确、时间戳按归一化文本迁移", () => {
  const root = makeRoot();
  const store = openTodoStore(root);
  assert.ok(store);
  const t0 = "2026-09-11T08:00:00.000Z";
  const t1 = "2026-09-11T09:00:00.000Z";
  const t2 = "2026-09-11T10:00:00.000Z";
  const original = "# t\r\n\r\n- [ ] 甲\r\n- [ ] 乙\r\n  - 子说明不是条目\r\n";
  writeTodo(root, "a", original);

  store.writeTxn(() => store.reimportFile("a", original, () => t0));
  assert.deepEqual(
    store.listEntryRows().map((r) => [r.file, r.line, r.status, r.text, r.createdAt]),
    [
      ["a", 3, "open", "甲", t0],
      ["a", 4, "open", "乙", t0],
    ],
    "CRLF 解析行集正确，缩进子说明不进库",
  );

  assert.equal(store.stampEntry("a", normalizeText("甲"), "claimedAt", t1), true);

  // claim 标注增删不改变归一化文本（normalizeText 剥标注括号）→ 重导入必须保留时间戳
  const claimed = original.replace("- [ ] 甲", "- [ ] 甲（processing @ feat/x）");
  writeTodo(root, "a", claimed);
  store.writeTxn(() => store.reimportFile("a", claimed, () => t2));
  let rows = store.listEntryRows();
  const jia = rows.find((r) => r.text.includes("甲"));
  assert.deepEqual(
    [jia.text, jia.createdAt, jia.claimedAt, jia.completedAt],
    ["甲（processing @ feat/x）", t0, t1, null],
  );

  // 新增条目：createdAt 取本次导入时刻，claim/complete 为 null
  const grown = `${claimed}- [ ] 丙\r\n`;
  writeTodo(root, "a", grown);
  store.writeTxn(() => store.reimportFile("a", grown, () => t2));
  rows = store.listEntryRows();
  const bing = rows.find((r) => r.text === "丙");
  assert.deepEqual([bing.createdAt, bing.claimedAt, bing.completedAt], [t2, null, null]);
  store.close();
});

test("driftedFiles：size/mtime 变化与新增文件判定", () => {
  const root = makeRoot();
  const store = openTodoStore(root);
  assert.ok(store);
  const statA = writeTodo(root, "a", "- [ ] 甲\n");
  const statB = writeTodo(root, "b", "- [ ] 乙\n");
  store.writeTxn(() => store.reimportFile("a", "- [ ] 甲\n", NOW));
  assert.deepEqual(store.driftedFiles([statA, statB]).sort(), ["b"], "表无记录的新增文件算漂移");

  store.writeTxn(() => store.reimportFile("b", "- [ ] 乙\n", NOW));
  assert.deepEqual(store.driftedFiles([statA, statB]), [], "未改动文件不漂移");

  const statA2 = writeTodo(root, "a", "- [ ] 甲\n- [ ] 甲二\n");
  assert.deepEqual(store.driftedFiles([statA2, statB]), ["a"], "size 变化即漂移");
  store.close();
});

test("stampEntry：唯一文本命中打时间戳，未命中/歧义返回 false", () => {
  const root = makeRoot();
  const store = openTodoStore(root);
  assert.ok(store);
  writeTodo(root, "a", "- [ ] 甲\n- [ ] 乙\n");
  store.writeTxn(() => store.reimportFile("a", "- [ ] 甲\n- [ ] 乙\n", NOW));
  const t = "2026-09-11T09:45:00.000Z";

  assert.equal(store.stampEntry("a", normalizeText("乙"), "completedAt", t), true);
  const yi = store.listEntryRows().find((r) => r.text === "乙");
  assert.equal(yi.completedAt, t);
  assert.equal(store.stampEntry("a", normalizeText("不存在"), "claimedAt", t), false);
  assert.equal(store.stampEntry("other", normalizeText("甲"), "claimedAt", t), false);

  writeTodo(root, "a", "- [ ] 甲\n- [ ] 甲\n");
  store.writeTxn(() => store.reimportFile("a", "- [ ] 甲\n- [ ] 甲\n", NOW));
  assert.equal(store.stampEntry("a", normalizeText("甲"), "claimedAt", t), false, "归一化后同文本多条时不猜行");
  store.close();
});

test("openTodoStore 降级：损坏库自愈（挪 .corrupt 后重建成功）", () => {
  const root = makeRoot();
  fs.mkdirSync(storeDir(root), { recursive: true });
  fs.writeFileSync(storeFile(root), "this is not a sqlite database");

  assert.equal(openTodoStore(root), null, "损坏库本次降级");
  assert.ok(fs.existsSync(path.join(storeDir(root), "index.db.corrupt")), "损坏库挪为 .corrupt 留证");

  const healed = openTodoStore(root);
  assert.ok(healed, "下一次 open 自动重建");
  assert.deepEqual(healed.listEntryRows(), []);
  healed.close();
});

test("atomicWriteFile：覆盖既有文件、无 .tmp 残留、10 分钟旧 tmp 被清", () => {
  const root = makeRoot();
  const dir = path.join(root, "todos");
  const target = path.join(dir, "a.md");
  fs.writeFileSync(target, "old");

  atomicWriteFile(target, "new\r\n");
  assert.equal(fs.readFileSync(target, "utf8"), "new\r\n");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "正常路径无 .tmp 残留");

  // 过期 tmp（崩溃残留）清理；新鲜 tmp 保留（可能属于并发写者，绝不能误删）
  const stale = path.join(dir, "a.md.123.dead.tmp");
  const fresh = path.join(dir, "a.md.456.alive.tmp");
  fs.writeFileSync(stale, "stale");
  fs.writeFileSync(fresh, "fresh");
  const old = (Date.now() - 11 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);

  atomicWriteFile(target, "newer");
  assert.equal(fs.existsSync(stale), false, "超过 10 分钟的 .tmp 被清理");
  assert.equal(fs.existsSync(fresh), true, "新鲜 .tmp 不动");
  assert.equal(fs.readFileSync(target, "utf8"), "newer");
});
