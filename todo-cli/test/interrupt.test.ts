/**
 * todo-cli 中断写边界测试（W3；TDD 红 = 预期交付形态）。
 *
 * 覆盖 10-design.md §6 清单 20–21，全部真实子进程 + 真实临时仓库 fixture：
 *   20. SIGKILL 循环杀 add：每轮后 md 必须是「旧版」或「完整新版」——不得出现半态；
 *       tmp 残留只能来自被杀进程，且过期（>10 分钟）后必须被下一次成功写入清理；
 *       末次 add 成功且 `list` 输出与 markdown 解析逐行一致。
 *   21. 漂移自愈确定性：手工改 md（模拟中断恢复 / 并行 worktree 合并）后，结构化查询
 *       必须立即反映新内容（DB 行集 = 新 parse 像）——今日 `list --json/--text`
 *       尚未接线，JSON.parse 必失败 = 预期红，W4 转绿。
 *
 * 关于击杀时机的实测说明（诚实记录）：设计稿写「随机 1–15ms」，但本机（Windows /
 * Node v24.13.1）`node tools/todo.mjs` 冷启动实测 ~400ms，1–15ms 只会命中启动阶段。
 * 因此这里随机区间取 [1, 1500]ms 覆盖启动/读改写/写回各阶段；无论命中哪个阶段，
 * 「旧版或完整新版」的断言都必须成立。补充实测：Windows 上 `writeFileSync` 的
 * 截断/写回过程对并发读者不可观测（字节级轮询探针 0 次撕裂），故清单 20 在今日
 * 实现上通常为绿——它的价值在 W4 落地 temp+rename 原子替换后作为回归网。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { appendEntry, parseTodoFile } from "../core.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 30k 缩进说明行 ≈ 2MB：让被杀的写入阶段有可观测时长，同时保持测试轻量。
const FILLER_LINES = 30_000;
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

function seedContent(): string {
  let content = "# general TODO\r\n\r\n";
  for (let i = 0; i < 10; i += 1) content += `- [ ] 种子条目 ${String(i).padStart(3, "0")} 供中断测试使用\r\n`;
  for (let i = 0; i < FILLER_LINES; i += 1) {
    content += `  - 子说明行 ${i} 仅存在于 markdown，不进数据库（撑大读改写窗口）\r\n`;
  }
  return content;
}

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-interrupt-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "todo-cli"), path.join(root, "todo-cli"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "tools", "todo.mjs"), path.join(root, "tools", "todo.mjs"));
  fs.writeFileSync(path.join(root, "todos", "general-todo.md"), seedContent());
  return root;
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function cliPath(root: string): string {
  return path.join(root, "tools", "todo.mjs");
}

function readTodo(root: string): string {
  return fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8");
}

function leftoverTmps(root: string): string[] {
  return fs.readdirSync(path.join(root, "todos")).filter((name) => name.endsWith(".tmp"));
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

function expectedListLines(root: string): string[] {
  return parseTodoFile(readTodo(root)).map((entry) => `${STATUS_MARK[entry.status]} general-todo:${entry.line}  ${entry.text}`);
}

test("中断写：5 轮随机延时 SIGKILL 杀 add，md 不得留半态；tmp 过期后由下一次成功写入清理；末次 add 与 list 一致", { timeout: 180_000 }, async (t) => {
  const root = makeFixture();
  t.after(() => removeFixture(root));
  const md = path.join(root, "todos", "general-todo.md");

  for (let round = 0; round < 5; round += 1) {
    const before = readTodo(root);
    const text = `中断测试条目 第${round}轮 由被杀的 add 写入`;
    const expected = appendEntry(before, text);
    const delay = 1 + Math.floor(Math.random() * 1500);
    const { result, killed } = await runCliKilled(root, ["add", "--file", "general", text], delay);

    const after = readTodo(root);
    assert.ok(
      after === before || after === expected,
      `第 ${round} 轮（SIGKILL ${delay}ms，killed=${killed}，exit=${result.code}/${result.signal}）后 md 必须是旧版或完整新版，不得半态：旧 ${before.length} 字节 / 实际 ${after.length} 字节 / 完整新版 ${expected.length} 字节`,
    );
    assert.doesNotThrow(() => parseTodoFile(after), `第 ${round} 轮后 md 必须仍可解析`);
  }

  // 残留 tmp 只能来自被杀的进程；拨旧 mtime 后用一次成功写入触发 W4 的过期清理。
  const aged = Date.now() - 11 * 60_000;
  for (const tmp of leftoverTmps(root)) {
    fs.utimesSync(path.join(root, "todos", tmp), aged / 1000, aged / 1000);
  }

  const finalText = "中断测试收尾条目 必须完整落盘";
  const finalBefore = readTodo(root);
  const finalRes = await runCli(root, ["add", "--file", "general", finalText]);
  assert.equal(finalRes.code, 0, `收尾 add 应 exit 0（stderr=${finalRes.stderr.slice(0, 200)}）`);
  assert.equal(finalRes.stderr, "", "收尾 add stderr 应恒空");
  assert.equal(readTodo(root), appendEntry(finalBefore, finalText), "收尾 add 必须完整落盘");
  assert.deepEqual(leftoverTmps(root), [], "成功写入后不得留下任何（含过期）tmp 残留");

  const listRes = await runCli(root, ["list"]);
  assert.equal(listRes.code, 0, `list 应 exit 0（stderr=${listRes.stderr.slice(0, 200)}）`);
  const actualLines = listRes.stdout.split(/\r?\n/).filter((line) => line !== "");
  assert.deepEqual(actualLines, expectedListLines(root), "list 输出必须与 markdown 解析逐行一致");
});

const MARKDOWN_PROJECTION = (root: string): Array<{ file: string; line: number; status: string; text: string }> =>
  parseTodoFile(readTodo(root)).map((entry) => ({ file: "general-todo", line: entry.line, status: entry.status, text: entry.text }));

function parseJsonRows(stdout: string, label: string): Array<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    assert.fail(`${label}：list --json 应先输出合法 JSON（今日 --json 未接线 → 预期红，W4 转绿）：${stdout.slice(0, 200)}`);
  }
  assert.ok(Array.isArray(value), `${label}：--json 输出应为数组`);
  return value as Array<Record<string, unknown>>;
}

function projectRows(rows: Array<Record<string, unknown>>): Array<{ file: unknown; line: unknown; status: unknown; text: unknown }> {
  return rows.map((row) => ({ file: row.file, line: row.line, status: row.status, text: row.text }));
}

test("漂移自愈：手工改 md 后结构化查询必须反映新内容（今日 --json/--text 未接线=红，W4 转绿）", { timeout: 120_000 }, async (t) => {
  const root = makeFixture();
  t.after(() => removeFixture(root));
  const md = path.join(root, "todos", "general-todo.md");

  const base = await runCli(root, ["list", "--json"]);
  assert.equal(base.code, 0, `list --json 应 exit 0（stderr=${base.stderr.slice(0, 200)}）`);
  const baseRows = parseJsonRows(base.stdout, "基线查询");
  assert.deepEqual(projectRows(baseRows), MARKDOWN_PROJECTION(root), "基线 --json 行集必须等于 markdown 派生像");

  // 手工漂移：直接改 md（模拟中断后人工编辑 / 并行 worktree 合并进来的条目）。
  const drifted = `${readTodo(root).replace(/\r\n$/, "")}\r\n- [ ] 手工漂移条目 由外部编辑写入\r\n`;
  fs.writeFileSync(md, drifted);

  const afterDrift = await runCli(root, ["list", "--json"]);
  const driftRows = parseJsonRows(afterDrift.stdout, "漂移后查询");
  assert.deepEqual(projectRows(driftRows), MARKDOWN_PROJECTION(root), "漂移重导入后行集必须跟随 markdown 新内容");
  assert.ok(
    driftRows.some((row) => String(row.text).includes("手工漂移条目")),
    "手工新增条目必须出现在结构化查询结果中",
  );

  const filtered = await runCli(root, ["list", "--file", "general", "--text", "手工漂移", "--json"]);
  const filteredRows = parseJsonRows(filtered.stdout, "组合过滤查询");
  assert.ok(filteredRows.length >= 1, "--text 过滤不应为空");
  assert.ok(
    filteredRows.every((row) => String(row.text).includes("手工漂移")),
    "--text 必须做子串过滤（AND 组合旧 flag --file）",
  );
});
