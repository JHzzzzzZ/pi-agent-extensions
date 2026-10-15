/*
 * timeout-bg — 远端 shell 的 job 托管端口（timeout-bg-todo#4，配套 remote-tools#12）
 *
 * 背景：远端 bash 命中超时后要与本地同语义——不杀 ssh、输出继续落本地日志、进统一 job 面
 * （/bg、/bg:kill、/bg:clear、状态条段）——但远端执行在 remote-tools 手里、job 注册表在本扩展
 * 手里。方案：本扩展（job owner）在 `pi.events` 的托管频道上**应答索取**：提供方同步 emit 一个
 * 盒子，本扩展在回调里填 `box.host` 把端口交出去；不跨扩展 import，任一扩展单独安装都照常工作。
 *
 * 契约（权威卡：docs/cross/shell-tool-capability.md）：
 *   频道名 `pi-extensions:shell-job-host:v1`；盒子 `{ host?: RemoteJobPort }`；先到先得；
 *   形状守卫两侧各自实现（本侧保证不放畸形端口进去，对端保证拒绝畸形端口）。
 * 加法式扩展：`registerBackground` 是 timeout-bg-todo#5 新增的方法——旧提供方不调用它、
 * 新提供方探测不到就 fail-closed，双向都安全，所以不开 v2 频道。
 *
 * 端口语义（谁做什么）：
 *   - `allocate()`：发号 + 给本地日志路径。命令**开始前**调用（远端要先把 pid 写进文件供
 *     /bg:kill 用、输出要全量落盘），但只有真的转后台才 `register` / `registerBackground`
 *     （与本地 job 同一套 id 序列）。
 *   - `register()`：命中超时——登记为运行中的 job，并返回本次 tool call 应抛出的超时结果文本。
 *   - `registerBackground()`：调用方主动要求后台（timeout-bg-todo#5）——登记 + 返回
 *     「已直接转入后台」结果文本。两种结果文本均由本扩展单源持有（与本地逐字一致），提供方不自己拼一份。
 *   - `settle()`：命令自然结束时更新退出码并触发完成通知（已被 /bg:kill 的忽略）。
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { JobRecord, JobRegistry } from "./jobs.ts";
import { stripControlChars } from "./logs.ts";
import { firstLine } from "./text.ts";

/** 索取频道（跨扩展契约；形状升级开新频道 `…:v2`，不做版本字段）。 */
export const SHELL_JOB_HOST_CHANNEL = "pi-extensions:shell-job-host:v1";

/** 跨扩展边界上进入模型可见文本的尾部上限（字符；与本地超时结果的尾部口径一致）。 */
export const REMOTE_TAIL_MAX_CHARS = 2000;

/** 一次远端转后台的登记信息（`id`/`logPath` 来自 `allocate()`）。 */
export interface RemoteJobRegistration {
  id: string;
  logPath: string;
  /** 原始命令（首行截断由本侧按本地口径做）。 */
  command: string;
  /** 目标主机展示形态（`[user@]host`）。 */
  target: string;
  /** 本次调用生效的超时秒数（仅超时路径有；结果文本用）。 */
  timeoutSeconds: number;
  /** 命令开始到转后台那一刻的最近输出（本侧剔控制字符并限长后再渲染）。 */
  tail: string;
  /** 尽力终止远端进程组 + 断开本地 ssh（由提供方实现）。 */
  terminate: () => void;
}

/** 主动转后台的登记信息：同形，但没有「生效超时秒数」（后台任务不受超时约束）。 */
export type RemoteBackgroundRegistration = Omit<RemoteJobRegistration, "timeoutSeconds">;

/** 命令开始前发的号：id 全局唯一（与本地 job 同序列），logPath 在本地日志根下。 */
export interface RemoteJobTicket {
  id: string;
  logPath: string;
}

export interface RemoteJobPort {
  allocate(): RemoteJobTicket;
  register(job: RemoteJobRegistration): string;
  /** 主动后台（#5 新增；提供方探测不到本方法时 fail-closed，不静默跟前台）。 */
  registerBackground(job: RemoteBackgroundRegistration): string;
  settle(id: string, exitCode: number | null): void;
}

export interface RemoteJobPortDeps {
  /** 发号（与本地 job 共用一个序列，/bg 里只有一个号段）。 */
  newJobId: () => string;
  /** 日志路径（唯一算法在 logs.ts：`<logRoot>/<pi pid>/<id>.log`，本地远端同布局）。 */
  logPathFor: (id: string) => string;
  registry: JobRegistry;
  /** 超时结果文本（text.ts 的模板；本侧是唯一持有者）。 */
  timeoutText: (seconds: number, job: JobRecord, tail: string) => string;
  /** 主动后台的结果文本（同上，本侧唯一持有者）。 */
  backgroundText: (job: JobRecord) => string;
}

/** 跨扩展边界的登记载荷 → 注册表条目：只信形状，不信类型（与本地 job 同口径过滤）。 */
function toJobInput(job: RemoteBackgroundRegistration, origin: "timeout" | "background") {
  return {
    id: job.id,
    pid: null,
    command: firstLine(stripControlChars(job.command), 400),
    logPath: job.logPath,
    target: stripControlChars(job.target),
    // terminate 不是函数就当没有（宁可不杀、不抛错）。
    terminate: typeof job.terminate === "function" ? job.terminate : undefined,
    origin,
  };
}

export function createRemoteJobPort(deps: RemoteJobPortDeps): RemoteJobPort {
  return {
    allocate() {
      const id = deps.newJobId();
      return { id, logPath: deps.logPathFor(id) };
    },
    register(job) {
      // 入参跨扩展而来：只信形状，不信任类型；进 /bg 列表与通知的文字先剔控制字符
      // （与本地 job 的 command 截断口径一致）。
      const record = deps.registry.background(toJobInput(job, "timeout"));
      const tail = stripControlChars(job.tail).slice(-REMOTE_TAIL_MAX_CHARS).trimEnd();
      return deps.timeoutText(job.timeoutSeconds, record, tail);
    },
    registerBackground(job) {
      const record = deps.registry.background(toJobInput(job, "background"));
      return deps.backgroundText(record);
    },
    settle(id, exitCode) {
      deps.registry.markExited(id, exitCode);
    },
  };
}

/**
 * 应答托管端口索取。提供方（remote-tools）在需要 job 托管时同步 emit 一个空盒子，
 * 本扩展在回调里填入端口；槽位已有主不覆盖，盒子/总线异常一律静默（当作没提供）。
 *
 * 返回退订函数：会话启动时登记、会话关闭时退订（见 index.ts）。不这么做的话，`/reload` 后
 * 旧实例的回调可能还挂在总线上，而盒子是**先到先得**——新提供方会拿到旧注册表里的死端口
 * （job 不进 /bg、不发通知），比「没有托管」更难查。
 */
export function offerRemoteJobPort(events: EventBus | undefined, port: RemoteJobPort): () => void {
  if (events === undefined) return () => undefined;
  try {
    return events.on(SHELL_JOB_HOST_CHANNEL, (box) => {
      try {
        if (typeof box !== "object" || box === null) return;
        const slot = box as { host?: unknown };
        if (slot.host !== undefined) return;
        slot.host = port;
      } catch {
        /* 盒子不可写：当作没提供能力 */
      }
    });
  } catch {
    // 没有事件总线：托管不可用，提供方按原行为工作。
    return () => undefined;
  }
}
