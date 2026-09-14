/**
 * todo-cli/schema.test.ts — todos JSON schema 纯函数单测（方案 C，todos/todo-cli-todo.md:17；
 * schema v2 对齐门 todo-cli-todo:11 + v3 依赖门 todo-cli-todo:10）。
 *
 * 边界：schema 是零 IO 的纯函数层（解析/校验/序列化/nextId），本文件不碰文件系统；
 * 落盘与锁的边界行为在 lock.test.ts / 根 test/todo-cli.test.ts 覆盖。
 * 本文件锁定的核心兼容契约：读 v1/v2/v3 都归一成 v3，写出一律 v3；
 * dependsOn 自 v3 起是必填原生字段，v1/v2 缺字段视作空数组。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { nextId, parseTodoJson, serializeTodo } from "../schema.ts";
import type { TodoFileData } from "../schema.ts";

const LATEST = {
  version: 3,
  title: "通用 TODO",
  entries: [
    {
      id: 1,
      text: "一条未领取",
      status: "open",
      branch: null,
      tags: [],
      dependsOn: [],
      notes: [],
      createdAt: "2026-09-12T00:00:00.000Z",
      claimedAt: null,
      completedAt: null,
      alignedAt: null,
    },
    {
      id: 2,
      text: "一条对齐中",
      status: "aligning",
      branch: "feat/x",
      tags: ["性能"],
      dependsOn: ["zzz-todo#1"],
      notes: ["2026-09-11 备注一", "备注二"],
      createdAt: null,
      claimedAt: "2026-09-12T01:00:00.000Z",
      completedAt: null,
      alignedAt: null,
    },
    {
      id: 3,
      text: "一条已对齐",
      status: "aligned",
      branch: "feat/x",
      tags: [],
      dependsOn: [],
      notes: [],
      createdAt: null,
      claimedAt: "2026-09-12T01:00:00.000Z",
      completedAt: null,
      alignedAt: "2026-09-12T02:00:00.000Z",
    },
    {
      id: 4,
      text: "一条进行中",
      status: "processing",
      branch: "feat/x",
      tags: [],
      dependsOn: [],
      notes: [],
      createdAt: null,
      claimedAt: "2026-09-12T03:00:00.000Z",
      completedAt: null,
      alignedAt: "2026-09-12T02:00:00.000Z",
    },
    {
      id: 5,
      text: "一条完成",
      status: "done",
      branch: "feat/x",
      tags: [],
      dependsOn: ["general-todo#1", "zzz-todo#4"],
      notes: ["feat/x：做完"],
      createdAt: null,
      claimedAt: null,
      completedAt: "2026-09-12T04:00:00.000Z",
      alignedAt: null,
    },
  ],
} as const;

/** schema v1 历史文件（无 alignedAt 字段、无新状态）——读兼容的输入形态。 */
const V1 = {
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
      notes: ["备注一"],
      createdAt: null,
      claimedAt: "2026-09-12T01:00:00.000Z",
      completedAt: null,
    },
  ],
} as const;

test("parseTodoJson：v1 历史文件可读，内存归一为 v3（alignedAt 与 dependsOn 补默认值）", () => {
  const parsed = parseTodoJson(JSON.stringify(V1), "todos/general-todo.json");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.version, 3, "v1 读入即归一为 v3");
  assert.equal(parsed.data.entries.length, 2);
  assert.deepEqual(
    parsed.data.entries.map((entry) => [entry.status, entry.branch, entry.alignedAt, entry.dependsOn]),
    [
      ["open", null, null, []],
      ["processing", "feat/x", null, []],
    ],
    "v1 无 alignedAt / dependsOn 字段 → 归一为 null / []，其余字段原样",
  );
  assert.deepEqual(parsed.data.entries[1].notes, ["备注一"]);
  assert.equal(parsed.data.entries[1].claimedAt, "2026-09-12T01:00:00.000Z");
});

test("parseTodoJson：v2 文件兼容读（五态 + alignedAt 保持，dependsOn 归一为空数组）", () => {
  const v2 = {
    version: 2,
    title: "通用 TODO",
    entries: [
      {
        id: 1,
        text: "一条已对齐",
        status: "aligned",
        branch: "feat/x",
        tags: [],
        notes: [],
        createdAt: null,
        claimedAt: "2026-09-12T01:00:00.000Z",
        completedAt: null,
        alignedAt: "2026-09-12T02:00:00.000Z",
      },
    ],
  };
  const parsed = parseTodoJson(JSON.stringify(v2), "todos/general-todo.json");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.version, 3, "v2 读入即归一为 v3");
  assert.equal(parsed.data.entries[0].alignedAt, "2026-09-12T02:00:00.000Z");
  assert.deepEqual(parsed.data.entries[0].dependsOn, [], "v2 无 dependsOn 字段 → []（不回填）");
});

