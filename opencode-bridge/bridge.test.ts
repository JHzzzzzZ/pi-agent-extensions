/**
 * opencode-bridge bridge.ts 单测：配置解析 + ensureBridge 生命周期（全 fake 依赖，无网络/无子进程）。
 * 运行:cd opencode-bridge && npm test
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  BRIDGE_CONFIG_FILE_NAME,
  BRIDGE_HOST,
  BRIDGE_SHUTDOWN_MARKER,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_SOCKS_HOST,
  DEFAULT_SOCKS_PORT,
  EnsureErrorCodes,
  HELPER_FILE_NAME,
  MigrateErrorCodes,
  type BridgeDeps,
  type EnsureBridgeResult,
  type ShutdownBridgeResult,
  bridgeConfigPath,
  createDefaultBridgeDeps,
  ensureBridge,
  applyHttpProxySync,
  applyRestore,
  formatBridgePortConfig,
  isOwnBridgeShutdownBody,
  listHttpProxyBackups,
  makeBackupPath,
  migrateBridgePort,
  parseBridgeConfig,
  parsePortString,
  planHttpProxySync,
  ProxySyncActions,
  type ProxySyncDeps,
  readBridgePortConfig,
  resolveEffectivePort,
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
    listDir(dir) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
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
    listDir: () => [],
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
    listDir: () => [],
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

// ===== listHttpProxyBackups / applyRestore =====

test("listHttpProxyBackups：只列本扩展备份且最新在前", () => {
  const listed: string[] = [
    "settings.json.bak-opencode-bridge-20260805-120001",
    "settings.json.bak-opencode-bridge-20260805-120003",
    "settings.json.bak-opencode-bridge-20260805-120002",
    "settings.json", // 干扰项
    "other.json.bak-opencode-bridge-20260805-120004", // 干扰项
  ];
  const customDeps: ProxySyncDeps = {
    readTextFile: () => undefined,
    writeTextFile: () => undefined,
    listDir: () => listed,
  };
  const r = listHttpProxyBackups(SETTINGS_PATH, customDeps);
  assert.deepEqual(r, [
    path.join(path.dirname(SETTINGS_PATH), "settings.json.bak-opencode-bridge-20260805-120003"),
    path.join(path.dirname(SETTINGS_PATH), "settings.json.bak-opencode-bridge-20260805-120002"),
    path.join(path.dirname(SETTINGS_PATH), "settings.json.bak-opencode-bridge-20260805-120001"),
  ]);
});

test("listHttpProxyBackups：目录不存在返回空", () => {
  const deps: ProxySyncDeps = {
    readTextFile: () => undefined,
    writeTextFile: () => undefined,
    listDir: () => {
      throw new Error("enoent");
    },
  };
  assert.deepEqual(listHttpProxyBackups(SETTINGS_PATH, deps), []);
});

test("applyRestore：settings 替换为备份内容，当前配置先备份", () => {
  const files = new Map<string, string>();
  files.set(SETTINGS_PATH, '{"httpProxy":"http://127.0.0.1:10899"}');
  files.set("/fake/settings.json.bak-old", '{"theme":"dark"}');
  const writeCalls: Array<{ path: string; content: string }> = [];
  const deps: ProxySyncDeps = {
    readTextFile: (p) => files.get(p),
    writeTextFile: (p, c) => {
      writeCalls.push({ path: p, content: c });
      files.set(p, c);
    },
    listDir: () => [],
  };
  const r = applyRestore(
    { backupPath: "/fake/settings.json.bak-old", settingsPath: SETTINGS_PATH, currentBackupPath: "/fake/settings.json.bak-restore" },
    deps,
  );
  assert.ok(r.ok);
  // 第一笔写是当前配置的备份
  assert.equal(writeCalls[0]?.path, "/fake/settings.json.bak-restore");
  assert.equal(writeCalls[0]?.content, '{"httpProxy":"http://127.0.0.1:10899"}');
  // settings = 备份内容
  assert.equal(files.get(SETTINGS_PATH), '{"theme":"dark"}');
  assert.match(r.message, /恢复 settings\.json/);
  assert.match(r.message, /重启/);
});

test("applyRestore：备份不存在 → 拒绝且不动 settings", () => {
  const files = new Map<string, string>([[SETTINGS_PATH, '{"a":1}']]);
  const deps: ProxySyncDeps = {
    readTextFile: (p) => files.get(p),
    writeTextFile: (p, c) => files.set(p, c),
    listDir: () => [],
  };
  const r = applyRestore(
    { backupPath: "/fake/no-such-backup", settingsPath: SETTINGS_PATH, currentBackupPath: "/fake/settings.json.bak-restore" },
    deps,
  );
  assert.ok(!r.ok);
  assert.match(r.message, /不存在或不可读/);
  assert.equal(files.get(SETTINGS_PATH), '{"a":1}');
});

test("applyRestore：当前配置备份失败 → 拒绝恢复", () => {
  const files = new Map<string, string>();
  files.set(SETTINGS_PATH, '{"a":1}');
  files.set("/fake/settings.json.bak-old", "{}");
  const deps: ProxySyncDeps = {
    readTextFile: (p) => files.get(p),
    writeTextFile: (p, c) => {
      if (p === "/fake/settings.json.bak-restore") throw new Error("disk full");
      files.set(p, c);
    },
    listDir: () => [],
  };
  const r = applyRestore(
    { backupPath: "/fake/settings.json.bak-old", settingsPath: SETTINGS_PATH, currentBackupPath: "/fake/settings.json.bak-restore" },
    deps,
  );
  assert.ok(!r.ok);
  assert.match(r.message, /备份失败/);
  assert.equal(files.get(SETTINGS_PATH), '{"a":1}');
});

test("applyRestore：settings.json 当前不存在 → 无恢复前备份仍可恢复", () => {
  const files = new Map<string, string>([["/fake/settings.json.bak-old", '{"theme":"dark"}']]);
  const deps: ProxySyncDeps = {
    readTextFile: (p) => files.get(p),
    writeTextFile: (p, c) => files.set(p, c),
    listDir: () => [],
  };
  const r = applyRestore(
    { backupPath: "/fake/settings.json.bak-old", settingsPath: SETTINGS_PATH, currentBackupPath: "/fake/settings.json.bak-restore" },
    deps,
  );
  assert.ok(r.ok);
  assert.equal(r.currentBackupPath, undefined);
  assert.equal(files.get(SETTINGS_PATH), '{"theme":"dark"}');
});

// ===== 端口自定义 v1.4.0：parsePortString / bridgeConfigPath / format =====

test("parsePortString 合法端口通过，前后空格容忍", () => {
  assert.deepEqual(parsePortString("20900"), { ok: true, value: 20900 });
  assert.deepEqual(parsePortString("  1  "), { ok: true, value: 1 });
  assert.deepEqual(parsePortString("65535"), { ok: true, value: 65535 });
});

test("parsePortString 非法端口拒绝（非整数/越界/空）", () => {
  for (const bad of ["abc", "0", "70000", "10899.5", "", "  ", "-1", "12a"]) {
    const r = parsePortString(bad);
    assert.equal(r.ok, false, `端口 ${JSON.stringify(bad)} 应被拒绝`);
    if (!r.ok) assert.match(r.message, /1-65535/);
  }
});

test("bridgeConfigPath 为 settings.json 同目录 opencode-bridge.json", () => {
  assert.equal(bridgeConfigPath(SETTINGS_PATH), path.join(path.dirname(SETTINGS_PATH), BRIDGE_CONFIG_FILE_NAME));
  assert.match(bridgeConfigPath("/a/b/settings.json"), /opencode-bridge\.json$/);
});

test("formatBridgePortConfig 仅含 bridgePort 字段", () => {
  assert.deepEqual(JSON.parse(formatBridgePortConfig(20900)), { bridgePort: 20900 });
});

// ===== readBridgePortConfig：坏值忽略回退 =====

function makeConfigDeps(files: Map<string, string>): ProxySyncDeps {
  return {
    readTextFile: (p) => files.get(p),
    writeTextFile: (p, c) => files.set(p, c),
    listDir: () => [],
  };
}

test("readBridgePortConfig 缺失/空文件静默回退（无 warning）", () => {
  assert.deepEqual(readBridgePortConfig(SETTINGS_PATH, makeConfigDeps(new Map())), {});
  const cfgPath = bridgeConfigPath(SETTINGS_PATH);
  assert.deepEqual(readBridgePortConfig(SETTINGS_PATH, makeConfigDeps(new Map([[cfgPath, "   "]]))), {});
});

test("readBridgePortConfig 合法端口读取成功", () => {
  const cfgPath = bridgeConfigPath(SETTINGS_PATH);
  assert.deepEqual(readBridgePortConfig(SETTINGS_PATH, makeConfigDeps(new Map([[cfgPath, '{"bridgePort": 20900}']]))), { port: 20900 });
});

test("readBridgePortConfig JSON 坏/根不是对象/端口非法一律忽略并 warning", () => {
  const cfgPath = bridgeConfigPath(SETTINGS_PATH);
  for (const bad of ['{ not json', '[]', '"str"', '{"bridgePort": "20900"}', '{"bridgePort": 0}', '{"bridgePort": 70000}', '{"bridgePort": 1.5}']) {
    const r = readBridgePortConfig(SETTINGS_PATH, makeConfigDeps(new Map([[cfgPath, bad]])));
    assert.equal(r.port, undefined, `坏值 ${bad} 不应给出端口`);
    assert.ok(r.warning, `坏值 ${bad} 应有 warning`);
  }
  const noField = readBridgePortConfig(SETTINGS_PATH, makeConfigDeps(new Map([[cfgPath, '{"other": 1}']])));
  assert.equal(noField.port, undefined);
  assert.equal(noField.warning, undefined);
});

// ===== resolveEffectivePort：参数 > 环境变量 > 配置文件 > 默认值 =====

test("resolveEffectivePort 默认值 10899（无任何来源）", () => {
  const r = resolveEffectivePort({ env: {} });
  assert.ok(r.ok && r.port === DEFAULT_BRIDGE_PORT && r.source === "默认值");
});

test("resolveEffectivePort 配置文件来源", () => {
  const r = resolveEffectivePort({ env: {}, configPort: 20900 });
  assert.ok(r.ok && r.port === 20900 && r.source === "配置文件");
});

test("resolveEffectivePort 环境变量覆盖配置文件", () => {
  const r = resolveEffectivePort({ env: { PI_BRIDGE_PORT: "20800" }, configPort: 20900 });
  assert.ok(r.ok && r.port === 20800 && r.source === "环境变量");
});

test("resolveEffectivePort 参数覆盖环境变量与配置文件", () => {
  const r = resolveEffectivePort({ cliPort: 20700, env: { PI_BRIDGE_PORT: "20800" }, configPort: 20900 });
  assert.ok(r.ok && r.port === 20700 && r.source === "命令行");
});

test("resolveEffectivePort 环境变量空串视为未设置，回退配置文件", () => {
  const r = resolveEffectivePort({ env: { PI_BRIDGE_PORT: "" }, configPort: 20900 });
  assert.ok(r.ok && r.port === 20900 && r.source === "配置文件");
});

test("resolveEffectivePort 环境变量非法返回 ok:false（fail-closed）", () => {
  const r = resolveEffectivePort({ env: { PI_BRIDGE_PORT: "abc" }, configPort: 20900 });
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.message, /PI_BRIDGE_PORT/);
});

test("resolveEffectivePort 参数非法返回 ok:false，且参数无视非法环境变量", () => {
  const bad = resolveEffectivePort({ cliPort: 0, env: {} });
  assert.ok(!bad.ok);
  const win = resolveEffectivePort({ cliPort: 20700, env: { PI_BRIDGE_PORT: "abc" }, configPort: 20900 });
  assert.ok(win.ok && win.port === 20700 && win.source === "命令行");
});

test("isOwnBridgeShutdownBody 含标记才算自家桥", () => {
  assert.equal(isOwnBridgeShutdownBody(`xxx ${BRIDGE_SHUTDOWN_MARKER} yyy`), true);
  assert.equal(isOwnBridgeShutdownBody("opencode-bridge shutting down\n"), true);
  assert.equal(isOwnBridgeShutdownBody("hello world"), false);
  assert.equal(isOwnBridgeShutdownBody(""), false);
});

// ===== migrateBridgePort（全 fake，不碰真实端口） =====

interface MigrateFakeOptions {
  shutdown?: ShutdownBridgeResult;
  shutdownThrows?: Error;
  /** 按端口返回 probe 结果 */
  probeByPort?: (host: string, port: number) => boolean;
  existingPaths?: string[];
}

