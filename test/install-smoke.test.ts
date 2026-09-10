/**
 * 安装冒烟工具的纯逻辑单测（工具本体见 tools/install-smoke.mjs）。
 *
 * 边界说明：这里只测得到"观察值 → 问题清单"的判定与解析；真实加载信号
 * 只能在真 pi 进程边界另一侧产生，由 `node tools/install-smoke.mjs` 端到端
 * 覆盖（本文件不 spawn pi，故可在无 pi 环境运行）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  REPO_ROOT,
  checkSmoke,
  extensionDirsFromManifest,
  findManifestDrift,
  loadManifest,
  parseRpcOutput,
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
