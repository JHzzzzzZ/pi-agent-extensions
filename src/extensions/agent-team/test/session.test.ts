/**
 * Session persistence + entry renderer tests (host-free).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  appendRunRecord,
  createRunEntryRenderer,
  deliverRunResult,
  formatFailureNotice,
  runDetailText,
  runSummaryLine,
  type SessionPort,
} from "../session.ts";
import { MAX_FAILURE_NOTICE_BYTES, type TeamRunRecord } from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";

function fixtureRecord() {
  const team = fixtureTeam();
  return {
    runId: "run-1",
    team: team.name,
    task: "修复登录 bug",
    startedAt: "2026-09-05T12:00:00Z",
    status: "completed" as const,
    report: "完成",
    members: [
      { name: "frontend", model: "chatanywhere/gpt-5.6", status: "done", summary: "做完" },
      { name: "backend", model: "anthropic/claude-sonnet-4-5", status: "done", worktree: { path: "/wt", branch: "team/r/backend" } },
    ],
    leaderUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.05, turns: 3 },
    totalCost: 0.05,
    totalTokens: 15,
    durationMs: 32000,
  };
}

test("appendRunRecord and deliverRunResult isolate host failures", () => {
  const calls: string[] = [];
  const throwingPort: SessionPort = {
    appendEntry: () => {
      calls.push("appendEntry");
      throw new Error("disk full");
    },
    sendMessage: () => {
      calls.push("sendMessage");
      throw new Error("no session");
    },
  };
  assert.doesNotThrow(() => appendRunRecord(throwingPort, fixtureRecord()));
  assert.doesNotThrow(() => deliverRunResult(throwingPort, "report"));
  assert.deepEqual(calls, ["appendEntry", "sendMessage"]);

  const recorded: Array<{ type: string; data: unknown }> = [];
  const messages: Array<{ customType: string; display?: boolean }> = [];
  const goodPort: SessionPort = {
    appendEntry: (type, data) => recorded.push({ type, data }),
    sendMessage: (message) => messages.push(message),
  };
  appendRunRecord(goodPort, fixtureRecord());
  deliverRunResult(goodPort, "最终报告");
  assert.equal(recorded[0].type, "agent-team-run-v1");
  assert.equal(messages[0].customType, "agent-team-result");
  assert.equal(messages[0].display, true);
});

test("run summary/detail lines and entry renderer reflect the record", () => {
  const record = fixtureRecord();
  assert.match(runSummaryLine(record), /✓ team dev-team · completed · 32s · \$0\.0500/);

  const detail = runDetailText({ ...record, report: "长报告".repeat(2000) });
  assert.match(detail, /runId: run-1/);
  assert.match(detail, /- frontend（done，chatanywhere\/gpt-5\.6）/);
  assert.match(detail, /- backend（done，anthropic\/claude-sonnet-4-5，worktree team\/r\/backend）/);
  assert.ok(detail.endsWith("…"), "long report truncated in detail view");

  const renderer = createRunEntryRenderer();
  const collapsed = renderer(
    { data: record } as never,
    { expanded: false } as never,
    { bg: () => "" } as never,
  );
  assert.ok(collapsed instanceof Box);
  const expanded = renderer(
    { data: record } as never,
    { expanded: true } as never,
    { bg: () => "" } as never,
  );
  assert.ok(expanded instanceof Box);

  assert.equal(renderer({ data: { bad: true } } as never, { expanded: false } as never, { bg: () => "" } as never), undefined);
  void Text;
});

function failureRecord(overrides: Partial<TeamRunRecord> = {}): TeamRunRecord {
  return {
    runId: "run-1",
    team: "dev-team",
    task: "修复登录 bug",
    startedAt: "2026-09-05T12:00:00Z",
    status: "failed",
    error: "model exploded",
    members: [
      { name: "frontend", status: "done", summary: "前端做完" },
      { name: "backend", status: "failed", summary: "后端挂了" },
    ],
    totalCost: 0.0312,
    totalTokens: 120,
    durationMs: 12500,
    ...overrides,
  };
}

test("formatFailureNotice: status/error/task/member rows/partial report", () => {
  const notice = formatFailureNotice(failureRecord({ report: "FINAL PARTIAL REPORT" }));
  assert.match(notice, /^team dev-team run 失败（runId run-1 · 12\.5s · \$0\.0312）/m);
  assert.match(notice, /^错误: model exploded$/m);
  assert.match(notice, /^任务: 修复登录 bug$/m);
  assert.match(notice, /^成员:$/m);
  assert.match(notice, /^  - frontend: done — 前端做完$/m);
  assert.match(notice, /^  - backend: failed — 后端挂了$/m);
  assert.match(notice, /^部分报告:$/m);
  assert.match(notice, /FINAL PARTIAL REPORT/);
});

test("formatFailureNotice omits empty sections and flattens newlines", () => {
  const notice = formatFailureNotice(
    failureRecord({
      error: "line one\nline two",
      task: "多行\n任务",
      members: [{ name: "frontend", status: "done", summary: "第一行\n第二行" }],
      report: undefined,
    }),
  );
  assert.match(notice, /^错误: line one line two$/m);
  assert.match(notice, /^任务: 多行 任务$/m);
  assert.match(notice, /^  - frontend: done — 第一行 第二行$/m);
  assert.doesNotMatch(notice, /部分报告:/);

  const bare = formatFailureNotice(
    failureRecord({ error: undefined, members: [], report: undefined, durationMs: undefined, totalCost: 0 }),
  );
  assert.doesNotMatch(bare, /^错误:/m);
  assert.doesNotMatch(bare, /^成员:/m);
  assert.doesNotMatch(bare, /部分报告:/);
  assert.match(bare, /^team dev-team run 失败（runId run-1）$/m, "no duration/cost suffix when absent");

  const noSummary = formatFailureNotice(failureRecord({ members: [{ name: "db", status: "failed" }] }));
  assert.match(noSummary, /^  - db: failed$/m);
});

test("formatFailureNotice caps the whole notice (report truncated last)", () => {
  const notice = formatFailureNotice(failureRecord({ report: "R".repeat(20000) }));
  assert.ok(Buffer.byteLength(notice, "utf8") <= MAX_FAILURE_NOTICE_BYTES, "notice within the byte cap");
  assert.match(notice, /^错误: model exploded$/m, "error survives truncation");
  assert.match(notice, /^  - backend: failed — 后端挂了$/m, "member rows survive truncation");
});
