/**
 * Cockpit coordinator tests: leader spawn args + env, progress tracking
 * (leader activity + member latest), team shared worktree + pre-flight,
 * status snapshots, RUN_IN_PROGRESS, stop/abort.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { failedRunRecord, formatStatusSnapshot, TeamRunCoordinator, type UiPort } from "../cockpit.ts";
import {
  DERIVED_AGENT_TOOL_DENYLIST,
  LEADER_ENV_FILE,
  LEADER_ENV_NAME,
  LEADER_ENV_RUNID,
  type RunProgress,
} from "../types.ts";
import { visibleWidth } from "../viewer.ts";
import { teamWorktreeBranch } from "../worktree.ts";
import { fixtureTeam } from "./fixtures.ts";
import {
  makeFakeSpawn,
  messageEndLine,
  toolExecutionEndLine,
  toolExecutionStartLine,
  toolExecutionUpdateLine,
  waitForChild,
} from "./helpers.ts";

function fakeUi(): UiPort {
  return {
    notify: () => {},
    dim: (text) => text,
  };
}

function dispatchDetails(members: Array<Record<string, unknown>>): string {
  return toolExecutionEndLine("team_dispatch", {
    content: [{ type: "text", text: "report" }],
    details: { members, totalUsage: { input: 1, output: 1, cost: 0.02, turns: 2 } },
  });
}

function leaderLines(): string[] {
  return [
    messageEndLine("assistant", {
      content: [{ type: "text", text: "让我先把任务拆解成两个子任务" }],
      usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15 },
    }),
    toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }),
    dispatchDetails([
      { name: "frontend", ok: true, status: "done", summary: "前端做完", latest: "前端完成", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } },
      { name: "backend", ok: true, status: "done", summary: "后端做完", usage: { input: 20, output: 8, cost: 0.02, turns: 2 }, worktree: { path: "/wt/backend", branch: "team/r/backend" } },
    ]),
    messageEndLine("assistant", {
      content: [{ type: "text", text: "FINAL REPORT" }],
      usage: { input: 50, output: 20, cost: { total: 0.05 }, totalTokens: 300 },
      model: "claude-opus-4-5",
    }),
  ];
}

test("coordinator spawns the leader with prompt/env/-e and folds member results into the record", async () => {
  const spawn = makeFakeSpawn();
  const ui = fakeUi();
  const progressUpdates: string[] = [];
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    extensionEntryPath: "/ext/agent-team/index.ts",
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot: "/tmp/runs",
  });
  const promise = coordinator.start({
    team: fixtureTeam(),
    task: "修复登录 bug",
    ui,
    onProgress: (progress) => progressUpdates.push(progress.team),
  });
  const child = await waitForChild(spawn, 0);
  const record = spawn.records[0];

  assert.deepEqual(record.args.slice(0, 2), ["--mode", "rpc"]);
  // 首跑：leader 会话落盘到本 run 的产物目录（不再 --no-session）
  assert.equal(record.args[2], "--session-dir");
  assert.equal(record.args[3], path.join("/tmp/runs", record.env?.PI_AGENT_TEAM_RUN_ID ?? "", "session"));
  assert.ok(!record.args.includes("--no-session"), "leader session is persisted");
  assert.equal(record.stdin, "pipe", "RPC leader keeps a live stdin channel");
  assert.equal(record.args[record.args.indexOf("--model") + 1], "anthropic/claude-opus-4-5");
  const extIndex = record.args.indexOf("-e");
  assert.equal(record.args[extIndex + 1], "/ext/agent-team/index.ts");
  // The leader may not start nested teams/subagents either: the same
  // single-source denylist travels as --exclude-tools (host: exclude wins
  // over --tools allowlists).
  const denyIndex = record.args.indexOf("--exclude-tools");
  assert.ok(denyIndex >= 0, "leader argv carries --exclude-tools");
  assert.equal(record.args[denyIndex + 1], DERIVED_AGENT_TOOL_DENYLIST.join(","));
  assert.ok(denyIndex < record.args.indexOf("--append-system-prompt"));
  const promptIndex = record.args.indexOf("--append-system-prompt");
  const promptPath = record.args[promptIndex + 1];
  assert.ok(!promptPath.startsWith("team-tmp://"), "prompt materialized to a temp file before spawn");
  const promptContent = fs.readFileSync(promptPath, "utf-8");
  assert.match(promptContent, /team_dispatch/);
  assert.match(promptContent, /frontend/);
  assert.match(promptContent, /你是技术负责人/);
  // RPC 模式：task 走 stdin 的初始 prompt 命令（不再作 argv 尾参）
  assert.ok(!record.args.some((arg) => arg.startsWith("Task: ")), "task not in argv");
  assert.deepEqual(JSON.parse(child.writes[0] ?? "{}"), {
    type: "prompt",
    id: "task",
    message: "Task: 修复登录 bug",
  });
  assert.equal(record.env?.PI_AGENT_TEAM_FILE, fixtureTeam().filePath);
  assert.equal(record.env?.PI_AGENT_TEAM_NAME, "dev-team");
  assert.match(record.env?.PI_AGENT_TEAM_RUN_ID ?? "", /^run-\d+$/);
  assert.equal(record.cwd, "/repo");

  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.equal(fs.existsSync(promptPath), false, "temp prompt removed after exit");
  const run = result.value!;
  assert.equal(run.status, "completed");
  assert.equal(run.report, "FINAL REPORT");
  assert.equal(run.team, "dev-team");
  assert.equal(run.durationMs !== undefined, true);
  assert.ok(Math.abs(run.totalCost - 0.051) < 1e-9);
  assert.equal(run.leaderUsage?.model, "claude-opus-4-5");
  assert.equal(run.members.length, 2);
  assert.equal(run.members[0].name, "frontend");
  assert.equal(run.members[0].model, "chatanywhere/gpt-5.6");
  assert.equal(run.members[0].summary, "前端做完");
  assert.equal(run.members[1].worktree?.branch, "team/r/backend");
  assert.equal(run.members[1].model, "anthropic/claude-sonnet-4-5");
  assert.ok(progressUpdates.length > 0, "onProgress fired");
  assert.equal(coordinator.isRunning(), false);
  // Status snapshot: run over, last record available.
  const status = coordinator.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.lastRecord?.runId, run.runId);
});

test("leader env 继承父进程环境并覆盖 run 级三键（NO_PROXY/PI_CODING_AGENT_DIR 透传）", async () => {
  const envBackup = { ...process.env };
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const pathPrefix = `fast-dev-inherit${path.delimiter}`;
  try {
    process.env.FAST_DEV_INHERIT_MARKER = "inherited-from-parent";
    process.env[pathKey] = `${pathPrefix}${process.env[pathKey] ?? ""}`;
    // F1：宿主 applyHttpProxySettings 注入的代理环境必须透传到 leader（再由 leader
    // 经 stripLeaderEnv 传给外部成员），NO_PROXY 放行本地 BASE_URL。
    process.env.NO_PROXY = "127.0.0.1,localhost";
    process.env.PI_CODING_AGENT_DIR = "/tmp/parent-agent-dir";
    // 父进程残留的 leader 键必须被本次 run 的三键覆盖（继承展开在前、覆盖在后）。
    process.env[LEADER_ENV_FILE] = "/stale/team.md";
    process.env[LEADER_ENV_NAME] = "stale-team";
    process.env[LEADER_ENV_RUNID] = "run-stale";
    const spawn = makeFakeSpawn();
    const coordinator = new TeamRunCoordinator({
      cwd: () => "/repo",
      worktreeRoot: "/tmp/worktrees",
      spawn: spawn.spawn,
      piCommand: "pi",
    });
    const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
    const child = await waitForChild(spawn, 0);
    const env = spawn.records[0].env;
    assert.equal(env?.FAST_DEV_INHERIT_MARKER, "inherited-from-parent", "父进程标记键必须被 leader 继承");
    assert.ok((env?.[pathKey] ?? "").startsWith(pathPrefix), "父进程 PATH 必须被继承（前缀保留）");
    assert.equal(env?.NO_PROXY, "127.0.0.1,localhost", "NO_PROXY 必须透传到 leader");
    assert.equal(env?.PI_CODING_AGENT_DIR, "/tmp/parent-agent-dir", "PI_CODING_AGENT_DIR 必须透传到 leader");
    // 本次 run 的三个键仍叠加在继承环境之上（覆盖父进程残留值）。
    assert.equal(env?.PI_AGENT_TEAM_FILE, fixtureTeam().filePath);
    assert.equal(env?.PI_AGENT_TEAM_NAME, "dev-team");
    assert.match(env?.PI_AGENT_TEAM_RUN_ID ?? "", /^run-\d+$/);
    child.autoRespond(leaderLines(), 0, 5);
    const result = await promise;
    assert.ok(result.ok, result.ok ? "" : result.message);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, envBackup);
  }
});

test("RPC steer：run 运行中插话写入 stdin，agent_settled 后关闭 stdin（进程退出门）", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "数数", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";

  assert.equal(coordinator.steerLeader(runId, "插话一"), true);
  assert.equal(coordinator.steerLeader(runId, "插话二"), true);
  assert.deepEqual(
    child.writes.slice(1).map((line) => JSON.parse(line)),
    [
      { type: "steer", message: "插话一" },
      { type: "steer", message: "插话二" },
    ],
  );

  // agent_settled = 本轮任务结束 → 关 stdin，RPC 进程才能退出
  child.emitLine(JSON.stringify({ type: "agent_settled" }));
  assert.equal(child.ended, true, "settle 后关闭 stdin");
  assert.equal(coordinator.steerLeader(runId, "太晚了"), false, "关闭后不再接受插话");

  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value!.status, "completed");
});

test("prompt 被 pi 拒绝：记错误 + 关 stdin，run 以 failed 落定而不是挂起", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "x", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);

  child.emitLine(
    JSON.stringify({ type: "response", id: "task", command: "prompt", success: false, error: "Unknown model: a/b" }),
  );
  assert.equal(child.ended, true, "prompt 失败无 settle 事件，必须主动关 stdin");
  child.emitClose(0);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value!.status, "failed");
  assert.match(result.value!.error ?? "", /Unknown model: a\/b/);
});

test("team-level shared worktree: leader runs inside it and the record carries it", async () => {
  const gitCalls: Array<{ args: string[] }> = [];
  const fakeGit = async (args: string[]) => {
    gitCalls.push({ args });
    return { code: 0, stdout: args[0] === "rev-parse" ? "true\n" : "", stderr: "" };
  };
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    gitRunner: fakeGit,
  });
  const team = fixtureTeam({ worktree: true });
  const promise = coordinator.start({ team, task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);

  const add = gitCalls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
  assert.ok(add, "shared worktree created");
  const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
  assert.deepEqual(add.args.slice(0, 3), ["worktree", "add", path.join("/tmp/worktrees", runId, "team")]);
  assert.equal(add.args[3], "-b");
  assert.equal(add.args[4], teamWorktreeBranch(runId));
  assert.equal(spawn.records[0].cwd, path.join("/tmp/worktrees", runId, "team"));

  child.autoRespond(leaderLines(), 0, 5);
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.value?.worktree, {
    path: path.join("/tmp/worktrees", runId, "team"),
    branch: teamWorktreeBranch(runId),
  });
});

test("pre-flight: worktree members without a git repo fail fast without spawning", async () => {
  const fakeGit = async (args: string[]) =>
    args[0] === "rev-parse" ? { code: 1, stdout: "false\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/not-a-repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    gitRunner: fakeGit,
  });
  const team = fixtureTeam({
    members: [{ name: "backend", worktree: true, prompt: "p" }],
  });
  const result = await coordinator.start({ team, task: "t", ui: fakeUi() });
  assert.ok(!result.ok);
  assert.equal(result.code, "WORKTREE_UNAVAILABLE");
  assert.match(result.message, /预检失败/);
  assert.equal(spawn.records.length, 0, "no leader spawned");
  assert.equal(result.record?.status, "failed", "launch-level failure carries a minimal record");
  assert.deepEqual(result.record?.members, []);
  assert.match(result.record?.error ?? "", /预检失败/);
  assert.equal(coordinator.getStatus().lastRecord?.status, "failed", "failed record visible to /team:status");
});

test("failedRunRecord builds the minimal failed record shape", () => {
  const record = failedRunRecord({
    runId: "run-7",
    team: "dev-team",
    task: "修复登录 bug",
    startedAt: "2026-09-05T12:00:00Z",
    error: "CHILD_FAILED: boom",
    durationMs: 1234,
  });
  assert.equal(record.status, "failed");
  assert.equal(record.runId, "run-7");
  assert.equal(record.error, "CHILD_FAILED: boom");
  assert.deepEqual(record.members, []);
  assert.equal(record.totalCost, 0);
  assert.equal(record.totalTokens, 0);
  assert.equal(record.durationMs, 1234);
  assert.equal(record.report, undefined);

  const noDuration = failedRunRecord({ runId: "run-8", team: "t", task: "x", startedAt: "2026-09-05T12:00:00Z", error: "e" });
  assert.equal(noDuration.durationMs, undefined);
});

test("formatStatusSnapshot 标注续跑来源并在可续 run 上提示 team_resume", () => {
  const running = formatStatusSnapshot(
    {
      running: true,
      actives: [],
      records: [],
      progress: { runId: "run-new", parentRunId: "run-old", team: "dev-team", task: "继续", startedAtMs: 0, members: [] },
      lastRecord: null,
    },
    0,
  );
  assert.match(running, /runId: run-new（续跑自 run-old）/);

  const failed = formatStatusSnapshot(
    {
      running: false,
      actives: [],
      records: [],
      progress: null,
      lastRecord: {
        runId: "run-old",
        team: "dev-team",
        task: "修复 bug",
        startedAt: "2026-09-05T12:00:00Z",
        status: "failed",
        error: "配额耗尽",
        leaderSessionFile: "/runs/run-old/session/a.jsonl",
        members: [],
        totalCost: 0,
        totalTokens: 0,
      },
    },
    0,
  );
  assert.match(failed, /runId: run-old\n/);
  assert.match(failed, /可用 team_resume run-old 续跑（可换模型）/);

  // completed runs have nothing to resume: no hint line.
  const completed = formatStatusSnapshot(
    {
      running: false,
      actives: [],
      records: [],
      progress: null,
      lastRecord: {
        runId: "run-done",
        team: "dev-team",
        task: "t",
        startedAt: "2026-09-05T12:00:00Z",
        status: "completed",
        leaderSessionFile: "/runs/run-done/session/a.jsonl",
        members: [],
        totalCost: 0,
        totalTokens: 0,
      },
    },
    0,
  );
  assert.doesNotMatch(completed, /team_resume/);
});

test("formatStatusSnapshot renders a running snapshot and the last record", () => {
  const running = formatStatusSnapshot(
    {
      running: true,
      actives: [],
      records: [],
      progress: {
        runId: "r",
        team: "dev-team",
        task: "修复 bug",
        startedAtMs: 0,
        // 模型口径（v1.15.4）：声明 provider 前缀 + 子进程实际上报 id。
        leaderDeclaredModel: "opencode-go/deepseek-flash",
        leaderModel: "deepseek-v3",
        leaderNote: "turn 3",
        leaderActivity: "正在汇总报告",
        members: [{ name: "frontend", status: "running", note: "turn 2", latest: "在写样式" }],
      },
      lastRecord: null,
    },
    5000,
  );
  assert.match(running, /当前 run：team dev-team ▶ running · 5s/);
  assert.match(running, /runId: r/);
  assert.match(running, /leader: opencode-go\/deepseek-v3 · turn 3/);
  assert.match(running, /↳ 正在汇总报告/);
  assert.match(running, /▶ frontend running — turn 2 — 在写样式/);

  const done = formatStatusSnapshot(
    {
      running: false,
      actives: [],
      records: [],
      progress: null,
      lastRecord: {
        runId: "run-1",
        team: "dev-team",
        task: "修复 bug",
        startedAt: "2026-09-05T12:00:00Z",
        status: "completed",
        report: "done",
        members: [
          {
            name: "frontend",
            model: "chatanywhere/gpt-5.6",
            status: "done",
            summary: "做完了",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1, model: "gpt-5.7" },
          },
          { name: "db", model: "opencode-go/deepseek-flash", status: "done", summary: "无实际上报" },
        ],
        totalCost: 0.05,
        totalTokens: 100,
        durationMs: 12000,
        worktree: { path: "/wt/team", branch: "team/run-1" },
      },
    },
    0,
  );
  assert.match(done, /最近一次 run：team dev-team ✓ completed · 12s · \$0\.0500/);
  assert.match(done, /runId: run-1/);
  assert.match(done, /✓ frontend done — chatanywhere\/gpt-5\.7/, "record member: declared prefix + actual id segment");
  assert.match(done, /✓ db done — opencode-go\/deepseek-flash/, "record member: no actual report → declared as-is");
  assert.match(done, /共享 worktree: `\/wt\/team`/);

  const empty = formatStatusSnapshot({ running: false, progress: null, lastRecord: null, actives: [], records: [] }, 0);
  assert.match(empty, /没有 team run 记录/);
});

test("formatStatusSnapshot 任务行压平多行任务（运行态与终态同口径，不产生残行）", () => {
  const multiLine = "目标：修复登录页\n  第二步：回归测试\n\t第三步：交付";
  const flattened = "目标：修复登录页 第二步：回归测试 第三步：交付";
  const running = formatStatusSnapshot(
    {
      running: true,
      actives: [],
      records: [],
      progress: { runId: "r", team: "dev-team", task: multiLine, startedAtMs: 0, members: [] },
      lastRecord: null,
    },
    0,
  );
  const done = formatStatusSnapshot(
    {
      running: false,
      actives: [],
      records: [],
      progress: null,
      lastRecord: {
        runId: "run-1",
        team: "dev-team",
        task: multiLine,
        startedAt: "2026-09-05T12:00:00Z",
        status: "completed",
        members: [],
        totalCost: 0,
        totalTokens: 0,
      },
    },
    0,
  );
  for (const [label, output] of [["运行态", running], ["终态", done]] as const) {
    const lines = output.split("\n");
    const taskLine = lines.find((line) => line.startsWith("任务: "));
    assert.equal(taskLine, `任务: ${flattened}`, `${label}：任务残片必须压平成单行并以单空格相连`);
    assert.ok(
      !lines.some((line) => line.trim() === "第二步：回归测试" || line.trim() === "第三步：交付"),
      `${label}：任务子行不得再作为独立物理行出现`,
    );
  }
});

test("formatStatusSnapshot 任务行按显示宽度截断（上限 60 列、CJK 双宽，运行态与终态同口径）", () => {
  const longTask = "分析".repeat(50) + "abc".repeat(50);
  const running = formatStatusSnapshot(
    {
      running: true,
      actives: [],
      records: [],
      progress: { runId: "r", team: "dev-team", task: longTask, startedAtMs: 0, members: [] },
      lastRecord: null,
    },
    0,
  );
  const done = formatStatusSnapshot(
    {
      running: false,
      actives: [],
      records: [],
      progress: null,
      lastRecord: {
        runId: "run-1",
        team: "dev-team",
        task: longTask,
        startedAt: "2026-09-05T12:00:00Z",
        status: "completed",
        members: [],
        totalCost: 0,
        totalTokens: 0,
      },
    },
    0,
  );
  for (const [label, output] of [["运行态", running], ["终态", done]] as const) {
    const taskLine = output.split("\n").find((line) => line.startsWith("任务: "));
    assert.ok(taskLine, `${label}：必须输出任务行`);
    const taskText = taskLine.slice("任务: ".length);
    assert.ok(visibleWidth(taskText) <= 60, `${label}：任务文本 ≤ 60 显示列（实际 ${visibleWidth(taskText)}）`);
    assert.ok(taskText.endsWith("…"), `${label}：超宽任务以 … 结尾`);
    assert.ok(visibleWidth(taskLine) <= 66, `${label}：任务行 ≤ 66 显示列（实际 ${visibleWidth(taskLine)}）`);
  }
});

test("restoreRecord keeps the newest records, dedupes by runId and caps at five", () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const older = { runId: "run-1", team: "t", task: "x", startedAt: "2026-09-05T10:00:00Z", status: "completed" } as never;
  const newer = { runId: "run-2", team: "t", task: "y", startedAt: "2026-09-05T11:00:00Z", status: "failed" } as never;
  coordinator.restoreRecord(older);
  coordinator.restoreRecord(newer);
  assert.equal(coordinator.getStatus().lastRecord?.runId, "run-2");

  // Same runId re-hydrated: the fresh record replaces the old one (no duplicate).
  const refreshing = { runId: "run-2", team: "t", task: "y2", startedAt: "2026-09-05T11:30:00Z", status: "completed" } as never;
  coordinator.restoreRecord(refreshing);
  const deduped = coordinator.getStatus();
  assert.equal(deduped.records.length, 2);
  assert.equal(deduped.records[0]?.task, "y2");

  // Insertion order does not matter: startedAt decides, oldest fall out at cap 5.
  for (let i = 3; i <= 8; i++) {
    coordinator.restoreRecord({ runId: `run-${i}`, team: "t", task: `t${i}`, startedAt: `2026-09-06T00:00:0${i}Z`, status: "completed" } as never);
  }
  const grown = coordinator.getStatus();
  assert.equal(grown.records.length, 5);
  assert.deepEqual(grown.records.map((r) => r.runId), ["run-8", "run-7", "run-6", "run-5", "run-4"]);
});

test("the concurrency cap rejects the next start with RUN_IN_PROGRESS listing active runIds", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promises = [0, 1, 2].map((i) => coordinator.start({ team: fixtureTeam(), task: `t${i}`, ui: fakeUi() }));
  await waitForChild(spawn, 0);
  await waitForChild(spawn, 1);
  await waitForChild(spawn, 2);
  const activeIds = coordinator.activeRunIds();
  assert.equal(activeIds.length, 3, "three parallel runs claimed");

  const rejected = await coordinator.start({ team: fixtureTeam(), task: "t3", ui: fakeUi() });
  assert.ok(!rejected.ok);
  assert.equal(rejected.code, "RUN_IN_PROGRESS");
  assert.match(rejected.message, /已达上限（3）/);
  for (const id of activeIds) assert.ok(rejected.message.includes(id), `message lists ${id}`);
  assert.equal(spawn.records.length, 3, "no fourth leader spawned");

  for (const child of spawn.children) child.autoRespond(leaderLines());
  const results = await Promise.all(promises);
  for (const result of results) assert.ok(result.ok);
});

test("stop() aborts the run and the record is marked aborted", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    killGraceMs: 10,
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
  assert.equal(coordinator.stop(), 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(child.killed.includes("SIGTERM"));
  child.emitClose(null);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "aborted");
  assert.equal(coordinator.stop(), 0);
  assert.equal(coordinator.isRunActive(runId), false, "settled run released its handle");
});

test("stopAndSettle aborts the active run and returns the terminal aborted record", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
  const settle = coordinator.stopAndSettle(runId);
  assert.ok(child.killed.includes("SIGTERM"), "abort sent synchronously");
  child.emitClose(null);
  const outcome = await settle;
  assert.equal(outcome.wasRunning, true);
  assert.equal(outcome.settled, true);
  assert.equal(outcome.record?.status, "aborted");
  assert.equal(outcome.record?.runId, spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID);
  // Stale progress cleared: status lands on the terminal record, not a phantom "running".
  const status = coordinator.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.progress, null);
  assert.equal(status.lastRecord?.status, "aborted");
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "aborted");
  // Settle removed the RUN_IN_PROGRESS residue: an immediate restart works.
  const second = coordinator.start({ team: fixtureTeam(), task: "t2", ui: fakeUi() });
  const child2 = await waitForChild(spawn, 1);
  assert.equal(spawn.records.length, 2, "second leader spawned right after settle");
  child2.autoRespond(leaderLines());
  const secondResult = await second;
  assert.ok(secondResult.ok);
  assert.equal(secondResult.value?.status, "completed");
});

test("stopAndSettle with no active run reports wasRunning:false", async () => {
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    piCommand: "pi",
  });
  const outcome = await coordinator.stopAndSettle("run-none");
  assert.deepEqual(outcome, { wasRunning: false, settled: true, record: null });
});

test("stopAndSettle times out while children are still shutting down (settled:false, not an error)", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
  const outcome = await coordinator.stopAndSettle(runId, 30);
  assert.equal(outcome.wasRunning, true);
  assert.equal(outcome.settled, false);
  assert.equal(outcome.record, null);
  assert.ok(child.killed.includes("SIGTERM"), "abort still sent before the timeout");
  // Once the child finally closes, the run settles into the terminal record.
  child.emitClose(null);
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "aborted");
  assert.equal(coordinator.getStatus().progress, null);
});

test("aborted runs fold the full roster into the record: queued/running members become aborted", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const team = fixtureTeam({
    members: [
      ...fixtureTeam().members,
      { name: "db", model: "anthropic/claude-sonnet-4-5", prompt: "你是 DBA。" },
    ],
  });
  const promise = coordinator.start({ team, task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  // Partial progress: one member dispatched and finished; the other two never started.
  child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "拆解任务" }] }));
  child.emitLine(toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }] }));
  child.emitLine(
    dispatchDetails([
      { name: "frontend", ok: true, status: "done", summary: "前端做完", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } },
    ]),
  );
  void coordinator.stopAndSettle(
    spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "",
  );
  child.emitClose(null);
  const result = await promise;
  assert.ok(result.ok);
  const record = result.value!;
  assert.equal(record.status, "aborted");
  assert.equal(record.members.length, 3, "every roster member present in the record");
  const byName = new Map(record.members.map((m) => [m.name, m]));
  assert.equal(byName.get("frontend")?.status, "done");
  assert.equal(byName.get("backend")?.status, "aborted");
  assert.equal(byName.get("backend")?.model, "anthropic/claude-sonnet-4-5");
  assert.equal(byName.get("db")?.status, "aborted");
  assert.equal(byName.get("db")?.model, "anthropic/claude-sonnet-4-5");
});

/**
 * Roster-fold regression (see cockpit.ts start() aborted path): a run that
 * is aborted after its dispatch results have been parsed must not lose the
 * members that never finished a dispatch. Those appear as "aborted".
 */
