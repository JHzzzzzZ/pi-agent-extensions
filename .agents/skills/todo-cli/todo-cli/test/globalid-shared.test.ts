/**
 * todo-cli/globalid-shared.test.ts — 全局 id 计数器的跨检出共享与旧布局折叠（todo-cli-todo:18）。
 *
 * 为什么必须真实 git：共享位置由 `git rev-parse --git-common-dir` 决定，真实 worktree 的
 * `.git` 指针 / commondir 不是纸面替身能代表的。本文件用真实 `git init` + `git worktree add`
 * 的临时仓库，交替在两个 cwd 下 spawn CLI 取号（#18 的复现步骤：主仓 add → worktree add →
 * 主仓 add），另用进程内调用覆盖目录解析（git 根 / 仓库子目录 / 非 git 根）与旧布局折叠。
 *
 * 锁定的不变量：主仓库与 worktree 共享同一份计数器与同一把 id 锁（同目录，锁跟着计数器走）；
 * 发号前对齐全台账（max(计数器, 台账 max+1)）；升级前的 `todos/.todo-cli/next-id` 按 max
 * 语义折叠进新位置；非 git 根 fail-soft 回退旧路径（不炸）；每文件锁仍按检出各自持有。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { allocateGlobalId, globalIdCounterFile, globalIdLockFile, globalIdRuntimeDir } from "../globalid.ts";
import { emptyTodoData, serializeTodo } from "../schema.ts";
import type { TodoEntry } from "../schema.ts";

/** 工具目录（入口 + 实现同居）：测试文件的上一级。 */
const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 拷进 fixture 的文件：入口 + 全部实现模块（test/ 不拷；按目录枚举，新增模块自动带上）。 */
function toolFiles(): string[] {
  return ["todo.mjs", ...fs.readdirSync(TOOL_DIR).filter((name) => name.endsWith(".ts"))];
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PI_AGENT_TEAM_FILE;
  delete env.PI_AGENT_TEAM_NAME;
  delete env.PI_AGENT_TEAM_RUN_ID;
  return env;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function seedEntries(): TodoEntry[] {
  return [1, 2].map((id) => ({
    id,
    globalId: id,
    text: `种子条目 ${id}`,
    status: "open",
    branch: null,
    tags: [],
    priority: 5,
    dependsOn: [],
    notes: [],
    createdAt: null,
    claimedAt: null,
    completedAt: null,
    alignedAt: null,
  }));
}

/** 真实 git 仓库 fixture：工具 + 种子台账已提交（worktree 检出才拿得到它们）。 */
function makeGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-shared-"));
  const toolDir = path.join(root, ".agents", "skills", "todo-cli", "todo-cli");
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.mkdirSync(toolDir, { recursive: true });
  for (const file of toolFiles()) fs.copyFileSync(path.join(TOOL_DIR, file), path.join(toolDir, file));
  fs.writeFileSync(path.join(root, "todos", "general-todo.json"), serializeTodo({ ...emptyTodoData("general-todo"), entries: seedEntries() }));
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "seed"]);
  return root;
}

/** 轻量 git 仓库（只要 .git，供目录解析/折叠用例）。 */
function makePlainGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-shared-git-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  git(root, ["init", "-q"]);
  return root;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 在指定检出内跑 CLI（不给 --root：走 git 自动发现，与真实用法同形）。 */
