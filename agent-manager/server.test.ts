/**
 * agent-manager W3 — HTTP server 测试（TDD：先红后绿）。
 *
 * 边界与手法：
 * - 全部走真实 node:http server（端口 0 随机、仅 127.0.0.1）+ 真实 fetch / http.request；
 *   会话数据在系统临时目录真读真写，测后清理，绝不触碰用户真实 `~/.pi/agent`。
 * - agents 端点用真实 node stub 脚本（经 AgentRunner 真 spawn）驱动：短命 stub 验证
 *   running→exited / sessionId / 输出归约，常驻 stub 验证 stop 端点与进程清理——
 *   这是进程边界的真实现，不是纸面替身。
 * - 页面自包含用例直接读 web/ 磁盘文件（零外部 URL 是验收 #3 的自动化证据）。
 * - Host 守卫必须用原始 http.request 直发（fetch 同源永远发合法 Host，测不出）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type ServerHandle } from "./server.ts";
import {
  listSessions,
  searchSessions,
  previewSession,
  type SearchHit,
  type SessionMeta,
  type SessionPreview,
  type TrashEntry,
} from "./core.ts";
import { resolvePiCommand, type AgentRecord, type OutputLine } from "./agent-runner.ts";
import type { AgentManagerSettings } from "./settings.ts";

const T0 = "2026-09-11T00:00:00.000Z";
const D1 = "--C--Users-12967-proj-one--";
const D2 = "--C--Users-12967-proj-two--";

// ------------------------------------------------------------ 临时目录与清理

const created: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* 清理失败不掩盖断言 */
  }
}
after(() => {
  for (const dir of created) removeTempDir(dir);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------ 会话 fixture

interface SessionFixtureOptions {
  name?: string;
  model?: string;
  user?: string;
  assistant?: string;
}

/** 造一条 v3 会话 JSONL：header + 可选 name/model_change/user/assistant。 */
function sessionText(id: string, cwd: string, options: SessionFixtureOptions = {}): string {
  const lines: string[] = [JSON.stringify({ type: "session", version: 3, id, timestamp: T0, cwd })];
  if (options.name) {
    lines.push(JSON.stringify({ type: "session_info", id: "00000001", parentId: null, timestamp: T0, name: options.name }));
  }
  if (options.model) {
    lines.push(JSON.stringify({ type: "model_change", id: "00000002", parentId: null, timestamp: T0, provider: "p", modelId: options.model }));
  }
  if (options.user) {
    lines.push(JSON.stringify({ type: "message", id: "00000003", parentId: null, timestamp: T0, message: { role: "user", content: [{ type: "text", text: options.user }], timestamp: 1 } }));
  }
  if (options.assistant) {
    lines.push(JSON.stringify({ type: "message", id: "00000004", parentId: null, timestamp: T0, message: { role: "assistant", content: [{ type: "text", text: options.assistant }], provider: "p", model: options.model ?? "m", usage: {}, stopReason: "stop", timestamp: 2 } }));
  }
  return lines.join("\n") + "\n";
}

interface SessionFixture {
  dir?: string;
  file: string;
  text: string;
  mtimeMs?: number;
}

function prepareSessions(sessionDir: string, files: SessionFixture[]): void {
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const fixture of files) {
    const dir = fixture.dir ? path.join(sessionDir, fixture.dir) : sessionDir;
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fixture.file);
    fs.writeFileSync(filePath, fixture.text, "utf8");
    if (fixture.mtimeMs) fs.utimesSync(filePath, fixture.mtimeMs / 1000, fixture.mtimeMs / 1000);
  }
}

// ------------------------------------------------------------ 服务与 HTTP 工具

interface TestServer {
  handle: ServerHandle;
  port: number;
  settings: AgentManagerSettings;
  configPath: string;
  base: string;
}

interface LaunchOptions {
  files?: SessionFixture[];
  sessionDir?: string;
  piPath?: string;
  now?: () => string;
}

