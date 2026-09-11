/**
 * Team definition file tests: parse + validate + serialize roundtrip +
 * discovery precedence + file creation rules.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildTeamFromToolInput,
  createTeamFile,
  discoverTeams,
  findNearestProjectTeamsDir,
  parseTeamFile,
  serializeTeam,
  splitModelThinking,
  validateTeam,
} from "../config.ts";
import { TeamErrorCodes } from "../types.ts";
import { VALID_TEAM_MD, fixtureTeam } from "./fixtures.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-cfg-"));
}

test("parseTeamFile parses nested YAML frontmatter with block-scalar prompts", () => {
  const parsed = parseTeamFile(VALID_TEAM_MD, { filePath: "/x/dev-team.md", source: "global" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  const team = parsed.value;
  assert.equal(team.name, "dev-team");
  assert.equal(team.description, "全栈开发小队");
  assert.equal(team.leader.model, "anthropic/claude-opus-4-5");
  assert.ok(team.leader.prompt.includes("拆解"));
  assert.equal(team.members.length, 2);
  assert.equal(team.members[0].name, "frontend");
  assert.equal(team.members[0].model, "chatanywhere/gpt-5.6");
  assert.deepEqual(team.members[0].tools, ["read", "edit", "bash"]);
  assert.equal(team.members[0].worktree, false);
  assert.ok(team.members[0].prompt.includes("TypeScript"));
  assert.equal(team.members[1].worktree, true);
  assert.equal(team.source, "global");
  assert.equal(team.filePath, "/x/dev-team.md");
  assert.ok(team.notes?.includes("团队级补充说明"));
});

test("parseTeamFile rejects invalid definitions with typed errors", () => {
  const cases: Array<[string, string]> = [
    ["no frontmatter at all", "just text"],
    ["missing name", "---\ndescription: x\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n"],
    ["empty members", "---\nname: t\nleader:\n  prompt: p\nmembers: []\n---\n"],
    ["duplicate member names", "---\nname: t\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n  - name: a\n    prompt: p\n---\n"],
    ["member without prompt", "---\nname: t\nleader:\n  prompt: p\nmembers:\n  - name: a\n---\n"],
    ["leader without prompt", "---\nname: t\nleader: {}\nmembers:\n  - name: a\n    prompt: p\n---\n"],
    ["model with whitespace", "---\nname: t\nleader:\n  prompt: p\n  model: anthropic claude\nmembers:\n  - name: a\n    prompt: p\n---\n"],
    ["name with slash", "---\nname: a/b\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n"],
  ];
  for (const [label, content] of cases) {
    const parsed = parseTeamFile(content, { filePath: "/x/bad.md", source: "global" });
    assert.ok(!parsed.ok, `expected rejection: ${label}`);
    assert.equal(parsed.code, TeamErrorCodes.INVALID_TEAM_FILE, label);
  }
});

test("validateTeam normalizes comma-separated tools strings", () => {
  const parsed = validateTeam(
    {
      name: "t",
      leader: { prompt: "p", tools: "read, grep" },
      members: [{ name: "a", prompt: "p", tools: "bash" }],
    },
    { filePath: "/x", source: "project" },
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value?.leader.tools, ["read", "grep"]);
  assert.deepEqual(parsed.value?.members[0].tools, ["bash"]);
  assert.equal(parsed.value?.source, "project");
});

test("serializeTeam output round-trips through parseTeamFile", () => {
  const team = fixtureTeam({ notes: undefined });
  const serialized = serializeTeam(team, "备注正文\n第二行");
  const parsed = parseTeamFile(serialized, { filePath: team.filePath, source: team.source });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  const back = parsed.value;
  assert.equal(back.name, team.name);
  assert.equal(back.description, team.description);
  assert.equal(back.leader.model, team.leader.model);
  assert.equal(back.leader.prompt.trim(), team.leader.prompt.trim());
  assert.equal(back.members.length, team.members.length);
  for (let i = 0; i < team.members.length; i++) {
    assert.equal(back.members[i].name, team.members[i].name);
    assert.equal(back.members[i].model, team.members[i].model);
    assert.equal(!!back.members[i].worktree, !!team.members[i].worktree);
    assert.equal(back.members[i].prompt.trim(), team.members[i].prompt.trim());
  }
  assert.equal(back.notes?.trim(), "备注正文\n第二行");
});

test("team-level worktree flag round-trips (parse + serialize)", () => {
  const withFlag = parseTeamFile(
    "---\nname: t\nworktree: true\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n",
    { filePath: "/x/t.md", source: "global" },
  );
  assert.ok(withFlag.ok);
  assert.equal(withFlag.value?.worktree, true);
  const withoutFlag = parseTeamFile(
    "---\nname: t\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n",
    { filePath: "/x/t.md", source: "global" },
  );
  assert.ok(withoutFlag.ok);
  assert.equal(withoutFlag.value?.worktree, undefined);

  const serialized = serializeTeam({ ...fixtureTeam({ worktree: true }) });
  assert.match(serialized, /^worktree: true$/m);
  const reparsed = parseTeamFile(serialized, { filePath: "/x", source: "global" });
  assert.ok(reparsed.ok);
  assert.equal(reparsed.value?.worktree, true);
});

test("serializeTeam keeps special characters and colons in prompts", () => {
  const team = fixtureTeam({
    members: [{ name: "qa", prompt: "校验 JSON: {\"a\": 1}\n缩进:  2 空格\n" }],
  });
  const parsed = parseTeamFile(serializeTeam(team), { filePath: team.filePath, source: "global" });
  assert.ok(parsed.ok);
  assert.ok(parsed.value?.members[0].prompt.includes('{"a": 1}'));
});

test("parseTeamFile parses the budget block into team.budget", () => {
  const parsed = parseTeamFile(
    "---\nname: budgeted\nbudget:\n  maxDispatchCalls: 20\n  maxMemberRuns: 60\n  maxCostUsd: 5.5\n  maxTotalTokens: 1000000\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n",
    { filePath: "/x/budgeted.md", source: "global" },
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.deepEqual(parsed.value?.budget, {
    maxDispatchCalls: 20,
    maxMemberRuns: 60,
    maxCostUsd: 5.5,
    maxTotalTokens: 1000000,
  });
});

test("a team without a budget block has no budget config", () => {
  const parsed = parseTeamFile(VALID_TEAM_MD, { filePath: "/x/dev-team.md", source: "global" });
  assert.ok(parsed.ok);
  assert.equal(parsed.value?.budget, undefined);
});

test("invalid budget blocks are rejected with INVALID_TEAM_FILE", () => {
  const cases: Array<[string, string]> = [
    ["budget not a mapping", "---\nname: t\nbudget: 20\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n"],
    ["string cap", "---\nname: t\nbudget:\n  maxDispatchCalls: many\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n"],
    ["negative cap", "---\nname: t\nbudget:\n  maxCostUsd: -1\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n"],
    ["zero cap", "---\nname: t\nbudget:\n  maxMemberRuns: 0\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n"],
    ["unknown key", "---\nname: t\nbudget:\n  maxTasks: 5\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n"],
    ["empty budget block", "---\nname: t\nbudget: {}\nleader:\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n"],
  ];
  for (const [label, content] of cases) {
    const parsed = parseTeamFile(content, { filePath: "/x/bad.md", source: "global" });
    assert.ok(!parsed.ok, `expected rejection: ${label}`);
    assert.equal(parsed.code, TeamErrorCodes.INVALID_TEAM_FILE, label);
  }
});

test("serializeTeam round-trips the budget block", () => {
  const team = fixtureTeam({ budget: { maxCostUsd: 5, maxDispatchCalls: 30 } });
  const serialized = serializeTeam(team);
  assert.match(serialized, /^budget:/m);
  assert.match(serialized, /maxCostUsd: 5/);
  const parsed = parseTeamFile(serialized, { filePath: team.filePath, source: team.source });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value?.budget, { maxCostUsd: 5, maxDispatchCalls: 30 });
});

test("discoverTeams scans global+project dirs with project precedence", () => {
  const root = tmpDir();
  const globalDir = path.join(root, "global");
  const projectDir = path.join(root, "proj", ".pi", "teams");
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(globalDir, "dev-team.md"), VALID_TEAM_MD);
  fs.writeFileSync(path.join(globalDir, "solo.md"), serializeTeam(fixtureTeam({ name: "solo", filePath: "" })));
  // project override with the same name + an invalid file
  fs.writeFileSync(path.join(projectDir, "dev-team.md"), serializeTeam(fixtureTeam({ name: "dev-team", description: "项目覆盖版", filePath: "" })));
  fs.writeFileSync(path.join(projectDir, "broken.md"), "not a team file");

  assert.equal(findNearestProjectTeamsDir(path.join(root, "proj", "deep")), projectDir);
  const both = discoverTeams({ cwd: path.join(root, "proj"), scope: "both", globalDir });
  assert.equal(both.teams.length, 2);
  const overridden = both.teams.find((t) => t.name === "dev-team");
  assert.equal(overridden?.description, "项目覆盖版");
  assert.equal(overridden?.source, "project");
  assert.equal(both.invalid.length, 1);
  assert.match(both.invalid[0].message, /frontmatter|name|required/i);

  const globalOnly = discoverTeams({ cwd: path.join(root, "proj"), scope: "global", globalDir });
  assert.equal(globalOnly.teams.length, 2);
  assert.equal(globalOnly.teams.find((t) => t.name === "dev-team")?.source, "global");
});

// 思考级别后缀来自宿主 VALID_THINKING_LEVELS（pi CLI `--model provider/id:level`）。
test("splitModelThinking 只在最后一段是有效思考级别时剥离模型后缀", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(splitModelThinking(`anthropic/claude-opus-4-5:${level}`), {
      model: "anthropic/claude-opus-4-5",
      thinkingLevel: level,
    });
  }
  // provider 斜杠形态 & 模型 id 本就带冒号：只剥最后一个合法后缀
  assert.deepEqual(splitModelThinking("openrouter/deepseek/deepseek-r1:max"), {
    model: "openrouter/deepseek/deepseek-r1",
    thinkingLevel: "max",
  });
  assert.deepEqual(splitModelThinking("a:b:medium"), { model: "a:b", thinkingLevel: "medium" });
  // 非法后缀不剥（是模型名的一部分）
  assert.deepEqual(splitModelThinking("provider/model:ultra"), { model: "provider/model:ultra" });
  assert.deepEqual(splitModelThinking("provider/model:high5"), { model: "provider/model:high5" });
  // 无后缀与空值安全
  assert.deepEqual(splitModelThinking("anthropic/claude-opus-4-5"), { model: "anthropic/claude-opus-4-5" });
  assert.deepEqual(splitModelThinking(undefined), {});
  assert.deepEqual(splitModelThinking(""), {});
  // 剥完会得到空模型（裸后缀）不剥：`:high` 不是可解析的模型引用
  assert.deepEqual(splitModelThinking(":high"), { model: ":high" });
});

// ---------------------------------------------------------------------------
// External CLI backends (v1: codex / claude members; leader syntax-only)
// ---------------------------------------------------------------------------

test("parseTeamFile 接受 codex/claude 成员 backend 并落位字段", () => {
  const parsed = parseTeamFile(
    "---\nname: ext\nleader:\n  prompt: p\nmembers:\n  - name: coder\n    backend: codex\n    model: gpt-5.1-codex\n    prompt: p\n  - name: writer\n    backend: claude\n    model: claude-haiku-4-5\n    prompt: p\n---\n",
    { filePath: "/x/ext.md", source: "global" },
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.equal(parsed.value?.members[0].backend, "codex");
  assert.equal(parsed.value?.members[0].model, "gpt-5.1-codex");
  assert.equal(parsed.value?.members[1].backend, "claude");
  // 未声明 backend 的成员保持 undefined（与 1.21.0 等价）
  const plain = parseTeamFile(VALID_TEAM_MD, { filePath: "/x/dev-team.md", source: "global" });
  assert.ok(plain.ok);
  assert.equal(plain.value?.leader.backend, undefined);
  assert.equal(plain.value?.members[0].backend, undefined);
});

test("backend 值域外的成员值 → INVALID_TEAM_FILE 且消息含合法值清单", () => {
  const cases: Array<[string, string]> = [
    ["unknown name", "backend: wan"],
    ["number", "backend: 1"],
    ["empty string", 'backend: ""'],
    ["null", "backend:"],
  ];
  for (const [label, line] of cases) {
    const parsed = parseTeamFile(
      `---\nname: t\nleader:\n  prompt: p\nmembers:\n  - name: a\n    ${line}\n    prompt: p\n---\n`,
      { filePath: "/x/bad.md", source: "global" },
    );
    assert.ok(!parsed.ok, `expected rejection: ${label}`);
    assert.equal(parsed.code, TeamErrorCodes.INVALID_TEAM_FILE, label);
    assert.match(parsed.message, /a\.backend/, label);
    assert.match(parsed.message, /codex/, label);
    assert.match(parsed.message, /claude/, label);
  }
});

test("leader 的非法 backend 值同样 INVALID_TEAM_FILE", () => {
  const parsed = parseTeamFile(
    "---\nname: t\nleader:\n  backend: wan\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n",
    { filePath: "/x/bad.md", source: "global" },
  );
  assert.ok(!parsed.ok);
  assert.equal(parsed.code, TeamErrorCodes.INVALID_TEAM_FILE);
  assert.match(parsed.message, /leader\.backend/);
  assert.match(parsed.message, /codex/);
  assert.match(parsed.message, /claude/);
});

test("leader 带 backend 在 config 层通过（run 预检才拒绝）", () => {
  const parsed = parseTeamFile(
    "---\nname: ext\nleader:\n  backend: codex\n  prompt: p\nmembers:\n  - name: a\n    prompt: p\n---\n",
    { filePath: "/x/ext.md", source: "global" },
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.equal(parsed.value?.leader.backend, "codex");
});

test("serializeTeam 把 backend 输出在 model 之前且 round-trip 保持", () => {
  const team = fixtureTeam({
    leader: { backend: "claude", model: "claude-opus-4-5", prompt: "p" },
    members: [{ name: "coder", backend: "codex", model: "gpt-5.1-codex", prompt: "p" }],
  });
  const serialized = serializeTeam(team);
  assert.match(serialized, /^  backend: claude\n  model:/m);
  assert.match(serialized, /^    backend: codex\n    model:/m);
  const parsed = parseTeamFile(serialized, { filePath: team.filePath, source: team.source });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  assert.equal(parsed.value?.leader.backend, "claude");
  assert.equal(parsed.value?.members[0].backend, "codex");
  assert.equal(parsed.value?.members[0].model, "gpt-5.1-codex");
});

test("buildTeamFromToolInput 透传 leader/成员 backend", () => {
  const built = buildTeamFromToolInput({
    name: "ext",
    leader: { backend: "claude", prompt: "p" },
    members: [{ name: "c", backend: "codex", model: "gpt-5.1-codex", prompt: "p" }],
    scope: "global",
    filePath: "/x/ext.md",
  });
  assert.ok(built.ok, built.ok ? "" : built.message);
  assert.equal(built.value?.leader.backend, "claude");
  assert.equal(built.value?.members[0].backend, "codex");
  const plain = buildTeamFromToolInput({
    name: "plain",
    leader: { prompt: "p" },
    members: [{ name: "c", prompt: "p" }],
    scope: "global",
    filePath: "/x/plain.md",
  });
  assert.ok(plain.ok);
  assert.equal(plain.value?.leader.backend, undefined);
  assert.equal(plain.value?.members[0].backend, undefined);
});

test("examples/external-cli.example.md 可解析且同时覆盖 codex 与 claude 成员（防腐烂）", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const examplePath = path.join(here, "..", "examples", "external-cli.example.md");
  const parsed = parseTeamFile(fs.readFileSync(examplePath, "utf-8"), { filePath: examplePath, source: "global" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
  const backends = parsed.value?.members.map((m) => m.backend) ?? [];
  assert.ok(backends.includes("codex"), "example must contain at least one codex member");
  assert.ok(backends.includes("claude"), "example must contain at least one claude member");
  assert.ok(parsed.value?.leader.backend === undefined, "leader backend must stay unset in the example (v1 fail-closed)");
});

test("createTeamFile writes the file and refuses overwrites", () => {
  const dir = tmpDir();
  const team = fixtureTeam({ filePath: path.join(dir, "dev-team.md") });
  const created = createTeamFile({ dir, team, notes: "备注" });
  assert.ok(created.ok);
  const content = fs.readFileSync(created.value, "utf-8");
  assert.match(content, /^---\n/);
  assert.match(content, /name: "dev-team"/);
  const again = createTeamFile({ dir, team });
  assert.ok(!again.ok);
  assert.equal(again.code, TeamErrorCodes.TEAM_ALREADY_EXISTS);
});