test("aborted roster fold leaves completed members untouched", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const team = fixtureTeam();
  const promise = coordinator.start({ team, task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.emitLine(toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }));
  child.emitLine(
    dispatchDetails([
      { name: "frontend", ok: true, status: "done", summary: "s", usage: { input: 1, output: 1, cost: 0, turns: 1 } },
      { name: "backend", ok: false, status: "failed", summary: "f", usage: { input: 1, output: 1, cost: 0, turns: 1 } },
    ]),
  );
  void coordinator.stopAndSettle(
    spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "",
  );
  child.emitClose(null);
  const result = await promise;
  assert.ok(result.ok);
  const record = result.value!;
  assert.equal(record.status, "aborted");
  assert.equal(record.members.length, 2, "completed dispatch statuses survive the fold");
  assert.equal(record.members.find((m) => m.name === "frontend")?.status, "done");
  assert.equal(record.members.find((m) => m.name === "backend")?.status, "failed");
});

// ---------------------------------------------------------------------------
// stopAndSettle helpers are kept private; the coordinator's own promise is
// the only settle boundary (bounded wait, never throws).
// ---------------------------------------------------------------------------

test("leader child failure marks the run failed with the error detail", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.autoRespond(
    [messageEndLine("assistant", { content: [{ type: "text", text: "partial" }], errorMessage: "model exploded", stopReason: "error" })],
    1,
    5,
  );
  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value?.status, "failed");
  assert.match(result.value?.error ?? "", /model exploded/);
});

