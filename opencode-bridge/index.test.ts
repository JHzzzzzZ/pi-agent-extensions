/**
 * opencode-bridge index.ts 扩展测试：fake Pi 宿主 + fake BridgeDeps，不启动真实 Pi / helper。
 * 覆盖 session_start 与 /opencode-bridge 的注册、探测/拉起/失败路径与 hasUI 静默行为。
 * 运行:cd opencode-bridge && npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_NAME, SYNC_COMMAND_NAME, type BridgeExtensionDeps, createOpencodeBridgeExtension, formatStatusLines, formatSyncConfirmMessage } from "./index.ts";
import { DEFAULT_BRIDGE_PORT, DEFAULT_SOCKS_HOST, DEFAULT_SOCKS_PORT, ProxySyncActions, type BridgeDeps, type ProxySyncDeps } from "./bridge.ts";

// ===== fake:pi 宿主（对齐 goal/index.test.ts 的手写 fake 风格） =====

interface Notification {
  message: string;
  type?: string;
}

function makeFakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notifications: Notification[] = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options);
    },
  };
  const makeCtx = (overrides: Record<string, unknown> = {}): ExtensionContext =>
    ({
      hasUI: true,
      ui: {
        notify: (message: string, type?: string) => {
          notifications.push({ message, type });
        },
      },
      ...overrides,
    }) as unknown as ExtensionContext;
  return { pi, handlers, commands, notifications, makeCtx };
}

// ===== fake:桥依赖 =====

interface FakeBridgeOptions {
  /** probe 序列（同 bridge.test.ts 语义） */
  probeSequence?: boolean[];
  existingPaths?: string[];
}

function makeFakeBridgeDeps(options: FakeBridgeOptions = {}) {
  const probeCalls: Array<{ host: string; port: number }> = [];
  const spawnCalls: Array<{ nodePath: string; helperPath: string; env: Record<string, string | undefined> }> = [];
  let probeIndex = 0;
  const deps: BridgeDeps = {
    async probe(host, port) {
      probeCalls.push({ host, port });
      const seq = options.probeSequence ?? [];
      const ok = seq[Math.min(probeIndex, Math.max(seq.length - 1, 0))] ?? false;
      probeIndex += 1;
      return ok;
    },
    fileExists(path) {
      return options.existingPaths?.includes(path) ?? false;
    },
    spawnDetached(nodePath, helperPath, env) {
      spawnCalls.push({ nodePath, helperPath, env });
    },
    async sleep() {
      /* 立即返回，测试不等待 */
    },
  };
  return { deps, probeCalls, spawnCalls };
}

const HELPER_PATH = "/fake/opencode-bridge-helper.mjs";
const SETTINGS_PATH = "/fake/settings.json";
// 原有测试只测桥本身（扩展不再自动改 settings）；同步行为在后面的专项测试里覆盖
const BASE_DEPS: BridgeExtensionDeps = {
  helperPaths: [HELPER_PATH],
  env: {},
  settingsPath: SETTINGS_PATH,
  now: () => new Date(0),
};

// ===== formatStatusLines（纯函数） =====

test("formatStatusLines 输出状态/监听/上游/引导四行，指向 /opencode-bridge-sync", () => {
  const lines = formatStatusLines(
    {
      bridgeHost: "127.0.0.1",
      bridgePort: DEFAULT_BRIDGE_PORT,
      socksHost: DEFAULT_SOCKS_HOST,
      socksPort: DEFAULT_SOCKS_PORT,
      proxyUrl: `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`,
    },
    true,
    "",
  );
  assert.equal(lines.length, 4);
  assert.match(lines[0], /运行中/);
  assert.match(lines[1]!, /http:\/\/127\.0\.0\.1:10899/);
  assert.match(lines[2]!, /socks5:\/\/127\.0\.0\.1:10808/);
  assert.match(lines[3]!, /opencode-bridge-sync/);
  assert.match(lines[3]!, /人工确认/);
  assert.match(lines[3]!, /备份/);
});

// ===== 注册 =====

test("createOpencodeBridgeExtension 注册 session_start 与 /opencode-bridge 命令", () => {
  const { pi, handlers, commands } = makeFakePi();
  createOpencodeBridgeExtension(pi as never, BASE_DEPS);
  assert.ok(handlers.has("session_start"));
  assert.ok(commands.has(COMMAND_NAME));
  assert.match(commands.get(COMMAND_NAME)?.description ?? "", /代理桥/);
});

// ===== session_start =====

test("session_start 桥已运行：不 spawn、不通知", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps, spawnCalls } = makeFakeBridgeDeps({ probeSequence: [true] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps });
  const handler = handlers.get("session_start")!;
  await handler({}, makeCtx());
  assert.equal(spawnCalls.length, 0);
  assert.equal(notifications.length, 0);
});