/** 每次独立临时 base：sessions / trash / config 全隔离，端口 0 并发安全。 */
async function launchServer(options: LaunchOptions = {}): Promise<TestServer> {
  const base = tempDir("am-server-");
  const sessionDir = options.sessionDir ?? path.join(base, "sessions");
  prepareSessions(sessionDir, options.files ?? []);
  const settings: AgentManagerSettings = {
    port: 0,
    sessionDir,
    piPath: options.piPath,
    trashDir: path.join(base, "trash"),
    openBrowser: false,
  };
  const configPath = path.join(base, "config.json");
  const handle = await startServer({ settings, configPath, now: options.now });
  return { handle, port: handle.port, settings, configPath, base };
}

interface JsonBody {
  ok: boolean;
  value?: unknown;
  code?: string;
  message?: string;
}

async function apiGet(ts: TestServer, apiPath: string, headers?: Record<string, string>): Promise<{ status: number; body: JsonBody }> {
  const res = await fetch(`http://127.0.0.1:${ts.port}${apiPath}`, { headers });
  return { status: res.status, body: (await res.json()) as JsonBody };
}

async function apiPost(ts: TestServer, apiPath: string, body: unknown): Promise<{ status: number; body: JsonBody }> {
  const res = await fetch(`http://127.0.0.1:${ts.port}${apiPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as JsonBody };
}

/** 原始请求：用于伪造 Host、raw path（fetch 会规范化两者）。 */
function rawRequest(port: number, options: { method?: string; path: string; headers?: Record<string, string> }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: options.headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function stopRunningAgents(ts: TestServer): Promise<void> {
  try {
    const list = await apiGet(ts, "/api/agents");
    const agents = (list.body.value ?? []) as AgentRecord[];
    for (const agent of agents) {
      if (agent.status === "running") await apiPost(ts, `/api/agents/${agent.id}/stop`, {});
    }
  } catch {
    /* 尽力清理，不掩盖断言 */
  }
}

async function closeServer(ts: TestServer): Promise<void> {
  await stopRunningAgents(ts);
  await ts.handle.close();
}

async function pollAgents(ts: TestServer): Promise<AgentRecord[]> {
  const res = await apiGet(ts, "/api/agents");
  return (res.body.value ?? []) as AgentRecord[];
}

async function waitForAgent(ts: TestServer, predicate: (agent: AgentRecord) => boolean, timeoutMs: number, label: string): Promise<AgentRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: AgentRecord | undefined;
  while (Date.now() < deadline) {
    const agents = await pollAgents(ts);
    last = agents.find(predicate);
    if (last) return last;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}${last ? `（最后状态 ${last.status}）` : ""}`);
}

// ------------------------------------------------------------ stub pi 脚本

