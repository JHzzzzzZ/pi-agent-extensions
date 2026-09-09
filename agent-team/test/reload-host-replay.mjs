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

const EXPECTED_TOOLS = ["team_create", "team_list", "team_models", "team_run", "team_status", "team_transcript", "team_stop"];
const EXPECTED_COMMANDS = ["team", "team:run", "team:status", "team:stop", "team:view", "team:clear"];

const toolNames = (exts) => exts.flatMap((e) => [...e.tools.values()].map((t) => t.definition.name));
const commandNames = (exts) => exts.flatMap((e) => [...e.commands.keys()]);

// -- 1. 首次装载 -------------------------------------------------------------
const runtime1 = createExtensionRuntime();
const loaded1 = await loadExtensions([EXT], cwd, createEventBus(), runtime1);
const exts1 = loaded1.extensions ?? loaded1;
const runner1 = new ExtensionRunner(exts1, runtime1, cwd, {}, {});
assert.ok(runner1.hasHandlers("session_shutdown"), "扩展注册了 session_shutdown 处理器（复位时机）");
for (const name of EXPECTED_TOOLS) assert.ok(toolNames(exts1).includes(name), `首次装载缺少工具 ${name}`);
console.log(`step1 首次装载：工具 ${toolNames(exts1).length} 个、命令 ${commandNames(exts1).length} 个 ✓`);

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
console.log(`step3 reload 后重绑：工具 ${toolNames(exts2).length} 个、命令 ${commandNames(exts2).length} 个 ✓（全部重新注册）`);

// -- 4. 反向对照：真双加载（无 shutdown 间隔）仍被抑制 --------------------------
const runtime3 = createExtensionRuntime();
const loaded3 = await loadExtensions([EXT], cwd, createEventBus(), runtime3);
const exts3 = loaded3.extensions ?? loaded3;
new ExtensionRunner(exts3, runtime3, cwd, {}, {});
assert.equal(toolNames(exts3).length, 0, "无 shutdown 的第二份装载应被守卫抑制（0 工具）");
console.log("step4 真双加载（无 shutdown）仍被守卫抑制 ✓");

console.log("\n真实宿主 reload 复演全部通过 ✓");
