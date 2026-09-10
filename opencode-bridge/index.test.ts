/**
 * opencode-bridge index.ts 扩展测试：fake Pi 宿主 + fake BridgeDeps，不启动真实 Pi / helper。
 * 覆盖 session_start 与 /opencode-bridge 的注册、探测/拉起/失败路径与 hasUI 静默行为。
 * 运行:cd opencode-bridge && npm test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_NAME, type BridgeExtensionDeps, createOpencodeBridgeExtension, formatPortChangeConfirmMessage, formatRestoreConfirmMessage, formatStatusLines, formatSyncConfirmMessage } from "./index.ts";
import { BRIDGE_HOST, DEFAULT_BRIDGE_PORT, DEFAULT_SOCKS_HOST, DEFAULT_SOCKS_PORT, ProxySyncActions, bridgeConfigPath, type BridgeDeps, type ProxySyncDeps, type ShutdownBridgeResult } from "./bridge.ts";

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

test("formatStatusLines 输出状态/监听/上游/引导四行，指向 /opencode-bridge sync", () => {
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
  assert.match(lines[3]!, /opencode-bridge sync/);
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

// ===== 命令面统一：单命令 + 子命令路由（命令风格统一） =====

test("命令面统一：单 /opencode-bridge 命令（无参=状态，sync/restore 子命令，旧长命令不再注册）", async () => {
  const { pi, commands, notifications, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps });
  assert.deepEqual([...commands.keys()], [COMMAND_NAME], "only the unified command is registered");

  await commands.get(COMMAND_NAME)!.handler("", makeCtx());
  assert.match(notifications.at(-1)!.message, /状态: 运行中/);

  notifications.length = 0;
  await commands.get(COMMAND_NAME)!.handler("bogus", makeCtx());
  assert.match(notifications.at(-1)!.message, /未知子命令/);
  assert.match(notifications.at(-1)!.message, /\/opencode-bridge sync \[port\]/);
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
  assert.match(notifications[0]?.message ?? "", /opencode-bridge sync/);
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

// ===== /opencode-bridge sync：手动触发 + 人工确认 + 备份（v1.2.0） =====

function makeFakeProxySyncDeps(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(SETTINGS_PATH, initial);
  const norm = (p: string) => p.replace(/\\/g, "/");
  const deps: ProxySyncDeps = {
    readTextFile(path) {
      return files.get(norm(path));
    },
    writeTextFile(path, content) {
      files.set(norm(path), content);
    },
    listDir(dir) {
      const prefix = norm(dir).endsWith("/") ? norm(dir) : `${norm(dir)}/`;
      return [...files.keys()]
        .map(norm)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    },
  };
  return { deps, files };
}

test("单命令注册：sync/restore 为 /opencode-bridge 子命令，不再注册旧长命令", () => {
  const { pi, handlers, commands } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, now: () => new Date(0) });
  assert.ok(handlers.has("session_start"));
  assert.deepEqual([...commands.keys()], [COMMAND_NAME]);
});

test("session_start 桥已运行：不写任何文件、不读 settings.json（只读端口配置文件）", async () => {
  const { pi, handlers, notifications, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  let settingsRead = false;
  let settingsWritten = false;
  const sync: ProxySyncDeps = {
    readTextFile: (p) => {
      if (p === SETTINGS_PATH) settingsRead = true;
      return undefined;
    },
    writeTextFile: (p) => {
      if (p === SETTINGS_PATH || p.startsWith(`${SETTINGS_PATH}.bak`)) settingsWritten = true;
    },
    listDir: () => [],
  };
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  await handlers.get("session_start")!({}, makeCtx());
  assert.equal(settingsRead, false);
  assert.equal(settingsWritten, false);
  assert.equal(notifications.length, 0);
});

test("sync：桥活着且无 httpProxy → 弹确认；确认后写入并备份", async () => {
  const { pi, handlers, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
  const now = new Date(2026, 7, 5, 12, 0, 0);
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => now });

  // 在 makeCtx 基础上注入 confirm 的返回值并捕获弹窗内容（无参默认回车保持端口）
  const ctx = makeCtx();
  let confirmCalled = 0;
  let confirmCaptured: { title: string; message: string } | undefined;
  (ctx as unknown as { ui: Record<string, unknown> }).ui.input = async () => "";
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async (title: string, message: string) => {
    confirmCalled += 1;
    confirmCaptured = { title, message };
    return true;
  };

  await commands.get(COMMAND_NAME)!.handler("sync", ctx);
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
  (ctx as unknown as { ui: Record<string, unknown> }).ui.input = async () => "";
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => false;
  await commands.get(COMMAND_NAME)!.handler("sync", ctx);
  assert.equal(files.get(SETTINGS_PATH), '{"theme":"dark"}');
  assert.match(notifications[0]?.message ?? "", /已取消/);
});

test("sync：已有其它代理地址 → 不弹确认，提示不碰", async () => {
  const { pi, handlers, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps(JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.input = async () => "";
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => {
    throw new Error("不应弹确认框");
  };
  await commands.get(COMMAND_NAME)!.handler("sync", ctx);
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
  (ctx as unknown as { ui: Record<string, unknown> }).ui.input = async () => "";
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => true;
  await commands.get(COMMAND_NAME)!.handler("sync", ctx);
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
  await commands.get(COMMAND_NAME)!.handler("sync", makeCtx({ hasUI: false }));
  assert.equal(files.get(SETTINGS_PATH), "{}");
  assert.equal(notifications.length, 0);
});

test("sync：settings.json 解析失败 → error 提示，不弹框不改文件", async () => {
  const { pi, handlers, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps("{ not json");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.input = async () => "";
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => {
    throw new Error("不应弹确认框");
  };
  await commands.get(COMMAND_NAME)!.handler("sync", ctx);
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

// ===== /opencode-bridge restore：选择备份 + 确认 + 恢复前再备份（v1.3.0） =====

/** 往 fake fs 里放一个备份文件（供 listDir 枚举） */
function putBackup(files: Map<string, string>, stamp: string, content: string): void {
  files.set(`${SETTINGS_PATH}.bak-opencode-bridge-${stamp}`, content);
}

