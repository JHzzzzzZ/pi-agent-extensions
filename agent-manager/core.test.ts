/**
 * agent-manager 核心逻辑测试（迁移自 session-manager/core.test.ts：format* 用例改写为 JSON 值断言，
 * 新增两段式写操作 rename/delete/trash/restore 与性能看门）。
 *
 * 边界：真实临时目录 + 真实 JSONL 文件（会话数据真读真写，测后清理）；fs 注入只用于覆盖
 * 「单文件读失败 / 跨盘 rename 失败」这类进程边界分支，不触碰用户真实会话目录。
 *
 * JHL-62 + 用户 2026-09-11 形态纠正需求（agent-manager 独立工具，非 Pi 扩展）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseSessionText,
  listSessions,
  searchSessions,
  previewSession,
  renameSession,
  deleteSession,
  listTrash,
  restoreSession,
  defaultTrashDir,
  SessionErrorCodes,
  type SessionFsDeps,
} from "./core.ts";

const T0 = "2026-09-11T00:00:00.000Z";
const T1 = "2026-09-11T01:00:00.000Z";

/** 临时目录登记表：用例用 tempDir/makeRoot 创建，文件级 after 钩子统一清理。 */
const created: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

interface SessionOpts {
  name?: string;
  model?: string;
  user?: string;
  assistant?: string;
  toolResult?: string;
}

/** 造一条 v3 会话 JSONL：header + 可选 name + model_change + user/assistant/toolResult。 */
function sessionText(id: string, cwd: string, opts: SessionOpts = {}): string {
  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: T0, cwd }),
  ];
  if (opts.name) {
    lines.push(JSON.stringify({ type: "session_info", id: "00000001", parentId: null, timestamp: T0, name: opts.name }));
  }
  if (opts.model) {
    lines.push(JSON.stringify({ type: "model_change", id: "00000002", parentId: null, timestamp: T0, provider: "p", modelId: opts.model }));
  }
  if (opts.user) {
    lines.push(JSON.stringify({
      type: "message", id: "00000003", parentId: null, timestamp: T0,
      message: { role: "user", content: [{ type: "text", text: opts.user }], timestamp: 1 },
    }));
  }
  if (opts.assistant) {
    lines.push(JSON.stringify({
      type: "message", id: "00000004", parentId: null, timestamp: T0,
      message: { role: "assistant", content: [{ type: "text", text: opts.assistant }], provider: "p", model: opts.model ?? "m", usage: {}, stopReason: "stop", timestamp: 2 },
    }));
  }
  if (opts.toolResult) {
    lines.push(JSON.stringify({
      type: "message", id: "00000005", parentId: null, timestamp: T0,
      message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: opts.toolResult }], isError: false, timestamp: 3 },
    }));
  }
  return lines.join("\n") + "\n";
}

/** root/<encoded-dir>/<file>.jsonl */
function makeRoot(files: Array<{ dir: string; file: string; text: string; mtimeMs?: number }>): string {
  const root = tempDir("agent-manager-");
  for (const f of files) {
    const dir = path.join(root, f.dir);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, f.file);
    fs.writeFileSync(p, f.text, "utf8");
    if (f.mtimeMs) fs.utimesSync(p, f.mtimeMs / 1000, f.mtimeMs / 1000);
  }
  return root;
}

const D1 = "--C--Users-12967-proj-one--";
const D2 = "--C--Users-12967-proj-two--";

/** 真实 fs 的 SessionFsDeps 默认实现（fake 只覆盖进程边界分支）。 */
const realDeps: SessionFsDeps = {
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  statSync: (p) => fs.statSync(p),
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  appendFileSync: (p, data) => fs.appendFileSync(p, data, "utf8"),
  writeFileSync: (p, data) => fs.writeFileSync(p, data, "utf8"),
  renameSync: (from, to) => fs.renameSync(from, to),
  copyFileSync: (from, to) => fs.copyFileSync(from, to),
  unlinkSync: (p) => fs.unlinkSync(p),
  mkdirSync: (p, options) => {
    fs.mkdirSync(p, options);
  },
  utimesSync: (p, atimeSec, mtimeSec) => fs.utimesSync(p, atimeSec, mtimeSec),
};

