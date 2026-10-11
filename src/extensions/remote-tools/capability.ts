/*
 * remote-tools — 跨扩展 shell 能力协商（remote-tools-todo#9 的提供方一侧）。
 *
 * 背景：timeout-bg 在 `session_start` 重新注册同名 `bash`（它要管超时→后台），而宿主
 * `registerTool` 对同名工具按**扩展加载顺序 first-wins**，没有「取回下层定义再包裹」的 API。
 * 两个扩展抢一个名字必有一方静默消失（2026-10-10 用户实测：带 remote 的 bash 跑在本机）。
 *
 * 方案（B′）：shell 工具的唯一 owner（timeout-bg）在注册前用宿主官方 `pi.events` 广播一个
 * **可变盒子**，本扩展把「远端 bash 能力」同步放进去；owner 合并参数片段并按参数分派。
 * 双方不互相 import、不走 globalThis 私有槽，任一扩展单独安装都照常工作。
 *
 * 契约（权威卡：docs/cross/shell-tool-capability.md，两侧各自实现形状守卫、不共享代码）：
 *   频道名 `pi-extensions:shell-capability:v1`；盒子 `{ bash?: ShellCapability }`；
 *   载荷 `{ parameters, isRemoteCall, executeRemote, guideline }`。
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolDetails,
	BashToolInput,
	EventBus,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import { ErrorCodes } from "./errors.ts";
import { type TargetInput, parseTarget } from "./ssh.ts";

/** 收集频道（跨扩展契约；升级形状用新频道 v2，不做版本字段）。 */
export const SHELL_CAPABILITY_CHANNEL = "pi-extensions:shell-capability:v1";

/**
 * job 托管频道（跨扩展契约，remote-tools-todo#12 / timeout-bg-todo#4；见
 * docs/cross/shell-tool-capability.md「远端超时与 job 托管」）。
 *
 * 方向与上方能力频道相反：**索取方 emit 空盒子，owner 在同步回调里填 `box.host`**。
 * 本扩展在首次需要 job 托管时索取一次并缓存；没装 timeout-bg 时拿不到端口，
 * 远端超时沿用宿主原有的 kill 语义（行为与今天逐字一致）。
 */
export const SHELL_JOB_HOST_CHANNEL = "pi-extensions:shell-job-host:v1";

/** timeout-bg 暴露的 job 托管端口（本侧独立声明：不跨扩展 import）。 */
export interface RemoteJobPort {
  /** 命令开始前发号：id 与本地日志路径（日志由本侧写，通知由 owner 发）。 */
  allocate(): { id: string; logPath: string };
  /** 命中超时：登记为运行中的后台任务，返回本次 tool call 应抛出的超时结果文本。 */
  register(job: {
    id: string;
    logPath: string;
    command: string;
    target: string;
    timeoutSeconds: number;
    tail: string;
    terminate: () => void;
  }): string;
  /** 命令自然结束（远端 shell 退出）：更新退出码并触发完成通知。 */
  settle(id: string, exitCode: number | null): void;
}

/** 远端 bash 参数（schema 之外的噪声一律当未提供，与解析口径一致）。 */
export interface RemoteBashParams extends BashToolInput {
	remote?: unknown;
	remotePort?: unknown;
	remoteCwd?: unknown;
}

/** owner 合并进来的能力载荷（本扩展是唯一提供方，形状由本模块保证）。 */
export interface RemoteBashCapability {
	/** 参数片段：属性名 → TypeBox schema；owner 合并进自己的 properties。 */
	parameters: Record<string, unknown>;
	/** 这次调用是否意图走远端（形态非法也算，见下）。 */
	isRemoteCall(params: unknown): boolean;
	/** 远端分支的单一实现：本扩展的 bash 与 owner 的合并 bash 共用同一个函数。 */
	executeRemote(
		id: string,
		params: RemoteBashParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
		ctx: ExtensionToolContext | undefined,
	): Promise<AgentToolResult<BashToolDetails | undefined>>;
	/** 追加给模型的远端指南（owner 拼进 promptGuidelines）。 */
	guideline: string;
}

