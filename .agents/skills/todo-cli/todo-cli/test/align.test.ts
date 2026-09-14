/**
 * todo-cli/align.test.ts — 对齐文档契约纯函数单测（零 IO）。
 *
 * 边界：align.ts 只做「路径派生 + 文本结构校验」，不碰文件系统（文件存在性在
 * core.runAlign 里判，见根 test/todo-cli.test.ts 的命令闭环）。本文件用内存字符串
 * 构造对齐文档，锁定：路径形态、四小节 + 条目标记的 fail-closed 清单、顺序无关。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { ALIGN_SECTIONS, alignDocPath, alignDocRelPath, validateAlignDoc } from "../align.ts";

const TARGET = { name: "todo-cli-todo", id: 11 };

/** 组装一份对齐文档：五处内容都可被覆盖成残缺形态。 */
function makeDoc(
  parts: Partial<{ heading: string; intent: string; scope: string; acceptance: string; confirm: string }> = {},
): string {
  const {
    heading = "todo-cli-todo#11 状态机扩为对齐驱动",
    intent = "把「领取即开工」拆成两段式，返工前先对齐意图。",
    scope = "只改 todo-cli 与其测试；明确不做依赖门。",
    acceptance = "五态迁移表有测试锁定，四门全绿。",
    confirm = "确认人：蒋晗；日期：2026-09-14；方式：会话内逐条确认。",
  } = parts;
  return [
    `# ${heading}`,
    "",
    "## 意图",
    intent,
    "",
    "## 范围",
    scope,
    "",
    "## 验收标准",
    acceptance,
    "",
    "## 人工确认",
    confirm,
    "",
  ].join("\n");
}

test("alignDocPath / alignDocRelPath：固定派生 todos/align/<文件基名>#<id>.md", () => {
  const root = path.resolve("/tmp/todo-align-root");
  assert.equal(alignDocRelPath("todo-cli-todo", 11), "todos/align/todo-cli-todo#11.md");
  assert.equal(alignDocPath(root, "todo-cli-todo", 11), path.join(root, "todos", "align", "todo-cli-todo#11.md"));
  assert.equal(alignDocRelPath("general-todo", 1), "todos/align/general-todo#1.md");
});

test("validateAlignDoc：完整文档通过（小节顺序无关）", () => {
  assert.deepEqual(validateAlignDoc(makeDoc(), TARGET), { ok: true });
  const reordered = [
    "# todo-cli-todo#11 标题",
    "## 范围",
    "范围内",
    "## 人工确认",
    "确认人：蒋晗",
    "## 验收标准",
    "测试全绿",
    "## 意图",
    "对齐意图",
  ].join("\n");
  assert.deepEqual(validateAlignDoc(reordered, TARGET), { ok: true });
});

test("validateAlignDoc：空文档报出全部缺项（条目标记 + 四小节）", () => {
  const result = validateAlignDoc("", TARGET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.missing, ["todo-cli-todo#11", "## 意图", "## 范围", "## 验收标准", "## 人工确认"]);
});

test("validateAlignDoc：缺条目标记（含串条目 #1 vs #11）不放过", () => {
  const result = validateAlignDoc(makeDoc({ heading: "另一条目的对齐文档" }), TARGET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.missing, ["todo-cli-todo#11"]);

  const otherEntry = validateAlignDoc(makeDoc({ heading: "todo-cli-todo#1 别的条目" }), TARGET);
  assert.equal(otherEntry.ok, false, "#1 不得被当作 #11 的标记");

  const longerId = validateAlignDoc(makeDoc({ heading: "todo-cli-todo#112 越界 id" }), TARGET);
  assert.equal(longerId.ok, false, "#112 不得被当作 #11 的标记");
});

test("validateAlignDoc：缺小节 / 小节只有标题没有正文，各自报缺", () => {
  const noAcceptance = validateAlignDoc(makeDoc({ acceptance: "" }), TARGET);
  assert.equal(noAcceptance.ok, false);
  if (noAcceptance.ok) return;
  assert.deepEqual(noAcceptance.missing, ["## 验收标准"], "空正文视为缺小节");

  const onlyHeadings = ["# todo-cli-todo#11 标题", "## 意图", "## 范围", "## 验收标准", "## 人工确认"].join("\n");
  const result = validateAlignDoc(onlyHeadings, TARGET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.missing, ["## 意图", "## 范围", "## 验收标准", "## 人工确认"]);

  const missingSection = makeDoc().replace("## 范围\n", "");
  const dropped = validateAlignDoc(missingSection, TARGET);
  assert.equal(dropped.ok, false);
  if (dropped.ok) return;
  assert.deepEqual(dropped.missing, ["## 范围"]);
});

test("ALIGN_SECTIONS：四小节名与契约单一来源", () => {
  assert.deepEqual([...ALIGN_SECTIONS], ["意图", "范围", "验收标准", "人工确认"]);
});