// 需求 A：live 成员模型必须是子进程实际上报值（usage.model），声明值只是
// 成员未跑过/未上报时的占位；thinkingLevel 同通路（需求 B）。
test("dispatch 结果把成员实际 model/thinkingLevel 折进 live progress（覆盖声明值、补未声明成员）", async () => {
  const spawn = makeFakeSpawn();
  const updates: RunProgress[] = [];
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const team = fixtureTeam({
    members: [
      { name: "frontend", model: "chatanywhere/gpt-5.6:high", prompt: "p" },
      { name: "backend", prompt: "p" },
      { name: "db", model: "anthropic/claude-sonnet-4-5:xhigh", prompt: "p" },
    ],
  });
  const promise = coordinator.start({ team, task: "t", ui: fakeUi(), onProgress: (p) => updates.push(structuredClone(p)) });
  const child = await waitForChild(spawn, 0);

  // 首次 leader 事件触发 render：播种态把声明后缀拆成 thinkingLevel
  child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "拆解" }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 } }));
  assert.deepEqual(
    updates.at(-1)!.members.map((m) => [m.name, m.model, m.thinkingLevel]),
    [
      ["frontend", "chatanywhere/gpt-5.6:high", "high"],
      ["backend", undefined, undefined],
      ["db", "anthropic/claude-sonnet-4-5:xhigh", "xhigh"],
    ],
  );

  child.emitLine(toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }));
  child.emitLine(
    dispatchDetails([
      { name: "frontend", ok: true, status: "done", usage: { input: 1, output: 1, cost: 0, turns: 1, model: "gpt-5.6", thinkingLevel: "medium" } },
      { name: "backend", ok: true, status: "done", usage: { input: 1, output: 1, cost: 0, turns: 1, model: "claude-sonnet-4-5" } },
    ]),
  );
  const folded = updates.at(-1)!;
  const frontend = folded.members.find((m) => m.name === "frontend")!;
  assert.equal(frontend.model, "chatanywhere/gpt-5.6", "实际值覆盖声明 id 并保留 provider 前缀");
  assert.equal(frontend.thinkingLevel, "medium", "实际思考级别覆盖声明后缀");
  const backend = folded.members.find((m) => m.name === "backend")!;
  assert.equal(backend.model, "claude-sonnet-4-5", "未声明成员补实际值");
  assert.equal(backend.thinkingLevel, undefined);
  const db = folded.members.find((m) => m.name === "db")!;
  assert.equal(db.model, "anthropic/claude-sonnet-4-5:xhigh", "未派发成员保留声明值");
  assert.equal(db.thinkingLevel, "xhigh");

  // leader 的 provider 原生级别随 message_end 进 live 状态，并写进终态记录。
  child.emitLine(
    messageEndLine("assistant", {
      content: [{ type: "text", text: "FINAL" }],
      usage: { input: 50, output: 20, cost: { total: 0.05 }, totalTokens: 300 },
      model: "claude-opus-4-5",
      providerThinkingLevel: "max",
    }),
  );
  assert.equal(updates.at(-1)!.leaderThinkingLevel, "max");
  child.emitClose(0);
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.equal(result.value!.leaderThinkingLevel, "max");
});