test("注册 /opencode-bridge restore 子命令（并入口令描述）", () => {
  const { pi, commands } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync } = makeFakeProxySyncDeps("{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  assert.deepEqual([...commands.keys()], [COMMAND_NAME]);
  assert.match(commands.get(COMMAND_NAME)?.description ?? "", /restore/);
});

test("restore：无备份 → warning 提示，不弹任何框", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"a":1}');
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  const ctx = makeCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.select = async () => {
    throw new Error("不应弹选择框");
  };
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => {
    throw new Error("不应弹确认框");
  };
  await commands.get(COMMAND_NAME)!.handler("restore", ctx);
  assert.equal(files.get(SETTINGS_PATH), '{"a":1}');
  assert.equal(notifications[0]?.type, "warning");
  assert.match(notifications[0]?.message ?? "", /没有可用的备份/);
});

test("restore：选择备份并确认 → settings 恢复为备份内容，当前配置先备份", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"httpProxy":"http://127.0.0.1:10899","theme":"dark"}');
  putBackup(files, "20260805-120001", '{"theme":"light"}');
  putBackup(files, "20260805-120002", '{"theme":"dark"}');
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(2026, 7, 5, 13, 0, 0) });
  const ctx = makeCtx();
  let selectedOptions: string[] = [];
  (ctx as unknown as { ui: Record<string, unknown> }).ui.select = async (_title: string, options: string[]) => {
    selectedOptions = options;
    return options[1]!; // 选第二个（更早的备份）
  };
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => true;
  await commands.get(COMMAND_NAME)!.handler("restore", ctx);
  // 选项按最新在前
  assert.match(selectedOptions[0] ?? "", /120002/);
  assert.match(selectedOptions[1] ?? "", /120001/);
  // settings = 所选备份内容
  assert.equal(files.get(SETTINGS_PATH), '{"theme":"light"}');
  // 恢复前当前配置已备份
  assert.match(files.get(`${SETTINGS_PATH}.bak-opencode-bridge-20260805-130000`) ?? "", /httpProxy/);
  assert.match(notifications[0]?.message ?? "", /已从 settings\.json\.bak-opencode-bridge-20260805-120001 恢复/);
  assert.match(notifications[0]?.message ?? "", /已备份到/);
  assert.equal(notifications[0]?.type, "info");
});

