#!/usr/bin/env node
/**
 * Opt-in 真机冒烟：同一任务的后台轮次真实并发（v1.8 重叠运行）。
 *
 * 单测（test/runner.test.ts、test/index.test.ts）用假子进程锁契约与并发语义，
 * 但"两个真实 pi 子进程同时在跑"只有真实进程边界能证明：并发 spawn、各自解析
 * JSON stdout、各自独立的 session id、各自会话落盘。本脚本直接调 runner 的
 * runBgAgent（不经过宿主 TUI）并发拉起两轮，核对：
 *
 *   1. 两轮都 done（并发下互不干扰，没有共享状态串味）；
 *   2. 两个会话 id 互不相同，且都能定位到会话文件（pi --session <id> 可恢复）；
 *   3. 真并发证据：spawn 包装器记录到的同时在跑子进程峰值 = 2。
 *
 * 为什么 opt-in：子 pi 要跑一次真实模型对话（需要鉴权与网络），不进 npm test。
 *
 * 用法（仓库根或本目录）：
 *   node src/extensions/loop/test/bg-overlap-smoke.mjs
 *   LOOP_SMOKE_TIMEOUT_MS=60000 node src/extensions/loop/test/bg-overlap-smoke.mjs
 *
 * 退出码：0 = 两轮真机并发通过；1 = 失败（原因打印到 stdout/stderr）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runBgAgent, defaultBgSpawn } from "../runner.ts";

const TIMEOUT_MS = Number(process.env.LOOP_SMOKE_TIMEOUT_MS ?? 240_000);
const PROMPT = "只回复 OK 两个字，不要调用任何工具，不要写任何文件。";

// 递归保险：若被当成子 pi 拉起（参数是本脚本的 CLI 参数前缀），立刻报错退出。
if (process.argv.includes("--mode") || process.argv.includes("-p")) {
  console.error("✗ bg overlap smoke: 检测到被当作子进程递归拉起（piBin 未生效？），拒绝继续");
  process.exit(1);
}

function fail(message) {
  console.error(`✗ bg overlap smoke: ${message}`);
  process.exit(1);
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** pi 入口脚本：与 npm 全局 shim 同一套解析（node <bin> <args>）；不依赖 exports 子路径 */
function resolvePiEntry() {
  if (process.env.LOOP_SMOKE_PI_ENTRY) return process.env.LOOP_SMOKE_PI_ENTRY;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkgPath = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      if (!bin) throw new Error("pi-coding-agent 未声明 bin.pi，用 LOOP_SMOKE_PI_ENTRY 显式指定入口");
      return path.join(path.dirname(pkgPath), bin);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("找不到 @earendil-works/pi-coding-agent（先在扩展目录 npm install）");
    dir = parent;
  }
}

/** spawn 包装器：记录同时在跑的真实子进程峰值（并发证据，而不是纸面 Promise.all） */
function countingSpawn() {
  const inner = defaultBgSpawn();
  const state = { live: 0, peak: 0 };
  const spawn = (command, args, opts) => {
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    const child = inner(command, args, opts);
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      on(event, cb) {
        child.on(event, (arg) => {
          if (state.live > 0) state.live -= 1;
          cb(arg);
        });
      },
      kill: (signal) => child.kill(signal),
    };
  };
  return { spawn, state };
}

const startedAt = Date.now();
const rounds = [
  { taskId: "smoke001", label: stamp(new Date(startedAt)) },
  { taskId: "smoke002", label: stamp(new Date(startedAt)) },
];
const { spawn, state } = countingSpawn();

console.log(`拉起两轮真实后台 pi 子进程（并发）：${rounds.map((r) => `loop-${r.taskId}-${r.label}`).join("、")}`);
const outcomes = await Promise.all(
  rounds.map((r) => runBgAgent({
    taskId: r.taskId,
    prompt: PROMPT,
    cwd: process.cwd(),
    label: r.label,
    spawn,
    timeoutMs: TIMEOUT_MS,
    // 脚本在 node 下跑：argv[1] 是本脚本而不是 pi 入口，必须显式指定（否则递归）
    piEntry: resolvePiEntry(),
  })),
);

const problems = [];
outcomes.forEach((outcome, i) => {
  if (outcome.status !== "done") {
    problems.push(`第 ${i + 1} 轮状态 ${outcome.status}（exitCode ${outcome.exitCode}）：${outcome.summary.slice(0, 200)}`);
  }
  if (!outcome.sessionId) problems.push(`第 ${i + 1} 轮未捕获会话 id`);
  else if (!outcome.sessionPath) problems.push(`第 ${i + 1} 轮会话文件未定位（${outcome.sessionId}）；pi --session 恢复依赖它`);
});
const ids = outcomes.map((o) => o.sessionId);
if (ids.every(Boolean) && new Set(ids).size !== ids.length) {
  problems.push(`两轮会话 id 相同（并发下必须各自独立）：${ids.join("、")}`);
}
if (state.peak < 2) problems.push(`未观察到真并发（同时在跑子进程峰值 ${state.peak}）`);

if (problems.length > 0) fail(problems.join("; "));

console.log(`✓ 两轮真机并发完成（峰值 ${state.peak} 个子进程）：`);
outcomes.forEach((outcome, i) => {
  console.log(`  - loop-${rounds[i].taskId}-${rounds[i].label} → ${outcome.sessionId}`);
  console.log(`    ${outcome.sessionPath}`);
});
console.log(`  耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