function runCli(checkout: string, args: string[], timeoutMs = 60_000): CliResult {
  const cli = path.join(checkout, ".agents", "skills", "todo-cli", "todo-cli", "todo.mjs");
  const res = spawnSync(process.execPath, [cli, ...args], { cwd: checkout, encoding: "utf8", timeout: timeoutMs, env: cleanEnv() });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function globalIdOf(checkout: string, text: string): number {
  const raw = fs.readFileSync(path.join(checkout, "todos", "general-todo.json"), "utf8");
  const parsed = JSON.parse(raw) as { entries: Array<{ text: string; globalId: number | null }> };
  const entry = parsed.entries.find((item) => item.text === text);
  assert.ok(entry !== undefined, `找不到条目：${text}`);
  assert.equal(typeof entry.globalId, "number", `条目必须带 globalId：${text}`);
  return entry.globalId as number;
}

function leftoverLocks(checkout: string): string[] {
  const dir = path.join(checkout, "todos", ".todo-cli", "locks");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test("共享计数器：真实 worktree 与主仓库交替取号互不重复，计数器与 id 锁落在 git 公共目录", { timeout: 120_000 }, (t) => {
  const root = makeGitRepo();
  const wt = path.join(root, ".worktrees", "wt");
  t.after(() => removeRoot(root));
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(root, ["worktree", "add", "-b", "feat/wt", wt]);

  // #18 复现步骤：主仓 add → worktree add → 主仓 add（升级前 worktree 无计数器，自愈重发主仓的号）
  const first = runCli(root, ["add", "--file", "general", "主仓库第一条取号"]);
  assert.equal(first.code, 0, `主仓 add 应 exit 0（stdout=${first.stdout} stderr=${first.stderr}）`);
  const second = runCli(wt, ["add", "--file", "general", "worktree 第二条取号"]);
  assert.equal(second.code, 0, `worktree add 应 exit 0（stdout=${second.stdout} stderr=${second.stderr}）`);
  const third = runCli(root, ["add", "--file", "general", "主仓库第三条取号"]);
  assert.equal(third.code, 0, `主仓再 add 应 exit 0（stdout=${third.stdout} stderr=${third.stderr}）`);

  const issued = [globalIdOf(root, "主仓库第一条取号"), globalIdOf(wt, "worktree 第二条取号"), globalIdOf(root, "主仓库第三条取号")];
  assert.equal(new Set(issued).size, 3, `两检出交替取号必须互不重复（撞号时出现同号）：${issued.join(",")}`);
  assert.deepEqual(issued, [3, 4, 5], "共享同一份号源：3 / 4 / 5 连续推进");

  const sharedCounter = path.join(root, ".git", "todo-cli", "next-id");
  assert.equal(fs.existsSync(sharedCounter), true, `计数器必须落在 git 公共目录：${sharedCounter}`);
  assert.equal(fs.readFileSync(sharedCounter, "utf8"), "6\n", "计数器 = 全台账 max(globalId)+1");
  for (const checkout of [root, wt]) {
    assert.equal(fs.existsSync(path.join(checkout, "todos", ".todo-cli", "next-id")), false, `旧位置不再写计数器：${checkout}`);
    assert.deepEqual(leftoverLocks(checkout), [], `收尾不得残留每文件锁：${checkout}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, ".git", "todo-cli", "locks")), [], "id 锁收尾不残留（与计数器同目录）");
});

test("共享布局：计数器与 id 锁同源（git 公共目录下）；仓库子目录与非 git 根 fail-soft 回退旧路径", (t) => {
  const root = makePlainGitRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-shared-plain-"));
  t.after(() => {
    removeRoot(root);
    removeRoot(plain);
  });
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });

  const shared = path.resolve(root, ".git", "todo-cli");
  assert.equal(path.resolve(globalIdRuntimeDir(root)), shared, "git 根：共享目录 = <git-common-dir>/todo-cli");
  assert.equal(globalIdCounterFile(root), path.join(shared, "next-id"));
  assert.equal(globalIdLockFile(root), path.join(shared, "locks", "id.lock"));
  assert.equal(
    path.dirname(globalIdCounterFile(root)),
    path.dirname(path.dirname(globalIdLockFile(root))),
    "锁必须跟着计数器走：两者同源（同一目录）",
  );

  const sub = path.join(root, "sub");
  assert.equal(
    path.resolve(globalIdRuntimeDir(sub)),
    path.resolve(sub, "todos", ".todo-cli"),
    "仓库子目录不是仓库根：fail-soft 回退检出内的旧路径",
  );
  assert.equal(
    path.resolve(globalIdRuntimeDir(plain)),
    path.resolve(plain, "todos", ".todo-cli"),
    "非 git 根：fail-soft 回退旧路径（不炸）",
  );
});

test("旧布局折叠：升级前的 todos/.todo-cli/next-id 按 max 语义并入新位置并清掉旧文件", (t) => {
  const root = makePlainGitRepo();
  t.after(() => removeRoot(root));
  const legacy = path.join(root, "todos", ".todo-cli", "next-id");
  const shared = path.join(root, ".git", "todo-cli", "next-id");
  fs.writeFileSync(path.join(root, "todos", "a-todo.json"), serializeTodo({ ...emptyTodoData("a-todo"), entries: seedEntries() }));

  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "41\n");
  assert.deepEqual(allocateGlobalId(root), { ok: true, value: 41 }, "共享计数器缺失：旧文件的值必须被折叠（不能忽略）");
  assert.equal(fs.readFileSync(shared, "utf8"), "42\n", "折叠进新位置并推进");
  assert.equal(fs.existsSync(legacy), false, "折叠后清掉旧文件（值已并入新位置）");
  assert.deepEqual(allocateGlobalId(root), { ok: true, value: 42 }, "折叠后不倒退");

  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "10\n");
  assert.deepEqual(allocateGlobalId(root), { ok: true, value: 43 }, "共享计数器更高时以共享为准（旧文件只参与取 max）");
  assert.equal(fs.existsSync(legacy), false, "陈旧旧文件同样被清掉");
});
