/*
 * timeout-bg — 真机 opt-in 用例（真实 spawn + 真实计时器 + 真实日志文件）。
 *
 * 为什么单独一层：其余用例 fake 了 spawn（进程边界替身），而「主动后台」承诺的是**真进程**行为——
 * 调用立刻返回、进程真的还活着、日志真的继续长、退出真的触发通知。纸面替身测不出「登记早于退出」
 * 「日志流没提前关」这两件事。默认跳过，显式开：
 *
 *   PI_TIMEOUT_BG_TEST_LIVE=1
 *
 * 前提：本机能跑 shell（Windows 用 PATH 上的 `bash`，其余平台用 `/bin/sh`）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createJobRegistry, type JobRecord } from "../jobs.ts";
import { createTimeoutOps, type SpawnLike, type TimeoutMode } from "../shell-ops.ts";

const live = process.env.PI_TIMEOUT_BG_TEST_LIVE === "1" ? false : "未设置 PI_TIMEOUT_BG_TEST_LIVE=1（真机 opt-in）";

/** 真机 shell 配置：Windows 走 PATH 上的 bash（git bash），其余平台走 /bin/sh。 */
function realShell(): { shell: string; args: string[] } {
  return process.platform === "win32" ? { shell: "bash", args: ["-lc"] } : { shell: "/bin/sh", args: ["-c"] };
}

function makeOps(mode: TimeoutMode, logRoot: string) {
  const exits: JobRecord[] = [];
  let seq = 0;
  const registry = createJobRegistry({ now: Date.now, killTree: () => {}, onExit: (job) => exits.push(job) });
  const ops = createTimeoutOps({
    spawn: ((file: string, args: readonly string[], options: never) => spawn(file, [...args], options)) as unknown as SpawnLike,
    shellConfig: () => ({ ...realShell(), commandTransport: "argv" as const }),
    shellName: "bash",
    registry,
    killTree: () => {},
    newJobId: () => `bg-${++seq}`,
    logRoot,
    defaultTimeoutSeconds: 300,
    platform: process.platform,
    mode,
  });
  return { ops, registry, exits };
}

const waitUntil = async (check: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !check()) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(check(), "等待超时");
};

test("真机：run_in_background 立即返回（不等命令跑完）；进程继续跑、日志继续长、退出收通知", { skip: live }, async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-bg-live-"));
  const h = makeOps("background", logRoot);

  const started = Date.now();
  const error = await h.ops
    .exec("sleep 3; echo REAL-DONE", process.cwd(), { onData: () => {}, env: process.env })
    .then(
      () => null,
      (e: unknown) => e as Error,
    );
  const elapsed = Date.now() - started;

  assert.ok(error !== null, "主动后台以错误结束本次调用");
  assert.match(error.message, /已直接转入后台运行/);
  assert.doesNotMatch(error.message, /超时/);
  assert.ok(elapsed < 1_500, `必须立刻返回（实际 ${elapsed}ms；命令要跑 3 秒）`);

  const job = h.registry.list()[0];
  assert.ok(job !== undefined);
  assert.equal(job.origin, "background");
  assert.ok(fs.existsSync(path.dirname(job.logPath)), "日志目录在登记时就绪（文件由写入流异步建，不等它）");

  await waitUntil(() => h.registry.get(job.id)!.status === "exited", 15_000);
  assert.equal(h.registry.get(job.id)!.exitCode, 0);
  assert.match(fs.readFileSync(job.logPath, "utf8"), /REAL-DONE/, "输出继续落盘（日志流没提前关）");
  assert.deepEqual(h.exits.map((j) => j.id), [job.id], "自然结束恰好发一次完成通知");
});

test("真机：超时路径同样转后台（默认超时 1s，命令跑到结束），两者共用同一条收尾路径", { skip: live }, async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-bg-live-timeout-"));
  const h = makeOps("timeout", logRoot);

  const error = await h.ops
    .exec("sleep 2; echo TIMEOUT-DONE", process.cwd(), { onData: () => {}, env: process.env, timeout: 1 })
    .then(
      () => null,
      (e: unknown) => e as Error,
    );
  assert.match(error?.message ?? "", /命令超时（1 秒）/);
  const job = h.registry.list()[0]!;
  assert.equal(job.origin, "timeout", "来源区分：超时转后台");

  await waitUntil(() => h.registry.get(job.id)!.status === "exited", 15_000);
  assert.equal(h.registry.get(job.id)!.exitCode, 0);
  assert.match(fs.readFileSync(job.logPath, "utf8"), /TIMEOUT-DONE/);
});
