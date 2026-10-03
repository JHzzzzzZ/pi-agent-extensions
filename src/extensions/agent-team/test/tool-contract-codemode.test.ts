/**
 * agent-team — 查询型工具在 codemode 脚本里的真实解析路径（agent-team-todo #73）
 *
 * 边界：本文件驱动**宿主真实的 codemode executor**（`dist/extensions/codemode/
 * execute.js` 的 `executeCodemode`，含真实 QuickJS 沙箱），只把会话侧替换成 fake
 * ——脚本侧的 `ctx.tools` 用真实注册出来的工具定义，`ctx.executeTool` 调真实工具
 * 的 execute。锁的是「声明 outputSchema 的工具在脚本里解析成 structuredContent
 * 而不是文本」这条宿主契约（pi 1.0 文档：A tool that declares `outputSchema`
 * resolves to its `structuredContent`）。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { isolateRunsDir } from "./helpers.ts";
import { fixtureTeam } from "./fixtures.ts";
import type { ToolResult } from "./tool-types.ts";

/** 宿主真实 codemode executor（测试直连宿主 dist，同 widget.test.ts 直读宿主源码惯例）。 */
const codemodeEntry = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "extensions",
  "codemode",
  "execute.js",
);
const { executeCodemode } = (await import(pathToFileURL(codemodeEntry).href)) as {
  executeCodemode: (
    toolCallId: string,
    input: { code: string },
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
    options?: { getToolNamespace?: (name: string) => { name: string; description?: string } | undefined },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }>;
};

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  outputSchema?: unknown;
  namespace?: { name: string; description?: string };
  execute: (toolCallId: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<ToolResult & { structuredContent?: unknown }>;
}

/** 注册真实 entry（cockpit 模式），返回工具定义表。 */
async function registerCockpit(): Promise<{ tools: Map<string, RegisteredTool>; cleanup: () => void }> {
  isolateRunsDir();
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-codemode-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".pi", "teams", "proj-team.md"),
    serializeTeam(fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined })),
  );
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    on() {},
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry() {
      return {};
    },
    sendMessage() {
      return {};
    },
  };
  agentTeamExtension(pi as never, {});
  const ctx = {
    cwd: projectDir,
    hasUI: false,
    isProjectTrusted: () => true,
    ui: {},
    sessionManager: { getEntries: () => [] },
  };
  // session_start 需要 handler 表；这里直接跳过（本文件只用查询型工具，不依赖 run 状态）。
  return { tools, cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }) };
}

/** 脚本侧会话：ctx.tools 用真实注册定义，executeTool 调真实工具 execute。 */
function scriptSession(tools: Map<string, RegisteredTool>) {
  const toolCtx = {
    cwd: os.tmpdir(),
    hasUI: false,
    isProjectTrusted: () => true,
    ui: {},
    sessionManager: { getEntries: () => [] },
  };
  return {
    tools: [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    })),
    async executeTool(name: string, args: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) return { toolCall: { id: "call-0", name, input: args }, result: { content: [] }, isError: true };
      const result = await tool.execute("call-1", args, undefined, undefined, toolCtx);
      return { toolCall: { id: "call-1", name, input: args }, result, isError: result.isError === true };
    },
    sessionManager: { getBranch: () => [] },
  };
}

test("codemode 脚本里 tools.team_status({}) 拿到 structuredContent（不是文本）", async () => {
  const { tools, cleanup } = await registerCockpit();
  try {
    const out = await executeCodemode(
      "codemode-call-1",
      { code: "const status = await tools.team_status({});\nreturn status;\n" },
      undefined,
      undefined,
      scriptSession(tools),
      { getToolNamespace: (name) => tools.get(name)?.namespace },
    );
    assert.equal(out.isError, undefined, out.content.map((c) => c.text).join("\n"));
    const value = out.content.at(-1)?.text ?? "";
    assert.deepEqual(JSON.parse(value), { active: [], recent: [] }, "脚本拿到结构化对象");
    const calls = (out.details as { calls: Array<{ name: string; status: string }> }).calls;
    assert.deepEqual(calls.map((c) => [c.name, c.status]), [["team_status", "ok"]]);
  } finally {
    cleanup();
  }
});

test("codemode 声明面：查询型工具的返回类型来自 outputSchema（不是 unknown）", async () => {
  const { tools, cleanup } = await registerCockpit();
  try {
    const out = await executeCodemode(
      "codemode-call-2",
      { code: 'text(ALL_TOOLS.map((tool) => tool.description).join("\\n"));\nreturn tools.team_status({});\n' },
      undefined,
      undefined,
      scriptSession(tools),
      { getToolNamespace: (name) => tools.get(name)?.namespace },
    );
    const declarations = out.content.map((c) => c.text).join("\n");
    const statusDeclaration = declarations.slice(declarations.indexOf("team_status(args: {"));
    assert.match(statusDeclaration, /team_status\(args: \{[\s\S]*?\}\): Promise<\{/, "team_status 输出类型可读（非 unknown）");
    assert.match(statusDeclaration, /active: Array<\{/, "汇总分支字段进入声明");
    assert.match(statusDeclaration, /recent: Array<\{/, "汇总分支字段进入声明");
    assert.match(declarations, /team_models\(args: \{[\s\S]*?\}\): Promise<\{/, "team_models 输出类型可读");
    assert.match(declarations, /team_list\(args: \{[\s\S]*?\}\): Promise<\{/, "team_list 输出类型可读");
  } finally {
    cleanup();
  }
});
