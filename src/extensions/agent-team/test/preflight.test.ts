/**
 * Model preflight tests: pure function over the team config and a fake
 * model-registry lookup — hard failure on unresolvable models
 * (MODEL_NOT_FOUND), warning-only when a model exists without configured
 * auth, members without a model are skipped (default model, unverifiable).
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { preflightTeamModels, type ExternalPreflightDeps, type ModelLookup } from "../preflight.ts";
import { buildExternalArgs } from "../external.ts";
import { resolveEffectiveTeam } from "../resume.ts";
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

// ---------------------------------------------------------------------------
// External CLI backends (v1: member-only; injected resolver)
// ---------------------------------------------------------------------------

function externalDeps(resolveCli: ExternalPreflightDeps["resolveCli"]): ExternalPreflightDeps {
  return { resolveCli };
}

test("leader 带 backend → EXTERNAL_LEADER_UNSUPPORTED（先于注册表与 CLI 探测）", () => {
  let lookupCalls = 0;
  let resolveCalls = 0;
  const result = preflightTeamModels(
    fixtureTeam({ leader: { backend: "codex", model: "anthropic/claude-opus-4-5", prompt: "p" } }),
    {
      find: () => {
        lookupCalls++;
        return undefined;
      },
      hasConfiguredAuth: () => {
        throw new Error("hasConfiguredAuth must not be called");
      },
    },
    externalDeps(() => {
      resolveCalls++;
      return { ok: true, value: { command: "/x/codex.exe" } };
    }),
  );
  assert.ok(!result.ok);
  assert.equal(result.code, TeamErrorCodes.EXTERNAL_LEADER_UNSUPPORTED);
  assert.match(result.message, /leader/);
  assert.match(result.message, /成员/);
  assert.equal(lookupCalls, 0);
  assert.equal(resolveCalls, 0);
});

test("外部成员跳过注册表模型查询（model 是 CLI 原生 id）", () => {
  let lookupCalls = 0;
  const result = preflightTeamModels(
    fixtureTeam({
      leader: { model: "anthropic/claude-opus-4-5", prompt: "p" },
      members: [
        { name: "coder", backend: "codex", model: "gpt-5.1-codex", prompt: "p" },
        { name: "writer", backend: "claude", model: "claude-haiku-4-5", prompt: "p" },
      ],
    }),
    {
      find: (provider, id) => {
        lookupCalls++;
        return provider === "anthropic" && id === "claude-opus-4-5" ? { auth: true } : undefined;
      },
      hasConfiguredAuth: () => true,
    },
    externalDeps(() => ({ ok: true, value: { command: "/x/cli" } })),
  );
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.equal(lookupCalls, 1); // 只有 leader 的 provider/id 查了注册表
  assert.deepEqual(result.warnings, []);
});

test("外部成员 CLI 解析失败 → CLI_NOT_FOUND 且消息含逃生门变量名", () => {
  for (const backend of ["codex", "claude"] as const) {
    const result = preflightTeamModels(
      fixtureTeam({ leader: { prompt: "p" }, members: [{ name: "coder", backend, model: "m", prompt: "p" }] }),
      lookup([]),
      externalDeps(() => ({ ok: false, code: TeamErrorCodes.CLI_NOT_FOUND, message: `${backend} not found on PATH` })),
    );
    assert.ok(!result.ok, backend);
    assert.equal(result.code, TeamErrorCodes.CLI_NOT_FOUND, backend);
    assert.match(result.message, new RegExp(`PI_AGENT_TEAM_${backend.toUpperCase()}_BIN`), backend);
    assert.match(result.message, new RegExp(backend), backend);
  }
});

test("mixed 团队：外部成员不查注册表，pi 成员照旧 MODEL_NOT_FOUND", () => {
  let lookupCalls = 0;
  const result = preflightTeamModels(
    fixtureTeam({
      leader: { prompt: "p" },
      members: [
        { name: "coder", backend: "codex", model: "gpt-5.1-codex", prompt: "p" },
        { name: "reviewer", model: "ghost/none", prompt: "p" },
      ],
    }),
    {
      find: () => {
        lookupCalls++;
        return undefined;
      },
      hasConfiguredAuth: () => true,
    },
    externalDeps(() => ({ ok: true, value: { command: "/x/codex" } })),
  );
  assert.ok(!result.ok);
  assert.equal(result.code, TeamErrorCodes.MODEL_NOT_FOUND);
  assert.match(result.message, /reviewer/);
  assert.match(result.message, /ghost\/none/);
  assert.equal(lookupCalls, 1);
});

test("external 缺省时跳过 CLI 探测且外部成员模型不查注册表（向后兼容）", () => {
  const result = preflightTeamModels(
    fixtureTeam({
      leader: { prompt: "p" },
      members: [{ name: "coder", backend: "codex", model: "gpt-5.1-codex", prompt: "p" }],
    }),
    lookup([]),
  );
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.deepEqual(result.warnings, []);
});

test("CLI 解析成功时外部成员照常放行，pi 成员的鉴权警告不受影响", () => {
  const result = preflightTeamModels(
    fixtureTeam({
      leader: { model: "anthropic/claude-opus-4-5", prompt: "p" },
      members: [
        { name: "coder", backend: "claude", model: "claude-haiku-4-5", prompt: "p" },
        { name: "frontend", model: "chatanywhere/gpt-5.6", prompt: "p" },
      ],
    }),
    lookup([
      { provider: "anthropic", id: "claude-opus-4-5", auth: true },
      { provider: "chatanywhere", id: "gpt-5.6", auth: false },
    ]),
    externalDeps(() => ({ ok: true, value: { command: "/x/claude.exe" } })),
  );
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /frontend/);
});

// ---------------------------------------------------------------------------
// 外部成员思考档位（agent-team-todo #66）
// ---------------------------------------------------------------------------

/** 本机实测支持集（claude `--help` / codex 官方 config 参考，见 README §7）。 */
const SUPPORTED_LEVELS = {
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  claude: ["low", "medium", "high", "xhigh", "max"],
} as const;

