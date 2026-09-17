/**
 * todo-cli/globalid.test.ts — 全局 id 计数器与全台账健康判定单测（todo-cli-todo:16）。
 *
 * 边界：本文件在 mkdtemp 临时仓库上覆盖真实文件系统的计数器读改写（原子写 + id 锁、
 * 自愈初始化、损坏 fail-closed）与三个纯函数（findGlobalIdProblems /
 * verifyGlobalIdMigration）；跨进程并发取号与 SIGKILL 残留的进程边界行为在
 * concurrency.test.ts / interrupt.test.ts 用真实子进程覆盖。
 *
 * 锁定的不变量：全台账两两互异、取出永不回收（只前进）、落盘 v4 条目恒为正整数、
 * 计数器缺失时按 max(条目 id, globalId)+1 自愈（fresh clone 无计数器也不能与存量撞车）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { allocateGlobalId, findGlobalIdProblems, verifyGlobalIdMigration } from "../globalid.ts";
import { serializeTodo } from "../schema.ts";
import type { TodoEntry, TodoFileData } from "../schema.ts";

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-globalid-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  return root;
}

function removeRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function counterPath(root: string): string {
  return path.join(root, "todos", ".todo-cli", "next-id");
}

function readCounter(root: string): string {
  return fs.readFileSync(counterPath(root), "utf8");
}

/** v4 条目构造（globalId 显式传入，null 表示未迁移的合法输入形态）。 */
function v4Entry(id: number, globalId: number | null, extra: Partial<TodoEntry> = {}): TodoEntry {
  return {
    id,
    globalId,
    text: `条目 ${id}`,
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

function writeV4(root: string, name: string, entries: TodoEntry[]): void {
  fs.writeFileSync(path.join(root, "todos", `${name}.json`), serializeTodo({ version: 4, title: "t", entries }));
}

/** 旧版（v1-v3）文件：JSON 直写（v3 无 globalId 字段 = 真实的未迁移形态）。 */
function writeLegacy(root: string, name: string, version: 1 | 2 | 3, entries: Array<Record<string, unknown>>): void {
  fs.writeFileSync(path.join(root, "todos", `${name}.json`), `${JSON.stringify({ version, title: "t", entries }, null, 2)}\n`);
}

test("allocateGlobalId：连续取号唯一且 +1，计数器经原子写持久（跨调用单调）", (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));

  const first = allocateGlobalId(root);
  assert.deepEqual(first, { ok: true, value: 1 }, "空台账自愈后从 1 起");
  assert.equal(readCounter(root), "2\n", "取出 1 后计数器落 2（下一个待发号）");

  const second = allocateGlobalId(root);
  assert.deepEqual(second, { ok: true, value: 2 }, "同一进程连续取号严格 +1");
  assert.equal(readCounter(root), "3\n");

  fs.writeFileSync(counterPath(root), "41\n");
  assert.deepEqual(allocateGlobalId(root), { ok: true, value: 41 });
  assert.deepEqual(allocateGlobalId(root), { ok: true, value: 42 }, "计数器现值跨调用持久，不因进程/调用边界回退");
  assert.equal(readCounter(root), "43\n");
});

test("allocateGlobalId 自愈：计数器缺失时取 max(条目 id, globalId)+1", (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  writeLegacy(root, "a-todo", 3, [
    { id: 3, text: "甲", status: "open", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null, alignedAt: null, dependsOn: [] },
    { id: 7, text: "乙", status: "open", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null, alignedAt: null, dependsOn: [] },
  ]);

  assert.equal(fs.existsSync(counterPath(root)), false, "前置：无计数器");
  assert.deepEqual(allocateGlobalId(root), { ok: true, value: 8 }, "自愈初值 = 全台账最大文件内 id + 1");
  assert.equal(readCounter(root), "9\n");
});

test("allocateGlobalId 自愈（fresh clone）：存量 globalId 71..265 无计数器时从 266 起，不与存量撞车", (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  writeV4(root, "a-todo", [v4Entry(1, 71), v4Entry(2, 100)]);
  writeV4(root, "b-todo", [v4Entry(1, 265)]);

  assert.deepEqual(allocateGlobalId(root), { ok: true, value: 266 }, "计数器不入库（gitignore），新 clone 必须按 globalId 存量继续");
  assert.equal(readCounter(root), "267\n");
});

