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
