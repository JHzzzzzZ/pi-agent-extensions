/**
 * tools/test-all.mjs — 仓库全量测试唯一入口（零依赖、纯 node）
 *
 * 背景（general-todo#11）：仓库测试已到 ~1900 用例，此前按目录手工串行跑；
 * 收尾核对与多 worktree 并行开发时固定成本高。本工具把「跑完所有套件」变成
 * 一条命令：
 *
 *   npm run test:all                  # 默认 --jobs 2
 *   node tools/test-all.mjs --jobs 1  # 全串行（对照基线）
 *   node tools/test-all.mjs --jobs 4  # 提高并发
 *   node tools/test-all.mjs --install # 先在缺依赖的目录 npm install 再跑
 *   node tools/test-all.mjs --only pwr
 *   node tools/test-all.mjs --list
 *
 * 设计口径：
 *   - DEFAULT_SUITES 是本文件里的常量，逐条镜像各插件 README / package.json 的
 *     测试命令；登记覆盖 pi.extensions 全部扩展、agent-manager 与根三套自检，
 *     覆盖只增不减（test/test-all.test.ts 有锁定测试）。
 *   - 负载敏感套件（pwr 性能门 / agent-manager 性能门 / root:todo 真子进程并发）
 *     标 serial：一整轮内独占运行（等其它套件排空后才启动），绝不放宽断言。
 *   - 逐套件墙钟计时、失败即收集不中断、退出码聚合（0 全绿 / 1 有失败 / 2 用法或
 *     注册表错误）；输出含 node 版本、平台与 CPU 数，跨机可复算。
 *   - 测试命令统一 `node --test` 直启（Windows 上 npm.cmd 必须过 shell，且多一层
 *     进程开销）；只有 --install 走 npm。
 *
 * 纯函数（parseArgs / normalizeSuites / filterSuites / parseTestCounts /
 * formatDuration / summarize / installTargets）导出给 test/test-all.test.ts；
 * CLI 只在直接执行时跑。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

const DEFAULT_TIMEOUT_MS = 600_000;
const FAILURE_TAIL_LINES = 40;
const INSTALL_ARGS = ["install", "--prefer-offline", "--no-audit", "--no-fund"];

const strip = { cmd: "node --test", serial: false, install: false };

/**
 * 套件清单（cwd 相对仓库根；cmd[0] === "node" 在执行前替换为 process.execPath）。
 * serial = 负载敏感：性能门 / 真子进程并发用例，必须独占运行，断言不放宽。
 */
export const DEFAULT_SUITES = [
  {
    ...strip,
    name: "pwr",
    cwd: "src/extensions/pwr",
    serial: true,
    install: true,
    cmd: [
      "node",
      "--test",
      "test/validator.test.ts",
      "test/interpreter.test.ts",
      "test/plain.test.ts",
      "test/perf.test.ts",
      "test/validate-tool.test.ts",
      "test/entry.test.ts",
      "tests/*.test.ts",
      "runtime/test/*.test.ts",
      "runner/test/*.test.ts",
    ],
  },
  { ...strip, name: "agent-team", cwd: "src/extensions/agent-team", install: true, cmd: ["node", "--test", "test/*.test.ts"] },
  {
    ...strip,
    name: "stream-token-speed",
    cwd: "src/extensions/stream-token-speed",
    cmd: ["node", "--experimental-strip-types", "--test", "test/*.test.ts"],
  },
  {
    ...strip,
    name: "chatanywhere-provider",
    cwd: ".",
    cmd: ["node", "--experimental-strip-types", "--test", "src/extensions/chatanywhere-provider/test/*.test.ts"],
  },
  {
    ...strip,
    name: "provider-quota",
    cwd: ".",
    cmd: ["node", "--experimental-strip-types", "--test", "src/extensions/provider-quota/index.test.ts"],
  },
  {
    ...strip,
    name: "run-timer",
    cwd: ".",
    cmd: [
      "node",
      "--experimental-strip-types",
      "--test",
      "src/extensions/run-timer/run-timer.test.ts",
      "src/extensions/run-timer/aligned-ticker.test.ts",
    ],
  },
  { ...strip, name: "loop", cwd: "src/extensions/loop", install: true, cmd: ["node", "--test", "test/*.test.ts"] },
  {
    ...strip,
    name: "goal",
    cwd: ".",
    cmd: ["node", "--experimental-strip-types", "--test", "src/extensions/goal/index.test.ts", "src/extensions/goal/aligned-ticker.test.ts"],
  },
  { ...strip, name: "opencode-bridge", cwd: "src/extensions/opencode-bridge", install: true, cmd: ["node", "--test", "*.test.ts"] },
  { ...strip, name: "deep-init", cwd: "src/extensions/deep-init", install: true, cmd: ["node", "--test", "*.test.ts"] },
  {
    ...strip,
    name: "human-notify",
    cwd: ".",
    cmd: ["node", "--experimental-strip-types", "--test", "src/extensions/human-notify/index.test.ts"],
  },
  {
    ...strip,
    name: "solo-mode",
    cwd: ".",
    cmd: ["node", "--experimental-strip-types", "--test", "src/extensions/solo-mode/index.test.ts"],
  },
  {
    ...strip,
    name: "agent-manager",
    cwd: "agent-manager",
    serial: true,
    install: true,
    cmd: ["node", "--experimental-strip-types", "--test", "core.test.ts", "agent-runner.test.ts", "server.test.ts"],
  },
  { ...strip, name: "root:contract", cwd: ".", cmd: ["node", "--test", "test/status-bar-contract.test.ts"] },
  { ...strip, name: "root:smoke", cwd: ".", cmd: ["node", "--test", "test/install-smoke.test.ts"] },
  { ...strip, name: "root:test-all", cwd: ".", cmd: ["node", "--test", "test/test-all.test.ts"] },
  { ...strip, name: "root:todo", cwd: ".", serial: true, cmd: ["node", "--test", ".agents/skills/todo-cli/todo-cli/test/*.test.ts"] },
];

