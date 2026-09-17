/**
 * todo-cli/query.test.ts — list 查询纯函数单测（方案 C：原生字段投影，无降级口径；
 * 五态标记与对齐字段见 todo-cli-todo:11，阻塞标记与 dependsOn 见 todo-cli-todo:10）。
 *
 * 边界：零 IO 纯函数；QueryEntry 由测试内联构造（字段口径见 schema.ts）；
 * 阻塞是 core 算好的派生字段（query 不查台账、不解析依赖图）。
 * priority（todo-cli-todo:15）是人读行标记与 `--sort priority` 的排序键。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyEntryFilter, parseFilterOptions, serializeEntries, sortByPriority, sortQueryEntries, statusMark } from "../query.ts";
import type { QueryEntry } from "../query.ts";

function entry(overrides: Partial<QueryEntry>): QueryEntry {
  return {
    file: "general-todo",
    id: 1,
    status: "open",
    text: "一条需求",
    branch: null,
    tags: [],
    priority: 5,
    dependsOn: [],
    blockedBy: [],
    createdAt: null,
    claimedAt: null,
    completedAt: null,
    alignedAt: null,
    ...overrides,
  };
}

const FIXTURE: QueryEntry[] = [
  entry({ id: 1, status: "open", text: "未领取条目" }),
  entry({ id: 2, status: "aligning", text: "对齐中条目", branch: "feat/a", claimedAt: "2026-09-12T01:00:00.000Z" }),
  entry({ id: 3, status: "aligned", text: "已对齐条目", branch: "feat/a", claimedAt: "2026-09-12T01:00:00.000Z", alignedAt: "2026-09-12T02:00:00.000Z" }),
  entry({ id: 4, status: "processing", text: "进行中条目", branch: "feat/todo-cli-json", tags: ["性能"], claimedAt: "2026-09-12T01:00:00.000Z", alignedAt: "2026-09-12T02:00:00.000Z" }),
  entry({ id: 5, status: "done", text: "完成条目", branch: "feat/todo-cli-json", tags: ["性能"], claimedAt: "2026-09-10T01:00:00.000Z", completedAt: "2026-09-11T01:00:00.000Z" }),
  entry({ id: 6, file: "zzz-todo", status: "open", text: "另一文件条目" }),
];

test("statusMark：五态各一标记", () => {
  assert.equal(statusMark("open"), "[ ]");
  assert.equal(statusMark("aligning"), "[?]");
  assert.equal(statusMark("aligned"), "[>]");
  assert.equal(statusMark("processing"), "[~]");
  assert.equal(statusMark("done"), "[x]");
});

test("applyEntryFilter：AND 组合，非法 status 给空结果", () => {
  assert.deepEqual(applyEntryFilter(FIXTURE, { status: "aligning" }).map((e) => e.id), [2]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { status: "aligned" }).map((e) => e.id), [3]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { status: "processing" }).map((e) => e.id), [4]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { branch: "todo-cli" }).map((e) => e.id), [4, 5]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { tag: "性能" }).map((e) => e.id), [4, 5]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { text: "条目" }).map((e) => e.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { file: "zzz-todo" }).map((e) => e.id), [6]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { claimedSince: "2026-09-11" }).map((e) => e.id), [2, 3, 4]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { branch: "todo-cli", tag: "性能", status: "done" }).map((e) => e.id), [5]);
  assert.deepEqual(applyEntryFilter(FIXTURE, { status: "bogus" as never }), []);
  assert.equal(applyEntryFilter(FIXTURE, {}), FIXTURE, "无过滤条件原样返回");
});

test("sortQueryEntries：file 升序 → id 升序，返回新数组", () => {
  const sorted = sortQueryEntries([FIXTURE[5], FIXTURE[0], FIXTURE[4], FIXTURE[1], FIXTURE[2], FIXTURE[3]]);
  assert.deepEqual(sorted.map((e) => `${e.file}#${e.id}`), [
    "general-todo#1",
    "general-todo#2",
    "general-todo#3",
    "general-todo#4",
    "general-todo#5",
    "zzz-todo#6",
  ]);
  assert.notEqual(sorted, FIXTURE);
});

test("serializeEntries：人读行 `${mark} ${file}#${id}  ${text}`；--json 带 alignedAt 单行整体输出", () => {
  const lines = serializeEntries(FIXTURE, { json: false });
  assert.deepEqual(lines, [
    "[ ] general-todo#1  [p5] 未领取条目",
    "[?] general-todo#2  [p5] 对齐中条目",
    "[>] general-todo#3  [p5] 已对齐条目",
    "[~] general-todo#4  [p5] 进行中条目",
    "[x] general-todo#5  [p5] 完成条目",
    "[ ] zzz-todo#6  [p5] 另一文件条目",
  ]);
  const json = serializeEntries(FIXTURE.slice(2, 3), { json: true });
  assert.equal(json.length, 1);
  const rows = JSON.parse(json[0]);
  assert.equal(rows[0].file, "general-todo");
  assert.equal(rows[0].id, 3);
  assert.equal(rows[0].status, "aligned");
  assert.equal(rows[0].alignedAt, "2026-09-12T02:00:00.000Z");
  assert.equal(rows[0].branch, "feat/a");
});

test("blocked 条目：人读行尾追加阻塞标记，非阻塞行字节不变；--json 带 dependsOn/blockedBy", () => {
  const fixture: QueryEntry[] = [
    entry({ id: 1, status: "processing", text: "前提" }),
    entry({
      id: 2,
      status: "aligned",
      text: "被阻塞条目",
      dependsOn: ["general-todo#1", "zzz-todo#9"],
      blockedBy: ["general-todo#1", "zzz-todo#9"],
    }),
    entry({ id: 3, status: "open", text: "无依赖" }),
  ];
  assert.deepEqual(serializeEntries(fixture, { json: false }), [
    "[~] general-todo#1  [p5] 前提",
    "[>] general-todo#2  [p5] 被阻塞条目 （阻塞：等待 general-todo#1, zzz-todo#9）",
    "[ ] general-todo#3  [p5] 无依赖",
  ]);

  const rows = JSON.parse(serializeEntries(fixture, { json: true })[0]);
  assert.deepEqual(rows[1].dependsOn, ["general-todo#1", "zzz-todo#9"], "原生字段进 JSON");
  assert.deepEqual(rows[1].blockedBy, ["general-todo#1", "zzz-todo#9"], "派生字段：非空即阻塞（不另设布尔位）");
  assert.deepEqual(rows[0].blockedBy, []);
  assert.deepEqual(rows[2].blockedBy, []);
});

test("parseFilterOptions：--claimed-since 校验格式与真实日期；其余 flag 透传", () => {
  assert.equal(parseFilterOptions({ "claimed-since": "2026-13-01" }).ok, false);
  assert.equal(parseFilterOptions({ "claimed-since": "2026-02-30" }).ok, false);
  assert.equal(parseFilterOptions({ "claimed-since": "2026-02-29" }).ok, false, "2026 非闰年");
  assert.equal(parseFilterOptions({ "claimed-since": "2028-02-29" }).ok, true, "2028 闰年");
  const bad = parseFilterOptions({ "claimed-since": "not-a-date" });
  assert.deepEqual(bad, { ok: false, code: "BAD_FILTER", message: "--claimed-since 需要 YYYY-MM-DD 日期" });

  const parsed = parseFilterOptions({ status: "aligning", tag: "性能", "claimed-since": "2026-09-01", json: true });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.filter, { status: "aligning", tag: "性能", claimedSince: "2026-09-01" });
    assert.equal(parsed.json, true);
  }
  assert.deepEqual(parseFilterOptions({}).filter, {});
  assert.deepEqual(parseFilterOptions({ tag: "" }).filter, {}, "空串 flag 视作未提供");
});

test("sortByPriority：priority 降序 → file 升序 → 文件内 id 升序；乱序输入同结果、返回新数组", () => {
  const fixture: QueryEntry[] = [
    entry({ file: "b-todo", id: 1, priority: 9 }),
    entry({ file: "a-todo", id: 2, priority: 9 }),
    entry({ file: "a-todo", id: 1, priority: 5 }),
    entry({ file: "a-todo", id: 3, priority: 9 }),
    entry({ file: "b-todo", id: 2, priority: 10 }),
    entry({ file: "b-todo", id: 3, priority: 1 }),
  ];
  const refs = (rows: QueryEntry[]) => rows.map((row) => `${row.file}#${row.id}`);
  const expected = ["b-todo#2", "a-todo#2", "a-todo#3", "b-todo#1", "a-todo#1", "b-todo#3"];
  assert.deepEqual(refs(sortByPriority(fixture)), expected);
  assert.deepEqual(refs(sortByPriority([...fixture].reverse())), expected, "与输入序无关");
  assert.notEqual(sortByPriority(fixture), fixture, "返回新数组");
});

test("serializeEntries：sort: \"priority\" 时行序 = (priority desc, file asc, id asc)；不传 sort 保持默认序", () => {
  const fixture: QueryEntry[] = [
    entry({ file: "b-todo", id: 1, priority: 9 }),
    entry({ file: "a-todo", id: 2, priority: 9 }),
    entry({ file: "a-todo", id: 1, priority: 5 }),
    entry({ file: "b-todo", id: 2, priority: 10 }),
  ];
  const refOf = (line: string) => /(\S+#\d+)/.exec(line)?.[1];
  assert.deepEqual(serializeEntries(fixture, { json: false, sort: "priority" }).map(refOf), [
    "b-todo#2",
    "a-todo#2",
    "b-todo#1",
    "a-todo#1",
  ]);
  assert.deepEqual(serializeEntries(fixture, { json: false }).map(refOf), [
    "a-todo#1",
    "a-todo#2",
    "b-todo#1",
    "b-todo#2",
  ], "不传 sort 时默认序（file → id）不变");
});

test("serializeEntries：人读行在 file#id 后插 [pN]（不零填充），阻塞后缀原样", () => {
  const fixture: QueryEntry[] = [
    entry({ id: 1, status: "done", text: "完成一条", priority: 10, completedAt: "2026-09-11T00:00:00.000Z" }),
    entry({ id: 2, status: "aligned", text: "被阻塞条目", priority: 7, dependsOn: ["general-todo#1"], blockedBy: ["general-todo#1"] }),
  ];
  assert.deepEqual(serializeEntries(fixture, { json: false }), [
    "[x] general-todo#1  [p10] 完成一条",
    "[>] general-todo#2  [p7] 被阻塞条目 （阻塞：等待 general-todo#1）",
  ]);
});

test("serializeEntries：--json 行对象带 priority（取值断言，不锁 key 序）", () => {
  const rows = JSON.parse(serializeEntries([entry({ id: 3, priority: 8 })], { json: true })[0]);
  assert.equal(rows[0].priority, 8);
});

test("parseFilterOptions：--sort 只接受 priority；其它值与空串 → BAD_FILTER 静态消息", () => {
  const ok = parseFilterOptions({ sort: "priority" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.sort, "priority");
  const bad = { ok: false, code: "BAD_FILTER", message: "--sort 只支持 priority" };
  assert.deepEqual(parseFilterOptions({ sort: "foo" }), bad);
  assert.deepEqual(parseFilterOptions({ sort: "" }), bad, "空串 flag 不静默默认");
  const none = parseFilterOptions({});
  assert.equal(none.ok, true);
  if (none.ok) assert.equal(none.sort, undefined);
});
