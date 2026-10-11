/**
 * test/helpers/composition-host.mjs — 组合测试的宿主替身与扩展加载器
 *
 * 边界与动机（必读）：
 * - 本文件只替身**宿主扩展 API 的注册面**（`pi.registerTool` / `registerCommand` /
 *   `registerProvider` / `registerVirtualModel` / `registerShortcut` / `on` / `events` /
 *   `ctx.ui` / `ctx.sessionManager`），记录"谁注册了什么"，不模拟宿主内部行为
 *   （工具分派、first-wins 覆盖、渲染、transcript）。宿主真实行为由 L3（真 pi RPC，
 *   opt-in）与既有宿主路径测试（agent-team `viewer-host.test.ts`、dir-context /
 *   jev-safe-gate 的 `index-host.test.ts`）覆盖。
 * - 组合冲突的**判定规则**（同名槽必须有 `独占声明`，否则算真冲突）在 L2 用例里，
 *   不藏在替身里——替身只如实记录。
 * - 加载扩展用真实 `import("<扩展目录>/index.ts")`（真源码、真副作用、真依赖解析），
 *   唯一被替换的是宿主 API 对象本身。
 */

import { register } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
export const EXTENSIONS_DIR = path.join(REPO_ROOT, "src", "extensions");

let resolverRegistered = false;

/** 注册宿主包解析钩子（幂等）。 */
export function registerHostPackages() {
  if (resolverRegistered) return;
  register("./host-resolver.mjs", import.meta.url, { data: { repoRoot: REPO_ROOT } });
  resolverRegistered = true;
}

/** 事件总线替身：记录订阅、支持同步 emit（宿主 `pi.events` 是同步派发）。 */
export function makeEventBus() {
  const listeners = new Map();
  return {
    channels: () => [...listeners.keys()].sort(),
    listenerCount: (channel) => (listeners.get(channel) ?? []).length,
    on(channel, handler) {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(handler);
      return () => {
        const list = listeners.get(channel) ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    emit(channel, payload) {
      for (const handler of listeners.get(channel) ?? []) handler(payload);
    },
  };
}

/**
 * 宿主替身。`ui` / `sessionManager` 只实现扩展实际用到的成员，多出来的调用会记进
 * `calls` 供断言（不抛异常，避免替身比宿主更严格导致误报）。
 */
export function makeHost({ label = "host" } = {}) {
  const events = makeEventBus();
  const record = {
    label,
    currentActor: label, // 谁在注册（一个宿主上先后加载多个扩展，靠它归因）
    tools: [], // { name, source }
    commands: [], // { name, source }
    shortcuts: [], // { key, source }
    providers: [], // { id, source }
    virtualModels: [], // { id, source }
    hooks: [], // { event, source }
    statusWrites: [], // { key, value }
    widgetWrites: [], // { key, value }
    values: new Map(), // 跨扩展共享（同一宿主 = 同一份）
    calls: [],
  };
  const actor = () => record.currentActor;

  const ui = {
    setStatus(key, value) {
      record.statusWrites.push({ key, value });
    },
    setWidget(key, value) {
      record.widgetWrites.push({ key, value });
    },
    notify() {},
    theme: { fg: (_style, text) => text },
  };

  const sessionManager = {
    getEntries: () => [],
    getSessionFile: () => undefined,
    appendEntry: () => {},
    getCwd: () => REPO_ROOT,
  };

  const state = new Map();

  /** 宿主内置工具面：timeout-bg / remote-tools 靠它判断该顶掉谁（真宿主同形）。 */
  const activeTools = ["bash", "powershell", "read", "write", "edit", "ls", "find", "grep"];
  const toolInfo = (name) => ({ name, description: `builtin ${name}`, parameters: {}, promptGuidelines: [], sourceInfo: { type: "builtin" } });

  const pi = {
    registerTool(tool) {
      record.tools.push({ name: tool?.name, source: actor() });
    },
    registerCommand(name) {
      record.commands.push({ name, source: actor() });
    },
    registerShortcut(key) {
      record.shortcuts.push({ key, source: actor() });
    },
    registerProvider(id) {
      record.providers.push({ id, source: actor() });
    },
    registerVirtualModel(model) {
      record.virtualModels.push({ id: model?.id ?? model?.model?.id, source: actor() });
    },
    registerFlag() {},
    getFlag: () => undefined,
    getActiveTools: () => [...activeTools],
    getAllTools: () => activeTools.map(toolInfo),
    getAllRegisteredTools: () => activeTools.map(toolInfo),
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    appendEntry() {},
    sendMessage() {},
    events,
    on(event, handler) {
      record.hooks.push({ event, handler, source: actor() });
      return handler;
    },
    get extensionState() {
      return {
        get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
        set: (key, value) => state.set(key, value),
      };
    },
  };

  const ctx = {
    hasUI: true,
    cwd: REPO_ROOT,
    ui,
    sessionManager,
    getContextUsage: () => undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    getModel: () => undefined,
    modelRegistry: { getModel: () => undefined, getAvailable: () => [] },
  };

  return {
    pi,
    ctx,
    record,
    events,
    /** 切换当前注册者（配对探针在加载每个扩展前调用）。 */
    setActor(name) {
      record.currentActor = name;
    },
  };
}

/**
 * 加载一个扩展模块（真实 import），返回其默认导出。
 * 缓存由 ESM 负责——同一进程内重复加载拿到同一模块实例（与宿主一致）。
 */
export async function loadExtension(name) {
  registerHostPackages();
  const dir = path.join(EXTENSIONS_DIR, name);
  const mod = await import(new URL(`file://${path.join(dir, "index.ts").replace(/\\/g, "/")}`).href);
  const factory = mod.default ?? mod.extension;
  if (typeof factory !== "function") {
    throw new Error(`${name}: index.ts 没有默认导出函数（拿到的类型：${typeof factory}）`);
  }
  return factory;
}

/** 触发宿主钩子（替身只负责派发，错误原样抛出——测试的「不抛未捕获异常」断言靠它）。 */
export async function fireHook(host, event, payload = {}) {
  const handlers = host.record.hooks.filter((entry) => entry.event === event);
  for (const entry of handlers) {
    await entry.handler({ type: event, ...payload }, host.ctx);
  }
  return handlers.length;
}
