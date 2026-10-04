/**
 * virtual-model-router — 路由失败码（general-todo#22）
 *
 * 为什么是抛错而不是结果联合：宿主契约里 `route()` 抛出 = 该请求以错误响应结束，
 * 没有把 `{ ok: false, code }` 传回宿主的通道（`docs/virtual-models.md`：
 * "If `route()` throws ... the request ends with an error response"）。所以失败必须
 * 以类型化异常显式表达——fail-closed，绝不静默回落某个模型。
 */

export const RouterErrorCodes = {
  /** 宿主给了表外的 `reason`（版本漂移 / 上游新增枚举值）。 */
  UNKNOWN_REASON: "UNKNOWN_REASON",
  /** 档位表指向的物理模型不在模型目录里（表里打错字、provider 没凭据/未加载）。 */
  MODEL_NOT_IN_CATALOG: "MODEL_NOT_IN_CATALOG",
} as const;

export type RouterErrorCode = (typeof RouterErrorCodes)[keyof typeof RouterErrorCodes];

/** 路由失败异常：`code` 给测试与宿主日志，`message` 为静态模板（不插值会话内容）。 */
export class RouterRouteError extends Error {
  readonly code: RouterErrorCode;

  constructor(code: RouterErrorCode, message: string) {
    super(message);
    this.name = "RouterRouteError";
    this.code = code;
  }
}
