#!/usr/bin/env node
/**
 * Opt-in host smoke: real `pi --mode rpc --session <file>` continuation.
 *
 * The resume feature leans on one host guarantee: opening an existing
 * session file with `--session` loads the full conversation and appends the
 * new turns to that same file (no fork, no new session). This script proves
 * it against the real pi binary without any model call:
 *
 *   1. write a tiny v3 fixture session (header + user + assistant turn)
 *   2. spawn `pi --mode rpc --session <fixture>`
 *   3. send `get_state` and assert the conversation survived
 *      (messageCount >= 2, sessionFile === the fixture)
 *   4. close stdin → the RPC process must exit cleanly
 *
 * Usage: node test/resume-host-smoke.mjs
 * Exit code 0 = host contract holds; 1 = broken (details on stdout/stderr).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TIMEOUT_MS = 60_000;

function fixtureSession(dir) {
  const file = path.join(dir, "fixture-session.jsonl");
  const now = new Date().toISOString();
  const lines = [
    { type: "session", version: 3, id: "11111111-2222-3333-4444-555555555555", timestamp: now, cwd: dir },
    {
      type: "message",
      id: "a1b2c3d4",
      parentId: null,
      timestamp: now,
      message: { role: "user", content: "fixture: 继续上次未完成的任务" },
    },
    {
      type: "message",
      id: "b2c3d4e5",
      parentId: "a1b2c3d4",
      timestamp: now,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fixture: 收到" }],
        provider: "fixture",
        model: "fixture-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        stopReason: "stop",
      },
    },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

function fail(message) {
  console.error(`✗ resume host smoke: ${message}`);
  process.exit(1);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-resume-smoke-"));
  const sessionFile = fixtureSession(dir);

  const child = spawn("pi", ["--mode", "rpc", "--session", sessionFile], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const state = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS}ms (stderr: ${stderr.slice(0, 500)})`)), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "response" && message.command === "get_state" && message.success === true) {
          clearTimeout(timer);
          resolve(message.data);
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
  });

  const expected = fs.realpathSync(sessionFile);
  const actual = state.sessionFile ? fs.realpathSync(state.sessionFile) : "(none)";
  if (actual !== expected) fail(`sessionFile mismatch: expected ${expected}, got ${actual}`);
  if (!(state.messageCount >= 2)) fail(`messageCount=${state.messageCount} — the fixture conversation was not restored`);

  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pi did not exit after stdin end")), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
  if (exitCode !== 0) fail(`pi exited with code ${exitCode} (stderr: ${stderr.slice(0, 500)})`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`✓ resume host smoke: sessionFile=${actual} messageCount=${state.messageCount}, clean exit`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
