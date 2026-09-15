/**
 * tools/test-all.mjs（仓库级全量测试入口）的测试。
 *
 * 边界说明：纯函数（参数解析 / 套件过滤 / 输出解析 / 汇总）直接单测；调度语义
 * （并发、serial 独占、失败聚合退出码、--install）在真实进程边界上测——用临时
 * 目录里的 fixture 注册表拉起真实 CLI，fixture 套件是真实 node 子进程（写
 * start/end 标记文件），因此「serial 不与他人重叠」是实测顺序，不是纸面断言。
 * 本文件不跑真实仓库套件（那由 `npm run test:all` 自己覆盖）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SUITES,
  REPO_ROOT,
  filterSuites,
  formatDuration,
  installTargets,
  normalizeSuites,
  parseArgs,
  parseTestCounts,
  summarize,
} from "../tools/test-all.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(REPO_ROOT, "tools", "test-all.mjs");

test("parseArgs：默认并发 2、无过滤、不安装", () => {
  const r = parseArgs([]);
  assert.equal(r.ok, true);
  assert.equal(r.value.jobs, 2);
  assert.equal(r.value.only, null);
  assert.equal(r.value.list, false);
  assert.equal(r.value.install, false);
  assert.equal(r.value.registry, null);
});

test("parseArgs：--jobs/--only/--install/--list/--registry 均被识别", () => {
  const r = parseArgs(["--jobs", "4", "--only", "pwr", "--install", "--list", "--registry", "r.json"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    jobs: 4,
    only: "pwr",
    install: true,
    list: true,
    registry: "r.json",
    timeoutMs: 600_000,
  });
});

test("parseArgs：非法并发/未知 flag/缺值 fail-closed", () => {
  assert.equal(parseArgs(["--jobs", "0"]).ok, false);
  assert.equal(parseArgs(["--jobs", "abc"]).ok, false);
  assert.equal(parseArgs(["--jobs"]).ok, false);
  assert.equal(parseArgs(["--nope"]).ok, false);
  assert.equal(parseArgs(["--only"]).ok, false);
  const r = parseArgs(["--timeout", "5"]);
  assert.equal(r.ok, false);
  assert.equal(parseArgs(["--timeout", "30000"]).value.timeoutMs, 30_000);
});

test("filterSuites：按名字子串过滤，无匹配即空", () => {
  const suites = [
    { name: "pwr", cwd: "a", cmd: ["node", "--test", "x.ts"], serial: true, install: true },
    { name: "root:todo", cwd: ".", cmd: ["node", "--test", "y.ts"], serial: true, install: false },
  ];
  assert.deepEqual(filterSuites(suites, null).map((s) => s.name), ["pwr", "root:todo"]);
  assert.deepEqual(filterSuites(suites, "pwr").map((s) => s.name), ["pwr"]);
  assert.deepEqual(filterSuites(suites, "nope"), []);
});

test("parseTestCounts：TAP 与 spec 两种汇总格式都能解析", () => {
  const tap = "ok 1 - a\n# tests 439\n# suites 3\n# pass 438\n# fail 1\n# skipped 0\n";
  assert.deepEqual(parseTestCounts(tap), { tests: 439, pass: 438, fail: 1 });
  const spec = "ℹ tests 45\nℹ pass 45\nℹ fail 0\nℹ duration_ms 128\n";
  assert.deepEqual(parseTestCounts(spec), { tests: 45, pass: 45, fail: 0 });
  assert.equal(parseTestCounts("no summary here"), null);
});

test("formatDuration：ms / 秒 / 分秒三种量级可读", () => {
  assert.equal(formatDuration(650), "650ms");
  assert.equal(formatDuration(11_700), "11.7s");
  assert.equal(formatDuration(90_500), "1m 30.5s");
});

test("summarize：全绿退出码 0、任一失败退出码 1，计数相加", () => {
  const ok = summarize([
    { name: "a", ok: true, ms: 1000, counts: { tests: 3, pass: 3, fail: 0 } },
    { name: "b", ok: true, ms: 2000, counts: { tests: 2, pass: 2, fail: 0 } },
  ]);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.tests, 5);
  assert.equal(ok.summedMs, 3000);
  assert.deepEqual(ok.failed, []);

  const bad = summarize([
    { name: "a", ok: true, ms: 1000, counts: { tests: 3, pass: 3, fail: 0 } },
    { name: "b", ok: false, ms: 500, counts: null },
  ]);
  assert.equal(bad.exitCode, 1);
  assert.deepEqual(bad.failed, ["b"]);
  assert.equal(bad.tests, 3);
});

test("normalizeSuites：解析相对 cwd、校验形状、缺字段 fail-closed", () => {
  const base = path.resolve("/tmp/fixture-root");
  const r = normalizeSuites(
    [{ name: "a", cwd: "suites/a", cmd: ["node", "--test", "a.test.ts"], serial: true, install: true }],
    base,
  );
  assert.equal(r.ok, true);
  assert.equal(r.value[0].cwd, path.join(base, "suites", "a"));
  assert.equal(r.value[0].serial, true);
  assert.equal(normalizeSuites([{ name: "a", cmd: ["node"] }], base).ok, false);
  assert.equal(normalizeSuites([{ name: "a", cwd: ".", cmd: [] }], base).ok, false);
  assert.equal(normalizeSuites("nope", base).ok, false);
});

test("installTargets：去重返回需要依赖安装的目录", () => {
  const suites = [
    { name: "a", cwd: "/x/pwr", serial: false, install: true },
    { name: "b", cwd: "/x/pwr", serial: false, install: true },
    { name: "c", cwd: "/x/todo", serial: true, install: false },
  ];
  assert.deepEqual(installTargets(suites), ["/x/pwr"]);
});

test("DEFAULT_SUITES：形状合法、名字唯一、命令统一走 node --test", () => {
  const names = DEFAULT_SUITES.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  for (const s of DEFAULT_SUITES) {
    assert.equal(typeof s.name, "string");
    assert.ok(s.cwd.length > 0, `${s.name} 缺 cwd`);
    assert.equal(s.cmd[0], "node", `${s.name} 必须用 node 直启（避免 Windows npm.cmd 壳）`);
    assert.ok(s.cmd.includes("--test"), `${s.name} 必须是 node:test`);
  }
});

test("DEFAULT_SUITES：serial 只标三条负载敏感套件（不放宽断言）", () => {
  const serial = DEFAULT_SUITES.filter((s) => s.serial).map((s) => s.name).sort();
  assert.deepEqual(serial, ["agent-manager", "pwr", "root:todo"]);
});

test("DEFAULT_SUITES：登记覆盖 pi.extensions 全部扩展与根三套自检", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const covered = (needle: string) =>
    DEFAULT_SUITES.some((s) => s.cwd.includes(needle) || s.cmd.some((a) => a.includes(needle)));
  for (const entry of pkg.pi.extensions as string[]) {
    const dir = path.posix.dirname(entry).replace(/^\.\//, "");
    assert.ok(covered(dir), `扩展 ${dir} 没有对应套件`);
  }
  for (const script of ["test/status-bar-contract.test.ts", "test/install-smoke.test.ts", ".agents/skills/todo-cli"]) {
    assert.ok(covered(script), `根自检 ${script} 没有对应套件`);
  }
  assert.ok(DEFAULT_SUITES.some((s) => s.cwd.includes("agent-manager")), "agent-manager 没有套件");
  assert.ok(
    DEFAULT_SUITES.some((s) => s.cmd.some((a) => a.includes("test/test-all.test.ts"))),
    "test-all 自身的测试没有登记",
  );
});

// ---------- 进程边界：真实 CLI + fixture 注册表 ----------

type FixtureSuite = {
  name: string;
  sleepMs: number;
  exitCode?: number;
  serial?: boolean;
  install?: boolean;
};

/** 临时注册表：套件是真实 node 子进程，读写共享标记文件作为调度顺序证据。 */
function makeFixture(suites: FixtureSuite[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-all-fixture-"));
  const logPath = path.join(dir, "order.log");
  fs.writeFileSync(logPath, "");
  const entries = suites.map((s, i) => {
    const sub = path.join(dir, `suite-${i}`);
    fs.mkdirSync(sub, { recursive: true });
    const script = path.join(sub, "run.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        `const log = ${JSON.stringify(logPath)};`,
        `fs.appendFileSync(log, "start ${s.name}\\n");`,
        `await new Promise((r) => setTimeout(r, ${s.sleepMs}));`,
        `fs.appendFileSync(log, "end ${s.name}\\n");`,
        s.exitCode
          ? `console.log("FAILURE_MARKER ${s.name}");`
          : `console.log("# tests 1");`,
        s.exitCode ? `console.log("# fail 1");` : `console.log("# pass 1");`,
        `process.exit(${s.exitCode ?? 0});`,
        "",
      ].join("\n"),
    );
    return {
      name: s.name,
      cwd: sub,
      cmd: ["node", script],
      serial: s.serial ?? false,
      install: s.install ?? false,
    };
  });
  const registryPath = path.join(dir, "registry.json");
  fs.writeFileSync(registryPath, JSON.stringify(entries, null, 2));
  return { dir, logPath, registryPath, readLog: () => fs.readFileSync(logPath, "utf8").trim().split("\n") };
}