test("record.leaderThinkingLevel：leader 事件实际值优先，无事件时回退团队声明后缀", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
  });
  const team = fixtureTeam({ leader: { model: "anthropic/claude-opus-4-5:xhigh", prompt: "你是负责人。" } });

  const first = coordinator.start({ team, task: "t1", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.autoRespond(
    [
      messageEndLine("assistant", {
        content: [{ type: "text", text: "A" }],
        model: "claude-opus-4-5",
        providerThinkingLevel: "low",
      }),
    ],
    0,
    5,
  );
  const firstResult = await first;
  assert.ok(firstResult.ok);
  assert.equal(firstResult.value!.leaderThinkingLevel, "low", "有实际上报值时以它为准");

  const second = coordinator.start({ team, task: "t2", ui: fakeUi() });
  const child2 = await waitForChild(spawn, 1);
  child2.autoRespond([messageEndLine("assistant", { content: [{ type: "text", text: "B" }], model: "claude-opus-4-5" })], 0, 5);
  const secondResult = await second;
  assert.ok(secondResult.ok);
  assert.equal(secondResult.value!.leaderThinkingLevel, "xhigh", "无实际上报时回退声明后缀");
});

test("formatStatusSnapshot running 成员行在状态后带模型（与终态成员行位置对齐）", () => {
  const running = formatStatusSnapshot(
    {
      running: true,
      actives: [],
      records: [],
      progress: {
        runId: "r",
        team: "dev-team",
        task: "t",
        startedAtMs: 0,
        members: [{ name: "frontend", status: "running", model: "gpt-5.6", note: "turn 2", latest: "在写样式" }],
      },
      lastRecord: null,
    },
    0,
  );
  assert.match(running, /▶ frontend running — gpt-5\.6 — turn 2 — 在写样式/);
});