function makeMigrateFake(options: MigrateFakeOptions = {}) {
  const shutdownCalls: Array<{ host: string; port: number }> = [];
  const probeCalls: Array<{ host: string; port: number }> = [];
  const spawnCalls: Array<{ helperPath: string; env: Record<string, string | undefined> }> = [];
  const deps: BridgeDeps = {
    async probe(host, port) {
      probeCalls.push({ host, port });
      return options.probeByPort?.(host, port) ?? false;
    },
    fileExists: (p) => options.existingPaths?.includes(p) ?? false,
    spawnDetached: (_node, helperPath, env) => {
      spawnCalls.push({ helperPath, env });
    },
    async sleep() {
      /* 立即返回 */
    },
    async shutdownBridge(host, port) {
      shutdownCalls.push({ host, port });
      if (options.shutdownThrows) throw options.shutdownThrows;
      return options.shutdown ?? { ok: true, body: "opencode-bridge shutting down\n" };
    },
  };
  return { deps, shutdownCalls, probeCalls, spawnCalls };
}

const OLD_PORT = 10899;
const NEW_PORT = 20900;
const MIGRATE_NEW_CONFIG = {
  bridgeHost: BRIDGE_HOST,
  bridgePort: NEW_PORT,
  socksHost: "127.0.0.1",
  socksPort: 18808,
  proxyUrl: `http://${BRIDGE_HOST}:${NEW_PORT}`,
};
const MIGRATE_BASE = { host: BRIDGE_HOST, oldPort: OLD_PORT, newConfig: MIGRATE_NEW_CONFIG, helperPaths: [HELPER_PATH], execPath: "/node" };

