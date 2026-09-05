/**
 * Leader system prompt + entry mode dispatch tests.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildLeaderSystemPrompt } from "../leader-prompt.ts";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { VALID_TEAM_MD, fixtureTeam } from "./fixtures.ts";

test("leader prompt embeds the user strategy verbatim, then roster and tool rules", () => {
  const team = fixtureTeam({
    members: [
      ...fixtureTeam().members,
      { name: "db", description: "数据库", model: "anthropic/claude-sonnet-4-5", worktree: true, prompt: "你是 DBA。" },
    ],
  });
  const prompt = buildLeaderSystemPrompt(team);

  // User-authored strategy comes first, verbatim.
  assert.ok(prompt.indexOf(team.leader.prompt.trim()) === 0);
  // Roster
  assert.match(prompt, /## 团队成员/);
  assert.match(prompt, /- \*\*frontend\*\* — 前端（model: chatanywhere\/gpt-5\.6；tools: read,edit,bash）/);
  assert.match(prompt, /- \*\*db\*\* — 数据库（model: anthropic\/claude-sonnet-4-5；在独立 git worktree 中工作）/);
  // Team notes are included
  assert.match(prompt, /团队补充说明/);
  assert.ok(prompt.includes(team.notes!.trim()));
  // Dispatch tool contract
  assert.match(prompt, /team_dispatch/);
  assert.match(prompt, /\{ "tasks": \[\{ "agent"/);
  assert.match(prompt, /1~8 个子任务/);
  assert.match(prompt, /自包含/);
  // Final report format
  assert.match(prompt, /## 结论/);
  assert.match(prompt, /## 各成员贡献/);
  assert.match(prompt, /## 风险与后续/);
});

// ---------------------------------------------------------------------------
// Entry mode dispatch (fake ExtensionAPI)
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
}

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, { description: string }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
  const entryRenderers = new Map<string, unknown>();
  return {
    tools,
    commands,
    handlers,
    entryRenderers,
    on(name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerTool(tool: RegisteredTool & Record<string, unknown>) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: { description: string }) {
      commands.set(name, command);
    },
    registerEntryRenderer(type: string, renderer: unknown) {
      entryRenderers.set(type, renderer);
    },
    async fire(name: string, event: unknown, ctx: unknown) {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    },
  };
}

function fakeCtx(cwd: string, trusted = true) {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    ui: {},
    sessionManager: { getEntries: () => [] },
  };
}

function withEnv(file: string | undefined, fn: () => void | Promise<void>): Promise<void> | void {
  const previous = process.env.PI_AGENT_TEAM_FILE;
  if (file === undefined) delete process.env.PI_AGENT_TEAM_FILE;
  else process.env.PI_AGENT_TEAM_FILE = file;
  const done = fn();
  if (done instanceof Promise) {
    return done.finally(() => {
      if (previous === undefined) delete process.env.PI_AGENT_TEAM_FILE;
      else process.env.PI_AGENT_TEAM_FILE = previous;
    });
  }
  if (previous === undefined) delete process.env.PI_AGENT_TEAM_FILE;
  else process.env.PI_AGENT_TEAM_FILE = previous;
}

test("leader mode (env set) registers only the team_dispatch tool", async () => {
  resetDoubleLoadGuardForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-entry-"));
  const teamFile = path.join(dir, "dev-team.md");
  fs.writeFileSync(teamFile, VALID_TEAM_MD);
  await withEnv(teamFile, () => {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    assert.equal(pi.tools.size, 1);
    assert.ok(pi.tools.has("team_dispatch"));
    assert.equal(pi.commands.size, 0);
  });
});

test("leader mode with an unreadable team file still registers a failing tool", async () => {
  resetDoubleLoadGuardForTests();
  await withEnv(path.join(os.tmpdir(), "does-not-exist-team.md"), () => {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    assert.ok(pi.tools.has("team_dispatch"));
  });
});

test("cockpit mode registers tools, commands and the entry renderer", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-cockpit-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const projTeam = fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "proj-team.md"), serializeTeam(projTeam));

  await withEnv(undefined, async () => {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    assert.ok(pi.tools.has("team_create"));
    assert.ok(pi.tools.has("team_list"));
    assert.ok(pi.tools.has("team_models"));
    assert.ok(pi.tools.has("team_run"));
    assert.ok(pi.tools.has("team_status"));
    assert.ok(pi.tools.has("team_transcript"));
    assert.ok(!pi.tools.has("team_dispatch"));
    for (const name of ["team", "team:run", "team:status", "team:stop", "team:view"]) {
      assert.ok(pi.commands.has(name), `command ${name} registered`);
    }
    assert.ok(pi.entryRenderers.has("agent-team-run-v1"));

    // session_start registers dynamic per-team commands (project scope, trusted)
    await pi.fire("session_start", { reason: "startup" }, fakeCtx(projectDir, true));
    assert.ok(pi.commands.has("team:proj-team"), "dynamic /team:<name> registered");
    assert.match(pi.commands.get("team:proj-team")?.description ?? "", /proj-team/);
  });
});

test("double load is a no-op (installed package + -e copy)", () => {
  resetDoubleLoadGuardForTests();
  const pi = fakePi();
  agentTeamExtension(pi as never);
  const toolsAfterFirst = pi.tools.size;
  agentTeamExtension(pi as never);
  assert.equal(pi.tools.size, toolsAfterFirst, "second instance registers nothing");
  assert.equal(pi.commands.size, 5);
  resetDoubleLoadGuardForTests();
});
