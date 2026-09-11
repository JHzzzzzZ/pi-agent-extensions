/**
 * agent-manager W2 — pi 子进程运行器测试（TDD：先红后绿）。
 *
 * 边界与手法：
 * - fake spawn 只做进程边界替身（沿 pwr/runner/test/helpers.ts 的 FakeChild 手法），
 *   参数构造 / json 事件归约 / 状态机全部走真实 AgentRunner；不用 mock 库。
 * - 真实进程树用例用 node 子进程树验证默认进程树杀与全链路：stub「pi」脚本派生
 *   孙进程并把孙 pid 写临时文件、父进程常驻；不碰用户真实 pi / 会话目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentErrorCodes,
  AgentRunner,
  defaultKillTree,
  resolvePiCommand,
  type AgentStartSpec,
  type PiInvocation,
  type RunnerChildProcess,
  type RunnerDeps,
} from "./agent-runner.ts";

const T0 = "2026-09-11T00:00:00.000Z";

// ---------------------------------------------------------------- fake spawn

/** 运行器经冻结注入缝传入的 spawn 选项（运行时有额外字段，断言处收窄）。 */
interface SpawnOptionsShape {
  cwd: string;
  stdio?: unknown;
  windowsHide?: unknown;
  detached?: unknown;
}

class FakeChild implements RunnerChildProcess {
  private static nextPid = 4100;
  readonly pid: number = FakeChild.nextPid++;
  private readonly stdoutHandlers: Array<(chunk: unknown) => void> = [];
  private readonly stderrHandlers: Array<(chunk: unknown) => void> = [];
  private readonly closeHandlers: Array<(code: number | null) => void> = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];

  readonly stdout = {
    on: (_event: "data", handler: (chunk: unknown) => void): void => {
      this.stdoutHandlers.push(handler);
    },
  };

  readonly stderr = {
    on: (_event: "data", handler: (chunk: unknown) => void): void => {
      this.stderrHandlers.push(handler);
    },
  };

  on(event: "close" | "error", handler: (arg: never) => void): void {
    if (event === "close") this.closeHandlers.push(handler as (code: number | null) => void);
    else this.errorHandlers.push(handler as (err: Error) => void);
  }

  emitStdout(text: string): void {
    for (const handler of this.stdoutHandlers) handler(Buffer.from(text, "utf8"));
  }

  emitStderr(text: string): void {
    for (const handler of this.stderrHandlers) handler(Buffer.from(text, "utf8"));
  }

  emitClose(code: number | null): void {
    for (const handler of this.closeHandlers) handler(code);
  }

  emitError(err: Error): void {
    for (const handler of this.errorHandlers) handler(err);
  }
}

interface FakeSpawnHandle {
  spawn: NonNullable<RunnerDeps["spawn"]>;
  records: Array<{ command: string; args: string[]; options: SpawnOptionsShape }>;
  children: FakeChild[];
  spawnError?: Error;
}

function makeFakeSpawn(): FakeSpawnHandle {
  const handle: FakeSpawnHandle = {
    records: [],
    children: [],
    spawn: (command, args, options) => {
      if (handle.spawnError) throw handle.spawnError;
      handle.records.push({ command, args, options: { ...(options as SpawnOptionsShape) } });
      const child = new FakeChild();
      handle.children.push(child);
      return child;
    },
  };
  return handle;
}

function makeRunner(
  fake: FakeSpawnHandle,
  overrides: Partial<RunnerDeps> = {},
  invocation: PiInvocation = { command: "pi", prefixArgs: [] },
): AgentRunner {
  return new AgentRunner({ invocation, spawn: fake.spawn, ...overrides });
}