test("allocateGlobalId：计数器损坏（非纯数字 / 非正整数）→ ID_COUNTER_CORRUPT，不覆盖损坏文件", (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));

  for (const broken of ["abc\n", "", "0\n", "-1\n", "1.5\n", "12 34\n"]) {
    fs.mkdirSync(path.dirname(counterPath(root)), { recursive: true });
    fs.writeFileSync(counterPath(root), broken);
    const result = allocateGlobalId(root);
    assert.equal(result.ok, false, `应拒绝损坏计数器：${JSON.stringify(broken)}`);
    if (result.ok) continue;
    assert.equal(result.code, "ID_COUNTER_CORRUPT");
    assert.match(result.message, /计数器损坏/);
    assert.equal(readCounter(root), broken, "损坏文件原样保留（修好或删掉后自愈）");
  }
});

test("findGlobalIdProblems：缺 globalId 与全台账重复各报一条（纯函数）", () => {
  const docs: Array<{ name: string; data: TodoFileData }> = [
    { name: "a-todo", data: { version: 4, title: "a", entries: [v4Entry(1, 7), v4Entry(2, null)] } },
    { name: "b-todo", data: { version: 4, title: "b", entries: [v4Entry(1, 7), v4Entry(2, 8)] } },
    { name: "c-todo", data: { version: 3, title: "c", entries: [v4Entry(1, null), v4Entry(2, null)] } },
  ];
  const problems = findGlobalIdProblems(docs);
  assert.deepEqual(problems, [
    { code: "GLOBAL_ID_MISSING", detail: "a-todo#2" },
    { code: "GLOBAL_ID_DUP", detail: "7（a-todo#1 与 b-todo#1）" },
    { code: "GLOBAL_ID_MISSING", detail: "c-todo#1" },
    { code: "GLOBAL_ID_MISSING", detail: "c-todo#2" },
  ]);
  assert.deepEqual(findGlobalIdProblems([{ name: "ok-todo", data: { version: 4, title: "ok", entries: [v4Entry(1, 1)] } }]), []);
});

test("verifyGlobalIdMigration：合法迁移返回 null；条目数变化 / 字段漂移 / 既有号被改 / 新号非单调各返回问题", () => {
  const before: TodoFileData = {
    version: 4,
    title: "t",
    entries: [v4Entry(1, null, { text: "甲", tags: ["x"], notes: ["n1", "n2"] }), v4Entry(2, null, { status: "done", completedAt: "2026-09-01T00:00:00.000Z" })],
  };
  const after: TodoFileData = {
    version: 4,
    title: "t",
    entries: [v4Entry(1, 71, { text: "甲", tags: ["x"], notes: ["n1", "n2"] }), v4Entry(2, 72, { status: "done", completedAt: "2026-09-01T00:00:00.000Z" })],
  };
  assert.equal(verifyGlobalIdMigration(before, after), null, "逐字段零漂移 + 新号单调 = 通过");

  const fewer: TodoFileData = { ...after, entries: [after.entries[0]] };
  assert.match(String(verifyGlobalIdMigration(before, fewer)), /条目数/);

  const drifted: TodoFileData = { ...after, entries: [after.entries[0], { ...after.entries[1], text: "改了" }] };
  assert.match(String(verifyGlobalIdMigration(before, drifted)), /字段/);

  const rewritten: TodoFileData = {
    version: 4,
    title: "t",
    entries: [v4Entry(1, 99, { text: "甲", tags: ["x"], notes: ["n1", "n2"] }), v4Entry(2, 72, { status: "done", completedAt: "2026-09-01T00:00:00.000Z" })],
  };
  assert.match(String(verifyGlobalIdMigration({ ...before, entries: [v4Entry(1, 71, { text: "甲", tags: ["x"], notes: ["n1", "n2"] }), v4Entry(2, 72, { status: "done", completedAt: "2026-09-01T00:00:00.000Z" })] }, rewritten)), /既有 globalId/);

  const nonMonotonic: TodoFileData = {
    version: 4,
    title: "t",
    entries: [v4Entry(1, 72, { text: "甲", tags: ["x"], notes: ["n1", "n2"] }), v4Entry(2, 71, { status: "done", completedAt: "2026-09-01T00:00:00.000Z" })],
  };
  assert.match(String(verifyGlobalIdMigration(before, nonMonotonic)), /单调/);

  const notAllocated: TodoFileData = { version: 4, title: "t", entries: [v4Entry(1, null, { text: "甲", tags: ["x"], notes: ["n1", "n2"] }), after.entries[1]] };
  assert.match(String(verifyGlobalIdMigration(before, notAllocated)), /globalId/);
});
