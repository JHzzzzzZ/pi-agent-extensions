/**
 * Run record archiving: 终态把 run 记录（`.pi/team-runs/<runId>/` 目录与
 * `<runId>.md` 单文件两种形态）复制到主工作区 `history/team-runs/<runId>/`。
 *
 * 边界（真实临时目录 fs，不 mock）：worktree 团队记录落在
 * `<worktreeRoot>/<runId>/team|<member>/.pi/team-runs/`，run worktree 会被
 * `git worktree remove` 整体删除——只有主工作区 history/ 存活，所以归档必须
 * 在终态当场完成；冲突保双方、失败只诊断。reconcile 与 cockpit 两条接线各自
 * 用真实模块组合测到（mock 只用在子进程边界 FakeChild）。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { archiveRunRecords } from "../archive.ts";
import { TeamRunCoordinator, type UiPort } from "../cockpit.ts";
import { RUN_STATUS_VERSION, reconcileStaleRuns } from "../runstore.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, waitForChild } from "./helpers.ts";

/** 固定时钟：冲突后缀可精确断言（UTC 紧凑格式）。 */
const FIXED_NOW = new Date("2026-02-10T03:14:05Z");
const RUN_ID = "run-1789118830531";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

/** 记录型 UI（cockpit 集成：断言归档诊断是否发 warning）。 */
function recordingUi(): { ui: UiPort; notifications: Array<{ text: string; level: string }> } {
  const notifications: Array<{ text: string; level: string }> = [];
  return {
    notifications,
    ui: {
      notify: (text, level) => notifications.push({ text, level }),
      dim: (text) => text,
    },
  };
}

// ---------------------------------------------------------------------------
// archiveRunRecords（纯 fs 边界）
// ---------------------------------------------------------------------------

test("归档成功：worktree 子目录与主 cwd 两种形态平铺复制，源保留", () => {
  const baseCwd = tmpDir("agent-team-archive-base-");
  const worktreeRunRoot = tmpDir("agent-team-archive-wt-");
  // ① worktree 形态：team 共享 worktree + 成员 worktree 各自的记录目录。
  write(path.join(worktreeRunRoot, "team", ".pi", "team-runs", RUN_ID, "task.md"), "team task");
  write(path.join(worktreeRunRoot, "team", ".pi", "team-runs", RUN_ID, "evidence.md"), "team evidence");
  write(path.join(worktreeRunRoot, "backend", ".pi", "team-runs", RUN_ID, "report.md"), "member report");
  // ② 主会话 cwd 形态：<runId>.md 单文件。
  write(path.join(baseCwd, ".pi", "team-runs", `${RUN_ID}.md`), "summary");

  const result = archiveRunRecords({ runId: RUN_ID, baseCwd, worktreeRunRoot, now: () => FIXED_NOW });

  const target = path.join(baseCwd, "history", "team-runs", RUN_ID);
  assert.deepEqual(
    fs.readdirSync(target).sort(),
    ["evidence.md", "report.md", "task.md", `${RUN_ID}.md`].sort(),
  );
  assert.equal(read(path.join(target, "task.md")), "team task");
  assert.equal(read(path.join(target, "report.md")), "member report");
  assert.equal(read(path.join(target, `${RUN_ID}.md`)), "summary");
  assert.deepEqual(result.archived.sort(), [
    path.join(target, "evidence.md"),
    path.join(target, "report.md"),
    path.join(target, "task.md"),
    path.join(target, `${RUN_ID}.md`),
  ].sort());
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.failures.length, 0);
  // 源永不删除。
  assert.equal(read(path.join(worktreeRunRoot, "team", ".pi", "team-runs", RUN_ID, "task.md")), "team task");
  assert.equal(read(path.join(baseCwd, ".pi", "team-runs", `${RUN_ID}.md`)), "summary");
});

test("目标已存在：不同内容保双方并加 conflict 时间戳；相同字节幂等跳过", () => {
  const baseCwd = tmpDir("agent-team-archive-base-");
  const worktreeRunRoot = tmpDir("agent-team-archive-wt-");
  const source = path.join(worktreeRunRoot, "team", ".pi", "team-runs", RUN_ID);
  write(path.join(source, "task.md"), "new content");
  write(path.join(source, "same.md"), "same bytes");
  const target = path.join(baseCwd, "history", "team-runs", RUN_ID);
  write(path.join(target, "task.md"), "old content");
  write(path.join(target, "same.md"), "same bytes");

  const result = archiveRunRecords({ runId: RUN_ID, baseCwd, worktreeRunRoot, now: () => FIXED_NOW });

  // 既有文件不被覆盖；新文件带 conflict 后缀落盘，双方都留。
  assert.equal(read(path.join(target, "task.md")), "old content");
  const conflict = path.join(target, `task.conflict-20260210T031405Z.md`);
  assert.equal(read(conflict), "new content");
  assert.deepEqual(result.conflicts, [conflict]);
  // 字节相同 → 幂等跳过（既不覆盖也不产生副本）。
  assert.equal(read(path.join(target, "same.md")), "same bytes");
  assert.deepEqual(result.archived, []);
  assert.equal(result.failures.length, 0);

  // 重复归档同一份记录：既有 conflict 副本字节相同 → 不新增副本。
  const again = archiveRunRecords({ runId: RUN_ID, baseCwd, worktreeRunRoot, now: () => FIXED_NOW });
  assert.deepEqual(again.conflicts, []);
  assert.deepEqual(again.archived, []);
  assert.equal(fs.readdirSync(target).filter((name) => name.includes("conflict")).length, 1);
});

