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
import agentTeamExtension, { resetDoubleLoadGuardForTests, TEAM_COMMAND_NAMES } from "../index.ts";
import { VALID_TEAM_MD, fixtureTeam } from "./fixtures.ts";
import { isolateRunsDir } from "./helpers.ts";

isolateRunsDir();

/** Cockpit command surface: bare root + one static command per sub-command. */
const COCKPIT_COMMANDS = [
  "team",
  TEAM_COMMAND_NAMES.list,
  TEAM_COMMAND_NAMES.run,
  TEAM_COMMAND_NAMES.resume,
  TEAM_COMMAND_NAMES.status,
  TEAM_COMMAND_NAMES.stop,
  TEAM_COMMAND_NAMES.view,
  TEAM_COMMAND_NAMES.clear,
  TEAM_COMMAND_NAMES.doctor,
];

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
  // Question tool contract (leader → human clarification)
  assert.match(prompt, /team_ask/);
  assert.match(prompt, /不获回答|未获回答/);
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
  parameters?: unknown;
  execute?: (
    toolCallId: string,
    params: never,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>;
}

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, { description: string }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
  const entryRenderers = new Map<string, unknown>();
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  return {
    tools,
    commands,
    handlers,
    entryRenderers,
    appendedEntries,
    sentMessages,
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
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ type: customType, data });
      return {};
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
      return {};
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

test("leader mode (env set) registers only the team_dispatch and team_ask tools", async () => {
  resetDoubleLoadGuardForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-entry-"));
  const teamFile = path.join(dir, "dev-team.md");
  fs.writeFileSync(teamFile, VALID_TEAM_MD);
  await withEnv(teamFile, () => {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    assert.equal(pi.tools.size, 2);
    assert.ok(pi.tools.has("team_dispatch"));
    assert.ok(pi.tools.has("team_ask"));
    assert.equal(pi.commands.size, 0);
  });
});

test("team_ask maps params onto the child's ctx.ui dialog and returns the human answer", async () => {
  resetDoubleLoadGuardForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-entry-"));
  const teamFile = path.join(dir, "dev-team.md");
  fs.writeFileSync(teamFile, VALID_TEAM_MD);
  await withEnv(teamFile, async () => {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    const tool = pi.tools.get("team_ask");
    assert.ok(tool?.execute);
    const calls: Array<{ kind: string; title: string; placeholder?: string; options?: string[]; timeout?: number }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        input: async (title: string, placeholder?: string, opts?: { timeout?: number }) => {
          calls.push({ kind: "input", title, placeholder, timeout: opts?.timeout });
          return "  staging  ";
        },
        select: async (title: string, options: string[], opts?: { timeout?: number }) => {
          calls.push({ kind: "select", title, options, timeout: opts?.timeout });
          return options[1];
        },
      },
    };
    const answered = await tool!.execute!("call-1", { question: "要发到哪个环境？" } as never, undefined, undefined, ctx);
    assert.deepEqual(calls[0], {
      kind: "input",
      title: "[dev-team] 要发到哪个环境？",
      placeholder: "输入回答后回车；Esc 取消",
      timeout: 600_000,
    });
    assert.equal(answered.isError, undefined);
    assert.deepEqual(answered.details, { answered: true, answer: "staging" });
    assert.match(answered.content[0].text, /用户回答：\nstaging/);

    const selected = await tool!.execute!(
      "call-2",
      { question: "环境？", options: ["staging", "prod"], timeoutMs: 1000 } as never,
      undefined,
      undefined,
      ctx,
    );
    assert.equal(calls[1].kind, "select");
    assert.deepEqual(calls[1].options, ["staging", "prod"]);
    assert.equal(calls[1].timeout, 30_000, "tool floor");
    assert.deepEqual(selected.details, { answered: true, answer: "prod" });
  });
});