function fakeDeps(overrides: Partial<SessionFsDeps>): SessionFsDeps {
  return { ...realDeps, ...overrides };
}

// #1 迁移
test("parseSessionText：提取元数据、容忍坏行、name 取最后一个", () => {
  const text =
    JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: T0, cwd: "C:\\proj\\one" }) + "\n" +
    "{ 这不是 JSON\n" +
    JSON.stringify({ type: "session_info", id: "a", parentId: null, timestamp: T0, name: "旧名" }) + "\n" +
    JSON.stringify({ type: "session_info", id: "b", parentId: null, timestamp: T0, name: "新名" }) + "\n" +
    sessionText("x", "C:\\proj\\one", { user: "帮我\n修  登录", assistant: "好的" }).split("\n").slice(1, 5).join("\n");

  const meta = parseSessionText(text, { path: "/root/f.jsonl", file: "f.jsonl", sizeBytes: 123, mtimeMs: 1_700_000_000_000 });
  assert.equal(meta.id, "sess-1");
  assert.equal(meta.cwd, "C:\\proj\\one");
  assert.equal(meta.name, "新名");
  assert.equal(meta.sizeBytes, 123);
  assert.equal(meta.userMessages, 1);
  assert.equal(meta.assistantMessages, 1);
  assert.equal(meta.firstUserText, "帮我 修 登录");
  assert.match(meta.modifiedAt, /^20\d\d-/);
  assert.equal(meta.model, "p/m");
});

// #2 迁移（fake fs 读失败分支并入：单文件读失败不拖垮扫描）
test("listSessions：按修改时间倒序、cwd 过滤、目录缺失报错、坏文件与单文件读失败都跳过", () => {
  const root = makeRoot([
    { dir: D1, file: "2026-01-01T00-00-00-000Z_aaa.jsonl", text: sessionText("aaa", "C:\\proj\\one", { user: "first" }), mtimeMs: 1_700_000_000_000 },
    { dir: D2, file: "2026-02-01T00-00-00-000Z_bbb.jsonl", text: sessionText("bbb", "C:\\proj\\two", { name: "第二个", user: "second" }), mtimeMs: 1_800_000_000_000 },
    { dir: D2, file: "_chron.txt", text: "ignore me" },
  ]);
  fs.writeFileSync(path.join(root, D1, "broken.jsonl"), "not json at all", "utf8");

  const all = listSessions(root);
  assert.equal(all.ok, true);
  if (!all.ok) return;
  assert.deepEqual(all.value.map((m) => m.id), ["bbb", "aaa"], "按 mtime 倒序且坏文件被跳过");
  assert.equal(all.value[1].sizeBytes > 0, true);

  const filtered = listSessions(root, { cwd: "C:\\proj\\two" });
  assert.equal(filtered.ok, true);
  if (!filtered.ok) return;
  assert.deepEqual(filtered.value.map((m) => m.id), ["bbb"]);

  const missing = listSessions(path.join(root, "nope"));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, SessionErrorCodes.DIR_MISSING);

  const deps = fakeDeps({
    readFileSync: (p) => {
      if (p.endsWith("throws.jsonl")) throw new Error("EACCES");
      return fs.readFileSync(p, "utf8");
    },
  });
  fs.writeFileSync(path.join(root, D1, "throws.jsonl"), sessionText("throws", "C:\\proj\\one", { user: "x" }), "utf8");
  const withFailure = listSessions(root, {}, deps);
  assert.equal(withFailure.ok, true);
  if (withFailure.ok) assert.deepEqual(withFailure.value.map((m) => m.id), ["bbb", "aaa"], "读失败文件被跳过，不拖垮扫描");
});

