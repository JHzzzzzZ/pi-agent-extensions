/**
 * team_create / team_list tool tests (host-free via a fake ExtensionAPI +
 * fake ExtensionContext).
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { registerManageTools } from "../manage.ts";
import type { ToolResult } from "./tool-types.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-manage-"));
}

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
}

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
  };
}

function fakeCtx(cwd: string, trusted = true) {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    ui: {},
  };
}

const CREATE_PARAMS = {
  name: "dev-team",
  description: "全栈开发小队",
  leader: { model: "anthropic/claude-opus-4-5", prompt: "你是技术负责人。" },
  members: [
    { name: "frontend", model: "chatanywhere/gpt-5.6", prompt: "你是前端工程师。", tools: ["read", "edit"] },
    { name: "backend", model: "anthropic/claude-sonnet-4-5", prompt: "你是后端工程师。", worktree: true },
  ],
};

test("team_create writes a valid team file and returns a reuse summary", async () => {
  const globalDir = tmpDir();
  const pi = fakePi();
  registerManageTools(pi as never, { globalDir });
  const tool = pi.tools.get("team_create");
  assert.ok(tool);

  const result = await tool.execute("id", CREATE_PARAMS, undefined, undefined, fakeCtx("/repo"));
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /\*\*dev-team\*\*/);
  assert.match(result.content[0].text, /team:run dev-team/);
  const filePath = path.join(globalDir, "dev-team.md");
  assert.equal(fs.existsSync(filePath), true);
  const content = fs.readFileSync(filePath, "utf-8");
  assert.match(content, /name: "dev-team"/);
  assert.match(content, /worktree: true/);
  assert.match(content, /你是后端工程师。/);
});

test("team_create rejects duplicates and invalid definitions", async () => {
  const globalDir = tmpDir();
  const pi = fakePi();
  registerManageTools(pi as never, { globalDir });
  const tool = pi.tools.get("team_create");
  assert.ok(tool);
  const ctx = fakeCtx("/repo");
  const first = await tool.execute("id", CREATE_PARAMS, undefined, undefined, ctx);
  assert.equal(first.isError, undefined);
  const duplicate = await tool.execute("id", CREATE_PARAMS, undefined, undefined, ctx);
  assert.equal(duplicate.isError, true);

  const invalid = await tool.execute(
    "id",
    { ...CREATE_PARAMS, name: "bad team", members: [] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /无效|invalid|members/i);
});

test("team_create project scope requires project trust", async () => {
  const globalDir = tmpDir();
  const projectDir = tmpDir();
  const pi = fakePi();
  registerManageTools(pi as never, { globalDir });
  const tool = pi.tools.get("team_create");
  assert.ok(tool);
  const untrusted = await tool.execute(
    "id",
    { ...CREATE_PARAMS, scope: "project" },
    undefined,
    undefined,
    fakeCtx(projectDir, false),
  );
  assert.equal(untrusted.isError, true);
  assert.match(untrusted.content[0].text, /信任/);

  const trusted = await tool.execute(
    "id",
    { ...CREATE_PARAMS, name: "proj-team", scope: "project" },
    undefined,
    undefined,
    fakeCtx(projectDir, true),
  );
  assert.equal(trusted.isError, undefined);
  assert.equal(fs.existsSync(path.join(projectDir, ".pi", "teams", "proj-team.md")), true);
});

test("team_list lists discovered teams and flags invalid files", async () => {
  const globalDir = tmpDir();
  const pi = fakePi();
  registerManageTools(pi as never, { globalDir });
  const create = pi.tools.get("team_create");
  const list = pi.tools.get("team_list");
  assert.ok(create && list);
  const ctx = fakeCtx("/repo");
  await create.execute("id", CREATE_PARAMS, undefined, undefined, ctx);
  fs.writeFileSync(path.join(globalDir, "broken.md"), "not a team");

  const result = await list.execute("id", {}, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /dev-team/);
  assert.match(result.content[0].text, /frontend/);
  assert.match(result.content[0].text, /chatanywhere\/gpt-5\.6/);
  assert.match(result.content[0].text, /broken\.md/);
});

test("team_list explains how to create a team when none exist", async () => {
  const globalDir = tmpDir();
  const pi = fakePi();
  registerManageTools(pi as never, { globalDir });
  const list = pi.tools.get("team_list");
  assert.ok(list);
  const result = await list.execute("id", {}, undefined, undefined, fakeCtx("/repo"));
  assert.match(result.content[0].text, /team_create/);
});