test("team_ask degrades to a proceed-on-your-own tool result when nobody answers", async () => {
  resetDoubleLoadGuardForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-entry-"));
  const teamFile = path.join(dir, "dev-team.md");
  fs.writeFileSync(teamFile, VALID_TEAM_MD);
  await withEnv(teamFile, async () => {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    const tool = pi.tools.get("team_ask");
    const ctx = { hasUI: false, ui: {} };
    const result = await tool!.execute!("call-1", { question: "q" } as never, undefined, undefined, ctx);
    assert.equal(result.isError, undefined, "unanswered is not an error (no retry loops)");
    assert.deepEqual(result.details, { answered: false });
    assert.match(result.content[0].text, /未获回答/);
    assert.match(result.content[0].text, /最合理的假设/);
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

// 水合多条 run 记录（多 run 并发后 session 里可能有一批终态记录）：
// 按 startedAt 新→旧排序，最多保留 5 条（/reload 后仍有历史可查）。
test("session_start hydrates several run records, newest first", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-hydrate-"));
  await withEnv(undefined, async () => {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    const entries = [1, 2, 3].map((i) => ({
      type: "custom",
      customType: "agent-team-run-v1",
      data: {
        runId: `run-h${i}`,
        team: "t",
        task: `任务 ${i}`,
        startedAt: `2026-09-16T0${i}:00:00Z`,
        status: "completed",
        members: [],
        totalCost: 0,
        totalTokens: 0,
      },
    }));
    const ctx = { ...fakeCtx(projectDir), sessionManager: { getEntries: () => entries } };
    await pi.fire("session_start", { reason: "reload" }, ctx);
    const tool = pi.tools.get("team_status") as unknown as {
      execute: () => Promise<{ content: Array<{ text: string }> }>;
    };
    const text = (await tool.execute()).content[0].text;
    assert.match(text, /runId: run-h3/, "newest record is the headline");
    assert.match(text, /近期 run：run-h2 ✓completed · run-h1 ✓completed/);
  });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("session_start hydration keeps at most five records", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-hydrate-"));
  await withEnv(undefined, async () => {
    const pi = fakePi();
    agentTeamExtension(pi as never);
    const entries = [1, 2, 3, 4, 5, 6].map((i) => ({
      type: "custom",
      customType: "agent-team-run-v1",
      data: {
        runId: `run-h${i}`,
        team: "t",
        task: `任务 ${i}`,
        startedAt: `2026-09-16T0${i}:00:00Z`,
        status: "completed",
        members: [],
        totalCost: 0,
        totalTokens: 0,
      },
    }));
    const ctx = { ...fakeCtx(projectDir), sessionManager: { getEntries: () => entries } };
    await pi.fire("session_start", { reason: "reload" }, ctx);
    const tool = pi.tools.get("team_status") as unknown as {
      execute: () => Promise<{ content: Array<{ text: string }> }>;
    };
    const text = (await tool.execute()).content[0].text;
    assert.match(text, /runId: run-h6/);
    assert.match(text, /近期 run：run-h5 ✓completed · run-h4 ✓completed · run-h3 ✓completed · run-h2 ✓completed（/);
    assert.doesNotMatch(text, /run-h1/, "the oldest two records were evicted at the cap");
  });
  fs.rmSync(projectDir, { recursive: true, force: true });
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
    assert.ok(pi.tools.has("team_resume"));
    assert.ok(pi.tools.has("team_status"));
    assert.ok(pi.tools.has("team_transcript"));
    assert.ok(pi.tools.has("team_stop"));
    assert.ok(!pi.tools.has("team_dispatch"));
    assert.deepEqual([...pi.commands.keys()], COCKPIT_COMMANDS, "the bare root + colon commands are registered");
    assert.ok(pi.entryRenderers.has("agent-team-run-v1"));

    // session_start never registers dynamic per-team commands: dispatch is
    // always the explicit /team:run <name> <task> form.
    await pi.fire("session_start", { reason: "startup" }, fakeCtx(projectDir, true));
    assert.ok(!pi.commands.has("team:proj-team"), "dynamic /team:<name> registrations stay retired");
    assert.deepEqual([...pi.commands.keys()], COCKPIT_COMMANDS);
  });
});

// /reload 场景：pi 宿主在同一进程里先发 session_shutdown 再重新调用扩展
// factory，globalThis 守卫必须被复位，否则第二份 entry 直接 return，
// team_* 工具、/team* 命令、widget 钩子全部消失。
test("after session_shutdown the guard resets and a fresh load registers everything", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-reload-"));
  await withEnv(undefined, async () => {
    const first = fakePi();
    agentTeamExtension(first as never);
    assert.ok(first.tools.has("team_run"));

    // pi 宿主在重绑扩展（reload/new/resume/fork/switch）前保证先发
    // session_shutdown —— 复位时机就挂在这个事件上。
    await first.fire("session_shutdown", { reason: "reload" }, fakeCtx(projectDir));

    const second = fakePi();
    agentTeamExtension(second as never);
    for (const name of ["team_run", "team_status", "team_transcript", "team_stop"]) {
      assert.ok(second.tools.has(name), `tool ${name} re-registered after reload`);
    }
    assert.deepEqual([...second.commands.keys()], COCKPIT_COMMANDS, "the /team* commands re-registered after reload");
    assert.ok(second.entryRenderers.has("agent-team-run-v1"));
  });
});

// 真双加载（leader 子进程 -e + 自动发现，两份之间没有 shutdown）仍被守卫抑制。
test("double load without shutdown stays suppressed", async () => {
  resetDoubleLoadGuardForTests();
  await withEnv(undefined, () => {
    const first = fakePi();
    agentTeamExtension(first as never);
    const toolsAfterFirst = first.tools.size;
    const second = fakePi();
    agentTeamExtension(second as never);
    assert.equal(second.tools.size, 0, "second instance registers no tools");
    assert.equal(second.commands.size, 0, "second instance registers no commands");
    assert.equal(first.tools.size, toolsAfterFirst, "first instance untouched");
  });
});

// 幂等：连发两次 shutdown（如 reload 后又 new session）守卫仍可用。
test("repeated session_shutdown keeps the guard usable", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-reload-"));
  await withEnv(undefined, async () => {
    const first = fakePi();
    agentTeamExtension(first as never);
    await first.fire("session_shutdown", { reason: "reload" }, fakeCtx(projectDir));
    await first.fire("session_shutdown", { reason: "new" }, fakeCtx(projectDir));

    const second = fakePi();
    agentTeamExtension(second as never);
    assert.ok(second.tools.has("team_run"), "tool registered after two shutdowns");
    assert.deepEqual([...second.commands.keys()], COCKPIT_COMMANDS);
  });
});

test("double load is a no-op (installed package + -e copy)", () => {
  resetDoubleLoadGuardForTests();
  const pi = fakePi();
  agentTeamExtension(pi as never);
  const toolsAfterFirst = pi.tools.size;
  agentTeamExtension(pi as never);
  assert.equal(pi.tools.size, toolsAfterFirst, "second instance registers nothing");
  assert.deepEqual([...pi.commands.keys()], COCKPIT_COMMANDS);
  resetDoubleLoadGuardForTests();
});
