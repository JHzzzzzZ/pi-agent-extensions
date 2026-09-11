/**
 * external-host.test.ts — host boundary for resolveExternalCli.
 *
 * Both branches must be green on any machine:
 * - resolved: really spawn the resolved executable with `--version`
 *   (shell:false, 10s bound) and require exit=0 + non-empty stdout — the
 *   process-boundary guard pure-fake tests cannot give (v1.15.0 deadlock
 *   class). `--version` is offline and free.
 * - unresolved: CLI_NOT_FOUND (a machine without the CLIs).
 */

import { spawn } from "node:child_process";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExternalCli } from "../external.ts";

const VERSION_TIMEOUT_MS = 10_000;

interface VersionRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runVersion(command: string): Promise<VersionRun> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, VERSION_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

for (const backend of ["codex", "claude"] as const) {
  test(`external-host: ${backend} resolves to a spawnable executable or fails with CLI_NOT_FOUND`, async () => {
    const resolved = resolveExternalCli(backend);
    if (!resolved.ok) {
      assert.equal(resolved.code, "CLI_NOT_FOUND");
      assert.ok(resolved.message.length > 0);
      return;
    }
    assert.doesNotMatch(resolved.value.command, /\.(cmd|ps1)$/i);
    const run = await runVersion(resolved.value.command);
    assert.equal(run.timedOut, false, "`--version` must exit inside 10s");
    assert.equal(run.code, 0, `exit code (stderr: ${run.stderr.slice(0, 400)})`);
    assert.ok(run.stdout.trim().length > 0, "`--version` stdout must not be empty");
  });
}