test("session_start 拉起成功：spawn helper 且不通知", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps, spawnCalls } = makeFakeBridgeDeps({ probeSequence: [false, false, true], existingPaths: [HELPER_PATH] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps });
  await handlers.get("session_start")!({}, makeCtx());
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.env.PI_BRIDGE_PORT, "10899");
  assert.equal(notifications.length, 0);
});

test("session_start 拉起失败：hasUI 时 error 通知（含错误信息）", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps, spawnCalls } = makeFakeBridgeDeps({ probeSequence: [false, false, false, false], existingPaths: [HELPER_PATH] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps });
  await handlers.get("session_start")!({}, makeCtx());
  assert.equal(spawnCalls.length, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.message ?? "", /opencode-bridge/);
});

test("session_start 拉起失败：无 UI 时静默（不调 notify）", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [false, false, false, false] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps });
  await handlers.get("session_start")!({}, makeCtx({ hasUI: false }));
  assert.equal(notifications.length, 0);
});

test("session_start 环境变量非法：静态错误提示，不 spawn", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps, spawnCalls } = makeFakeBridgeDeps({ probeSequence: [true] });
  createOpencodeBridgeExtension(pi as never, {
    ...BASE_DEPS,
    bridge: deps,
    env: { PI_BRIDGE_PORT: "999999" },
  });
  await handlers.get("session_start")!({}, makeCtx());
  assert.equal(spawnCalls.length, 0);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.message ?? "", /PI_BRIDGE_PORT/);
});

test("session_start 内部异常被吞掉：只 warning 通知，不向上抛", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const throwingDeps: BridgeDeps = {
    probe: () => {
      throw new Error("probe exploded");
    },
    fileExists: () => false,
    spawnDetached: () => undefined,
    sleep: async () => undefined,
  };
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: throwingDeps });
  await handlers.get("session_start")!({}, makeCtx());
  assert.equal(notifications[0]?.type, "warning");
  assert.match(notifications[0]?.message ?? "", /probe exploded/);
});

// ===== /opencode-bridge 命令 =====

test("命令：桥已运行时展示状态，不 spawn", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps, spawnCalls } = makeFakeBridgeDeps({ probeSequence: [true] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps });
  await commands.get(COMMAND_NAME)!.handler("", makeCtx());
  assert.equal(spawnCalls.length, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /状态: 运行中/);
  assert.match(notifications[0]?.message ?? "", /opencode-bridge-sync/);
  assert.equal(notifications[0]?.type, "info");
});

test("命令：桥未运行但拉起成功时标注（已自动启动）", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps, spawnCalls } = makeFakeBridgeDeps({ probeSequence: [false, false, true], existingPaths: [HELPER_PATH] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps });
  await commands.get(COMMAND_NAME)!.handler("", makeCtx());
  assert.equal(spawnCalls.length, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /运行中（已自动启动）/);
});

test("命令：拉起失败时展示（启动失败：…）并给出 warning", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [false, false, false, false], existingPaths: [HELPER_PATH] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps });
  await commands.get(COMMAND_NAME)!.handler("", makeCtx());
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "warning");
  assert.match(notifications[0]?.message ?? "", /未运行（启动失败：/);
});

test("命令：无 UI 时静默（不调 notify）", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps });
  await commands.get(COMMAND_NAME)!.handler("", makeCtx({ hasUI: false }));
  assert.equal(notifications.length, 0);
});

test("命令：配置非法时提示变量名，不 spawn", async () => {
  const { pi, handlers, commands, notifications, makeCtx } = makeFakePi();
  const { deps, spawnCalls } = makeFakeBridgeDeps({ probeSequence: [true] });
  createOpencodeBridgeExtension(pi as never, {
    ...BASE_DEPS,
    bridge: deps,
    env: { PI_BRIDGE_SOCKS_PORT: "abc" },
  });
  await commands.get(COMMAND_NAME)!.handler("", makeCtx());
  assert.equal(spawnCalls.length, 0);
  assert.match(notifications[0]?.message ?? "", /PI_BRIDGE_SOCKS_PORT/);
});

// ===== /opencode-bridge-sync：手动触发 + 人工确认 + 备份（v1.2.0） =====

function makeFakeProxySyncDeps(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(SETTINGS_PATH, initial);
  const deps: ProxySyncDeps = {
    readTextFile(path) {
      return files.get(path);
    },
    writeTextFile(path, content) {
      files.set(path, content);
    },
  };
  return { deps, files };
}

test("注册 /opencode-bridge-sync 命令，/opencode-bridge 不再自动改 settings", () => {
  const { pi, handlers, commands } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, now: () => new Date(0) });
  assert.ok(handlers.has("session_start"));
  assert.ok(commands.has(COMMAND_NAME));
  assert.ok(commands.has(SYNC_COMMAND_NAME));
});

