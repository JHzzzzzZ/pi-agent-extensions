/**
 * Team file frontmatter tolerance (#63): the host's `parseFrontmatter` rejects
 * bare scalars containing ": " (`description: 全栈开发: 小队`), so a single
 * hand-written description used to make the whole team file unusable. Parsing
 * now retries once with those values quoted; when the file still fails the
 * error gains an actionable hint (file line + fix), and `findTeam` names the
 * unusable files so the run paths stop being silent about them.
 *
 * Scope of this file: `config.ts` parsing/discovery only. The run/resume
 * wiring (TEAM_NOT_FOUND text reaching `team_run` / `team_resume`) is locked
 * in `test/run-tool.test.ts`.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { findTeam, parseTeamFile, serializeTeam } from "../config.ts";
import { TeamErrorCodes } from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";

const LEADER_AND_MEMBER = `leader:
  model: opencode-go/deepseek-flash
  prompt: |
    你是技术负责人。
members:
  - name: dev
    model: opencode-go/deepseek-flash
    prompt: |
      你是成员。`;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-frontmatter-"));
}

/** 与 CLI 相同的口径：整个 frontmatter 块（含块标量 prompt）里出现不可修复的 YAML 错误。 */
const UNFIXABLE_MEMBERS = `members: [`; // 未闭合 flow sequence —— 加引号重试也救不回来