function emitJson(child: FakeChild, event: unknown): void {
  child.emitStdout(`${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------- 通用工具

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* 清理失败不掩盖测试断言 */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function bestEffortTreeKill(pid: number | undefined): Promise<void> {
  if (pid === undefined || !isAlive(pid)) return;
  try {
    await defaultKillTree(pid);
  } catch {
    /* 清理失败不掩盖测试断言 */
  }
}

/**
 * 写一个 stub「pi」脚本：派生一个常驻孙进程并把孙 pid 写进 AM_STUB_PID_FILE，
 * 可选先打印会话头 / assistant message_end，然后父进程常驻。
 */
function writeStubPi(
  dir: string,
  fileName: string,
  script: { sessionId?: string; assistantText?: string } = {},
): string {
  const prints: string[] = [];
  if (script.sessionId) {
    prints.push(`console.log(${JSON.stringify(JSON.stringify({ type: "session", id: script.sessionId }))});`);
  }
  if (script.assistantText) {
    const event = {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: script.assistantText }] },
    };
    prints.push(`console.log(${JSON.stringify(JSON.stringify(event))});`);
  }
  const source = [
    'import { spawn } from "node:child_process";',
    'import * as fs from "node:fs";',
    "",
    "const pidFile = process.env.AM_STUB_PID_FILE;",
    'const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
    "if (pidFile) fs.writeFileSync(pidFile, String(grandchild.pid));",
    ...prints,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, source, "utf8");
  return file;
}

// ------------------------------------------------------------------- 测试

test("resolvePiCommand：js 直启 / win32 cmd 包装 / posix 裸 command 三分支", () => {
  assert.deepEqual(resolvePiCommand("C:\\tools\\pi\\cli.js", "win32"), {
    command: process.execPath,
    prefixArgs: ["C:\\tools\\pi\\cli.js"],
  });
  assert.deepEqual(resolvePiCommand("/opt/pi/dist/cli.mjs", "linux"), {
    command: process.execPath,
    prefixArgs: ["/opt/pi/dist/cli.mjs"],
  });
  assert.deepEqual(resolvePiCommand("C:\\tools\\pi.cmd", "win32"), {
    command: "cmd.exe",
    prefixArgs: ["/d", "/s", "/c", "C:\\tools\\pi.cmd"],
  });
  assert.deepEqual(resolvePiCommand("/usr/local/bin/pi", "darwin"), {
    command: "/usr/local/bin/pi",
    prefixArgs: [],
  });
  assert.deepEqual(resolvePiCommand(undefined, "win32"), {
    command: "cmd.exe",
    prefixArgs: ["/d", "/s", "/c", "pi"],
  });
  assert.deepEqual(resolvePiCommand(undefined, "linux"), { command: "pi", prefixArgs: [] });
});

test("start（fake spawn）：spawn 参数序列与选项严格按冻结顺序构造", () => {
  const tmp = makeTempDir("am-args-");
  const fake = makeFakeSpawn();
  let seq = 0;
  const runner = makeRunner(fake, {
    now: () => T0,
    makeId: () => `run-${String(++seq).padStart(4, "0")}`,
  });
  try {
    const resumed = runner.start({
      cwd: tmp,
      prompt: "do it",
      model: "p/m",
      name: "worker",
      kind: "resume",
      sessionRef: "sess-42",
    });
    assert.equal(resumed.ok, true);
    assert.equal(fake.records[0].command, "pi");
    assert.deepEqual(fake.records[0].args, [
      "--mode", "json", "-p",
      "--model", "p/m",
      "--name", "worker",
      "--session", "sess-42",
      "do it",
    ]);
    const options = fake.records[0].options;
    assert.equal(options.cwd, tmp);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.detached, process.platform !== "win32");

    const forked = runner.start({ cwd: tmp, prompt: "again", kind: "fork", sessionRef: "sess-42" });
    assert.equal(forked.ok, true);
    assert.deepEqual(fake.records[1].args, [
      "--mode", "json", "-p",
      "--name", "agent-manager-run-0002",
      "--fork", "sess-42",
      "again",
    ]);

    const fresh = runner.start({ cwd: tmp, prompt: "fresh", kind: "new" });
    assert.equal(fresh.ok, true);
    assert.deepEqual(fake.records[2].args, [
      "--mode", "json", "-p",
      "--name", "agent-manager-run-0003",
      "fresh",
    ]);
  } finally {
    removeTempDir(tmp);
  }
});

test("json 事件归约：sessionId 捕获 / 行类型 / lastText / 2000 截断 / 坏行跳过", () => {
  const tmp = makeTempDir("am-json-");
  const fake = makeFakeSpawn();
  const runner = makeRunner(fake, { now: () => T0, makeId: () => "run00001" });
  try {
    const started = runner.start({ cwd: tmp, prompt: "hi", kind: "new" });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const id = started.value.id;
    const child = fake.children[0];

    emitJson(child, { type: "session", id: "sess-9" });
    child.emitStdout("这不是 JSON 的行\n");
    emitJson(child, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } });

    const longText = "x".repeat(2500);
    emitJson(child, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: longText }] } });

    const replyLine = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "reply text" }] },
    });
    child.emitStdout(replyLine.slice(0, 10));
    child.emitStdout(`${replyLine.slice(10)}\n`);

    emitJson(child, { type: "tool_execution_start", toolName: "bash", args: { command: "ls -la" } });
    emitJson(child, {
      type: "tool_execution_end",
      toolName: "bash",
      result: { content: [{ type: "text", text: "file1\nfile2" }] },
    });
    child.emitStderr("boom happened\n");
    emitJson(child, { type: "agent_end" });
    child.emitClose(0);

    const record = runner.get(id);
    assert.equal(record?.sessionId, "sess-9");
    assert.equal(record?.status, "exited");
    assert.equal(record?.exitCode, 0);
    assert.equal(record?.endedAt, T0);
    assert.equal(record?.lastText, "reply text");

    const output = runner.output(id);
    assert.ok(output);
    assert.deepEqual(
      output.lines.map((line) => line.kind),
      ["user", "assistant", "assistant", "tool", "tool", "error", "info"],
    );
    assert.deepEqual(
      output.lines.map((line) => line.seq),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(output.lines[0].text, "hi");
    assert.equal(output.lines[1].text.length, 2000);
    assert.equal(output.lines[2].text, "reply text");
    assert.ok(output.lines[3].text.includes("bash"));
    assert.ok(output.lines[3].text.includes("ls -la"));
    assert.ok(output.lines[4].text.includes("file1 file2"));
    assert.equal(output.lines[5].text, "boom happened");
    assert.equal(output.total, 7);
  } finally {
    removeTempDir(tmp);
  }
});

test("start 校验（BAD_SPEC）：空 prompt / cwd 不存在 / resume 无 ref / new 带 ref 均不 spawn", () => {
  const tmp = makeTempDir("am-spec-");
  const fake = makeFakeSpawn();
  const runner = makeRunner(fake);
  try {
    const cases: Array<{ label: string; spec: AgentStartSpec }> = [
      { label: "空 prompt", spec: { cwd: tmp, prompt: "   ", kind: "new" } },
      { label: "cwd 不存在", spec: { cwd: path.join(tmp, "missing"), prompt: "x", kind: "new" } },
      { label: "resume 无 sessionRef", spec: { cwd: tmp, prompt: "x", kind: "resume" } },
      { label: "fork 无 sessionRef", spec: { cwd: tmp, prompt: "x", kind: "fork" } },
      { label: "new 带 sessionRef", spec: { cwd: tmp, prompt: "x", kind: "new", sessionRef: "s1" } },
    ];
    for (const item of cases) {
      const result = runner.start(item.spec);
      assert.equal(result.ok, false, item.label);
      if (!result.ok) assert.equal(result.code, AgentErrorCodes.BAD_SPEC, item.label);
    }
    assert.equal(fake.records.length, 0);
    assert.equal(runner.list().length, 0);
  } finally {
    removeTempDir(tmp);
  }
});

test("start spawn 同步抛错 → ok:true + status failed 记录，不炸调用方；异步 error 同", () => {
  const tmp = makeTempDir("am-spawn-");
  const fake = makeFakeSpawn();
  let seq = 0;
  const runner = makeRunner(fake, { now: () => T0, makeId: () => `run-${++seq}` });
  try {
    fake.spawnError = new Error("spawn pi ENOENT");
    const failed = runner.start({ cwd: tmp, prompt: "x", kind: "new" });
    assert.equal(failed.ok, true);
    if (!failed.ok) return;
    assert.equal(failed.value.status, "failed");
    assert.ok(failed.value.error?.includes("ENOENT"));
    assert.equal(runner.get(failed.value.id)?.status, "failed");
    const firstOutput = runner.output(failed.value.id);
    assert.equal(firstOutput?.lines[0]?.kind, "error");
    assert.ok(firstOutput?.lines[0]?.text.includes("ENOENT"));

    fake.spawnError = undefined;
    const started = runner.start({ cwd: tmp, prompt: "y", kind: "new" });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    fake.children[0].emitError(new Error("EACCES: 无权限"));
    assert.equal(runner.get(started.value.id)?.status, "failed");
    assert.ok(runner.get(started.value.id)?.error?.includes("EACCES"));
  } finally {
    removeTempDir(tmp);
  }
});

test("output 增量语义：seq 单调、since 过滤、环形丢最旧后 total 单调", () => {
  const tmp = makeTempDir("am-output-");
  const fake = makeFakeSpawn();
  const runner = makeRunner(fake, { maxOutputLines: 3, now: () => T0, makeId: () => "run00001" });
  try {
    const started = runner.start({ cwd: tmp, prompt: "x", kind: "new" });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const child = fake.children[0];
    for (let i = 1; i <= 5; i++) {
      emitJson(child, { type: "message_end", message: { role: "user", content: [{ type: "text", text: `line-${i}` }] } });
    }

    const all = runner.output(started.value.id);
    assert.ok(all);
    assert.equal(all.total, 5);
    assert.deepEqual(all.lines.map((line) => line.seq), [3, 4, 5]);
    assert.deepEqual(all.lines.map((line) => line.text), ["line-3", "line-4", "line-5"]);

    const since3 = runner.output(started.value.id, 3);
    assert.ok(since3);
    assert.equal(since3.total, 5);
    assert.deepEqual(since3.lines.map((line) => line.seq), [4, 5]);

    const sinceLatest = runner.output(started.value.id, 5);
    assert.ok(sinceLatest);
    assert.deepEqual(sinceLatest.lines, []);
    assert.equal(sinceLatest.total, 5);

    assert.equal(runner.output("missing"), undefined);
  } finally {
    removeTempDir(tmp);
  }
});

test("stop：注入 killTree 被调用、close 后 stopped；未知 → NOT_FOUND；已退出 → NOT_RUNNING", async () => {
  const tmp = makeTempDir("am-stop-");
  const fake = makeFakeSpawn();
  const killed: number[] = [];
  let seq = 0;
  const runner = makeRunner(fake, {
    now: () => T0,
    makeId: () => `run-${++seq}`,
    killTree: async (pid) => {
      killed.push(pid);
      fake.children[0].emitClose(0);
    },
  });
  try {
    const missing = await runner.stop("missing");
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, AgentErrorCodes.NOT_FOUND);

    const started = runner.start({ cwd: tmp, prompt: "x", kind: "new" });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const pid = started.value.pid;
    assert.equal(typeof pid, "number");
    const stopped = await runner.stop(started.value.id);
    assert.equal(stopped.ok, true);
    if (stopped.ok) assert.equal(stopped.value.status, "stopped");
    assert.deepEqual(killed, [pid]);
    assert.equal(runner.get(started.value.id)?.status, "stopped");
    assert.equal(runner.get(started.value.id)?.exitCode, 0);

    const again = await runner.stop(started.value.id);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.code, AgentErrorCodes.NOT_RUNNING);

    const second = runner.start({ cwd: tmp, prompt: "y", kind: "new" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    fake.children[1].emitClose(0);
    const exited = await runner.stop(second.value.id);
    assert.equal(exited.ok, false);
    if (!exited.ok) assert.equal(exited.code, AgentErrorCodes.NOT_RUNNING);
  } finally {
    removeTempDir(tmp);
  }
});

test("list：运行中在前、启动时间倒序、退出记录保留最近 50 条", () => {
  const tmp = makeTempDir("am-list-");
  const fake = makeFakeSpawn();
  let idSeq = 0;
  let clock = 0;
  const runner = makeRunner(fake, {
    makeId: () => `run-${String(++idSeq).padStart(4, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 11, 0, 0, clock++)).toISOString(),
  });
  try {
    for (let i = 0; i < 55; i++) {
      const result = runner.start({ cwd: tmp, prompt: `p${i}`, kind: "new" });
      assert.equal(result.ok, true);
    }
    // 前 52 条退出（每次退出触发历史上限裁剪），后 3 条保持运行。
    for (let i = 0; i < 52; i++) fake.children[i].emitClose(0);

    const records = runner.list();
    const running = records.filter((record) => record.status === "running");
    const finished = records.filter((record) => record.status !== "running");
    assert.deepEqual(running.map((record) => record.id), ["run-0055", "run-0054", "run-0053"]);
    assert.equal(finished.length, 50);
    assert.equal(finished[0].id, "run-0052");
    assert.equal(records.some((record) => record.id === "run-0001"), false);
    assert.equal(records.some((record) => record.id === "run-0002"), false);
    assert.equal(records.some((record) => record.id === "run-0003"), true);
  } finally {
    removeTempDir(tmp);
  }
});

