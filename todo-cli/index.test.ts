/**
 * todo-cli 扩展接线测试。
 *
 * 边界：fake ExtensionAPI 只捕获注册面（工具/命令）；执行走真实临时仓库目录，
 * 覆盖 argv 翻译 → core.main → 真实文件写入的完整链路；不触碰仓库真实 todos/。
 * triage 的 git 事实用注入的 fake execGit 提供（不依赖真实 git / worktree 布局）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import todoCli from "./index.ts";

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

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-ext-"));
  fs.mkdirSync(path.join(root, "todos"), { recursive: true });
  fs.writeFileSync(path.join(root, "todos", "general-todo.md"), "# TODO（通用领域）\r\n\r\n", "utf8");
  return root;
}

function makeCtx(root: string, notices: string[]) {
  return {
    hasUI: true,
    sessionManager: { getCwd: () => root },
    ui: { notify: (message: string) => notices.push(message) },
  };
}

const WORKTREES = [
  "worktree C:/repo",
  "HEAD aaa111",
  "branch refs/heads/dev-laptop",
  "",
  "worktree C:/repo/.worktrees/demo",
  "HEAD bbb222",
  "branch refs/heads/feat/demo",
  "",
].join("\n");

function fakeExecGit(args: string[]): string {
  if (args[0] === "worktree") return WORKTREES;
  if (args[0] === "branch") return "  dev-laptop\n* feat/demo\n";
  if (args[0] === "status") return "";
  return "";
}

function readTodo(root: string): string {
  return fs.readFileSync(path.join(root, "todos", "general-todo.md"), "utf8");
}

async function runTool(tools: Map<string, any>, params: Record<string, unknown>, ctx: unknown) {
  const tool = tools.get("todos");
  assert.ok(tool, "应注册名为 todos 的工具");
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

test("todo-cli：注册 todos 工具与冒号命令面（/todo + 6 条子命令，均有描述）", () => {
  const { api, tools, commands } = makeFakePi();
  todoCli(api, { execGit: fakeExecGit });

  assert.ok(tools.get("todos"), "工具名应为 todos");
  // 回归锁：第三方 @juicesharp/rpiv-todo 注册同名工具 todo，宿主注册表无命名空间，
  // 再注册 "todo" 会让后加载的一方整个扩展加载失败（用户实测报错）。
  assert.equal(tools.has("todo"), false, "不得再注册工具名 todo（与 rpiv-todo 冲突）");
  assert.match(tools.get("todos").description, /todos\//);
  assert.deepEqual(
    [...commands.keys()].sort(),
    ["todo", "todo:add", "todo:claim", "todo:complete", "todo:lint", "todo:list", "todo:triage"],
  );
  for (const c of commands.values()) assert.ok(c.description.length > 0, `${c.name} 应有描述`);
});

test("工具 todos：add→claim→complete 全链路写真实文件、保持 CRLF、重复登记被拒", async () => {
  const root = makeRepo();
  const { api, tools } = makeFakePi();
  todoCli(api, { execGit: fakeExecGit });
  const ctx = makeCtx(root, []);

  const added = await runTool(tools, { action: "add", file: "general", text: "需求甲" }, ctx);
  assert.notEqual(added.isError, true);
  assert.match(added.content[0].text, /已登记到 todos\/general-todo\.md：需求甲/);
  assert.ok(readTodo(root).includes("- [ ] 需求甲"));
  assert.ok(readTodo(root).includes("\r\n"), "CRLF 行尾必须保持");

  const dup = await runTool(tools, { action: "add", file: "general", text: "需求甲" }, ctx);
  assert.equal(dup.isError, true);
  assert.match(dup.content[0].text, /重复（exact）/);
  assert.equal(readTodo(root).match(/- \[ \] 需求甲/g).length, 1, "重复登记不得写入第二条");

  const claimed = await runTool(tools, { action: "claim", file: "general", match: "需求甲", branch: "feat/demo" }, ctx);
  assert.notEqual(claimed.isError, true);
  assert.ok(readTodo(root).includes("- [ ] 需求甲（processing @ feat/demo）"));

  const done = await runTool(tools, { action: "complete", file: "general", match: "需求甲", note: "feat/demo：闭环" }, ctx);
  assert.notEqual(done.isError, true);
  const finalText = readTodo(root);
  assert.ok(finalText.includes("- [x] 需求甲"));
  assert.ok(!finalText.includes("processing @ feat/demo"));
});

test("工具 todos：list/summary/lint 只读输出，缺参返回可读错误", async () => {
  const root = makeRepo();
  const { api, tools } = makeFakePi();
  todoCli(api, { execGit: fakeExecGit });
  const ctx = makeCtx(root, []);
  await runTool(tools, { action: "add", file: "general", text: "需求乙" }, ctx);

  const list = await runTool(tools, { action: "list", status: "open" }, ctx);
  assert.notEqual(list.isError, true);
  assert.match(list.content[0].text, /\[ \] general-todo:\d+  需求乙/);

  const summary = await runTool(tools, { action: "summary" }, ctx);
  assert.match(summary.content[0].text, /general-todo\s+open 1/);

  const lint = await runTool(tools, { action: "lint" }, ctx);
  assert.equal(lint.isError, true, "根目录没有 package.json pi.extensions，lint 应报问题");
  assert.match(lint.content[0].text, /lint|✗/);

  const bad = await runTool(tools, { action: "claim", file: "general" }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /match/);
});

test("工具 todos：triage 透出注入的 git 事实且不改写 todos/", async () => {
  const root = makeRepo();
  const { api, tools } = makeFakePi();
  todoCli(api, { execGit: fakeExecGit });
  const ctx = makeCtx(root, []);
  const before = readTodo(root);

  const triage = await runTool(tools, { action: "triage" }, ctx);
  assert.notEqual(triage.isError, true);
  assert.match(triage.content[0].text, /# triage/);
  assert.match(triage.content[0].text, /feat\/demo/);
  assert.equal(readTodo(root), before, "triage 只读：不得改写 todos/ 文件");
});

test("命令面：裸 /todo=盘点摘要、旧空格写法只提示改名、/todo:add 与 /todo:complete 走真实写入", async () => {
  const root = makeRepo();
  const { api, commands } = makeFakePi();
  todoCli(api, { execGit: fakeExecGit });
  const notices: string[] = [];
  const ctx = makeCtx(root, notices);

  await commands.get("todo")!.handler("list", ctx);
  assert.match(notices.at(-1)!, /已改名为「\/todo:list」/);

  await commands.get("todo")!.handler("", ctx);
  assert.match(notices.at(-1)!, /general-todo/);

  await commands.get("todo:add")!.handler("general 需求丙", ctx);
  assert.ok(readTodo(root).includes("需求丙"));

  await commands.get("todo:complete")!.handler("general 需求丙 --note 命令闭环", ctx);
  assert.ok(readTodo(root).includes("- [x] 需求丙"));
  assert.ok(readTodo(root).includes("命令闭环"));
});