function writeStub(dir: string, fileName: string, body: string): string {
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/** 短命 stub：会话头 + 用户/助手消息，延迟 500ms 后退出 0（留出 running 可见窗口）。 */
function writeShortLivedStub(dir: string): string {
  const source = [
    'console.log(JSON.stringify({ type: "session", id: "stub-session-short" }));',
    'console.log(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "stub 问题" }] } }));',
    "await new Promise((resolve) => setTimeout(resolve, 500));",
    'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stub 回答" }] } }));',
    "process.exit(0);",
    "",
  ].join("\n");
  return writeStub(dir, "short-stub.mjs", source);
}

/** 常驻 stub：只打印会话头，不退出（stop 端点用）。 */
function writeResidentStub(dir: string): string {
  const source = [
    'console.log(JSON.stringify({ type: "session", id: "stub-session-resident" }));',
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
  return writeStub(dir, "resident-stub.mjs", source);
}

/** 三行输出 stub：user + assistant ×2，随后立即退出（output 增量用）。 */
function writeLinesStub(dir: string): string {
  const source = [
    'console.log(JSON.stringify({ type: "session", id: "stub-session-lines" }));',
    'console.log(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "第一行" }] } }));',
    'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第二行" }] } }));',
    'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第三行" }] } }));',
    "",
  ].join("\n");
  return writeStub(dir, "lines-stub.mjs", source);
}

// ------------------------------------------------------------------- 测试

test("health：200 + 设置回显（version/port/sessionDir/piCommand）", async () => {
  const ts = await launchServer();
  try {
    const res = await apiGet(ts, "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const value = res.body.value as { version: string; port: number; sessionDir: string; piCommand: { command: string; prefixArgs: string[] } };
    assert.equal(typeof value.version, "string");
    assert.ok(value.version.length > 0);
    assert.equal(value.port, ts.port);
    assert.equal(value.sessionDir, ts.settings.sessionDir);
    assert.deepEqual(value.piCommand, resolvePiCommand(ts.settings.piPath, process.platform));
  } finally {
    await closeServer(ts);
  }
});

test("sessions：list/search/preview 接线临时目录，值与 core 直调一致", async () => {
  const root = tempDir("am-sessions-");
  prepareSessions(root, [
    { dir: D1, file: "2026-01-01T00-00-00-000Z_aaa.jsonl", text: sessionText("aaa-0001", "C:\\proj\\one", { user: "帮我修登录页", assistant: "好的" }), mtimeMs: 1_700_000_000_000 },
    { dir: D2, file: "2026-02-01T00-00-00-000Z_bbb.jsonl", text: sessionText("bbb-0002", "C:\\proj\\two", { name: "第二个会话", user: "部署脚本", assistant: "完成" }), mtimeMs: 1_800_000_000_000 },
  ]);
  const ts = await launchServer({ sessionDir: root });
  try {
    const list = await apiGet(ts, "/api/sessions");
    assert.equal(list.status, 200);
    const directList = listSessions(root);
    assert.equal(directList.ok, true);
    if (!directList.ok) return;
    assert.deepEqual(list.body.value, directList.value);

    const limited = await apiGet(ts, "/api/sessions?limit=1");
    assert.equal((limited.body.value as SessionMeta[]).length, 1);

    const search = await apiGet(ts, "/api/sessions/search?q=%E7%99%BB%E5%BD%95");
    const directSearch = searchSessions(root, "登录");
    assert.equal(directSearch.ok, true);
    if (!directSearch.ok) return;
    assert.deepEqual(search.body.value, directSearch.value);
    assert.equal((search.body.value as SearchHit[]).length, 1);

    const preview = await apiGet(ts, "/api/sessions/preview?ref=bbb");
    const directPreview = previewSession(root, "bbb");
    assert.equal(directPreview.ok, true);
    if (!directPreview.ok) return;
    assert.deepEqual(preview.body.value, directPreview.value);
    assert.equal((preview.body.value as SessionPreview).meta.name, "第二个会话");
  } finally {
    await closeServer(ts);
  }
});

test("错误映射：BAD_QUERY→400 / NOT_FOUND→404 / AMBIGUOUS→409 / BAD_NAME→400，体含 code", async () => {
  const root = tempDir("am-errors-");
  prepareSessions(root, [
    { dir: D1, file: "dup-a.jsonl", text: sessionText("dup-aaaa", "C:\\proj\\one", { user: "dup" }) },
    { dir: D1, file: "dup-b.jsonl", text: sessionText("dup-bbbb", "C:\\proj\\one", { user: "dup" }) },
    { dir: D2, file: "solo.jsonl", text: sessionText("solo-0001", "C:\\proj\\two", { user: "solo" }) },
  ]);
  const ts = await launchServer({ sessionDir: root });
  try {
    const badQuery = await apiGet(ts, "/api/sessions/search?q=");
    assert.equal(badQuery.status, 400);
    assert.equal(badQuery.body.ok, false);
    assert.equal(badQuery.body.code, "SESSION_BAD_QUERY");

    const notFound = await apiGet(ts, "/api/sessions/preview?ref=nope-nope");
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.code, "SESSION_NOT_FOUND");

    const missingRef = await apiGet(ts, "/api/sessions/preview");
    assert.equal(missingRef.status, 404);
    assert.equal(missingRef.body.code, "SESSION_NOT_FOUND");

    const ambiguous = await apiGet(ts, "/api/sessions/preview?ref=dup");
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.body.code, "SESSION_AMBIGUOUS");

    const badName = await apiPost(ts, "/api/sessions/rename", { ref: "solo", name: "\r\n" });
    assert.equal(badName.status, 400);
    assert.equal(badName.body.code, "SESSION_BAD_NAME");
  } finally {
    await closeServer(ts);
  }
});

test("rename：dry-run 文件不变 → confirm 追加 session_info 行，列表立即反映新名", async () => {
  const root = tempDir("am-rename-");
  prepareSessions(root, [
    { dir: D1, file: "2026-01-01T00-00-00-000Z_sess-a.jsonl", text: sessionText("sess-a-0001", "C:\\proj\\one", { user: "hello" }) },
  ]);
  const file = path.join(root, D1, "2026-01-01T00-00-00-000Z_sess-a.jsonl");
  const before = fs.readFileSync(file, "utf8");
  const ts = await launchServer({ sessionDir: root });
  try {
    const dry = await apiPost(ts, "/api/sessions/rename", { ref: "sess-a", name: "新标题" });
    assert.equal(dry.status, 200);
    const plan = dry.body.value as { confirmed: boolean; appendLine: string; currentName: string; newName: string; file: string };
    assert.equal(plan.confirmed, false);
    assert.equal(plan.file, file);
    assert.equal(plan.currentName, "");
    assert.equal(plan.newName, "新标题");
    const planned = JSON.parse(plan.appendLine) as { type: string; name: string; id: string };
    assert.equal(planned.type, "session_info");
    assert.equal(planned.name, "新标题");
    assert.equal(fs.readFileSync(file, "utf8"), before, "dry-run 不得产生写副作用");

    const confirmed = await apiPost(ts, "/api/sessions/rename", { ref: "sess-a", name: "新标题", confirm: true });
    assert.equal(confirmed.status, 200);
    const outcome = confirmed.body.value as { confirmed: boolean; appendLine: string };
    assert.equal(outcome.confirmed, true);

    const after = fs.readFileSync(file, "utf8");
    assert.ok(after.startsWith(before), "原内容必须逐字节保留");
    assert.equal(after, `${before}${outcome.appendLine}\n`);
    const appended = JSON.parse(after.slice(before.length).trim()) as { type: string; name: string };
    assert.equal(appended.type, "session_info");
    assert.equal(appended.name, "新标题");

    const list = await apiGet(ts, "/api/sessions");
    assert.ok((list.body.value as SessionMeta[]).some((meta) => meta.name === "新标题"));
  } finally {
    await closeServer(ts);
  }
});

test("delete/trash/restore 全链路（HTTP）：dry-run 零副作用、confirm 移入 trash、restore 逐字节还原", async () => {
  const root = tempDir("am-delete-");
  prepareSessions(root, [
    { dir: D1, file: "2026-01-01T00-00-00-000Z_gone.jsonl", text: sessionText("gone-0001", "C:\\proj\\one", { user: "删我" }) },
  ]);
  const file = path.join(root, D1, "2026-01-01T00-00-00-000Z_gone.jsonl");
  const before = fs.readFileSync(file, "utf8");
  const ts = await launchServer({ sessionDir: root });
  try {
    const dry = await apiPost(ts, "/api/sessions/delete", { ref: "gone" });
    assert.equal(dry.status, 200);
    const plan = dry.body.value as { confirmed: boolean; trashName: string };
    assert.equal(plan.confirmed, false);
    assert.ok(plan.trashName.endsWith("_gone.jsonl"));
    assert.equal(fs.existsSync(file), true, "dry-run 不得删文件");

    const confirmed = await apiPost(ts, "/api/sessions/delete", { ref: "gone", confirm: true });
    assert.equal(confirmed.status, 200);
    assert.equal((confirmed.body.value as { confirmed: boolean }).confirmed, true);
    assert.equal(fs.existsSync(file), false);

    const trash = await apiGet(ts, "/api/trash");
    const entries = trash.body.value as TrashEntry[];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].origPath, file);
    assert.equal(entries[0].name, plan.trashName);
    assert.ok(fs.existsSync(path.join(ts.settings.trashDir, entries[0].name)));

    const restoreDry = await apiPost(ts, "/api/trash/restore", { name: entries[0].name });
    assert.equal(restoreDry.status, 200);
    assert.equal((restoreDry.body.value as { confirmed: boolean }).confirmed, false);
    assert.equal(fs.existsSync(file), false, "dry-run 不得恢复文件");

    const restore = await apiPost(ts, "/api/trash/restore", { name: entries[0].name, confirm: true });
    assert.equal(restore.status, 200);
    const restored = restore.body.value as { restoredPath: string; confirmed: boolean };
    assert.equal(restored.confirmed, true);
    assert.equal(restored.restoredPath, file);
    assert.equal(fs.readFileSync(file, "utf8"), before, "恢复内容必须逐字节相等");

    const again = await apiPost(ts, "/api/trash/restore", { name: entries[0].name });
    assert.equal(again.status, 404);
    assert.equal(again.body.code, "SESSION_NOT_FOUND");
  } finally {
    await closeServer(ts);
  }
});

