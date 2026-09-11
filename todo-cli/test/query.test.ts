/**
 * todo-cli/query.ts 纯函数单测（W2 查询引擎，10-design §6 清单 12–16）。
 *
 * 边界说明：query.ts 是真正隔离于 fs/db 之上的纯派生逻辑——本文件只喂文本构造的
 * entries，不碰文件系统、不碰 node:sqlite、不 import core/store。分支引用派生口径
 * 以 core.PROCESSING_REF_RE 为对照、状态标记以 core.STATUS_MARK 为对照（两处独立
 * 实现，W4 加对照测试锁定一致）；真实路径行为（数据库行、CLI 新 flags、降级）由
 * W3/W4 在真实临时仓库上锁定。人读行字节比对样例取自今日 `node tools/todo.mjs list`
 * 的真实输出。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyEntryFilter,
  deriveQueryEntries,
  parseBranchRef,
  parseFilterOptions,
  parseTags,
  serializeEntries,
  sortQueryEntries,
  statusMark,
} from "../query.ts";
import type { EntryStatus, QueryEntry } from "../query.ts";

/** 构造 QueryEntry 的最小工厂：测试只关心被锁字段，其余给稳定默认值。 */
function makeEntry(overrides: Partial<QueryEntry>): QueryEntry {
  return {
    file: "a-todo",
    line: 1,
    status: "open",
    text: "条目",
    branch: null,
    tags: [],
    createdAt: null,
    claimedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** 真实条目标注形态的 fixture（含 processing/done/标签三种派生来源）。 */
const SAMPLE_ENTRIES: Array<{ line: number; status: EntryStatus; text: string }> = [
  {
    line: 5,
    status: "processing",
    text: "持久化改造：markdown → 数据库（processing 2026-09-11 @ feat/todo-cli-extension，根 2.29.0）",
  },
  { line: 7, status: "open", text: "元数据化筛选查询 #todo-cli #sqlite" },
  { line: 9, status: "done", text: "旧能力（完成 2026-09-10 @ feat/old-thing）" },
];

// ---------------------------------------------------------------------------
// 清单 12：派生函数
// ---------------------------------------------------------------------------

test("parseBranchRef：真实条目文本派生 @ 分支引用（口径 = core.PROCESSING_REF_RE）", () => {
  assert.equal(
    parseBranchRef("持久化改造：markdown → 数据库（processing 2026-09-11 @ feat/todo-cli-extension，根 2.29.0）"),
    "feat/todo-cli-extension",
    "processing 标注取首个 @ 捕获组，遇全角逗号截断",
  );
  assert.equal(parseBranchRef("旧能力（完成 2026-09-10 @ feat/old-thing）"), "feat/old-thing", "done 行同样派生");
  assert.equal(parseBranchRef("（processing @   feat/spaces）"), "feat/spaces", "@ 后空白不属于引用内容");
  assert.equal(parseBranchRef("（processing）"), null);
  assert.equal(parseBranchRef("无分支引用"), null);
});

test("parseTags：#词保序去重（字母/数字/下划线/连字符与中文）", () => {
  assert.deepEqual(parseTags("元数据化筛选查询 #todo-cli #sqlite"), ["todo-cli", "sqlite"]);
  assert.deepEqual(parseTags("标签在括号里（#中文标签）"), ["中文标签"], "全角左括号是合法前缀");
  assert.deepEqual(parseTags("(ascii #tag)"), ["tag"], "ASCII 左括号是合法前缀");
  assert.deepEqual(parseTags("#a #a #b"), ["a", "b"], "重复标签只保留首个");
  assert.deepEqual(parseTags("#v2_3-x"), ["v2_3-x"], "首字符后允许下划线与连字符");
  assert.deepEqual(parseTags("#123"), ["123"], "数字可作为首字符");
  assert.deepEqual(parseTags("a#b 前面没有分隔"), [], "无行首/空白/左括号前缀不算标签");
  assert.deepEqual(parseTags("（processing 2026-09-11 @ feat/x，根 2.29.0）"), []);
});

// ---------------------------------------------------------------------------
// 清单 13：派生 + AND 组合
// ---------------------------------------------------------------------------

test("deriveQueryEntries + applyEntryFilter：派生字段完整，AND 组合交集正确", () => {
  const derived = deriveQueryEntries("todo-cli-todo", SAMPLE_ENTRIES);
  assert.equal(derived.length, 3);
  assert.deepEqual(derived[0], {
    file: "todo-cli-todo",
    line: 5,
    status: "processing",
    text: SAMPLE_ENTRIES[0].text,
    branch: "feat/todo-cli-extension",
    tags: [],
    createdAt: null,
    claimedAt: null,
    completedAt: null,
  });
  assert.deepEqual(derived[1].tags, ["todo-cli", "sqlite"]);
  assert.equal(derived[2].status, "done");
  assert.equal(derived[2].branch, "feat/old-thing", "done 行也派生 branch，供历史查询");

  const both = [...derived, ...deriveQueryEntries("general-todo", SAMPLE_ENTRIES)];
  assert.deepEqual(
    applyEntryFilter(both, { status: "processing", file: "todo-cli-todo" }).map((e) => `${e.file}:${e.line}`),
    ["todo-cli-todo:5"],
    "processing 且 file=todo-cli-todo 只命中一条（验收②锚点的纯函数层）",
  );
  assert.deepEqual(applyEntryFilter(both, { file: "general-todo" }).map((e) => e.line), [5, 7, 9]);
  assert.deepEqual(applyEntryFilter(both, { status: "bogus" as EntryStatus }), [], "非法 status 沿旧 list 语义给空结果，不报错");
  assert.equal(applyEntryFilter(derived, {}) === derived, true, "全字段 undefined 原样返回，不做无谓拷贝");
});

// ---------------------------------------------------------------------------
// 清单 14：各维度语义与边界
// ---------------------------------------------------------------------------

test("applyEntryFilter：branch 子串 / tag 精确 / text 子串 / claimedSince 边界", () => {
  const entries = [
    makeEntry({
      line: 1,
      status: "processing",
      branch: "feat/todo-cli-extension",
      tags: ["todo-cli"],
      text: "持久化改造",
      claimedAt: "2026-09-11T09:00:00.000Z",
    }),
    makeEntry({ line: 2, branch: null, tags: ["todo-cli-x"], text: "另一个需求", claimedAt: "2026-09-10T23:59:59.000Z" }),
    makeEntry({ line: 3, branch: "feat/other", tags: [], text: "无关条目", claimedAt: null }),
  ];

  assert.deepEqual(applyEntryFilter(entries, { branch: "todo-cli" }).map((e) => e.line), [1], "branch 子串命中；null 引用排除");
  assert.deepEqual(applyEntryFilter(entries, { branch: "feat" }).map((e) => e.line), [1, 3]);
  assert.deepEqual(applyEntryFilter(entries, { tag: "todo-cli" }).map((e) => e.line), [1], "tag 精确包含，todo-cli-x 不命中");
  assert.deepEqual(applyEntryFilter(entries, { text: "持久化" }).map((e) => e.line), [1]);
  assert.deepEqual(applyEntryFilter(entries, { claimedSince: "2026-09-11" }).map((e) => e.line), [1], "当日含，null 排除，前缀比较");
  assert.deepEqual(applyEntryFilter(entries, { claimedSince: "2026-09-10" }).map((e) => e.line), [1, 2]);
  assert.deepEqual(
    applyEntryFilter(entries, { tag: "todo-cli", claimedSince: "2026-09-11" }).map((e) => e.line),
    [1],
    "tag+claimedSince 多维 AND 组合",
  );
  assert.deepEqual(applyEntryFilter(entries, { status: "open", branch: "feat" }).map((e) => e.line), [3], "status+branch 组合");
});

// ---------------------------------------------------------------------------
// 清单 15：排序与序列化
// ---------------------------------------------------------------------------

test("sortQueryEntries + serializeEntries：稳定排序，人读行与今日 list 字节一致，--json 字段完整", () => {
  const shuffled = [
    makeEntry({ file: "b-todo", line: 2, text: "乙" }),
    makeEntry({ file: "a-todo", line: 9, status: "done", text: "丙" }),
    makeEntry({ file: "a-todo", line: 3, status: "processing", text: "甲" }),
  ];
  const sorted = sortQueryEntries(shuffled);
  assert.deepEqual(sorted.map((e) => `${e.file}:${e.line}`), ["a-todo:3", "a-todo:9", "b-todo:2"]);
  assert.deepEqual(
    shuffled.map((e) => `${e.file}:${e.line}`),
    ["b-todo:2", "a-todo:9", "a-todo:3"],
    "返回新数组，不改输入序",
  );

  assert.equal(statusMark("open"), "[ ]");
  assert.equal(statusMark("processing"), "[~]");
  assert.equal(statusMark("done"), "[x]");

  // 今日 `node tools/todo.mjs list` 真实输出行（字节级比对，输入故意乱序验证序列化排序）
  const real = [
    makeEntry({
      file: "agent-team-todo",
      line: 84,
      status: "processing",
      text: "真正并发跑多个 team run（processing @ team-run-run-1789116514774）",
      branch: "team-run-run-1789116514774",
    }),
    makeEntry({
      file: "agent-team-todo",
      line: 28,
      status: "done",
      text: "agent-team 的 TUI 与 pi-subagents 同步，所有细节同步到代码层级",
    }),
  ];
  assert.deepEqual(serializeEntries(real, { json: false }), [
    "[x] agent-team-todo:28  agent-team 的 TUI 与 pi-subagents 同步，所有细节同步到代码层级",
    "[~] agent-team-todo:84  真正并发跑多个 team run（processing @ team-run-run-1789116514774）",
  ]);

  const jsonOut = serializeEntries(real, { json: true });
  assert.equal(jsonOut.length, 1, "JSON 整体一行交给 log");
  const rows = JSON.parse(jsonOut[0]);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), [
    "file",
    "line",
    "status",
    "text",
    "branch",
    "tags",
    "createdAt",
    "claimedAt",
    "completedAt",
  ]);
  assert.equal(rows[0].file, "agent-team-todo");
  assert.equal(rows[0].status, "done");
  assert.equal(rows[0].claimedAt, null);
  assert.equal(rows[1].branch, "team-run-run-1789116514774");
});