test("真实进程树停止：defaultKillTree 杀掉 stub pi 及其孙进程", async () => {
  const tmp = makeTempDir("am-tree-");
  const pidFile = path.join(tmp, "grand.pid");
  const stubPath = writeStubPi(tmp, "tree-stub.mjs");
  const runner = new AgentRunner({
    invocation: { command: process.execPath, prefixArgs: [stubPath] },
    env: { AM_STUB_PID_FILE: pidFile },
  });
  let parentPid: number | undefined;
  try {
    const started = runner.start({ cwd: tmp, prompt: "tree", kind: "new" });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const pid = started.value.pid;
    assert.equal(typeof pid, "number");
    if (typeof pid !== "number") return;
    parentPid = pid;

    await waitFor(() => fs.existsSync(pidFile), 10000, "stub 孙进程 pid 文件");
    const grandPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(grandPid) && grandPid > 0, "孙进程 pid 有效");
    assert.equal(isAlive(pid), true, "停前父进程存活");
    assert.equal(isAlive(grandPid), true, "停前孙进程存活");

    await defaultKillTree(pid);

    await waitFor(() => !isAlive(pid) && !isAlive(grandPid), 10000, "父子进程都退出");
  } finally {
    await bestEffortTreeKill(parentPid);
    removeTempDir(tmp);
  }
});

