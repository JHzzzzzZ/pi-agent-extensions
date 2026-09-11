/**
 * Leader-mode model overrides: the resume env vars reach the dispatch
 * executor inside the leader child — `PI_AGENT_TEAM_MEMBER_MODELS` replaces
 * member models for this run (unknown members ignored), bad JSON is a no-op
 * (declared models keep working), and `PI_AGENT_TEAM_WORKTREE_RUNID` is
 * available for member worktree aliasing. Drives the real entry in leader
 * mode with a fake spawn (no real child processes).
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, waitForChild, type FakeSpawnHandle } from "./helpers.ts";

const LEADER_ENVS = [
  "PI_AGENT_TEAM_FILE",
  "PI_AGENT_TEAM_NAME",
  "PI_AGENT_TEAM_RUN_ID",
  "PI_AGENT_TEAM_WORKTREE_RUN_ID",
  "PI_AGENT_TEAM_MEMBER_MODELS",
] as const;

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of LEADER_ENVS) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of LEADER_ENVS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function fakePi() {
  const tools = new Map<string, Record<string, unknown>>();
  return {
    tools,
    on() {},
    registerTool(tool: Record<string, unknown> & { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry() {
      return {};
    },
    sendMessage() {
      return {};
    },
  };
}

type DispatchTool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: undefined,
    onUpdate?: undefined,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
};

async function setupLeader(envOverrides: Record<string, string | undefined>): Promise<{
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  cleanup: () => void;
}> {
  resetDoubleLoadGuardForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-leader-overrides-"));
  const teamFile = path.join(dir, "dev-team.md");
  fs.writeFileSync(teamFile, serializeTeam(fixtureTeam({ filePath: "", notes: undefined })));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  await withEnv(
    {
      PI_AGENT_TEAM_FILE: teamFile,
      PI_AGENT_TEAM_NAME: "dev-team",
      PI_AGENT_TEAM_RUN_ID: "run-child",
      ...envOverrides,
    },
    async () => {
      agentTeamExtension(pi as never, { spawn: spawn.spawn });
    },
  );
  return { pi, spawn, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function dispatchFrontend(pi: ReturnType<typeof fakePi>, spawn: FakeSpawnHandle): Promise<string> {
  const tool = pi.tools.get("team_dispatch") as unknown as DispatchTool;
  const promise = tool.execute("call-1", { tasks: [{ agent: "frontend", task: "接着写" }] });
  const child = await waitForChild(spawn, 0);
  const modelIndex = spawn.records[0].args.indexOf("--model");
  const model = modelIndex >= 0 ? spawn.records[0].args[modelIndex + 1] : undefined;
  child.autoRespond([messageEndLine("assistant", { content: [{ type: "text", text: "完成" }] })]);
  const result = await promise;
  assert.notEqual(result.isError, true);
  return model as string;
}

test("leader mode applies PI_AGENT_TEAM_MEMBER_MODELS to the dispatched member model", async () => {
  const { pi, spawn, cleanup } = await setupLeader({
    PI_AGENT_TEAM_MEMBER_MODELS: JSON.stringify({ frontend: "opencode-go/deepseek-v4-flash:xhigh" }),
    PI_AGENT_TEAM_WORKTREE_RUN_ID: "run-parent",
  });
  try {
    const model = await dispatchFrontend(pi, spawn);
    assert.equal(model, "opencode-go/deepseek-v4-flash:xhigh", "member runs on the override model");
  } finally {
    cleanup();
  }
});

test("leader mode ignores bad/unknown member-model env without crashing (declared model wins)", async () => {
  const { pi, spawn, cleanup } = await setupLeader({
    PI_AGENT_TEAM_MEMBER_MODELS: '{"ghost":"opencode-go/deepseek-v4",',
  });
  try {
    const model = await dispatchFrontend(pi, spawn);
    assert.equal(model, "chatanywhere/gpt-5.6", "bad JSON: declared model unchanged");
  } finally {
    cleanup();
  }

  const second = await setupLeader({ PI_AGENT_TEAM_MEMBER_MODELS: JSON.stringify({ ghost: "opencode-go/deepseek-v4" }) });
  try {
    const model = await dispatchFrontend(second.pi, second.spawn);
    assert.equal(model, "chatanywhere/gpt-5.6", "unknown member override ignored");
  } finally {
    second.cleanup();
  }
});
