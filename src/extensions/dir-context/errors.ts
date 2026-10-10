/**
 * dir-context 错误码（本层自己的错误码集，见 AGENTS.md「结果联合优先于异常」）。
 *
 * 本扩展的失败模式设计为 **fail-open 降级**：任何解析/读取失败都只是「这次不注入」，
 * 绝不改坏原工具结果。因此错误码只覆盖「本该注入却读不出来」这类需要可观测的故障，
 * 而「不在作用域内 / 没有候选文件」是正常路径（返回 null），不是错误。
 */

export const ErrorCodes = {
  /** canonicalize 或包含校验发生时无法归类到正常路径的失败。 */
  pathResolutionFailed: "DIR_CONTEXT_PATH_RESOLUTION_FAILED",
  /** 发现阶段命中的上下文文件读不出来（权限/编码/竞态删除）。 */
  contextReadFailed: "DIR_CONTEXT_CONTEXT_READ_FAILED",
} as const;

export type DirContextErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface DirContextError {
  ok: false;
  code: DirContextErrorCode;
  /** 静态模板消息：不插值文件内容，路径为调用方自行附加的程序性信息。 */
  message: string;
}