test("parseTeamFile tolerates a bare \": \" in the team description", () => {
  const content = `---
name: colon-team
description: 全栈开发: 小队
${LEADER_AND_MEMBER}
---
`;
  const parsed = parseTeamFile(content, { filePath: "/x/colon-team.md", source: "global" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.equal(parsed.value.description, "全栈开发: 小队");
  assert.equal(parsed.value.leader.prompt.trim(), "你是技术负责人。");
});

test("parseTeamFile tolerates a bare \": \" in a member description", () => {
  const content = `---
name: colon-team
description: 普通描述
leader:
  prompt: |
    你是负责人。
members:
  - name: dev
    description: 写代码: 做测试
    prompt: |
      你是成员。
---
`;
  const parsed = parseTeamFile(content, { filePath: "/x/colon-team.md", source: "global" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.equal(parsed.value.members[0].description, "写代码: 做测试");
});

test("quoted \": \" values, block scalars and CRLF keep working (tolerance stays narrow)", () => {
  const quoted = parseTeamFile(
    `---\nname: t\ndescription: "全栈开发: 小队"\n${LEADER_AND_MEMBER}\n---\n`,
    { filePath: "/x/t.md", source: "global" },
  );
  assert.ok(quoted.ok, quoted.ok ? "" : quoted.message);
  assert.equal(quoted.value.description, "全栈开发: 小队");

  const block = parseTeamFile(
    `---\nname: t\ndescription: |\n  全栈开发: 小队\n${LEADER_AND_MEMBER}\n---\n`,
    { filePath: "/x/t.md", source: "global" },
  );
  assert.ok(block.ok, block.ok ? "" : block.message);
  assert.equal(block.value.description, "全栈开发: 小队");

  const crlf = parseTeamFile(
    `---\r\nname: t\r\ndescription: 全栈开发: 小队\r\n${LEADER_AND_MEMBER}\r\n---\r\n`,
    { filePath: "/x/t.md", source: "global" },
  );
  assert.ok(crlf.ok, crlf.ok ? "" : crlf.message);
  assert.equal(crlf.value.description, "全栈开发: 小队");
});

test("retry reuses the write-path escaping: bare \": \" value with inner quotes survives", () => {
  const content = `---
name: t
description: 他说 "你好": 世界
${LEADER_AND_MEMBER}
---
`;
  const parsed = parseTeamFile(content, { filePath: "/x/t.md", source: "global" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.equal(parsed.value.description, '他说 "你好": 世界');
});

test("retry does not rewrite block-scalar content lines that look like mappings", () => {
  const content = `---
name: t
description: 全栈开发: 小队
leader:
  prompt: |
    你是负责人。
    Note: 保持: 原样
members:
  - name: dev
    prompt: |
      干活。
---
`;
  const parsed = parseTeamFile(content, { filePath: "/x/t.md", source: "global" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.ok(parsed.value.leader.prompt.includes("Note: 保持: 原样"), parsed.value.leader.prompt);
  assert.ok(!parsed.value.leader.prompt.includes('"'), parsed.value.leader.prompt);
});

test("retry only rewrites frontmatter lines — body notes stay verbatim", () => {
  const content = `---
name: t
description: 全栈开发: 小队
${LEADER_AND_MEMBER}
---

正文说明: 也带冒号: 的备注。
`;
  const parsed = parseTeamFile(content, { filePath: "/x/t.md", source: "global" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.equal(parsed.value.notes, "正文说明: 也带冒号: 的备注。");
});

test("unfixable YAML error keeps the original detail and gains a line-numbered fix hint", () => {
  // 描述行可容忍，但 `members: [` 救不回来 —— 重试仍失败 ⇒ 回落**首次**解析的
  // 原始错误（对齐文档：重试仍失败则回落原错误），并前置修法提示。
  const content = `---
name: t
description: 全栈开发: 小队
${UNFIXABLE_MEMBERS}
---
`;
  const parsed = parseTeamFile(content, { filePath: "/x/t.md", source: "global" });
  assert.ok(!parsed.ok);
  assert.equal(parsed.code, TeamErrorCodes.INVALID_TEAM_FILE);
  // 行号按团队文件真实行（`---` 占第 1 行，宿主的 YAML 片段从第 2 行起）。
  assert.match(parsed.message, /第 3 行的值含 ": "，请加引号（"…"）或改用 \| 块标量/);
  assert.match(parsed.message, /failed to parse frontmatter/);
  assert.match(parsed.message, /Nested mappings are not allowed in compact mappings/, "原始 YAML 错误作为细节保留");
});

test("failures without a bare \": \" line keep the plain error (no misleading hint)", () => {
  const content = `---
name: t
leader:
\tprompt: p
members:
  - name: a
    prompt: p
---
`;
  const parsed = parseTeamFile(content, { filePath: "/x/t.md", source: "global" });
  assert.ok(!parsed.ok);
  assert.equal(parsed.code, TeamErrorCodes.INVALID_TEAM_FILE);
  assert.match(parsed.message, /failed to parse frontmatter/);
  assert.ok(!parsed.message.includes('值含 ": "'), parsed.message);
});

test("findTeam names unusable files in TEAM_NOT_FOUND (reason first line only)", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "good.md"), serializeTeam(fixtureTeam({ name: "good", filePath: "" })));
    fs.writeFileSync(
      path.join(dir, "bad.md"),
      `---
name: bad
description: 全栈开发: 小队
${UNFIXABLE_MEMBERS}
---
`,
    );
    const found = findTeam({ cwd: dir, scope: "global", name: "bad", globalDir: dir });
    assert.ok(!found.ok);
    assert.equal(found.code, TeamErrorCodes.TEAM_NOT_FOUND);
    assert.match(found.message, /team "bad" not found \(available: good\)/);
    assert.match(found.message, /另有 1 个定义不可用/);
    assert.match(found.message, /bad\.md（第 3 行的值含 ": "，请加引号/);
    assert.ok(!found.message.includes("\n"), "原因只取首行，文案保持单行");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TEAM_NOT_FOUND keeps its exact old wording when every file is valid", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "good.md"), serializeTeam(fixtureTeam({ name: "good", filePath: "" })));
    const found = findTeam({ cwd: dir, scope: "global", name: "nope", globalDir: dir });
    assert.ok(!found.ok);
    assert.equal(found.code, TeamErrorCodes.TEAM_NOT_FOUND);
    assert.equal(found.message, 'team "nope" not found (available: good)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