// ---------------------------------------------------------------------------
// 清单 16：选项解析与校验
// ---------------------------------------------------------------------------

test("parseFilterOptions：合法透传、缺失字段不设、--claimed-since 非法日期 BAD_FILTER", () => {
  assert.deepEqual(
    parseFilterOptions({
      status: "processing",
      file: "todo-cli-todo",
      branch: "feat/x",
      tag: "sqlite",
      text: "持久化",
      "claimed-since": "2026-09-01",
      json: true,
    }),
    {
      ok: true,
      filter: {
        status: "processing",
        file: "todo-cli-todo",
        branch: "feat/x",
        tag: "sqlite",
        text: "持久化",
        claimedSince: "2026-09-01",
      },
      json: true,
    },
  );

  assert.deepEqual(parseFilterOptions({}), { ok: true, filter: {}, json: false });
  assert.deepEqual(parseFilterOptions({ status: "open", json: false }), { ok: true, filter: { status: "open" }, json: false });
  assert.deepEqual(parseFilterOptions({ status: "" }), { ok: true, filter: {}, json: false }, "空字符串沿旧 list 真值语义视作未提供");
  assert.deepEqual(
    parseFilterOptions({ "claimed-since": undefined }),
    { ok: true, filter: {}, json: false },
    "parseArgs 尾部缺值 → undefined，视作未提供（旧 flags 同语义）",
  );

  for (const bad of ["2026-9-1", "20260901", "2026-13-01", "2026-02-30", "2026-00-10", "2023-02-29", "not-a-date", ""]) {
    assert.deepEqual(
      parseFilterOptions({ "claimed-since": bad }),
      { ok: false, code: "BAD_FILTER", message: "--claimed-since 需要 YYYY-MM-DD 日期" },
      `非法日期：${bad}`,
    );
  }
  assert.deepEqual(
    parseFilterOptions({ "claimed-since": "2024-02-29" }),
    { ok: true, filter: { claimedSince: "2024-02-29" }, json: false },
    "闰日合法",
  );
});
