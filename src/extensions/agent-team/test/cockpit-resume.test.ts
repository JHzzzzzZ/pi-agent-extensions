/**
 * Cockpit resume integration: a resumed run opens the parent leader session
 * (`--session`, no `--no-session`/`--session-dir`), inherits the parent's
 * shared worktree (with prune-retry restore; hard failure never spawns a
 * fresh tree), reads the parent session header cwd when no worktree exists,
 * injects the member-model alias env, and writes lineage metadata into the
 * status snapshot + terminal record. Fake spawn + fake git against the real
 * runstore/resume logic.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { TeamRunCoordinator, type UiPort } from "../cockpit.ts";
import { buildResumePrompt } from "../resume.ts";
import { writeRunStatus, readRunStatuses, type RunStatusFile } from "../runstore.ts";
import { teamWorktreeBranch } from "../worktree.ts";
import { LEADER_ENV_MEMBER_MODELS, LEADER_ENV_WORKTREE_RUNID } from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, toolExecutionEndLine, toolExecutionStartLine, waitForChild } from "./helpers.ts";

function fakeUi(): UiPort {
  return { notify: () => {}, dim: (text) => text };
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-resume-cockpit-"));
}

function parentStatus(runId: string, overrides: Partial<RunStatusFile> = {}): RunStatusFile {
  return {
    version: 1,
    runId,
    team: "dev-team",
    task: "修复 bug",
    startedAt: "2026-09-11T05:00:00Z",
    status: "failed",
    updatedAt: "2026-09-11T05:30:00Z",
    ...overrides,
  };
}

/** Writes a parent leader session mirror and returns its file path. */
function writeSessionMirror(root: string, parentRunId: string, cwd?: string): string {
  const sessionDir = path.join(root, parentRunId, "session");
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, "20260911_000000_abc.jsonl");
  const header = { type: "session", version: 3, id: "abc", timestamp: "2026-09-11T05:00:00Z", ...(cwd !== undefined ? { cwd } : {}) };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
  return file;
}

function leaderLines(): string[] {
  return [
    messageEndLine("assistant", { content: [{ type: "text", text: "继续干活" }] }),
    toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "接着写" }] }),
    toolExecutionEndLine("team_dispatch", {
      content: [{ type: "text", text: "report" }],
      details: {
        members: [{ name: "frontend", ok: true, status: "done", summary: "继续完成", usage: { input: 1, output: 1, cost: 0.01, turns: 1 } }],
        totalUsage: { input: 1, output: 1, cost: 0.01, turns: 1 },
      },
    }),
    messageEndLine("assistant", { content: [{ type: "text", text: "FINAL" }], usage: { input: 10, output: 5, cost: { total: 0.02 }, totalTokens: 15 } }),
  ];
}

test("resume opens the parent session, applies model overrides and records lineage", async () => {
  const root = tmpRoot();
  const parentRunId = "run-parent";
  writeRunStatus(root, parentStatus(parentRunId));
  const sessionFile = writeSessionMirror(root, parentRunId, "/repo/parent-cwd");

  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot: root,
  });
  const promise = coordinator.start({
    team: fixtureTeam(),
    task: buildResumePrompt(),
    ui: fakeUi(),
    resume: {
      parentRunId,
      parentStatus: parentStatus(parentRunId),
      sessionFile,
      modelOverrides: {
        leaderModel: "opencode-go/deepseek-v4:max",
        memberModels: { frontend: "opencode-go/deepseek-v4-flash" },
      },
    },
  });
  const child = await waitForChild(spawn, 0);
  const record = spawn.records[0];

  // Session continuation: `--session <file>` and neither --no-session nor --session-dir.
  assert.deepEqual(record.args.slice(0, 2), ["--mode", "rpc"]);
  assert.equal(record.args[2], "--session");
  assert.equal(record.args[3], path.resolve(sessionFile));
  assert.ok(!record.args.includes("--no-session"), "no --no-session on a resumed leader");
  assert.ok(!record.args.includes("--session-dir"), "pi derives the dir from --session");
  // Leader model override.
  assert.equal(record.args[record.args.indexOf("--model") + 1], "opencode-go/deepseek-v4:max");
  // Roster prompt uses the effective (overridden) team (the leader's own model
  // is not part of the roster — it travels via --model).
  const promptPath = record.args[record.args.indexOf("--append-system-prompt") + 1];
  const promptContent = fs.readFileSync(promptPath, "utf-8");
  assert.match(promptContent, /model: opencode-go\/deepseek-v4-flash/, "member override lands in the leader roster");
  // Env: fresh runId, parent worktree alias, member model overrides.
  assert.match(record.env?.PI_AGENT_TEAM_RUN_ID ?? "", /^run-\d+$/);
  assert.notEqual(record.env?.PI_AGENT_TEAM_RUN_ID, parentRunId);
  assert.equal(record.env?.PI_AGENT_TEAM_WORKTREE_RUN_ID, parentRunId);
  assert.deepEqual(JSON.parse(record.env?.PI_AGENT_TEAM_MEMBER_MODELS ?? "{}"), {
    frontend: "opencode-go/deepseek-v4-flash",
  });
  // No shared worktree: the leader runs in the parent session's cwd.
  assert.equal(record.cwd, "/repo/parent-cwd");
  // Initial prompt: the resume template.
  assert.deepEqual(JSON.parse(child.writes[0] ?? "{}"), {
    type: "prompt",
    id: "task",
    message: "Task: 继续上次未完成的任务；完成后按团队约定的最终报告格式输出报告。",
  });

  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : result.message);
  const run = result.value!;
  assert.equal(run.status, "completed");
  assert.equal(run.parentRunId, parentRunId);
  assert.equal(run.leaderSessionFile, path.resolve(sessionFile), "resume inherits the opened session file");
  assert.equal(run.leaderDeclaredModel, "opencode-go/deepseek-v4:max");
  assert.equal(run.members[0].model, "opencode-go/deepseek-v4-flash", "record members carry the effective model");
  assert.equal(run.members[0].status, "done");

  const terminal = readRunStatuses(root).entries.find((e) => e.runId === run.runId);
  assert.equal(terminal?.status, "completed");
  assert.equal(terminal?.parentRunId, parentRunId);
  assert.equal(terminal?.leaderSessionFile, path.resolve(sessionFile));
});

