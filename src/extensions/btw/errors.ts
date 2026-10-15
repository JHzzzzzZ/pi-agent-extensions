/**
 * btw - 错误码与结果联合（本扩展唯一层，错误码集中在这里）
 *
 * 全代码库统一 `{ ok: true, value } | { ok: false, code, message }`；
 * `message` 为静态模板或宿主/模型的诊断原文，绝不插值用户输入或密钥。
 */

export const BtwErrorCodes = {
  /** 侧调用失败（宿主流内 error 事件或抛错）——message 为宿主/模型诊断原文 */
  sideCallError: "side-call-error",
  /** 侧调用被中止（用户关闭面板 / 宿主取消 / 本扩展的看门狗超时） */
  aborted: "aborted",
} as const;

/* 其它失败（无模型 / 提问非法 / 单飞忙 / 无 UI / 找不到模型）只存在于命令层的提示文案里，
   不进 result union——它们没有调用方需要分支处理的语义。 */

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
