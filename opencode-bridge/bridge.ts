/**
 * opencode-bridge — 桥配置解析、端口探测与 helper 拉起（可测试核心逻辑）
 *
 * 本模块不 import Pi 宿主 API：所有进程/网络边界（TCP 探测、文件存在性、
 * detached spawn、sleep）都通过 `BridgeDeps` 注入，测试用手写 fake 替换，
 * 生产用 `createDefaultBridgeDeps()`。
 *
 * 配置来源（均为可选环境变量）：
 *   PI_BRIDGE_PORT        桥监听端口，默认 10899（仅绑定 127.0.0.1）
 *   PI_BRIDGE_SOCKS_HOST  上游 SOCKS5 主机，默认 127.0.0.1
 *   PI_BRIDGE_SOCKS_PORT  上游 SOCKS5 端口，默认 10808（v2rayN 默认值）
 *
 * settings.json httpProxy 同步（v1.2.0）：不再自动修改。由 /opencode-bridge-sync
 *   斜杠命令手动触发，先 plan（只读）给出将要做的事，经 ctx.ui.confirm 人工
 *   确认后才 apply（写前把原文件原文备份到 settings.json.bak-opencode-bridge-*）；
 *   仅增/删 httpProxy 字段，其余配置原样保留。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

// ===== 常量 =====

export const BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 10899;
export const DEFAULT_SOCKS_HOST = "127.0.0.1";
export const DEFAULT_SOCKS_PORT = 10808;
export const HELPER_FILE_NAME = "opencode-bridge-helper.mjs";

/** 默认探测/拉起轮询参数 */
export const PROBE_TIMEOUT_MS = 600;
export const START_ATTEMPTS = 25;
export const START_POLL_DELAY_MS = 120;

/** httpProxy 同步动作（静态、可诊断；plan 只读，apply 才落盘） */
export const ProxySyncActions = {
  /** 将写入 httpProxy（待确认） */
  SET: "set",
  /** 将移除指向本桥的 httpProxy（桥不通，待确认） */
  REMOVE: "remove",
  /** 已指向本桥，无需改动 */
  NOOP: "noop",
  /** 已有其它代理地址，不碰 */
  FOREIGN: "foreign",
} as const;
export type ProxySyncAction = (typeof ProxySyncActions)[keyof typeof ProxySyncActions];

export interface HttpProxySyncPlan {
  action: ProxySyncAction;
  /** 将写入的地址（set） */
  proxyUrl?: string;
  /** 当前 httpProxy 值（存在时） */
  current?: string;
  message: string;
}

export type PlanSyncResult =
  | { ok: true; plan: HttpProxySyncPlan }
  | { ok: false; message: string };

export type ApplySyncResult =
  | { ok: true; backupPath?: string; message: string }
  | { ok: false; message: string };

/** settings.json 读写边界；测试注入 fake，生产用 createDefaultProxySyncDeps()。 */
export interface ProxySyncDeps {
  /** 文件不存在返回 undefined；读失败抛异常由调用方隔离 */
  readTextFile(path: string): string | undefined;
  writeTextFile(path: string, content: string): void;
}