test("agents：stub pi 启动 → 列表 running → 退出 exited，sessionId 与输出行可见", async () => {
  const base = tempDir("am-agents-run-");
  const stub = writeShortLivedStub(base);
  const ts = await launchServer({ piPath: stub });
  try {
    const started = await apiPost(ts, "/api/agents/start", { cwd: base, prompt: "跑一下", kind: "new", name: "stub-run" });
    assert.equal(started.status, 200);
    assert.equal(started.body.ok, true);
    const record = started.body.value as AgentRecord;
    assert.equal(record.spec.name, "stub-run");

    const running = await waitForAgent(ts, (agent) => agent.id === record.id && agent.status === "running", 10000, "running 可见");
    assert.equal(running.id, record.id);

    const exited = await waitForAgent(ts, (agent) => agent.id === record.id && agent.status !== "running", 15000, "agent 退出");
    assert.equal(exited.status, "exited");
    assert.equal(exited.sessionId, "stub-session-short");

    const output = await apiGet(ts, `/api/agents/${record.id}/output`);
    assert.equal(output.status, 200);
    const lines = (output.body.value as { lines: OutputLine[]; total: number }).lines;
    assert.ok(lines.some((line) => line.kind === "assistant" && line.text === "stub 回答"));

    const one = await apiGet(ts, `/api/agents/${record.id}`);
    assert.equal(one.status, 200);
    assert.equal((one.body.value as AgentRecord).status, "exited");
  } finally {
    await closeServer(ts);
  }
});

