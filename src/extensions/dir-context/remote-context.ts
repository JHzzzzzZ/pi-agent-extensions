/**
 * dir-context — 远端目录上下文的消费方：能力握手 + 请求/结果形状守卫（工单 dir-context-todo#6）。
 *
 * 本扩展不会 ssh、也解不了远端路径（`#4` 的根因），所以「取文件」这件事交给能 ssh 的那一侧
 * （remote-tools）。通道用宿主官方 `pi.events` 做一次能力协商（与 shell 能力同构，权威契约：
 * `docs/cross/remote-context-capability.md`）：本扩展在 `session_start` 广播一个**可变盒子**，
 * 提供方在同步回调里把 `fetchRemoteContext` 放进去。
 *
 * 双方不互相 import、各自实现形状守卫；没有提供方（没装 remote-tools / 载荷畸形）⇒ 退回
 * 「一行提示」，行为与 `#4` 之后逐字一致。
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

import type { ContextFileContent } from "./inject.ts";

/** 收集频道（跨扩展契约；升级形状用新频道 v2，不做版本字段）。 */
export const REMOTE_CONTEXT_CHANNEL = "pi-extensions:dir-context-remote-context:v1";

/** 远端取回的单个上下文文件。 */
export interface RemoteContextFile {
  /** 远端绝对路径。 */
  path: string;
  content: string;
}

export interface RemoteContextRequest {
  /** 模型给的 ssh 目标（原文，可能含 `user@`）。 */
  remote: string;
  remotePort?: number | undefined;
  /** 模型给的原始路径（可能省略/相对/绝对 POSIX）。 */
  path?: string | undefined;
  /** 触碰类型：目录类触碰把该路径自身当锚点，文件类退到父目录。 */
  kind: "file" | "directory";
}

export type RemoteContextOutcome =
  | { ok: true; dir: string; files: RemoteContextFile[] }
  | { ok: false; code: string; message: string };

export interface RemoteContextCapability {
  fetchRemoteContext(request: RemoteContextRequest): Promise<RemoteContextOutcome>;
}

export interface RemoteContextOffer {
  /** 拿到的能力；null = 没有提供方或载荷不可用。 */
  capability: RemoteContextCapability | null;
  /** 需要 notify 一次的问题（畸形载荷 / 总线抛错）；正常为 null。 */
  warning: string | null;
}

/**
 * 广播收集请求并校验回来的载荷。盒子里外都是别的扩展的对象：形状不对就当「没有能力」，
 * 总线抛错就当「没装对端」——两条路都退回本扩展原行为，绝不因协商失败破坏会话。
 */
export function collectRemoteContext(events: EventBus | undefined): RemoteContextOffer {
  if (events === undefined) return { capability: null, warning: null };
  const box: { remoteContext?: unknown } = {};
  try {
    events.emit(REMOTE_CONTEXT_CHANNEL, box);
  } catch {
    return { capability: null, warning: "远端上下文能力协商失败（事件总线调用出错）：远端调用仍按「零注入 + 一行提示」处理。" };
  }
  if (box.remoteContext === undefined) return { capability: null, warning: null };
  const capability = toCapability(box.remoteContext);
  if (capability === null) {
    return { capability: null, warning: "忽略畸形远端上下文能力载荷（形状不符合跨扩展契约）：远端调用仍按「零注入 + 一行提示」处理。" };
  }
  return { capability, warning: null };
}

/**
 * 载荷只保留契约字段，函数用薄包装隔离：调用一律包 try/catch 并把结果收敛成带 `ok` 标签的形状
 * —— 对端抛错/返回垃圾都只导致「本次不注入 + 一行提示」，绝不打断工具结果。
 */
function toCapability(value: unknown): RemoteContextCapability | null {
  if (typeof value !== "object" || value === null) return null;
  const fetchRemoteContext = (value as { fetchRemoteContext?: unknown }).fetchRemoteContext;
  if (typeof fetchRemoteContext !== "function") return null;
  return {
    async fetchRemoteContext(request) {
      try {
        const outcome: unknown = await fetchRemoteContext(request);
        const parsed = toOutcome(outcome);
        if (parsed !== null) return parsed;
      } catch {
        /* 落到下面的统一失败 */
      }
      return { ok: false, code: "REMOTE_CONTEXT_UNUSABLE", message: "远端上下文：能力返回了不符合契约的结果，本次跳过。" };
    },
  };
}

function toOutcome(value: unknown): RemoteContextOutcome | null {
  if (typeof value !== "object" || value === null) return null;
  const { ok, dir, files, code, message } = value as Record<string, unknown>;
  if (ok === false) {
    if (typeof code !== "string" || typeof message !== "string") return null;
    return { ok: false, code, message };
  }
  if (ok !== true || typeof dir !== "string" || !Array.isArray(files)) return null;
  const parsed: RemoteContextFile[] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) continue;
    const { path, content } = entry as Record<string, unknown>;
    if (typeof path === "string" && path.length > 0 && typeof content === "string") parsed.push({ path, content });
  }
  return { ok: true, dir, files: parsed };
}

/**
 * 取回的文件 → 注入条目的形状（交给 `inject.ts` 的去重键/预算/块格式，规则只有一份）。
 *
 * - 去重键加 `remote:` 前缀：与本地绝对路径**分属两个命名空间**（同一台机的远端路径和本机路径
 *   字符串上可能一模一样，比如都是 `/srv/app/AGENTS.md`）。
 * - 展示路径 = `<host>:<远端绝对路径>`，块头据此自报来源（用户要求，避免把远端约定当本机约定）。
 * - 只收 host 部分做展示：`user@host` 原样保留（它就是这次调用的目标身份）。
 */
export function toContextFiles(host: string, files: readonly RemoteContextFile[]): ContextFileContent[] {
  return files.map((file) => ({
    absolutePath: `remote:${host}\u0000${file.path}`,
    relativePath: `${host}:${file.path}`,
    sourcePath: file.path,
    remote: host,
    content: file.content,
  }));
}