const VALUE_FLAGS = new Set(["--jobs", "--only", "--registry", "--timeout"]);
const usageFail = (message) => ({ ok: false, code: "USAGE", message });

export function parseArgs(argv) {
  const value = { jobs: 2, only: null, install: false, list: false, registry: null, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--install") value.install = true;
    else if (arg === "--list") value.list = true;
    else if (arg === "--help" || arg === "-h") value.help = true;
    else if (VALUE_FLAGS.has(arg)) {
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith("--")) return usageFail(`${arg} 需要取值`);
      i += 1;
      if (arg === "--jobs") {
        if (!/^\d+$/.test(raw) || Number(raw) < 1) return usageFail(`--jobs 需要 ≥1 的整数，收到：${raw}`);
        value.jobs = Number(raw);
      } else if (arg === "--timeout") {
        if (!/^\d+$/.test(raw) || Number(raw) < 1000) return usageFail(`--timeout 需要 ≥1000 的毫秒整数，收到：${raw}`);
        value.timeoutMs = Number(raw);
      } else if (arg === "--only") value.only = raw;
      else value.registry = raw;
    } else return usageFail(`未知参数：${arg}`);
  }
  return { ok: true, value };
}

/** 校验并归一注册表：cwd 相对 baseDir 解析，node 替换为当前进程可执行文件。 */
export function normalizeSuites(raw, baseDir) {
  if (!Array.isArray(raw)) return { ok: false, code: "REGISTRY_INVALID", message: "注册表必须是套件数组" };
  const suites = [];
  for (const entry of raw) {
    const name = entry?.name;
    const cwd = entry?.cwd;
    const cmd = entry?.cmd;
    if (typeof name !== "string" || name.length === 0) return { ok: false, code: "REGISTRY_INVALID", message: "套件缺 name" };
    if (typeof cwd !== "string" || cwd.length === 0) return { ok: false, code: "REGISTRY_INVALID", message: `套件 ${name} 缺 cwd` };
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === "string")) {
      return { ok: false, code: "REGISTRY_INVALID", message: `套件 ${name} 的 cmd 必须是非空字符串数组` };
    }
    suites.push({
      name,
      cwd: path.resolve(baseDir, cwd),
      cmd: cmd[0] === "node" ? [process.execPath, ...cmd.slice(1)] : cmd,
      serial: entry.serial === true,
      install: entry.install === true,
    });
  }
  return { ok: true, value: suites };
}

export function filterSuites(suites, only) {
  if (only === null || only === undefined) return suites;
  return suites.filter((s) => s.name.includes(only));
}

