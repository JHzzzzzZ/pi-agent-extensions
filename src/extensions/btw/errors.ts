/**
 * btw - 错误码与结果联合（本扩展唯一层，错误码集中在这里）
 *
 * 全代码库统一 `{ ok: true, value } | { ok: false, code, message }`；
 * `message` 为静态模板或宿主/模型的诊断原文，绝不插值用户输入或密钥。
 */

export const BtwErrorCodes = {
  /** 会话没有当前模型（ctx.model 为空） */
  noModel: "no-model",
  /** 侧调用失败（宿主流内 error 事件或抛错） */
  sideCallError: "side-call-error",
  /** 侧调用被中止（用户关闭面板 / 主会话取消等） */
  aborted: "aborted",
  /** 侧调用超时（由本扩展的看门狗触发） */
  timeout: "timeout",
  /** 提问为空或超长 */
  badQuestion: "bad-question",
  /** 上一个侧调用还在跑（同一时刻只允许一个） */
  busy: "busy",
  /** 无 UI（print / json 模式）：没有可展示侧对话的通道 */
  uiUnavailable: "ui-unavailable",
  /** `/btw:model` 指定的模型在宿主目录里找不到 */
  modelNotFound: "model-not-found",
} as const;

export type BtwErrorCode = (typeof BtwErrorCodes)[keyof typeof BtwErrorCodes];

export interface BtwFailure {
  ok: false;
  code: BtwErrorCode;
  message: string;
}

export interface BtwSuccess<T> {
  ok: true;
  value: T;
}

export type BtwResult<T> = BtwSuccess<T> | BtwFailure;

export function ok<T>(value: T): BtwSuccess<T> {
  return { ok: true, value };
}

export function fail(code: BtwErrorCode, message: string): BtwFailure {
  return { ok: false, code, message };
}
