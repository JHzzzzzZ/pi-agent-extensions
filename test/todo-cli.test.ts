/**
 * todo CLI 的纯逻辑 + 临时目录功能单测（工具本体见 tools/todo.mjs）。
 *
 * 边界说明：这里覆盖解析/状态判定/查重/标注等可在文件系统边界内验证的行为；
 * 真实仓库 `todos/` 上的写操作只允许在临时 fixture 目录里演练，测试不触碰
 * 仓库真实条目（防止把跑测试变成改待办）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  appendEntry,
  completeEntry,
  findDuplicates,
  main,
  parseTodoFile,
  resolveTodoPath,
  setProcessing,
  summarize,
} from "../tools/todo.mjs";

const FIXTURE = [
  "# 某插件 TODO",
  "",
  "- [ ] 未领取的条目：做点事情",
  "- [x] 已完成的条目（完成 2026-09-11 @ feat/x）",
  "- [ ] 进行中的条目（processing 2026-09-11 @ feat/y：在做）",
  "  - 子说明不是条目",
  "- [ ] 另一条未领取",
  "",
].join("\n");

test("parseTodoFile：识别勾选/进行中/未领取，忽略缩进说明行", () => {
  const entries = parseTodoFile(FIXTURE);
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((e) => [e.status, e.line]),
    [
      ["open", 3],
      ["done", 4],
      ["processing", 5],
      ["open", 7],
    ],
  );
  assert.match(entries[0].text, /^未领取的条目/);
});

test("summarize：按文件汇总三态计数", () => {
  const summary = summarize([
    { name: "a-todo", content: FIXTURE },
    { name: "b-todo", content: "- [ ] 一条\n" },
  ]);
  assert.deepEqual(summary, [
    { name: "a-todo", open: 2, processing: 1, done: 1, total: 4 },
    { name: "b-todo", open: 1, processing: 0, done: 0, total: 1 },
  ]);
});

test("findDuplicates：跨文件归一化查重（空白/大小写/标注差异不算新）", () => {
  const docs = [
    { name: "general-todo", content: FIXTURE },
    { name: "loop-todo", content: "- [ ] 另一个需求（processing 2026-09-10 @ feat/z）\n" },
  ];
  const hit = findDuplicates("另一个需求", docs);
  assert.deepEqual(hit.map((h) => h.name), ["loop-todo"]);
  assert.equal(findDuplicates("全新的需求描述", docs).length, 0);
});

test("appendEntry：补尾行后追加，不破坏既有内容", () => {
  const out = appendEntry("# t\n\n- [ ] a\n", "b");
  assert.equal(out, "# t\n\n- [ ] a\n- [ ] b\n");
  const noTrailing = appendEntry("# t", "c");
  assert.equal(noTrailing, "# t\n- [ ] c\n");
});

test("setProcessing：唯一定位后加标注，重复标注幂等，缺失/歧义报错", () => {
  const ok = setProcessing(FIXTURE, "未领取的条目");
  assert.equal(ok.ok, true);
  assert.match(ok.content, /- \[ \] 未领取的条目：做点事情（processing）/);

  const again = setProcessing(ok.content, "未领取的条目");
  assert.equal(again.ok, true);
  assert.equal(again.content, ok.content);

  const missing = setProcessing(FIXTURE, "不存在的条目");
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "NOT_FOUND");

  const ambiguous = setProcessing(FIXTURE, "条目");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, "AMBIGUOUS");
});

test("completeEntry：勾选并去 processing，可附完成注记", () => {
  const done = completeEntry(FIXTURE, "进行中的条目", "feat/y：做完");
  assert.equal(done.ok, true);
  assert.match(done.content, /- \[x\] 进行中的条目（完成 feat\/y：做完）/);
  assert.doesNotMatch(done.content, /processing/);

  const plain = completeEntry(FIXTURE, "另一条未领取");
  assert.match(plain.content, /- \[x\] 另一条未领取/);
});

test("CRLF 文件：解析与写回都保持 Windows 行尾（真实 todos/ 是 CRLF）", () => {
  const crlf = "# t\r\n\r\n- [ ] 一条需求\r\n";
  const entries = parseTodoFile(crlf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "一条需求");
  const claimed = setProcessing(crlf, "一条需求");
  assert.equal(claimed.ok, true);
  assert.equal(claimed.content, "# t\r\n\r\n- [ ] 一条需求（processing）\r\n");
  const completed = completeEntry(claimed.content, "一条需求", "feat/x");
  assert.equal(completed.content, "# t\r\n\r\n- [x] 一条需求（完成 feat/x）\r\n");
  assert.equal(appendEntry(crlf, "新条目"), "# t\r\n\r\n- [ ] 一条需求\r\n- [ ] 新条目\r\n");
});

test("resolveTodoPath：只允许 todos/ 内的文件，拒绝路径穿越", () => {
  const root = path.resolve("/tmp/todo-cli-root");
  assert.equal(resolveTodoPath("general", root), path.join(root, "todos", "general-todo.md"));
  assert.equal(resolveTodoPath("general-todo.md", root), path.join(root, "todos", "general-todo.md"));
  assert.equal(resolveTodoPath("../package.json", root), null);
  assert.equal(resolveTodoPath("a/b", root), null);
});

test("main：add/list/claim/complete 在临时仓库上闭环，写操作不外溢", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-"));
  fs.mkdirSync(path.join(root, "todos"));
  fs.writeFileSync(path.join(root, "todos", "general-todo.md"), "# 通用 TODO\n\n");
  const out = [];

  const add = main(["add", "--file", "general", "第一条需求"], { repoRoot: root, log: (l) => out.push(l) });
  assert.equal(add, 0);
  assert.match(fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8"), /- \[ \] 第一条需求\n$/);

  const dup = main(["add", "--file", "general", "第一条需求"], { repoRoot: root, log: (l) => out.push(l) });
  assert.equal(dup, 1);
  assert.match(out.join("\n"), /重复/);

  assert.equal(main(["claim", "--file", "general", "--match", "第一条需求"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8"), /（processing）/);

  assert.equal(main(["complete", "--file", "general", "--match", "第一条需求", "--note", "测试"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8"), /- \[x\] 第一条需求（完成 测试）/);

  assert.equal(main(["list", "--status", "done"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /第一条需求/);
});