test("目标不可写：failures 出诊断、不 throw、源完好、既有文件不动", () => {
  const baseCwd = tmpDir("agent-team-archive-base-");
  const worktreeRunRoot = tmpDir("agent-team-archive-wt-");
  // 让 history 位置被同名文件占住 → mkdir -p 必然失败。
  write(path.join(baseCwd, "history"), "occupied");
  const sourceFile = path.join(worktreeRunRoot, "team", ".pi", "team-runs", RUN_ID, "task.md");
  write(sourceFile, "task");

  const result = archiveRunRecords({ runId: RUN_ID, baseCwd, worktreeRunRoot, now: () => FIXED_NOW });

  assert.ok(result.failures.length > 0, `failures 应有诊断：${JSON.stringify(result)}`);
  assert.match(result.failures.join("\n"), /归档/);
  assert.equal(result.archived.length, 0);
  assert.equal(result.conflicts.length, 0);
  // 源完好、占位文件未被改写。
  assert.equal(read(sourceFile), "task");
  assert.equal(read(path.join(baseCwd, "history")), "occupied");
});

test("reconcile 接线：running 翻 failed 后按 index.ts 组合归档该 run 记录", () => {
  const runsRoot = tmpDir("agent-team-archive-runs-");
  const baseCwd = tmpDir("agent-team-archive-recon-");
  const runId = "run-recon-archive-1";
  write(
    path.join(runsRoot, runId, "status.json"),
    JSON.stringify({
      version: RUN_STATUS_VERSION,
      runId,
      team: "dev-team",
      task: "上次会话崩溃时的任务",
      startedAt: "2026-09-09T00:00:00Z",
      status: "running",
      ownerPid: 999999,
      updatedAt: "2026-09-09T00:00:00Z",
    }),
  );
  write(path.join(baseCwd, ".pi", "team-runs", runId, "plan.md"), "plan");

  const stale = reconcileStaleRuns({
    root: runsRoot,
    inMemoryRunIds: new Set(),
    currentPid: process.pid,
    isProcessAlive: () => false,
    now: () => "2026-09-09T00:01:00Z",
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].runId, runId);

  // index.ts session_start 接线：每个翻 failed 的 run 各归档一次。
  for (const run of stale) {
    archiveRunRecords({
      runId: run.runId,
      baseCwd,
      worktreeRunRoot: path.join(baseCwd, "teams", "worktrees", run.runId),
      now: () => FIXED_NOW,
    });
  }

  assert.equal(read(path.join(baseCwd, "history", "team-runs", runId, "plan.md")), "plan");
  assert.equal(JSON.parse(read(path.join(runsRoot, runId, "status.json"))).status, "failed");
});

// ---------------------------------------------------------------------------
// cockpit 集成（terminal write 后归档；诊断只走 warning）
// ---------------------------------------------------------------------------

test("cockpit 终态归档：run 完成后记录已复制到主工作区，成功路径不发 warning", async () => {
  const baseCwd = tmpDir("agent-team-archive-cockpit-");
  const worktreeRoot = tmpDir("agent-team-archive-cockpit-wt-");
  const transcriptRoot = tmpDir("agent-team-archive-cockpit-runs-");
  const runMs = 1789118830999;
  const runId = `run-${runMs}`;
  write(path.join(baseCwd, ".pi", "team-runs", runId, "evidence.md"), "done");
  write(path.join(worktreeRoot, runId, "team", ".pi", "team-runs", runId, "wt.md"), "from worktree");

  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => baseCwd,
    worktreeRoot,
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot,
    nowMs: () => runMs,
  });
  const { ui, notifications } = recordingUi();
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui });
  const child = await waitForChild(spawn, 0);
  child.autoRespond([messageEndLine("assistant", { content: [{ type: "text", text: "FINAL" }] })]);

  const result = await promise;
  assert.ok(result.ok);
  assert.equal(result.value.status, "completed");
  const target = path.join(baseCwd, "history", "team-runs", runId);
  assert.equal(read(path.join(target, "evidence.md")), "done");
  assert.equal(read(path.join(target, "wt.md")), "from worktree");
  assert.equal(
    notifications.filter((n) => n.level === "warning").length,
    0,
    `成功路径不应发 warning：${JSON.stringify(notifications)}`,
  );
});

test("cockpit 归档失败：warning 诊断可见、run 终态不受影响", async () => {
  const baseCwd = tmpDir("agent-team-archive-cockpit-fail-");
  const worktreeRoot = tmpDir("agent-team-archive-cockpit-fail-wt-");
  const transcriptRoot = tmpDir("agent-team-archive-cockpit-fail-runs-");
  const runMs = 1789118830888;
  const runId = `run-${runMs}`;
  write(path.join(baseCwd, "history"), "blocked");
  write(path.join(baseCwd, ".pi", "team-runs", runId, "evidence.md"), "done");

  const spawn = makeFakeSpawn();
  const coordinator = new TeamRunCoordinator({
    cwd: () => baseCwd,
    worktreeRoot,
    spawn: spawn.spawn,
    piCommand: "pi",
    transcriptRoot,
    nowMs: () => runMs,
  });
  const { ui, notifications } = recordingUi();
  const promise = coordinator.start({ team: fixtureTeam(), task: "t", ui });
  const child = await waitForChild(spawn, 0);
  child.autoRespond([messageEndLine("assistant", { content: [{ type: "text", text: "FINAL" }] })]);

  const result = await promise;
  // 归档失败绝不改终态、绝不抛异常。
  assert.ok(result.ok);
  assert.equal(result.value.status, "completed");
  const warnings = notifications.filter((n) => n.level === "warning");
  assert.equal(warnings.length, 1, `应恰好一条归档 warning：${JSON.stringify(notifications)}`);
  assert.match(warnings[0].text, /归档/);
  assert.equal(read(path.join(baseCwd, ".pi", "team-runs", runId, "evidence.md")), "done");
});
