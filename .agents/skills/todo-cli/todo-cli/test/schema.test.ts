/**
 * todo-cli/schema.test.ts — todos JSON schema 纯函数单测（方案 C，todos/todo-cli-todo.md:17）。
 *
 * 边界：schema 是零 IO 的纯函数层（解析/校验/序列化/nextId），本文件不碰文件系统；
 * 落盘与锁的边界行为在 lock.test.ts / 根 test/todo-cli.test.ts 覆盖。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { nextId, parseTodoJson, serializeTodo } from "../schema.ts";
import type { TodoFileData } from "../schema.ts";

const VALID = {
  version: 1,
  title: "通用 TODO",
  entries: [
    {
      id: 1,
      text: "一条未领取",
      status: "open",
      branch: null,
      tags: [],
      notes: [],
      createdAt: "2026-09-12T00:00:00.000Z",
      claimedAt: null,
      completedAt: null,
    },
    {
      id: 2,
      text: "一条进行中",
      status: "processing",
      branch: "feat/x",
      tags: ["性能"],
      notes: ["2026-09-11 备注一", "备注二"],
      createdAt: null,
      claimedAt: "2026-09-12T01:00:00.000Z",
      completedAt: null,
    },
    {
      id: 3,
      text: "一条完成",
      status: "done",
      branch: "feat/x",
      tags: [],
      notes: ["feat/x：做完"],
      createdAt: null,
      claimedAt: null,
      completedAt: "2026-09-12T02:00:00.000Z",
    },
  ],
} as const;

test("parseTodoJson：合法数据原样通过，字段类型保持", () => {
  const parsed = parseTodoJson(JSON.stringify(VALID), "todos/general-todo.json");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.version, 1);
  assert.equal(parsed.data.title, "通用 TODO");
  assert.equal(parsed.data.entries.length, 3);
  assert.equal(parsed.data.entries[1].branch, "feat/x");
  assert.deepEqual(parsed.data.entries[1].tags, ["性能"]);
  assert.deepEqual(parsed.data.entries[1].notes, ["2026-09-11 备注一", "备注二"]);
  assert.equal(parsed.data.entries[2].completedAt, "2026-09-12T02:00:00.000Z");
});

test("parseTodoJson：非法 JSON → BAD_JSON，合并冲突标记有专门提示", () => {
  const conflict = parseTodoJson("<<<<<<< HEAD\n{}\n>>>>>>> other\n", "todos/a-todo.json");
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.code, "BAD_JSON");
  assert.match(conflict.message, /合并冲突/);
  assert.match(conflict.message, /todos\/a-todo\.json/);

  const broken = parseTodoJson("{ not json", "todos/a-todo.json");
  assert.equal(broken.ok, false);
  if (broken.ok) return;
  assert.equal(broken.code, "BAD_JSON");
});

test("parseTodoJson：结构不合法逐项拒绝（version/entries/条目字段）", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ version: 2, title: "t", entries: [] }, /version 必须是 1/],
    [{ version: 1, title: "t", entries: "nope" }, /entries 必须是数组/],
    [{ version: 1, entries: [] }, /title 必须是字符串/],
    [{ version: 1, title: "t", entries: [{ id: 1 }] }, /text/],
    [
      {
        version: 1,
        title: "t",
        entries: [{ id: "1", text: "x", status: "open", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null }],
      },
      /id/,
    ],
    [
      {
        version: 1,
        title: "t",
        entries: [{ id: 1, text: "x", status: "bogus", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null }],
      },
      /status/,
    ],
    [
      {
        version: 1,
        title: "t",
        entries: [{ id: 1, text: "x", status: "open", branch: null, tags: [1], notes: [], createdAt: null, claimedAt: null, completedAt: null }],
      },
      /tags/,
    ],
    [
      {
        version: 1,
        title: "t",
        entries: [{ id: 1, text: "x", status: "open", branch: null, tags: [], notes: [null], createdAt: null, claimedAt: null, completedAt: null }],
      },
      /notes/,
    ],
  ];
  for (const [input, pattern] of cases) {
    const parsed = parseTodoJson(JSON.stringify(input), "todos/a-todo.json");
    assert.equal(parsed.ok, false, `应拒绝：${JSON.stringify(input)}`);
    if (parsed.ok) continue;
    assert.equal(parsed.code, "BAD_SCHEMA");
    assert.match(parsed.message, pattern);
  }
});

test("serializeTodo：两空格缩进 + LF 尾换行，parse(serialize) 恒等", () => {
  const data = VALID as unknown as TodoFileData;
  const text = serializeTodo(data);
  assert.ok(text.endsWith("}\n"), "尾换行");
  assert.ok(!text.includes("\r"), "LF 行尾");
  assert.ok(text.includes('\n  "version": 1,'), "两空格缩进");
  const round = parseTodoJson(text, "x");
  assert.equal(round.ok, true);
  if (!round.ok) return;
  assert.deepEqual(round.data, data);
});

test("nextId：取最大 id + 1，空文件从 1 起，缺口不复用", () => {
  assert.equal(nextId([]), 1);
  assert.equal(nextId(VALID.entries.map((e) => ({ ...e }))), 4);
  assert.equal(nextId([{ ...VALID.entries[0], id: 7 }, { ...VALID.entries[1], id: 3 }]), 8);
});
