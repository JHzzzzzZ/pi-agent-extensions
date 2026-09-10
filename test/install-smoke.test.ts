/**
 * 安装冒烟工具的纯逻辑单测（工具本体见 tools/install-smoke.mjs）。
 *
 * 边界说明：这里只测得到"观察值 → 问题清单"的判定与解析；真实加载信号
 * 只能在真 pi 进程边界另一侧产生，由 `node tools/install-smoke.mjs` 端到端
 * 覆盖（本文件不 spawn pi，故可在无 pi 环境运行）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  REPO_ROOT,
  buildDeepArgs,
  checkDeepRun,
  checkInstallRun,
  checkSmoke,
  deepModelFromSettings,
  extensionDirsFromManifest,
  findManifestDrift,
  findPiPackage,
  installSourceKind,
  loadManifest,
  parseJsonEvents,
  parseRpcOutput,
  piPackageSearchRoots,
} from "../tools/install-smoke.mjs";

const BASE = path.resolve("/tmp/pi-install-smoke-fixture");
const command = (name, sourcePath) => ({ name, sourceInfo: { path: sourcePath } });

test("extensionDirsFromManifest：条目路径解析为扩展目录名", () => {
  assert.deepEqual(extensionDirsFromManifest(["./pwr/index.ts", "./agent-team/index.ts"]), ["pwr", "agent-team"]);
});

test("findManifestDrift：两侧缺一即报，双向可查", () => {
  const expectations = { alpha: { commands: [], uiKeys: [] }, beta: { commands: [], uiKeys: [] } };
  assert.deepEqual(findManifestDrift(["alpha", "beta"], expectations), []);
  const problems = findManifestDrift(["alpha", "gamma"], expectations);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /gamma/);
  assert.match(problems[1], /beta/);
});

test("findManifestDrift：本仓库清单与期望表一一对应（防新增扩展漏登记）", () => {
  const dirs = extensionDirsFromManifest(loadManifest(REPO_ROOT));
  assert.deepEqual(findManifestDrift(dirs), []);
});

test("parseRpcOutput：跳过 UI 事件、收集 widget/status 键、只认指定 id", () => {
  const text = [
    JSON.stringify({ type: "extension_ui_request", method: "setWidget", widgetKey: "agent-team" }),
    JSON.stringify({ type: "extension_ui_request", method: "setStatus", statusKey: "30:pwr" }),
    JSON.stringify({ id: "other", type: "response", command: "get_commands", data: { commands: [command("x", "/x")] } }),
    JSON.stringify({ id: "smoke", type: "response", command: "get_commands", success: true, data: { commands: [command("team", `${BASE}/extensions/agent-team/index.ts`)] } }),
    "",
  ].join("\n");
  const parsed = parseRpcOutput(text, "smoke");
  assert.deepEqual([...parsed.uiKeys].sort(), ["30:pwr", "agent-team"]);
  assert.deepEqual(parsed.commands.map((c) => c.name), ["team"]);
});

test("checkSmoke：全部观察值正常时零问题", () => {
  const problems = checkSmoke({
    exitCode: 0,
    stderr: "",
    commands: [command("team", `${BASE}/extensions/agent-team/index.ts`), command("quota", `${BASE}/extensions/provider-quota/index.ts`)],
    uiKeys: new Set(["agent-team"]),
    baseDir: BASE,
    dirs: ["agent-team", "provider-quota"],
    expectations: {
      "agent-team": { commands: ["team"], uiKeys: ["agent-team"] },
      "provider-quota": { commands: ["quota"], uiKeys: [] },
    },
  });
  assert.deepEqual(problems, []);
});

test("checkSmoke：进程失败/ stderr 非空直接判定失败", () => {
  const failed = checkSmoke({ exitCode: 1, stderr: "boom", commands: [], uiKeys: new Set(), baseDir: BASE });
  assert.equal(failed.length, 2);
  assert.match(failed[0], /退出码 1/);
  assert.match(failed[1], /stderr 非空/);
  const spawnFailed = checkSmoke({ spawnError: "ENOENT", commands: [], uiKeys: new Set(), baseDir: BASE });
  assert.equal(spawnFailed.length, 1);
  assert.match(spawnFailed[0], /无法启动 pi/);
});

test("checkSmoke：缺命令、缺 UI 键、来源目录不符逐项报错", () => {
  const problems = checkSmoke({
    exitCode: 0,
    stderr: "",
    commands: [command("team", "C:/Users/someone/.pi/agent/extensions/agent-team/index.ts")],
    uiKeys: new Set(),
    baseDir: BASE,
    dirs: ["agent-team"],
    expectations: { "agent-team": { commands: ["team", "team:view"], uiKeys: ["agent-team"] } },
  });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /缺少命令 \/team:view/);
  assert.match(problems[1], /未写入启动期 TUI 键 agent-team/);
  assert.match(problems[2], /不在本次安装目录/);
});

test("checkSmoke：宿主内联扩展（<inline:…>）不参与来源目录核对", () => {
  const problems = checkSmoke({
    exitCode: 0,
    stderr: "",
    commands: [command("llama", "<inline:llama.cpp>")],
    uiKeys: new Set(),
    baseDir: BASE,
    dirs: [],
    expectations: {},
  });
  assert.deepEqual(problems, []);
});

test("checkSmoke：baseDir 可传多个根（本地路径安装时命令来自源目录）", () => {
  const sourceDir = path.resolve("/tmp/pi-package-smoke-source");
  const problems = checkSmoke({
    exitCode: 0,
    stderr: "",
    commands: [command("team", `${sourceDir}/agent-team/index.ts`)],
    uiKeys: new Set(["agent-team"]),
    baseDir: [BASE, sourceDir],
    dirs: ["agent-team"],
    expectations: { "agent-team": { commands: ["team"], uiKeys: ["agent-team"] } },
  });
  assert.deepEqual(problems, []);
  // 两个根都不匹配时仍要报错。
  const outside = checkSmoke({
    exitCode: 0,
    stderr: "",
    commands: [command("team", "/elsewhere/agent-team/index.ts")],
    uiKeys: new Set(),
    baseDir: [BASE, sourceDir],
    dirs: ["agent-team"],
    expectations: { "agent-team": { commands: ["team"], uiKeys: [] } },
  });
  assert.equal(outside.length, 1);
  assert.match(outside[0], /不在本次安装目录/);
});

// —— pi install 包路径冒烟（--install）：安装产物定位与安装结果校验 ——

test("deepModelFromSettings：显式 --model 优先，否则由 defaultProvider/defaultModel 拼 provider/id", () => {
  assert.equal(deepModelFromSettings({ defaultProvider: "opencode-go", defaultModel: "deepseek-flash" }, undefined), "opencode-go/deepseek-flash");
  assert.equal(deepModelFromSettings({ defaultProvider: "opencode-go", defaultModel: "deepseek-flash" }, "deepseek/deepseek-chat"), "deepseek/deepseek-chat");
  assert.equal(deepModelFromSettings({}, undefined), undefined);
  assert.equal(deepModelFromSettings({ defaultProvider: "opencode-go" }, undefined), undefined);
});

test("buildDeepArgs：--tools 只放行被测工具，显式模型透传，无模型时不加 --model", () => {
  const args = buildDeepArgs({ model: "opencode-go/deepseek-flash", tool: "loop_list" });
  assert.deepEqual(args.slice(0, 7), ["--mode", "json", "-p", "--no-session", "--tools", "loop_list", "--model"]);
  assert.equal(args[7], "opencode-go/deepseek-flash");
  assert.match(args.at(-1), /loop_list/);
  const bare = buildDeepArgs({ tool: "loop_list" });
  assert.ok(!bare.includes("--model"));
});

test("parseJsonEvents：跳过非 JSON 行（OSC 通知转义 / 文本日志），保留事件", () => {
  const text = [
    "]777;notify;Pi;Ready for input",
    JSON.stringify({ type: "agent_start" }),
    "not json",
    JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "loop_list", args: {} }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "loop_list", isError: false }),
  ].join("\n");
  const events = parseJsonEvents(text);
  assert.deepEqual(events.map((e) => e.type), ["agent_start", "tool_execution_start", "tool_execution_end"]);
});

test("checkDeepRun：工具成功执行一次即零问题", () => {
  const problems = checkDeepRun({
    exitCode: 0,
    events: [
      { type: "agent_start" },
      { type: "tool_execution_start", toolName: "loop_list" },
      { type: "tool_execution_end", toolName: "loop_list", isError: false },
      { type: "agent_end" },
    ],
    tool: "loop_list",
  });
  assert.deepEqual(problems, []);
});

test("checkDeepRun：进程退出码非 0 直接失败并附 stderr", () => {
  const problems = checkDeepRun({ exitCode: 1, stderr: "auth failed", events: [], tool: "loop_list" });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /退出码 1/);
  assert.match(problems[1], /auth failed/);
  const spawnFailed = checkDeepRun({ spawnError: "ENOENT", events: [], tool: "loop_list" });
  assert.equal(spawnFailed.length, 1);
  assert.match(spawnFailed[0], /无法启动 pi/);
});

test("checkDeepRun：模型没调工具 / 工具报错 / 半途而废分别给出指向性结论", () => {
  const notCalled = checkDeepRun({ exitCode: 0, events: [{ type: "agent_end" }], tool: "loop_list" });
  assert.equal(notCalled.length, 1);
  assert.match(notCalled[0], /未调用工具 loop_list/);

  const toolError = checkDeepRun({
    exitCode: 0,
    events: [{ type: "tool_execution_start", toolName: "loop_list" }, { type: "tool_execution_end", toolName: "loop_list", isError: true }],
    tool: "loop_list",
  });
  assert.equal(toolError.length, 1);
  assert.match(toolError[0], /执行报错/);

  const halfDone = checkDeepRun({ exitCode: 0, events: [{ type: "tool_execution_start", toolName: "loop_list" }], tool: "loop_list" });
  assert.equal(halfDone.length, 1);
  assert.match(halfDone[0], /未执行完成/);
});

// —— pi install 包路径冒烟（--install）：安装源识别 / 安装产物定位 / 安装结果校验 ——

test("installSourceKind：npm: / git:（含 URL） / 其余按本地路径", () => {
  assert.equal(installSourceKind("npm:pi-foo"), "npm");
  assert.equal(installSourceKind("git:github.com/JHzzzzzZ/pi-agent-extensions@dev-laptop"), "git");
  assert.equal(installSourceKind("https://github.com/a/b.git"), "git");
  assert.equal(installSourceKind("github.com/a/b"), "git");
  assert.equal(installSourceKind("./pi-agent-extensions"), "local");
  assert.equal(installSourceKind("C:/Users/x/dev_extensions"), "local");
  assert.equal(installSourceKind(""), undefined);
  assert.equal(installSourceKind(undefined), undefined);
});

test("piPackageSearchRoots：git 装到 <configDir>/git，npm 装到 <configDir>/npm/node_modules，本地路径指回源目录", () => {
  const configDir = path.resolve("/tmp/pi-package-smoke");
  assert.deepEqual(piPackageSearchRoots("git:github.com/a/b", configDir), [path.join(configDir, "git"), path.join(configDir, "npm", "node_modules")]);
  assert.deepEqual(piPackageSearchRoots("npm:pi-foo", configDir), [path.join(configDir, "git"), path.join(configDir, "npm", "node_modules")]);
  assert.deepEqual(piPackageSearchRoots("./repo", configDir), [path.resolve("./repo"), path.join(configDir, "git"), path.join(configDir, "npm", "node_modules")]);
});

test("findPiPackage：在安装根下递归找到带 pi.extensions 的 package.json（跳过 node_modules），找不到返回 undefined", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pkg-fixture-"));
  try {
    const clone = path.join(root, "git", "github.com", "a", "b");
    fs.mkdirSync(path.join(clone, "node_modules", "junk"), { recursive: true });
    fs.writeFileSync(path.join(clone, "package.json"), JSON.stringify({ name: "pi-agent-extensions", version: "2.25.0", pi: { extensions: ["./pwr/index.ts"] } }));
    fs.writeFileSync(path.join(clone, "node_modules", "junk", "package.json"), JSON.stringify({ name: "junk", pi: { extensions: ["./junk.ts"] } }));
    const found = findPiPackage([path.join(root, "git")]);
    assert.ok(found);
    assert.equal(found.dir, clone);
    assert.equal(found.name, "pi-agent-extensions");
    assert.equal(found.version, "2.25.0");
    assert.deepEqual(found.extensions, ["./pwr/index.ts"]);
    assert.equal(findPiPackage([path.join(root, "nowhere")]), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkInstallRun：退出码 0 + 输出含 Installed <源> 才算装成功（git 克隆进度走 stderr 属正常）", () => {
  const source = "git:github.com/a/b@dev";
  const ok = checkInstallRun({
    exitCode: 0,
    stderr: `Cloning into '${BASE}/git/github.com/a/b'...\nSwitched to a new branch 'dev'`,
    stdout: `Installing ${source}...\nInstalled ${source}\n`,
    source,
  });
  assert.deepEqual(ok, []);
  const failed = checkInstallRun({ exitCode: 1, stderr: "fatal: repository not found", stdout: "", source });
  assert.equal(failed.length, 2);
  assert.match(failed[0], /退出码 1/);
  assert.match(failed[1], /stderr/);
  // 退出码 0 但没看到确认行：安装被静默跳过也算失败。
  const silent = checkInstallRun({ exitCode: 0, stderr: "", stdout: "something else", source });
  assert.equal(silent.length, 1);
  assert.match(silent[0], /未见 "Installed/);
  const spawnFailed = checkInstallRun({ spawnError: "ENOENT", source });
  assert.equal(spawnFailed.length, 1);
  assert.match(spawnFailed[0], /无法启动 pi/);
});
