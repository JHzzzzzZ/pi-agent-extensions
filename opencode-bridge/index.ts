/**
 * opencode-bridge — 随 Pi 启动自动拉起本地代理桥（不开机自启）
 *
 * 背景：opencode-go 的 Muse Spark 等模型按出口 IP 限区，Pi 又只支持 HTTP 代理
 *       （不认 socks5://）。本扩展在会话启动时确保一个独立 helper 进程在跑
 *       （opencode-bridge-helper.mjs），它把 HTTP CONNECT 转成你本地 v2rayN
 *       的 SOCKS5（默认 127.0.0.1:10808）。Pi 的 settings.json 配置
 *       "httpProxy": "http://127.0.0.1:10899" 后，模型请求即可经此桥从允许
 *       地区出去。
 *
 * 设计要点（对齐仓库异常隔离习惯）：
 *  - 桥运行在独立进程中，任何异常都不会影响 Pi 主进程；
 *  - 多个 Pi 实例（含 subagent 子进程）共用同一个桥：先探测端口，只在必要时拉起；
 *  - 本扩展自身除探测 socket 外不持有任何资源（spawn 后 unref，不持有子进程）；
 *  - session_start / 命令处理全部 try/catch 包裹，失败只提示、不抛出。
 *
 * settings.json httpProxy 修改（v1.2.0）：本扩展【绝不自动修改】用户的
 *       settings.json。需要用 /opencode-bridge-sync 斜杠命令手动触发：先展示
 *       将要做的事，经 ctx.ui.confirm 人工确认后才落盘；写入前把原文件原文
 *       备份到 settings.json.bak-opencode-bridge-<时间戳>；仅增/删 httpProxy
 *       字段，其余配置原样保留；写入在下次 Pi 启动才生效。
 *
 * 命令：/opencode-bridge — 查看状态（必要时尝试启动），显示监听地址、上游
 *       SOCKS5 地址、settings.json 的 httpProxy 当前状态。
 *       /opencode-bridge-sync — 修改 settings.json 的 httpProxy（确认 + 备份）。
 *       /opencode-bridge-restore — 从备份中恢复 settings.json（确认；恢复前
 *       先把当前配置再备份一份，保证恢复操作本身可撤销）。
 *
 * 环境变量：PI_BRIDGE_PORT / PI_BRIDGE_SOCKS_HOST / PI_BRIDGE_SOCKS_PORT
 *           （helper 另支持 PI_BRIDGE_LOG 指定日志文件路径）
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
  type HttpProxySyncPlan,
  type ProxySyncDeps,
  ProxySyncActions,
  applyHttpProxySync,
  applyRestore,
  createDefaultBridgeDeps,
  createDefaultProxySyncDeps,
  ensureBridge,
  listHttpProxyBackups,
  makeBackupPath,
  parseBridgeConfig,
  planHttpProxySync,
} from "./bridge.ts";

// ===== 常量 =====

export const COMMAND_NAME = "opencode-bridge";
export const SYNC_COMMAND_NAME = "opencode-bridge-sync";
export const RESTORE_COMMAND_NAME = "opencode-bridge-restore";

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
  /** 备份文件名时间戳来源；缺省 new Date()（测试注入固定时刻） */
  now?: () => Date;
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

/**
 * 确保桥在跑（session_start 与命令共用），不碰 settings.json。
 * 所有异常都在内部消化，不外抛；配置无效时返回 parsed: false。
 */
async function ensureBridgeRunning(
  ctx: ExtensionContext,
  deps: {
    bridge: BridgeDeps;
    helperPaths: string[];
    env: Record<string, string | undefined>;
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
    `pi 配置: 如需让模型请求走本桥，运行 /opencode-bridge-sync（人工确认 + 自动备份 settings.json）`,
  ];
}

/** /opencode-bridge-sync 的确认弹窗文案（纯函数，便于测试断言）。 */
export function formatSyncConfirmMessage(plan: HttpProxySyncPlan, settingsPath: string, backupPath: string): string {
  const verb = plan.action === ProxySyncActions.SET ? `写入 httpProxy: ${plan.proxyUrl}` : "移除 httpProxy";
  return [
    `即将修改 settings.json：${verb}`,
    `仅改动 httpProxy 字段，其余配置不动`,
    `修改前原文件备份到 ${backupPath}`,
    `文件：${settingsPath}；重启 Pi 后生效`,
  ].join("\n");
}

/** /opencode-bridge-restore 的确认弹窗文案（纯函数，便于测试断言）。 */
export function formatRestoreConfirmMessage(backupPath: string, settingsPath: string, currentBackupPath: string): string {
  return [
    `即将把 settings.json 恢复为所选备份的内容：${backupPath}`,
    `恢复前当前配置先备份到 ${currentBackupPath}（恢复操作本身可撤销）`,
    `文件：${settingsPath}；重启 Pi 后生效`,
  ].join("\n");
}

// ===== 扩展入口 =====

