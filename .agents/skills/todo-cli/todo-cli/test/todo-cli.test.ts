/**
 * todo CLI 的纯逻辑 + 临时目录功能单测（工具本体与测试同居：`.agents/skills/todo-cli/todo-cli/`）。
 *
 * 边界说明：这里覆盖查重/路径解析/命令闭环/triage 可在文件系统边界内验证的行为；
 * 存储是 `todos/<名>.json`（方案 C：JSON 唯一权威；v3 = 五态对齐门 + dependsOn 依赖门），写操作走锁 +
 * temp+rename 原子落盘——并发/中断边界在 test/{lock,concurrency,interrupt}.test.ts 用
 * 真实进程覆盖，仓库根发现（--root / git）在 test/root-discovery.test.ts 覆盖。本文件
 * 只在临时 fixture 目录演练写操作，不触碰仓库真实 todos/；末尾的进程边界 E2E 只跑只读命令。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  findDuplicateHits,
  main,
  normalizeText,
  parseMergedBranches,
  parseWorktrees,
  resolveTodoPath,
  triageRepo,
} from "../todo.mjs";
import { emptyTodoData, parseTodoJson, serializeTodo } from "../schema.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TODO_CLI = path.join(HERE, "..", "todo.mjs");
/** 本仓库根：工具住在 skill 目录里，从测试文件位置推断已不可靠，改问 git。 */
const REPO_ROOT = path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE, encoding: "utf8" }).trim());
const runCli = (args, cwd) =>
  spawnSync(process.execPath, [TODO_CLI, ...args], { cwd, encoding: "utf8", timeout: 30_000 });

/** 临时仓库 fixture：写入 todos/<名>.json；不传 content 则建空文件数据。 */
function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-main-"));
  fs.mkdirSync(path.join(root, "todos"));
  for (const [name, data] of Object.entries(files)) {
    const content = data === undefined ? emptyTodoData(name) : data;
    fs.writeFileSync(path.join(root, "todos", `${name}.json`), serializeTodo(content));
  }
  return root;
}

function readRepoData(root, name) {
  const parsed = parseTodoJson(fs.readFileSync(path.join(root, "todos", `${name}.json`), "utf8"), "test");
  assert.equal(parsed.ok, true, `${name}.json 必须始终可解析（原子写不留半态）`);
  return parsed.ok ? parsed.data : null;
}

/** 写一份结构完整的对齐文档（内容可按测试覆盖；空串正文用于制造缺小节）。 */
function writeAlignDoc(root, name, id, overrides = {}) {
  const parts = {
    heading: `${name}#${id} 对齐文档`,
    intent: "意图：把边界与术语问清。",
    scope: "范围：只改被测模块，不做范围外。",
    acceptance: "验收标准：测试全绿。",
    confirm: "人工确认：确认人、日期、方式。",
    ...overrides,
  };
  const lines = [`# ${parts.heading}`, ""];
  for (const [title, body] of [
    ["意图", parts.intent],
    ["范围", parts.scope],
    ["验收标准", parts.acceptance],
    ["人工确认", parts.confirm],
  ]) {
    lines.push(`## ${title}`);
    if (body !== "") lines.push(body);
    lines.push("");
  }
  const dir = path.join(root, "todos", "align");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}#${id}.md`);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