/** 从 node:test 输出（TAP 的 `# tests N` 或 spec 的 `ℹ tests N`）取汇总计数。 */
export function parseTestCounts(output) {
  const last = (label) => {
    const re = new RegExp(`^\\s*[ℹ#]?\\s*${label}\\s+(\\d+)\\s*$`, "gm");
    let found = null;
    for (const m of output.matchAll(re)) found = Number(m[1]);
    return found;
  };
  const tests = last("tests");
  if (tests === null) return null;
  return { tests, pass: last("pass") ?? 0, fail: last("fail") ?? 0 };
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

export function installTargets(suites) {
  return [...new Set(suites.filter((s) => s.install).map((s) => s.cwd))];
}

export function summarize(results) {
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  const sum = (pick) => results.reduce((n, r) => n + pick(r), 0);
  return {
    exitCode: failed.length > 0 ? 1 : 0,
    suites: results.length,
    failed,
    tests: sum((r) => r.counts?.tests ?? 0),
    pass: sum((r) => r.counts?.pass ?? 0),
    fail: sum((r) => r.counts?.fail ?? 0),
    summedMs: sum((r) => r.ms),
  };
}

const pad = (text, width) => text + " ".repeat(Math.max(0, width - text.length));
const tailLines = (text, count) => text.split("\n").slice(-count).join("\n");

/** 跑一条命令并捕获输出；超时杀进程（杀不掉子进程树，退化为单个套件失败）。 */
function runCommand(cmd, args, options) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: options.shell === true });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, ms: Date.now() - started, output: `${output}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, ms: Date.now() - started, output, timedOut });
    });
  });
}

async function runSuite(suite, timeoutMs) {
  const r = await runCommand(suite.cmd[0], suite.cmd.slice(1), { cwd: suite.cwd, timeoutMs });
  return {
    name: suite.name,
    ok: r.ok,
    ms: r.ms,
    counts: parseTestCounts(r.output),
    tail: r.ok ? "" : `${r.timedOut ? "（超时被杀）\n" : ""}${tailLines(r.output, FAILURE_TAIL_LINES)}`,
  };
}

/** 保序并发调度：serial 套件独占——运行期间不启动任何新套件，启动前等其它套件排空。 */
async function runSuites(suites, options) {
  const pending = [...suites];
  const active = new Map(); // promise -> suite
  const results = new Map();
  while (pending.length > 0 || active.size > 0) {
    while (pending.length > 0 && active.size < options.jobs) {
      const head = pending[0];
      const serialActive = [...active.values()].some((s) => s.serial);
      if (active.size > 0 && (head.serial || serialActive)) break;
      pending.shift();
      let promise;
      promise = runSuite(head, options.timeoutMs).then((result) => {
        results.set(head.name, result);
        active.delete(promise);
        options.onResult(result, results.size);
      });
      active.set(promise, head);
    }
    if (active.size > 0) await Promise.race(active.keys());
  }
  return suites.map((s) => results.get(s.name));
}

/** 依赖安装（--install）：同并发度并行 npm install，串行打印进度。 */
async function runInstalls(dirs, options) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < dirs.length) {
      const dir = dirs[next];
      next += 1;
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const r = await runCommand(npm, INSTALL_ARGS, { cwd: dir, timeoutMs: options.timeoutMs, shell: true });
      process.stdout.write(`[${r.ok ? "ok" : "fail"}]    npm install ${path.relative(REPO_ROOT, dir) || "."}  ${formatDuration(r.ms)}\n`);
      if (!r.ok) process.stdout.write(tailLines(r.output, FAILURE_TAIL_LINES) + "\n");
      results.push({ dir, ok: r.ok });
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.jobs, dirs.length) }, worker));
  return results;
}

function printUsage() {
  process.stdout.write(
    [
      "用法（仓库根）：node tools/test-all.mjs [选项]",
      "",
      "  --jobs N         并发套件数（默认 2；1 = 全串行对照）",
      "  --only <子串>    只跑名字含该子串的套件",
      "  --install        先在需要依赖的目录并行 npm install（--prefer-offline）",
      "  --list           只列套件清单，不执行",
      "  --registry <f>   用 JSON 注册表替代内置清单（测试缝）",
      "  --timeout <ms>   单套件超时（默认 600000）",
      "  --help           本说明",
      "",
      "退出码：0 全绿 / 1 有套件失败或安装失败 / 2 用法或注册表错误",
      "",
    ].join("\n"),
  );
}

function printHeader(suites, jobs) {
  const cpu = os.cpus().length;
  process.stdout.write(
    `== test:all · node ${process.version} · ${process.platform} ${process.arch} · ${cpu} CPUs · jobs ${jobs} · ${suites.length} 套件 ==\n`,
  );
}

function printSummary(results, options) {
  const total = summarize(results);
  const width = Math.max(...results.map((r) => r.name.length), 5);
  process.stdout.write("\n== 汇总 ==\n");
  process.stdout.write(`${pad("suite", width)}  结果   用例    墙钟\n`);
  for (const r of results) {
    process.stdout.write(
      `${pad(r.name, width)}  ${r.ok ? "ok  " : "fail"}   ${pad(r.counts ? String(r.counts.tests) : "-", 5)}  ${formatDuration(r.ms)}\n`,
    );
  }
  process.stdout.write(
    `通过 ${total.suites - total.failed.length}/${total.suites} 套件 · 用例 ${total.tests}（pass ${total.pass} / fail ${total.fail}）· jobs ${options.jobs}\n`,
  );
  process.stdout.write(`墙钟 ${formatDuration(options.wallMs)} · 套件耗时合计 ${formatDuration(total.summedMs)}\n`);
  if (total.failed.length > 0) process.stdout.write(`失败套件：${total.failed.join("、")}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    printUsage();
    return 2;
  }
  if (parsed.value.help) {
    printUsage();
    return 0;
  }
  const options = parsed.value;

  let raw = DEFAULT_SUITES;
  let baseDir = REPO_ROOT;
  if (options.registry !== null) {
    try {
      const file = path.resolve(process.cwd(), options.registry);
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
      baseDir = path.dirname(file);
    } catch (err) {
      process.stderr.write(`注册表读取失败：${options.registry}（${err.message}）\n`);
      return 2;
    }
  }
  const normalized = normalizeSuites(raw, baseDir);
  if (!normalized.ok) {
    process.stderr.write(`${normalized.message}\n`);
    return 2;
  }
  const selected = filterSuites(normalized.value, options.only);
  if (selected.length === 0) {
    process.stderr.write(`没有匹配的套件（--only ${options.only}）\n`);
    return 2;
  }
  if (options.list) {
    const width = Math.max(...selected.map((s) => s.name.length), 5);
    for (const s of selected) {
      const marks = [s.serial ? "serial" : "", s.install ? "install" : ""].filter(Boolean).join(",");
      process.stdout.write(`${pad(s.name, width)}  ${marks || "-"}\n`);
    }
    return 0;
  }

  printHeader(selected, options.jobs);

  if (options.install) {
    const dirs = installTargets(selected);
    process.stdout.write(`== 依赖安装（npm install × ${dirs.length}，jobs ${options.jobs}）==\n`);
    const installs = await runInstalls(dirs, options);
    if (installs.some((i) => !i.ok)) {
      process.stderr.write("依赖安装失败，已中止（失败目录见上）\n");
      return 1;
    }
  } else {
    const missing = selected.filter((s) => s.install && !fs.existsSync(path.join(s.cwd, "node_modules")));
    if (missing.length > 0) {
      process.stdout.write(
        `! 缺少 node_modules：${missing.map((s) => s.name).join("、")}——先跑一次 node tools/test-all.mjs --install（或 cd <目录> && npm install）\n`,
      );
    }
  }

  const started = Date.now();
  const onResult = (r, done) => {
    process.stdout.write(`[${r.ok ? "ok" : "fail"}] ${pad(r.name, 22)} ${pad(r.counts ? `${r.counts.tests} 用例` : "-", 9)} ${formatDuration(r.ms)}  (${done}/${selected.length})\n`);
  };
  const results = await runSuites(selected, { jobs: options.jobs, timeoutMs: options.timeoutMs, onResult });
  const wallMs = Date.now() - started;

  printSummary(results, { jobs: options.jobs, wallMs });
  const total = summarize(results);
  for (const r of results.filter((x) => !x.ok)) {
    process.stdout.write(`\n---- ${r.name} 输出尾部（${FAILURE_TAIL_LINES} 行）----\n${r.tail}\n`);
  }
  return total.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
