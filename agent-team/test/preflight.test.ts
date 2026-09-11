/**
 * Model preflight tests: pure function over the team config and a fake
 * model-registry lookup — hard failure on unresolvable models
 * (MODEL_NOT_FOUND), warning-only when a model exists without configured
 * auth, members without a model are skipped (default model, unverifiable).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { preflightTeamModels, type ModelLookup } from "../preflight.ts";
import { TeamErrorCodes } from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";

function lookup(models: Array<{ provider: string; id: string; auth?: boolean }>): ModelLookup {
  const known = models;
  return {
    find: (provider, id) => known.find((m) => m.provider === provider && m.id === id) ?? undefined,
    hasConfiguredAuth: (model) => (model as { auth?: boolean }).auth === true,
  };
}

test("all configured models resolve → ok, no warnings", () => {
  const result = preflightTeamModels(
    fixtureTeam(),
    lookup([
      { provider: "anthropic", id: "claude-opus-4-5", auth: true },
      { provider: "chatanywhere", id: "gpt-5.6", auth: true },
      { provider: "anthropic", id: "claude-sonnet-4-5", auth: true },
    ]),
  );
  assert.ok(result.ok);
  assert.deepEqual(result.warnings, []);
});

test("an unresolvable model fails hard with MODEL_NOT_FOUND naming every bad reference", () => {
  const result = preflightTeamModels(
    fixtureTeam({
      members: [
        { name: "frontend", model: "chatanywhere/gpt-5.6", prompt: "p" },
        { name: "backend", model: "anthropic/no-such-model", prompt: "p" },
        { name: "db", model: "ghost", prompt: "p" }, // no provider separator
      ],
    }),
    lookup([{ provider: "chatanywhere", id: "gpt-5.6", auth: true }]),
  );
  assert.ok(!result.ok);
  assert.equal(result.code, TeamErrorCodes.MODEL_NOT_FOUND);
  assert.match(result.message, /backend/);
  assert.match(result.message, /anthropic\/no-such-model/);
  assert.match(result.message, /db/);
  assert.match(result.message, /ghost/);
  assert.match(result.message, /team_models/);
});

test("a model without configured auth passes with a warning", () => {
  const result = preflightTeamModels(
    fixtureTeam(),
    lookup([
      { provider: "anthropic", id: "claude-opus-4-5", auth: false },
      { provider: "chatanywhere", id: "gpt-5.6", auth: true },
      { provider: "anthropic", id: "claude-sonnet-4-5", auth: true },
    ]),
  );
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /leader/);
  assert.match(result.warnings[0], /anthropic\/claude-opus-4-5/);
  assert.match(result.warnings[0], /未配置鉴权/);
});

test("members without a model are skipped (default model, unverifiable)", () => {
  const team = fixtureTeam({
    leader: { prompt: "p" },
    members: [{ name: "solo", prompt: "p" }],
  });
  const result = preflightTeamModels(team, lookup([]));
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.warnings, []);
});

test("missing auth on members is warned too (member name in the warning)", () => {
  const result = preflightTeamModels(
    fixtureTeam(),
    lookup([
      { provider: "anthropic", id: "claude-opus-4-5", auth: true },
      { provider: "chatanywhere", id: "gpt-5.6", auth: false },
      { provider: "anthropic", id: "claude-sonnet-4-5", auth: true },
    ]),
  );
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /frontend/);
  assert.match(result.warnings[0], /chatanywhere\/gpt-5.6/);
});

test("provider/id:level（宿主合法思考级别后缀）按基础 id 解析，后缀不参与注册表查询", () => {
  const result = preflightTeamModels(
    fixtureTeam({
      leader: { model: "anthropic/claude-opus-4-5:max", prompt: "p" },
      members: [{ name: "frontend", model: "chatanywhere/gpt-5.6:high", prompt: "p" }],
    }),
    lookup([
      { provider: "anthropic", id: "claude-opus-4-5", auth: true },
      { provider: "chatanywhere", id: "gpt-5.6", auth: true },
    ]),
  );
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.warnings, []);
});

test("非法后缀不剥离：照旧按原串查询并失败，报错保留原始引用", () => {
  const result = preflightTeamModels(
    fixtureTeam({
      leader: { model: "anthropic/claude-opus-4-5:ultra", prompt: "p" },
      members: [{ name: "frontend", model: "chatanywhere/gpt-5.6", prompt: "p" }],
    }),
    lookup([
      { provider: "anthropic", id: "claude-opus-4-5", auth: true },
      { provider: "chatanywhere", id: "gpt-5.6", auth: true },
    ]),
  );
  assert.ok(!result.ok);
  assert.equal(result.code, TeamErrorCodes.MODEL_NOT_FOUND);
  assert.match(result.message, /anthropic\/claude-opus-4-5:ultra/);
});
