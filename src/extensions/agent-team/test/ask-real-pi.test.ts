/**
 * Real pi child E2E (acceptance core): the leader-side ask path inside a real
 * `pi --mode rpc` process, answered by the real cockpit-side `AskChannel`
 * over the RPC Extension UI wire.
 *
 * The fixture extension asks one question from its `session_start` (no LLM
 * call involved), so the full chain runs for real: real pi child →
 * `extension_ui_request` on stdout → AskChannel → main-session answer →
 * `extension_ui_response` on stdin → dialog promise resolves → the fixture
 * persists the outcome. Covers answered / host-cancelled / no-UI plus pi's
 * own agent-side dialog timeout.
 *
 * Skips when the local pi package is unavailable (the agent-team workspace
 * installs it as a devDependency, so in-repo runs always exercise it).
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AskChannel, type AskPort } from "../ask.ts";
import { defaultSpawn, runChildPi } from "../runner.ts";
import type { PiChildProcess } from "../types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "ask-e2e-extension.ts");
// The package's real bin entry is the bundled CLI (`bin.pi`); the unbundled
// dist/cli.js does not boot under node in this workspace.
const piCliPath = path.join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

const piAvailable = fs.existsSync(piCliPath);
const skip = piAvailable ? false : "local @earendil-works/pi-coding-agent/package is not installed";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface E2eOutcome {
  answered: boolean;
  answer?: string;
}

async function runAskE2E(input: {
  params?: Record<string, unknown>;
  /** Direct protocol timeout (bypasses the leader tool clamp). */
  directTimeoutMs?: number;
  port: AskPort;
  /** Keep the cockpit backstop out of the way (lets pi's own timeout win). */
  backstopMarginMs?: number;
}): Promise<{ outcome: E2eOutcome | null; responses: Array<Record<string, unknown>>; exitCode: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-ask-e2e-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-ask-e2e-cfg-"));
  const outPath = path.join(dir, "answer.json");
  const readyPath = path.join(dir, "ready");
  const writes: string[] = [];
  let child: PiChildProcess | undefined;
  const channel = new AskChannel({
    port: input.port,
    // The response must reach the real child's RPC stdin — the whole point of
    // this test — while still being captured for assertions.
    write: (line) => {
      writes.push(line);
      child?.stdin?.write(line);
    },
    backstopMarginMs: input.backstopMarginMs ?? 100,
  });
  try {
    const running = runChildPi({
      command: process.execPath,
      args: [piCliPath, "--mode", "rpc", "--no-session", "-e", fixturePath],
      env: {
        ...process.env,
        // Isolate the child from the user's global extensions/config; the
        // fixture loads explicitly via -e.
        PI_CODING_AGENT_DIR: configDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        ASK_E2E_OUT: outPath,
        ASK_E2E_READY: readyPath,
        ASK_E2E_TEAM: "e2e",
        ...(input.params !== undefined ? { ASK_E2E_ARGS: JSON.stringify(input.params) } : {}),
        ...(input.directTimeoutMs !== undefined ? { ASK_E2E_DIRECT_TIMEOUT: String(input.directTimeoutMs) } : {}),
      },
      spawn: defaultSpawn(),
      stdin: "pipe",
      killGraceMs: 2000,
      onWire: (message) => channel.handle(message),
      onChild: (c) => {
        child = c;
      },
    });
    // Wait for the session to be up (RPC stdin is not consumed while
    // session-start handlers are pending), then trigger the command.
    const readyDeadline = Date.now() + 45_000;
    while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) await sleep(100);
    child?.stdin?.write(`${JSON.stringify({ type: "prompt", message: "/ask-e2e" })}\n`);
    const deadline = Date.now() + 45_000;
    while (!fs.existsSync(outPath) && Date.now() < deadline) await sleep(100);
    // RPC children exit only when stdin ends.
    child?.stdin?.end();
    const outcome = await running;
    const raw = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf-8") : "";
    return {
      outcome: raw ? (JSON.parse(raw) as E2eOutcome) : null,
      responses: writes
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((message): message is Record<string, unknown> => message?.type === "extension_ui_response"),
      exitCode: outcome.exitCode,
    };
  } finally {
    channel.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

test("real pi child: a leader question round-trips over the RPC wire and the answer returns", { skip }, async () => {
  const result = await runAskE2E({
    params: { question: "要发到哪个环境？" },
    port: { present: async () => ({ kind: "answer", value: "staging" }) },
  });
  assert.equal(result.exitCode, 0, "fixture exits cleanly after answering");
  assert.deepEqual(result.outcome, { answered: true, answer: "staging" });
  assert.equal(result.responses.length, 1);
  assert.equal(typeof result.responses[0].id, "string");
  assert.equal(result.responses[0].value, "staging");
});

test("real pi child: a host-cancelled question degrades to unanswered", { skip }, async () => {
  const result = await runAskE2E({
    params: { question: "要发到哪个环境？", options: ["staging", "prod"] },
    port: { present: async () => ({ kind: "cancelled" }) },
  });
  assert.deepEqual(result.outcome, { answered: false });
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].cancelled, true);
});

test("real pi child: no main-session UI cancels the question immediately", { skip }, async () => {
  const result = await runAskE2E({
    params: { question: "要发到哪个环境？" },
    port: { present: async () => ({ kind: "unavailable" }) },
  });
  assert.deepEqual(result.outcome, { answered: false });
  assert.equal(result.responses[0]?.cancelled, true);
});

test("real pi child: pi auto-resolves a dialog at its own timeout when nobody answers", { skip }, async () => {
  const result = await runAskE2E({
    directTimeoutMs: 1500,
    port: { present: () => new Promise(() => {}) },
    backstopMarginMs: 600_000, // keep the cockpit backstop silent: pi's own timeout must fire
  });
  assert.deepEqual(result.outcome, { answered: false });
  assert.deepEqual(result.responses, [], "no response was ever written — pi resolved the dialog itself");
});
