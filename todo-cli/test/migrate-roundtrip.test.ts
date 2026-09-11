/**
 * todo-cli 迁移/回滚可逆性边界测试（W3；TDD 红 = 预期交付形态）。
 *
 * 今日 `./store.ts`、`./migrate.ts` 尚未实现，本文件按 10-design.md §3.2/§3.3 冻结签名
 * import → 加载即 MODULE_NOT_FOUND（预期红；W1 交付实现后转绿，W4 接线后全链路绿）。
 *
 * 覆盖 §6 清单 22–23：
 *   22. CRLF fixture 仓库全往返：dbStatus 只读不建库 → rebuild（markdown 字节不变、
 *       DB 行集 == parseTodoFile 纯函数像）→ drop（回滚到纯 markdown）→ CLI 全功能
 *       → 再 rebuild 仍一致。
 *   23. 时间戳迁移：claim 时刻 t1 经强制漂移重导入后 claimedAt 仍为 t1
 *       （W4 的 claim 路径正是 atomicWriteFile + reimportFile + stampEntry 三连）。
 *
 * 真实临时仓库 fixture：DB 与 markdown 都在 fixture 内，测试绝不触碰仓库真实 todos/。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizeText, parseTodoFile, setProcessing } from "../core.ts";
import { openTodoStore, storeFile } from "../store.ts";
import type { TodoStore } from "../store.ts";
import { dbStatus, dropStore, rebuildStore } from "../migrate.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = "2026-09-11T09:45:00.000Z";

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

function runCli(root: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "tools", "todo.mjs"), ...args], { cwd: root, env: cleanEnv(), timeout: timeoutMs });
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

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-migrate-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "todo-cli"), path.join(root, "todo-cli"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "tools", "todo.mjs"), path.join(root, "tools", "todo.mjs"));
  fs.writeFileSync(
    path.join(root, "todos", "general-todo.md"),
    "# 通用 TODO\r\n\r\n- [ ] 未领取条目\r\n- [ ] 进行中条目（processing 2026-09-11 @ feat/x）\r\n- [x] 已完成条目（完成 2026-09-11 @ feat/y）\r\n",
  );
  fs.writeFileSync(path.join(root, "todos", "other-todo.md"), "# 其他 TODO\r\n\r\n- [ ] 另一文件条目\r\n");
  return root;
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function readDocs(root: string): Array<{ name: string; content: string }> {
  const dir = path.join(root, "todos");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ name: name.slice(0, -3), content: fs.readFileSync(path.join(dir, name), "utf8") }));
}

function hashTodos(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const doc of readDocs(root)) {
    hashes[doc.name] = crypto.createHash("sha256").update(Buffer.from(doc.content, "utf8")).digest("hex");
  }
  return hashes;
}

interface RowProjection {
  file: string;
  line: number;
  status: string;
  text: string;
}

/** markdown 派生的行集（纯函数像）：file 升序 → line 升序，与 DB 行排序口径一致。 */
function markdownRows(root: string): RowProjection[] {
  const rows: RowProjection[] = [];
  for (const doc of readDocs(root)) {
    for (const entry of parseTodoFile(doc.content)) {
      rows.push({ file: doc.name, line: entry.line, status: entry.status, text: entry.text });
    }
  }
  return rows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

function storeRows(store: TodoStore): RowProjection[] {
  return store.listEntryRows().map((row) => ({ file: row.file, line: row.line, status: row.status, text: row.text }));
}

test("迁移可逆全往返：rebuild 不改 md、行集 == markdown 像、drop 后可回滚、再 rebuild 仍一致", { timeout: 120_000 }, async (t) => {
  const root = makeFixture();
  t.after(() => removeFixture(root));
  const now = () => NOW;

  // 只读探测不得建库。
  const initialStatus = dbStatus(root);
  assert.equal(initialStatus.available, false);
  assert.equal(initialStatus.reason, "NO_DB");
  assert.ok(!fs.existsSync(storeFile(root)), "dbStatus 不得创建库文件");

  const before = hashTodos(root);
  const docs = readDocs(root);
  assert.deepEqual(rebuildStore(root, docs, now), { ok: true, reason: null });
  assert.deepEqual(hashTodos(root), before, "rebuild 不得改写任何 markdown（迁移可逆的根基）");

  const rebuiltStatus = dbStatus(root);
  assert.equal(rebuiltStatus.available, true);
  assert.equal(rebuiltStatus.reason, null);
  assert.equal(rebuiltStatus.files, docs.length);
  assert.equal(rebuiltStatus.entries, markdownRows(root).length);

  const store = openTodoStore(root);
  if (store === null) assert.fail("rebuild 后 openTodoStore 不应返回 null（本机 node:sqlite 可用）");
  assert.deepEqual(storeRows(store), markdownRows(root), "DB 行集必须等于 parseTodoFile 的纯函数像");
  store.close();

  // 回滚：drop 删索引文件，CLI 回到纯 markdown 路径。
  const dropped = dropStore(root);
  assert.equal(dropped.ok, true);
  assert.ok(dropped.removed.some((rel) => rel.endsWith("index.db")), `removed 应含 index.db：${dropped.removed.join(", ")}`);
  assert.ok(!fs.existsSync(storeFile(root)), "drop 后库文件必须不存在");
  assert.equal(dbStatus(root).reason, "NO_DB");
  assert.deepEqual(hashTodos(root), before, "drop 是纯删索引，不得触碰 markdown");

  const list = await runCli(root, ["list", "--status", "processing"]);
  assert.equal(list.code, 0, `drop 后 list 应 exit 0（stderr=${list.stderr.slice(0, 200)}）`);
  assert.match(list.stdout, /进行中条目/);
  const add = await runCli(root, ["add", "--file", "general", "迁移往返新增条目"]);
  assert.equal(add.code, 0, `drop 后 add 应 exit 0（stderr=${add.stderr.slice(0, 200)}）`);
  const claim = await runCli(root, ["claim", "--file", "general", "--match", "迁移往返新增条目", "--branch", "feat/roundtrip"]);
  assert.equal(claim.code, 0, `drop 后 claim 应 exit 0（stderr=${claim.stderr.slice(0, 200)}）`);

  // 二次 rebuild：新内容也进行集，且 DB 行集仍等于 markdown 像。
  const docsAfterCli = readDocs(root);
  assert.deepEqual(rebuildStore(root, docsAfterCli, now), { ok: true, reason: null });
  const storeAgain = openTodoStore(root);
  if (storeAgain === null) assert.fail("二次 rebuild 后 openTodoStore 不应返回 null");
  assert.deepEqual(storeRows(storeAgain), markdownRows(root), "二次 rebuild 后行集仍必须等于 markdown 像");
  storeAgain.close();
});

test("时间戳迁移：claim 时刻 t1 经强制漂移重导入后 claimedAt 仍为 t1", { timeout: 60_000 }, async (t) => {
  const root = makeFixture();
  t.after(() => removeFixture(root));
  const mdPath = path.join(root, "todos", "general-todo.md");
  const original = fs.readFileSync(mdPath, "utf8");
  const t1 = "2026-09-11T09:45:00.000Z";
  const t2 = "2026-09-11T10:30:00.000Z";

  const store = openTodoStore(root);
  if (store === null) assert.fail("测试环境 node:sqlite 可用，openTodoStore 不应返回 null");

  // 1) 首次导入 + 模拟 claim 落时间戳（W4 claim 路径 = atomicWriteFile + reimportFile + stampEntry）。
  store.writeTxn(() => {
    store.reimportFile("general-todo", original, () => t1);
    assert.equal(store.stampEntry("general-todo", normalizeText("未领取条目"), "claimedAt", t1), true, "stampEntry 应命中唯一条目");
  });
  let rows = store.listEntryRows().filter((row) => row.text.includes("未领取条目"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claimedAt, t1, "claim 时刻必须落库");
  assert.equal(rows[0].createdAt, t1, "首次导入时间必须落库");

  // 2) 强制漂移：claim 标注增删不改变 normalizeText 结果，重导入后时间戳按归一化文本迁移。
  const claimed = setProcessing(original, "未领取条目", "feat/claim");
  if (!claimed.ok) assert.fail(`setProcessing 应成功：${claimed.code}`);
  store.writeTxn(() => store.reimportFile("general-todo", claimed.content, () => t2));
  rows = store.listEntryRows().filter((row) => row.text.includes("未领取条目"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claimedAt, t1, "重导入后 claimedAt 必须按归一化文本迁移保留");
  assert.equal(rows[0].createdAt, t1, "重导入后 createdAt 也必须保留");
  assert.match(rows[0].text, /（processing @ feat\/claim）/, "重导入后文本应为 claim 后的 markdown 原文");
  store.close();
});
