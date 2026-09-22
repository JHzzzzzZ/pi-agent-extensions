/**
 * shell-ops.ts 单测：把宿主的「超时即杀」换成「超时转后台」（timeout-bg-todo#1）
 *
 * 边界说明：真实被测逻辑 = 进程编排（spawn → 计时 → 输出落盘 → 退出/超时分流），
 * 因此只 fake 进程边界（spawn 出的子进程与 killTree），真实读写临时目录里的日志文件、
 * 真实计时器（毫秒级小超时）；不做"纸面替身"式断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJobRegistry, type JobRecord } from "../jobs.ts";
import { createTimeoutOps, type SpawnedProcess } from "../shell-ops.ts";

class FakeChild extends EventEmitter {
  pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin: { data: string | null; on: () => void; end: (text: string) => void } | null = null;

  constructor(pid: number, wantsStdin: boolean) {
    super();
    this.pid = pid;
    if (wantsStdin) this.stdin = { data: null, on: () => {}, end: (text) => (this.stdin!.data = text) };
  }

  emitData(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }

  exit(code: number | null): void {
    this.emit("exit", code, null);
  }
}

/**
 * 让 spawn 出的子进程由测试驱动：每次 exec 前用一个已建好的 FakeChild 接到 spawn 上
 * （只有一个子进程在飞，避免共享可变状态掩盖时序问题）。
 */
function harnessWithChild(options: { defaultSeconds?: number; commandTransport?: "argv" | "stdin" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-bg-op-"));
  const logDir = path.join(dir, "logs");
  const spawns: Array<{ file: string; args: readonly string[]; options: { cwd?: string; detached?: boolean } }> = [];
  const killCalls: number[] = [];
  const exits: JobRecord[] = [];
  let jobSeq = 1;
  const child = new FakeChild(4_242, options.commandTransport === "stdin");
  const jobs = createJobRegistry({ now: () => 1_000, killTree: (pid) => killCalls.push(pid), onExit: (job) => exits.push(job) });
  const ops = createTimeoutOps({
    spawn: ((file: string, args: readonly string[], spawnOptions: { cwd?: string; detached?: boolean }) => {
      spawns.push({ file, args, options: spawnOptions });
      return child as unknown as SpawnedProcess;
    }) as never,
    shellConfig: () => ({ shell: "bash", args: ["-lc"], commandTransport: options.commandTransport }),
    shellName: "bash",
    registry: jobs,
    killTree: (pid: number) => killCalls.push(pid),
    newJobId: () => `bg-${jobSeq++}`,
    logRoot: logDir,
    defaultTimeoutSeconds: options.defaultSeconds,
    platform: "linux",
  });
  return { ops, child, spawns, killCalls, exits, jobs, dir, logDir };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("超时前正常退出：resolve 退出码、输出透传与落盘，不杀进程、不进后台注册表", async () => {
  const h = harnessWithChild({ defaultSeconds: 300 });
  const chunks: string[] = [];
  const pending = h.ops.exec("echo hi", h.dir, { onData: (b: Buffer) => chunks.push(b.toString("utf8")), env: {} });
  h.child.emitData("hi\n");
  h.child.exit(0);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(chunks.join(""), "hi\n");
  assert.deepEqual(h.killCalls, []);
  assert.equal(h.jobs.list().length, 0, "正常结束的任务不进后台注册表");
  const logFile = path.join(h.logDir, String(process.pid), "bg-1.log");
  assert.equal(fs.readFileSync(logFile, "utf8"), "hi\n", "输出始终落盘（超时后要能接着看）");
});

test("命中超时：不杀进程，登记 running job，错误文本给出 job/pid/日志/秒数", async () => {
  const h = harnessWithChild({ defaultSeconds: 300 });
  const pending = h.ops.exec("sleep 400", h.dir, { onData: () => {}, timeout: 0.05, env: {} });
  const error = await pending.then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(error instanceof Error, "超时必须结束本次 tool call");
  const job = h.jobs.list()[0];
  assert.ok(job, "超时后任务进入后台注册表");
  assert.equal(job.status, "running");
  assert.equal(job.pid, 4_242);
  assert.match(error.message, /0\.05 秒/, "错误文本带超时秒数");
  assert.ok(error.message.includes(job.id), "错误文本带 jobId");
  assert.ok(error.message.includes(job.logPath), "错误文本带日志路径");
  assert.deepEqual(h.killCalls, [], "超时绝不杀进程");

  h.child.emitData("still running\n");
  await wait(30);
  assert.ok(fs.readFileSync(job.logPath, "utf8").includes("still running"), "超时后输出继续落盘");

  h.child.exit(3);
  await wait(30);
  assert.equal(h.jobs.get(job.id)!.status, "exited");
  assert.equal(h.jobs.get(job.id)!.exitCode, 3);
  assert.equal(h.exits.length, 1, "自然结束触发一次完成通知");
  assert.equal(h.exits[0]!.id, job.id);
});

test("未传 timeout：默认超时生效（同样转后台，不杀）", async () => {
  const h = harnessWithChild({ defaultSeconds: 0.05 });
  const error = await h.ops.exec("npm test", h.dir, { onData: () => {}, env: {} }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /0\.05 秒/);
  assert.equal(h.jobs.list().length, 1);
  assert.deepEqual(h.killCalls, []);
});

test("默认超时关闭（undefined）：不施加超时，等进程自然结束", async () => {
  const h = harnessWithChild({ defaultSeconds: undefined });
  const pending = h.ops.exec("sleep 400", h.dir, { onData: () => {}, env: {} });
  await wait(120);
  assert.equal(h.jobs.list().length, 0, "没有超时就不该转后台");
  h.child.exit(0);
  assert.equal((await pending).exitCode, 0);
  assert.deepEqual(h.killCalls, []);
});

test("abort（Esc）：杀进程树、不转后台、以 aborted 结束", async () => {
  const h = harnessWithChild({ defaultSeconds: 300 });
  const controller = new AbortController();
  const pending = h.ops.exec("sleep 400", h.dir, { onData: () => {}, signal: controller.signal, env: {} });
  controller.abort();
  h.child.exit(null);
  const error = await pending.then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.equal(error?.message, "aborted");
  assert.deepEqual(h.killCalls, [4_242], "用户主动取消仍然杀进程树");
  assert.equal(h.jobs.list().length, 0);
});

test("timeout 非法：不 spawn，直接 fail-closed", async () => {
  const h = harnessWithChild({ defaultSeconds: 300 });
  const error = await h.ops.exec("ls", h.dir, { onData: () => {}, timeout: 0, env: {} }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.match(error?.message ?? "", /Invalid timeout: must be a finite number of seconds/);
  assert.equal(h.spawns.length, 0);
});

test("工作目录不存在：沿用宿主文案拒绝执行（不 spawn）", async () => {
  const h = harnessWithChild({ defaultSeconds: 300 });
  const error = await h.ops.exec("ls", path.join(h.dir, "nope"), { onData: () => {}, env: {} }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.match(error?.message ?? "", /Working directory does not exist/);
  assert.equal(h.spawns.length, 0);
});

test("stdin 传输命令：argv 不带命令，命令写进 stdin（宿主 commandTransport 语义）", async () => {
  const h = harnessWithChild({ commandTransport: "stdin" });
  const pending = h.ops.exec("echo hi", h.dir, { onData: () => {}, env: {} });
  assert.deepEqual(h.spawns[0]!.args, ["-lc"]);
  assert.equal(h.child.stdin!.data, "echo hi");
  h.child.exit(0);
  await pending;
});