function externalTeam(backend: "codex" | "claude", model: string) {
  return fixtureTeam({
    leader: { prompt: "p" },
    members: [{ name: "coder", backend, model, prompt: "p" }],
  });
}

test("外部成员带受支持档位：预检放行（含基础 id 剥后缀后仍不查注册表）", () => {
  let lookupCalls = 0;
  for (const [backend, level] of [
    ["codex", "minimal"],
    ["codex", "xhigh"],
    ["claude", "low"],
    ["claude", "max"],
  ] as const) {
    const result = preflightTeamModels(
      externalTeam(backend, `m:${level}`),
      {
        find: () => {
          lookupCalls++;
          return undefined;
        },
        hasConfiguredAuth: () => true,
      },
      externalDeps(() => ({ ok: true, value: { command: "/x/cli" } })),
    );
    assert.ok(result.ok, `${backend}:${level} → ${result.ok ? "" : result.message}`);
    assert.deepEqual(result.warnings, [], `${backend}:${level}`);
  }
  assert.equal(lookupCalls, 0);
});

test("外部成员带不支持档位：预检 fail-closed（EXTERNAL_THINKING_UNSUPPORTED + 静态消息，零 CLI 探测）", () => {
  const cases = [
    ["claude", "off"],
    ["claude", "minimal"],
    ["codex", "off"],
    ["codex", "max"],
  ] as const;
  for (const [backend, level] of cases) {
    let resolveCalls = 0;
    const result = preflightTeamModels(
      externalTeam(backend, `m:${level}`),
      lookup([]),
      externalDeps(() => {
        resolveCalls++;
        return { ok: true, value: { command: "/x/cli" } };
      }),
    );
    assert.ok(!result.ok, `${backend}:${level} 必须 fail-closed`);
    assert.equal(result.code, TeamErrorCodes.EXTERNAL_THINKING_UNSUPPORTED, `${backend}:${level}`);
    // 静态模板：成员名前缀 + 后端名 + 静态支持集列表；被拒档位与模型串（用户输入）不进消息。
    const supported = SUPPORTED_LEVELS[backend].join("/");
    assert.equal(
      result.message,
      `外部成员 coder：外部 CLI 不支持该思考档位：${backend} 仅支持 ${supported}。请把成员 model 的 :level 后缀改为受支持档位，或去掉后缀使用 CLI 默认。`,
      `${backend}:${level}`,
    );
    assert.equal(resolveCalls, 0, `${backend}:${level} 不进入 CLI 探测`);
  }
});

test("外部成员不带后缀：预检不因档位检查改变既有行为", () => {
  const result = preflightTeamModels(
    externalTeam("claude", "claude-haiku-4-5"),
    lookup([]),
    externalDeps(() => ({ ok: true, value: { command: "/x/cli" } })),
  );
  assert.ok(result.ok, result.ok ? "" : result.message);
});

test("对照组：预检与启动对同一 model 字符串的判定/解析完全一致（pi 全档位 × 两 CLI）", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  for (const backend of ["codex", "claude"] as const) {
    for (const level of levels) {
      const model = `gpt-5.1-codex:${level}`;
      const pre = preflightTeamModels(
        externalTeam(backend, model),
        lookup([]),
        externalDeps(() => ({ ok: true, value: { command: "/x/cli" } })),
      );
      const spawned = buildExternalArgs(backend, { model, prompt: "p" }, "t");
      assert.equal(pre.ok, spawned.ok, `${backend}:${level} 预检与启动判定必须一致`);
      if (!pre.ok && !spawned.ok) assert.equal(pre.code, spawned.code, `${backend}:${level} 错误码一致`);
      if (spawned.ok) {
        const flag = backend === "codex" ? `model_reasoning_effort=${level}` : level;
        assert.ok(spawned.value.includes(flag), `${backend}:${level} spawn 参数含级别`);
        assert.equal(spawned.value[spawned.value.indexOf("--model") + 1], "gpt-5.1-codex");
      }
    }
  }
});

test("team_resume 的 memberModels 覆盖走同一解析路径（生效团队为准）", () => {
  const team = externalTeam("codex", "gpt-5.1-codex");
  const overridden = resolveEffectiveTeam(team, { memberModels: { coder: "gpt-5.1-codex:max" } }).team;
  const rejected = preflightTeamModels(
    overridden,
    lookup([]),
    externalDeps(() => ({ ok: true, value: { command: "/x/cli" } })),
  );
  assert.ok(!rejected.ok, "覆盖为不支持档位必须在预检期拦下");
  assert.equal(rejected.code, TeamErrorCodes.EXTERNAL_THINKING_UNSUPPORTED);

  const ok = resolveEffectiveTeam(team, { memberModels: { coder: "gpt-5.1-codex:xhigh" } }).team;
  const passed = preflightTeamModels(
    ok,
    lookup([]),
    externalDeps(() => ({ ok: true, value: { command: "/x/cli" } })),
  );
  assert.ok(passed.ok, passed.ok ? "" : passed.message);
  const built = buildExternalArgs("codex", { model: ok.members[0].model, prompt: "p" }, "t");
  assert.ok(built.ok);
  assert.ok(built.value.includes("model_reasoning_effort=xhigh"));
  assert.equal(built.value[built.value.indexOf("--model") + 1], "gpt-5.1-codex");
});
