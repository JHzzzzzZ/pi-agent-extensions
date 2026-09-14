/**
 * todo-cli/query.test.ts — list 查询纯函数单测（方案 C：原生字段投影，无降级口径）。
 *
 * 边界：零 IO 纯函数；QueryEntry 由测试内联构造（字段口径见 schema.ts）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyEntryFilter, parseFilterOptions, serializeEntries, sortQueryEntries, statusMark } from "../query.ts";
import type { QueryEntry } from "../query.ts";

function entry(overrides: Partial<QueryEntry>): QueryEntry {
  return {
    file: "general-todo",
    id: 1,
    status: "open",
    text: "一条需求",
    branch: null,
    tags: [],
    createdAt: null,
    claimedAt: null,
    completedAt: null,
    ...overrides,
  };
}

const FIXTURE: QueryEntry[] = [
  entry({ id: 1, status: "open", text: "未领取条目" }),
  entry({ id: 2, status: "processing", text: "进行中条目", branch: "feat/todo-cli-json", tags: ["性能"], claimedAt: "2026-09-12T01:00:00.000Z" }),
  entry({ id: 3, status: "done", text: "完成条目", branch: "feat/todo-cli-json", tags: ["性能"], claimedAt: "2026-09-10T01:00:00.000Z", completedAt: "2026-09-11T01:00:00.000Z" }),
  entry({ id: 4, file: "zzz-todo", status: "open", text: "另一文件条目" }),
];

test("statusMark：done→[x] processing→[~] open→[ ]", () => {
  assert.equal(statusMark("done"), "[x]");
  assert.equal(statusMark("processing"), "[~]");
  assert.equal(statusMark("open"), "[ ]");
});

test("applyEntryFilter：AND 组合，非法 status 给空结果", () => {
  assert.deepEqual(applyEntryFilter(FIXTURE, { status: "processing" }).map((e) => e.id), [2]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { branch: "todo-cli" }).map((e) => e.id), [2, 3]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { tag: "性能" }).map((e) => e.id), [2, 3]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { text: "条目" }).map((e) => e.id), [1, 2, 3, 4]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { file: "zzz-todo" }).map((e) => e.id), [4]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { claimedSince: "2026-09-11" }).map((e) => e.id), [2]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { branch: "todo-cli", tag: "性能", status: "done" }).map((e) => e.id), [3]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { status: "bogus" as never }), []);
  assert.equal(applyEntryFilter(FIXTURE, {}), FIXTURE, "无过滤条件原样返回");
});

test("sortQueryEntries：file 升序 → id 升序，返回新数组", () => {
  const sorted = sortQueryEntries([FIXTURE[3], FIXTURE[0], FIXTURE[2], FIXTURE[1]]);
  assert.deepEqual(sorted.map((e) => `${e.file}#${e.id}`), ["general-todo#1", "general-todo#2", "general-todo#3", "zzz-todo#4"]);
  assert.notEqual(sorted, FIXTURE);
});

test("serializeEntries：人读行 `${mark} ${file}#${id}  ${text}`；--json 单行整体输出", () => {
  const lines = serializeEntries(FIXTURE, { json: false });
  assert.deepEqual(lines, [
    "[ ] general-todo#1  未领取条目",
    "[~] general-todo#2  进行中条目",
    "[x] general-todo#3  完成条目",
    "[ ] zzz-todo#4  另一文件条目",
  ]);
  const json = serializeEntries(FIXTURE.slice(0, 1), { json: true });
  assert.equal(json.length, 1);
  const rows = JSON.parse(json[0]);
  assert.equal(rows[0].file, "general-todo");
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].branch, null);
});

test("parseFilterOptions：--claimed-since 校验格式与真实日期；其余 flag 透传", () => {
  assert.equal(parseFilterOptions({ "claimed-since": "2026-13-01" }).ok, false);
  assert.equal(parseFilterOptions({ "claimed-since": "2026-02-30" }).ok, false);
  assert.equal(parseFilterOptions({ "claimed-since": "2026-02-29" }).ok, false, "2026 非闰年");
  assert.equal(parseFilterOptions({ "claimed-since": "2028-02-29" }).ok, true, "2028 闰年");
  const bad = parseFilterOptions({ "claimed-since": "not-a-date" });
  assert.deepEqual(bad, { ok: false, code: "BAD_FILTER", message: "--claimed-since 需要 YYYY-MM-DD 日期" });

  const parsed = parseFilterOptions({ status: "open", tag: "性能", "claimed-since": "2026-09-01", json: true });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.filter, { status: "open", tag: "性能", claimedSince: "2026-09-01" });
    assert.equal(parsed.json, true);
  }
  assert.deepEqual(parseFilterOptions({}).filter, {});
  assert.deepEqual(parseFilterOptions({ tag: "" }).filter, {}, "空串 flag 视作未提供");
});
