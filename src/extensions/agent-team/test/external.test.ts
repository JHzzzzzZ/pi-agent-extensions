/**
 * external.ts tests — external agent CLI adapter (codex / claude).
 *
 * Covers the three frozen layers of 10-design §4: command resolution
 * (injected deps + real temp-dir npm layouts), non-interactive argument
 * building (exact element shapes) and stdout JSONL event parsing against
 * recorded real-machine fixtures (test/fixtures/external-*.jsonl).
 *
 * Boundary: this file is pure logic (no real CLI processes). The host
 * boundary — resolved executable really spawns with shell:false — lives in
 * external-host.test.ts.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildExternalArgs, createExternalParser, resolveExternalCli } from "../external.ts";
import type { ChildEvent } from "../types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

function fixtureMessages(name: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(path.join(FIXTURES, name), "utf-8");
  const messages: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    messages.push(JSON.parse(trimmed) as Record<string, unknown>);
  }
  return messages;
}

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-extcli-test-"));
}

function writeFile(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  return file;
}

function feed(p: ReturnType<typeof createExternalParser>, fixture: string): ChildEvent[] {
  const events: ChildEvent[] = [];
  for (const message of fixtureMessages(fixture)) events.push(...p.feed(message));
  return events;
}

// ---------------------------------------------------------------------------
// resolveExternalCli — four-step resolution order
// ---------------------------------------------------------------------------

test("resolveExternalCli: env override wins over PATH and invalid override fails closed", () => {
  const root = makeRoot();
  try {
    const override = writeFile(path.win32.join(root, "custom", "codex.exe"));
    const onPath = writeFile(path.win32.join(root, "pathdir", "codex.exe"));
    const hit = resolveExternalCli("codex", {
      env: { PI_AGENT_TEAM_CODEX_BIN: override },
      pathDirs: [path.win32.join(root, "pathdir")],
      platform: "win32",
      arch: "x64",
    });
    if (!hit.ok) assert.fail(hit.message);
    assert.equal(hit.value.command, override);
    assert.notEqual(hit.value.command, onPath);

    const invalid = resolveExternalCli("codex", {
      env: { PI_AGENT_TEAM_CODEX_BIN: path.win32.join(root, "missing.exe") },
      pathDirs: [path.win32.join(root, "pathdir")],
      platform: "win32",
      arch: "x64",
    });
    if (invalid.ok) assert.fail("invalid override must not fall through to PATH");
    assert.equal(invalid.code, "CLI_NOT_FOUND");
    assert.match(invalid.message, /PI_AGENT_TEAM_CODEX_BIN/);

    const empty = resolveExternalCli("claude", {
      env: { PI_AGENT_TEAM_CLAUDE_BIN: "" },
      pathDirs: [path.win32.join(root, "pathdir")],
      platform: "win32",
      arch: "x64",
    });
    if (empty.ok) assert.fail("empty override must not fall through to PATH");
    assert.equal(empty.code, "CLI_NOT_FOUND");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveExternalCli: PATH hit on win32 resolves the .exe, never the .cmd/.ps1 shim", () => {
  const root = makeRoot();
  try {
    const exe = writeFile(path.win32.join(root, "codex.exe"));
    writeFile(path.win32.join(root, "codex.cmd"));
    writeFile(path.win32.join(root, "codex.ps1"));
    const res = resolveExternalCli("codex", { env: {}, pathDirs: [root], platform: "win32", arch: "x64" });
    if (!res.ok) assert.fail(res.message);
    assert.equal(res.value.command, exe);
    assert.doesNotMatch(res.value.command, /\.(cmd|ps1)$/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveExternalCli: PATH hit on posix resolves the bare executable name", () => {
  const root = makeRoot();
  try {
    const bin = writeFile(path.posix.join(root, "claude"));
    const res = resolveExternalCli("claude", { env: {}, pathDirs: [root], platform: "linux", arch: "x64" });
    if (!res.ok) assert.fail(res.message);
    assert.equal(res.value.command, path.posix.join(root, "claude"));
    assert.equal(res.value.command, bin);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveExternalCli: win32 npm layout resolves the vendored codex.exe (primary and sibling fallback)", () => {
  const root = makeRoot();
  try {
    writeFile(path.win32.join(root, "codex.cmd"));
    const primary = writeFile(
      path.win32.join(
        root,
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      ),
    );
    const res = resolveExternalCli("codex", { env: {}, pathDirs: [root], platform: "win32", arch: "x64" });
    if (!res.ok) assert.fail(res.message);
    assert.equal(res.value.command, primary);
    assert.doesNotMatch(res.value.command, /\.(cmd|ps1)$/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const root2 = makeRoot();
  try {
    writeFile(path.win32.join(root2, "codex.cmd"));
    const sibling = writeFile(
      path.win32.join(
        root2,
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      ),
    );
    const res = resolveExternalCli("codex", { env: {}, pathDirs: [root2], platform: "win32", arch: "x64" });
    if (!res.ok) assert.fail(res.message);
    assert.equal(res.value.command, sibling);
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }

  const root3 = makeRoot();
  try {
    writeFile(path.win32.join(root3, "codex.cmd"));
    const arm = writeFile(
      path.win32.join(
        root3,
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-arm64",
        "vendor",
        "aarch64-pc-windows-msvc",
        "bin",
        "codex.exe",
      ),
    );
    const res = resolveExternalCli("codex", { env: {}, pathDirs: [root3], platform: "win32", arch: "arm64" });
    if (!res.ok) assert.fail(res.message);
    assert.equal(res.value.command, arm);
  } finally {
    fs.rmSync(root3, { recursive: true, force: true });
  }
});

test("resolveExternalCli: win32 npm layout resolves @anthropic-ai/claude-code/bin/claude.exe", () => {
  const root = makeRoot();
  try {
    writeFile(path.win32.join(root, "claude.cmd"));
    const exe = writeFile(path.win32.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
    const res = resolveExternalCli("claude", { env: {}, pathDirs: [root], platform: "win32", arch: "x64" });
    if (!res.ok) assert.fail(res.message);
    assert.equal(res.value.command, exe);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveExternalCli: shim-only directories never yield a spawnable command", () => {
  const root = makeRoot();
  try {
    writeFile(path.win32.join(root, "codex.cmd"));
    writeFile(path.win32.join(root, "codex.ps1"));
    const res = resolveExternalCli("codex", { env: {}, pathDirs: [root], platform: "win32", arch: "x64" });
    if (res.ok) assert.fail(`must not return a shim: ${res.value.command}`);
    assert.equal(res.code, "CLI_NOT_FOUND");
    assert.doesNotMatch(res.message, /\.(cmd|ps1)\b/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveExternalCli: all misses report CLI_NOT_FOUND with searched locations and the env escape hatch", () => {
  const root = makeRoot();
  try {
    const res = resolveExternalCli("codex", { env: {}, pathDirs: [root], platform: "win32", arch: "x64" });
    if (res.ok) assert.fail("empty dirs must not resolve");
    assert.equal(res.code, "CLI_NOT_FOUND");
    assert.match(res.message, /codex/);
    assert.match(res.message, /PATH/);
    assert.match(res.message, /PI_AGENT_TEAM_CODEX_BIN/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildExternalArgs — frozen shapes
// ---------------------------------------------------------------------------

test("buildExternalArgs: codex exact shape, model optional, prompt merged into the task text", () => {
  const args = buildExternalArgs("codex", { model: "gpt-5.1-codex", prompt: "你是评审员。" }, "检查登录流程");
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "-s",
    "workspace-write",
    "--model",
    "gpt-5.1-codex",
    "你是评审员。\n\n---\n\nTask: 检查登录流程",
  ]);
  const noModel = buildExternalArgs("codex", { prompt: "p" }, "t");
  assert.ok(!noModel.includes("--model"));
  assert.equal(noModel[noModel.length - 1], "p\n\n---\n\nTask: t");
});

test("buildExternalArgs: claude exact shape includes --verbose (missing it fails exit=1)", () => {
  const args = buildExternalArgs("claude", { model: "haiku", prompt: "你是评审员。" }, "检查登录流程");
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    "acceptEdits",
    "--append-system-prompt",
    "你是评审员。",
    "--model",
    "haiku",
    "Task: 检查登录流程",
  ]);
  const noModel = buildExternalArgs("claude", { prompt: "p" }, "t");
  assert.ok(!noModel.includes("--model"));
  assert.equal(noModel[noModel.length - 1], "Task: t");
});

test("buildExternalArgs: task text only ever lands in the final positional argument", () => {
  const task = "UNIQUE_TASK_SENTINEL_12345";
  for (const backend of ["codex", "claude"] as const) {
    const args = buildExternalArgs(backend, { model: "m", prompt: "PROMPT_SENTINEL" }, task);
    const hits = args.filter((arg) => arg.includes(task));
    assert.equal(hits.length, 1, `${backend}: task must appear exactly once`);
    assert.equal(args[args.length - 1], hits[0]);
    assert.ok(!hits[0].startsWith("--"), `${backend}: task must not be read as a flag`);
  }
});

// ---------------------------------------------------------------------------
// createExternalParser — codex fixture paths
// ---------------------------------------------------------------------------

test("parser: codex success fixture reports finalText, usage and no failure", () => {
  const parser = createExternalParser("codex");
  const events = feed(parser, "external-codex-success.jsonl");
  assert.equal(parser.finalText, "ok");
  assert.deepEqual(parser.usage, { input: 17704, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
  assert.equal(parser.model, undefined);
  assert.deepEqual(parser.finalize(), { failed: false });
  const messageEnds = events.filter((event) => event.type === "message_end");
  assert.equal(messageEnds.length, 1);
  assert.equal(events.some((event) => event.type === "tool_execution_start"), false);
});

test("parser: codex failure fixture — item error is non-fatal, turn.failed marks the run failed", () => {
  const parser = createExternalParser("codex");
  const events = feed(parser, "external-codex-fail.jsonl");
  const errors = events.filter((event) => event.type === "error");
  assert.equal(errors.length, 1);
  if (errors[0].type !== "error") assert.fail("expected an error event");
  assert.equal(errors[0].code, "EXTERNAL_ITEM_ERROR");
  assert.match(errors[0].message, /Model metadata/);
  const fin = parser.finalize();
  assert.equal(fin.failed, true);
  assert.match(fin.errorMessage ?? "", /gpt-5-nano/);
});

test("parser: an item error alone never fails the run", () => {
  const parser = createExternalParser("codex");
  const events = parser.feed({
    type: "item.completed",
    item: { id: "item_0", type: "error", message: "transient warning" },
  });
  assert.equal(events.length, 1);
  assert.deepEqual(parser.finalize(), { failed: false });
});

test("parser: codex command_execution maps to shell tool start/end", () => {
  const parser = createExternalParser("codex");
  const started = parser.feed({
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "ls" },
  });
  assert.deepEqual(started, [{ type: "tool_execution_start", toolName: "shell" }]);
  const completed = parser.feed({ type: "item.completed", item: { id: "item_1", type: "command_execution" } });
  assert.deepEqual(completed, [{ type: "tool_execution_end", toolName: "shell" }]);
  assert.deepEqual(parser.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
});

test("parser: unknown codex event shapes are tolerated without events or throws", () => {
  const parser = createExternalParser("codex");
  const shapes: Array<Record<string, unknown>> = [
    {},
    { type: "nope" },
    { type: "item.completed" },
    { type: "item.completed", item: null },
    { type: "item.completed", item: { type: "unknown" } },
    { type: "thread.started", thread_id: 1 },
  ];
  for (const shape of shapes) assert.deepEqual(parser.feed(shape), []);
  assert.deepEqual(parser.finalize(), { failed: false });
});

// ---------------------------------------------------------------------------
// createExternalParser — claude fixture paths
// ---------------------------------------------------------------------------

test("parser: claude error fixture (proxy 405) — is_error drives failure, usage/cost are finalized", () => {
  const parser = createExternalParser("claude");
  const events = feed(parser, "external-claude-error.jsonl");
  assert.equal(parser.model, "claude-haiku-4-5");
  assert.deepEqual(parser.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
  assert.match(parser.finalText, /405 CONNECT only/);
  const fin = parser.finalize();
  assert.equal(fin.failed, true);
  assert.match(fin.errorMessage ?? "", /405 CONNECT only/);
  const messageEnds = events.filter((event) => event.type === "message_end");
  assert.equal(messageEnds.length, 1);
});

test("parser: claude success fixture finalizes usage, model and tool name reverse lookup", () => {
  const parser = createExternalParser("claude");
  const events = feed(parser, "external-claude-success.jsonl");
  assert.equal(parser.model, "claude-haiku-4-5");
  assert.equal(parser.finalText, "a.txt 的内容是 hello。");
  assert.deepEqual(parser.usage, { input: 123, output: 45, cacheRead: 20, cacheWrite: 10, cost: 0.0123, turns: 3 });
  assert.deepEqual(parser.finalize(), { failed: false });
  assert.deepEqual(
    events.map((event) => event.type),
    ["message_end", "tool_execution_start", "tool_execution_end", "message_end"],
  );
  const start = events[1];
  if (start.type !== "tool_execution_start") assert.fail("expected tool start");
  assert.equal(start.toolName, "Read");
  const end = events[2];
  if (end.type !== "tool_execution_end") assert.fail("expected tool end");
  assert.equal(end.toolName, "Read");
});

test("parser: claude tool_result with unknown id falls back to '?' and unknown events are ignored", () => {
  const parser = createExternalParser("claude");
  const events = parser.feed({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "unknown-id", content: "x" }] },
  });
  assert.deepEqual(events, [{ type: "tool_execution_end", toolName: "?" }]);
  for (const shape of [
    {},
    { type: "nope" },
    { type: "assistant" },
    { type: "assistant", message: { content: "not-an-array" } },
    { type: "user", message: { content: [null, { type: "text" }] } },
    { type: "system", subtype: "init" },
  ] as Array<Record<string, unknown>>) {
    assert.deepEqual(parser.feed(shape), []);
  }
  assert.deepEqual(parser.finalize(), { failed: false });
  assert.equal(parser.model, undefined);
});

test("parser: claude result without a result string keeps the last assistant text", () => {
  const parser = createExternalParser("claude");
  parser.feed({ type: "assistant", message: { content: [{ type: "text", text: "partial answer" }] } });
  parser.feed({ type: "result", is_error: false, num_turns: 1, total_cost_usd: 0.5, usage: { input_tokens: 7 } });
  assert.equal(parser.finalText, "partial answer");
  assert.deepEqual(parser.usage, { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 1 });
});