/** 生产依赖：真实 fs 读写。 */
export function createDefaultProxySyncDeps(): ProxySyncDeps {
  return {
    readTextFile(path) {
      try {
        return fs.readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeTextFile(path, content) {
      fs.writeFileSync(path, content, "utf8");
    },
  };
}

/** 备份文件路径：settings.json 同目录，settings.json.bak-opencode-bridge-YYYYMMDD-HHmmss。 */
export function makeBackupPath(settingsPath: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${settingsPath}.bak-opencode-bridge-${stamp}`;
}

/** ensureBridge 错误码（静态、可诊断，调用方据此提示用户） */
export const EnsureErrorCodes = {
  /** helper 文件不存在 */
  HELPER_MISSING: "HELPER_MISSING",
  /** spawn 同步抛出异常 */
  SPAWN_FAILED: "SPAWN_FAILED",
  /** helper 已拉起但端口始终未就绪 */
  START_TIMEOUT: "START_TIMEOUT",
} as const;
export type EnsureErrorCode = (typeof EnsureErrorCodes)[keyof typeof EnsureErrorCodes];

// ===== 类型 =====

export interface BridgeConfig {
  /** 桥监听主机，恒为 127.0.0.1 */
  bridgeHost: string;
  bridgePort: number;
  socksHost: string;
  socksPort: number;
  /** 供 Pi settings.json httpProxy 使用的地址 */
  proxyUrl: string;
}

export type ParseBridgeConfigResult =
  | { ok: true; config: BridgeConfig }
  | { ok: false; errors: string[] };

export type EnsureBridgeResult =
  | { ok: true; started: boolean }
  | { ok: false; started: boolean; code: EnsureErrorCode; message: string };

export interface EnsureBridgeOptions {
  config: BridgeConfig;
  /** helper 候选路径，按序取第一个存在的 */
  helperPaths: string[];
  /** Node 可执行文件（helper 用它启动） */
  execPath: string;
  /** 传给 helper 的额外环境（会合并 PI_BRIDGE_PORT） */
  env?: Record<string, string | undefined>;
  attempts?: number;
  delayMs?: number;
  probeTimeoutMs?: number;
}

/** 进程/网络边界。测试注入 fake，生产由 createDefaultBridgeDeps 提供。 */
export interface BridgeDeps {
  probe(host: string, port: number, timeoutMs: number): Promise<boolean>;
  fileExists(path: string): boolean;
  spawnDetached(nodePath: string, helperPath: string, env: Record<string, string | undefined>): void;
  sleep(ms: number): Promise<void>;
}

// ===== 配置解析 =====

/**
 * 解析端口环境变量：未设置/空串用默认值；必须是 1-65535 的整数，
 * 否则返回静态可诊断错误（不静默回退，避免不可诊断的启动失败）。
 */
function parsePortEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined || raw === "") return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return { ok: false, message: `环境变量 ${name} 无效：需为 1-65535 的整数（当前值：${JSON.stringify(raw)}）` };
  }
  return { ok: true, value };
}

/** 解析桥配置；任一端口非法即整体拒绝（Result union，不抛异常）。 */
export function parseBridgeConfig(env: Record<string, string | undefined>): ParseBridgeConfigResult {
  const portResult = parsePortEnv(env.PI_BRIDGE_PORT, "PI_BRIDGE_PORT", DEFAULT_BRIDGE_PORT);
  const socksPortResult = parsePortEnv(env.PI_BRIDGE_SOCKS_PORT, "PI_BRIDGE_SOCKS_PORT", DEFAULT_SOCKS_PORT);
  if (!portResult.ok || !socksPortResult.ok) {
    return { ok: false, errors: [portResult.ok ? "" : portResult.message, socksPortResult.ok ? "" : socksPortResult.message].filter(Boolean) };
  }
  const socksHost = env.PI_BRIDGE_SOCKS_HOST?.trim() || DEFAULT_SOCKS_HOST;
  const config: BridgeConfig = {
    bridgeHost: BRIDGE_HOST,
    bridgePort: portResult.value,
    socksHost,
    socksPort: socksPortResult.value,
    proxyUrl: `http://${BRIDGE_HOST}:${portResult.value}`,
  };
  return { ok: true, config };
}

// ===== 默认（生产）依赖 =====

/** 生产依赖：真实 TCP 探测 / fs 存在性 / detached spawn / setTimeout。 */
export function createDefaultBridgeDeps(): BridgeDeps {
  return {
    probe(host, port, timeoutMs) {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
          resolve(ok);
        };
        let socket: net.Socket;
        try {
          socket = net.connect({ host, port });
          socket.setTimeout(timeoutMs, () => finish(false));
          socket.once("connect", () => finish(true));
          socket.once("error", () => finish(false));
        } catch {
          finish(false);
        }
      });
    },
    fileExists(path) {
      try {
        return fs.existsSync(path);
      } catch {
        return false;
      }
    },
    spawnDetached(nodePath, helperPath, env) {
      const child = spawn(nodePath, [helperPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
      });
      // 错误由 ensureBridge 的端口轮询统一报告；不持有子进程资源
      child.on("error", () => {
        /* ignore */
      });
      child.unref();
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

// ===== ensureBridge =====

/**
 * 读取 settings.json 并生成 httpProxy 同步计划（只读，不落盘）：
 *   - 桥在监听且未设 httpProxy → set；已指向本桥 → noop；已有其它代理 → foreign（不碰）；
 *   - 桥不通且原值指向本桥 → remove（建议移除，避免死代理拖垮全部模型请求）。
 * settings.json 解析失败/根不是对象 → ok:false（绝不写）。
 */
export function planHttpProxySync(
  options: { settingsPath: string; proxyUrl: string; bridgeAlive: boolean },
  deps: ProxySyncDeps,
): PlanSyncResult {
  const { settingsPath, proxyUrl, bridgeAlive } = options;

  let settings: Record<string, unknown> = {};
  const raw = deps.readTextFile(settingsPath);
  if (raw !== undefined && raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      ) {
        return { ok: false, message: `settings.json 根不是对象，拒绝修改（${settingsPath}）` };
      }
      settings = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, message: `settings.json 解析失败，拒绝修改（${settingsPath}）` };
    }
  }

  const existing = typeof settings.httpProxy === "string" ? settings.httpProxy : undefined;

  if (bridgeAlive) {
    if (existing === proxyUrl) {
      return { ok: true, plan: { action: ProxySyncActions.NOOP, current: existing, message: "httpProxy 已指向本桥，无需改动" } };
    }
    if (existing !== undefined) {
      return { ok: true, plan: { action: ProxySyncActions.FOREIGN, current: existing, message: `检测到已有 httpProxy（${existing}），不碰` } };
    }
    return { ok: true, plan: { action: ProxySyncActions.SET, proxyUrl, message: `将写入 httpProxy: ${proxyUrl}` } };
  }

  if (existing === proxyUrl) {
    return { ok: true, plan: { action: ProxySyncActions.REMOVE, current: existing, message: "桥未运行，将移除指向本桥的 httpProxy（避免请求卡死）" } };
  }
  return { ok: true, plan: { action: ProxySyncActions.NOOP, current: existing, message: "桥未运行，settings.json 无需改动" } };
}

