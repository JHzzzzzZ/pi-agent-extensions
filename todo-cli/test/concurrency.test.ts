/**
 * todo-cli 并发写边界测试（方案 C 重写版）。
 *
 * 为什么必须真实进程 + 真实文件系统：跨进程锁互斥、丢更新在单进程注入下不可见——
 * 本文件把 `todo-cli/` 与 `tools/todo.mjs` 拷进真实临时仓库 fixture，用
 * `node tools/todo.mjs add/claim` 驱动 N 个真实子进程同时读改写同一 JSON 文件。
 * 锁（lock.ts，O_EXCL + 重试）串行化临界区：并发全落、stderr 恒空、收尾无锁残留。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { emptyTodoData, parseTodoJson, serializeTodo } from "../schema.ts";
import type { TodoEntry } from "../schema.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 2000 条种子条目：把每次读改写的 parse+stringify 窗口拉到毫秒级，让无锁实现必丢更新。
const SEED_ENTRIES = 2000;

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PI_AGENT_TEAM_FILE;
  delete env.PI_AGENT_TEAM_NAME;
  delete env.PI_AGENT_TEAM_RUN_ID;
  return env;
}

function seedEntries(): TodoEntry[] {
  const entries: TodoEntry[] = [];
  for (let i = 0; i < SEED_ENTRIES; i += 1) {
    entries.push({
      id: i + 1,
      text: `种子条目 ${String(i).padStart(4, "0")} 供并发测试使用`,
      status: "open",
      branch: null,
      tags: [],
      notes: [],
      createdAt: null,
      claimedAt: null,
      completedAt: null,
    });
  }
  return entries;
}

/** 真实临时仓库 fixture：自带 tools/todo.mjs + todo-cli/，REPO_ROOT 由脚本位置解析到 fixture。 */
function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-concurrency-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "todo-cli"), path.join(root, "todo-cli"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "tools", "todo.mjs"), path.join(root, "tools", "todo.mjs"));
  const data = { ...emptyTodoData("general-todo"), entries: seedEntries() };
  fs.writeFileSync(path.join(root, "todos", "general-todo.json"), serializeTodo(data));
  return root;
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function runCli(root: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "tools", "todo.mjs"), ...args], {
      cwd: root,
      env: cleanEnv(),
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => resolve({ code: -1, signal: null, stdout, stderr }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function readJson(root: string) {
  const parsed = parseTodoJson(fs.readFileSync(path.join(root, "todos", "general-todo.json"), "utf8"), "test");
  assert.equal(parsed.ok, true, "并发结束后 JSON 必须可解析（原子写不留半态）");
  return parsed.ok ? parsed.data : null;
}

function leftoverLocks(root: string): string[] {
  const dir = path.join(root, "todos", ".todo-cli", "locks");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test("并发写：6 个真实子进程同时 add --file general，6 条全落、id 唯一、无锁残留", { timeout: 180_000 }, async (t) => {
  const root = makeFixture();
  t.after(() => removeFixture(root));

  const texts = Array.from({ length: 6 }, (_, i) => `并发新增条目 编号${i} 须完整落盘`);
  const results = await Promise.all(texts.map((text) => runCli(root, ["add", "--file", "general", text])));

  for (const [i, res] of results.entries()) {
    assert.equal(res.code, 0, `第 ${i} 个子进程 add 应 exit 0（stderr=${res.stderr.slice(0, 200)}）`);
    assert.equal(res.stderr, "", `第 ${i} 个子进程 stderr 应恒空`);
  }

  const data = readJson(root);
  const byText = new Map<string, number>();
  for (const entry of data.entries) byText.set(entry.text, (byText.get(entry.text) ?? 0) + 1);
  for (const text of texts) {
    assert.equal(byText.get(text), 1, `并发条目必须且只出现一次：${text}（实际 ${byText.get(text) ?? 0} 条）`);
  }
  const ids = new Set(data.entries.map((entry) => entry.id));
  assert.equal(ids.size, data.entries.length, "并发分配的 id 不得重复");
  assert.equal(data.entries.length, SEED_ENTRIES + 6, "6 条全部落盘（丢更新即失败）");
  assert.deepEqual(leftoverLocks(root), [], "收尾不得残留锁文件");
});

test("并发 claim：2 个真实子进程同时领取不同条目，两个分支引用都在", { timeout: 120_000 }, async (t) => {
  const root = makeFixture();
  t.after(() => removeFixture(root));

  const first = "种子条目 0001 供并发测试使用";
  const second = "种子条目 0002 供并发测试使用";
  const results = await Promise.all([
    runCli(root, ["claim", "--file", "general", "--match", first, "--branch", "feat/claim-a"]),
    runCli(root, ["claim", "--file", "general", "--match", second, "--branch", "feat/claim-b"]),
  ]);

  assert.equal(results[0].code, 0, `claim 甲 exit ${results[0].code}（stderr=${results[0].stderr.slice(0, 200)}）`);
  assert.equal(results[1].code, 0, `claim 乙 exit ${results[1].code}（stderr=${results[1].stderr.slice(0, 200)}）`);
  assert.equal(results[0].stderr, "");
  assert.equal(results[1].stderr, "");

  const data = readJson(root);
  const a = data.entries.find((entry) => entry.text === first);
  const b = data.entries.find((entry) => entry.text === second);
  assert.equal(a?.status, "processing");
  assert.equal(a?.branch, "feat/claim-a", "甲条目分支引用必须落盘（丢更新时缺失）");
  assert.equal(b?.status, "processing");
  assert.equal(b?.branch, "feat/claim-b", "乙条目分支引用必须落盘（丢更新时缺失）");
  assert.deepEqual(leftoverLocks(root), []);
});
