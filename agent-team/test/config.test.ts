/**
 * Team definition file tests: parse + validate + serialize roundtrip +
 * discovery precedence + file creation rules.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createTeamFile,
  discoverTeams,
  findNearestProjectTeamsDir,
  parseTeamFile,
  serializeTeam,
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
