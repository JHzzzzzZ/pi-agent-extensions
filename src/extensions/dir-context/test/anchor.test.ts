/**
 * anchor.ts 单测：锚点目录解析 + cwd 包含校验。
 *
 * 为什么用**真实临时文件系统**而不是路径字符串替身：本模块的风险全在
 * realpath / 符号链接 / 前缀冒充 / 尚不存在的文件这些真实语义上——纯字符串
 * 拼路径的「纸面正确」抓不到 repo vs repo-evil 与链接逃逸。
 *
 * 边界 fake：无（只用 node:fs 与 os.tmpdir）。Windows 上目录 symlink 需要管理
 * 员权限，测试里用 `junction` 建立等价的链接逃逸场景；建不出来时 skip 而非静默绿。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAnchor } from "../anchor.ts";

function makeTree(): { root: string; cleanup: () => void } {
  // realpath 归一：期望值必须与被测实现（canonicalize）同一坐标系，否则 Windows 上
  // 临时目录的大小写/短路径差异会造成假红。
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dir-context-anchor-")));
  return { root: base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("文件在嵌套目录：锚点 = 该文件所在目录", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "components", "Button.tsx"), "x");

  const result = resolveAnchor({ rawPath: "src/components/Button.tsx", kind: "file", cwd: project });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.anchorDir, path.join(project, "src", "components"));
});

test("write 到尚不存在的文件：锚点仍解析到其所在目录（最深的已存在祖先 + 尾巴）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });

  const result = resolveAnchor({ rawPath: "src/deep/new/file.ts", kind: "file", cwd: project });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.anchorDir, path.join(project, "src", "deep", "new"));
});

test("ls 一个文件路径：锚点退到它的父目录", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.ts"), "x");

  const result = resolveAnchor({ rawPath: "src/a.ts", kind: "directory", cwd: project });
  assert.equal(result.ok && result.anchorDir, path.join(project, "src"));
});

test("cwd 之外的路径（相对与绝对）：没有锚点，零注入", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  const outside = path.join(tree.root, "outside");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "a.ts"), "x");

  for (const rawPath of ["../outside/a.ts", path.join(outside, "a.ts")]) {
    const result = resolveAnchor({ rawPath, kind: "file", cwd: project });
    assert.equal(result.ok, true, rawPath);
    assert.equal(result.ok && result.anchorDir, null, rawPath);
  }
});

test("前缀冒充：repo-evil 不算在 repo 内（字符串前缀判定必须带分隔符）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  const evil = path.join(tree.root, "repo-evil");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, "a.ts"), "x");

  const result = resolveAnchor({ rawPath: "../repo-evil/a.ts", kind: "file", cwd: project });
  assert.equal(result.ok && result.anchorDir, null);
});

test("符号链接逃逸：链接指向 cwd 之外时 fail-closed（realpath 后判定）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  const outside = path.join(tree.root, "outside");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.ts"), "x");
  try {
    // Windows 上目录 symlink 需管理员权限，junction 等价且普通权限可用；非 Windows 平台普通 symlink 即可。
    fs.symlinkSync(outside, path.join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`本机无法创建目录链接（${String(error)}），跳过链接逃逸用例`);
    return;
  }

  const result = resolveAnchor({ rawPath: "linked/secret.ts", kind: "file", cwd: project });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.anchorDir, null, "链接指向 cwd 之外时必须零注入");
});

test("链接指向 cwd 之内：正常解析到真实目录", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "real"), { recursive: true });
  try {
    fs.symlinkSync(path.join(project, "real"), path.join(project, "alias"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`本机无法创建目录链接（${String(error)}），跳过链接内解析用例`);
    return;
  }

  const result = resolveAnchor({ rawPath: "alias/a.ts", kind: "file", cwd: project });
  assert.equal(result.ok && result.anchorDir, path.join(project, "real"));
});

test("锚点等于 cwd 本身：合法但交给下游发现（发现阶段会返回空）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "a.ts"), "x");

  assert.equal(resolveAnchor({ rawPath: "a.ts", kind: "file", cwd: project }).ok, true);
  const result = resolveAnchor({ rawPath: ".", kind: "directory", cwd: project });
  assert.equal(result.ok && result.anchorDir, project);
});

test("入参用反斜杠 / 混合分隔符：按平台解析（Windows 真机语义）", (t) => {
  const tree = makeTree();
  t.after(tree.cleanup);
  const project = path.join(tree.root, "repo");
  fs.mkdirSync(path.join(project, "src", "ui"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "ui", "a.ts"), "x");

  const rawPath = process.platform === "win32" ? "src\\ui\\a.ts" : "src/ui/a.ts";
  const result = resolveAnchor({ rawPath, kind: "file", cwd: project });
  assert.equal(result.ok && result.anchorDir, path.join(project, "src", "ui"));
});