test("restore：选择框取消 → 不弹确认，settings 不变", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"a":1}');
  putBackup(files, "20260805-120001", "{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  const ctx = makeCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.select = async () => undefined;
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => {
    throw new Error("不应弹确认框");
  };
  await commands.get(COMMAND_NAME)!.handler("restore", ctx);
  assert.equal(files.get(SETTINGS_PATH), '{"a":1}');
  assert.match(notifications[0]?.message ?? "", /已取消/);
});

test("restore：确认框取消 → settings 不变", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"a":1}');
  putBackup(files, "20260805-120001", "{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  const ctx = makeCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.select = async (_t: string, o: string[]) => o[0]!;
  (ctx as unknown as { ui: Record<string, unknown> }).ui.confirm = async () => false;
  await commands.get(COMMAND_NAME)!.handler("restore", ctx);
  assert.equal(files.get(SETTINGS_PATH), '{"a":1}');
  assert.match(notifications[0]?.message ?? "", /已取消/);
});

test("restore：无 UI → 静默不改文件", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"a":1}');
  putBackup(files, "20260805-120001", "{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  await commands.get(COMMAND_NAME)!.handler("restore", makeCtx({ hasUI: false }));
  assert.equal(files.get(SETTINGS_PATH), '{"a":1}');
  assert.equal(notifications.length, 0);
});

test("formatRestoreConfirmMessage：三行文案含备份/再备份/重启提示", () => {
  const lines = formatRestoreConfirmMessage(
    "/fake/settings.json.bak-opencode-bridge-old",
    "/fake/settings.json",
    "/fake/settings.json.bak-opencode-bridge-new",
  ).split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /恢复为所选备份的内容/);
  assert.match(lines[1]!, /恢复操作本身可撤销/);
  assert.match(lines[2]!, /重启 Pi 后生效/);
});

// ===== 端口自定义 v1.4.0：状态来源 + sync 迁移（全 fake，不碰真实端口/文件） =====

const CONFIG_PATH = "/fake/opencode-bridge.json";
const OLD_PORT = 10899;
const NEW_PORT = 20900;
const NEW_PROXY = `http://${BRIDGE_HOST}:${NEW_PORT}`;

/** 端口迁移专用 fake：按端口返回 probe，shutdown 可注入，记录全部调用。 */
function makePortBridgeFake(options: {
  shutdown?: ShutdownBridgeResult;
  /** old 端口是否仍在监听（默认 false=已释放） */
  oldAlive?: boolean;
  /** new 端口首探是否已在监听（默认 false=需 spawn；true=直接复用） */
  newAliveFirst?: boolean;
  existingPaths?: string[];
} = {}) {
  const shutdownCalls: Array<{ host: string; port: number }> = [];
  const spawnCalls: Array<{ helperPath: string; env: Record<string, string | undefined> }> = [];
  const probeCalls: Array<{ host: string; port: number }> = [];
  let newProbed = 0;
  const deps: BridgeDeps = {
    async probe(_host, port) {
      probeCalls.push({ host: _host, port });
      if (port === OLD_PORT) return options.oldAlive ?? false;
      if (port === NEW_PORT) {
        newProbed += 1;
        if (options.newAliveFirst && newProbed === 1) return true;
        return newProbed === 1 ? false : true;
      }
      return false;
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
      return options.shutdown ?? { ok: true, body: "opencode-bridge shutting down\n" };
    },
  };
  return { deps, shutdownCalls, spawnCalls, probeCalls };
}

function setUi(ctx: unknown, ui: Record<string, unknown>): void {
  Object.assign((ctx as { ui: Record<string, unknown> }).ui, ui);
}