// #3 迁移
test("searchSessions：用户/助手文本大小写不敏感、工具输出不搜、空查询报错", () => {
  const root = makeRoot([
    { dir: D1, file: "a.jsonl", text: sessionText("aaa", "C:\\p", { user: "Fix Login Bug", toolResult: "SECRET-TOKEN-XYZ" }), mtimeMs: 1_700_000_000_000 },
    { dir: D2, file: "b.jsonl", text: sessionText("bbb", "C:\\p2", { assistant: "login done" }), mtimeMs: 1_800_000_000_000 },
  ]);

  const hit = searchSessions(root, "login");
  assert.equal(hit.ok, true);
  if (!hit.ok) return;
  assert.deepEqual(hit.value.map((h) => h.meta.id), ["bbb", "aaa"], "命中数相同时按最近修改排序");
  assert.ok(hit.value[0].snippets[0].toLowerCase().includes("login"));
  assert.ok(hit.value[1].hits >= 1);

  const secret = searchSessions(root, "SECRET-TOKEN");
  assert.equal(secret.ok, true);
  if (secret.ok) assert.equal(secret.value.length, 0, "工具输出不参与检索");

  const bad = searchSessions(root, "   ");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, SessionErrorCodes.BAD_QUERY);

  const scoped = searchSessions(root, "login", { cwd: "C:\\p2" });
  assert.equal(scoped.ok, true);
  if (scoped.ok) assert.deepEqual(scoped.value.map((h) => h.meta.id), ["bbb"]);
});

// #4 迁移（与宿主的交接面：resume/fork 命令字符串）
test("previewSession：按 id 前缀或文件名前缀定位、歧义/缺失报错、尾文与宿主接续命令", () => {
  const root = makeRoot([
    { dir: D1, file: "2026-01-01T00-00-00-000Z_aaaa1111.jsonl", text: sessionText("aaaa1111-0000", "C:\\p", { name: "修登录", user: "开始", assistant: "结束" }) },
    { dir: D2, file: "2026-01-02T00-00-00-000Z_aaaa2222.jsonl", text: sessionText("aaaa2222-0000", "C:\\p2", { user: "别的" }) },
    { dir: D2, file: "2026-01-03T00-00-00-000Z_bbbb3333.jsonl", text: sessionText("bbbb3333-0000", "C:\\p2", { user: "另一个" }) },
  ]);

  const one = previewSession(root, "bbbb3333");
  assert.equal(one.ok, true);
  if (!one.ok) return;
  assert.equal(one.value.meta.name, "");
  assert.equal(one.value.resumeCommand, "pi --session bbbb3333");
  assert.equal(one.value.forkCommand, "pi --fork bbbb3333");
  assert.deepEqual(one.value.tail.map((l) => l.role), ["user"]);

  const byFile = previewSession(root, "2026-01-01T00-00-00-000Z_aaaa1111");
  assert.equal(byFile.ok, true);
  if (byFile.ok) assert.deepEqual(byFile.value.tail.map((l) => l.role), ["user", "assistant"]);

  const ambiguous = previewSession(root, "aaaa");
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.code, SessionErrorCodes.AMBIGUOUS);
    assert.match(ambiguous.message, /2 个候选/);
  }

  const missing = previewSession(root, "zzzz");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, SessionErrorCodes.NOT_FOUND);
});

// #5 改写：原 formatList / formatPreview 用例 → JSON 值形状断言
test("list/search 返回的 JSON 值形状完整、可直接序列化（原 format* 用例改写）", () => {
  const root = makeRoot([
    { dir: D1, file: "a.jsonl", text: sessionText("aaaa1111-2222", "C:\\proj\\one", { name: "会话甲", model: "flash", user: "给我派个 agent", assistant: "收到" }), mtimeMs: 1_700_000_000_000 },
  ]);
  const listed = listSessions(root);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.value.length, 1);
  const meta = listed.value[0];
  assert.deepEqual(Object.keys(meta).sort(), [
    "assistantMessages", "createdAt", "cwd", "file", "firstUserText", "id", "model", "modifiedAt",
    "name", "parentSession", "path", "sizeBytes", "toolResults", "userMessages",
  ]);
  assert.equal(meta.id, "aaaa1111-2222");
  assert.equal(meta.name, "会话甲");
  assert.equal(meta.model, "p/flash");
  assert.equal(meta.userMessages, 1);
  assert.equal(meta.assistantMessages, 1);
  assert.equal(meta.toolResults, 0);
  assert.equal(meta.parentSession, "");
  assert.equal(meta.path, path.join(root, D1, "a.jsonl"));
  assert.equal((JSON.parse(JSON.stringify(meta)) as { id: string }).id, "aaaa1111-2222", "web 消费的是 JSON 值");

  const found = searchSessions(root, "给我派个");
  assert.equal(found.ok, true);
  if (!found.ok) return;
  assert.equal(found.value.length, 1);
  const hit = found.value[0];
  assert.deepEqual(Object.keys(hit).sort(), ["hits", "meta", "snippets"]);
  assert.equal(hit.meta.id, "aaaa1111-2222");
  assert.equal(hit.hits, 1);
  assert.equal(typeof hit.snippets[0], "string");
  assert.equal((JSON.parse(JSON.stringify(hit)) as { meta: { id: string } }).meta.id, "aaaa1111-2222");
});

