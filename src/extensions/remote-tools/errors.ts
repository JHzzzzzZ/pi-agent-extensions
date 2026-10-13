/*
 * remote-tools — 错误码单源。
 *
 * 约定（AGENTS.md 代码约定）：错误码用 `as const` 对象 + 判别联合，不用 enum；
 * 消息一律为静态模板，绝不插值远端路径内容或用户输入，避免把远端内容回灌进模型上下文。
 */

export const ErrorCodes = {
	/** remote 参数形态非法（前导 -、空格、多 @、内嵌端口等）。 */
	INVALID_REMOTE_TARGET: "INVALID_REMOTE_TARGET",
	/** remotePort 非法（非整数 / 越界）或缺少配套的 remote。 */
	INVALID_REMOTE_PORT: "INVALID_REMOTE_PORT",
	/** 远端路径不是绝对 POSIX 路径（相对路径、Windows 路径、~ 形式都拒绝）。 */
	REMOTE_PATH_NOT_ABSOLUTE: "REMOTE_PATH_NOT_ABSOLUTE",
	/** ssh 连接层失败：客户端缺失、未知主机指纹、认证失败、连接被拒。 */
	SSH_CONNECT_FAILED: "SSH_CONNECT_FAILED",
	/** ssh 调用超时（连接或命令超过 timeout）。 */
	SSH_TIMEOUT: "SSH_TIMEOUT",
	/** 远端路径不存在。 */
	REMOTE_NOT_FOUND: "REMOTE_NOT_FOUND",
	/** 远端路径存在但不是目录（ls/find 的目录探针；read 的「是目录」仍报 REMOTE_NOT_READABLE）。 */
	REMOTE_NOT_DIRECTORY: "REMOTE_NOT_DIRECTORY",
	/** 远端路径不可读。 */
	REMOTE_NOT_READABLE: "REMOTE_NOT_READABLE",
	/** 远端路径不可写。 */
	REMOTE_NOT_WRITABLE: "REMOTE_NOT_WRITABLE",
	/** 远端写入失败（mkdir/writeFile）。 */
	REMOTE_WRITE_FAILED: "REMOTE_WRITE_FAILED",
	/** 远端命令非零退出（bash 透传退出码，此处用于内部工具调用）。 */
	REMOTE_COMMAND_FAILED: "REMOTE_COMMAND_FAILED",
	/** 远端目录上下文（dir-context 的自动注入）取回失败：解析/ssh/非零退出/远端缺 `base64`（协议 v2）。消费方据此退回一行提示。 */
	REMOTE_CONTEXT_FAILED: "REMOTE_CONTEXT_FAILED",
	/**
	 * 同上，但原因是**链上候选存在却读不出**（权限，`dir-context-todo#7`/`#8`）。
	 * 单独一个码的理由：消费方的下一步动作与通用失败不同（去修权限，而不是自己去 read）；
	 * 消息文本不参与判定，此值由契约 `docs/cross/remote-context-capability.md` 固定。
	 */
	REMOTE_CONTEXT_UNREADABLE: "REMOTE_CONTEXT_UNREADABLE",
	/** 标记根锚定的文件缺失或被替换（本地路径信道的前提被破坏）⇒ 远端调用 fail-closed。 */
	HOST_MARKER_CONFLICT: "HOST_MARKER_CONFLICT",
	/** job 托管端口不符合跨扩展契约（形状或返回值非法，见 docs/cross/shell-tool-capability.md）。 */
	REMOTE_JOB_PORT_INVALID: "REMOTE_JOB_PORT_INVALID",
	/** 远端超时转后台失败（登记 job 时端口抛错）：已断开本地 ssh，远端命令可能仍在运行。 */
	REMOTE_BACKGROUND_FAILED: "REMOTE_BACKGROUND_FAILED",
	/** strict 白名单开着，而目标既不是已登记别名也不匹配任何条目的展开目标（remote-tools#2）。 */
	UNKNOWN_REMOTE_TARGET: "UNKNOWN_REMOTE_TARGET",
	/** 目标与多个已登记条目歧义（同一主机登记了多条且无法用 user/port 区分）——fail-closed，绝不按序挑一个。 */
	AMBIGUOUS_REMOTE_TARGET: "AMBIGUOUS_REMOTE_TARGET",
	/** 目标登记表读不出或形态非法——fail-closed，绝不静默当空表（那会静默全拒）。 */
	REMOTE_TARGETS_UNREADABLE: "REMOTE_TARGETS_UNREADABLE",
	/** 别名已存在（覆盖要显式 force；模型侧永远不 force）。 */
	REMOTE_TARGET_EXISTS: "REMOTE_TARGET_EXISTS",
	/** 要删/要改的别名不在登记表里。 */
	REMOTE_TARGET_UNKNOWN: "REMOTE_TARGET_UNKNOWN",
	/** 登记表落盘失败（目录权限等）。 */
	REMOTE_TARGETS_WRITE_FAILED: "REMOTE_TARGETS_WRITE_FAILED",
} as const;

export type RemoteToolsErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** 本插件的失败结果（沿用仓库 result union 约定）。 */
export type RemoteToolsFailure = { ok: false; code: RemoteToolsErrorCode; message: string };

export function failure(code: RemoteToolsErrorCode, message: string): RemoteToolsFailure {
	return { ok: false, code, message };
}