test("formatStatusLines 带来源时新增端口来源行，坏配置给出配置提示行", () => {
  const base = {
    bridgeHost: BRIDGE_HOST,
    bridgePort: OLD_PORT,
    socksHost: DEFAULT_SOCKS_HOST,
    socksPort: DEFAULT_SOCKS_PORT,
    proxyUrl: `http://${BRIDGE_HOST}:${OLD_PORT}`,
  };
  const withSource = formatStatusLines(base, true, "", "配置文件");
  assert.equal(withSource.length, 5);
  assert.match(withSource[3]!, /端口来源: 配置文件/);
  const withWarning = formatStatusLines(base, true, "", "默认值", "桥配置文件解析失败，已忽略");
  assert.equal(withWarning.length, 6);
  assert.match(withWarning[4]!, /配置提示/);
});

test("formatPortChangeConfirmMessage 列清写配置/停旧桥/起新桥/改 httpProxy 四件事", () => {
  const msg = formatPortChangeConfirmMessage(
    OLD_PORT,
    NEW_PORT,
    CONFIG_PATH,
    true,
    { action: ProxySyncActions.SET, proxyUrl: NEW_PROXY, message: "" },
    SETTINGS_PATH,
    "/fake/settings.json.bak-x",
  );
  assert.match(msg, /10899 → .*20900/);
  assert.match(msg, /写配置文件/);
  assert.match(msg, /停旧桥/);
  assert.match(msg, /起新桥/);
  assert.match(msg, /改 httpProxy.*20900/);
  assert.match(msg, /重启 Pi 后生效/);
});

