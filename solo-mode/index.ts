/**
 * solo-mode - 免审批模式（审批门自动批准）扩展
 *
 * `/solo` 一键切换 solo 模式：开启后，本仓库"审批摩擦类"门自动走批准路径——
 * PWR 批准卡（自动按 once）、opencode-bridge 的 sync / 端口切换 / restore 确认
 * （restore 自动选最新备份）、deep-init 的 `--create-new` 二次确认。
 * 误触保护类确认（如 agent-team viewer `D` 停止）不在范围内，保持人工。
 *
 * 跨扩展契约（docs/cross/solo-approval-gate.md）：状态写在本进程独占文件
 * `${PI_SOLO_MODE_FILE:-~/.pi/agent/solo-mode.json}`，内容 `{pid, activatedAt}`；
 * 读者（pwr / opencode-bridge / deep-init 各自的 solo-gate.ts）校验
 * `pid === process.pid` 才视为激活——损坏/缺失/异 pid 一律 fail-closed。
 * 因此子 pi 进程（PWR sub-agent、agent-team 成员、loop --bg）天然不继承 solo；
 * 崩溃残留文件在下次启动因 pid 不匹配而失效。
 *
 * 生命周期：仅当前会话有效。`session_start`（含 /reload、/new、/resume、/fork）
 * 与 `session_shutdown` 都清掉本进程的状态文件与状态条；关闭时命令直接生效，
 * 开启时先经一次 `ctx.ui.confirm` 防误触，无 UI 环境拒绝激活（fail-closed）。
 *
 * 安全边界：只豁免"审批摩擦"，绝不自动批准误触保护类确认；对 PWR 只产生 once
 * 批准，绝不写 remembered 记录；solo 关闭后既有 remembered 批准不受影响。
 * 状态文件读写/UI 调用全部异常隔离，任何失败都不破坏会话。
 *
 * 安装:复制本目录到 ~/.pi/agent/extensions/solo-mode/ 或
 *      <项目>/.pi/extensions/solo-mode/,在 Pi 中执行 /reload。卸载即删除目录。
 * 测试:node --experimental-strip-types --test solo-mode/index.test.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ===== 常量 =====

/** 状态文件路径覆盖环境变量（测试隔离 / 多实例隔离） */
export const SOLO_STATE_FILE_ENV = "PI_SOLO_MODE_FILE";
/** 状态条键（每扩展一个；带 `40:` 排序前缀，见 docs/cross/status-bar.md） */
export const SOLO_STATUS_KEY = "40:solo-mode";
/** 段分隔前缀（跨插件契约 docs/cross/status-bar.md）：每段状态文本以 `│ ` 开头 */
export const STATUS_SEPARATOR = "│ ";
/** 状态条文本（纯字符串,宿主 ExtensionUIContext 无 theme 字段） */
export const SOLO_STATUS_TEXT = "⚡ solo";
/** 命令行用法 */
export const SOLO_USAGE = [
  "用法：",
  "  /solo          切换 solo 模式（开启需确认）",
  "  /solo:on       开启：危险操作将自动批准",
  "  /solo:off      关闭",
  "  /solo:status   查看当前状态",
].join("\n");

/** 冒号子命令（v1.2.0）：独立静态注册命令名。 */
export const SOLO_SUBCOMMANDS = {
  on: "solo:on",
  off: "solo:off",
  status: "solo:status",
} as const;

/**
 * 旧空格子命令 → 新命令 + 用法。裸 `/solo` 命中时只提示改名、绝不执行
 * （防止 `/solo on` 被误当一次切换——切换的隐式语义与显式开启方向相反）。
 */
export const RETIRED_SOLO_SUBCOMMANDS: Record<string, { command: string; usage: string }> = {
  on: { command: SOLO_SUBCOMMANDS.on, usage: "/solo:on" },
  off: { command: SOLO_SUBCOMMANDS.off, usage: "/solo:off" },
  status: { command: SOLO_SUBCOMMANDS.status, usage: "/solo:status" },
};
/** 开启确认正文（静态文案,列出受影响审批门） */
export const SOLO_CONFIRM_BODY = [
  "开启后以下审批门将自动批准（仅当前会话，/reload 或会话切换即复位）：",
  "· PWR 批准卡 → 按 once 自动批准",
  "· opencode-bridge sync / 端口切换 / restore 确认 → 自动确认（restore 自动选最新备份）",
  "· deep-init --create-new 二次确认 → 自动放行",
  "agent-team viewer D 停止等误触保护确认不受影响。",
].join("\n");

