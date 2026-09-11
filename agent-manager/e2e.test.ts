/**
 * agent-manager W3 — 真机 e2e（opt-in，不进默认 `npm test`）。
 *
 * 前置：`AGENT_MANAGER_E2E_MODEL`（廉价模型，如 opencode-go/deepseek-flash）+ 鉴权 + 网络；
 * 未设置时全部 skip（无 key/无网环境保持绿）。隔离：子进程 env 设
 * `PI_CODING_AGENT_SESSION_DIR=<临时目录>`（宿主 README），绝不触碰用户真实会话目录。
 *
 * 覆盖：①短任务全周期 + sessionId + 隔离落盘；②长任务 tool 开始后 stop（进程树清）；
 * ③`--session <id>` + `-p` 接续实证（设计 R1）；④startServer + HTTP 全链路 + 静态页。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRunner, resolvePiCommand, type AgentRecord, type OutputLine } from "./agent-runner.ts";
import { startServer } from "./server.ts";

const MODEL = process.env.AGENT_MANAGER_E2E_MODEL ?? "";
const SKIP_REASON = MODEL
  ? false
  : "需要 AGENT_MANAGER_E2E_MODEL（廉价模型如 opencode-go/deepseek-flash）";

const created: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
after(() => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* 清理失败不掩盖断言 */
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(50);
  }
}