test("sync 带参新端口：一次确认后迁移+写配置+httpProxy 指向新端口且备份链完整", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls, spawnCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(2026, 7, 5, 12, 0, 0) });
  const ctx = makeCtx();
  let confirmMsg = "";
  setUi(ctx, {
    input: async () => {
      throw new Error("带参不应询问端口");
    },
    confirm: async (_t: string, m: string) => {
      confirmMsg = m;
      return true;
    },
  });
  await commands.get(COMMAND_NAME)!.handler(`sync ${NEW_PORT}`, ctx);
  assert.match(confirmMsg, /写配置文件/);
  assert.match(confirmMsg, /停旧桥/);
  assert.match(confirmMsg, /起新桥/);
  assert.match(confirmMsg, /改 httpProxy/);
  assert.deepEqual(shutdownCalls, [{ host: BRIDGE_HOST, port: OLD_PORT }]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.env.PI_BRIDGE_PORT, String(NEW_PORT));
  assert.equal(JSON.parse(files.get(CONFIG_PATH)!).bridgePort, NEW_PORT);
  const saved = JSON.parse(files.get(SETTINGS_PATH)!);
  assert.equal(saved.httpProxy, NEW_PROXY);
  assert.equal(saved.theme, "dark");
  assert.equal(files.get("/fake/settings.json.bak-opencode-bridge-20260805-120000"), '{"theme":"dark"}');
  assert.match(notifications[0]?.message ?? "", new RegExp(NEW_PROXY.replace(/\//g, "\\/")));
  assert.equal(notifications[0]?.type, "info");
});

test("sync 带参非法端口直接警告退出，零落盘（不 shutdown、不写文件）", async () => {
  for (const bad of ["abc", "0", "70000", "1.5"]) {
    const { pi, notifications, commands, makeCtx } = makeFakePi();
    const { deps, shutdownCalls, spawnCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
    const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
    createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
    const ctx = makeCtx();
    setUi(ctx, {
      input: async () => {
        throw new Error("非法参数不应询问");
      },
      confirm: async () => {
        throw new Error("非法参数不应确认");
      },
    });
    const before = new Map(files);
    await commands.get(COMMAND_NAME)!.handler(`sync ${bad}`, ctx);
    assert.match(notifications[0]?.message ?? "", /端口无效/);
    assert.equal(notifications[0]?.type, "warning");
    assert.deepEqual(shutdownCalls, []);
    assert.deepEqual(spawnCalls, []);
    assert.deepEqual(files, before);
  }
});

test("sync 参数过多直接警告退出，零落盘", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps("{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  const ctx = makeCtx();
  setUi(ctx, { confirm: async () => {
    throw new Error("不应确认");
  } });
  await commands.get(COMMAND_NAME)!.handler("sync 20900 20901", ctx);
  assert.match(notifications[0]?.message ?? "", /参数过多/);
  assert.deepEqual(shutdownCalls, []);
  assert.equal(files.get(SETTINGS_PATH), "{}");
});

test("sync 无参 TUI 输入新端口：询问后迁移（placeholder 为当前端口）", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps("{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  let inputArgs: { title: string; placeholder?: string } | undefined;
  setUi(ctx, {
    input: async (title: string, placeholder?: string) => {
      inputArgs = { title, placeholder };
      return String(NEW_PORT);
    },
    confirm: async () => true,
  });
  await commands.get(COMMAND_NAME)!.handler("sync", ctx);
  assert.equal(inputArgs?.placeholder, String(OLD_PORT));
  assert.match(inputArgs?.title ?? "", /桥端口/);
  assert.deepEqual(shutdownCalls, [{ host: BRIDGE_HOST, port: OLD_PORT }]);
  assert.equal(JSON.parse(files.get(CONFIG_PATH)!).bridgePort, NEW_PORT);
  assert.match(notifications[0]?.message ?? "", /20900/);
});

test("sync 无参 TUI 回车保持：不迁移，走原 httpProxy 确认（不写配置文件）", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls, spawnCalls } = makePortBridgeFake({ oldAlive: true, existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  setUi(ctx, { input: async () => "", confirm: async () => true });
  await commands.get(COMMAND_NAME)!.handler("sync", ctx);
  assert.deepEqual(shutdownCalls, []);
  assert.equal(files.get(CONFIG_PATH), undefined);
  assert.equal(JSON.parse(files.get(SETTINGS_PATH)!).httpProxy, `http://${BRIDGE_HOST}:${OLD_PORT}`);
  assert.match(notifications[0]?.message ?? "", /已写入 httpProxy/);
});

test("sync 输入框取消：全 abort，零落盘", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls, spawnCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  const ctx = makeCtx();
  setUi(ctx, {
    input: async () => undefined,
    confirm: async () => {
      throw new Error("取消后不应确认");
    },
  });
  const before = new Map(files);
  await commands.get(COMMAND_NAME)!.handler("sync", ctx);
  assert.match(notifications[0]?.message ?? "", /已取消/);
  assert.deepEqual(shutdownCalls, []);
  assert.deepEqual(spawnCalls, []);
  assert.deepEqual(files, before);
});

test("sync 输入非法端口：警告退出，零落盘", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps("{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  const ctx = makeCtx();
  setUi(ctx, {
    input: async () => "abc",
    confirm: async () => {
      throw new Error("不应确认");
    },
  });
  await commands.get(COMMAND_NAME)!.handler("sync", ctx);
  assert.match(notifications[0]?.message ?? "", /端口无效/);
  assert.deepEqual(shutdownCalls, []);
  assert.equal(files.get(SETTINGS_PATH), "{}");
});

test("sync 指纹不符拒绝迁移并零落盘（不写配置/备份/settings）", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls, spawnCalls } = makePortBridgeFake({
    shutdown: { ok: true, body: "some other proxy" },
    existingPaths: [HELPER_PATH],
  });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  setUi(ctx, { confirm: async () => true });
  const before = new Map(files);
  await commands.get(COMMAND_NAME)!.handler(`sync ${NEW_PORT}`, ctx);
  assert.deepEqual(shutdownCalls, [{ host: BRIDGE_HOST, port: OLD_PORT }]);
  assert.deepEqual(spawnCalls, []);
  assert.deepEqual(files, before);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.message ?? "", /非本桥占用/);
});

test("sync 旧桥不释放超时 abort，零落盘", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, spawnCalls } = makePortBridgeFake({ oldAlive: true, existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps("{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  const ctx = makeCtx();
  setUi(ctx, { confirm: async () => true });
  const before = new Map(files);
  await commands.get(COMMAND_NAME)!.handler(`sync ${NEW_PORT}`, ctx);
  assert.deepEqual(spawnCalls, []);
  assert.deepEqual(files, before);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.message ?? "", /未释放/);
});