test("session_start 桥已运行：完全不读写 settings.json", async () => {
  const { pi, handlers, notifications, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  let readCalled = false;
  const sync: ProxySyncDeps = {
    readTextFile: () => {
      readCalled = true;
      return undefined;
    },
    writeTextFile: () => undefined,
  };
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  await handlers.get("session_start")!({}, makeCtx());
  assert.equal(readCalled, false);
  assert.equal(notifications.length, 0);
});

test("sync：桥活着且无 httpProxy → 弹确认；确认后写入并备份", async () => {
  const { pi, handlers, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
  const now = new Date(2026, 7, 5, 12, 0, 0);
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => now });

  // 在 makeCtx 基础上注入 confirm 的返回值并捕获弹窗内容
  const ctx = makeCtx();
  let confirmCalled = 0;
  let confirmCaptured: { title: string; message: string } | undefined;
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async (title: string, message: string) => {
    confirmCalled += 1;
    confirmCaptured = { title, message };
    return true;
  };

  await commands.get(SYNC_COMMAND_NAME)!.handler("", ctx);
  assert.equal(confirmCalled, 1);
  assert.match(confirmCaptured?.title ?? "", /修改 settings\.json/);
  assert.match(confirmCaptured?.message ?? "", /httpProxy: http:\/\/127\.0\.0\.1:10899/);
  assert.match(confirmCaptured?.message ?? "", /备份/);
  assert.match(confirmCaptured?.message ?? "", /settings\.json\.bak-opencode-bridge-20260805-120000/);
  const saved = JSON.parse(files.get(SETTINGS_PATH)!);
  assert.equal(saved.httpProxy, "http://127.0.0.1:10899");
  assert.equal(saved.theme, "dark");
  // 备份内容 = 原文
  assert.match(notifications[0]?.message ?? "", /已写入 httpProxy/);
  assert.match(notifications[0]?.message ?? "", /settings\.json\.bak-opencode-bridge-20260805-120000/);
  assert.equal(notifications[0]?.type, "info");
});

test("sync：用户取消 → settings 不变", async () => {
  const { pi, handlers, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => false;
  await commands.get(SYNC_COMMAND_NAME)!.handler("", ctx);
  assert.equal(files.get(SETTINGS_PATH), '{"theme":"dark"}');
  assert.match(notifications[0]?.message ?? "", /已取消/);
});

test("sync：已有其它代理地址 → 不弹确认，提示不碰", async () => {
  const { pi, handlers, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps(JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => {
    throw new Error("不应弹确认框");
  };
  await commands.get(SYNC_COMMAND_NAME)!.handler("", ctx);
  assert.match(files.get(SETTINGS_PATH)!, /7890/);
  assert.equal(notifications[0]?.type, "warning");
  assert.match(notifications[0]?.message ?? "", /未改动/);
});

test("sync：桥死了且原值指向本桥 → 弹确认提议移除；确认后移除并备份", async () => {
  const { pi, handlers, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [false, false, false, false], existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps(JSON.stringify({ theme: "dark", httpProxy: "http://127.0.0.1:10899" }));
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => true;
  await commands.get(SYNC_COMMAND_NAME)!.handler("", ctx);
  const saved = JSON.parse(files.get(SETTINGS_PATH)!);
  assert.equal(saved.httpProxy, undefined);
  assert.equal(saved.theme, "dark");
  assert.match(notifications[0]?.message ?? "", /已移除 httpProxy/);
  assert.match(notifications[0]?.message ?? "", /备份/);
});

test("sync：无 UI（-p / JSON 模式）→ 静默不改文件（notify 本身有 hasUI 守卫）", async () => {
  const { pi, handlers, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps("{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  await commands.get(SYNC_COMMAND_NAME)!.handler("", makeCtx({ hasUI: false }));
  assert.equal(files.get(SETTINGS_PATH), "{}");
  assert.equal(notifications.length, 0);
});

test("sync：settings.json 解析失败 → error 提示，不弹框不改文件", async () => {
  const { pi, handlers, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps("{ not json");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => {
    throw new Error("不应弹确认框");
  };
  await commands.get(SYNC_COMMAND_NAME)!.handler("", ctx);
  assert.equal(files.get(SETTINGS_PATH), "{ not json");
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.message ?? "", /解析失败/);
});

test("formatSyncConfirmMessage：四行文案含动作/仅改字段/备份路径/重启提示", () => {
  const lines = formatSyncConfirmMessage(
    { action: ProxySyncActions.SET, proxyUrl: "http://127.0.0.1:10899", message: "" },
    "/fake/settings.json",
    "/fake/settings.json.bak-opencode-bridge-x",
  ).split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /写入 httpProxy: http:\/\/127\.0\.0\.1:10899/);
  assert.match(lines[1]!, /仅改动 httpProxy 字段/);
  assert.match(lines[2]!, /备份到/);
  assert.match(lines[3]!, /重启 Pi 后生效/);
});
