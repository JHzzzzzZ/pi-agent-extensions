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
	/** 远端路径不可读。 */
	REMOTE_NOT_READABLE: "REMOTE_NOT_READABLE",
	/** 远端路径不可写。 */
	REMOTE_NOT_WRITABLE: "REMOTE_NOT_WRITABLE",
	/** 远端写入失败（mkdir/writeFile）。 */
	REMOTE_WRITE_FAILED: "REMOTE_WRITE_FAILED",
	/** 远端命令非零退出（bash 透传退出码，此处用于内部工具调用）。 */
	REMOTE_COMMAND_FAILED: "REMOTE_COMMAND_FAILED",
} as const;

export type RemoteToolsErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** 本插件的失败结果（沿用仓库 result union 约定）。 */
export type RemoteToolsFailure = { ok: false; code: RemoteToolsErrorCode; message: string };

export function failure(code: RemoteToolsErrorCode, message: string): RemoteToolsFailure {
	return { ok: false, code, message };
}