test("sync 确认拒绝零落盘（不 shutdown、不写文件）", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls, spawnCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  const ctx = makeCtx();
  setUi(ctx, { confirm: async () => false });
  const before = new Map(files);
  await commands.get(COMMAND_NAME)!.handler(`sync ${NEW_PORT}`, ctx);
  assert.deepEqual(shutdownCalls, []);
  assert.deepEqual(spawnCalls, []);
  assert.deepEqual(files, before);
  assert.match(notifications[0]?.message ?? "", /已取消/);
});

test("sync 迁移时已有外部代理：桥照切+配置照写，settings 不碰", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps(JSON.stringify({ httpProxy: "http://127.0.0.1:7890" }));
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const ctx = makeCtx();
  setUi(ctx, { confirm: async () => true });
  await commands.get(COMMAND_NAME)!.handler(`sync ${NEW_PORT}`, ctx);
  assert.equal(JSON.parse(files.get(CONFIG_PATH)!).bridgePort, NEW_PORT);
  assert.match(files.get(SETTINGS_PATH)!, /7890/);
  assert.equal(notifications[0]?.type, "warning");
  assert.match(notifications[0]?.message ?? "", /已切换到.*20900/);
});

test("sync 非 TUI 带参新端口：提示去 TUI，零落盘", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps("{}");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync });
  const before = new Map(files);
  await commands.get(COMMAND_NAME)!.handler(`sync ${NEW_PORT}`, makeCtx({ hasUI: false }));
  assert.deepEqual(shutdownCalls, []);
  assert.deepEqual(files, before);
  assert.equal(notifications.length, 0);
});

test("sync 配置文件坏值忽略回退：状态行提示一句，不阻断正常同步", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps } = makePortBridgeFake({ oldAlive: true, existingPaths: [HELPER_PATH] });
  const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
  files.set(CONFIG_PATH, "{ not json");
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, now: () => new Date(0) });
  const statusHandler = commands.get(COMMAND_NAME)!;
  const statusCtx = makeCtx();
  await statusHandler.handler("", statusCtx);
  assert.match(notifications[0]?.message ?? "", /端口来源: 默认值/);
  assert.match(notifications[0]?.message ?? "", /配置提示/);
  const syncCtx = makeCtx();
  setUi(syncCtx, { input: async () => "", confirm: async () => true });
  await commands.get(COMMAND_NAME)!.handler("sync", syncCtx);
  assert.equal(JSON.parse(files.get(SETTINGS_PATH)!).httpProxy, `http://${BRIDGE_HOST}:${OLD_PORT}`);
});

test("sync 配置文件端口生效：无环境变量时状态与同步都走配置文件端口", async () => {
  const { pi, notifications, commands, makeCtx } = makeFakePi();
  const { deps, shutdownCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH], newAliveFirst: true });
  const { deps: sync, files } = makeFakeProxySyncDeps("{}");
  files.set(CONFIG_PATH, '{"bridgePort": 20900}');
  createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, env: {}, now: () => new Date(0) });
  await commands.get(COMMAND_NAME)!.handler("", makeCtx());
  assert.match(notifications[0]?.message ?? "", /20900/);
  assert.match(notifications[0]?.message ?? "", /端口来源: 配置文件/);
  assert.deepEqual(shutdownCalls, []);
  const cfgPath = bridgeConfigPath(SETTINGS_PATH);
  assert.ok(cfgPath.endsWith("opencode-bridge.json"));
});

// ===== solo 审批门（docs/cross/solo-approval-gate.md） =====