test("resume with 补充指示 renders the instruction template", async () => {
  const root = tmpRoot();
  const parentRunId = "run-parent";
  writeRunStatus(root, parentStatus(parentRunId));
  const sessionFile = writeSessionMirror(root, parentRunId);

  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot: root,
  });
  const promise = coordinator.start({
    team: fixtureTeam(),
    task: buildResumePrompt("改用 deepseek 接着干"),
    ui: fakeUi(),
    resume: { parentRunId, parentStatus: parentStatus(parentRunId), sessionFile },
  });
  const child = await waitForChild(spawn, 0);
  assert.deepEqual(JSON.parse(child.writes[0] ?? "{}"), {
    type: "prompt",
    id: "task",
    message: "Task: 继续上次未完成的任务。补充指示：\n改用 deepseek 接着干\n完成后按团队约定的最终报告格式输出报告。",
  });
  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok);
  // No overrides: the env alias still points at the parent run (member worktrees),
  // but no member-model override env is injected.
  assert.equal(spawn.records[0].env?.PI_AGENT_TEAM_WORKTREE_RUN_ID, parentRunId);
  assert.equal(spawn.records[0].env?.PI_AGENT_TEAM_MEMBER_MODELS, undefined);
});

test("resume reuses the parent's recorded shared worktree without creating a new one", async () => {
  const root = tmpRoot();
  const worktreeRoot = tmpRoot();
  const parentRunId = "run-parent";
  const worktree = { path: path.join(worktreeRoot, "run-parent", "team"), branch: teamWorktreeBranch("run-parent") };
  writeRunStatus(root, parentStatus(parentRunId, { worktree }));
  const sessionFile = writeSessionMirror(root, parentRunId, worktree.path);
  fs.mkdirSync(worktree.path, { recursive: true });

  const gitCalls: string[][] = [];
  const fakeGit = async (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
    if (args[0] === "worktree" && args[1] === "list") {
      return { code: 0, stdout: `worktree ${worktree.path}\nbranch refs/heads/${worktree.branch}\n`, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      throw new Error(`unexpected git worktree add: ${args.join(" ")}`);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot,
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot: root,
    gitRunner: fakeGit,
  });
  const promise = coordinator.start({
    team: fixtureTeam({ worktree: true }),
    task: buildResumePrompt(),
    ui: fakeUi(),
    resume: { parentRunId, parentStatus: parentStatus(parentRunId, { worktree }), sessionFile },
  });
  const child = await waitForChild(spawn, 0);

  assert.equal(spawn.records[0].cwd, worktree.path, "leader works in the parent shared worktree");
  assert.ok(!gitCalls.some((c) => c[0] === "worktree" && c[1] === "add"), "registered parent worktree reused, no new tree");
  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.value?.worktree, worktree);
  const terminal = readRunStatuses(root).entries.find((e) => e.runId === result.value!.runId);
  assert.deepEqual(terminal?.worktree, worktree, "terminal snapshot records the reused worktree");
});