// #6
test("renameSession dry-run：返回精确 appendLine、parentId=文件最后一条 entry id、不动文件", () => {
  const root = makeRoot([{ dir: D1, file: "s.jsonl", text: sessionText("aaaa1111-2222", "C:\\p", { user: "hi" }) }]);
  const file = path.join(root, D1, "s.jsonl");
  const before = fs.readFileSync(file, "utf8");
  const plan = renameSession(root, "aaaa1111", "新标题", { now: () => T0, idFactory: () => "abc12345" });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.confirmed, false);
  assert.equal(plan.value.file, file);
  assert.equal(plan.value.currentName, "");
  assert.equal(plan.value.newName, "新标题");
  assert.equal(fs.readFileSync(file, "utf8"), before, "dry-run 不产生任何写副作用");
  const entry = JSON.parse(plan.value.appendLine) as Record<string, unknown>;
  assert.equal(entry.type, "session_info");
  assert.equal(entry.name, "新标题");
  assert.equal(entry.parentId, "00000003", "parentId = 文件最后一条 entry 的 id（此处为 user message）");
  assert.equal(entry.id, "abc12345");
  assert.equal(entry.timestamp, T0);

  const withDefaultId = renameSession(root, "aaaa1111", "另一个名字", { now: () => T0 });
  assert.equal(withDefaultId.ok, true);
  if (withDefaultId.ok) {
    const defaultId = (JSON.parse(withDefaultId.value.appendLine) as { id: string }).id;
    assert.match(defaultId, /^[0-9a-f]{8}$/, "默认 id 为 randomUUID 前 8 位 hex");
  }
});

// #7
test("renameSession confirm：原内容逐字节保留、恰好追加一行、列表立即反映新名", () => {
  const textA = sessionText("aaaa1111-0000", "C:\\p", { name: "旧名", user: "hi" });
  const textB = sessionText("bbbb2222-0000", "C:\\p", { user: "hi" }).replace(/\n$/, "");
  const root = makeRoot([
    { dir: D1, file: "a.jsonl", text: textA },
    { dir: D1, file: "b.jsonl", text: textB },
  ]);
  const fileA = path.join(root, D1, "a.jsonl");
  const fileB = path.join(root, D1, "b.jsonl");
  const beforeA = fs.readFileSync(fileA, "utf8");
  const beforeB = fs.readFileSync(fileB, "utf8");

  const rA = renameSession(root, "aaaa1111", "新名字", { now: () => T0, idFactory: () => "11112222", confirm: true });
  assert.equal(rA.ok, true);
  if (!rA.ok) return;
  assert.equal(rA.value.confirmed, true);
  const afterA = fs.readFileSync(fileA, "utf8");
  assert.ok(afterA.startsWith(beforeA), "原内容逐字节保留为前缀");
  assert.equal(afterA, beforeA + rA.value.appendLine + "\n", "尾换行文件：恰好追加一行（含换行）");
  assert.equal(
    afterA.split("\n").filter(Boolean).length,
    beforeA.split("\n").filter(Boolean).length + 1,
    "非空行数恰好 +1",
  );

  const rB = renameSession(root, "bbbb2222", "无尾换行也安全", { now: () => T0, idFactory: () => "33334444", confirm: true });
  assert.equal(rB.ok, true);
  if (!rB.ok) return;
  const afterB = fs.readFileSync(fileB, "utf8");
  assert.ok(afterB.startsWith(beforeB));
  assert.equal(afterB, beforeB + "\n" + rB.value.appendLine + "\n", "原文件无尾换行时先补一个换行再加一行");

  const listed = listSessions(root);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const names = new Map(listed.value.map((m) => [m.id.slice(0, 8), m.name]));
  assert.equal(names.get("aaaa1111"), "新名字", "listSessions 立即反映新名");
  assert.equal(names.get("bbbb2222"), "无尾换行也安全");
});