/** 本进程 pid 的 solo 状态文件 + 注入给扩展的环境表（不碰真实 ~/.pi/agent） */
function makeSoloEnv(): { env: Record<string, string | undefined>; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-solo-"));
  const file = path.join(dir, "solo-mode.json");
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, activatedAt: "2026-08-05T12:00:00Z" }), "utf8");
  return {
    env: { PI_SOLO_MODE_FILE: file },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("solo：sync 不弹确认直接写入并备份", async () => {
  const { env, cleanup } = makeSoloEnv();
  try {
    const { pi, notifications, commands, makeCtx } = makeFakePi();
    const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
    const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
    createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, env, now: () => new Date(2026, 7, 5, 12, 0, 0) });
    const ctx = makeCtx();
    let confirmCalled = 0;
    setUi(ctx, {
      input: async () => "",
      confirm: async () => {
        confirmCalled += 1;
        return true;
      },
    });

    await commands.get(COMMAND_NAME)!.handler("sync", ctx);

    assert.equal(confirmCalled, 0, "solo 下不弹确认框");
    const saved = JSON.parse(files.get(SETTINGS_PATH)!);
    assert.equal(saved.httpProxy, `http://${BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`);
    assert.equal(saved.theme, "dark");
    assert.ok(notifications.some((n) => n.message.includes("solo") && n.type === "info"), "notify 明示 solo 自动批准");
    assert.match(notifications[0]?.message ?? "", /solo：已自动确认修改 settings\.json/);
  } finally {
    cleanup();
  }
});

test("solo：端口切换路径不弹确认，迁移+写配置+httpProxy 联动照常", async () => {
  const { env, cleanup } = makeSoloEnv();
  try {
    const { pi, commands, makeCtx } = makeFakePi();
    const { deps, shutdownCalls, spawnCalls } = makePortBridgeFake({ existingPaths: [HELPER_PATH] });
    const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
    createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, env, now: () => new Date(2026, 7, 5, 12, 0, 0) });
    const ctx = makeCtx();
    let confirmCalled = 0;
    setUi(ctx, {
      input: async () => {
        throw new Error("带参不应询问端口");
      },
      confirm: async () => {
        confirmCalled += 1;
        return true;
      },
    });

    await commands.get(COMMAND_NAME)!.handler(`sync ${NEW_PORT}`, ctx);

    assert.equal(confirmCalled, 0, "solo 下端口切换不弹确认框");
    assert.deepEqual(shutdownCalls, [{ host: BRIDGE_HOST, port: OLD_PORT }]);
    assert.equal(spawnCalls.length, 1);
    assert.equal(JSON.parse(files.get(CONFIG_PATH)!).bridgePort, NEW_PORT);
    assert.equal(JSON.parse(files.get(SETTINGS_PATH)!).httpProxy, NEW_PROXY);
  } finally {
    cleanup();
  }
});

test("solo：restore 自动选最新备份并跳过选择/确认", async () => {
  const { env, cleanup } = makeSoloEnv();
  try {
    const { pi, notifications, commands, makeCtx } = makeFakePi();
    const { deps } = makeFakeBridgeDeps({ probeSequence: [true] });
    const { deps: sync, files } = makeFakeProxySyncDeps('{"theme":"dark"}');
    putBackup(files, "20260805-120001", '{"theme":"light"}');
    putBackup(files, "20260805-120002", '{"theme":"solarized"}');
    createOpencodeBridgeExtension(pi as never, { ...BASE_DEPS, bridge: deps, proxySync: sync, env, now: () => new Date(2026, 7, 5, 13, 0, 0) });
    const ctx = makeCtx();
    let selectCalled = 0;
    let confirmCalled = 0;
    setUi(ctx, {
      select: async () => {
        selectCalled += 1;
        return undefined;
      },
      confirm: async () => {
        confirmCalled += 1;
        return true;
      },
    });

    await commands.get(COMMAND_NAME)!.handler("restore", ctx);

    assert.equal(selectCalled, 0, "solo 下不弹选择框");
    assert.equal(confirmCalled, 0, "solo 下不弹确认框");
    // 备份列表“最新在前”：自动选 20260805-120002
    assert.equal(files.get(SETTINGS_PATH), '{"theme":"solarized"}');
    assert.match(files.get(`${SETTINGS_PATH}.bak-opencode-bridge-20260805-130000`) ?? "", /theme/);
    assert.match(notifications[0]?.message ?? "", /solo：已自动选择最新备份/);
    assert.ok(notifications.some((n) => n.message.includes("solo：已自动确认恢复 settings.json")), "notify 明示自动确认恢复");
    const restored = notifications.find((n) => n.message.includes("已从"));
    assert.match(restored?.message ?? "", /20260805-120002/);
  } finally {
    cleanup();
  }
});