test("agents stop 端点：常驻 stub → stopped；重复 stop 409、未知 id 404", async () => {
  const base = tempDir("am-agents-stop-");
  const stub = writeResidentStub(base);
  const ts = await launchServer({ piPath: stub });
  try {
    const started = await apiPost(ts, "/api/agents/start", { cwd: base, prompt: "常驻", kind: "new" });
    assert.equal(started.status, 200);
    const record = started.body.value as AgentRecord;
    await waitForAgent(ts, (agent) => agent.id === record.id && agent.status === "running", 10000, "running");

    const stop = await apiPost(ts, `/api/agents/${record.id}/stop`, {});
    assert.equal(stop.status, 200);
    await waitForAgent(ts, (agent) => agent.id === record.id && agent.status === "stopped", 15000, "状态 stopped");

    const again = await apiPost(ts, `/api/agents/${record.id}/stop`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "AGENT_NOT_RUNNING");

    const missing = await apiPost(ts, "/api/agents/nope1234/stop", {});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "AGENT_NOT_FOUND");

    const missingGet = await apiGet(ts, "/api/agents/nope1234");
    assert.equal(missingGet.status, 404);
    assert.equal(missingGet.body.code, "AGENT_NOT_FOUND");
  } finally {
    await closeServer(ts);
  }
});

