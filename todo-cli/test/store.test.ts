/**
 * todo-cli/store.ts 单测 —— 真实临时目录 + 真实 node:sqlite（宿主边界必须真实实现，禁 fake：
 * 跨进程写互斥、原子写、漂移检测都发生在 sqlite/fs 的真边界上，纸面替身测不出问题）。
 *
 * 边界：所有用例在 mkdtemp 出来的临时仓库根上执行，只写临时目录，不触碰仓库真实 todos/；
 * 时间戳一律注入固定 NowFn，保证确定性。busy 等待用例必须真实子进程持锁——跨进程锁语义
 * 在单进程注入下不可见（旧实现正是在此处把 SQLITE_BUSY 当损坏降级、丢更新）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeText } from "../core.ts";
import {
  atomicWriteFile,
  loadSqliteModule,
  openTodoStore,
  storeDir,
  storeFile,
} from "../store.ts";

const NOW = () => "2026-09-11T09:45:00.000Z";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-store-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  return root;
}

/** 写一个 markdown fixture，返回当前 stat（size/mtimeMs），供 driftedFiles 断言。 */
function writeTodo(root, name, content) {
  const file = path.join(root, "todos", `${name}.md`);
  fs.writeFileSync(file, content);
  const st = fs.statSync(file);
  return { name, size: st.size, mtimeMs: st.mtimeMs };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORE_URL = pathToFileURL(path.join(REPO_ROOT, "todo-cli", "store.ts")).href;
/** > busy_timeout=5000：旧实现在 ~5s 后把 SQLITE_BUSY(errcode=5) 当损坏 → open 返回 null。 */
const HOLD_MS = 6500;

interface StoreHolder {
  locked: Promise<void>;
  done: Promise<number | null>;
  kill: () => void;
}

/** 子进程持 store 写锁 HOLD_MS：进入 writeTxn 后打印 LOCKED，Atomics.wait 持锁，提交后退出。 */
function spawnStoreHolder(root: string, holdMs: number): StoreHolder {
  const script = [
    `import { openTodoStore } from ${JSON.stringify(STORE_URL)};`,
    `const store = openTodoStore(process.env.TODO_STORE_FIXTURE);`,
    `if (store === null) { console.log("HOLDER_OPEN_NULL"); process.exit(3); }`,
    `store.writeTxn(() => {`,
    `  console.log("LOCKED");`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TODO_STORE_HOLD_MS));`,
    `});`,
    `store.close();`,
    `process.exit(0);`,
  ].join("\n");
  const env = { ...process.env, TODO_STORE_FIXTURE: root, TODO_STORE_HOLD_MS: String(holdMs) };
  delete env.PI_AGENT_TEAM_FILE;
  delete env.PI_AGENT_TEAM_NAME;
  delete env.PI_AGENT_TEAM_RUN_ID;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const locked = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`持锁子进程未在 20s 内进入写事务：${stdout}`)), 20_000);
    child.stdout?.on("data", () => {
      if (stdout.includes("LOCKED")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!stdout.includes("LOCKED")) {
        clearTimeout(timer);
        reject(new Error(`持锁子进程提前退出 code=${code} out=${stdout}`));
      }
    });
  });
  const done = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { locked, done, kill: () => child.kill() };
}

test("openTodoStore：建库建表幂等，schema_version=1", () => {
  const root = makeRoot();
  const first = openTodoStore(root);
  assert.ok(first, "首次 open 建库成功");
  first.close();
  const second = openTodoStore(root);
  assert.ok(second, "二次 open 不抛");
  assert.deepEqual(second.listEntryRows(), []);
  second.close();

  assert.equal(storeDir(root), path.join(root, "todos", ".todo-cli"));
  assert.ok(fs.existsSync(storeFile(root)));

  const sqlite = loadSqliteModule();
  assert.ok(sqlite, "验证机 node:sqlite 应可用");
  const db = new sqlite.DatabaseSync(storeFile(root), { readOnly: true });
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  db.close();
  assert.equal(row.value, "1");
  assert.deepEqual(tables, ["entries", "files", "meta"]);
});

test("writeTxn：fn 抛错回滚且重抛", () => {
  const root = makeRoot();
  const store = openTodoStore(root);
  assert.ok(store);
  writeTodo(root, "a", "- [ ] 甲\n- [ ] 乙\n");
  store.writeTxn(() => store.reimportFile("a", "- [ ] 甲\n- [ ] 乙\n", NOW));
  const before = store.listEntryRows();
  assert.equal(before.length, 2);

  assert.throws(
    () =>
      store.writeTxn(() => {
        store.reimportFile("a", "- [ ] 甲\n", NOW);
        throw new Error("boom");
      }),
    /boom/,
    "异常必须透传（临界区半途失败不留脏数据）",
  );
  assert.deepEqual(store.listEntryRows(), before, "回滚后行集不变");
  store.close();
});

test("reimportFile：CRLF 内容行集正确、时间戳按归一化文本迁移", () => {
  const root = makeRoot();
  const store = openTodoStore(root);
  assert.ok(store);
  const t0 = "2026-09-11T08:00:00.000Z";
  const t1 = "2026-09-11T09:00:00.000Z";
  const t2 = "2026-09-11T10:00:00.000Z";
  const original = "# t\r\n\r\n- [ ] 甲\r\n- [ ] 乙\r\n  - 子说明不是条目\r\n";
  writeTodo(root, "a", original);

  store.writeTxn(() => store.reimportFile("a", original, () => t0));
  assert.deepEqual(
    store.listEntryRows().map((r) => [r.file, r.line, r.status, r.text, r.createdAt]),
    [
      ["a", 3, "open", "甲", t0],
      ["a", 4, "open", "乙", t0],
    ],
    "CRLF 解析行集正确，缩进子说明不进库",
  );

  assert.equal(store.stampEntry("a", normalizeText("甲"), "claimedAt", t1), true);

  // claim 标注增删不改变归一化文本（normalizeText 剥标注括号）→ 重导入必须保留时间戳
  const claimed = original.replace("- [ ] 甲", "- [ ] 甲（processing @ feat/x）");
  writeTodo(root, "a", claimed);
  store.writeTxn(() => store.reimportFile("a", claimed, () => t2));
  let rows = store.listEntryRows();
  const jia = rows.find((r) => r.text.includes("甲"));
  assert.deepEqual(
    [jia.text, jia.createdAt, jia.claimedAt, jia.completedAt],
    ["甲（processing @ feat/x）", t0, t1, null],
  );

  // 新增条目：createdAt 取本次导入时刻，claim/complete 为 null
  const grown = `${claimed}- [ ] 丙\r\n`;
  writeTodo(root, "a", grown);
  store.writeTxn(() => store.reimportFile("a", grown, () => t2));
  rows = store.listEntryRows();
  const bing = rows.find((r) => r.text === "丙");
  assert.deepEqual([bing.createdAt, bing.claimedAt, bing.completedAt], [t2, null, null]);
  store.close();
});

test("driftedFiles：size/mtime 变化与新增文件判定", () => {
  const root = makeRoot();
  const store = openTodoStore(root);
  assert.ok(store);
  const statA = writeTodo(root, "a", "- [ ] 甲\n");
  const statB = writeTodo(root, "b", "- [ ] 乙\n");
  store.writeTxn(() => store.reimportFile("a", "- [ ] 甲\n", NOW));
  assert.deepEqual(store.driftedFiles([statA, statB]).sort(), ["b"], "表无记录的新增文件算漂移");

  store.writeTxn(() => store.reimportFile("b", "- [ ] 乙\n", NOW));
  assert.deepEqual(store.driftedFiles([statA, statB]), [], "未改动文件不漂移");

  const statA2 = writeTodo(root, "a", "- [ ] 甲\n- [ ] 甲二\n");
  assert.deepEqual(store.driftedFiles([statA2, statB]), ["a"], "size 变化即漂移");
  store.close();
});

test("stampEntry：唯一文本命中打时间戳，未命中/歧义返回 false", () => {
  const root = makeRoot();
  const store = openTodoStore(root);
  assert.ok(store);
  writeTodo(root, "a", "- [ ] 甲\n- [ ] 乙\n");
  store.writeTxn(() => store.reimportFile("a", "- [ ] 甲\n- [ ] 乙\n", NOW));
  const t = "2026-09-11T09:45:00.000Z";

  assert.equal(store.stampEntry("a", normalizeText("乙"), "completedAt", t), true);
  const yi = store.listEntryRows().find((r) => r.text === "乙");
  assert.equal(yi.completedAt, t);
  assert.equal(store.stampEntry("a", normalizeText("不存在"), "claimedAt", t), false);
  assert.equal(store.stampEntry("other", normalizeText("甲"), "claimedAt", t), false);

  writeTodo(root, "a", "- [ ] 甲\n- [ ] 甲\n");
  store.writeTxn(() => store.reimportFile("a", "- [ ] 甲\n- [ ] 甲\n", NOW));
  assert.equal(store.stampEntry("a", normalizeText("甲"), "claimedAt", t), false, "归一化后同文本多条时不猜行");
  store.close();
});

test("openTodoStore 降级：损坏库自愈（挪 .corrupt 后重建成功）", () => {
  const root = makeRoot();
  fs.mkdirSync(storeDir(root), { recursive: true });
  fs.writeFileSync(storeFile(root), "this is not a sqlite database");

  assert.equal(openTodoStore(root), null, "损坏库本次降级");
  assert.ok(fs.existsSync(path.join(storeDir(root), "index.db.corrupt")), "损坏库挪为 .corrupt 留证");

  const healed = openTodoStore(root);
  assert.ok(healed, "下一次 open 自动重建");
  assert.deepEqual(healed.listEntryRows(), []);
  healed.close();
});

test("openTodoStore：并发写者持锁超过 busy_timeout 时等待而非降级（busy 不是损坏，不得返回 null/挪 .corrupt）", { timeout: 60_000 }, async (t) => {
  const root = makeRoot();
  const holder = spawnStoreHolder(root, HOLD_MS);
  t.after(() => {
    holder.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // 先无竞争建库，再让子进程持锁——复现 core 写路径「open 撞上长写事务」的时序
  const initial = openTodoStore(root);
  assert.ok(initial, "初始建库应成功");
  initial.close();
  await holder.locked;

  const t0 = Date.now();
  const store = openTodoStore(root);
  const waited = Date.now() - t0;
  assert.ok(store, `持锁期间 open 不得返回 null（旧实现 ~5s 后误判损坏；实测等待 ${waited}ms）`);
  assert.ok(waited >= 1000, `应等待持锁者提交（实测 ${waited}ms），而不是立即降级`);
  assert.equal(
    fs.existsSync(path.join(storeDir(root), "index.db.corrupt")),
    false,
    "SQLITE_BUSY 不是损坏：不得隔离出 .corrupt",
  );
  const content = "# t\r\n\r\n- [ ] 等待后写入\r\n";
  writeTodo(root, "a", content);
  try {
    store.writeTxn(() => store.reimportFile("a", content, NOW));
    assert.deepEqual(
      store.listEntryRows().map((r) => [r.file, r.text]),
      [["a", "等待后写入"]],
      "等待锁释放后写入必须成功（旧实现降级丢这条）",
    );
  } finally {
    store.close();
  }
  assert.equal(await holder.done, 0, "持锁子进程应正常提交退出");
});

test("writeTxn：持锁写者超过 busy_timeout 时 BEGIN 有界重试而非立即抛 busy", { timeout: 60_000 }, async (t) => {
  const root = makeRoot();
  const initial = openTodoStore(root);
  assert.ok(initial, "初始建库应成功");
  const holder = spawnStoreHolder(root, HOLD_MS);
  t.after(() => {
    holder.kill();
    try {
      initial.close();
    } catch {
      // 已关闭
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  await holder.locked;

  const content = "# t\r\n\r\n- [ ] 重试后写入\r\n";
  writeTodo(root, "a", content);
  const t0 = Date.now();
  initial.writeTxn(() => initial.reimportFile("a", content, NOW));
  const waited = Date.now() - t0;
  assert.ok(waited >= 1000, `BEGIN 应等待持锁者释放后重试（实测 ${waited}ms），旧实现 5s 即抛 busy`);
  assert.deepEqual(
    initial.listEntryRows().map((r) => r.text),
    ["重试后写入"],
    "持锁者提交后重试的写入必须落库",
  );
  initial.close();
  assert.equal(await holder.done, 0, "持锁子进程应正常提交退出");
});

test("atomicWriteFile：覆盖既有文件、无 .tmp 残留、10 分钟旧 tmp 被清", () => {
  const root = makeRoot();
  const dir = path.join(root, "todos");
  const target = path.join(dir, "a.md");
  fs.writeFileSync(target, "old");

  atomicWriteFile(target, "new\r\n");
  assert.equal(fs.readFileSync(target, "utf8"), "new\r\n");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "正常路径无 .tmp 残留");

  // 过期 tmp（崩溃残留）清理；新鲜 tmp 保留（可能属于并发写者，绝不能误删）
  const stale = path.join(dir, "a.md.123.dead.tmp");
  const fresh = path.join(dir, "a.md.456.alive.tmp");
  fs.writeFileSync(stale, "stale");
  fs.writeFileSync(fresh, "fresh");
  const old = (Date.now() - 11 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);

  atomicWriteFile(target, "newer");
  assert.equal(fs.existsSync(stale), false, "超过 10 分钟的 .tmp 被清理");
  assert.equal(fs.existsSync(fresh), true, "新鲜 .tmp 不动");
  assert.equal(fs.readFileSync(target, "utf8"), "newer");
});