test("parseTodoJson：v3 文件原样通过（五态 + alignedAt + dependsOn 保持）", () => {
  const parsed = parseTodoJson(JSON.stringify(LATEST), "todos/general-todo.json");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.version, 3);
  assert.deepEqual(
    parsed.data.entries.map((entry) => entry.status),
    ["open", "aligning", "aligned", "processing", "done"],
  );
  assert.equal(parsed.data.entries[2].alignedAt, "2026-09-12T02:00:00.000Z");
  assert.equal(parsed.data.entries[0].alignedAt, null);
  assert.deepEqual(parsed.data.entries[1].dependsOn, ["zzz-todo#1"], "依赖引用原样保留（schema 层不校验存在性）");
  assert.deepEqual(parsed.data.entries[4].dependsOn, ["general-todo#1", "zzz-todo#4"], "引用顺序保序");
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

test("parseTodoJson：结构不合法逐项拒绝（version/entries/条目字段，含 v2 alignedAt）", () => {
  const v2Entry = (overrides: Record<string, unknown>) => ({
    id: 1,
    text: "x",
    status: "open",
    branch: null,
    tags: [],
    notes: [],
    createdAt: null,
    claimedAt: null,
    completedAt: null,
    alignedAt: null,
    ...overrides,
  });
  const cases: Array<[unknown, RegExp]> = [
    [{ version: 4, title: "t", entries: [] }, /version 必须是 1、2 或 3/],
    [{ title: "t", entries: [] }, /version 必须是 1、2 或 3/],
    [{ version: 2, title: "t", entries: "nope" }, /entries 必须是数组/],
    [{ version: 2, entries: [] }, /title 必须是字符串/],
    [{ version: 2, title: "t", entries: [{ id: 1 }] }, /text/],
    [{ version: 2, title: "t", entries: [v2Entry({ id: "1" })] }, /id/],
    [{ version: 2, title: "t", entries: [v2Entry({ status: "bogus" })] }, /status/],
    [{ version: 2, title: "t", entries: [v2Entry({ tags: [1] })] }, /tags/],
    [{ version: 2, title: "t", entries: [v2Entry({ notes: [null] })] }, /notes/],
    [{ version: 2, title: "t", entries: [v2Entry({ alignedAt: 5 })] }, /alignedAt/],
    [{ version: 2, title: "t", entries: [v2Entry({ createdAt: 5 })] }, /createdAt/],
    [{ version: 3, title: "t", entries: [v2Entry({ dependsOn: null })] }, /dependsOn/],
    [{ version: 3, title: "t", entries: [v2Entry({ dependsOn: [1] })] }, /dependsOn/],
    [{ version: 3, title: "t", entries: [v2Entry()] }, /dependsOn/],
  ];
  for (const [input, pattern] of cases) {
    const parsed = parseTodoJson(JSON.stringify(input), "todos/a-todo.json");
    assert.equal(parsed.ok, false, `应拒绝：${JSON.stringify(input)}`);
    if (parsed.ok) continue;
    assert.equal(parsed.code, "BAD_SCHEMA");
    assert.match(parsed.message, pattern);
  }
});

test("parseTodoJson：v2 条目缺 alignedAt 字段 fail-closed；v1 缺则不算缺；v3 缺 dependsOn 也 fail-closed", () => {
  const missing = {
    version: 2,
    title: "t",
    entries: [
      { id: 1, text: "x", status: "open", branch: null, tags: [], notes: [], createdAt: null, claimedAt: null, completedAt: null },
    ],
  };
  const parsed = parseTodoJson(JSON.stringify(missing), "todos/a-todo.json");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.message, /alignedAt/);

  const missingDep = {
    version: 3,
    title: "t",
    entries: [
      {
        id: 1,
        text: "x",
        status: "open",
        branch: null,
        tags: [],
        notes: [],
        createdAt: null,
        claimedAt: null,
        completedAt: null,
        alignedAt: null,
      },
    ],
  };
  const parsedDep = parseTodoJson(JSON.stringify(missingDep), "todos/a-todo.json");
  assert.equal(parsedDep.ok, false, "v3 条目缺 dependsOn 是结构损坏，不静默补空数组");
  if (!parsedDep.ok) assert.match(parsedDep.message, /dependsOn/);
});

test("serializeTodo：两空格缩进 + LF 尾换行，输出恒为 version 3，parse(serialize) 恒等", () => {
  const data = LATEST as unknown as TodoFileData;
  const text = serializeTodo(data);
  assert.ok(text.endsWith("}\n"), "尾换行");
  assert.ok(!text.includes("\r"), "LF 行尾");
  assert.ok(text.includes('\n  "version": 3,'), "写出一律 v3");
  assert.ok(text.includes('"alignedAt"'), "alignedAt 是原生字段");
  assert.ok(text.includes('"dependsOn"'), "dependsOn 是原生字段");
  const round = parseTodoJson(text, "x");
  assert.equal(round.ok, true);
  if (!round.ok) return;
  assert.deepEqual(round.data, data);

  assert.ok(serializeTodo({ version: 3, title: "t", entries: [] }).includes('"version": 3'));
});

test("nextId：取最大 id + 1，空文件从 1 起，缺口不复用", () => {
  assert.equal(nextId([]), 1);
  assert.equal(nextId(LATEST.entries.map((e) => ({ ...e }))), 6);
  assert.equal(nextId([{ ...LATEST.entries[0], id: 7 }, { ...LATEST.entries[1], id: 3 }]), 8);
});
