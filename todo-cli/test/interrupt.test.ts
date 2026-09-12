/**
 * todo-cli 中断写边界测试（方案 C 重写版）。
 *
 * 覆盖（全部真实子进程 + 真实临时仓库 fixture）：
 *   - SIGKILL 循环杀 add：每轮后 JSON 必须是「旧版」或「完整新版」（temp+rename 原子
 *     替换，无半态）；被杀进程可能残留锁/pid 死锁文件 → 下一次写必须 stale 抢占成功；
 *   - tmp 残留只能来自被杀进程，过期（>10 分钟）后必须被下一次成功写入清理；
 *   - 末次 add 成功且 `list` 输出与 JSON 投影逐行一致。
 *
 * 击杀时机：本机（Windows / Node 24）`node tools/todo.mjs` 冷启动实测 ~400ms，随机
 * 区间取 [1, 1500]ms 覆盖启动/读改写/写回各阶段；无论命中哪个阶段，「旧版或完整新版」
 * 的断言都必须成立。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { emptyTodoData, parseTodoJson, serializeTodo } from "../schema.ts";
import type { TodoEntry, TodoFileData } from "../schema.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEED_ENTRIES = 200;
const STATUS_MARK: Record<string, string> = { done: "[x]", processing: "[~]", open: "[ ]" };

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
      text: `种子条目 ${String(i).padStart(3, "0")} 供中断测试使用`,
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

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-interrupt-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "todo-cli"), path.join(root, "todo-cli"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "tools", "todo.mjs"), path.join(root, "tools", "todo.mjs"));
  const data: TodoFileData = { ...emptyTodoData("general-todo"), entries: seedEntries() };
  fs.writeFileSync(path.join(root, "todos", "general-todo.json"), serializeTodo(data));
  return root;
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function cliPath(root: string): string {
  return path.join(root, "tools", "todo.mjs");
}

function jsonPath(root: string): string {
  return path.join(root, "todos", "general-todo.json");
}

function readData(root: string) {
  const parsed = parseTodoJson(fs.readFileSync(jsonPath(root), "utf8"), "test");
  assert.equal(parsed.ok, true, "JSON 必须始终可解析");
  return parsed.ok ? parsed.data : null;
}

function leftoverTmps(root: string): string[] {
  const dir = path.join(root, "todos", ".todo-cli", "tmp");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function collect(child: import("node:child_process").ChildProcess): { stdout: string; stderr: string } {
  const captured = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk) => {
    captured.stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    captured.stderr += String(chunk);
  });
  return captured;
}

function runCli(root: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath(root), ...args], { cwd: root, env: cleanEnv(), timeout: timeoutMs });
    const captured = collect(child);
    child.on("error", () => resolve({ code: -1, signal: null, ...captured }));
    child.on("close", (code, signal) => resolve({ code, signal, ...captured }));
  });
}

/** 启动 add 并延迟 SIGKILL；返回内容快照与退出信息（Windows 上 SIGKILL = TerminateProcess）。 */
function runCliKilled(root: string, args: string[], delayMs: number): Promise<{ result: CliResult; killed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath(root), ...args], { cwd: root, env: cleanEnv() });
    const captured = collect(child);
    let killed = false;
    const timer = setTimeout(() => {
      killed = child.kill("SIGKILL");
    }, delayMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ result: { code: -1, signal: null, ...captured }, killed });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ result: { code, signal, ...captured }, killed });
    });
  });
}

function withEntry(data: TodoFileData, text: string): TodoFileData {
  return {
    ...data,
    entries: [
      ...data.entries,
      {
        id: data.entries.length + 1,
        text,
        status: "open",
        branch: null,
        tags: [],
        notes: [],
        createdAt: null,
        claimedAt: null,
        completedAt: null,
      },
    ],
  };
}

test("中断写：5 轮随机延时 SIGKILL 杀 add，JSON 无半态；残留锁由 stale 抢占自愈；过期 tmp 被清理；末次 add 与 list 一致", { timeout: 180_000 }, async (t) => {
  const root = makeFixture();
  t.after(() => removeFixture(root));

  for (let round = 0; round < 5; round += 1) {
    const beforeData = readData(root);
    const before = fs.readFileSync(jsonPath(root), "utf8");
    const text = `中断测试条目 第${round}轮 由被杀的 add 写入`;
    const delay = 1 + Math.floor(Math.random() * 1500);
    const { result, killed } = await runCliKilled(root, ["add", "--file", "general", text], delay);

    // 时间戳无关的语义比对：旧版（无新条目）或完整新版（追加一条 open 条目）
    const semantic = (data: TodoFileData) =>
      JSON.stringify(data.entries.map((entry) => [entry.id, entry.text, entry.status, entry.branch, entry.tags, entry.notes]));
    const after = fs.readFileSync(jsonPath(root), "utf8");
    const afterData = readData(root);
    const isOld = semantic(afterData) === semantic(beforeData);
    const isNew =
      semantic(afterData) === semantic(withEntry(beforeData, text)) &&
      afterData.entries[afterData.entries.length - 1].createdAt !== null;
    assert.ok(
      isOld || isNew,
      `第 ${round} 轮（SIGKILL ${delay}ms，killed=${killed}，exit=${result.code}/${result.signal}）后 JSON 必须是旧版或完整新版：旧 ${before.length} 字节 / 实际 ${after.length} 字节`,
    );
    assert.doesNotThrow(() => parseTodoJson(after, "roundtrip"), `第 ${round} 轮后 JSON 必须仍可解析`);
  }

  // 残留 tmp 只能来自被杀进程；拨旧 mtime 后用一次成功写入触发过期清理。
  const aged = Date.now() - 11 * 60_000;
  for (const tmp of leftoverTmps(root)) {
    const target = path.join(root, "todos", ".todo-cli", "tmp", tmp);
    fs.utimesSync(target, aged / 1000, aged / 1000);
  }

  const finalText = "中断测试收尾条目 必须完整落盘";
  const finalRes = await runCli(root, ["add", "--file", "general", finalText]);
  assert.equal(finalRes.code, 0, `收尾 add 应 exit 0（被杀残留锁必须被 stale 抢占；stderr=${finalRes.stderr.slice(0, 200)}）`);
  assert.equal(finalRes.stderr, "", "收尾 add stderr 应恒空");
  assert.ok(
    readData(root).entries.some((entry) => entry.text === finalText),
    "收尾条目必须完整落盘",
  );
  assert.deepEqual(leftoverTmps(root), [], "成功写入后不得留下任何（含过期）tmp 残留");

  const listRes = await runCli(root, ["list"]);
  assert.equal(listRes.code, 0, `list 应 exit 0（stderr=${listRes.stderr.slice(0, 200)}）`);
  const expectedLines = readData(root).entries.map(
    (entry) => `${STATUS_MARK[entry.status]} general-todo#${entry.id}  ${entry.text}`,
  );
  const actualLines = listRes.stdout.split(/\r?\n/).filter((line) => line !== "");
  assert.deepEqual(actualLines, expectedLines, "list 输出必须与 JSON 投影逐行一致");
});
