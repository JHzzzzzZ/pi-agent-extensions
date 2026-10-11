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
	/** 远端目录上下文（dir-context 的自动注入）取回失败：解析/ssh/非零退出，或链上候选存在但读不出（权限，`dir-context-todo#7`）。消费方据此退回一行提示。 */
	REMOTE_CONTEXT_FAILED: "REMOTE_CONTEXT_FAILED",
	/** 标记根锚定的文件缺失或被替换（本地路径信道的前提被破坏）⇒ 远端调用 fail-closed。 */
	HOST_MARKER_CONFLICT: "HOST_MARKER_CONFLICT",
	/** job 托管端口不符合跨扩展契约（形状或返回值非法，见 docs/cross/shell-tool-capability.md）。 */
	REMOTE_JOB_PORT_INVALID: "REMOTE_JOB_PORT_INVALID",
	/** 远端超时转后台失败（登记 job 时端口抛错）：已断开本地 ssh，远端命令可能仍在运行。 */
	REMOTE_BACKGROUND_FAILED: "REMOTE_BACKGROUND_FAILED",
} as const;

export type RemoteToolsErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** 本插件的失败结果（沿用仓库 result union 约定）。 */
export type RemoteToolsFailure = { ok: false; code: RemoteToolsErrorCode; message: string };

export function failure(code: RemoteToolsErrorCode, message: string): RemoteToolsFailure {
	return { ok: false, code, message };
}