test("migrateBridgePort 新旧相同直接成功，不发 shutdown、不 spawn", async () => {
  const { deps, shutdownCalls, spawnCalls } = makeMigrateFake();
  const r = await migrateBridgePort({ ...MIGRATE_BASE, oldPort: NEW_PORT }, deps);
  assert.ok(r.ok);
  assert.equal(shutdownCalls.length, 0);
  assert.equal(spawnCalls.length, 0);
});

test("migrateBridgePort shutdown 失败返回 SHUTDOWN_FAILED 且不 spawn", async () => {
  const { deps, spawnCalls } = makeMigrateFake({ shutdown: { ok: false, message: "conn refused" } });
  const r = await migrateBridgePort(MIGRATE_BASE, deps);
  assert.ok(!r.ok && r.code === MigrateErrorCodes.SHUTDOWN_FAILED);
  assert.match(r.message, /手动释放/);
  assert.equal(spawnCalls.length, 0);
});

test("migrateBridgePort 指纹不符拒绝迁移（FOREIGN_BRIDGE）且不 spawn", async () => {
  const { deps, spawnCalls } = makeMigrateFake({ shutdown: { ok: true, body: "some other proxy" } });
  const r = await migrateBridgePort(MIGRATE_BASE, deps);
  assert.ok(!r.ok && r.code === MigrateErrorCodes.FOREIGN_BRIDGE);
  assert.match(r.message, /手动释放/);
  assert.equal(spawnCalls.length, 0);
});

