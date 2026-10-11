/**
 * L1 单装组合测试（general-todo#32 / docs/specs/composition-test-matrix.md）
 *
 * 验的是「A 能独立运行」：每个插件**单独**加载进一个空宿主（其它插件都不在），断言
 *   ① 加载与生命周期流转不抛未捕获异常（session_start → session_shutdown → session_start）；
 *   ② 自己声明的注册面**真的注册了**（清单与实现一致）；
 *   ③ **没有**声明之外的注册面（防止清单漏记、别人不知道的槽位被悄悄占用）；
 *   ④ 二次 session_start 不炸（可重入，对齐 pwr `revive()` 教训）。
 *
 * 边界（为什么这样测）：宿主替身只记录注册面，不模拟宿主内部行为——宿主真实行为由 L3
 * （真 pi RPC，opt-in）与既有宿主路径测试覆盖。加载的是真实 `index.ts`（真源码、真依赖、
 * 真副作用），唯一替换的是宿主 API 对象。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { REPO_ROOT, listExtensions, parseSurfaces } from "../tools/composition-surfaces.mjs";
import { fireHook, loadExtension, makeHost } from "./helpers/composition-host.mjs";

const markdown = fs.readFileSync(path.join(REPO_ROOT, "docs/cross/composition-surfaces.md"), "utf8");
const surfaces = parseSurfaces(markdown);
const extensions = listExtensions(REPO_ROOT);

// 环境隔离：leader 子进程里跑本套件时 PI_AGENT_TEAM_FILE 会已设置，
// 不清掉会让 agent-team 进入 leader 模式而把 cockpit 用例误红（反之亦然）。
delete process.env.PI_AGENT_TEAM_FILE;

const declared = (name) => surfaces.get(name)?.fields ?? new Map();
const declaredValues = (name, field) => declared(name).get(field) ?? [];
/** 多模式扩展（如 agent-team 的 cockpit / leader）：声明与观测按模式分叉，L1 放宽「声明必注册」。 */
const modes = (name) => declaredValues(name, "mode");

/** 声明的工具面（`replace:bash` / `wrap:read`）→ 被顶掉的宿主工具名。 */
const declaredToolNames = (name) =>
  declaredValues(name, "toolSurface").map((value) => value.replace(/^(replace|wrap)\s*[:：]\s*/, "").trim());

test("L1：清单覆盖 src/extensions 下的每个扩展（新增插件必须补一节）", () => {
  const missing = extensions.filter((name) => !surfaces.has(name));
  assert.deepEqual(missing, [], `未在 docs/cross/composition-surfaces.md 声明的扩展：${missing.join(", ")}`);
});

