/**
 * todo-cli 并发写边界测试（方案 C 重写版）。
 *
 * 为什么必须真实进程 + 真实文件系统：跨进程锁互斥、丢更新在单进程注入下不可见——
 * 本文件把工具（todo.mjs + *.ts）拷进真实临时仓库 fixture 的
 * `.agents/skills/todo-cli/todo-cli/`，用 `--root <fixture>` 显式指定仓库根，
 * 驱动 N 个真实子进程同时读改写同一 JSON 文件（git 自动发现路径另见
 * root-discovery.test.ts，避免重 fixture 依赖 .git 目录）。
 * 锁（lock.ts，O_EXCL + 重试）串行化临界区：并发全落、stderr 恒空、收尾无锁残留。
 * 依赖写入（dep add，todo-cli-todo:10）也走同一条读改写路径，一并在此覆盖。
 */

import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { emptyTodoData, parseTodoJson, serializeTodo } from "../schema.ts";
import type { TodoEntry } from "../schema.ts";
import { activeSceneSink, withFailureScene } from "./failure-scene.ts";

/** 工具目录（入口 + 实现同居）：测试文件的上一级。 */
const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 拷进 fixture 的文件：入口 + 全部实现模块（test/ 不拷；按目录枚举，新增模块自动带上）。 */
function toolFiles(): string[] {
  return ["todo.mjs", ...fs.readdirSync(TOOL_DIR).filter((name) => name.endsWith(".ts"))];
}
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
      globalId: i + 1,
      text: `种子条目 ${String(i).padStart(4, "0")} 供并发测试使用`,
      status: "open",
      branch: null,
      tags: [],
      dependsOn: [],
      notes: [],
      createdAt: null,
      claimedAt: null,
      completedAt: null,
      alignedAt: null,
    });
  }
  return entries;
}

/** 真实临时仓库 fixture：工具落 `<root>/.agents/skills/todo-cli/todo-cli/`，仓库根用 `--root` 指定。 */
function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-concurrency-"));
  const toolDir = path.join(root, ".agents", "skills", "todo-cli", "todo-cli");
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.mkdirSync(toolDir, { recursive: true });
  for (const file of toolFiles()) fs.copyFileSync(path.join(TOOL_DIR, file), path.join(toolDir, file));
  const data = { ...emptyTodoData("general-todo"), entries: seedEntries() };
  fs.writeFileSync(path.join(root, "todos", "general-todo.json"), serializeTodo(data));
  return root;
}

