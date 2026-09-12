/**
 * todo-cli/lock.test.ts — 跨进程写锁 + 原子写的边界单测（方案 C，todos/todo-cli-todo.md:17）。
 *
 * 为什么必须真实进程/真实文件系统：互斥（O_EXCL）、stale 抢占、exit 释放、temp+rename
 * 原子性都发生在 fs/进程边界上，单进程注入测不出。持锁对手进程用 store.test.ts 同款
 * 「子进程 Atomics.wait 持锁」模式。时间与存活探测可注入，保证 stale 用例确定性。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { atomicWriteFile, lockFileFor, withTodoLock } from "../lock.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_URL = pathToFileURL(path.join(REPO_ROOT, "todo-cli", "lock.ts")).href;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-lock-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.mkdirSync(path.join(root, "todos", ".todo-cli", "locks"), { recursive: true });
  return root;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PI_AGENT_TEAM_FILE;
  delete env.PI_AGENT_TEAM_NAME;
  delete env.PI_AGENT_TEAM_RUN_ID;
  return env;
}

test("withTodoLock：acquire/release 幂等，锁文件随释放消失；重入同进程直接放行", () => {
  const root = makeRoot();
  const lockPath = lockFileFor(root, "general-todo");
  const first = withTodoLock(root, "general-todo", () => {
    assert.ok(fs.existsSync(lockPath), "持锁期间锁文件存在");
    // 同进程重入：不再走 fs 竞争，直接执行
    const inner = withTodoLock(root, "general-todo", () => "inner");
    assert.deepEqual(inner, { ok: true, value: "inner" });
    return "outer";
  });
  assert.deepEqual(first, { ok: true, value: "outer" });
  assert.equal(fs.existsSync(lockPath), false, "释放后锁文件消失");
});

test("withTodoLock：临界区抛错也必须释放锁（错误原样重抛）", () => {
  const root = makeRoot();
  const lockPath = lockFileFor(root, "general-todo");
  assert.throws(() => withTodoLock(root, "general-todo", () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(fs.existsSync(lockPath), false, "异常后锁已释放");
  const again = withTodoLock(root, "general-todo", () => 1);
  assert.equal(again.ok, true, "释放后可重新获取");
});

test("withTodoLock：他人持锁（存活 pid、新鲜时间）→ 等到 deadline 超时退出 1 路径", () => {
  const root = makeRoot();
  const lockPath = lockFileFor(root, "general-todo");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const start = Date.now();
  const result = withTodoLock(
    root,
    "general-todo",
    () => "never",
    { alive: () => true, staleMs: 60_000, deadlineMs: 300, sleep: () => {} },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "LOCK_TIMEOUT");
    assert.match(result.message, /忙/);
  }
  assert.ok(Date.now() - start < 10_000, "有界等待，不无限挂起");
  assert.ok(fs.existsSync(lockPath), "他人锁不被误删");
});

test("withTodoLock：pid 已死 → 残留锁被抢占", () => {
  const root = makeRoot();
  const lockPath = lockFileFor(root, "general-todo");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, startedAt: Date.now() }));
  const result = withTodoLock(root, "general-todo", () => "taken", {});
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, "taken");
});

test("withTodoLock：锁内容损坏（半态文件）按残留处理，可抢占", () => {
  const root = makeRoot();
  fs.writeFileSync(lockFileFor(root, "general-todo"), "<partial>");
  const result = withTodoLock(root, "general-todo", () => "ok", {});
  assert.equal(result.ok, true);
});

test("withTodoLock：持锁者存活但超过 stale 阈值 → 抢占（时钟注入）", () => {
  const root = makeRoot();
  const lockPath = lockFileFor(root, "general-todo");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 1_000 }));
  const result = withTodoLock(
    root,
    "general-todo",
    () => "stale-taken",
    { alive: () => true, staleMs: 60_000, now: () => Date.now(), deadlineMs: 200, sleep: () => {} },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, "stale-taken");
});

test("真实子进程持锁：对手进程持锁期间本进程超时；对手退出（exit handler）锁消失后可立即获取", { timeout: 60_000 }, async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const script = [
    `import { withTodoLock } from ${JSON.stringify(LOCK_URL)};`,
    `withTodoLock(process.env.TODO_LOCK_ROOT, "general-todo", () => {`,
    `  console.log("LOCKED");`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TODO_LOCK_HOLD_MS));`,
    `});`,
    `process.exit(0);`,
  ].join("\n");
  const env = { ...cleanEnv(), TODO_LOCK_ROOT: root, TODO_LOCK_HOLD_MS: "4000" };
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const locked = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子进程未在 20s 内持锁：${stdout}`)), 20_000);
    child.stdout?.on("data", () => {
      if (stdout.includes("LOCKED")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
  });
  await locked;

  const blocked = withTodoLock(root, "general-todo", () => "x", {
    alive: () => true,
    staleMs: 60_000,
    deadlineMs: 300,
    sleep: () => {},
  });
  assert.equal(blocked.ok, false, "对手持锁期间必须超时");

  const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  const code = await done;
  assert.equal(code, 0, "持锁子进程正常退出");
  assert.equal(fs.existsSync(lockFileFor(root, "general-todo")), false, "exit handler 必须清掉自持锁");

  const after = withTodoLock(root, "general-todo", () => "free", {});
  assert.equal(after.ok, true, "对手退出后立即可获取");
});

test("atomicWriteFile：temp+rename 原子替换，失败清自己的 tmp；过期 tmp 由下次写入清理", () => {
  const root = makeRoot();
  const tmpDir = path.join(root, "todos", ".todo-cli", "tmp");
  const target = path.join(root, "todos", "a-todo.json");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(target, "old");

  atomicWriteFile(target, '{"version":1}', { tmpDir });
  assert.equal(fs.readFileSync(target, "utf8"), '{"version":1}');
  assert.deepEqual(fs.readdirSync(tmpDir), [], "成功写入不残留 tmp");

  // 过期残留：拨旧 mtime 后一次成功写入应清掉
  const residue = path.join(tmpDir, "a-todo.json.123.deadbeef.tmp");
  fs.writeFileSync(residue, "junk");
  const aged = Date.now() / 1000 - 11 * 60;
  fs.utimesSync(residue, aged, aged);
  atomicWriteFile(target, '{"version":2}', { tmpDir });
  assert.deepEqual(fs.readdirSync(tmpDir), [], "过期 tmp 被清理");

  // 写失败（目标目录被文件占用模拟不可行——用非法路径触发）时清自己的 tmp
  const badTarget = path.join(root, "no-such-dir", "x.json");
  assert.throws(() => atomicWriteFile(badTarget, "x", { tmpDir }));
});