test("真实 stub-pi 全链路：start→output 可见→stop→进程树清", async () => {
  const tmp = makeTempDir("am-e2e-");
  const pidFile = path.join(tmp, "grand.pid");
  const stubPath = writeStubPi(tmp, "full-stub.mjs", {
    sessionId: "stub-session-1",
    assistantText: "stub reply",
  });
  const runner = new AgentRunner({
    invocation: { command: process.execPath, prefixArgs: [stubPath] },
    env: { AM_STUB_PID_FILE: pidFile },
  });
  let parentPid: number | undefined;
  try {
    const started = runner.start({ cwd: tmp, prompt: "hello", kind: "new" });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const id = started.value.id;
    const pid = started.value.pid;
    assert.equal(typeof pid, "number");
    if (typeof pid !== "number") return;
    parentPid = pid;

    await waitFor(() => runner.get(id)?.sessionId === "stub-session-1", 10000, "sessionId 捕获");
    await waitFor(
      () =>
        (runner.output(id)?.lines ?? []).some(
          (line) => line.kind === "assistant" && line.text.includes("stub reply"),
        ),
      10000,
      "assistant 输出行可见",
    );
    assert.equal(runner.get(id)?.lastText, "stub reply");
    assert.equal(runner.get(id)?.status, "running");

    await waitFor(() => fs.existsSync(pidFile), 10000, "stub 孙进程 pid 文件");
    const grandPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(grandPid) && grandPid > 0, "孙进程 pid 有效");

    const stopped = await runner.stop(id);
    assert.equal(stopped.ok, true);

    await waitFor(() => runner.get(id)?.status === "stopped", 10000, "状态 stopped");
    await waitFor(() => !isAlive(pid) && !isAlive(grandPid), 10000, "父子进程都退出");
  } finally {
    await bestEffortTreeKill(parentPid);
    removeTempDir(tmp);
  }
});
