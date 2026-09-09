/**
 * opencode-bridge — 随 Pi 启动自动拉起本地代理桥（不开机自启）
 *
 * 背景：opencode-go 的 Muse Spark 等模型按出口 IP 限区，Pi 又只支持 HTTP 代理
 *       （不认 socks5://）。本扩展在会话启动时确保一个独立 helper 进程在跑
 *       （opencode-bridge-helper.mjs），它把 HTTP CONNECT 转成你本地 v2rayN
 *       的 SOCKS5（默认 127.0.0.1:10808）。Pi 的 settings.json 配置
 *       "httpProxy": "http://127.0.0.1:10899" 后，模型请求即可经此桥从允许
 *       地区出去。本扩展不会自动修改用户的 settings.json。
 *
 * 设计要点（对齐仓库异常隔离习惯）：
 *  - 桥运行在独立进程中，任何异常都不会影响 Pi 主进程；
 *  - 多个 Pi 实例（含 subagent 子进程）共用同一个桥：先探测端口，只在必要时拉起；
 *  - 本扩展自身除探测 socket 外不持有任何资源（spawn 后 unref，不持有子进程）；
 *  - session_start / 命令处理全部 try/catch 包裹，失败只提示、不抛出。
 *
 * httpProxy 自动同步：桥确认在监听后，自动把 settings.json 的 httpProxy
 *       指向本桥（幂等；已有其它代理地址不碰；桥不通且原值指向本桥则自动
 *       移除自愈）。写入在下次 Pi 启动才生效，通知里会说明。
 *       PI_BRIDGE_AUTO_PROXY=0/false/off 可关闭。
 *
 * 命令：/opencode-bridge — 查看状态（必要时尝试启动），显示监听地址、
 *       上游 SOCKS5 地址和所需 httpProxy 配置。
 *
 * 环境变量：PI_BRIDGE_PORT / PI_BRIDGE_SOCKS_HOST / PI_BRIDGE_SOCKS_PORT /
 *           PI_BRIDGE_AUTO_PROXY（helper 另支持 PI_BRIDGE_LOG 指定日志文件路径）
 *
 * 安装：复制本目录到 ~/.pi/agent/extensions/opencode-bridge/ 或
 *       <项目>/.pi/extensions/opencode-bridge/，在 Pi 中执行 /reload。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HELPER_FILE_NAME,
  PROBE_TIMEOUT_MS,
  type BridgeConfig,
  type BridgeDeps,
  type ProxySyncDeps,
  createDefaultBridgeDeps,
  createDefaultProxySyncDeps,
  ensureBridge,
  parseBridgeConfig,
  syncHttpProxy,
} from "./bridge.ts";

// ===== 常量 =====

export const COMMAND_NAME = "opencode-bridge";

// ===== 扩展依赖（测试可注入） =====

export interface BridgeExtensionDeps {
  /** 桥进程/网络边界；缺省用 createDefaultBridgeDeps() */
  bridge?: BridgeDeps;
  /** helper 路径解析用的 import.meta.url；测试可显式传入 */
  metaUrl?: string;
  /** helper 候选路径覆盖（优先于自动解析） */
  helperPaths?: string[];
  /** 环境变量来源覆盖（缺省 process.env） */
  env?: Record<string, string | undefined>;
  /** settings.json 读写边界；缺省用 createDefaultProxySyncDeps() */
  proxySync?: ProxySyncDeps;
  /** settings.json 路径覆盖（缺省 ~/.pi/agent/settings.json） */
  settingsPath?: string;
}

// ===== 内部工具 =====

/** 异常隔离的通知：无 UI 静默降级，任何 UI 错误不外抛。 */
function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(message, type);
  } catch {
    /* ignore */
  }
}

/** PI_BRIDGE_AUTO_PROXY 解析：未设置默认开；0/false/off（不分大小写）关。 */
export function isAutoProxyEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.PI_BRIDGE_AUTO_PROXY;
  if (raw === undefined || raw.trim() === "") return true;
  return !/^(0|false|off)$/i.test(raw.trim());
}

/**
 * 确保桥在跑并同步 settings.json 的 httpProxy（session_start 与命令共用）。
 * 所有异常都在内部消化，不外抛；配置无效时返回 parsed: false。
 */
