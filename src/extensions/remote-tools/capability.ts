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

import { type TargetInput, parseTarget } from "./ssh.ts";

/** 收集频道（跨扩展契约；升级形状用新频道 v2，不做版本字段）。 */
export const SHELL_CAPABILITY_CHANNEL = "pi-extensions:shell-capability:v1";

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