// ---------------------------------------------------------------------------
// v1.17.0 活动阶段（viewer 活动行的 live 数据源）
// ---------------------------------------------------------------------------

// leader 的 tool/message 事件驱动阶段，时间戳取注入时钟（确定性）。
test("leader live 阶段：tool start→tool+名字、update 只刷新时间、end/message_end→waiting", async () => {
  const spawn = makeFakeSpawn();
  const snapshots: Array<{ phase?: string; toolName?: string; at?: number }> = [];
  let t = 5_000;
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    nowMs: () => t,
  });
  const promise = coordinator.start({
    team: fixtureTeam(),
    task: "t",
    ui: fakeUi(),
    onProgress: (p) =>
      snapshots.push({
        ...(p.leaderPhase !== undefined ? { phase: p.leaderPhase } : {}),
        ...(p.leaderToolName !== undefined ? { toolName: p.leaderToolName } : {}),
        ...(p.leaderLastEventAtMs !== undefined ? { at: p.leaderLastEventAtMs } : {}),
      }),
  });
  const child = await waitForChild(spawn, 0);

  child.emitLine(toolExecutionStartLine("read", { path: "x.ts" }));
  assert.deepEqual(snapshots.at(-1), { phase: "tool", toolName: "read", at: 5_000 });

  t = 6_000;
  child.emitLine(toolExecutionUpdateLine("read", { content: [{ type: "text", text: "reading" }] }));
  assert.deepEqual(snapshots.at(-1), { phase: "tool", toolName: "read", at: 6_000 }, "update 刷新时间、阶段保持");

  t = 7_000;
  child.emitLine(toolExecutionEndLine("read", { content: [{ type: "text", text: "ok" }] }));
  assert.deepEqual(snapshots.at(-1), { phase: "waiting", at: 7_000 }, "tool end 清工具名回 waiting");

  t = 8_000;
  child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "收到" }] }));
  assert.deepEqual(snapshots.at(-1), { phase: "waiting", at: 8_000 });

  child.emitClose(0);
  await promise;
});

