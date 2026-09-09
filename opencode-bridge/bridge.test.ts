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
  parseBridgeConfig,
  ProxySyncActions,
  type ProxySyncDeps,
  syncHttpProxy,
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

// ===== syncHttpProxy（内存 fake，不碰真实 settings.json） =====

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

test("syncHttpProxy 桥在监听且无 httpProxy：写入并提示重启生效", () => {
  const { deps, writeCalls, files } = makeFakeSyncDeps('{"theme":"dark"}');
  const r = syncHttpProxy({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(r.ok);
  assert.equal(r.action, ProxySyncActions.SET);
  assert.match(r.message, /重启/);
  assert.equal(writeCalls.length, 1);
  const saved = JSON.parse(files.get(SETTINGS_PATH)!);
  assert.equal(saved.theme, "dark");
  assert.equal(saved.httpProxy, PROXY_URL);
});

test("syncHttpProxy 已指向本桥：幂等不动", () => {
  const { deps, writeCalls } = makeFakeSyncDeps(JSON.stringify({ httpProxy: PROXY_URL }));
  const r = syncHttpProxy({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(r.ok);
  assert.equal(r.action, ProxySyncActions.UNCHANGED);
  assert.equal(writeCalls.length, 0);
});

test("syncHttpProxy 已有其它代理地址：不碰，仅提示", () => {
  const { deps, writeCalls, files } = makeFakeSyncDeps(JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));
  const r = syncHttpProxy({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(r.ok);
  assert.equal(r.action, ProxySyncActions.KEPT_FOREIGN);
  assert.match(r.message, /7890/);
  assert.equal(writeCalls.length, 0);
  assert.match(files.get(SETTINGS_PATH)!, /7890/);
});

test("syncHttpProxy 桥不通且原值指向本桥：自愈移除", () => {
  const { deps, writeCalls, files } = makeFakeSyncDeps(JSON.stringify({ theme: "dark", httpProxy: PROXY_URL }));
  const r = syncHttpProxy({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: false }, deps);
  assert.ok(r.ok);
  assert.equal(r.action, ProxySyncActions.REMOVED);
  const saved = JSON.parse(files.get(SETTINGS_PATH)!);
  assert.equal(saved.theme, "dark");
  assert.equal(saved.httpProxy, undefined);
});

test("syncHttpProxy 桥不通且原值是其它代理：不动", () => {
  const { deps, writeCalls } = makeFakeSyncDeps(JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));
  const r = syncHttpProxy({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: false }, deps);
  assert.ok(r.ok);
  assert.equal(r.action, ProxySyncActions.KEPT_FOREIGN);
  assert.equal(writeCalls.length, 0);
});

test("syncHttpProxy 文件不存在视作空设置：桥通则写入", () => {
  const { deps, writeCalls } = makeFakeSyncDeps(undefined);
  const r = syncHttpProxy({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(r.ok);
  assert.equal(r.action, ProxySyncActions.SET);
  assert.equal(writeCalls.length, 1);
});

test("syncHttpProxy settings.json 解析失败：报错不写", () => {
  const { deps, writeCalls } = makeFakeSyncDeps("{ not json");
  const r = syncHttpProxy({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(!r.ok);
  assert.match(r.message, /解析失败/);
  assert.equal(writeCalls.length, 0);
});

test("syncHttpProxy 根是数组：报错不写（防整体覆盖）", () => {
  const { deps, writeCalls } = makeFakeSyncDeps("[]");
  const r = syncHttpProxy({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(!r.ok);
  assert.match(r.message, /根不是对象/);
  assert.equal(writeCalls.length, 0);
});

test("syncHttpProxy 写入抛异常：归一为 ok:false", () => {
  const deps: ProxySyncDeps = {
    readTextFile: () => undefined,
    writeTextFile: () => {
      throw new Error("disk full");
    },
  };
  const r = syncHttpProxy({ settingsPath: SETTINGS_PATH, proxyUrl: PROXY_URL, bridgeAlive: true }, deps);
  assert.ok(!r.ok);
  assert.match(r.message, /disk full/);
});