// #8
test("renameSession：name 清洗换行为空格+trim；清洗后为空 → BAD_NAME 且零写", () => {
  const root = makeRoot([{ dir: D1, file: "s.jsonl", text: sessionText("cccc3333-0000", "C:\\p", { user: "hi" }) }]);
  const file = path.join(root, D1, "s.jsonl");
  const before = fs.readFileSync(file, "utf8");

  const cleaned = renameSession(root, "cccc3333", "  第一行\r\n第二行  ", { now: () => T0, idFactory: () => "cccc0001" });
  assert.equal(cleaned.ok, true);
  if (cleaned.ok) {
    assert.equal(cleaned.value.newName, "第一行 第二行", "对齐宿主 appendSessionInfo 的 name 清洗");
    assert.equal((JSON.parse(cleaned.value.appendLine) as { name: string }).name, "第一行 第二行");
  }

  const blank = renameSession(root, "cccc3333", " \r\n\t ");
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.code, SessionErrorCodes.BAD_NAME);
  assert.equal(fs.readFileSync(file, "utf8"), before, "BAD_NAME 不落盘");
});

// #9
test("renameSession：id 对文件内已有 id 防碰撞（复刻宿主 generateId 语义）", () => {
  const root = makeRoot([{ dir: D1, file: "s.jsonl", text: sessionText("dddd4444-0000", "C:\\p", { user: "hi" }) }]);
  const file = path.join(root, D1, "s.jsonl");
  const queued = ["00000003", "deadbeef"];
  let calls = 0;
  const idFactory = (): string => {
    const id = queued[calls] ?? "fallback9";
    calls++;
    return id;
  };
  const r = renameSession(root, "dddd4444", "改名", { now: () => T0, idFactory, confirm: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(calls, 2, "第一个 id 与文件内已有 entry 冲突，重试第二个");
  const last = fs.readFileSync(file, "utf8").trimEnd().split("\n").pop();
  assert.equal((JSON.parse(last ?? "") as { id: string }).id, "deadbeef");
});

// #10
test("renameSession：复用 previewSession 的 NOT_FOUND/AMBIGUOUS/DIR_MISSING 定位语义", () => {
  const root = makeRoot([
    { dir: D1, file: "2026-01-01T00-00-00-000Z_aaaa1111.jsonl", text: sessionText("aaaa1111-0000", "C:\\p", { user: "一" }) },
    { dir: D2, file: "2026-01-02T00-00-00-000Z_aaaa2222.jsonl", text: sessionText("aaaa2222-0000", "C:\\p2", { user: "二" }) },
  ]);

  const missing = renameSession(root, "zzzz", "x", { confirm: true });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, SessionErrorCodes.NOT_FOUND);

  const ambiguous = renameSession(root, "aaaa", "x", { confirm: true });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.code, SessionErrorCodes.AMBIGUOUS);
    assert.match(ambiguous.message, /2 个候选/);
  }

  const noDir = renameSession(path.join(root, "nope"), "aaaa", "x");
  assert.equal(noDir.ok, false);
  if (!noDir.ok) assert.equal(noDir.code, SessionErrorCodes.DIR_MISSING);

  const preview = previewSession(root, "aaaa");
  assert.equal(preview.ok, false);
  if (!preview.ok) assert.equal(preview.code, SessionErrorCodes.AMBIGUOUS, "同一 ref 的定位语义与 preview 一致");
});

