/**
 * todo-cli/depends.test.ts — 依赖引用与依赖图纯函数单测（todo-cli-todo:10 依赖门）。
 *
 * 边界：零 IO 纯函数（引用归一 / 写入期校验 / 全量扫描 / 阻塞判定 / 反查）。
 * CLI 层行为（claim 门、dep 子命令、list 标记、lint 汇总、complete 提示）在
 * test/todo-cli.test.ts 覆盖；并发写在 test/concurrency.test.ts 用真实子进程覆盖。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  blockedByMap,
  blockingDeps,
  checkDepWrite,
  dependentsOf,
  findDepProblems,
  formatDepRef,
  normalizeDepRef,
  parseDepRef,
} from "../depends.ts";

function dep(file, id, status, dependsOn = []) {
  return { file, id, status, dependsOn };
}

test("parseDepRef / normalizeDepRef：四种文件写法归一到 文件基名#id，非法引用一律拒绝", () => {
  const expected = { file: "general-todo", id: 11 };
  assert.deepEqual(parseDepRef("general-todo#11"), expected);
  assert.deepEqual(parseDepRef("general#11"), expected, "短名与 --file 同口径");
  assert.deepEqual(parseDepRef("general-todo.json#11"), expected);
  assert.deepEqual(parseDepRef("general-todo.md#11"), expected);
  assert.deepEqual(parseDepRef("  general #7 "), { file: "general-todo", id: 7 }, "# 两侧空白容忍");

  assert.equal(normalizeDepRef("general#11"), "general-todo#11", "存储形态统一为规范引用");
  assert.equal(formatDepRef({ file: "a-todo", id: 3 }), "a-todo#3");

  for (const bad of ["general", "#11", "general#", "general#0", "general#-1", "general#1.5", "general#11x", "../x#1", "a/b#1", "a\\b#1", ""]) {
    assert.equal(parseDepRef(bad), null, `非法引用应拒绝：${JSON.stringify(bad)}`);
    assert.equal(normalizeDepRef(bad), null, `非法引用应拒绝：${JSON.stringify(bad)}`);
  }
});

test("checkDepWrite：目标不存在 / 自引用 / 成环各自报出问题，合法新增通过", () => {
  const entries = [
    dep("a-todo", 1, "aligned"),
    dep("a-todo", 2, "open", ["a-todo#1"]),
    dep("b-todo", 3, "processing"),
  ];
  assert.deepEqual(checkDepWrite({ file: "a-todo", id: 1, dependsOn: ["b-todo#3"] }, entries), [], "干净新增通过");
  assert.deepEqual(checkDepWrite({ file: "a-todo", id: 1, dependsOn: ["a-todo#1"] }, entries), [
    { owner: "a-todo#1", code: "DEP_SELF", detail: "a-todo#1" },
  ]);
  assert.deepEqual(checkDepWrite({ file: "a-todo", id: 1, dependsOn: ["a-todo#99"] }, entries), [
    { owner: "a-todo#1", code: "DEP_NOT_FOUND", detail: "a-todo#99" },
  ]);
  assert.deepEqual(checkDepWrite({ file: "a-todo", id: 1, dependsOn: ["a-todo#2"] }, entries), [
    { owner: "a-todo#1", code: "DEP_CYCLE", detail: "a-todo#1 → a-todo#2 → a-todo#1" },
  ], "候选者新增依赖后回到自身即环");
});

test("checkDepWrite：跨文件环按环路径报出；菱形（两条路径到同一节点）不算环", () => {
  const entries = [
    dep("a-todo", 1, "open", ["b-todo#2"]),
    dep("b-todo", 2, "open", ["c-todo#3"]),
    dep("c-todo", 3, "done"),
    dep("a-todo", 4, "open", ["c-todo#3"]),
  ];
  assert.deepEqual(
    checkDepWrite({ file: "a-todo", id: 4, dependsOn: ["c-todo#3", "b-todo#2"] }, entries),
    [],
    "共享同一前提的两条路径不是环",
  );
  assert.deepEqual(checkDepWrite({ file: "c-todo", id: 3, dependsOn: ["a-todo#1"] }, entries), [
    { owner: "c-todo#3", code: "DEP_CYCLE", detail: "c-todo#3 → a-todo#1 → b-todo#2 → c-todo#3" },
  ]);
});

test("findDepProblems：全量扫描分类悬空/自引用/环，干净台账返回空", () => {
  assert.deepEqual(findDepProblems([dep("a-todo", 1, "open", ["a-todo#2"]), dep("a-todo", 2, "done")]), []);

  assert.deepEqual(
    findDepProblems([
      dep("a-todo", 1, "open", ["a-todo#9"]),
      dep("a-todo", 2, "open", ["a-todo#2"]),
      dep("a-todo", 3, "open", ["a-todo#4"]),
      dep("a-todo", 4, "open", ["a-todo#3"]),
      dep("b-todo", 1, "open"),
    ]),
    [
      { owner: "a-todo#1", code: "DEP_NOT_FOUND", detail: "a-todo#9" },
      { owner: "a-todo#2", code: "DEP_SELF", detail: "a-todo#2" },
      { owner: "a-todo#3", code: "DEP_CYCLE", detail: "a-todo#3 → a-todo#4 → a-todo#3" },
    ],
  );
});

test("blockingDeps：只看直接依赖，done 即解锁，悬空目标也算阻塞且状态为 null", () => {
  const entries = [dep("b-todo", 1, "done"), dep("c-todo", 1, "open")];
  assert.deepEqual(blockingDeps({ dependsOn: ["b-todo#1", "c-todo#1", "d-todo#1"] }, entries), [
    { ref: "c-todo#1", status: "open" },
    { ref: "d-todo#1", status: null },
  ], "顺序沿用 dependsOn，done 不进清单");
  assert.deepEqual(blockingDeps({ dependsOn: [] }, entries), []);
});

test("blockedByMap：一次建图算全量阻塞清单（空数组 = 可开工）", () => {
  const entries = [
    dep("a-todo", 1, "aligned", ["b-todo#1", "c-todo#1", "d-todo#9"]),
    dep("b-todo", 1, "done"),
    dep("c-todo", 1, "open"),
    dep("d-todo", 1, "open"),
  ];
  const map = blockedByMap(entries);
  assert.deepEqual(map.get("a-todo#1"), ["c-todo#1", "d-todo#9"], "done 不进清单，悬空也算阻塞");
  assert.deepEqual(map.get("b-todo#1"), []);
  assert.equal(map.size, 4, "每个条目都有清单（含无依赖者）");
});

test("dependentsOf：反查直接依赖者，已完成的依赖者不进清单", () => {
  const entries = [
    dep("c-todo", 1, "open"),
    dep("a-todo", 1, "aligned", ["c-todo#1"]),
    dep("a-todo", 2, "done", ["c-todo#1"]),
    dep("a-todo", 3, "processing", ["a-todo#1"]),
  ];
  assert.deepEqual(dependentsOf("c-todo#1", entries).map((e) => `${e.file}#${e.id}`), ["a-todo#1"]);
  assert.deepEqual(dependentsOf("a-todo#1", entries).map((e) => `${e.file}#${e.id}`), ["a-todo#3"]);
  assert.deepEqual(dependentsOf("nosuch-todo#1", entries), []);
});