/**
 * 执行同步计划：先把原文件原文备份到 backupPath（原文件不存在则跳过备份），
 * 再仅增/删 httpProxy 字段落盘。apply 前重读校验 current 未变（防竞态覆盖）。
 */
export function applyHttpProxySync(
  plan: HttpProxySyncPlan,
  options: { settingsPath: string; backupPath: string },
  deps: ProxySyncDeps,
): ApplySyncResult {
  const { settingsPath, backupPath } = options;
  if (plan.action !== ProxySyncActions.SET && plan.action !== ProxySyncActions.REMOVE) {
    return { ok: false, message: `无需执行的动作：${plan.action}` };
  }

  const raw = deps.readTextFile(settingsPath);
  let settings: Record<string, unknown> = {};
  if (raw !== undefined && raw.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, message: "settings.json 根不是对象，拒绝修改" };
      }
      settings = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, message: "settings.json 解析失败，拒绝修改" };
    }
  }
  const current = typeof settings.httpProxy === "string" ? settings.httpProxy : undefined;
  if (current !== plan.current) {
    return { ok: false, message: `settings.json 已变化（当前 httpProxy：${JSON.stringify(current)}），请重新执行命令` };
  }

  if (raw !== undefined) {
    try {
      deps.writeTextFile(backupPath, raw);
    } catch (err) {
      return { ok: false, message: `备份失败，未修改：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (plan.action === ProxySyncActions.SET) {
    settings.httpProxy = plan.proxyUrl;
  } else {
    delete settings.httpProxy;
  }
  try {
    deps.writeTextFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch (err) {
    return { ok: false, message: `写入 settings.json 失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const backupNote = raw !== undefined ? `；原配置已备份到 ${backupPath}` : "；原文件不存在，无备份";
  return {
    ok: true,
    backupPath: raw !== undefined ? backupPath : undefined,
    message: `${plan.action === ProxySyncActions.SET ? `已写入 httpProxy: ${plan.proxyUrl}` : "已移除 httpProxy"}${backupNote}（重启 Pi 后生效）`,
  };
}

/** 确保桥在运行：已在监听则复用，否则拉起 helper 并轮询端口就绪。 */
export async function ensureBridge(
  options: EnsureBridgeOptions,
  deps: BridgeDeps,
): Promise<EnsureBridgeResult> {
  const { config, helperPaths, execPath } = options;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  if (await deps.probe(config.bridgeHost, config.bridgePort, probeTimeoutMs)) {
    return { ok: true, started: false };
  }

  const helperPath = helperPaths.find((candidate) => deps.fileExists(candidate));
  if (!helperPath) {
    return {
      ok: false,
      started: false,
      code: EnsureErrorCodes.HELPER_MISSING,
      message: `helper 文件不存在（${HELPER_FILE_NAME}；候选路径：${helperPaths.join("，")}）`,
    };
  }

  try {
    deps.spawnDetached(execPath, helperPath, {
      ...options.env,
      PI_BRIDGE_PORT: String(config.bridgePort),
    });
  } catch (err) {
    return {
      ok: false,
      started: false,
      code: EnsureErrorCodes.SPAWN_FAILED,
      message: `启动 helper 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const attempts = options.attempts ?? START_ATTEMPTS;
  const delayMs = options.delayMs ?? START_POLL_DELAY_MS;
  for (let i = 0; i < attempts; i++) {
    await deps.sleep(delayMs);
    if (await deps.probe(config.bridgeHost, config.bridgePort, probeTimeoutMs)) {
      return { ok: true, started: true };
    }
  }

  return {
    ok: false,
    started: true,
    code: EnsureErrorCodes.START_TIMEOUT,
    message: `helper 已拉起但未监听 ${config.proxyUrl}（检查上游 SOCKS5 ${config.socksHost}:${config.socksPort} 是否可用）`,
  };
}