async function ensureBridgeAndSync(
  ctx: ExtensionContext,
  deps: {
    bridge: BridgeDeps;
    proxySync: ProxySyncDeps;
    helperPaths: string[];
    env: Record<string, string | undefined>;
    settingsPath: string;
    /** 拉起失败时是否发 error 通知（session_start 用；命令走状态行，不开） */
    reportError: boolean;
  },
): Promise<{ parsed: false } | { parsed: true; alive: boolean; note: string; config: BridgeConfig }> {
  const parsed = parseBridgeConfig(deps.env);
  if (!parsed.ok) {
    notify(ctx, `opencode-bridge 配置无效：${parsed.errors.join("；")}`, "error");
    return { parsed: false };
  }
  const config = parsed.config;

  let alive = await deps.bridge.probe(config.bridgeHost, config.bridgePort, PROBE_TIMEOUT_MS);
  let note = "";
  if (!alive) {
    const result = await ensureBridge(
      { config, helperPaths: deps.helperPaths, execPath: process.execPath, env: deps.env },
      deps.bridge,
    );
    alive = result.ok;
    note = result.ok ? "（已自动启动）" : `（启动失败：${result.message}）`;
    if (!result.ok && deps.reportError) {
      notify(ctx, `opencode-bridge: ${result.message}`, "error");
    }
  }

  if (isAutoProxyEnabled(deps.env)) {
    try {
      const sync = syncHttpProxy(
        { settingsPath: deps.settingsPath, proxyUrl: config.proxyUrl, bridgeAlive: alive },
        deps.proxySync,
      );
      notify(
        ctx,
        `opencode-bridge httpProxy 同步：${sync.message}`,
        sync.ok && sync.action !== "kept-foreign" ? "info" : "warning",
      );
    } catch (err) {
      notify(ctx, `opencode-bridge httpProxy 同步异常已忽略：${err instanceof Error ? err.message : String(err)}`, "warning");
    }
  }

  return { parsed: true, alive, note, config };
}

/** helper 候选路径：扩展目录（import.meta.url 同目录）优先，其余为常见安装位置。 */
function resolveHelperCandidates(metaUrl: string | undefined): string[] {
  const candidates: string[] = [];
  if (metaUrl?.startsWith("file:")) {
    try {
      candidates.push(path.join(path.dirname(fileURLToPath(metaUrl)), HELPER_FILE_NAME));
    } catch {
      /* file: URL 解析失败时走后面的兜底 */
    }
  }
  // jiti 加载 .ts 扩展时 import.meta.url 是 data: URI（转译后的源码），
  // 但 jiti 以 CJS 包装函数注入 __dirname，其值即扩展真实目录。
  try {
    const dir = typeof __dirname !== "undefined" ? __dirname : undefined;
    if (dir) candidates.push(path.join(dir, HELPER_FILE_NAME));
  } catch {
    /* Node 原生 ESM 下 __dirname 不存在，走后面的兜底 */
  }
  candidates.push(
    path.join(os.homedir(), ".pi", "agent", "extensions", "opencode-bridge", HELPER_FILE_NAME),
    path.join(os.homedir(), ".pi", "agent", "extensions", HELPER_FILE_NAME),
  );
  return candidates;
}

/** /opencode-bridge 状态输出（纯函数，便于测试断言）。 */
export function formatStatusLines(config: BridgeConfig, alive: boolean, note: string): string[] {
  return [
    `状态: ${alive ? "运行中" : "未运行"}${note}`,
    `监听: ${config.proxyUrl}`,
    `上游: socks5://${config.socksHost}:${config.socksPort}`,
    `pi 配置: settings.json 的 httpProxy 由扩展自动同步（PI_BRIDGE_AUTO_PROXY=0 可关闭）`,
  ];
}

// ===== 扩展入口 =====

export function createOpencodeBridgeExtension(pi: ExtensionAPI, deps: BridgeExtensionDeps = {}): void {
  const bridgeDeps = deps.bridge ?? createDefaultBridgeDeps();
  const proxySyncDeps = deps.proxySync ?? createDefaultProxySyncDeps();
  const env = deps.env ?? process.env;
  const helperPaths =
    deps.helperPaths ?? resolveHelperCandidates(deps.metaUrl ?? (import.meta as unknown as { url?: string }).url);
  const settingsPath = deps.settingsPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json");

  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureBridgeAndSync(ctx, {
        bridge: bridgeDeps,
        proxySync: proxySyncDeps,
        helperPaths,
        env,
        settingsPath,
        reportError: true,
      });
    } catch (err) {
      notify(ctx, `opencode-bridge 异常已忽略：${err instanceof Error ? err.message : String(err)}`, "warning");
    }
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "查看/启动本地代理桥（HTTP CONNECT → 本地 SOCKS5）",
    handler: async (_args, ctx) => {
      try {
        const state = await ensureBridgeAndSync(ctx, {
          bridge: bridgeDeps,
          proxySync: proxySyncDeps,
          helperPaths,
          env,
          settingsPath,
          reportError: false,
        });
        if (!state.parsed) return;
        notify(ctx, formatStatusLines(state.config, state.alive, state.note).join("\n"), state.alive ? "info" : "warning");
      } catch (err) {
        notify(ctx, `opencode-bridge 异常已忽略：${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });
}

export default function opencodeBridge(pi: ExtensionAPI): void {
  createOpencodeBridgeExtension(pi);
}