async function waitForAsync<T>(probe: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(50);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 受测运行器：真实 pi CLI + 隔离会话目录（env 注入经 RunnerDeps.env 合并）。 */
function runnerFor(sessions: string): AgentRunner {
  return new AgentRunner({
    invocation: resolvePiCommand(process.env.AGENT_MANAGER_E2E_PI, process.platform),
    env: { PI_CODING_AGENT_SESSION_DIR: sessions },
  });
}

async function bestEffortStop(runner: AgentRunner, id: string): Promise<void> {
  if (runner.get(id)?.status !== "running") return;
  try {
    await runner.stop(id);
  } catch {
    /* 清理失败不掩盖断言 */
  }
}

/** #1 产出、#3 消费（同文件内测试顺序执行）。 */
let firstRun: { sessions: string; cwd: string; sessionId: string; file: string } | undefined;

test("真机 e2e：廉价模型短任务 running→exited、sessionId 捕获、隔离目录落盘", { skip: SKIP_REASON }, async () => {
  const base = tempDir("am-e2e-short-");
  const sessions = path.join(base, "sessions");
  const cwd = path.join(base, "cwd");
  fs.mkdirSync(sessions);
  fs.mkdirSync(cwd);
  const runner = runnerFor(sessions);
  const started = runner.start({ cwd, prompt: "请只回复两个字：你好", model: MODEL, name: "am-e2e-short", kind: "new" });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const id = started.value.id;
  try {
    const finished = await waitFor(
      () => {
        const record = runner.get(id);
        return record && record.status !== "running" ? record : undefined;
      },
      180000,
      "agent 退出",
    );
    assert.equal(finished.status, "exited");
    assert.ok(finished.sessionId, "应捕获 sessionId");
    const sessionId = finished.sessionId ?? "";

    const files = fs.readdirSync(sessions, { recursive: true }).map(String);
    const matched = files.find((name) => name.includes(sessionId));
    assert.ok(matched, `隔离目录应出现包含 ${sessionId} 的会话文件`);

    const output = runner.output(id);
    assert.ok(output && output.lines.some((line) => line.kind === "assistant"), "应捕获 assistant 输出行");

    firstRun = { sessions, cwd, sessionId, file: path.join(sessions, matched) };
  } finally {
    await bestEffortStop(runner, id);
  }
});

test("真机 e2e：长任务见 tool 事件后 stop → stopped、pi 进程消失", { skip: SKIP_REASON }, async () => {
  const base = tempDir("am-e2e-long-");
  const sessions = path.join(base, "sessions");
  const cwd = path.join(base, "cwd");
  fs.mkdirSync(sessions);
  fs.mkdirSync(cwd);
  // 长任务脚本 + 无 shell 元字符的提示词：win32 下默认经 cmd.exe 包装，prompt 含引号会被 cmd 解析破坏（设计 R2）。
  fs.writeFileSync(path.join(cwd, "long-task.mjs"), "setTimeout(() => {}, 60000);\n", "utf8");
  const runner = runnerFor(sessions);
  const started = runner.start({
    cwd,
    prompt: "请使用 bash 工具运行命令 node long-task.mjs 并等待它结束。只做这件事，不要使用其他工具。",
    model: MODEL,
    name: "am-e2e-long",
    kind: "new",
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const id = started.value.id;
  const pid = started.value.pid;
  try {
    await waitFor(
      () => {
        const lines = runner.output(id)?.lines ?? [];
        return lines.some((line) => line.kind === "tool" && line.text.includes("long-task")) ? true : undefined;
      },
      180000,
      "tool_execution_start 出现",
    );

    const stopped = await runner.stop(id);
    assert.equal(stopped.ok, true);
    await waitFor(() => (runner.get(id)?.status === "stopped" ? true : undefined), 30000, "状态 stopped");
    assert.equal(typeof pid, "number");
    if (typeof pid === "number") {
      await waitFor(() => (isAlive(pid) ? undefined : true), 30000, "pi 进程消失");
    }
  } finally {
    await bestEffortStop(runner, id);
  }
});

test("真机 e2e：--session <id> + -p 接续同一会话文件（设计 R1 实证）", { skip: SKIP_REASON }, async () => {
  assert.ok(firstRun, "依赖前一个短任务用例产生的会话（单独运行请先跑完整 e2e）");
  if (!firstRun) return;
  const run = firstRun;
  const before = fs.readFileSync(run.file, "utf8");
  const runner = runnerFor(run.sessions);
  const started = runner.start({
    cwd: run.cwd,
    prompt: "请只回复：继续",
    model: MODEL,
    name: "am-e2e-resume",
    kind: "resume",
    sessionRef: run.sessionId,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const id = started.value.id;
  try {
    const finished = await waitFor(
      () => {
        const record = runner.get(id);
        return record && record.status !== "running" ? record : undefined;
      },
      180000,
      "接续 agent 退出",
    );
    assert.equal(finished.status, "exited");
    assert.equal(finished.sessionId, run.sessionId, "接续应落在同一会话");

    const after = fs.readFileSync(run.file, "utf8");
    assert.ok(after.length > before.length, "会话文件应增长");
    assert.ok(after.startsWith(before), "接续必须 append-only");
  } finally {
    await bestEffortStop(runner, id);
  }
});

test("真机 e2e：startServer + HTTP /api/agents/start 全链路 + 静态页可取", { skip: SKIP_REASON }, async () => {
  const base = tempDir("am-e2e-http-");
  const sessions = path.join(base, "sessions");
  const cwd = path.join(base, "cwd");
  fs.mkdirSync(sessions);
  fs.mkdirSync(cwd);
  const handle = await startServer({
    settings: { port: 0, sessionDir: sessions, piPath: process.env.AGENT_MANAGER_E2E_PI, trashDir: path.join(base, "trash"), openBrowser: false },
    runner: runnerFor(sessions),
    configPath: path.join(base, "config.json"),
  });
  const baseUrl = `http://127.0.0.1:${handle.port}`;
  let agentId = "";
  try {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("app.js") && html.includes("style.css"));

    const started = await fetch(`${baseUrl}/api/agents/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, prompt: "请只回复：OK", model: MODEL, name: "am-e2e-http", kind: "new" }),
    });
    assert.equal(started.status, 200);
    const body = (await started.json()) as { ok: boolean; value: AgentRecord };
    agentId = body.value.id;

    const finished = await waitForAsync(
      async () => {
        const res = await fetch(`${baseUrl}/api/agents/${agentId}`);
        const payload = (await res.json()) as { value: AgentRecord };
        return payload.value.status !== "running" ? payload.value : undefined;
      },
      180000,
      "HTTP agent 退出",
    );
    assert.equal(finished.status, "exited");
    assert.ok(finished.sessionId);

    const output = (await (await fetch(`${baseUrl}/api/agents/${agentId}/output`)).json()) as { value: { lines: OutputLine[] } };
    assert.ok(output.value.lines.some((line) => line.kind === "assistant"));
  } finally {
    if (agentId) {
      try {
        await fetch(`${baseUrl}/api/agents/${agentId}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch {
        /* 尽力清理 */
      }
    }
    await handle.close();
  }
});
