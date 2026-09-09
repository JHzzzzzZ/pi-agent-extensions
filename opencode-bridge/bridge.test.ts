/**
 * opencode-bridge bridge.ts 单测：配置解析 + ensureBridge 生命周期（全 fake 依赖，无网络/无子进程）。
 * 运行:cd opencode-bridge && npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_SOCKS_HOST,
  DEFAULT_SOCKS_PORT,
  EnsureErrorCodes,
  HELPER_FILE_NAME,
  type BridgeDeps,
  type EnsureBridgeResult,
  createDefaultBridgeDeps,
  ensureBridge,
  applyHttpProxySync,
  makeBackupPath,
  parseBridgeConfig,
  planHttpProxySync,
  ProxySyncActions,
  type ProxySyncDeps,
} from "./bridge.ts";

// ===== fake 依赖 =====

interface FakeDepsOptions {
  /** probe 返回的结果序列；循环最后一个值用于后续所有探测 */
  probeSequence?: boolean[];
  onSpawn?: (nodePath: string, helperPath: string, env: Record<string, string | undefined>) => void;
  spawnThrows?: Error;
  existingPaths?: string[];
}

function makeFakeDeps(options: FakeDepsOptions = {}) {
  const probeCalls: Array<{ host: string; port: number; timeoutMs: number }> = [];
  const spawnCalls: Array<{ nodePath: string; helperPath: string; env: Record<string, string | undefined> }> = [];
  const sleepCalls: number[] = [];
  let probeIndex = 0;
  const deps: BridgeDeps = {
    async probe(host, port, timeoutMs) {
      probeCalls.push({ host, port, timeoutMs });
      const seq = options.probeSequence ?? [];
      const ok = seq[Math.min(probeIndex, Math.max(seq.length - 1, 0))] ?? false;
      probeIndex += 1;
      return ok;
    },
    fileExists(path) {
      return options.existingPaths?.includes(path) ?? false;
    },
    spawnDetached(nodePath, helperPath, env) {
      if (options.spawnThrows) throw options.spawnThrows;
      spawnCalls.push({ nodePath, helperPath, env });
      options.onSpawn?.(nodePath, helperPath, env);
    },
    async sleep(ms) {
      sleepCalls.push(ms);
    },
  };
  return { deps, probeCalls, spawnCalls, sleepCalls };
}

const CONFIG = {
  bridgeHost: BRIDGE_HOST,
  bridgePort: 19999,
  socksHost: "127.0.0.1",
  socksPort: 18808,
  proxyUrl: "http://127.0.0.1:19999",
};
const HELPER_PATH = `/tmp/${HELPER_FILE_NAME}`;
const BASE_OPTIONS = { config: CONFIG, helperPaths: [HELPER_PATH], execPath: "/node", attempts: 3, delayMs: 0 };

// ===== parseBridgeConfig =====

test("parseBridgeConfig 默认配置：10899 / 127.0.0.1 / 10808", () => {
  const result = parseBridgeConfig({});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.bridgePort, DEFAULT_BRIDGE_PORT);
  assert.equal(result.config.socksHost, DEFAULT_SOCKS_HOST);
  assert.equal(result.config.socksPort, DEFAULT_SOCKS_PORT);
  assert.equal(result.config.proxyUrl, `http://${BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`);
});

test("parseBridgeConfig 空字符串与空白环境变量按默认值处理", () => {
  assert.deepEqual(parseBridgeConfig({ PI_BRIDGE_PORT: "", PI_BRIDGE_SOCKS_HOST: "  ", PI_BRIDGE_SOCKS_PORT: "" }), {
    ok: true,
    config: {
      bridgeHost: BRIDGE_HOST,
      bridgePort: DEFAULT_BRIDGE_PORT,
      socksHost: DEFAULT_SOCKS_HOST,
      socksPort: DEFAULT_SOCKS_PORT,
      proxyUrl: `http://${BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`,
    },
  });
});

