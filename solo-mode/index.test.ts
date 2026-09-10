/**
 * solo-mode 扩展测试:node:test + assert/strict,全部手写 fake（pi 宿主 / UI / 时钟）,
 * 状态文件走临时目录 + PI_SOLO_MODE_FILE 覆盖,不碰真实 ~/.pi/agent。
 * 运行:node --experimental-strip-types --test solo-mode/index.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SOLO_STATUS_KEY,
  SOLO_STATUS_TEXT,
  clearSoloState,
  createSoloModeExtension,
  isSoloActive,
  parseSoloCommand,
  readSoloState,
  resolveSoloStatePath,
  writeSoloState,
} from "./index.ts";

// ===== fake =====

interface Notification {
  message: string;
  type?: string;
}

interface StatusCall {
  key: string;
  text?: string;
}

function makeFakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, options);
    },
  };
  return { pi, handlers, commands };
}

interface FakeCtxOptions {
  hasUI?: boolean;
  confirm?: (title: string, message?: string) => Promise<boolean>;
}

function makeFakeCtx(options: FakeCtxOptions = {}) {
  const notifications: Notification[] = [];
  const statuses: StatusCall[] = [];
  const confirms: Array<{ title: string; message?: string }> = [];
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      confirm: async (title: string, message?: string) => {
        confirms.push({ title, message });
        return options.confirm ? await options.confirm(title, message) : true;
      },
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      setStatus: (key: string, text?: string) => {
        statuses.push({ key, text });
      },
    },
  };
  return { ctx, notifications, statuses, confirms };
}

function makeTempStateFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solo-mode-"));
  return { dir, file: path.join(dir, "solo-mode.json") };
}

function boot(options: FakeCtxOptions & { statePath: string; pid?: number } = { statePath: "" }) {
  const fake = makeFakePi();
  const env = { PI_SOLO_MODE_FILE: options.statePath };
  const pid = options.pid ?? process.pid;
  createSoloModeExtension(fake.pi as unknown as ExtensionAPI, {
    env,
    pid,
    nowIso: () => "2026-08-05T12:00:00.000Z",
  });
  const ctx = makeFakeCtx(options);
  return { ...fake, ...ctx, env, pid };
}

// ===== 纯函数:命令解析 / 路径 =====

test("parseSoloCommand：空参＝切换，其余（含旧管理词）＝usage", () => {
  assert.equal(parseSoloCommand(""), "toggle");
  assert.equal(parseSoloCommand("   "), "toggle");
  assert.equal(parseSoloCommand("ON"), "usage");
  assert.equal(parseSoloCommand("off"), "usage");
  assert.equal(parseSoloCommand(" status "), "usage");
  assert.equal(parseSoloCommand("bogus"), "usage");
});

test("命令注册：裸 /solo + 三个冒号子命令，均有描述", () => {
  const { file } = makeTempStateFile();
  const { commands } = boot({ statePath: file });
  assert.deepEqual([...commands.keys()], ["solo", "solo:on", "solo:off", "solo:status"]);
  for (const name of commands.keys()) {
    assert.ok((commands.get(name)?.description ?? "").length > 0, `${name} has a description`);
  }
});

test("resolveSoloStatePath：PI_SOLO_MODE_FILE 优先，空串回落默认路径", () => {
  assert.equal(resolveSoloStatePath({ PI_SOLO_MODE_FILE: "/tmp/x.json" }), "/tmp/x.json");
  assert.equal(resolveSoloStatePath({ PI_SOLO_MODE_FILE: "  " }), path.join(os.homedir(), ".pi", "agent", "solo-mode.json"));
  assert.match(resolveSoloStatePath({}), /solo-mode\.json$/);
});

// ===== 纯函数:状态判定 fail-closed =====

test("isSoloActive：本进程 pid 激活；缺失/损坏/异 pid 一律 false", () => {
  const { file } = makeTempStateFile();
  const env = { PI_SOLO_MODE_FILE: file };

  assert.equal(isSoloActive({ env }), false, "文件缺失 → false");
  fs.writeFileSync(file, "{ not json", "utf8");
  assert.equal(isSoloActive({ env }), false, "JSON 损坏 → false");
  writeSoloState(file, { pid: process.pid + 1, activatedAt: "x" });
  assert.equal(isSoloActive({ env }), false, "异 pid（子进程/崩溃残留）→ false");
  writeSoloState(file, { pid: process.pid, activatedAt: "2026-08-05T12:00:00.000Z" });
  assert.equal(isSoloActive({ env }), true, "本进程 pid → true");
  assert.deepEqual(readSoloState({ env }), { pid: process.pid, activatedAt: "2026-08-05T12:00:00.000Z" });
});

test("clearSoloState：删除成功；目录路径删除失败返回 false 不抛错", () => {
  const { dir, file } = makeTempStateFile();
  writeSoloState(file, { pid: process.pid, activatedAt: "x" });
  assert.equal(clearSoloState(file), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(clearSoloState(dir), false, "目录只能用 recursive 删；返回 false 而非抛错");
});

// ===== 命令面 =====

test("开启：确认通过 → 状态文件写入 + 状态条 + notify；关闭 → 删除 + 清状态条", async () => {
  const { file } = makeTempStateFile();
  const { commands, ctx, notifications, statuses } = boot({ statePath: file });

  const handler = commands.get("solo")!.handler;
  await handler("", ctx);

  assert.equal(fs.existsSync(file), true, "确认后写入状态文件");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { pid: process.pid, activatedAt: "2026-08-05T12:00:00.000Z" });
  assert.ok(statuses.some((s) => s.key === SOLO_STATUS_KEY && s.text === SOLO_STATUS_TEXT), "状态条显示 ⚡ solo");
  assert.ok(notifications.some((n) => n.message.includes("已启用")), "notify 已启用");

  await commands.get("solo:off")!.handler("", ctx);
  assert.equal(fs.existsSync(file), false, "关闭删除状态文件");
  assert.ok(statuses.some((s) => s.key === SOLO_STATUS_KEY && s.text === undefined), "状态条清除");
  assert.ok(notifications.some((n) => n.message.includes("已关闭")), "notify 已关闭");
});

test("开启：确认取消 → 不写文件、保持关闭", async () => {
  const { file } = makeTempStateFile();
  const { commands, ctx, notifications, confirms } = boot({ statePath: file, confirm: async () => false });

  await commands.get("solo:on")!.handler("", ctx);

  assert.equal(confirms.length, 1, "开启弹一次确认");
  assert.equal(fs.existsSync(file), false, "取消不写状态文件");
  assert.ok(notifications.some((n) => n.message.includes("已取消")), "notify 已取消");
});

test("无 UI 环境：拒绝开启（fail-closed），不弹确认、不写文件", async () => {
  const { file } = makeTempStateFile();
  const { commands, ctx, notifications, confirms } = boot({ statePath: file, hasUI: false });

  await commands.get("solo:on")!.handler("", ctx);

  assert.equal(confirms.length, 0);
  assert.equal(fs.existsSync(file), false);
  assert.ok(notifications.some((n) => n.type === "warning" && n.message.includes("TUI")), "warning 提示需 TUI");
});

test("status / usage：开与关两态输出，未知参数提示用法", async () => {
  const { file } = makeTempStateFile();
  const { commands, ctx, notifications } = boot({ statePath: file });

  await commands.get("solo:status")!.handler("", ctx);
  assert.ok(notifications.at(-1)!.message.includes("未启用"));

  writeSoloState(file, { pid: process.pid, activatedAt: "x" });
  await commands.get("solo:status")!.handler("", ctx);
  assert.ok(notifications.at(-1)!.message.includes("已启用"));

  await commands.get("solo")!.handler("bogus", ctx);
  assert.ok(notifications.at(-1)!.message.includes("用法"), "未知参数给用法");
});

test("裸 /solo 的旧管理词只提示改名，绝不执行切换/开关", async () => {
  const { file } = makeTempStateFile();
  const { commands, ctx, notifications, confirms } = boot({ statePath: file });
  const before = notifications.length;
  for (const head of ["on", "off", "status"]) {
    await commands.get("solo")!.handler(head, ctx);
    const note = notifications.at(-1)!;
    assert.equal(note.type, "warning");
    assert.match(note.message, new RegExp(`「/solo ${head}」已改名为「/solo:${head}」`));
  }
  assert.equal(notifications.length, before + 3, "每个旧词恰好一条提示");
  assert.equal(confirms.length, 0, "改名提示不弹确认");
  assert.equal(fs.existsSync(file), false, "改名提示不写状态文件");
});
test("写失败（状态路径为目录）：保持关闭 + error notify，不抛异常", async () => {
  const { dir } = makeTempStateFile();
  const { commands, ctx, notifications } = boot({ statePath: dir });

  await commands.get("solo:on")!.handler("", ctx);

  assert.ok(notifications.some((n) => n.type === "error" && n.message.includes("启用失败")), "error notify");
  assert.equal(isSoloActive({ env: { PI_SOLO_MODE_FILE: dir } }), false, "仍为关闭");
});
// ===== 生命周期 =====

test("session_start：本进程残留复位（reload 提示），异 pid 文件不触碰", async () => {
  const { file } = makeTempStateFile();
  const b1 = boot({ statePath: file });
  writeSoloState(file, { pid: process.pid, activatedAt: "x" });
  await (b1.handlers.get("session_start")! as (e: unknown, c: unknown) => unknown)({ reason: "reload" }, b1.ctx);
  assert.equal(fs.existsSync(file), false, "own-pid 残留被清除");
  assert.ok(b1.notifications.some((n) => n.message.includes("重载复位")), "reload 提示");

  // 异 pid 文件（并发实例）：session_start 不得删除
  writeSoloState(file, { pid: process.pid + 1, activatedAt: "x" });
  const boot2 = boot({ statePath: file });
  await (boot2.handlers.get("session_start")! as (e: unknown, c: unknown) => unknown)({ reason: "startup" }, boot2.ctx);
  assert.equal(fs.existsSync(file), true, "异 pid 文件保留");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid + 1);
});

test("session_shutdown：清除本进程状态文件与状态条", async () => {
  const { file } = makeTempStateFile();
  const b = boot({ statePath: file });
  writeSoloState(file, { pid: process.pid, activatedAt: "x" });

  await (b.handlers.get("session_shutdown")! as (e: unknown, c: unknown) => unknown)({}, b.ctx);

  assert.equal(fs.existsSync(file), false, "shutdown 清状态文件");
  assert.ok(b.statuses.some((s) => s.key === SOLO_STATUS_KEY && s.text === undefined), "状态条清除");
});

test("SOLO_STATUS_KEY 带排序带前缀（40:solo-mode）", () => {
  assert.equal(SOLO_STATUS_KEY, "40:solo-mode");
});