test("agents output：?since= 增量语义与 total；未知 id 404", async () => {
  const base = tempDir("am-agents-output-");
  const stub = writeLinesStub(base);
  const ts = await launchServer({ piPath: stub });
  try {
    const started = await apiPost(ts, "/api/agents/start", { cwd: base, prompt: "三行", kind: "new" });
    assert.equal(started.status, 200);
    const id = (started.body.value as AgentRecord).id;

    const deadline = Date.now() + 15000;
    let total = 0;
    while (Date.now() < deadline) {
      const res = await apiGet(ts, `/api/agents/${id}/output`);
      total = (res.body.value as { total: number }).total;
      if (total >= 3) break;
      await sleep(50);
    }
    assert.ok(total >= 3, `应至少有 3 条输出（实际 ${total}）`);

    const since2 = await apiGet(ts, `/api/agents/${id}/output?since=2`);
    const incremental = since2.body.value as { lines: OutputLine[]; total: number };
    assert.equal(incremental.total, total);
    assert.deepEqual(incremental.lines.map((line) => line.seq), [3]);
    assert.equal(incremental.lines[0].text, "第三行");

    const sinceLatest = await apiGet(ts, `/api/agents/${id}/output?since=${total}`);
    assert.deepEqual((sinceLatest.body.value as { lines: OutputLine[] }).lines, []);

    const missing = await apiGet(ts, "/api/agents/nope1234/output?since=0");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "AGENT_NOT_FOUND");
  } finally {
    await closeServer(ts);
  }
});