// ===== 类型 =====

/** 命令动作：空参＝切换，其余一律 usage（管理词已拆为冒号命令） */
export type SoloAction = "toggle" | "usage";

export interface SoloState {
  pid: number;
  activatedAt: string;
}

export interface SoloModeDeps {
  /** 环境变量表（测试用）；缺省 `process.env` */
  env?: Record<string, string | undefined>;
  /** 进程号（测试用）；缺省 `process.pid` */
  pid?: number;
  /** 注入时钟（测试用）；缺省 `Date.now` 的 ISO 串 */
  nowIso?: () => string;
}

// ===== 纯函数:命令解析 / 状态文件读写 =====

/** 解析裸 `/solo` 参数：空参＝切换，其余（含旧管理词）＝usage（非抛错） */
export function parseSoloCommand(raw: unknown): SoloAction {
  const token = String(raw ?? "").trim();
  if (token === "") return "toggle";
  return "usage";
}

/** 状态文件路径：`PI_SOLO_MODE_FILE` 优先，缺省 `~/.pi/agent/solo-mode.json` */
export function resolveSoloStatePath(env: Record<string, string | undefined> = process.env): string {
  const override = env?.[SOLO_STATE_FILE_ENV];
  if (typeof override === "string" && override.trim() !== "") return override;
  return path.join(os.homedir(), ".pi", "agent", "solo-mode.json");
}

/**
 * 读取本进程的 solo 状态。fail-closed：文件缺失、不可读、JSON 损坏或
 * pid 不匹配（含子进程、崩溃残留）一律返回 undefined。
 */
