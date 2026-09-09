/**
 * 顶层真机复演：用 pi 宿主的 DefaultResourceLoader.reload()——/reload 命令的
 * 真实实现（clearExtensionCache → settings reload → 包解析 → 缓存装载）——
 * 在用户真实环境（~/.pi/agent，含 git 包 pi-agent-extensions@dev-laptop）里
 * 验证：reload 前工具在 → session_shutdown → reload 后工具重新在。
 *
 * 手动跑：node agent-team/test/reload-real-env.mjs
 * 回归：/reload 后 team 工具消失（b8f6eaf 修复）。
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = os.homedir();
const PI_DIST = path.join(home, "AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist");
const u = (p) => pathToFileURL(p).href;
const { DefaultResourceLoader } = await import(u(`${PI_DIST}/core/resource-loader.js`));
const { ExtensionRunner } = await import(u(`${PI_DIST}/core/extensions/runner.js`));

const cwd = path.join(home, ".pi/agent/dev_extensions");
const agentDir = path.join(home, ".pi/agent");
const EXPECTED = ["team_run", "team_status", "team_stop", "team_list", "team_create"];

const toolNames = (loader) =>
  loader.extensionsResult.extensions.flatMap((e) => [...e.tools.values()].map((t) => t.definition.name));

// -- 第 1 次 reload：初次装载（等价宿主启动） --------------------------------
const loader = new DefaultResourceLoader({ cwd, agentDir });
await loader.reload();
const names1 = toolNames(loader);
for (const name of EXPECTED) assert.ok(names1.includes(name), `首次装载缺少工具 ${name}`);
console.log(`step1 首次 reload（真实包解析 + 缓存装载）：agent-team 工具 ${names1.filter((n) => n.startsWith("team")).length} 个 ✓`);

// -- 宿主 reload 序列：先向旧 runner 发 session_shutdown ----------------------
const runner = new ExtensionRunner(loader.extensionsResult.extensions, loader.extensionsResult.runtime, cwd, {}, {});
assert.ok(runner.hasHandlers("session_shutdown"));
await runner.emit({ type: "session_shutdown", reason: "reload" });
console.log("step2a 旧 runner emit session_shutdown(reason=reload) ✓");

// -- 第 2 次 reload：同一进程内重绑（/reload 命令本体） ------------------------
await loader.reload();
const names2 = toolNames(loader);
for (const name of EXPECTED) assert.ok(names2.includes(name), `reload 后缺少工具 ${name}`);
console.log(`step2b 第二次 reload（同一进程，globalThis 守卫应已复位）：team 工具齐全 ✓`);

console.log("\n真实宿主 DefaultResourceLoader.reload() 复演通过 ✓");