function cliPath(root: string): string {
  return path.join(root, ".agents", "skills", "todo-cli", "todo-cli", "todo.mjs");
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function runCli(root: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const sink = activeSceneSink();
    const child = spawn(process.execPath, [cliPath(root), "--root", root, ...args], {
      cwd: root,
      env: cleanEnv(),
      timeout: timeoutMs,
    });
    const childId = sink?.spawn("todo-cli", { pid: child.pid, args });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      if (sink !== null && childId !== undefined) sink.fail(childId, String(err));
      resolve({ code: -1, signal: null, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      if (sink !== null && childId !== undefined) {
        sink.close(childId, { code, signal, stdout, stderr });
        sink.note("剩余锁", JSON.stringify(leftoverLocks(root)));
      }
      resolve({ code, signal, stdout, stderr });
    });
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

/** 用例包装：失败时写现场；通过路径零写盘零输出（activeSceneSink 为 null 时全短路）。 */
function sceneTest(name: string, options: { timeout: number }, body: (t: TestContext) => Promise<void>): void {
  test(name, options, async (t) => withFailureScene(name, () => body(t)));
}

sceneTest("并发写：6 个真实子进程同时 add --file general，6 条全落、id 与 globalId 均唯一、无锁残留", { timeout: 180_000 }, async (t) => {
  const root = makeFixture();
  activeSceneSink()?.note("fixture root", root);
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
  const globalIds = data.entries.map((entry) => entry.globalId);
  assert.equal(new Set(globalIds).size, data.entries.length, "并发分配的 globalId 不得重复（同文件并发也必须不重号）");
  assert.ok(
    globalIds.every((g) => typeof g === "number" && Number.isInteger(g) && g >= 1),
    "落盘条目恒有正整数 globalId",
  );
  assert.equal(data.entries.length, SEED_ENTRIES + 6, "6 条全部落盘（丢更新即失败）");
  assert.deepEqual(leftoverLocks(root), [], "收尾不得残留锁文件（含 id.lock）");
});

sceneTest("并发跨文件 add：3+3 真实子进程同时打两个文件，globalId 全台账唯一只靠 id.lock + 无锁残留", { timeout: 180_000 }, async (t) => {
  const root = makeFixture();
  activeSceneSink()?.note("fixture root", root);
  t.after(() => removeFixture(root));
  // 第二个台账文件（globalId 与 general 种子错开、无重号）：文件锁互不相关，唯一性只得笃 id.lock。
  fs.writeFileSync(
    path.join(root, "todos", "other-todo.json"),
    serializeTodo({
      ...emptyTodoData("other-todo"),
      entries: [
        { ...seedEntries()[0], id: 1, globalId: 2001, text: "乙文件种子 1" },
        { ...seedEntries()[0], id: 2, globalId: 2002, text: "乙文件种子 2" },
        { ...seedEntries()[0], id: 3, globalId: 2003, text: "乙文件种子 3" },
      ],
    }),
  );

  const texts = [
    ...Array.from({ length: 3 }, (_, i) => [`general`, `甲文件并发条目 编号${i}`]),
    ...Array.from({ length: 3 }, (_, i) => [`other`, `乙文件并发条目 编号${i}`]),
  ];
  const results = await Promise.all(texts.map(([file, text]) => runCli(root, ["add", "--file", file, text])));

  for (const [i, res] of results.entries()) {
    assert.equal(res.code, 0, `第 ${i} 个子进程 add 应 exit 0（stderr=${res.stderr.slice(0, 200)}）`);
    assert.equal(res.stderr, "", `第 ${i} 个子进程 stderr 应恒空`);
  }

  const readAll = () =>
    ["general-todo", "other-todo"].flatMap((name) => {
      const parsed = parseTodoJson(fs.readFileSync(path.join(root, "todos", `${name}.json`), "utf8"), "test");
      assert.equal(parsed.ok, true, `${name}.json 必须可解析`);
      return parsed.ok ? parsed.data.entries.map((entry) => [name, entry]) : [];
    });
  const all = readAll();
  for (const [file, text] of texts) {
    const match = all.filter(([name, entry]) => name === `${file}-todo` && entry.text === text);
    assert.equal(match.length, 1, `条目必须且只出现一次：${text}（实际 ${match.length}）`);
  }
  const globalIds = all.map(([, entry]) => entry.globalId);
  assert.equal(new Set(globalIds).size, globalIds.length, "跨文件并发下 globalId 必须两两互异（文件锁不互斥，只靠 id.lock）");
  const counter = Number(fs.readFileSync(path.join(root, "todos", ".todo-cli", "next-id"), "utf8").trim());
  assert.equal(counter, Math.max(...globalIds) + 1, "计数器 = 全台账 max(globalId)+1（烧号即断）");
  assert.deepEqual(leftoverLocks(root), [], "收尾不得残留锁文件（含 id.lock）");
});

sceneTest("并发 dep add：2 个真实子进程同时给不同条目加依赖，两条都在（无丢更新）+ 无锁残留", { timeout: 120_000 }, async (t) => {
  const root = makeFixture();
  activeSceneSink()?.note("fixture root", root);
  t.after(() => removeFixture(root));

  const first = "种子条目 0001 供并发测试使用";
  const second = "种子条目 0002 供并发测试使用";
  const results = await Promise.all([
    runCli(root, ["dep", "add", "--file", "general", "--match", first, "--on", "general-todo#3"]),
    runCli(root, ["dep", "add", "--file", "general", "--match", second, "--on", "general-todo#4"]),
  ]);

  assert.equal(results[0].code, 0, `dep add 甲 exit ${results[0].code}（stderr=${results[0].stderr.slice(0, 200)}）`);
  assert.equal(results[1].code, 0, `dep add 乙 exit ${results[1].code}（stderr=${results[1].stderr.slice(0, 200)}）`);
  assert.equal(results[0].stderr, "");
  assert.equal(results[1].stderr, "");

  const data = readJson(root);
  assert.deepEqual(data.entries.find((entry) => entry.text === first).dependsOn, ["general-todo#3"], "并发下不得丢更新（甲）");
  assert.deepEqual(data.entries.find((entry) => entry.text === second).dependsOn, ["general-todo#4"], "并发下不得丢更新（乙）");
  assert.equal(data.entries.length, SEED_ENTRIES, "依赖写入不改条目集");
  assert.deepEqual(leftoverLocks(root), [], "收尾不得残留锁文件");
});

sceneTest("并发 claim：2 个真实子进程同时领取不同条目，两个分支引用都在（open → aligning）", { timeout: 120_000 }, async (t) => {
  const root = makeFixture();
  activeSceneSink()?.note("fixture root", root);
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
  assert.equal(a?.status, "aligning");
  assert.equal(a?.branch, "feat/claim-a", "甲条目分支引用必须落盘（丢更新时缺失）");
  assert.equal(typeof a?.claimedAt, "string", "首次领取写 claimedAt");
  assert.equal(b?.status, "aligning");
  assert.equal(b?.branch, "feat/claim-b", "乙条目分支引用必须落盘（丢更新时缺失）");
  assert.deepEqual(leftoverLocks(root), []);
});

sceneTest("并发 align：2 个真实子进程同时确认同一条目——幂等、无丢更新、收尾可再领取进 processing", { timeout: 120_000 }, async (t) => {
  const root = makeFixture();
  activeSceneSink()?.note("fixture root", root);
  t.after(() => removeFixture(root));

  const text = "种子条目 0003 供并发测试使用";
  const claim = await runCli(root, ["claim", "--file", "general", "--match", text, "--branch", "feat/align-seq"]);
  assert.equal(claim.code, 0, `claim 应 exit 0（stderr=${claim.stderr.slice(0, 200)}）`);
  const claimed = readJson(root).entries.find((entry) => entry.text === text);
  assert.equal(claimed?.status, "aligning");

  // 文档路径按条目真实 id 派生（种子文本编号 ≠ id：id 从 1 起、文本从 0000 起）
  const docPath = path.join(root, "todos", "align", `general-todo#${claimed.id}.md`);
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(
    docPath,
    [
      `# general-todo#${claimed.id} 并发对齐`,
      "## 意图",
      "并发确认同一条目只落一次。",
      "## 范围",
      "只测 align 幂等。",
      "## 验收标准",
      "终态 aligned 且无锁残留。",
      "## 人工确认",
      "确认人：测试。",
      "",
    ].join("\n"),
  );

  const results = await Promise.all([
    runCli(root, ["align", "--file", "general", "--match", text]),
    runCli(root, ["align", "--file", "general", "--match", text]),
  ]);
  assert.equal(results[0].code, 0, `align 甲 exit ${results[0].code}（stderr=${results[0].stderr.slice(0, 200)}）`);
  assert.equal(results[1].code, 0, `align 乙 exit ${results[1].code}（stderr=${results[1].stderr.slice(0, 200)}）`);
  assert.equal(results[0].stderr, "");
  assert.equal(results[1].stderr, "");

  const aligned = readJson(root).entries.find((entry) => entry.text === text);
  assert.equal(aligned?.status, "aligned");
  assert.equal(typeof aligned?.alignedAt, "string", "alignedAt 必须落盘（丢更新时缺失）");
  assert.equal(aligned?.branch, "feat/align-seq", "幂等分支不得抹掉已落盘的分支引用");
  assert.deepEqual(leftoverLocks(root), []);

  const reclaim = await runCli(root, ["claim", "--file", "general", "--match", text, "--branch", "feat/align-seq-2"]);
  assert.equal(reclaim.code, 0, `再领取 exit ${reclaim.code}（stderr=${reclaim.stderr.slice(0, 200)}）`);
  const processing = readJson(root).entries.find((entry) => entry.text === text);
  assert.equal(processing?.status, "processing", "aligned → processing 需再次 claim");
  assert.equal(processing?.branch, "feat/align-seq-2", "提供了 --branch 则覆盖原值");
  assert.deepEqual(leftoverLocks(root), []);
});
