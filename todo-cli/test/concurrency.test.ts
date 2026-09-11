/**
 * todo-cli 并发写边界测试（W3；TDD 红 = 预期交付形态）。
 *
 * 为什么必须真实进程 + 真实文件系统：跨进程写互斥、丢更新、写撕裂在单进程注入下
 * 不可见——本文件把 `todo-cli/` 与 `tools/todo.mjs` 拷进真实临时仓库 fixture，
 * 用 `node tools/todo.mjs add/claim` 驱动 N 个真实子进程同时读改写同一 markdown。
 * fixture 塞入大量缩进说明行：它们不进数据库（markdown 权威、非条目行只存在于 md），
 * 只把「读→改→写」窗口撑到几十毫秒，让今日无锁实现的丢更新稳定复现（非夸大）。
 *
 * 预期红（今日 core.ts 未接存储层）：
 *   1) 并发 6 个 add：read-modify-write 无互斥 → 只落 1–2 条（实测同形态 5/5 次复现）。
 *   2) 并发 2 个 claim 不同条目：后写者整文件覆盖 → 丢一个标注（确定性风险场景）。
 *   3) stderr 恒空：内联子进程 import 尚未实现的 ./store.ts → MODULE_NOT_FOUND，
 *      归 W4（W4 实现 ExperimentalWarning 压制后应转绿；3 = node:sqlite 不可用的降级路径）。
 *
 * 转绿条件（W4）：写路径进 `store.writeTxn`（BEGIN IMMEDIATE + busy_timeout=5000）
 * 串行化 → 并发全落、stderr 恒空。W4 合入前本文件保持红。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseTodoFile } from "../core.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// 200k 缩进说明行 ≈ 12MB：拉长每个进程的读取/解析/写回阶段，让并发窗口稳定重叠。
const FILLER_LINES = 200_000;

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** 子进程环境剥离团队运行变量：成员进程继承的 PI_AGENT_TEAM_* 会被宿主当 leader 模式。 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PI_AGENT_TEAM_FILE;
  delete env.PI_AGENT_TEAM_NAME;
  delete env.PI_AGENT_TEAM_RUN_ID;
  return env;
}

function seedContent(): string {
  let content = "# general TODO\r\n\r\n";
  for (let i = 0; i < 40; i += 1) content += `- [ ] 种子条目 ${String(i).padStart(3, "0")} 供并发 claim 使用\r\n`;
  for (let i = 0; i < FILLER_LINES; i += 1) {
    content += `  - 子说明行 ${i} 仅存在于 markdown，不进数据库（撑大读改写窗口）\r\n`;
  }
  return content;
}

/** 真实临时仓库 fixture：自带 tools/todo.mjs + todo-cli/，REPO_ROOT 由脚本位置解析到 fixture。 */
function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-concurrency-"));
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

function spawnCapture(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, timeout: timeoutMs });
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

function runCli(root: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return spawnCapture(process.execPath, [path.join(root, "tools", "todo.mjs"), ...args], root, cleanEnv(), timeoutMs);
}

function readTodo(root: string): string {
  return fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8");
}

/** CRLF 保持：拆掉全部 \r\n 后不得再有裸 \n。 */
function assertCrlfPreserved(content: string, label: string): void {
  const bareLf = content.split("\r\n").some((part) => part.includes("\n"));
  assert.ok(!bareLf, `${label}：只允许 CRLF，出现裸 LF`);
}

test("并发写：6 个真实子进程同时 add --file general，6 条全落且文件可解析（今日丢更新=红）", { timeout: 180_000 }, async (t) => {
  const root = makeFixture();
  t.after(() => removeFixture(root));

  const entries = Array.from({ length: 6 }, (_, i) => `并发新增条目 编号${i}（撑大窗口后稳定复现丢更新）`);
  const results = await Promise.all(entries.map((text) => runCli(root, ["add", "--file", "general", text])));

  for (const [i, res] of results.entries()) {
    assert.equal(res.code, 0, `第 ${i} 个子进程 add 应 exit 0（stderr=${res.stderr.slice(0, 200)}）`);
    assert.equal(res.stderr, "", `第 ${i} 个子进程 stderr 应恒空`);
  }

  const content = readTodo(root);
  const parsed = parseTodoFile(content);
  for (const text of entries) {
    const hits = parsed.filter((entry) => entry.text === text);
    assert.equal(hits.length, 1, `并发条目必须且只出现一次：${text}（实际 ${hits.length} 条）`);
  }
  assertCrlfPreserved(content, "并发 add 后");
});

test("并发 claim：2 个真实子进程同时领取不同条目，两个标注都在（今日整文件覆盖丢更新=红）", { timeout: 120_000 }, async (t) => {
  const root = makeFixture();
  t.after(() => removeFixture(root));

  const first = "种子条目 001";
  const second = "种子条目 002";
  const results = await Promise.all([
    runCli(root, ["claim", "--file", "general", "--match", first, "--branch", "feat/claim-a"]),
    runCli(root, ["claim", "--file", "general", "--match", second, "--branch", "feat/claim-b"]),
  ]);

  assert.equal(results[0].code, 0, `claim 甲 exit ${results[0].code}（stderr=${results[0].stderr.slice(0, 200)}）`);
  assert.equal(results[1].code, 0, `claim 乙 exit ${results[1].code}（stderr=${results[1].stderr.slice(0, 200)}）`);

  const content = readTodo(root);
  assert.ok(content.includes("（processing @ feat/claim-a）"), "甲条目标注必须落盘（丢更新时缺失）");
  assert.ok(content.includes("（processing @ feat/claim-b）"), "乙条目标注必须落盘（丢更新时缺失）");
  const parsed = parseTodoFile(content);
  assert.equal(parsed.find((entry) => entry.text.includes(first))?.status, "processing");
  assert.equal(parsed.find((entry) => entry.text.includes(second))?.status, "processing");
  assertCrlfPreserved(content, "并发 claim 后");
});

test("stderr 恒空：子进程驱动 store 打开+写库，stderr 必须为空（今日 store.ts 未实现=MODULE_NOT_FOUND 红，归 W4）", { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-stderr-"));
  t.after(() => removeFixture(root));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.writeFileSync(path.join(root, "todos", "general-todo.md"), "# general TODO\r\n\r\n- [ ] 写库条目\r\n");

  const storeUrl = pathToFileURL(path.join(REPO_ROOT, "todo-cli", "store.ts")).href;
  const script = [
    `import { openTodoStore } from ${JSON.stringify(storeUrl)};`,
    "const root = process.env.TODO_FIXTURE_ROOT;",
    "const store = openTodoStore(root);",
    "if (store === null) process.exit(3);", // 3 = node:sqlite 不可用：降级环境也必须 stderr 恒空
    'store.writeTxn(() => store.reimportFile("general", "# general TODO\\r\\n\\r\\n- [ ] 写库条目\\r\\n", () => "2026-09-11T09:45:00.000Z"));',
    "store.close();",
    "process.exit(0);",
  ].join("\n");

  const res = await spawnCapture(
    process.execPath,
    ["--input-type=module", "-e", script],
    root,
    { ...cleanEnv(), TODO_FIXTURE_ROOT: root },
    30_000,
  );

  assert.equal(res.stderr, "", `store 路径子进程 stderr 必须恒空（ExperimentalWarning 压制失效会在此暴露）：${res.stderr.slice(0, 400)}`);
  assert.ok(res.code === 0 || res.code === 3, `期望 exit 0（sqlite 可用）或 3（无库环境降级），实际 ${res.code}`);
});
