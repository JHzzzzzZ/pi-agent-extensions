/**
 * 真实宿主边界验证（node --test 不纳入；手动跑：`node test/reload-host-replay.mjs`）：
 * 用 pi 包（devDependency，即宿主同款代码）的真实 loader + ExtensionRunner 复演
 * /reload 序列——非 fake、非 mock：真实 dynamic import、真实事件分发、真实
 * globalThis 守卫跨装载共享。回归背景：/reload 后 team 工具消失（b8f6eaf）。
 *
 *   1. loadExtensions 装载 agent-team（默认本文件所属扩展，可传参指定部署副本）
 *   2. 检查工具/命令注册齐全，且注册了 session_shutdown 处理器（复位时机）
 *   3. runner.emit({ type: "session_shutdown", reason: "reload" })——与宿主
 *      agent-session.js reload() 第 2220 行同款调用
 *   4. 同一进程重新 loadExtensions + 新 ExtensionRunner —— 守卫必须已复位，
 *      工具/命令全部重新注册（修复前此处为 0 工具，即 /reload 消失 bug）
 *   5. 反向对照：不发 shutdown 再载一份 —— 守卫仍抑制（真双加载 no-op）
 *
 * 验证部署副本：node test/reload-host-replay.mjs <副本>/agent-team/index.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.argv[2] ?? path.resolve(here, "..", "index.ts");
const cwd = process.cwd();

// pi 包 exports 不暴露 dist 子路径：从主入口（"." → dist/index.js）反推包根，
// 再用文件 URL 直连内部模块（与宿主 loader 自引同款）。
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piRoot = path.dirname(path.dirname(piEntry));
const u = (p) => pathToFileURL(p).href;
const { createExtensionRuntime, loadExtensions } = await import(u(`${piRoot}/dist/core/extensions/loader.js`));
const { ExtensionRunner } = await import(u(`${piRoot}/dist/core/extensions/runner.js`));
const { createEventBus } = await import(u(`${piRoot}/dist/core/event-bus.js`));

const EXPECTED_TOOLS = ["team_create", "team_list", "team_models", "team_run", "team_resume", "team_status", "team_transcript", "team_stop"];
const EXPECTED_COMMANDS = ["team", "team:list", "team:run", "team:status", "team:stop", "team:view", "team:clear", "team:doctor"];

/** pi 1.0 工具面契约（agent-team-todo#73）：注册面必须可读出分级/标注/分组。 */
const MODEL_ONLY_TOOLS = ["team_create", "team_resume", "team_run", "team_stop"];
const READ_ONLY_TOOLS = ["team_list", "team_models", "team_status", "team_transcript"];
const OPEN_WORLD_TOOLS = ["team_resume", "team_run"];
const NAMESPACE = { name: "agent-team", description: "多 agent 团队派单与查询" };

const toolNames = (exts) => exts.flatMap((e) => [...e.tools.values()].map((t) => t.definition.name));
const commandNames = (exts) => exts.flatMap((e) => [...e.commands.keys()]);
const definitions = (exts) => exts.flatMap((e) => [...e.tools.values()].map((t) => t.definition));
const definitionOf = (exts, name) => definitions(exts).find((d) => d.name === name);

/** 宿主真实注册面（ExtensionRunner 与 ctx.getAllTools 同源）逐条读契约。 */
function assertToolContract(exts, stage) {
  for (const name of EXPECTED_TOOLS) {
    const def = definitionOf(exts, name);
    assert.ok(def, `${stage}：缺少工具 ${name}`);
    const expectedExposure = MODEL_ONLY_TOOLS.includes(name) ? "model-only" : "direct";
    assert.equal(def.exposure ?? "direct", expectedExposure, `${stage}：${name} exposure`);
    assert.deepEqual(def.namespace, NAMESPACE, `${stage}：${name} namespace`);
    const expectedAnnotations = READ_ONLY_TOOLS.includes(name)
      ? { readOnlyHint: true }
      : OPEN_WORLD_TOOLS.includes(name)
        ? { destructiveHint: true, openWorldHint: true }
        : { destructiveHint: true };
    assert.deepEqual(def.annotations, expectedAnnotations, `${stage}：${name} annotations`);
    if (READ_ONLY_TOOLS.includes(name)) assert.ok(def.outputSchema, `${stage}：${name} 应有 outputSchema`);
    else assert.equal(def.outputSchema, undefined, `${stage}：${name} 不应声明 outputSchema`);
  }
}

// -- 1. 首次装载 -------------------------------------------------------------
const runtime1 = createExtensionRuntime();
const loaded1 = await loadExtensions([EXT], cwd, createEventBus(), runtime1);
const exts1 = loaded1.extensions ?? loaded1;
const runner1 = new ExtensionRunner(exts1, runtime1, cwd, {}, {});
assert.ok(runner1.hasHandlers("session_shutdown"), "扩展注册了 session_shutdown 处理器（复位时机）");
for (const name of EXPECTED_TOOLS) assert.ok(toolNames(exts1).includes(name), `首次装载缺少工具 ${name}`);
assertToolContract(exts1, "step1");
console.log(`step1 首次装载：工具 ${toolNames(exts1).length} 个、命令 ${commandNames(exts1).length} 个 ✓（契约：exposure/annotations/namespace/outputSchema 逐条可读）`);

// -- 2. 宿主 reload 语义：先 emit session_shutdown ---------------------------
await runner1.emit({ type: "session_shutdown", reason: "reload" });
console.log("step2 emit session_shutdown(reason=reload) ✓");

// -- 3. 重绑：同一进程、同一 globalThis，重新装载 ------------------------------
const runtime2 = createExtensionRuntime();
const loaded2 = await loadExtensions([EXT], cwd, createEventBus(), runtime2);
const exts2 = loaded2.extensions ?? loaded2;
const runner2 = new ExtensionRunner(exts2, runtime2, cwd, {}, {});
for (const name of EXPECTED_TOOLS) assert.ok(toolNames(exts2).includes(name), `reload 后缺少工具 ${name}`);
for (const name of EXPECTED_COMMANDS) assert.ok(commandNames(exts2).includes(name), `reload 后缺少命令 ${name}`);
assertToolContract(exts2, "step3");
console.log(`step3 reload 后重绑：工具 ${toolNames(exts2).length} 个、命令 ${commandNames(exts2).length} 个 ✓（全部重新注册）`);

// -- 4. 反向对照：真双加载（无 shutdown 间隔）仍被抑制 --------------------------
const runtime3 = createExtensionRuntime();
const loaded3 = await loadExtensions([EXT], cwd, createEventBus(), runtime3);
const exts3 = loaded3.extensions ?? loaded3;
new ExtensionRunner(exts3, runtime3, cwd, {}, {});
assert.equal(toolNames(exts3).length, 0, "无 shutdown 的第二份装载应被守卫抑制（0 工具）");
console.log("step4 真双加载（无 shutdown）仍被守卫抑制 ✓");

console.log("\n真实宿主 reload 复演全部通过 ✓");