export function readSoloState(
  options: { env?: Record<string, string | undefined>; pid?: number } = {},
): SoloState | undefined {
  const pid = options.pid ?? process.pid;
  try {
    const raw = fs.readFileSync(resolveSoloStatePath(options.env), "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; activatedAt?: unknown };
    if (parsed?.pid !== pid) return undefined;
    return { pid, activatedAt: typeof parsed.activatedAt === "string" ? parsed.activatedAt : "" };
  } catch {
    return undefined;
  }
}

/** 是否处于 solo 模式（本进程） */
export function isSoloActive(options: { env?: Record<string, string | undefined>; pid?: number } = {}): boolean {
  return readSoloState(options) !== undefined;
}

/** 写入状态文件；失败抛错由调用方 fail-closed 处理 */
export function writeSoloState(filePath: string, state: SoloState): void {
  fs.writeFileSync(filePath, JSON.stringify(state), "utf8");
}

/** 删除状态文件；返回是否删除成功（缺失视为成功） */
export function clearSoloState(filePath: string): boolean {
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ===== 扩展工厂 =====

/** 最小 UI 面（结构 fake 友好） */
interface SoloUi {
  hasUI?: boolean;
  ui?: {
    confirm?: (title: string, message?: string) => Promise<boolean>;
    notify?: (message: string, type?: string) => void;
    setStatus?: (key: string, text?: string) => void;
  };
}

export function createSoloModeExtension(pi: ExtensionAPI, deps: SoloModeDeps = {}): void {
  const env = deps.env ?? process.env;
  const pid = deps.pid ?? process.pid;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const statePath = resolveSoloStatePath(env);

  function notify(ctx: SoloUi, message: string, type: "info" | "warning" | "error"): void {
    try {
      ctx?.ui?.notify?.(message, type);
    } catch {
      /* 忽略 */
    }
  }

  function setStatus(ctx: SoloUi, text: string | undefined): void {
    try {
      if (!ctx?.hasUI) return;
      ctx.ui?.setStatus?.(SOLO_STATUS_KEY, text === undefined ? undefined : STATUS_SEPARATOR + text);
    } catch {
      /* 忽略 */
    }
  }

  /** 开启：需 UI 确认，写失败则保持关闭（fail-closed） */
  async function activate(ctx: SoloUi): Promise<void> {
    if (!ctx?.hasUI || typeof ctx.ui?.confirm !== "function") {
      notify(ctx, "solo 模式需要图形确认，请在 TUI 中运行 /solo", "warning");
      return;
    }
    let confirmed = false;
    try {
      confirmed = await ctx.ui.confirm("启用 solo 模式？", SOLO_CONFIRM_BODY);
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      notify(ctx, "已取消，solo 模式未启用", "info");
      return;
    }
    try {
      writeSoloState(statePath, { pid, activatedAt: nowIso() });
    } catch {
      notify(ctx, "solo 模式启用失败：状态文件无法写入，保持关闭", "error");
      return;
    }
    setStatus(ctx, SOLO_STATUS_TEXT);
    notify(ctx, "solo 模式已启用：危险操作将自动批准（仅当前会话）", "info");
  }

  /** 关闭：删除状态文件（删除失败明确告警,避免"以为关了"） */
  function deactivate(ctx: SoloUi): void {
    const cleared = clearSoloState(statePath);
    setStatus(ctx, undefined);
    if (cleared) notify(ctx, "solo 模式已关闭：审批门恢复人工确认", "info");
    else notify(ctx, "solo 模式关闭失败：状态文件无法删除，审批门可能仍自动批准", "error");
  }

  /** `/solo:status`：当前状态文案。 */
  function showStatus(ui: SoloUi): void {
    notify(ui, isSoloActive({ env, pid }) ? "solo 模式已启用（危险操作自动批准）" : "solo 模式未启用", "info");
  }

  /**
   * 裸 `/solo`（命令面冒号化 v1.2.0）：空参＝切换；旧管理词（on/off/status）
   * 只提示改名、绝不执行；其余参数提示用法。
   */
  pi.registerCommand("solo", {
    description: "切换 solo 免审批模式（危险操作自动批准；仅当前会话）；子命令为独立冒号命令：/solo:on|off|status",
    handler: async (args, ctx) => {
      const ui = ctx as unknown as SoloUi;
      const head = String(args ?? "").trim().toLowerCase();
      const renamed = RETIRED_SOLO_SUBCOMMANDS[head];
      if (renamed) {
        notify(ui, `「/solo ${head}」已改名为「/${renamed.command}」；用法：${renamed.usage}`, "warning");
        return;
      }
      if (parseSoloCommand(args) === "usage") {
        notify(ui, SOLO_USAGE, "warning");
        return;
      }
      // toggle：以状态文件为准（跨实例共享进程则视为各自实例的）
      if (isSoloActive({ env, pid })) deactivate(ui);
      else await activate(ui);
    },
  });

  pi.registerCommand(SOLO_SUBCOMMANDS.on, {
    description: "开启 solo 模式：危险操作将自动批准（需一次确认；仅当前会话）",
    handler: async (_args, ctx) => activate(ctx as unknown as SoloUi),
  });

  pi.registerCommand(SOLO_SUBCOMMANDS.off, {
    description: "关闭 solo 模式：审批门恢复人工确认",
    handler: async (_args, ctx) => deactivate(ctx as unknown as SoloUi),
  });

  pi.registerCommand(SOLO_SUBCOMMANDS.status, {
    description: "查看 solo 模式当前状态（是否已启用）",
    handler: async (_args, ctx) => showStatus(ctx as unknown as SoloUi),
  });

  // 会话边界一律复位（/reload、/new、/resume、/fork）：仅清本进程 pid 的状态文件，
  // 绝不触碰异 pid 文件（并发 pi 实例互不干扰）。
  pi.on("session_start", async (event, ctx) => {
    try {
      const ui = ctx as unknown as SoloUi;
      const reset = isSoloActive({ env, pid });
      if (reset) clearSoloState(statePath);
      setStatus(ui, undefined);
      const reason = (event as { reason?: string } | undefined)?.reason;
      if (reset && reason === "reload") notify(ui, "solo 模式已随扩展重载复位", "info");
    } catch {
      /* 忽略 */
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (isSoloActive({ env, pid })) clearSoloState(statePath);
      setStatus(ctx as unknown as SoloUi, undefined);
    } catch {
      /* 忽略 */
    }
  });
}

export default function soloMode(pi: ExtensionAPI): void {
  createSoloModeExtension(pi);
}