function runTool(args: string[], timeout = 60_000) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout,
  });
}

test("CLI：全部通过时退出码 0，输出含套件名、用例计数与并发度", (t) => {
  const fx = makeFixture([
    { name: "s1", sleepMs: 10 },
    { name: "s2", sleepMs: 10 },
  ]);
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const r = runTool(["--registry", fx.registryPath, "--jobs", "1"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /s1/);
  assert.match(r.stdout, /s2/);
  assert.match(r.stdout, /node v/);
  assert.match(r.stdout, /jobs 1/);
  assert.match(r.stdout, /用例 2/);
});

test("CLI：失败聚合——退出码 1、其余套件照跑、失败输出带诊断尾部", (t) => {
  const fx = makeFixture([
    { name: "good", sleepMs: 10 },
    { name: "bad", sleepMs: 10, exitCode: 1 },
    { name: "after", sleepMs: 10 },
  ]);
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const r = runTool(["--registry", fx.registryPath, "--jobs", "2"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /失败套件：bad/);
  assert.match(r.stdout, /FAILURE_MARKER bad/);
  const log = fx.readLog();
  assert.equal(log.length, 6);
  for (const marker of ["start good", "end good", "start bad", "end bad", "start after", "end after"]) {
    assert.ok(log.includes(marker), `缺标记 ${marker}`);
  }
  assert.ok(log.includes("end after"), "失败不中断后续套件");
});

test("CLI：serial 套件独占运行——前后非 serial 套件按序排空", (t) => {
  const fx = makeFixture([
    { name: "a", sleepMs: 400 },
    { name: "s", sleepMs: 150, serial: true },
    { name: "b", sleepMs: 50 },
  ]);
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const r = runTool(["--registry", fx.registryPath, "--jobs", "2"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fx.readLog(), ["start a", "end a", "start s", "end s", "start b", "end b"]);
});

test("CLI：--jobs 2 让两个非 serial 套件真并发（区间重叠）", (t) => {
  const fx = makeFixture([
    { name: "a", sleepMs: 500 },
    { name: "b", sleepMs: 500 },
  ]);
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const r = runTool(["--registry", fx.registryPath, "--jobs", "2"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = fx.readLog();
  assert.ok(log.indexOf("start a") < log.indexOf("end b"), `a/b 未重叠：${log.join(" | ")}`);
  assert.ok(log.indexOf("start b") < log.indexOf("end a"), `b/a 未重叠：${log.join(" | ")}`);
});

test("CLI：--list 只列套件不执行；--only 过滤出子集", (t) => {
  const fx = makeFixture([
    { name: "s1", sleepMs: 10 },
    { name: "s2", sleepMs: 10 },
  ]);
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const listed = runTool(["--registry", fx.registryPath, "--list"]);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /s1/);
  assert.match(listed.stdout, /s2/);
  assert.equal(fx.readLog().join(""), "", "--list 不应执行套件");

  const only = runTool(["--registry", fx.registryPath, "--only", "s2"]);
  assert.equal(only.status, 0, only.stdout + only.stderr);
  assert.deepEqual(fx.readLog(), ["start s2", "end s2"]);
});

test("CLI：--install 先装依赖再跑套件（package-lock.json 为安装证据）", (t) => {
  const fx = makeFixture([{ name: "s1", sleepMs: 10, install: true }]);
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const suiteDir = path.join(fx.dir, "suite-0");
  fs.writeFileSync(
    path.join(suiteDir, "package.json"),
    JSON.stringify({ name: "fixture-suite", version: "1.0.0", private: true, dependencies: {} }),
  );
  const r = runTool(["--registry", fx.registryPath, "--install", "--jobs", "1"], 120_000);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /安装/);
  assert.ok(fs.existsSync(path.join(suiteDir, "package-lock.json")), "npm install 未跑");
  assert.ok(fx.readLog().includes("end s1"), "安装后套件应照跑");
});

test("CLI：注册表缺失 / --only 无匹配 / 非法 flag 都以退出码 2 fail-closed", (t) => {
  const missing = runTool(["--registry", path.join(HERE, "no-such-registry.json")]);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stdout + missing.stderr, /注册表|registry/);

  const fx = makeFixture([{ name: "s1", sleepMs: 10 }]);
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const none = runTool(["--registry", fx.registryPath, "--only", "nope"]);
  assert.equal(none.status, 2, none.stdout + none.stderr);
  const badFlag = runTool(["--nope"]);
  assert.equal(badFlag.status, 2, badFlag.stdout + badFlag.stderr);

  const broken = path.join(fx.dir, "broken.json");
  fs.writeFileSync(broken, "{ not json");
  const brokenRun = runTool(["--registry", broken]);
  assert.equal(brokenRun.status, 2, brokenRun.stdout + brokenRun.stderr);
});
