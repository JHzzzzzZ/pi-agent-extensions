/**
 * skill 资产结构测试：SKILL.md 的 frontmatter 与命令面、包装器是否存在。
 *
 * 为什么要有：Pi 对缺 description / 名字非法的 skill **静默不加载**（只打 warning），
 * 光靠人眼核验会在下次改动后悄悄失效。这里只锁「可被判为合法 skill」+ 命令面不漏项，
 * 不锁正文措辞（那是文档，由人读）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_MD = path.join(SKILL_DIR, "SKILL.md");
const WRAPPER = path.join(SKILL_DIR, "scripts", "todo.sh");

function readFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, "SKILL.md 必须以 YAML frontmatter 开头");
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep > 0) fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return fields;
}

test("SKILL.md：frontmatter 合法（name 规则 + description 非空且 ≤1024）", () => {
  const text = fs.readFileSync(SKILL_MD, "utf8");
  const fields = readFrontmatter(text);
  assert.equal(fields.name, "todo-cli");
  assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "name 只允许小写字母/数字/单连字符");
  assert.ok(fields.name.length <= 64);
  assert.ok(fields.description !== undefined && fields.description.length > 0, "description 必填");
  assert.ok(fields.description.length <= 1024, `description 超长：${fields.description.length}`);
});

test("SKILL.md：命令面与入口/包装器路径齐备（与 core.ts 的 USAGE 同一套）", () => {
  const text = fs.readFileSync(SKILL_MD, "utf8");
  for (const sub of ["summary", "list", "add", "claim", "align", "complete", "reopen", "lint", "triage", "migrate"]) {
    assert.ok(text.includes(sub), `SKILL.md 缺子命令 ${sub}`);
  }
  assert.ok(text.includes(".agents/skills/todo-cli/todo-cli/todo.mjs"), "必须写明唯一入口路径");
  assert.ok(text.includes("--root"), "必须写明 --root 覆盖");
  assert.ok(text.includes("git rev-parse --show-toplevel"), "必须写明 git 自动发现");

  assert.equal(fs.existsSync(WRAPPER), true, "包装器 scripts/todo.sh 必须存在");
  const wrapper = fs.readFileSync(WRAPPER, "utf8");
  assert.match(wrapper, /todo-cli\/todo\.mjs/, "包装器必须指向内层工具，而不是仓库根的 tools/todo.mjs");
  assert.equal(wrapper.includes("tools/todo.mjs"), false, "包装器不得引用已删除的旧入口");
});