for (const name of extensions) {
  test(`L1 单装：${name} 加载 + 生命周期可重入 + 注册面与清单一致`, async () => {
    const factory = await loadExtension(name);
    const host = makeHost({ label: name });

    await factory(host.pi);
    await fireHook(host, "session_start");
    await fireHook(host, "session_shutdown");
    await fireHook(host, "session_start"); // 可重入：pwr 曾因缺 revive 在第二次会话永久抛错

    const registered = {
      tools: [...declaredValues(name, "tool"), ...declaredToolNames(name)],
      commands: declaredValues(name, "commands"),
      shortcuts: declaredValues(name, "shortcuts"),
      providers: declaredValues(name, "model"),
    };
    const observedTools = new Set(host.record.tools.map((t) => t.name));
    const multiMode = modes(name).length > 1;
    for (const tool of registered.tools) {
      if (multiMode) continue; // 该模式下的面：由专门的模式用例（如 agent-team leader 模式）覆盖
      assert.ok(observedTools.has(tool), `${name}: 清单声明了工具/工具面 \`${tool}\`，但加载期与 session_start 都没注册它`);
    }
    if (multiMode) {
      assert.ok(
        registered.tools.some((tool) => observedTools.has(tool)),
        `${name}: 声明了模式 ${modes(name).join("/")}，但两次生命周期內一个声明的工具都没注册`,
      );
    }
    const observedCommands = new Set(host.record.commands.map((c) => c.name));
    for (const command of registered.commands) {
      assert.ok(observedCommands.has(command), `${name}: 清单声明了命令 \`${command}\`，但没注册`);
    }
    // 快捷键：声明的必须注册，注册的必须已声明
    const observedShortcuts = host.record.shortcuts.map((s) => s.key);
    for (const shortcut of registered.shortcuts) {
      assert.ok(observedShortcuts.includes(shortcut), `${name}: 清单声明了快捷键 \`${shortcut}\`，但没注册`);
    }
    const undeclaredShortcuts = observedShortcuts.filter((key) => !registered.shortcuts.includes(key));
    assert.deepEqual(undeclaredShortcuts, [], `${name}: 注册了未在清单声明的快捷键：${undeclaredShortcuts.join(", ")}`);
    // 状态键 / widget 键 / 钩子：运行时写下去的也必须已声明
    const undeclaredRuntime = [
      ...host.record.statusWrites.map((w) => `状态键:${w.key}`),
      ...host.record.widgetWrites.map((w) => `widget:${w.key}`),
      ...host.record.hooks.map((h) => `钩子:${h.event}`),
    ].filter((entry) => {
      const [kind, value] = [entry.slice(0, entry.indexOf(":")), entry.slice(entry.indexOf(":") + 1)];
      const declaredList =
        kind === "状态键" ? declaredValues(name, "status") : kind === "widget" ? declaredValues(name, "widget") : declaredValues(name, "hooks");
      return !declaredList.includes(value);
    });
    assert.deepEqual(undeclaredRuntime, [], `${name}: 运行时写了未在清单声明的面：${undeclaredRuntime.join(", ")}`);
    assert.ok(
      host.record.providers.length + host.record.virtualModels.length >= registered.providers.length,
      `${name}: 清单声明了 ${registered.providers.length} 个模型面，实际注册 ${host.record.providers.length + host.record.virtualModels.length} 个`,
    );

    // 反向：注册了却没声明 ⇒ 清单漏记（别人不知道这个槽被占了）
    const undeclared = [
      ...host.record.tools.map((t) => `工具:${t.name}`),
      ...host.record.commands.map((c) => `命令:${c.name}`),
      ...host.record.providers.map((p) => `provider:${p.id}`),
      ...host.record.virtualModels.map((v) => `虚拟模型:${v.id}`),
    ].filter((entry) => {
      const value = entry.split(":").slice(1).join(":");
      return ![registered.tools, registered.commands, registered.providers].some((list) =>
        list.some((declaredValue) => declaredValue === value),
      );
    });
    assert.deepEqual(undeclared, [], `${name}: 注册了未在清单声明的面：${undeclared.join(", ")}`);
  });
}

test("L1：清单里的扩展名都在 src/extensions 下真实存在", () => {
  const ghosts = [...surfaces.keys()].filter((name) => !extensions.includes(name));
  assert.deepEqual(ghosts, []);
});

test("L1 模式分叉：agent-team 用 PI_AGENT_TEAM_FILE 进 leader 模式，只注册 dispatch/ask", async () => {
  const factory = await loadExtension("agent-team");
  const host = makeHost({ label: "agent-team:leader" });
  const previous = process.env.PI_AGENT_TEAM_FILE;
  // 真文件路径（相对扩展目录）：走到 parsed-team 分支，而不是靠“缺文件容忍”碰巧绿。
  process.env.PI_AGENT_TEAM_FILE = path.join(REPO_ROOT, "src/extensions/agent-team/examples/dev-team.example.md");
  try {
    await factory(host.pi);
    const tools = host.record.tools.map((t) => t.name).sort();
    assert.ok(tools.includes("team_dispatch"), `leader 模式缺 team_dispatch（实际：${tools.join(", ")}）`);
    assert.ok(tools.includes("team_ask"), `leader 模式缺 team_ask（实际：${tools.join(", ")}）`);
    assert.deepEqual(
      host.record.commands.map((c) => c.name),
      [],
      "leader 模式不应注册 cockpit 的命令面",
    );
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_TEAM_FILE;
    else process.env.PI_AGENT_TEAM_FILE = previous;
  }
});
