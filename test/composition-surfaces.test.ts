/**
 * 接触面清单校验器与配对生成器的纯函数测试（general-todo#32）。
 *
 * 边界：本文件只测 tools/composition-surfaces.mjs 的纯逻辑（解析 / 校验 / 配对），
 * 用临时仓库 fixture 提供源码，不触碰真实清单与真实扩展——真实清单的完备性由
 * tools/composition-surfaces.mjs --check 在 test:all 的 root:composition 套件里跑。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { computePairs, parseSurfaces, validateSurfaces } from "../tools/composition-surfaces.mjs";

const makeRepo = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "composition-surfaces-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
};

const ext = (name, source) => [`src/extensions/${name}/index.ts`, source];

test("parseSurfaces 解析节与字段，反引号与中文冒号都认", () => {
  const md = [
    "## 表",
    "",
    "### alpha",
    "状态键: `alpha-status`",
    "- widget： alpha-widget",
    "宿主钩子: tool_call、input",
    "events 提供: caps:alpha",
    "无注册面: -",
    "",
    "### beta",
    "无注册面: true",
  ].join("\n");
  const surfaces = parseSurfaces(md);
  assert.deepEqual([...surfaces.keys()], ["alpha", "beta"]);
  assert.deepEqual(surfaces.get("alpha").fields.get("status"), ["alpha-status"]);
  assert.deepEqual(surfaces.get("alpha").fields.get("widget"), ["alpha-widget"]);
  assert.deepEqual(surfaces.get("alpha").fields.get("hooks"), ["tool_call", "input"]);
  assert.deepEqual(surfaces.get("alpha").fields.get("eventsProvide"), ["caps:alpha"]);
  assert.deepEqual(surfaces.get("alpha").fields.get("bare"), []);
  assert.deepEqual(surfaces.get("beta").fields.get("bare"), ["true"]);
});

test("parseSurfaces 忽略非字段行与未声明的标题层级", () => {
  const md = ["### alpha", "这是说明文字。", "状态键: a", "## 新章节", "### beta", "状态键: b"].join("\n");
  const surfaces = parseSurfaces(md);
  assert.deepEqual([...surfaces.keys()], ["alpha", "beta"]);
  assert.equal(surfaces.get("alpha").fields.size, 1);
});

test("validateSurfaces 报出未声明的扩展目录", () => {
  const root = makeRepo({
    [ext("alpha", "pi.on('tool_call', () => {});")[0]]: "pi.on('tool_call', () => {});",
    [ext("beta", "export {};")[0]]: "export {};",
  });
  const { problems } = validateSurfaces({ repoRoot: root, markdown: "### alpha\n无注册面: true\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /`beta` 未在 .* 声明接触面/);
});

test("validateSurfaces 报出清单里不存在的扩展目录", () => {
  const root = makeRepo({ [ext("alpha", "export {};")[0]]: "export {};" });
  const { problems } = validateSurfaces({ repoRoot: root, markdown: "### alpha\n无注册面: true\n\n### ghost\n无注册面: true\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /`ghost` 不是 src\/extensions/);
});

test("validateSurfaces 报出声明的键在源码里找不到（声明与实现分叉）", () => {
  const root = makeRepo({ [ext("alpha", "ctx.ui.setStatus('alpha-status', 'x');")[0]]: "ctx.ui.setStatus('alpha-status', 'x');" });
  const md = "### alpha\n状态键: alpha-status\nwidget: 不存在的键\n";
  const { problems } = validateSurfaces({ repoRoot: root, markdown: md });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /alpha: 声明 `widget: 不存在的键`/);
});

test("validateSurfaces 忽略测试文件里的字面量（只看非测试源码）", () => {
  const root = makeRepo({
    [ext("alpha", "export {};")[0]]: "export {};",
    "src/extensions/alpha/index.test.ts": "ctx.ui.setStatus('alpha-status', 'x');",
  });
  const { problems } = validateSurfaces({ repoRoot: root, markdown: "### alpha\n状态键: alpha-status\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /找不到字面量 "alpha-status"/);
});

test("validateSurfaces 报出没有任何可识别字段的空节", () => {
  const root = makeRepo({ [ext("alpha", "export {};")[0]]: "export {};" });
  const { problems } = validateSurfaces({ repoRoot: root, markdown: "### alpha\n（待补）\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /没有任何可识别字段/);
});

test("validateSurfaces 通过时 problems 为空", () => {
  const root = makeRepo({ [ext("alpha", "ctx.ui.setStatus('alpha-status', 'x');\npi.on('tool_call', () => {});")[0]]: "ctx.ui.setStatus('alpha-status', 'x');\npi.on('tool_call', () => {});" });
  const md = "### alpha\n状态键: alpha-status\n宿主钩子: tool_call\n";
  assert.deepEqual(validateSurfaces({ repoRoot: root, markdown: md }).problems, []);
});

test("computePairs 对同一声明槽配对（状态键重复）", () => {
  const surfaces = parseSurfaces("### alpha\n状态键: shared\n\n### beta\n状态键: shared\n");
  const pairs = computePairs(surfaces);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].pair, ["alpha", "beta"]);
  assert.deepEqual(pairs[0].reasons, [{ dim: "status", value: "shared" }]);
});

test("computePairs 对能力频道按「提供↔消费」配对，同向不配对", () => {
  const surfaces = parseSurfaces(
    "### alpha\nevents 提供: caps:bash\n\n### beta\nevents 消费: caps:bash\n\n### gamma\nevents 提供: caps:bash\n",
  );
  const pairs = computePairs(surfaces);
  assert.deepEqual(
    pairs.map((p) => p.pair),
    [
      ["alpha", "beta"],
      ["beta", "gamma"],
    ],
  );
  assert.ok(pairs.every((p) => p.reasons.every((r) => r.dim === "capability")));
});

test("computePairs 只对拦截型钩子配对，生命周期钩子不配对", () => {
  const surfaces = parseSurfaces("### alpha\n宿主钩子: tool_call,session_start\n\n### beta\n宿主钩子: tool_call,session_start\n");
  const pairs = computePairs(surfaces);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].reasons, [{ dim: "hook", value: "tool_call" }]);
});

test("computePairs 在生命周期钩子完全相同时不产生配对", () => {
  const surfaces = parseSurfaces("### alpha\n宿主钩子: session_start,session_shutdown\n\n### beta\n宿主钩子: session_start,session_shutdown\n");
  assert.deepEqual(computePairs(surfaces), []);
});

test("computePairs 无交集的扩展不配对，且结果按字典序稳定", () => {
  const surfaces = parseSurfaces("### beta\n状态键: b1\n\n### alpha\n状态键: a1\n\n### gamma\n状态键: a1\n");
  const pairs = computePairs(surfaces);
  assert.deepEqual(pairs.map((p) => p.pair), [["alpha", "gamma"]]);
});

test("computePairs 对 replace:<内置工具> 与同名工具注册配对", () => {
  const surfaces = parseSurfaces("### alpha\n工具: bash\n\n### beta\n工具面: `replace: bash`\n");
  const pairs = computePairs(surfaces);
  assert.deepEqual(pairs.map((p) => p.pair), [["alpha", "beta"]]);
  assert.deepEqual(pairs[0].reasons, [{ dim: "tool", value: "bash" }]);
});

test("computePairs 同一对多维度只出一条，reasons 记录全部维度", () => {
  const surfaces = parseSurfaces("### alpha\n状态键: s\n工具: t\n\n### beta\n状态键: s\n工具: t\n");
  const pairs = computePairs(surfaces);
  assert.equal(pairs.length, 1);
  assert.deepEqual(
    pairs[0].reasons.map((r) => r.dim).sort(),
    ["status", "tool"],
  );
});