// cockpit 侧新增 tool_execution_update 分支：把 dispatch 进度载荷里的成员活动
// 折入 progress.members（viewer 的成员活动行数据源）。
test("team_dispatch tool_execution_update：details.members 活动字段按名字折入 progress.members", async () => {
  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => "/repo",
    worktreeRoot: "/tmp/worktrees",
    spawn: spawn.spawn,
    piCommand: "pi",
    nowMs: () => 9_000,
  });
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui: fakeUi() });
  const child = await waitForChild(spawn, 0);
  child.emitLine(toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }] }));
  child.emitLine(
    toolExecutionUpdateLine("team_dispatch", {
      content: [{ type: "text", text: "…" }],
      details: {
        members: [
          {
            name: "frontend",
            status: "running",
            phase: "tool",
            toolName: "read",
            lastActivityAtMs: 8_900,
            note: "turn 2",
            latest: "在读登录页",
          },
        ],
        totalUsage: { input: 1, output: 1, cost: 0, turns: 1 },
      },
    }),
  );

  const progress = coordinator.getStatus().progress!;
  const frontend = progress.members.find((m) => m.name === "frontend")!;
  assert.equal(frontend.phase, "tool");
  assert.equal(frontend.toolName, "read");
  assert.equal(frontend.lastActivityAtMs, 8_900);
  assert.equal(frontend.note, "turn 2");
  assert.equal(frontend.latest, "在读登录页");
  assert.equal(frontend.status, "running");
  assert.equal(progress.leaderPhase, "tool", "leader 仍在执行 team_dispatch");
  assert.equal(progress.leaderLastEventAtMs, 9_000, "update 刷新 leader 时间");

  child.emitClose(0);
  await promise;
});
