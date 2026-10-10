/**
 * discover.ts 单测：从锚点目录向上找到「严格在 cwd 之下」的上下文文件。
 *
 * 边界：真实临时目录（每个用例建一棵小树），因为「哪一级是谁」正是被测行为本身。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONTEXT_FILE_NAMES, discoverContextFiles } from "../discover.ts";

function makeTree(): { root: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dir-context-discover-"));
  return { root: base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("候选文件名集合与 pi 原生一致（顺序即优先级）", () => {
  assert.deepEqual([...CONTEXT_FILE_NAMES], ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
});

test("多层链：每级取一个，由外向内排列，cwd 自身不重复注入（pi 已加载）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "a", "b", "c"), { recursive: true });
  fs.writeFileSync(path.join(project, "AGENTS.md"), "root");
  fs.writeFileSync(path.join(project, "a", "AGENTS.md"), "a");
  fs.writeFileSync(path.join(project, "a", "b", "CLAUDE.md"), "b");
  fs.writeFileSync(path.join(project, "a", "b", "c", "AGENTS.md"), "c");

  const files = discoverContextFiles({ anchorDir: path.join(project, "a", "b", "c"), rootDir: project });
  assert.deepEqual(files, [
    path.join(project, "a", "AGENTS.md"),
    path.join(project, "a", "b", "CLAUDE.md"),
    path.join(project, "a", "b", "c", "AGENTS.md"),
  ]);
});

test("同目录优先级：AGENTS.override.md 压掉 AGENTS.md / CLAUDE.md", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "AGENTS.md"), "plain");
  fs.writeFileSync(path.join(project, "src", "CLAUDE.md"), "claude");
  fs.writeFileSync(path.join(project, "src", "AGENTS.override.md"), "override");

  assert.deepEqual(discoverContextFiles({ anchorDir: path.join(project, "src"), rootDir: project }), [
    path.join(project, "src", "AGENTS.override.md"),
  ]);
});

test("大小写变体 AGENTS.MD / CLAUDE.MD 可被发现", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "x", "y"), { recursive: true });
  fs.writeFileSync(path.join(project, "x", "AGENTS.MD"), "upper-agents");
  fs.writeFileSync(path.join(project, "x", "y", "CLAUDE.MD"), "upper-claude");

  assert.deepEqual(discoverContextFiles({ anchorDir: path.join(project, "x", "y"), rootDir: project }), [
    path.join(project, "x", "AGENTS.MD"),
    path.join(project, "x", "y", "CLAUDE.MD"),
  ]);
});

test("锚点 = cwd：零发现（cwd 的文件 pi 已在启动时加载）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "AGENTS.md"), "root");

  assert.deepEqual(discoverContextFiles({ anchorDir: project, rootDir: project }), []);
});

test("中间目录没有上下文文件：跳过该级继续向上", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(project, "a", "AGENTS.md"), "a");

  assert.deepEqual(discoverContextFiles({ anchorDir: path.join(project, "a", "b"), rootDir: project }), [
    path.join(project, "a", "AGENTS.md"),
  ]);
});

test("锚点在 cwd 之外：零发现（防御性，上游已 fail-closed）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  const outside = path.join(tree.root, "outside");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "AGENTS.md"), "x");

  assert.deepEqual(discoverContextFiles({ anchorDir: outside, rootDir: project }), []);
});

test("文件级链接逃逸：内容在 cwd 之外时整个候选跳过（fail-closed，不伪装路径）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  const outside = path.join(tree.root, "outside");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "shared.md"), "外部内容");
  try {
    fs.symlinkSync(path.join(outside, "shared.md"), path.join(project, "src", "AGENTS.md"), "file");
  } catch (error) {
    t.skip(`本机无法创建文件链接（${String(error)}），跳过文件级逃逸用例`);
    return;
  }

  assert.deepEqual(discoverContextFiles({ anchorDir: path.join(project, "src"), rootDir: project }), []);
});

test("锚点在 cwd 之下但目录不存在（write 新文件且路径更深）：不抛错，向上找已存在的级", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "AGENTS.md"), "src");

  const files = discoverContextFiles({ anchorDir: path.join(project, "src", "nope", "deeper"), rootDir: project });
  assert.deepEqual(files, [path.join(project, "src", "AGENTS.md")]);
});

test("文件链接指向 cwd 之内：正常发现（取磁盘真名）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "notes"), { recursive: true });
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "notes", "shared.md"), "共享约定");
  try {
    fs.symlinkSync(path.join(project, "notes", "shared.md"), path.join(project, "src", "AGENTS.md"), "file");
  } catch (error) {
    t.skip(`本机无法创建文件链接（${String(error)}），跳过链接内解析用例`);
    return;
  }

  assert.deepEqual(discoverContextFiles({ anchorDir: path.join(project, "src"), rootDir: project }), [
    path.join(project, "notes", "shared.md"),
  ]);
});