test("legacy parent without a recorded worktree: convention path + prune retry restores the tree", async () => {
  const root = tmpRoot();
  const worktreeRoot = tmpRoot();
  const parentRunId = "run-parent";
  writeRunStatus(root, parentStatus(parentRunId)); // no worktree field (pre-v1.17 run)
  const sessionFile = writeSessionMirror(root, parentRunId);
  const expectedPath = path.join(worktreeRoot, parentRunId, "team");
  const expectedBranch = teamWorktreeBranch(parentRunId);

  // First list reports a stale registration (dir missing) → prune → clean add.
  let pruned = false;
  const gitCalls: string[][] = [];
  const fakeGit = async (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
    if (args[0] === "worktree" && args[1] === "list") {
      return pruned
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 0, stdout: `worktree ${expectedPath}\nbranch refs/heads/${expectedBranch}\n`, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "prune") {
      pruned = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot,
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot: root,
    gitRunner: fakeGit,
  });
  const promise = coordinator.start({
    team: fixtureTeam({ worktree: true }),
    task: buildResumePrompt(),
    ui: fakeUi(),
    resume: { parentRunId, parentStatus: parentStatus(parentRunId), sessionFile },
  });
  const child = await waitForChild(spawn, 0);

  const pruneIndex = gitCalls.findIndex((c) => c[0] === "worktree" && c[1] === "prune");
  const addIndex = gitCalls.findIndex((c) => c[0] === "worktree" && c[1] === "add");
  assert.ok(pruneIndex >= 0, "stale registration pruned once");
  assert.ok(addIndex > pruneIndex, "retry after prune created the worktree");
  assert.deepEqual(gitCalls[addIndex], ["worktree", "add", expectedPath, "-b", expectedBranch]);
  assert.equal(spawn.records[0].cwd, expectedPath);

  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.value?.worktree, { path: expectedPath, branch: expectedBranch });
});

test("an unrestorable shared worktree is a hard failure (no silent fresh tree, no spawn)", async () => {
  const root = tmpRoot();
  const worktreeRoot = tmpRoot();
  const parentRunId = "run-parent";
  writeRunStatus(root, parentStatus(parentRunId));
  const sessionFile = writeSessionMirror(root, parentRunId);
  const expectedPath = path.join(worktreeRoot, parentRunId, "team");
  // A plain directory occupies the path: git does not know it as a worktree.
  fs.mkdirSync(expectedPath, { recursive: true });

  const fakeGit = async (args: string[]) => {
    if (args[0] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "" };
    if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot,
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot: root,
    gitRunner: fakeGit,
  });
  const result = await coordinator.start({
    team: fixtureTeam({ worktree: true }),
    task: buildResumePrompt(),
    ui: fakeUi(),
    resume: { parentRunId, parentStatus: parentStatus(parentRunId), sessionFile },
  });

  assert.ok(!result.ok);
  assert.equal(result.code, "WORKTREE_UNAVAILABLE");
  assert.equal(spawn.records.length, 0, "no leader spawned against the wrong directory");
  const terminal = readRunStatuses(root).entries.find((e) => e.runId !== parentRunId);
  assert.equal(terminal?.status, "failed");
});

test("续跑 leader env 继承父进程环境：注入键覆盖父进程残留（展开在前、覆盖在后）", async () => {
  const root = tmpRoot();
  const parentRunId = "run-parent";
  writeRunStatus(root, parentStatus(parentRunId));
  const sessionFile = writeSessionMirror(root, parentRunId);

  const saved = new Map<string, string | undefined>();
  const keys = ["NO_PROXY", LEADER_ENV_WORKTREE_RUNID, LEADER_ENV_MEMBER_MODELS];
  for (const key of keys) saved.set(key, process.env[key]);
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env[LEADER_ENV_WORKTREE_RUNID] = "run-stale-parent";
  process.env[LEADER_ENV_MEMBER_MODELS] = JSON.stringify({ frontend: "stale/model" });
  try {
    const spawn = makeFakeSpawn();
    const coordinator = new TeamRunCoordinator({
      cwd: () => "/repo",
      worktreeRoot: "/tmp/worktrees",
      spawn: spawn.spawn,
      piCommand: "pi",
      transcriptRoot: root,
    });
    const promise = coordinator.start({
      team: fixtureTeam(),
      task: buildResumePrompt(),
      ui: fakeUi(),
      resume: {
        parentRunId,
        parentStatus: parentStatus(parentRunId),
        sessionFile,
        modelOverrides: { memberModels: { frontend: "opencode-go/deepseek-v4-flash" } },
      },
    });
    const child = await waitForChild(spawn, 0);
    const record = spawn.records[0];

    // 继承：代理放行变量随父进程进 leader（F1 修复语义）。
    assert.equal(record.env?.NO_PROXY, "127.0.0.1,localhost");
    // 覆盖：本次续跑注入的别名/成员覆盖必须赢过父进程残留值。
    assert.equal(record.env?.[LEADER_ENV_WORKTREE_RUNID], parentRunId);
    assert.deepEqual(JSON.parse(record.env?.[LEADER_ENV_MEMBER_MODELS] ?? "{}"), {
      frontend: "opencode-go/deepseek-v4-flash",
    });

    child.autoRespond(leaderLines(), 0, 5);
    const result = await promise;
    assert.ok(result.ok, result.ok ? "" : result.message);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