test("parseBridgeConfig 合法环境变量覆盖默认值", () => {
  const result = parseBridgeConfig({ PI_BRIDGE_PORT: "20800", PI_BRIDGE_SOCKS_HOST: "192.168.1.9", PI_BRIDGE_SOCKS_PORT: "1080" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.bridgePort, 20800);
  assert.equal(result.config.socksHost, "192.168.1.9");
  assert.equal(result.config.socksPort, 1080);
});

test("parseBridgeConfig 非法端口（NaN/越界/非整数）被拒绝且给出变量名", () => {
  for (const bad of ["abc", "0", "70000", "10899.5", "-1"]) {
    const result = parseBridgeConfig({ PI_BRIDGE_PORT: bad });
    assert.equal(result.ok, false, `PI_BRIDGE_PORT=${bad} 应被拒绝`);
    if (result.ok) continue;
    assert.ok(result.errors.some((e) => e.includes("PI_BRIDGE_PORT")));
  }
  const socks = parseBridgeConfig({ PI_BRIDGE_SOCKS_PORT: "http" });
  assert.equal(socks.ok, false);
  if (socks.ok) return;
  assert.ok(socks.errors.some((e) => e.includes("PI_BRIDGE_SOCKS_PORT")));
});

// ===== ensureBridge =====

test("ensureBridge 桥已在监听时直接复用，不 spawn", async () => {
  const { deps, probeCalls, spawnCalls } = makeFakeDeps({ probeSequence: [true] });
  const result = await ensureBridge(BASE_OPTIONS, deps);
  assert.deepEqual(result, { ok: true, started: false });
  assert.equal(spawnCalls.length, 0);
  assert.equal(probeCalls.length, 1);
  assert.deepEqual(probeCalls[0], { host: BRIDGE_HOST, port: 19999, timeoutMs: 600 });
});

test("ensureBridge helper 缺失返回 HELPER_MISSING 且不 spawn", async () => {
  const { deps, spawnCalls } = makeFakeDeps({ probeSequence: [false] });
  const result = await ensureBridge(BASE_OPTIONS, deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.code === EnsureErrorCodes.HELPER_MISSING);
  assert.ok(!result.ok && result.message.includes(HELPER_FILE_NAME));
  assert.equal(spawnCalls.length, 0);
});

test("ensureBridge 按候选顺序取第一个存在的 helper 路径", async () => {
  const second = "/installed/opencode-bridge-helper.mjs";
  const { deps, spawnCalls } = makeFakeDeps({ probeSequence: [false, true], existingPaths: [second] });
  const result = await ensureBridge({ ...BASE_OPTIONS, helperPaths: [HELPER_PATH, second] }, deps);
  assert.equal(result.ok, true);
  assert.equal(spawnCalls[0]?.helperPath, second);
});

test("ensureBridge spawn 同步抛出返回 SPAWN_FAILED", async () => {
  const { deps } = makeFakeDeps({
    probeSequence: [false],
    existingPaths: [HELPER_PATH],
    spawnThrows: new Error("spawn boom"),
  });
  const result = await ensureBridge(BASE_OPTIONS, deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.code === EnsureErrorCodes.SPAWN_FAILED);
  assert.ok(!result.ok && result.message.includes("spawn boom"));
});

test("ensureBridge 端口始终未就绪返回 START_TIMEOUT，且传递 PI_BRIDGE_PORT", async () => {
  const { deps, spawnCalls, sleepCalls } = makeFakeDeps({ probeSequence: [false, false, false, false], existingPaths: [HELPER_PATH] });
  const result = await ensureBridge(BASE_OPTIONS, deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.code === EnsureErrorCodes.START_TIMEOUT);
  assert.ok(!result.ok && result.message.includes("http://127.0.0.1:19999"));
  assert.ok(!result.ok && result.message.includes("127.0.0.1:18808"));
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.env.PI_BRIDGE_PORT, "19999");
  assert.equal(sleepCalls.length, 3); // attempts 次 sleep 后超时
});

test("ensureBridge 轮询到端口就绪返回 started:true", async () => {
  const { deps, spawnCalls, sleepCalls } = makeFakeDeps({ probeSequence: [false, false, true], existingPaths: [HELPER_PATH] });
  const result: EnsureBridgeResult = await ensureBridge(BASE_OPTIONS, deps);
  assert.deepEqual(result, { ok: true, started: true });
  assert.equal(spawnCalls.length, 1);
  assert.equal(sleepCalls.length, 2);
});

test("createDefaultBridgeDeps 提供 probe/fileExists/spawnDetached/sleep 全套边界", () => {
  const deps = createDefaultBridgeDeps();
  assert.equal(typeof deps.probe, "function");
  assert.equal(typeof deps.fileExists, "function");
  assert.equal(typeof deps.spawnDetached, "function");
  assert.equal(typeof deps.sleep, "function");
  assert.equal(deps.fileExists("/definitely/not/a/real/path/xyz"), false);
});