/** 能力载荷里的 bash 指南：owner 的文案负责本地语义，这条负责远端语义。 */
export const BASH_REMOTE_GUIDELINE =
	"bash 传 remote 时在远端主机执行（cwd = remoteCwd 或远端 $HOME），remote 省略或留空时走本机（默认超时与超时转后台仍然生效）。";

/**
 * 远端意图判定（owner 的分派闸门）：
 *   - 目标合法且非空 ⇒ 远端；
 *   - 目标形态非法（前导 `-`、空格、内嵌端口、端口越界…）⇒ **也算远端**：交给远端分支报
 *     结构化错误，绝不因为「解析失败」就静默在本机执行（`local` 是常见 ssh 别名，跑错机器更贵）；
 *   - 空串 / 缺省值字面量 / 非字符串 ⇒ 本机（与 `parseTarget` 同口径）。
 */
export function isRemoteBashCall(params: unknown): boolean {
	const source = (typeof params === "object" && params !== null ? params : {}) as TargetInput;
	const parsed = parseTarget({ remote: source.remote, remotePort: source.remotePort });
	return parsed.ok ? parsed.target !== null : true;
}

/** 盒子里的端口来自别的扩展：形状不符合契约就当「没有 owner」，绝不因畸形端口破坏会话。 */
function toRemoteJobPort(value: unknown): RemoteJobPort | null {
	if (typeof value !== "object" || value === null) return null;
	const { allocate, register, settle } = value as Record<string, unknown>;
	if (typeof allocate !== "function" || typeof register !== "function" || typeof settle !== "function") return null;
	return {
		allocate: () => {
			const ticket = allocate() as { id?: unknown; logPath?: unknown } | null | undefined;
			if (typeof ticket !== "object" || ticket === null || typeof ticket.id !== "string" || typeof ticket.logPath !== "string") {
				throw new Error(`${ErrorCodes.REMOTE_JOB_PORT_INVALID}: job 托管端口返回了非法 job 句柄。`);
			}
			return { id: ticket.id, logPath: ticket.logPath };
		},
		register: (job) => {
			const text = register(job);
			if (typeof text !== "string") throw new Error(`${ErrorCodes.REMOTE_JOB_PORT_INVALID}: job 托管端口未返回超时结果文本。`);
			return text;
		},
		settle: (id, exitCode) => {
			settle(id, exitCode);
		},
	};
}

/**
 * 索取 job 托管端口：同步 emit 一个空盒子，owner（timeout-bg）在回调里填 `box.host`。
 * 没装 owner / 总线抛错 / 载荷畸形 ⇒ 返回 null（调用方按「无托管」原行为工作）。
 */
export function claimRemoteJobHost(events: EventBus | undefined): RemoteJobPort | null {
	if (events === undefined) return null;
	const box: { host?: unknown } = {};
	try {
		events.emit(SHELL_JOB_HOST_CHANNEL, box);
	} catch {
		return null;
	}
	return toRemoteJobPort(box.host);
}

/**
 * 订阅收集频道并把能力放进盒子。盒子里外都是别人的对象，形状守卫 + 异常隔离都在这里：
 * 盒子不是对象 ⇒ 忽略；槽位已有主 ⇒ 先到先得（不覆盖别的提供方）；订阅注册本身失败
 * （宿主没有事件总线 / 旧版本）⇒ 静默跳过，本扩展自己注册的 bash 仍然照常工作。
 */
export function offerBashCapability(events: EventBus | undefined, capability: RemoteBashCapability): void {
	if (events === undefined) return;
	try {
		events.on(SHELL_CAPABILITY_CHANNEL, (box) => {
			try {
				if (typeof box !== "object" || box === null) return;
				const slot = box as { bash?: unknown };
				if (slot.bash !== undefined) return;
				slot.bash = capability;
			} catch {
				/* 盒子不可写：当作没提供能力 */
			}
		});
	} catch {
		/* 没有事件总线：协商不可用，行为退回「各自注册」（本扩展的 bash 仍在） */
	}
}
