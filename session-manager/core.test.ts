/**
 * session-manager 核心纯逻辑测试。
 *
 * 边界：真实临时目录 + 真实 JSONL 文件（会话数据是真读的），fs 注入只用于
 * 覆盖「目录缺失 / 文件读失败」这类进程边界分支；不触碰用户真实会话目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseSessionText,
  listSessions,
  searchSessions,
  previewSession,
  formatList,
  formatPreview,
  SessionErrorCodes,
  type SessionFsDeps,
} from "./core.ts";

const T0 = "2026-09-11T00:00:00.000Z";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-"));
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

test("listSessions：按修改时间倒序、cwd 过滤、目录缺失报错、坏文件跳过", () => {
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
});

test("listSessions：单文件读失败不拖垮整次扫描（注入 fake fs）", () => {
  const realRoot = makeRoot([{ dir: D1, file: "ok.jsonl", text: sessionText("ok", "C:\\p", { user: "hi" }) }]);
  const realRead = fs.readFileSync.bind(fs);
  const deps: SessionFsDeps = {
    existsSync: fs.existsSync,
    readdirSync: (p) => fs.readdirSync(p),
    statSync: (p) => fs.statSync(p),
    readFileSync: (p) => {
      if (p.endsWith("bad.jsonl")) throw new Error("EACCES");
      return realRead(p, "utf8");
    },
  };
  fs.writeFileSync(path.join(realRoot, D1, "bad.jsonl"), "x", "utf8");
  const r = listSessions(realRoot, {}, deps);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value.map((m) => m.id), ["ok"]);
});

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

test("formatList / formatPreview：确定性文本包含 id、大小、标题与宿主接续指引", () => {
  const root = makeRoot([
    { dir: D1, file: "a.jsonl", text: sessionText("aaaa1111-2222", "C:\\proj\\one", { name: "会话甲", model: "flash", user: "给我派个 agent" }), mtimeMs: 1_700_000_000_000 },
  ]);
  const listed = listSessions(root);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const text = formatList(listed.value);
  assert.match(text, /会话 1 个/);
  assert.match(text, /aaaa1111/);
  assert.match(text, /会话甲/);
  assert.match(text, /C:\\proj\\one/);

  const preview = previewSession(root, "aaaa1111");
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  const ptext = formatPreview(preview.value);
  assert.match(ptext, /接续：pi --session aaaa1111/);
  assert.match(ptext, /分支：pi --fork aaaa1111/);
  assert.match(ptext, /用户 1/);
});