export function createOpencodeBridgeExtension(pi: ExtensionAPI, deps: BridgeExtensionDeps = {}): void {
  const bridgeDeps = deps.bridge ?? createDefaultBridgeDeps();
  const proxySyncDeps = deps.proxySync ?? createDefaultProxySyncDeps();
  const env = deps.env ?? process.env;
  const helperPaths =
    deps.helperPaths ?? resolveHelperCandidates(deps.metaUrl ?? (import.meta as unknown as { url?: string }).url);
  const settingsPath = deps.settingsPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json");
  const now = deps.now ?? (() => new Date());

  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureBridgeRunning(ctx, {
        bridge: bridgeDeps,
        helperPaths,
        env,
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
        const state = await ensureBridgeRunning(ctx, {
          bridge: bridgeDeps,
          helperPaths,
          env,
          reportError: false,
        });
        if (!state.parsed) return;
        notify(ctx, formatStatusLines(state.config, state.alive, state.note).join("\n"), state.alive ? "info" : "warning");
      } catch (err) {
        notify(ctx, `opencode-bridge 异常已忽略：${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });

  pi.registerCommand(SYNC_COMMAND_NAME, {
    description: "修改 settings.json 的 httpProxy 指向本桥（人工确认 + 自动备份，仅改 httpProxy 字段）",
    handler: async (_args, ctx) => {
      try {
        const state = await ensureBridgeRunning(ctx, {
          bridge: bridgeDeps,
          helperPaths,
          env,
          reportError: false,
        });
        if (!state.parsed) return;

        const planned = planHttpProxySync(
          { settingsPath, proxyUrl: state.config.proxyUrl, bridgeAlive: state.alive },
          proxySyncDeps,
        );
        if (!planned.ok) {
          notify(ctx, `opencode-bridge-sync：${planned.message}`, "error");
          return;
        }
        const plan = planned.plan;
        if (plan.action === ProxySyncActions.NOOP || plan.action === ProxySyncActions.FOREIGN) {
          notify(ctx, `opencode-bridge-sync：${plan.message}，settings.json 未改动`, plan.action === ProxySyncActions.FOREIGN ? "warning" : "info");
          return;
        }

        if (!ctx.hasUI) {
          notify(ctx, "opencode-bridge-sync 需要图形确认，请在 TUI 中运行此命令", "warning");
          return;
        }

        const backupPath = makeBackupPath(settingsPath, now());
        let confirmed = false;
        try {
          confirmed = await ctx.ui.confirm("opencode-bridge：修改 settings.json？", formatSyncConfirmMessage(plan, settingsPath, backupPath));
        } catch (err) {
          notify(ctx, `opencode-bridge-sync 确认框异常已忽略：${err instanceof Error ? err.message : String(err)}`, "warning");
          return;
        }
        if (!confirmed) {
          notify(ctx, "已取消，settings.json 未改动", "info");
          return;
        }

        const applied = applyHttpProxySync(plan, { settingsPath, backupPath }, proxySyncDeps);
        notify(ctx, `opencode-bridge-sync：${applied.message}`, applied.ok ? "info" : "error");
      } catch (err) {
        notify(ctx, `opencode-bridge-sync 异常已忽略：${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });

  pi.registerCommand(RESTORE_COMMAND_NAME, {
    description: "从备份恢复 settings.json（人工确认；恢复前先备份当前配置）",
    handler: async (_args, ctx) => {
      try {
        if (!ctx.hasUI) {
          notify(ctx, "opencode-bridge-restore 需要图形选择，请在 TUI 中运行此命令", "warning");
          return;
        }

        const backups = listHttpProxyBackups(settingsPath, proxySyncDeps);
        if (backups.length === 0) {
          notify(ctx, `opencode-bridge-restore：没有可用的备份（${settingsPath}.bak-opencode-bridge-*）`, "warning");
          return;
        }

        let selected: string | undefined;
        try {
          selected = await ctx.ui.select(
            "选择要恢复的备份（最新在前）：",
            backups.map((p) => path.basename(p)),
          );
        } catch (err) {
          notify(ctx, `opencode-bridge-restore 选择框异常已忽略：${err instanceof Error ? err.message : String(err)}`, "warning");
          return;
        }
        if (!selected) {
          notify(ctx, "已取消，settings.json 未改动", "info");
          return;
        }
        const backupPath = path.join(path.dirname(settingsPath), selected);

        const currentBackupPath = makeBackupPath(settingsPath, now());
        let confirmed = false;
        try {
          confirmed = await ctx.ui.confirm(
            "opencode-bridge：恢复 settings.json？",
            formatRestoreConfirmMessage(backupPath, settingsPath, currentBackupPath),
          );
        } catch (err) {
          notify(ctx, `opencode-bridge-restore 确认框异常已忽略：${err instanceof Error ? err.message : String(err)}`, "warning");
          return;
        }
        if (!confirmed) {
          notify(ctx, "已取消，settings.json 未改动", "info");
          return;
        }

        const applied = applyRestore({ backupPath, settingsPath, currentBackupPath }, proxySyncDeps);
        notify(ctx, `opencode-bridge-restore：${applied.message}`, applied.ok ? "info" : "error");
      } catch (err) {
        notify(ctx, `opencode-bridge-restore 异常已忽略：${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    },
  });
}

export default function opencodeBridge(pi: ExtensionAPI): void {
  createOpencodeBridgeExtension(pi);
}
