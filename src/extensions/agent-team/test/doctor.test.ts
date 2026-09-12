/**
 * Doctor report tests: pure report builder over injected deps (discovery,
 * run statuses, model lookup, fs probes) — every section renders, preflight
 * results and budget sources are listed per team, corrupt status files and
 * stale running runs are reported, never thrown.
 */

import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildDoctorReport, type DoctorDeps, type DoctorInput } from "../doctor.ts";
import { fixtureTeam } from "./fixtures.ts";

function baseInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    mode: "cockpit",
    cwd: "/repo",
    projectTrusted: true,
    scope: "both",
    widgetEnabled: true,
    runsRoot: "/runs",
    worktreeRoot: "/wt",
    registryError: undefined,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    discoverTeams: () => ({ teams: [fixtureTeam()], invalid: [] }),
    readRunStatuses: () => ({ entries: [], corrupt: [] }),
    lookup: {
      find: (provider, id) =>
        provider === "anthropic" || provider === "chatanywhere" ? { provider, id } : undefined,
      hasConfiguredAuth: () => true,
    },
    dirStatus: () => "ok",
    isGitRepo: () => true,
    ...overrides,
  };
}

test("the report renders every section for a healthy cockpit", () => {
  const report = buildDoctorReport(baseInput(), baseDeps());
  assert.match(report, /agent-team 自检报告/);
  assert.match(report, /模式: cockpit/);
  assert.match(report, /cwd: \/repo/);
  assert.match(report, /项目信任: 是/);
  assert.match(report, /亮块 widget: 启用/);
  assert.match(report, /团队发现/);
  assert.match(report, /dev-team/);
  assert.match(report, /模型预检/);
  assert.match(report, /✓/);
  assert.match(report, /运行目录/);
  assert.match(report, /残留 running: 0/);
  assert.match(report, /损坏 status 文件: 0/);
  assert.match(report, /预算/);
  assert.match(report, /来源: default/);
  assert.match(report, /派发 12/);
  assert.match(report, /worktree/);
  assert.match(report, /git 仓库: 是/);
  assert.match(report, /模型注册表/);
  assert.match(report, /正常|无错误/);
});

test("leader mode, untrusted project and disabled widget are reported", () => {
  const report = buildDoctorReport(
    baseInput({ mode: "leader", projectTrusted: false, widgetEnabled: false }),
    baseDeps(),
  );
  assert.match(report, /模式: leader/);
  assert.match(report, /项目信任: 否/);
  assert.match(report, /亮块 widget: 关闭/);
});

test("registry errors are surfaced", () => {
  const report = buildDoctorReport(baseInput({ registryError: "models.json 解析失败" }), baseDeps());
  assert.match(report, /错误: models\.json 解析失败/);
});

test("team discovery reports scopes, counts and invalid files", () => {
  const report = buildDoctorReport(
    baseInput(),
    baseDeps({
      discoverTeams: () => ({
        teams: [fixtureTeam()],
        invalid: [{ file: "/x/broken.md", message: "missing required field: name" }],
      }),
    }),
  );
  assert.match(report, /无效文件 1 个/);
  assert.match(report, /\/x\/broken\.md — missing required field: name/);
});

test("per-team preflight failures and auth warnings are listed", () => {
  const failTeam = fixtureTeam({
    name: "fail-team",
    members: [
      { name: "frontend", model: "chatanywhere/gpt-5.6", prompt: "p" },
      { name: "backend", model: "ghost/no-such-model", prompt: "p" },
    ],
  });
  const warnTeam = fixtureTeam({ name: "warn-team", members: [{ name: "backend", model: "anthropic/claude-sonnet-4-5", prompt: "p" }] });
  const report = buildDoctorReport(
    baseInput(),
    baseDeps({
      discoverTeams: () => ({ teams: [failTeam, warnTeam], invalid: [] }),
      lookup: {
        find: (provider, id) => (provider === "ghost" ? undefined : { provider, id }),
        hasConfiguredAuth: (model) => (model as { provider: string }).provider !== "anthropic",
      },
    }),
  );
  assert.match(report, /✗ fail-team/);
  assert.match(report, /ghost\/no-such-model/);
  assert.match(report, /⚠ warn-team/);
  assert.match(report, /anthropic\/claude-opus-4-5 未配置鉴权|未配置鉴权.*claude-opus-4-5/s);
});

test("stale running runs and corrupt status files are reported with counts", () => {
  const report = buildDoctorReport(
    baseInput(),
    baseDeps({
      readRunStatuses: () => ({
        entries: [
          {
            version: 1,
            runId: "run-1",
            team: "dev-team",
            task: "t",
            startedAt: "s",
            status: "running",
            updatedAt: "u",
            leaderPid: 4321,
          },
        ],
        corrupt: [{ file: "/runs/run-2/status.json", message: "bad json" }],
      }),
    }),
  );
  assert.match(report, /残留 running: 1 个/);
  assert.match(report, /run-1（pid 4321）/);
  assert.match(report, /损坏 status 文件: 1/);
  assert.match(report, /\/runs\/run-2\/status\.json/);
});

test("frontmatter budgets are listed with their source", () => {
  const report = buildDoctorReport(
    baseInput(),
    baseDeps({
      discoverTeams: () => ({ teams: [fixtureTeam({ budget: { maxCostUsd: 5 } })], invalid: [] }),
    }),
  );
  assert.match(report, /来源: frontmatter/);
  assert.match(report, /费用 \$5\.00/);
  assert.match(report, /tokens 无限/);
});

test("fs probe failures degrade to reported lines, never thrown", () => {
  const report = buildDoctorReport(
    baseInput(),
    baseDeps({
      dirStatus: () => "missing",
      isGitRepo: () => false,
    }),
  );
  assert.match(report, /运行目录.*缺失/s);
  assert.match(report, /git 仓库: 否/);
  assert.match(report, /worktreeRoot: 缺失|不可写|缺失/);
});

// ---------------------------------------------------------------------------
// v1.22.0 外部 CLI 后端预检（doctor 接线真实 resolver，10-design §3/§6）
// ---------------------------------------------------------------------------

test("doctor 预检：外部 leader 报告 v1 限制行", () => {
  const report = buildDoctorReport(
    baseInput(),
    baseDeps({
      discoverTeams: () => ({
        teams: [fixtureTeam({ leader: { ...fixtureTeam().leader, backend: "claude" } })],
        invalid: [],
      }),
    }),
  );
  assert.match(report, /✗ dev-team/);
  assert.match(report, /v1 限制：leader 暂不支持外部 CLI 后端/);
});

test("doctor 预检：外部成员 CLI 不可用报告 CLI 缺失告警（真实 resolver）", () => {
  const envKey = "PI_AGENT_TEAM_CODEX_BIN";
  const previous = process.env[envKey];
  process.env[envKey] = path.join(os.tmpdir(), "agent-team-doctor-missing-codex.exe");
  try {
    const report = buildDoctorReport(
      baseInput(),
      baseDeps({
        discoverTeams: () => ({
          teams: [
            fixtureTeam({
              members: [{ name: "coder", backend: "codex", model: "gpt-5.1-codex", prompt: "你是外部码农。" }],
            }),
          ],
          invalid: [],
        }),
      }),
    );
    assert.match(report, /✗ dev-team/);
    assert.match(report, /外部成员 coder 的 codex CLI 不可用/);
    assert.match(report, /PI_AGENT_TEAM_CODEX_BIN/);
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  }
});