test("守卫：BAD_SPEC→400、非 JSON Content-Type→415、body 超 1MB→400", async () => {
  const base = tempDir("am-guards-");
  const ts = await launchServer();
  try {
    const badSpec = await apiPost(ts, "/api/agents/start", { cwd: base, prompt: "   ", kind: "new" });
    assert.equal(badSpec.status, 400);
    assert.equal(badSpec.body.code, "AGENT_BAD_SPEC");

    const wrongType = await fetch(`http://127.0.0.1:${ts.port}/api/sessions/rename`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);

    const oversize = await fetch(`http://127.0.0.1:${ts.port}/api/sessions/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "x", name: "a".repeat(1024 * 1024 + 1) }),
    });
    assert.equal(oversize.status, 400);
  } finally {
    await closeServer(ts);
  }
});

test("Host 头守卫：伪造 Host: evil.com → 403，127.0.0.1/localhost 放行", async () => {
  const ts = await launchServer();
  try {
    const evil = await rawRequest(ts.port, { path: "/api/health", headers: { Host: "evil.com" } });
    assert.equal(evil.status, 403);
    assert.equal((JSON.parse(evil.text) as { code: string }).code, "HTTP_FORBIDDEN_HOST");

    const byName = await rawRequest(ts.port, { path: "/api/health", headers: { Host: "localhost" } });
    assert.equal(byName.status, 200);

    const byIp = await rawRequest(ts.port, { path: "/api/health", headers: { Host: `127.0.0.1:${ts.port}` } });
    assert.equal(byIp.status, 200);
  } finally {
    await closeServer(ts);
  }
});

test("静态资源白名单：/ 返回 HTML 且 Content-Type/no-store 正确，未知与穿越 404", async () => {
  const ts = await launchServer();
  try {
    const index = await rawRequest(ts.port, { path: "/" });
    assert.equal(index.status, 200);
    assert.match(index.text, /app\.js/);
    assert.match(index.text, /style\.css/);

    const indexRes = await fetch(`http://127.0.0.1:${ts.port}/index.html`);
    assert.equal(indexRes.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(indexRes.headers.get("cache-control"), "no-store");

    const appJs = await fetch(`http://127.0.0.1:${ts.port}/app.js`);
    assert.equal(appJs.status, 200);
    assert.equal(appJs.headers.get("content-type"), "text/javascript; charset=utf-8");

    const style = await fetch(`http://127.0.0.1:${ts.port}/style.css`);
    assert.equal(style.status, 200);
    assert.equal(style.headers.get("content-type"), "text/css; charset=utf-8");

    const traversal = await rawRequest(ts.port, { path: "/../core.ts" });
    assert.equal(traversal.status, 404);

    const unknown = await fetch(`http://127.0.0.1:${ts.port}/nope`);
    assert.equal(unknown.status, 404);
  } finally {
    await closeServer(ts);
  }
});

test("页面自包含：web/ 三文件无任何外部 URL（离线可用）", () => {
  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
  for (const name of ["index.html", "app.js", "style.css"]) {
    const file = path.join(webDir, name);
    assert.equal(fs.existsSync(file), true, `${name} 应存在`);
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes("http://"), false, `${name} 不得含 http://`);
    assert.equal(text.includes("https://"), false, `${name} 不得含 https://`);
    assert.equal(/@import\s+url\(\s*["']?http/i.test(text), false, `${name} 不得 @import 远程样式`);
  }
});

test("settings：GET/POST 落临时 configPath、sessionDir 即时生效、port 变更 restartRequired、非法值 400", async () => {
  const base = tempDir("am-settings-");
  const rootA = path.join(base, "sessions-a");
  prepareSessions(rootA, [
    { dir: D1, file: "settle-a.jsonl", text: sessionText("settle-a", "C:\\proj\\one", { user: "hello" }) },
  ]);
  const rootB = path.join(base, "sessions-b");
  prepareSessions(rootB, [
    { file: "only-b.jsonl", text: sessionText("only-b", "C:\\proj\\two", { user: "world" }) },
  ]);
  const ts = await launchServer({ sessionDir: rootA });
  try {
    const initial = await apiGet(ts, "/api/settings");
    assert.equal(initial.status, 200);
    const info = initial.body.value as {
      settings: AgentManagerSettings;
      resolvedPi: { command: string; prefixArgs: string[] };
      configPath: string;
      restartRequired: boolean;
    };
    assert.equal(info.settings.sessionDir, rootA);
    assert.equal(info.settings.trashDir, ts.settings.trashDir);
    assert.equal(info.settings.openBrowser, false);
    assert.equal(info.configPath, ts.configPath);
    assert.deepEqual(info.resolvedPi, resolvePiCommand(undefined, process.platform));
    assert.equal(info.restartRequired, false);

    const saved = await apiPost(ts, "/api/settings", { sessionDir: rootB });
    assert.equal(saved.status, 200);
    const savedValue = saved.body.value as { saved: AgentManagerSettings; restartRequired: boolean };
    assert.equal(savedValue.saved.sessionDir, rootB);
    assert.equal(savedValue.restartRequired, false);

    const config = JSON.parse(fs.readFileSync(ts.configPath, "utf8")) as { sessionDir?: string };
    assert.equal(config.sessionDir, rootB);

    const list = await apiGet(ts, "/api/sessions");
    const metas = list.body.value as SessionMeta[];
    assert.ok(metas.some((meta) => meta.id === "only-b"), "sessionDir 应即时生效");
    assert.equal(metas.some((meta) => meta.id === "settle-a"), false);

    const portChanged = await apiPost(ts, "/api/settings", { port: 4321 });
    assert.equal(portChanged.status, 200);
    assert.equal((portChanged.body.value as { restartRequired: boolean }).restartRequired, true);

    const invalid = await apiPost(ts, "/api/settings", { port: "abc" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "SETTINGS_INVALID");
  } finally {
    await closeServer(ts);
  }
});