// ===== planHttpProxySync / applyHttpProxySync（内存 fake，不碰真实 settings.json） =====

const SETTINGS_PATH = "/fake/settings.json";
const PROXY_URL = "http://127.0.0.1:10899";

function makeFakeSyncDeps(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(SETTINGS_PATH, initial);
  const writeCalls: Array<{ path: string; content: string }> = [];
  const deps: ProxySyncDeps = {
    readTextFile(path) {
      return files.get(path);
    },
    writeTextFile(path, content) {
      writeCalls.push({ path, content });
      files.set(path, content);
    },
  };
  return { deps, writeCalls, files };
}

test("planHttpProxySync 桥在监听且无 httpProxy：计划 SET（只读，不落盘）", () => {
  const { deps, writeCalls } = makeFakeSyncDeps('{"theme":"dark"}');
  const r = planHttpProxySync({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(r.ok);
  assert.equal(r.plan.action, ProxySyncActions.SET);
  assert.equal(r.plan.proxyUrl, PROXY_URL);
  assert.equal(writeCalls.length, 0);
});

test("planHttpProxySync 已指向本桥：NOOP", () => {
  const { deps } = makeFakeSyncDeps(JSON.stringify({ httpProxy: PROXY_URL }));
  const r = planHttpProxySync({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(r.ok);
  assert.equal(r.plan.action, ProxySyncActions.NOOP);
});

test("planHttpProxySync 已有其它代理地址：FOREIGN（不碰，报告现值）", () => {
  const { deps, writeCalls } = makeFakeSyncDeps(JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));
  const r = planHttpProxySync({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(r.ok);
  assert.equal(r.plan.action, ProxySyncActions.FOREIGN);
  assert.equal(r.plan.current, "http://127.0.0.1:7890");
  assert.match(r.plan.message, /7890/);
  assert.equal(writeCalls.length, 0);
});

test("planHttpProxySync 桥不通且原值指向本桥：计划 REMOVE", () => {
  const { deps } = makeFakeSyncDeps(JSON.stringify({ httpProxy: PROXY_URL }));
  const r = planHttpProxySync({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: false }, deps);
  assert.ok(r.ok);
  assert.equal(r.plan.action, ProxySyncActions.REMOVE);
});

test("planHttpProxySync 桥不通且其它值/无值：NOOP", () => {
  const { deps } = makeFakeSyncDeps(JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));
  const r1 = planHttpProxySync({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: false }, deps);
  assert.ok(r1.ok && r1.plan.action === ProxySyncActions.NOOP);
  const r2 = planHttpProxySync({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: false }, makeFakeSyncDeps(undefined).deps);
  assert.ok(r2.ok && r2.plan.action === ProxySyncActions.NOOP);
});

test("planHttpProxySync 解析失败/根是数组：ok:false（绝不写）", () => {
  const bad = planHttpProxySync({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, makeFakeSyncDeps("{ not json").deps);
  assert.ok(!bad.ok);
  assert.match(bad.message, /解析失败/);
  const arr = planHttpProxySync({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, makeFakeSyncDeps("[]").deps);
  assert.ok(!arr.ok);
  assert.match(arr.message, /根不是对象/);
});

test("applyHttpProxySync SET：先备份原文，再仅加 httpProxy 字段", () => {
  const raw = '{"theme":"dark","defaultModel":"glm-5.3-flash"}';
  const { deps, writeCalls, files } = makeFakeSyncDeps(raw);
  const r = applyHttpProxySync(
    { action: ProxySyncActions.SET, proxyUrl: PROXY_URL, message: "" },
    { settingsPath: SETTINGS_PATH, backupPath: "/fake/backup.bak" },
    deps,
  );
  assert.ok(r.ok);
  assert.equal(r.backupPath, "/fake/backup.bak");
  // 第一笔写是备份（内容 = 原文），第二笔才是 settings
  assert.equal(writeCalls[0]?.path, "/fake/backup.bak");
  assert.equal(writeCalls[0]?.content, raw);
  const saved = JSON.parse(files.get(SETTINGS_PATH)!);
  assert.equal(saved.httpProxy, PROXY_URL);
  assert.equal(saved.theme, "dark");
  assert.equal(saved.defaultModel, "glm-5.3-flash");
  assert.match(r.message, /备份/);
  assert.match(r.message, /重启/);
});

test("applyHttpProxySync REMOVE：备份后仅删 httpProxy 字段，其余不动", () => {
  const { deps, writeCalls, files } = makeFakeSyncDeps('{"theme":"dark","httpProxy":"http://127.0.0.1:10899"}');
  const r = applyHttpProxySync(
    { action: ProxySyncActions.REMOVE, current: PROXY_URL, message: "" },
    { settingsPath: SETTINGS_PATH, backupPath: "/fake/backup.bak" },
    deps,
  );
  assert.ok(r.ok);
  const saved = JSON.parse(files.get(SETTINGS_PATH)!);
  assert.equal(saved.httpProxy, undefined);
  assert.equal(saved.theme, "dark");
  assert.equal(writeCalls[0]?.path, "/fake/backup.bak");
});

test("applyHttpProxySync 原文件不存在：无备份仍然可 SET", () => {
  const { deps, writeCalls, files } = makeFakeSyncDeps(undefined);
  const r = applyHttpProxySync(
    { action: ProxySyncActions.SET, proxyUrl: PROXY_URL, message: "" },
    { settingsPath: SETTINGS_PATH, backupPath: "/fake/backup.bak" },
    deps,
  );
  assert.ok(r.ok);
  assert.equal(r.backupPath, undefined);
  assert.equal(writeCalls.length, 1); // 只写 settings，无备份笔
  assert.match(r.message, /无备份/);
  assert.equal(JSON.parse(files.get(SETTINGS_PATH)!).httpProxy, PROXY_URL);
});

test("applyHttpProxySync 竞态：current 与计划不符时拒绝且不写", () => {
  const { deps, writeCalls } = makeFakeSyncDeps(JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));
  const r = applyHttpProxySync(
    { action: ProxySyncActions.SET, proxyUrl: PROXY_URL, current: undefined, message: "" },
    { settingsPath: SETTINGS_PATH, backupPath: "/fake/backup.bak" },
    deps,
  );
  assert.ok(!r.ok);
  assert.match(r.message, /已变化/);
  assert.equal(writeCalls.length, 0);
});

test("applyHttpProxySync noop 计划直接拒绝", () => {
  const { deps, writeCalls } = makeFakeSyncDeps("{}");
  const r = applyHttpProxySync(
    { action: ProxySyncActions.NOOP, message: "" },
    { settingsPath: SETTINGS_PATH, backupPath: "/fake/backup.bak" },
    deps,
  );
  assert.ok(!r.ok);
  assert.equal(writeCalls.length, 0);
});

test("applyHttpProxySync 备份写失败：拒绝修改 settings", () => {
  const deps: ProxySyncDeps = {
    readTextFile: () => '{"theme":"dark"}',
    writeTextFile(path) {
      if (path === "/fake/backup.bak") throw new Error("disk full");
    },
  };
  const r = applyHttpProxySync(
    { action: ProxySyncActions.SET, proxyUrl: PROXY_URL, message: "" },
    { settingsPath: SETTINGS_PATH, backupPath: "/fake/backup.bak" },
    deps,
  );
  assert.ok(!r.ok);
  assert.match(r.message, /备份失败/);
});

test("applyHttpProxySync settings 写失败：报错（备份已落盘可回滚）", () => {
  const deps: ProxySyncDeps = {
    readTextFile: () => '{"theme":"dark"}',
    writeTextFile(path, content) {
      if (path === SETTINGS_PATH) throw new Error("EACCES");
    },
  };
  const r = applyHttpProxySync(
    { action: ProxySyncActions.SET, proxyUrl: PROXY_URL, message: "" },
    { settingsPath: SETTINGS_PATH, backupPath: "/fake/backup.bak" },
    deps,
  );
  assert.ok(!r.ok);
  assert.match(r.message, /EACCES/);
});

test("makeBackupPath 生成同目录带时间戳的备份路径", () => {
  const p = makeBackupPath("C:/Users/u/.pi/agent/settings.json", new Date(2026, 7, 5, 12, 3, 4));
  assert.equal(p, "C:/Users/u/.pi/agent/settings.json.bak-opencode-bridge-20260805-120304");
});