/** 内联条目构造：默认 v3 全字段（alignedAt / dependsOn 原生）。 */
function entry(id, text, status, extra = {}) {
  return {
    id,
    text,
    status,
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

test("normalizeText / findDuplicateHits：归一化查重口径不变（标注/空白/大小写/句读差异不算新）", () => {
  assert.equal(normalizeText("做点事情（processing）"), normalizeText("做点事情"));
  const entries = [
    { name: "a-todo", id: 1, status: "open", text: "另一个需求描述更长一些" },
    { name: "a-todo", id: 2, status: "open", text: "全新的需求描述在这里" },
  ];
  assert.deepEqual(findDuplicateHits("另一个需求描述更长一些", entries).map((h) => h.kind), ["exact"]);
  assert.deepEqual(findDuplicateHits("另一个需求描述更长", entries).map((h) => [h.id, h.kind]), [[1, "similar"]], "短边 ≥8 的包含算 similar");
  assert.equal(findDuplicateHits("完全无关的新需求", entries).length, 0);
  assert.equal(findDuplicateHits("", entries).length, 0);
});

test("resolveTodoPath：四种输入归一到 todos/<名>.json，拒绝路径穿越", () => {
  const root = path.resolve("/tmp/todo-cli-root");
  const expected = path.join(root, "todos", "general-todo.json");
  assert.equal(resolveTodoPath("general", root), expected);
  assert.equal(resolveTodoPath("general-todo", root), expected);
  assert.equal(resolveTodoPath("general-todo.md", root), expected, "旧 md 引用向后兼容");
  assert.equal(resolveTodoPath("general-todo.json", root), expected);
  assert.equal(resolveTodoPath("../package.json", root), null);
  assert.equal(resolveTodoPath("a/b", root), null);
  assert.equal(resolveTodoPath("", root), null);
});

test("main：add/dup/claim/align/complete 在临时仓库上闭环，JSON 字段原生落盘", () => {
  const root = makeRepo({ "general-todo": undefined });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-12T00:00:00.000Z" };

  assert.equal(main(["add", "--file", "general", "第一条需求"], deps), 0);
  let data = readRepoData(root, "general-todo");
  assert.equal(data.version, 3, "新建文件即 v3");
  assert.equal(data.entries.length, 1);
  assert.deepEqual(data.entries[0], {
    id: 1,
    text: "第一条需求",
    status: "open",
    branch: null,
    tags: [],
    dependsOn: [],
    notes: [],
    createdAt: "2026-09-12T00:00:00.000Z",
    claimedAt: null,
    completedAt: null,
    alignedAt: null,
  });
  assert.match(out.join("\n"), /已登记到 todos\/general-todo\.json：第一条需求/);

  assert.equal(main(["add", "--file", "general", "第一条需求"], deps), 1, "查重拒绝");
  assert.match(out.join("\n"), /重复（exact）：general-todo#1/);
  assert.equal(readRepoData(root, "general-todo").entries.length, 1, "拒绝时不写入");
  assert.equal(main(["add", "--file", "general", "第二条需求", "--force"], deps), 0, "--force 放行");
  assert.equal(readRepoData(root, "general-todo").entries[1].id, 2, "id 取 max+1");

  // 第一段：open → aligning（写分支引用与首次领取时间，并提示对齐文档）
  out.length = 0;
  assert.equal(main(["claim", "--file", "general", "--match", "第一条需求", "--branch", "feat/first"], deps), 0);
  data = readRepoData(root, "general-todo");
  assert.equal(data.entries[0].status, "aligning", "首次领取进 aligning，不直接开工");
  assert.equal(data.entries[0].branch, "feat/first");
  assert.equal(data.entries[0].claimedAt, "2026-09-12T00:00:00.000Z");
  assert.equal(data.entries[0].alignedAt, null);
  assert.match(out.join("\n"), /todos\/align\/general-todo#1\.md/, "输出派生的对齐文档路径");
  assert.match(out.join("\n"), /## 意图、## 范围、## 验收标准、## 人工确认/, "输出必填小节名");

  assert.equal(main(["claim", "--file", "general", "--match", "第一条需求"], deps), 0);
  assert.match(out.join("\n"), /已领取（状态未变）/);
  assert.equal(main(["claim", "--file", "general", "--match", "不存在"], deps), 1);
  assert.match(out.join("\n"), /NOT_FOUND：没有匹配条目/);
  assert.equal(main(["claim", "--file", "general", "--match", "条"], deps), 1);
  assert.match(out.join("\n"), /AMBIGUOUS：匹配到多条/);

  // 对齐门：无文档不放行 → 补文档 → aligned
  out.length = 0;
  assert.equal(main(["align", "--file", "general", "--match", "第一条需求"], deps), 1);
  assert.match(out.join("\n"), /ALIGN_DOC_MISSING：缺少对齐文档 todos\/align\/general-todo#1\.md/);
  assert.equal(readRepoData(root, "general-todo").entries[0].status, "aligning", "门没过不写盘");
  writeAlignDoc(root, "general-todo", 1);
  assert.equal(main(["align", "--file", "general", "--match", "第一条需求"], deps), 0);
  data = readRepoData(root, "general-todo");
  assert.equal(data.entries[0].status, "aligned");
  assert.equal(data.entries[0].alignedAt, "2026-09-12T00:00:00.000Z");
  assert.equal(main(["align", "--file", "general", "--match", "第一条需求"], deps), 0);
  assert.match(out.join("\n"), /已对齐（状态未变）/);

  // 第二段：aligned → processing（无人值守开工）
  assert.equal(main(["claim", "--file", "general", "--match", "第一条需求"], deps), 0);
  data = readRepoData(root, "general-todo");
  assert.equal(data.entries[0].status, "processing");
  assert.equal(data.entries[0].branch, "feat/first", "未提供 --branch 时保留原引用");
  assert.match(out.join("\n"), /进入 processing/);

  assert.equal(main(["complete", "--file", "general", "--match", "第一条需求"], deps), 0);
  data = readRepoData(root, "general-todo");
  assert.equal(data.entries[0].status, "done");
  assert.equal(data.entries[0].completedAt, "2026-09-12T00:00:00.000Z");
  assert.deepEqual(data.entries[0].notes, [], "无 --note 不加注记");

  assert.equal(main(["claim", "--file", "general", "--match", "第一条需求"], deps), 1, "已完成条目不可领取");
  assert.match(out.join("\n"), /ALREADY_DONE：条目已完成，不能再领取/);
  assert.equal(main(["complete", "--file", "general", "--match", "第一条需求"], deps), 0);
  assert.match(out.join("\n"), /已完成（状态未变）/);
});

test("main：claim 两段式迁移表——aligning/processing 幂等，aligned 覆盖或保留 branch", () => {
  const root = makeRepo({
    "general-todo": {
      version: 2,
      title: "t",
      entries: [
        entry(1, "对齐中条目", "aligning", { branch: "feat/old", claimedAt: "2026-09-01T00:00:00.000Z" }),
        entry(2, "已对齐覆盖分支", "aligned", { branch: "feat/old", alignedAt: "2026-09-02T00:00:00.000Z" }),
        entry(3, "已对齐保留分支", "aligned", { branch: "feat/keep", alignedAt: "2026-09-02T00:00:00.000Z" }),
        entry(4, "已对齐无分支", "aligned", { alignedAt: "2026-09-02T00:00:00.000Z" }),
        entry(5, "进行中条目", "processing", { branch: "feat/wip" }),
        entry(6, "完成条目", "done", { completedAt: "2026-09-03T00:00:00.000Z" }),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };

  assert.equal(main(["claim", "--file", "general", "--match", "对齐中条目", "--branch", "feat/ignored"], deps), 0);
  assert.match(out.join("\n"), /已领取（状态未变）/);
  let data = readRepoData(root, "general-todo");
  assert.equal(data.entries[0].status, "aligning");
  assert.equal(data.entries[0].branch, "feat/old", "aligning 幂等不覆盖 branch");
  assert.equal(data.entries[0].claimedAt, "2026-09-01T00:00:00.000Z", "claimedAt 首次领取后不再覆盖");

  assert.equal(main(["claim", "--file", "general", "--match", "已对齐覆盖分支", "--branch", "feat/new"], deps), 0);
  data = readRepoData(root, "general-todo");
  assert.equal(data.entries[1].status, "processing", "aligned → processing 需再次 claim");
  assert.equal(data.entries[1].branch, "feat/new", "提供了 --branch 就覆盖");
  assert.equal(data.entries[1].alignedAt, "2026-09-02T00:00:00.000Z", "alignedAt 保留");

  assert.equal(main(["claim", "--file", "general", "--match", "已对齐保留分支"], deps), 0);
  assert.equal(readRepoData(root, "general-todo").entries[2].branch, "feat/keep", "未提供 --branch 保留原值");

  assert.equal(main(["claim", "--file", "general", "--match", "已对齐无分支"], deps), 0);
  assert.equal(readRepoData(root, "general-todo").entries[3].branch, null, "无引用 + 未提供 → 仍为 null");

  out.length = 0;
  assert.equal(main(["claim", "--file", "general", "--match", "进行中条目"], deps), 0);
  assert.match(out.join("\n"), /已领取（状态未变）/);
  assert.equal(readRepoData(root, "general-todo").entries[4].branch, "feat/wip");

  assert.equal(main(["claim", "--file", "general", "--match", "完成条目"], deps), 1);
  assert.match(out.join("\n"), /ALREADY_DONE/);
});

test("main：align 失败路径——NOT_ALIGNING / ALIGN_DOC_MISSING / ALIGN_DOC_INCOMPLETE 均不写盘", () => {
  const root = makeRepo({
    "general-todo": {
      version: 2,
      title: "t",
      entries: [
        entry(1, "未领取条目", "open"),
        entry(2, "对齐中条目", "aligning", { branch: "feat/a", claimedAt: "2026-09-01T00:00:00.000Z" }),
        entry(3, "进行中条目", "processing"),
        entry(4, "完成条目", "done", { completedAt: "2026-09-03T00:00:00.000Z" }),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };

  for (const [match, label] of [
    ["未领取条目", "open"],
    ["进行中条目", "processing"],
    ["完成条目", "done"],
  ]) {
    out.length = 0;
    assert.equal(main(["align", "--file", "general", "--match", match], deps), 1, `${label} 不可确认对齐`);
    assert.match(out.join("\n"), /NOT_ALIGNING：条目不在 aligning 状态/);
  }
  const snapshot = JSON.stringify(readRepoData(root, "general-todo"));

  out.length = 0;
  assert.equal(main(["align", "--file", "general", "--match", "对齐中条目"], deps), 1);
  assert.match(out.join("\n"), /ALIGN_DOC_MISSING：缺少对齐文档 todos\/align\/general-todo#2\.md/);

  writeAlignDoc(root, "general-todo", 2, { heading: "别的条目", acceptance: "", confirm: "" });
  out.length = 0;
  assert.equal(main(["align", "--file", "general", "--match", "对齐中条目"], deps), 1);
  assert.match(
    out.join("\n"),
    /ALIGN_DOC_INCOMPLETE：对齐文档缺少小节：general-todo#2、## 验收标准、## 人工确认/,
  );
  assert.equal(JSON.stringify(readRepoData(root, "general-todo")), snapshot, "校验失败不写盘（状态/alignedAt 不变）");

  writeAlignDoc(root, "general-todo", 2);
  const note = "feat/a：已与人工逐条确认（含边界）";
  assert.equal(main(["align", "--file", "general", "--match", "对齐中条目", "--note", note], deps), 0);
  const aligned = readRepoData(root, "general-todo").entries[1];
  assert.equal(aligned.status, "aligned");
  assert.equal(aligned.alignedAt, "2026-09-14T00:00:00.000Z");
  assert.deepEqual(aligned.notes, [note], "align --note 逐字进 notes");
  assert.equal(aligned.claimedAt, "2026-09-01T00:00:00.000Z", "claimedAt 不被 align 覆盖");
});

test("main：complete 收口门——aligning/aligned 必带 --note，open/processing 可选", () => {
  const root = makeRepo({
    "general-todo": {
      version: 2,
      title: "t",
      entries: [
        entry(1, "未领取条目", "open"),
        entry(2, "对齐中条目", "aligning", { branch: "feat/a" }),
        entry(3, "已对齐条目", "aligned", { branch: "feat/a", alignedAt: "2026-09-02T00:00:00.000Z" }),
        entry(4, "进行中条目", "processing", { branch: "feat/a" }),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };

  assert.equal(main(["complete", "--file", "general", "--match", "未领取条目"], deps), 0, "open 无 note 可完成");
  assert.equal(readRepoData(root, "general-todo").entries[0].status, "done");

  out.length = 0;
  assert.equal(main(["complete", "--file", "general", "--match", "对齐中条目"], deps), 1);
  assert.match(out.join("\n"), /NOTE_REQUIRED：从对齐阶段收口必须带 --note 说明原因/);
  assert.equal(readRepoData(root, "general-todo").entries[1].status, "aligning", "缺 note 不写盘");
  assert.equal(main(["complete", "--file", "general", "--match", "对齐中条目", "--note", "搁置：范围太大"], deps), 0);
  assert.deepEqual(readRepoData(root, "general-todo").entries[1].notes, ["搁置：范围太大"]);
  assert.equal(readRepoData(root, "general-todo").entries[1].status, "done");

  out.length = 0;
  assert.equal(main(["complete", "--file", "general", "--match", "已对齐条目"], deps), 1);
  assert.match(out.join("\n"), /NOTE_REQUIRED/);
  assert.equal(readRepoData(root, "general-todo").entries[2].status, "aligned");
  assert.equal(main(["complete", "--file", "general", "--match", "已对齐条目", "--note", "取消：优先级变化"], deps), 0);
  assert.deepEqual(readRepoData(root, "general-todo").entries[2].notes, ["取消：优先级变化"]);

  assert.equal(main(["complete", "--file", "general", "--match", "进行中条目"], deps), 0, "processing → done 无人工门");
  assert.equal(readRepoData(root, "general-todo").entries[3].status, "done");
});

test("main：complete --note 原样进 notes——含全角括号、换行、超长备注都不解析不吞字（L16 收口）", () => {
  const root = makeRepo({ "general-todo": undefined });
  const deps = { repoRoot: root, log: () => {}, now: () => "2026-09-12T00:00:00.000Z" };
  assert.equal(main(["add", "--file", "general", "带坑备注的条目"], deps), 0);

  const note = "feat/x：见 statusTaskText(）与（完成 括号）混排\n第二行说明——（（嵌套））超长" + "尾".repeat(400);
  assert.equal(main(["complete", "--file", "general", "--match", "带坑备注", "--note", note], deps), 0);
  const data = readRepoData(root, "general-todo");
  assert.deepEqual(data.entries[0].notes, [note], "note 逐字节保真（不吞括号、不重复前缀）");

  assert.equal(main(["add", "--file", "general", "无备注条目"], deps), 0);
  assert.equal(main(["complete", "--file", "general", "--match", "无备注条目"], deps), 0);
  assert.deepEqual(readRepoData(root, "general-todo").entries[1].notes, []);
});

test("main：reopen 三来源回 open——清 branch/claimedAt/alignedAt，注记带源状态，其余字段不动", () => {
  const root = makeRepo({
    "general-todo": {
      version: 3,
      title: "t",
      entries: [
        entry(1, "对齐中条目", "aligning", {
          branch: "feat/a",
          claimedAt: "2026-09-01T00:00:00.000Z",
          tags: ["cli"],
          dependsOn: ["other-todo#9"],
          notes: ["历史注记"],
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
        entry(2, "已对齐条目", "aligned", {
          branch: "feat/b",
          claimedAt: "2026-09-01T00:00:00.000Z",
          alignedAt: "2026-09-02T00:00:00.000Z",
        }),
        entry(3, "进行中条目", "processing", {
          branch: "feat/c",
          claimedAt: "2026-09-01T00:00:00.000Z",
          alignedAt: "2026-09-02T00:00:00.000Z",
        }),
      ],
    },
    "other-todo": { version: 3, title: "t", entries: [entry(9, "被依赖条目", "done", { completedAt: "2026-09-03T00:00:00.000Z" })] },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };

  assert.equal(main(["reopen", "--file", "general", "--match", "对齐中条目", "--note", "范围重估：先做最小形态"], deps), 0);
  assert.match(out.join("\n"), /已撤销（已写入）：general · 对齐中条目/);
  let data = readRepoData(root, "general-todo");
  assert.equal(data.entries[0].status, "open");
  assert.equal(data.entries[0].branch, null, "branch 引用清空");
  assert.equal(data.entries[0].claimedAt, null, "claimedAt 清空");
  assert.equal(data.entries[0].alignedAt, null, "alignedAt 清空");
  assert.equal(data.entries[0].createdAt, "2026-08-01T00:00:00.000Z", "createdAt 保留");
  assert.equal(data.entries[0].completedAt, null);
  assert.deepEqual(data.entries[0].tags, ["cli"], "tags 保留");
  assert.deepEqual(data.entries[0].dependsOn, ["other-todo#9"], "dependsOn 保留（撤销不动依赖语义）");
  assert.deepEqual(
    data.entries[0].notes,
    ["历史注记", "撤销 2026-09-14：从 aligning 回到未领取；范围重估：先做最小形态"],
    "历史注记保留 + 新注记一条（日期取 now() 的 UTC 日期、原因逐字接在 ； 后）",
  );

  out.length = 0;
  assert.equal(main(["reopen", "--file", "general", "--match", "已对齐条目", "--note", "人工推翻对齐"], deps), 0);
  data = readRepoData(root, "general-todo");
  assert.equal(data.entries[1].status, "open");
  assert.equal(data.entries[1].alignedAt, null);
  assert.deepEqual(data.entries[1].notes, ["撤销 2026-09-14：从 aligned 回到未领取；人工推翻对齐"]);

  out.length = 0;
  assert.equal(main(["reopen", "--file", "general", "--match", "进行中条目"], deps), 0, "processing 无 --note 可撤销");
  data = readRepoData(root, "general-todo");
  assert.equal(data.entries[2].status, "open");
  assert.deepEqual(data.entries[2].notes, ["撤销 2026-09-14：从 processing 回到未领取"], "无 --note 时注记只有前缀；源状态取 status 字段原值");
});

test("main：reopen 门与幂等——done 拒绝、note 门、0/多匹配 fail-closed、已是 open 字节不变", () => {
  const root = makeRepo({
    "general-todo": {
      version: 3,
      title: "t",
      entries: [
        entry(1, "未领取条目", "open"),
        entry(2, "完成条目", "done", { completedAt: "2026-09-03T00:00:00.000Z" }),
        entry(3, "对齐中条目", "aligning", { branch: "feat/a", claimedAt: "2026-09-01T00:00:00.000Z" }),
        entry(4, "已对齐条目", "aligned", { branch: "feat/b", alignedAt: "2026-09-02T00:00:00.000Z" }),
        entry(5, "含子串条目", "processing"),
        entry(6, "含子串条目二", "processing"),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };
  const file = path.join(root, "todos", "general-todo.json");
  const snapshot = JSON.stringify(readRepoData(root, "general-todo"));

  assert.equal(main(["reopen", "--file", "general", "--match", "未领取条目"], deps), 0, "已是 open 幂等通过");
  assert.match(out.join("\n"), /已撤销（状态未变）/);
  assert.equal(JSON.stringify(readRepoData(root, "general-todo")), snapshot, "幂等不写盘");

  out.length = 0;
  assert.equal(main(["reopen", "--file", "general", "--match", "完成条目", "--note", "想撤销"], deps), 1);
  assert.match(out.join("\n"), /ALREADY_DONE：条目已完成，撤销已完成条目请另条登记/);
  assert.equal(readRepoData(root, "general-todo").entries[1].status, "done", "done 拒绝且不写盘");

  for (const match of ["对齐中条目", "已对齐条目"]) {
    out.length = 0;
    assert.equal(main(["reopen", "--file", "general", "--match", match], deps), 1, `${match} 无 --note 被拒`);
    assert.match(out.join("\n"), /NOTE_REQUIRED：从对齐阶段撤销必须带 --note 说明原因/);
  }
  assert.equal(JSON.stringify(readRepoData(root, "general-todo")), snapshot, "note 门失败不写盘");

  out.length = 0;
  assert.equal(main(["reopen", "--file", "general", "--match", "没有这个条目"], deps), 1);
  assert.match(out.join("\n"), /NOT_FOUND：没有匹配条目/);
  out.length = 0;
  assert.equal(main(["reopen", "--file", "general", "--match", "含子串条目"], deps), 1);
  assert.match(out.join("\n"), /AMBIGUOUS：匹配到多条，请缩小范围/);
  assert.equal(JSON.stringify(readRepoData(root, "general-todo")), snapshot, "匹配失败不写盘");
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"), "文件仍是规范 JSON 形态（未被半写）");
});

test("main：reopen 归档对齐文档——规范路径腾空、重领必重写；无文档跳过；归档失败不写盘", () => {
  const root = makeRepo({
    "general-todo": {
      version: 3,
      title: "t",
      entries: [
        entry(1, "有文档条目", "aligned", { branch: "feat/a", alignedAt: "2026-09-02T00:00:00.000Z" }),
        entry(2, "无文档条目", "processing"),
        entry(3, "归档冲突条目", "aligning", { branch: "feat/c" }),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };
  const alignDir = path.join(root, "todos", "align");

  writeAlignDoc(root, "general-todo", 1);
  assert.equal(main(["reopen", "--file", "general", "--match", "有文档条目", "--note", "重估"], deps), 0);
  assert.equal(fs.existsSync(path.join(alignDir, "general-todo#1.md")), false, "规范路径腾空");
  const archived = path.join(alignDir, "general-todo#1.reopened-20260914T000000Z.md");
  assert.equal(fs.existsSync(archived), true, "归档为 .reopened-<UTC 紧凑时间戳>.md");
  assert.match(fs.readFileSync(archived, "utf8"), /general-todo#1/, "归档文件内容原样保留");
  assert.match(out.join("\n"), /对齐文档已归档：todos\/align\/general-todo#1\.reopened-20260914T000000Z\.md/);

  // 归档的意义：旧文档不能再零人工二次过门。
  assert.equal(main(["claim", "--file", "general", "--match", "有文档条目", "--branch", "feat/a2"], deps), 0);
  out.length = 0;
  assert.equal(main(["align", "--file", "general", "--match", "有文档条目"], deps), 1);
  assert.match(out.join("\n"), /ALIGN_DOC_MISSING：缺少对齐文档 todos\/align\/general-todo#1\.md/);

  out.length = 0;
  assert.equal(main(["reopen", "--file", "general", "--match", "无文档条目", "--note", "从未开工"], deps), 0, "无对齐文档跳过归档");
  assert.doesNotMatch(out.join("\n"), /对齐文档已归档/);
  assert.equal(readRepoData(root, "general-todo").entries[1].status, "open");

  writeAlignDoc(root, "general-todo", 3);
  fs.mkdirSync(path.join(alignDir, "general-todo#3.reopened-20260914T000000Z.md"), { recursive: true });
  const snapshot = JSON.stringify(readRepoData(root, "general-todo"));
  out.length = 0;
  assert.equal(main(["reopen", "--file", "general", "--match", "归档冲突条目", "--note", "重估"], deps), 1);
  assert.match(out.join("\n"), /ALIGN_ARCHIVE_FAILED：归档目标已存在 todos\/align\/general-todo#3\.reopened-20260914T000000Z\.md/);
  assert.equal(JSON.stringify(readRepoData(root, "general-todo")), snapshot, "归档失败整体中止、JSON 零改动");
  assert.equal(fs.existsSync(path.join(alignDir, "general-todo#3.md")), true, "原文档未被改名");
});

test("main：add --tag 原生标签字段 + list --tag 精确过滤", () => {
  const root = makeRepo({ "general-todo": undefined });
  const deps = { repoRoot: root, log: () => {}, now: () => "2026-09-12T00:00:00.000Z" };
  assert.equal(main(["add", "--file", "general", "标签条目", "--tag", "性能, 存储 ,性能"], deps), 0);
  assert.deepEqual(readRepoData(root, "general-todo").entries[0].tags, ["性能", "存储"], "去空格去重保序");

  const out = [];
  assert.equal(main(["list", "--tag", "性能"], { ...deps, log: (l) => out.push(l) }), 0);
  assert.deepEqual(out, ["[ ] general-todo#1  标签条目"]);
});

test("main：list 五态标记与过滤；--status/--branch/--text/--claimed-since 组合", () => {
  const root = makeRepo({
    "general-todo": {
      version: 2,
      title: "通用 TODO",
      entries: [
        entry(1, "未领取", "open"),
        entry(2, "对齐中", "aligning", { branch: "feat/a", claimedAt: "2026-09-12T00:00:00.000Z" }),
        entry(3, "已对齐", "aligned", { branch: "feat/a", claimedAt: "2026-09-12T00:00:00.000Z", alignedAt: "2026-09-12T01:00:00.000Z" }),
        entry(4, "进行中", "processing", { branch: "feat/a", claimedAt: "2026-09-12T00:00:00.000Z", alignedAt: "2026-09-12T01:00:00.000Z" }),
        entry(5, "已完成", "done", { notes: ["收尾"], claimedAt: "2026-09-11T00:00:00.000Z", completedAt: "2026-09-11T00:00:00.000Z" }),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l) };

  assert.equal(main(["list"], deps), 0);
  assert.deepEqual(out, [
    "[ ] general-todo#1  未领取",
    "[?] general-todo#2  对齐中",
    "[>] general-todo#3  已对齐",
    "[~] general-todo#4  进行中",
    "[x] general-todo#5  已完成",
  ]);

  out.length = 0;
  assert.equal(main(["list", "--status", "aligning"], deps), 0);
  assert.deepEqual(out, ["[?] general-todo#2  对齐中"]);

  out.length = 0;
  assert.equal(main(["list", "--status", "aligned"], deps), 0);
  assert.deepEqual(out, ["[>] general-todo#3  已对齐"]);

  out.length = 0;
  assert.equal(main(["list", "--status", "done"], deps), 0);
  assert.deepEqual(out, ["[x] general-todo#5  已完成"]);

  out.length = 0;
  assert.equal(main(["list", "--branch", "feat/a", "--status", "aligned", "--json"], deps), 0);
  const rows = JSON.parse(out.join("\n"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 3);
  assert.equal(rows[0].alignedAt, "2026-09-12T01:00:00.000Z", "list --json 带 alignedAt");
  assert.equal(rows[0].claimedAt, "2026-09-12T00:00:00.000Z");

  out.length = 0;
  assert.equal(main(["list", "--claimed-since", "2026-09-12"], deps), 0, "时间维度是一等公民（无降级）");
  assert.deepEqual(out, ["[?] general-todo#2  对齐中", "[>] general-todo#3  已对齐", "[~] general-todo#4  进行中"]);

  out.length = 0;
  assert.equal(main(["list", "--text", "注记内容不存在"], deps), 0);
  assert.deepEqual(out, [], "--match/--text 只匹配纯描述 text，不进 notes");
});

test("main：list --file 短名/全名/.json/.md 四写法一致；不存在仍 exit 1", () => {
  const entry = (id, text, status, extra = {}) => ({
    id,
    text,
    status,
    branch: null,
    tags: [],
    notes: [],
    createdAt: null,
    claimedAt: null,
    completedAt: null,
    ...extra,
  });
  const root = makeRepo({
    "general-todo": {
      version: 1,
      title: "通用 TODO",
      entries: [entry(1, "未领取", "open"), entry(2, "进行中", "processing", { branch: "feat/a" }), entry(3, "已完成", "done")],
    },
    "other-todo": { version: 1, title: "其它", entries: [entry(1, "别的文件条目", "open")] },
  });
  const run = (args) => {
    const lines = [];
    const code = main(args, { repoRoot: root, log: (l) => lines.push(l) });
    return { code, lines };
  };

  const full = run(["list", "--file", "general-todo"]);
  assert.equal(full.code, 0);
  assert.deepEqual(full.lines, ["[ ] general-todo#1  未领取", "[~] general-todo#2  进行中", "[x] general-todo#3  已完成"]);
  assert.ok(full.lines.every((line) => line.includes("general-todo#")), "不得混入其它文件条目");

  for (const name of ["general", "general-todo", "general-todo.json", "general-todo.md"]) {
    assert.deepEqual(run(["list", "--file", name]).lines, full.lines, `--file ${name} 应与全名输出逐字节一致`);
  }

  assert.deepEqual(run(["list", "--file", "general", "--status", "open"]).lines, ["[ ] general-todo#1  未领取"], "短名与其它 flag AND 组合");
  const json = run(["list", "--file", "general", "--json"]);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.lines.join("\n")).length, full.lines.length);

  const missing = run(["list", "--file", "nosuch"]);
  assert.equal(missing.code, 1, "不存在的文件明确报错，不倒向空结果");
  assert.match(missing.lines.join("\n"), /找不到 todo 文件：nosuch/);
});

test("main：损坏 JSON fail-closed——summary/list/add 都明确报错退出 1，绝不静默修复", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-corrupt-"));
  fs.mkdirSync(path.join(root, "todos"));
  fs.writeFileSync(path.join(root, "todos", "bad-todo.json"), "<<<<<<< HEAD\n{}\n>>>>>>> other\n");
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  const out = [];
  for (const args of [["summary"], ["list"], ["add", "--file", "bad", "x"]]) {
    out.length = 0;
    assert.equal(main(args, { repoRoot: root, log: (l) => out.push(l) }), 1, `${args.join(" ")} 应 exit 1`);
    assert.match(out.join("\n"), /不是合法 JSON.*合并冲突/s);
  }
  assert.equal(fs.readFileSync(path.join(root, "todos", "bad-todo.json"), "utf8").includes("<<<<<<<"), true, "不写入不修复");
});

test("summary：按文件五态计数（.json 文件名）", () => {
  const root = makeRepo({
    "a-todo": {
      version: 2,
      title: "a",
      entries: [entry(1, "甲", "open"), entry(2, "乙", "done")],
    },
    "b-todo": {
      version: 2,
      title: "b",
      entries: [entry(1, "丙", "aligning"), entry(2, "丁", "aligned"), entry(3, "戊", "processing")],
    },
  });
  const out = [];
  assert.equal(main(["summary"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /a-todo\s+open 1  aligning 0  aligned 0  processing 0  done 1  total 2/);
  assert.match(out.join("\n"), /b-todo\s+open 0  aligning 1  aligned 1  processing 1  done 0  total 3/);

  const json = [];
  assert.equal(main(["summary", "--json"], { repoRoot: root, log: (l) => json.push(l) }), 0);
  const rows = JSON.parse(json.join("\n"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: "a-todo", open: 1, aligning: 0, aligned: 0, processing: 0, done: 1, total: 2 });
  assert.deepEqual(rows[1], { name: "b-todo", open: 0, aligning: 1, aligned: 1, processing: 1, done: 0, total: 3 });
});

test("lint：注册扩展 ↔ todos/<名>-todo.json 一一对应（一个方向）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-lint-"));
  fs.mkdirSync(path.join(root, "todos"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./myext/index.ts"] } }));
  const out = [];
  assert.equal(main(["lint"], { repoRoot: root, log: (l) => out.push(l) }), 1);
  assert.match(out.join("\n"), /✗ 扩展 myext 缺少 todos\/myext-todo\.json/);
  fs.writeFileSync(path.join(root, "todos", "myext-todo.json"), serializeTodo(emptyTodoData("myext-todo")));
  out.length = 0;
  assert.equal(main(["lint"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /lint 通过/);
});

// ---------------------------------------------------------------------------
// 依赖门（todo-cli-todo:10）：声明入口 —— 写入期校验 + 引用归一
// ---------------------------------------------------------------------------

test("main：add --dep 写入归一后的规范引用；非法/悬空引用拒绝且不写盘", () => {
  const root = makeRepo({
    "general-todo": { version: 3, title: "t", entries: [entry(1, "已有前提", "open")] },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };

  assert.equal(main(["add", "--file", "general", "依赖已有前提", "--dep", "general#1"], deps), 0);
  assert.deepEqual(readRepoData(root, "general-todo").entries[1].dependsOn, ["general-todo#1"], "短名归一为规范引用");
  assert.match(out.join("\n"), /依赖 general-todo#1/);

  out.length = 0;
  assert.equal(main(["add", "--file", "general", "悬空依赖", "--dep", "general-todo#99"], deps), 1);
  assert.match(out.join("\n"), /DEP_NOT_FOUND：依赖目标不存在 general-todo#99/);
  assert.equal(main(["add", "--file", "general", "非法引用", "--dep", "general"], deps), 1);
  assert.match(out.join("\n"), /DEP_REF_INVALID：--dep 需要 文件#id 引用/);
  assert.equal(readRepoData(root, "general-todo").entries.length, 2, "拒绝时不写入");
});

test("main：dep add / dep remove —— 追加去重、幂等、缺引用与校验失败都不写盘", () => {
  const root = makeRepo({
    "general-todo": {
      version: 3,
      title: "t",
      entries: [
        entry(1, "已完成前提", "done", { completedAt: "2026-09-10T00:00:00.000Z" }),
        entry(2, "依赖方", "aligned", { dependsOn: ["general-todo#1"], alignedAt: "2026-09-13T00:00:00.000Z" }),
        entry(3, "另一条", "open"),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };

  assert.equal(main(["dep", "add", "--file", "general", "--match", "依赖方", "--on", "general-todo#3, general#1"], deps), 0);
  assert.deepEqual(readRepoData(root, "general-todo").entries[1].dependsOn, ["general-todo#1", "general-todo#3"], "去重并保序追加");
  assert.match(out.join("\n"), /已更新依赖（已写入）/);

  out.length = 0;
  assert.equal(main(["dep", "add", "--file", "general", "--match", "依赖方", "--on", "general-todo#3"], deps), 0);
  assert.match(out.join("\n"), /状态未变/, "重复声明是幂等 no-op");

  out.length = 0;
  assert.equal(main(["dep", "add", "--file", "general", "--match", "依赖方", "--on", "general-todo#99"], deps), 1);
  assert.match(out.join("\n"), /DEP_NOT_FOUND：依赖目标不存在 general-todo#99/);
  assert.equal(main(["dep", "add", "--file", "general", "--match", "依赖方", "--on", "general#2"], deps), 1);
  assert.match(out.join("\n"), /DEP_SELF：条目不能依赖自身 general-todo#2/);
  assert.deepEqual(readRepoData(root, "general-todo").entries[1].dependsOn, ["general-todo#1", "general-todo#3"], "校验失败不写盘");

  assert.equal(main(["dep", "remove", "--file", "general", "--match", "依赖方", "--on", "general-todo#1"], deps), 0);
  assert.deepEqual(readRepoData(root, "general-todo").entries[1].dependsOn, ["general-todo#3"]);
  assert.equal(main(["dep", "remove", "--file", "general", "--match", "依赖方", "--on", "general-todo#1"], deps), 1);
  assert.match(out.join("\n"), /DEP_ABSENT：该条目未声明依赖 general-todo#1/);

  out.length = 0;
  assert.equal(main(["dep", "remove", "--file", "general", "--match", "依赖方"], deps), 1);
  assert.match(out.join("\n"), /缺少 --on/);
  assert.equal(main(["dep", "frobnicate", "--file", "general", "--match", "依赖方", "--on", "general-todo#1"], deps), 1);
  assert.match(out.join("\n"), /未知 dep 子命令/);
});

test("main：dep add 拒绝成环（回显环路径）且不写盘", () => {
  const root = makeRepo({
    "general-todo": {
      version: 3,
      title: "t",
      entries: [
        entry(1, "环甲", "aligned", { dependsOn: ["general-todo#2"] }),
        entry(2, "环乙", "open"),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l) };
  assert.equal(main(["dep", "add", "--file", "general", "--match", "环乙", "--on", "general#1"], deps), 1);
  assert.match(out.join("\n"), /DEP_CYCLE：依赖成环 general-todo#2 → general-todo#1 → general-todo#2/);
  assert.deepEqual(readRepoData(root, "general-todo").entries[1].dependsOn, [], "成环不写盘");
});

test("main：claim 依赖门——被阻塞 fail-closed 不写盘，前提完成后可开工；首次领取与 align 不受阻", () => {
  const root = makeRepo({
    "general-todo": {
      version: 3,
      title: "t",
      entries: [
        entry(1, "前提条目", "open"),
        entry(2, "被阻塞条目", "aligned", {
          branch: "feat/b",
          claimedAt: "2026-09-13T00:00:00.000Z",
          alignedAt: "2026-09-13T01:00:00.000Z",
          dependsOn: ["general-todo#1"],
        }),
        entry(3, "待对齐的阻塞条目", "open", { dependsOn: ["general-todo#1"] }),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };

  assert.equal(main(["claim", "--file", "general", "--match", "被阻塞条目"], deps), 1);
  assert.match(out.join("\n"), /DEP_BLOCKED：依赖未完成，不能开工/);
  assert.match(out.join("\n"), /general-todo#1（open）/);
  assert.equal(readRepoData(root, "general-todo").entries[1].status, "aligned", "门没过不写盘");

  out.length = 0;
  assert.equal(main(["claim", "--file", "general", "--match", "待对齐的阻塞条目"], deps), 0, "被阻塞条目仍可先对齐");
  assert.equal(readRepoData(root, "general-todo").entries[2].status, "aligning");
  writeAlignDoc(root, "general-todo", 3);
  assert.equal(main(["align", "--file", "general", "--match", "待对齐的阻塞条目"], deps), 0);
  assert.equal(readRepoData(root, "general-todo").entries[2].status, "aligned");

  out.length = 0;
  assert.equal(main(["complete", "--file", "general", "--match", "前提条目"], deps), 0);
  assert.match(out.join("\n"), /提示：以下未完成条目依赖本条目：general-todo#2（aligned）、general-todo#3（aligned）/, "收口时反查直接依赖者");
  assert.equal(main(["complete", "--file", "general", "--match", "被阻塞条目", "--note", "收口"], deps), 0);
  assert.equal(main(["claim", "--file", "general", "--match", "被阻塞条目"], deps), 1, "已完成条目不可领取");
});

test("main：依赖未完成时的开工门与解锁（done 即解锁，含悬空引用算阻塞）", () => {
  const root = makeRepo({
    "general-todo": {
      version: 3,
      title: "t",
      entries: [
        entry(1, "悬空前提", "aligned", { dependsOn: ["general-todo#99"], alignedAt: "2026-09-13T01:00:00.000Z" }),
        entry(2, "正常前提", "done", { completedAt: "2026-09-13T00:00:00.000Z" }),
        entry(3, "已可开工", "aligned", { dependsOn: ["general-todo#2"], alignedAt: "2026-09-13T01:00:00.000Z" }),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };

  assert.equal(main(["claim", "--file", "general", "--match", "悬空前提"], deps), 1);
  assert.match(out.join("\n"), /DEP_BLOCKED/);
  assert.match(out.join("\n"), /general-todo#99（不存在）/, "悬空依赖也算阻塞并标不存在");

  out.length = 0;
  assert.equal(main(["claim", "--file", "general", "--match", "已可开工"], deps), 0);
  assert.equal(readRepoData(root, "general-todo").entries[2].status, "processing", "依赖 done 即解锁");
  assert.match(out.join("\n"), /进入 processing/);
});

test("main：list 阻塞标记（非阻塞行字节不变）+ --json 带 dependsOn/blockedBy；summary 不变", () => {
  const root = makeRepo({
    "general-todo": {
      version: 3,
      title: "t",
      entries: [
        entry(1, "前提", "processing", { branch: "feat/a" }),
        entry(2, "被阻塞", "aligned", { dependsOn: ["general-todo#1"], alignedAt: "2026-09-13T00:00:00.000Z" }),
        entry(3, "无依赖", "open"),
        entry(4, "依赖已完成", "open", { dependsOn: ["general-todo#5"] }),
        entry(5, "已完成前提", "done", { completedAt: "2026-09-10T00:00:00.000Z" }),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l) };

  assert.equal(main(["list"], deps), 0);
  assert.deepEqual(out, [
    "[~] general-todo#1  前提",
    "[>] general-todo#2  被阻塞 （阻塞：等待 general-todo#1）",
    "[ ] general-todo#3  无依赖",
    "[ ] general-todo#4  依赖已完成",
    "[x] general-todo#5  已完成前提",
  ]);

  out.length = 0;
  assert.equal(main(["list", "--json"], deps), 0);
  const rows = JSON.parse(out.join("\n"));
  assert.deepEqual(rows[1].dependsOn, ["general-todo#1"]);
  assert.deepEqual(rows[1].blockedBy, ["general-todo#1"], "非空即阻塞（派生字段只有一个）");
  assert.deepEqual(rows[0].blockedBy, []);
  assert.deepEqual(rows[3].dependsOn, ["general-todo#5"], "依赖已完成 → 不算阻塞");
  assert.deepEqual(rows[3].blockedBy, []);

  out.length = 0;
  assert.equal(main(["summary"], deps), 0);
  assert.match(out.join("\n"), /^general-todo\s+open 2  aligning 0  aligned 1  processing 1  done 1  total 5$/, "summary 不含阻塞信息");
});

test("main：complete 提示直接依赖者（已完成的依赖者不进提示）", () => {
  const root = makeRepo({
    "general-todo": {
      version: 3,
      title: "t",
      entries: [
        entry(1, "被依赖的前提", "processing", { branch: "feat/a" }),
        entry(2, "依赖方甲", "open", { dependsOn: ["general-todo#1"] }),
        entry(3, "依赖方乙", "done", { dependsOn: ["general-todo#1"], completedAt: "2026-09-12T00:00:00.000Z" }),
      ],
    },
  });
  const out = [];
  const deps = { repoRoot: root, log: (l) => out.push(l), now: () => "2026-09-14T00:00:00.000Z" };

  assert.equal(main(["complete", "--file", "general", "--match", "被依赖的前提"], deps), 0);
  assert.match(out.join("\n"), /提示：以下未完成条目依赖本条目：general-todo#2（open）/);
  assert.equal(out.join("\n").includes("依赖方乙"), false);
});

test("lint：扩展核对之外扫描依赖悬空/自引用/环", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-lint-dep-"));
  fs.mkdirSync(path.join(root, "todos"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./myext/index.ts"] } }));
  const file = path.join(root, "todos", "myext-todo.json");
  fs.writeFileSync(
    file,
    serializeTodo({
      version: 3,
      title: "myext TODO",
      entries: [
        entry(1, "悬空", "open", { dependsOn: ["myext-todo#9"] }),
        entry(2, "自引用", "open", { dependsOn: ["myext-todo#2"] }),
        entry(3, "环甲", "open", { dependsOn: ["myext-todo#4"] }),
        entry(4, "环乙", "open", { dependsOn: ["myext-todo#3"] }),
        entry(5, "干净", "open", { dependsOn: ["myext-todo#1"] }),
      ],
    }),
  );
  const out = [];
  assert.equal(main(["lint"], { repoRoot: root, log: (l) => out.push(l) }), 1);
  const text = out.join("\n");
  assert.match(text, /✗ myext-todo#1 依赖目标不存在：myext-todo#9/);
  assert.match(text, /✗ myext-todo#2 自引用依赖：myext-todo#2/);
  assert.match(text, /✗ myext-todo#3 依赖成环：myext-todo#3 → myext-todo#4 → myext-todo#3/);
  assert.equal(text.includes("myext-todo#5"), false, "干净条目不进问题清单");

  fs.writeFileSync(file, serializeTodo({ version: 3, title: "clean", entries: [entry(1, "干净", "open")] }));
  out.length = 0;
  assert.equal(main(["lint"], { repoRoot: root, log: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /lint 通过/);
});

// ---------------------------------------------------------------------------
// triage：git worktree 事实 × todos 条目（branch 原生字段精确相等，只读）
// ---------------------------------------------------------------------------

const PORCELAIN = [
  "worktree C:/repo",
  "HEAD aaaa1111",
  "branch refs/heads/dev-laptop",
  "",
  "worktree C:/repo/.worktrees/live",
  "HEAD bbbb2222",
  "branch refs/heads/feat/live-thing",
  "",
  "worktree C:/repo/.worktrees/merged",
  "HEAD cccc3333",
  "branch refs/heads/feat/merged-thing",
  "",
  "worktree C:/repo/.worktrees/dirty",
  "HEAD dddd4444",
  "branch refs/heads/feat/dirty-thing",
  "",
  "worktree C:/repo/.worktrees/no-todo",
  "HEAD eeee5555",
  "branch refs/heads/feat/no-todo",
  "",
  "worktree C:/repo/.worktrees/gone",
  "HEAD ffff6666",
  "detached",
  "",
].join("\n");

const TRIAGE_DOCS = [
  {
    name: "a-todo",
    data: {
      version: 3,
      title: "a",
      entries: [
        entry(1, "在做的需求", "processing", { branch: "feat/live-thing" }),
        entry(2, "已完成", "done", { completedAt: "2026-09-11T00:00:00.000Z" }),
        entry(3, "无分支引用的进行中", "processing"),
        entry(4, "引用已消失的", "processing", { branch: "feat/vanished" }),
        entry(5, "对齐中有工作台", "aligning", { branch: "feat/live-thing" }),
        entry(6, "对齐中引用消失", "aligning", { branch: "feat/vanished" }),
        entry(7, "对齐中无引用", "aligning"),
        entry(8, "已对齐有工作台", "aligned", { branch: "feat/live-thing", alignedAt: "2026-09-12T00:00:00.000Z" }),
        entry(9, "已对齐无引用", "aligned", { alignedAt: "2026-09-12T00:00:00.000Z" }),
      ],
    },
  },
];

test("parseWorktrees / parseMergedBranches：porcelain 与 merged 解析不变", () => {
  const wts = parseWorktrees(PORCELAIN);
  assert.equal(wts.length, 6);
  assert.deepEqual(wts[1], {
    path: "C:/repo/.worktrees/live",
    head: "bbbb2222",
    branch: "feat/live-thing",
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  });
  assert.equal(wts[5].detached, true);
  assert.equal(wts[5].branch, null);
  assert.equal(parseWorktrees("").length, 0);
  assert.deepEqual(parseMergedBranches("* dev-laptop\n+ feat/old\n  feat/new\n  remotes/origin/dev-laptop\n\n"), [
    "dev-laptop",
    "feat/old",
    "feat/new",
  ]);
});

test("triageRepo：worktree 状态判定 + 五态中三个在途态分类（branch 精确相等）+ 孤儿目录透传", () => {
  const report = triageRepo({
    worktrees: parseWorktrees(PORCELAIN),
    mergedBranches: ["dev-laptop", "feat/merged-thing", "feat/dirty-thing"],
    docs: TRIAGE_DOCS,
    exists: (p) => !p.endsWith(".worktrees/gone"),
    dirty: (p) => (p.endsWith(".worktrees/dirty") ? 2 : 0),
    orphanDirs: [".worktrees/orphan"],
  });

  assert.equal(report.main.branch, "dev-laptop");
  assert.deepEqual(
    report.worktrees.map((w) => [w.branch, w.state]),
    [
      ["feat/live-thing", "active"],
      ["feat/merged-thing", "cleanup"],
      ["feat/dirty-thing", "merged-dirty"],
      ["feat/no-todo", "orphan"],
      [null, "missing"],
    ],
  );
  assert.deepEqual(report.worktrees[0].entries.map((e) => [e.name, e.id]), [
    ["a-todo", 1],
    ["a-todo", 5],
    ["a-todo", 8],
  ]);

  assert.equal(report.processing.total, 3);
  assert.deepEqual(report.processing.active.map((p) => p.ref), ["feat/live-thing"]);
  assert.deepEqual(report.processing.stale.map((p) => [p.id, p.ref]), [[4, "feat/vanished"]]);
  assert.deepEqual(report.processing.noRef.map((p) => p.id), [3]);

  assert.equal(report.aligning.total, 3);
  assert.deepEqual(report.aligning.active.map((p) => [p.id, p.ref]), [[5, "feat/live-thing"]]);
  assert.deepEqual(report.aligning.stale.map((p) => [p.id, p.ref]), [[6, "feat/vanished"]]);
  assert.deepEqual(report.aligning.noRef.map((p) => p.id), [7]);

  assert.equal(report.aligned.total, 2);
  assert.deepEqual(report.aligned.active.map((p) => p.id), [8]);
  assert.deepEqual(report.aligned.stale, []);
  assert.deepEqual(report.aligned.noRef.map((p) => p.id), [9]);
  assert.deepEqual(report.orphanDirs, [".worktrees/orphan"]);
});

test("main triage：fake git 事实驱动只读报告，只读不写、--json 可解析", () => {
  const root = makeRepo({ "a-todo": TRIAGE_DOCS[0].data });
  fs.mkdirSync(path.join(root, ".worktrees", "live"), { recursive: true });
  const porcelain = [
    `worktree ${root}`,
    "HEAD aaaa1111",
    "branch refs/heads/dev-laptop",
    "",
    `worktree ${path.join(root, ".worktrees", "live")}`,
    "HEAD bbbb2222",
    "branch refs/heads/feat/live-thing",
    "",
  ].join("\n");
  const calls = [];
  const execGit = (args) => {
    calls.push(args[0]);
    if (args[0] === "worktree") return porcelain;
    if (args[0] === "branch") return "* dev-laptop\n";
    if (args[0] === "status") return "";
    throw new Error(`unexpected git: ${args.join(" ")}`);
  };
  const out = [];
  assert.equal(main(["triage", "--json"], { repoRoot: root, execGit, log: (l) => out.push(l) }), 0);
  const report = JSON.parse(out.join("\n"));
  assert.deepEqual(report.worktrees.map((w) => [w.branch, w.state]), [["feat/live-thing", "active"]]);
  assert.equal(report.processing.active[0].ref, "feat/live-thing");
  assert.deepEqual(readRepoData(root, "a-todo"), TRIAGE_DOCS[0].data, "triage 不得写 todos/");
  assert.ok(calls.includes("worktree") && calls.includes("branch"));

  const text = [];
  assert.equal(main(["triage"], { repoRoot: root, execGit, log: (l) => text.push(l) }), 0);
  assert.match(text.join("\n"), /feat\/live-thing/);
  assert.match(text.join("\n"), /active/);
  assert.match(text.join("\n"), /aligning 条目：3（有工作台 1 · 引用分支已消失 1 · 无分支引用 1）/);
  assert.match(text.join("\n"), /aligned 条目：2（有工作台 1 · 引用分支已消失 0 · 无分支引用 1）/);
  assert.match(text.join("\n"), /processing 条目：3（有工作台 1 · 引用分支已消失 1 · 无分支引用 1）/);
});

// ---------------------------------------------------------------------------
// 进程边界 E2E：真实子进程 + 仓库/非仓库 cwd 跑 CLI 入口（只读，不写真实 todos/）
// ---------------------------------------------------------------------------

test("CLI E2E：仓库子目录 cwd 跑 summary（git 自动发现到仓库根）退出 0、stderr 恒空", () => {
  const res = runCli(["summary"], path.join(REPO_ROOT, ".agents"));
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  assert.ok(res.stdout.trim().length > 0, "summary 输出非空");
  assert.match(res.stdout, /-todo/);
});

test("CLI E2E：--help 在非仓库 cwd 也退出 0 且含完整用法（migrate 替代 db，reopen 是第十子命令）", () => {
  const res = runCli(["--help"], os.tmpdir());
  assert.equal(res.status, 0);
  assert.match(res.stdout, /用法/);
  for (const sub of ["summary", "list", "add", "claim", "align", "complete", "reopen", "lint", "triage", "migrate", "dep"]) {
    assert.ok(res.stdout.includes(sub), `用法含子命令 ${sub}`);
  }
  assert.match(res.stdout, /--status open\|aligning\|aligned\|processing\|done/);
  assert.equal(res.stdout.includes("db "), false, "db 子命令已删除");
  assert.match(res.stdout, /--root/, "用法说明含 --root");
  assert.match(res.stdout, /--dep/, "用法说明含 --dep");
});

test("CLI E2E：align 缺 --file / 缺 --match 均提示 + exit 1、stderr 恒空", () => {
  const noFile = runCli(["align", "--match", "随便"], os.tmpdir());
  assert.equal(noFile.status, 1);
  assert.match(noFile.stdout, /缺少 --file <name>/);
  assert.equal(noFile.stderr, "");

  const noMatch = runCli(["align", "--file", "general"], os.tmpdir());
  assert.equal(noMatch.status, 1);
  assert.match(noMatch.stdout, /缺少 --match "子串"/);
  assert.equal(noMatch.stderr, "");
});

test("CLI E2E：reopen 缺 --file / 缺 --match 均提示 + exit 1、stderr 恒空", () => {
  const noFile = runCli(["reopen", "--match", "随便"], os.tmpdir());
  assert.equal(noFile.status, 1);
  assert.match(noFile.stdout, /缺少 --file <name>/);
  assert.equal(noFile.stderr, "");

  const noMatch = runCli(["reopen", "--file", "general"], os.tmpdir());
  assert.equal(noMatch.status, 1);
  assert.match(noMatch.stdout, /缺少 --match "子串"/);
  assert.equal(noMatch.stderr, "");
});

test("CLI E2E：真实仓库 list --file 短名与全名输出一致且非空（#12 回归锁）", () => {
  const short = runCli(["list", "--file", "general"], REPO_ROOT);
  const full = runCli(["list", "--file", "general-todo"], REPO_ROOT);
  assert.equal(short.status, 0);
  assert.equal(full.status, 0);
  assert.ok(short.stdout.trim().length > 0, "短名不得静默返回空结果");
  assert.equal(short.stdout, full.stdout);
});

test("CLI E2E：dep 缺 --file / --match / --on 均提示 + exit 1、stderr 恒空", () => {
  const noFile = runCli(["dep", "add", "--match", "随便", "--on", "a#1"], os.tmpdir());
  assert.equal(noFile.status, 1);
  assert.match(noFile.stdout, /缺少 --file <name>/);
  assert.equal(noFile.stderr, "");

  const noMatch = runCli(["dep", "remove", "--file", "general", "--on", "a#1"], os.tmpdir());
  assert.equal(noMatch.status, 1);
  assert.match(noMatch.stdout, /缺少 --match "子串"/);
  assert.equal(noMatch.stderr, "");

  const noOn = runCli(["dep", "add", "--file", "general", "--match", "随便"], os.tmpdir());
  assert.equal(noOn.status, 1);
  assert.match(noOn.stdout, /缺少 --on/);
  assert.equal(noOn.stderr, "");
});

test("CLI E2E：未知命令退出 1 并提示（非仓库 cwd 也不需要仓库根）", () => {
  const res = runCli(["definitely-not-a-command"], os.tmpdir());
  assert.equal(res.status, 1);
  assert.match(res.stdout, /未知命令：definitely-not-a-command/);
  assert.match(res.stdout, /用法/);
  assert.equal(res.stderr, "");
});