test("migrateBridgePort 旧端口不释放超时 abort（RELEASE_TIMEOUT）", async () => {
  const { deps, spawnCalls } = makeMigrateFake({
    shutdown: { ok: true, body: "opencode-bridge shutting down" },
    probeByPort: ( _host, port) => (port === OLD_PORT ? true : false),
    existingPaths: [HELPER_PATH],
  });
  const r = await migrateBridgePort({ ...MIGRATE_BASE, releaseAttempts: 3, releaseDelayMs: 0 }, deps);
  assert.ok(!r.ok && r.code === MigrateErrorCodes.RELEASE_TIMEOUT);
  assert.equal(spawnCalls.length, 0);
});

test("migrateBridgePort 新桥 helper 缺失返回 ENSURE_FAILED", async () => {
  const { deps } = makeMigrateFake({
    shutdown: { ok: true, body: "opencode-bridge shutting down" },
    probeByPort: ( _host, port) => false,
  });
  const r = await migrateBridgePort(MIGRATE_BASE, deps);
  assert.ok(!r.ok && r.code === MigrateErrorCodes.ENSURE_FAILED);
});

test("migrateBridgePort 成功：停旧桥→等释放→起新桥（PI_BRIDGE_PORT 透传新端口）", async () => {
  let newProbes = 0;
  const { deps, shutdownCalls, spawnCalls } = makeMigrateFake({
    shutdown: { ok: true, body: "opencode-bridge shutting down\n" },
    probeByPort: (_host, port) => {
      if (port === OLD_PORT) return false;
      newProbes += 1;
      return newProbes === 1 ? false : true;
    },
    existingPaths: [HELPER_PATH],
  });
  const r = await migrateBridgePort({ ...MIGRATE_BASE, releaseAttempts: 2, releaseDelayMs: 0 }, deps);
  assert.ok(r.ok);
  assert.deepEqual(shutdownCalls[0], { host: BRIDGE_HOST, port: OLD_PORT });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.env.PI_BRIDGE_PORT, String(NEW_PORT));
});

test("createDefaultBridgeDeps 提供 shutdownBridge（仅 127.0.0.1）", async () => {
  const deps = createDefaultBridgeDeps();
  assert.equal(typeof deps.shutdownBridge, "function");
  const foreign = await deps.shutdownBridge!("192.168.1.1", 10899, 50);
  assert.ok(!foreign.ok);
  assert.match(foreign.message, /非本地/);
});
