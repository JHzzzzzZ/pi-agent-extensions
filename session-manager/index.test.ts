/**
 * session-manager 扩展接线测试。
 *
 * 边界：fake ExtensionAPI 只捕获注册面（工具/命令），执行走注入的临时会话根目录，
 * 覆盖「参数 → core → 真实 JSONL 读取」的完整链路；不触碰用户真实会话目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sessionManager from "./index.ts";

interface FakeCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, FakeCommand>();
  const api = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, opts: { description: string; handler: FakeCommand["handler"] }) =>
      commands.set(name, { name, ...opts }),
  };
  return { api: api as never, tools, commands };
}

const DIR = "--C--Users-12967-proj--";

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-ext-"));
  const dir = path.join(root, DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "2026-09-11T00-00-00-000Z_11112222.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "11112222-3333", timestamp: "2026-09-11T00:00:00.000Z", cwd: "C:\\proj" }),
      JSON.stringify({ type: "session_info", id: "01", parentId: null, timestamp: "2026-09-11T00:00:01.000Z", name: "派单测试" }),
      JSON.stringify({
        type: "message", id: "02", parentId: null, timestamp: "2026-09-11T00:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: "帮我看一下 agent-team 的状态" }], timestamp: 1 },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  return root;
}

function makeCtx(cwd: string, notices: string[]) {
  return {
    hasUI: true,
    sessionManager: { getCwd: () => cwd, getSessionDir: () => path.join(cwd, "sessions", DIR) },
    ui: { notify: (message: string) => notices.push(message) },
  };
}

async function runTool(tools: Map<string, any>, params: Record<string, unknown>, ctx: unknown) {
  const tool = tools.get("session");
  assert.ok(tool, "应注册名为 session 的工具");
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

test("session-manager：注册 session 工具与冒号命令面（均有描述）", () => {
  const { api, tools, commands } = makeFakePi();
  sessionManager(api, { rootDir: makeRoot() });
  assert.ok(tools.get("session"));
  assert.deepEqual([...commands.keys()].sort(), ["session-manager", "session-manager:list", "session-manager:preview", "session-manager:search"]);
  for (const c of commands.values()) assert.ok(c.description.length > 0, `${c.name} 应有描述`);
});

test("工具 session：list / search / preview 输出真实会话元数据与宿主接续命令", async () => {
  const root = makeRoot();
  const { api, tools } = makeFakePi();
  sessionManager(api, { rootDir: root });
  const ctx = makeCtx("C:\\proj", []);

  const list = await runTool(tools, { action: "list" }, ctx);
  assert.notEqual(list.isError, true);
  assert.match(list.content[0].text, /11112222/);
  assert.match(list.content[0].text, /派单测试/);

  const search = await runTool(tools, { action: "search", query: "agent-team" }, ctx);
  assert.notEqual(search.isError, true);
  assert.match(search.content[0].text, /11112222/);

  const preview = await runTool(tools, { action: "preview", ref: "11112222" }, ctx);
  assert.notEqual(preview.isError, true);
  assert.match(preview.content[0].text, /pi --session 11112222/);
  assert.match(preview.content[0].text, /pi --fork 11112222/);

  const missing = await runTool(tools, { action: "preview", ref: "zzzz" }, ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /找不到|SESSION_NOT_FOUND/);
});

test("命令面：裸 /session-manager 列当前项目、:search 检索、:preview 给接续命令、旧空格写法提示改名", async () => {
  const root = makeRoot();
  const { api, commands } = makeFakePi();
  sessionManager(api, { rootDir: root });
  const notices: string[] = [];
  const ctx = makeCtx("C:\\proj", notices);

  await commands.get("session-manager")!.handler("", ctx);
  assert.match(notices.at(-1)!, /11112222/);

  await commands.get("session-manager")!.handler("list", ctx);
  assert.match(notices.at(-1)!, /已改名为「\/session-manager:list」/);

  await commands.get("session-manager:search")!.handler("agent-team", ctx);
  assert.match(notices.at(-1)!, /11112222/);

  await commands.get("session-manager:preview")!.handler("11112222", ctx);
  assert.match(notices.at(-1)!, /pi --session 11112222/);
});

test("没有任何会话时给出可读提示而不是崩溃", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-manager-empty-"));
  const { api, tools } = makeFakePi();
  sessionManager(api, { rootDir: root });
  const ctx = makeCtx("C:\\proj", []);
  const list = await runTool(tools, { action: "list" }, ctx);
  assert.notEqual(list.isError, true);
  assert.match(list.content[0].text, /0 个|没有/);
});