// #11
test("deleteSession dry-run/confirm：移入 trash + sidecar 元数据、listTrash 按删除时间倒序、二次删除 NOT_FOUND", () => {
  const root = makeRoot([
    { dir: D1, file: "a.jsonl", text: sessionText("aaaa1111-0000", "C:\\p", { user: "甲" }), mtimeMs: 1_600_000_000_000 },
    { dir: D2, file: "b.jsonl", text: sessionText("bbbb2222-0000", "C:\\p2", { user: "乙" }), mtimeMs: 1_650_000_000_000 },
  ]);
  const fileA = path.join(root, D1, "a.jsonl");
  const beforeA = fs.readFileSync(fileA, "utf8");
  const preStatA = fs.statSync(fileA);
  const trashDir = path.join(tempDir("agent-manager-trash-"), "trash");

  const dry = deleteSession(root, "aaaa1111", { trashDir, now: () => T0 });
  assert.equal(dry.ok, true);
  if (!dry.ok) return;
  assert.equal(dry.value.confirmed, false);
  assert.equal(dry.value.file, fileA);
  assert.equal(dry.value.trashDir, trashDir);
  assert.equal(dry.value.trashName, `${Date.parse(T0)}-a.jsonl`);
  assert.equal(dry.value.sizeBytes, preStatA.size);
  assert.equal(fs.existsSync(fileA), true, "dry-run 源文件仍在");
  assert.equal(fs.existsSync(trashDir), false, "dry-run 不创建 trash 目录");

  const done = deleteSession(root, "aaaa1111", { trashDir, now: () => T0, confirm: true });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.value.confirmed, true);
  assert.equal(fs.existsSync(fileA), false, "confirm 后原文件消失");
  const trashPath = path.join(trashDir, done.value.trashName);
  assert.equal(fs.readFileSync(trashPath, "utf8"), beforeA, "trash 内容逐字节保留");
  const sidecar = JSON.parse(fs.readFileSync(`${trashPath}.meta.json`, "utf8")) as Record<string, unknown>;
  assert.equal(sidecar.origPath, fileA);
  assert.equal(sidecar.sizeBytes, preStatA.size);
  assert.equal(sidecar.mtimeMs, preStatA.mtimeMs);
  assert.equal(sidecar.deletedAt, T0);

  const doneB = deleteSession(root, "bbbb2222", { trashDir, now: () => T1, confirm: true });
  assert.equal(doneB.ok, true);
  if (!doneB.ok) return;

  const listed = listTrash(trashDir);
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.deepEqual(listed.value.map((e) => e.name), [doneB.value.trashName, done.value.trashName], "按删除时间倒序");
    assert.equal(listed.value[1].origPath, fileA);
    assert.equal(listed.value[1].deletedAt, T0);
    assert.equal(listed.value[1].sizeBytes, preStatA.size);
  }

  const empty = listTrash(path.join(root, "no-such-trash"));
  assert.equal(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.value, [], "trash 目录缺失返回空数组而非错误");

  const again = deleteSession(root, "aaaa1111", { trashDir, now: () => T0, confirm: true });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, SessionErrorCodes.NOT_FOUND, "二次删除目标已不在会话目录");

  const home = defaultTrashDir().replace(/\\/g, "/");
  assert.ok(home.endsWith("/.pi/agent/agent-manager/trash"), "默认 trash 位于 ~/.pi/agent/agent-manager/trash");
});

// #12
test("restoreSession：恢复原路径 + 逐字节相等 + mtime 还原；TARGET_EXISTS / NOT_FOUND / TRASH_MISSING", () => {
  const root = makeRoot([{ dir: D1, file: "r.jsonl", text: sessionText("restore1-0000", "C:\\p", { user: "hi" }), mtimeMs: 1_600_000_000_000 }]);
  const file = path.join(root, D1, "r.jsonl");
  const before = fs.readFileSync(file, "utf8");
  const trashDir = path.join(tempDir("agent-manager-trash-"), "trash");

  const del = deleteSession(root, "restore1", { trashDir, now: () => T0, confirm: true });
  assert.equal(del.ok, true);
  if (!del.ok) return;
  const trashName = del.value.trashName;
  const trashPath = path.join(trashDir, trashName);
  const sidecarPath = `${trashPath}.meta.json`;

  const dry = restoreSession(trashDir, trashName);
  assert.equal(dry.ok, true);
  if (!dry.ok) return;
  assert.equal(dry.value.confirmed, false);
  assert.equal(dry.value.restoredPath, file);
  assert.equal(fs.existsSync(file), false, "dry-run 不恢复");
  assert.equal(fs.existsSync(trashPath), true, "dry-run 条目仍在 trash");

  const done = restoreSession(trashDir, trashName, { confirm: true });
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.value.confirmed, true);
  assert.equal(done.value.restoredPath, file);
  assert.equal(fs.readFileSync(file, "utf8"), before, "恢复内容逐字节相等");
  assert.equal(fs.existsSync(trashPath), false, "恢复后 trash 数据文件消失");
  assert.equal(fs.existsSync(sidecarPath), false, "恢复后 sidecar 消失");
  const restoredMtime = fs.statSync(file).mtimeMs;
  assert.ok(Math.abs(restoredMtime - 1_600_000_000_000) < 2, `mtime 近似还原（得到 ${restoredMtime}）`);

  const del2 = deleteSession(root, "restore1", { trashDir, now: () => T1, confirm: true });
  assert.equal(del2.ok, true);
  if (!del2.ok) return;
  fs.writeFileSync(file, "占用者", "utf8");
  const blocked = restoreSession(trashDir, del2.value.trashName, { confirm: true });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, SessionErrorCodes.TARGET_EXISTS);
  assert.equal(fs.existsSync(path.join(trashDir, del2.value.trashName)), true, "TARGET_EXISTS 不动 trash 条目");
  assert.equal(fs.readFileSync(file, "utf8"), "占用者", "不覆盖已存在的目标文件");

  const unknown = restoreSession(trashDir, "nope-123.jsonl");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, SessionErrorCodes.NOT_FOUND);

  const noTrash = restoreSession(path.join(root, "no-such-trash"), "x.jsonl");
  assert.equal(noTrash.ok, false);
  if (!noTrash.ok) assert.equal(noTrash.code, SessionErrorCodes.TRASH_MISSING);
});

// #13
test("deleteSession 跨盘兜底：renameSync 抛错走 copyFileSync+unlinkSync；兜底也失败 → WRITE_FAILED 且源文件保留", () => {
  const root = makeRoot([{ dir: D1, file: "x1.jsonl", text: sessionText("x1-0000", "C:\\p", { user: "跨盘" }) }]);
  const file = path.join(root, D1, "x1.jsonl");
  const before = fs.readFileSync(file, "utf8");
  const trashDir = path.join(tempDir("agent-manager-trash-"), "trash");
  const calls: string[] = [];
  const deps = fakeDeps({
    renameSync: () => {
      calls.push("rename");
      const err = new Error("EXDEV: cross-device link not permitted") as Error & { code?: string };
      err.code = "EXDEV";
      throw err;
    },
    copyFileSync: (from, to) => {
      calls.push("copy");
      fs.copyFileSync(from, to);
    },
    unlinkSync: (p) => {
      calls.push("unlink");
      fs.unlinkSync(p);
    },
  });
  const moved = deleteSession(root, "x1", { trashDir, now: () => T0, confirm: true }, deps);
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.deepEqual(calls, ["rename", "copy", "unlink"], "rename 失败 → copy → unlink 固定顺序");
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(trashDir, moved.value.trashName), "utf8"), before, "兜底路径同样逐字节保留");

  const root2 = makeRoot([{ dir: D1, file: "x2.jsonl", text: sessionText("x2-0000", "C:\\p", { user: "第二" }) }]);
  const file2 = path.join(root2, D1, "x2.jsonl");
  const failing = fakeDeps({
    renameSync: () => {
      throw new Error("EXDEV");
    },
    copyFileSync: () => {
      throw new Error("EACCES");
    },
  });
  const failed = deleteSession(root2, "x2", { trashDir: path.join(tempDir("agent-manager-trash-"), "t2"), now: () => T0, confirm: true }, failing);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, SessionErrorCodes.WRITE_FAILED);
  assert.equal(fs.existsSync(file2), true, "移动失败时源文件必须保留");
});

// #14
test("性能看门：200 会话 × ~100KB（约 20MB）listSessions < 1s（墙钟）", () => {
  const root = tempDir("agent-manager-perf-");
  const dir = path.join(root, D1);
  fs.mkdirSync(dir, { recursive: true });
  const blob = "a".repeat(100 * 1024);
  for (let i = 0; i < 200; i++) {
    const name = `s${String(i).padStart(3, "0")}.jsonl`;
    fs.writeFileSync(path.join(dir, name), sessionText(`perf-${i}-0000`, "C:\\p", { user: `${blob}-${i}` }), "utf8");
  }

  const started = Date.now();
  const r = listSessions(root);
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.length, 200);
  assert.ok(elapsed < 1000, `200×100KB listSessions 用时 ${elapsed}ms（门限 1000ms）`);
});
