/**
 * timeout-bg — 模型面参数 `run_in_background` 的读取、剥离、描述注入与分派（timeout-bg-todo#5）
 *
 * 宿主 `createBashTool().execute` 只把 `command` / `timeout` / `env` 交给 `operations.exec`，
 * 新参数**到不了**我们的 ops。所以「主动后台」的传递靠**两份工具定义**（超时模式 / 后台模式），
 * 由本模块的分派函数按参数选一份执行；参数的读/剥/描述口径也只有这一份实现。
 *
 * 为什么不用 `timeout: 0` / `-1` 当哨兵：`PI_TIMEOUT_BG_DEFAULT=0` 在本插件词表里已经
 * 是「关闭默认超时、不限时」（同词反义），宿主 `resolveTimeoutMs` 对 ≤0 也直接抛
 * `Invalid timeout`——两个方向都要求独立字段（对齐文档 `todos/align/timeout-bg-todo#5.md`）。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runInBackgroundParamDescription, timeoutParamDescription } from "./text.ts";

/** 参数名（模型面；bash 与 powershell 共用）。 */
export const RUN_IN_BACKGROUND_PARAM = "run_in_background";

/** 这次调用是否要求「直接转后台」。严格 `=== true`：畸形值按不给处理，fail-safe 回既有语义。 */
export function requestsRunInBackground(params: unknown): boolean {
  if (typeof params !== "object" || params === null) return false;
  return (params as Record<string, unknown>)[RUN_IN_BACKGROUND_PARAM] === true;
}

/** 剥掉本参数：宿主的内置工具定义不认识它，透传只是噪声（远端侧另有一条同样的剥离）。 */
export function stripRunInBackground<T>(params: T): T {
  if (typeof params !== "object" || params === null) return params;
  const copy = { ...(params as Record<string, unknown>) };
  delete copy[RUN_IN_BACKGROUND_PARAM];
  return copy as T;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * 参数 schema 注入：改写 `timeout` 那句（宿主原文写着 "no default timeout"，与新语义冲突）
 * 并新增 `run_in_background`。用纯 JSON Schema 字面量而不是 TypeBox——本扩展没有 `typebox`
 * 依赖（宿主工具给回来的 properties 本身就是 JSON Schema，合并口径一致）。
 */
export function withOwnParamDescriptions(parameters: unknown, defaultSeconds: number | undefined): unknown {
  const source = asRecord(parameters);
  if (source === null) return parameters;
  const properties = asRecord(source.properties);
  if (properties === null) return parameters;
  const next: Record<string, unknown> = { ...properties };
  const timeout = asRecord(properties.timeout);
  if (timeout !== null) next.timeout = { ...timeout, description: timeoutParamDescription(defaultSeconds) };
  next[RUN_IN_BACKGROUND_PARAM] = { type: "boolean", description: runInBackgroundParamDescription() };
  return { ...source, properties: next };
}

export interface RunInBackgroundDispatchDeps {
  /** 既有语义：命中超时（显式或默认）才转后台。 */
  timeout: ToolDefinition["execute"];
  /** 主动后台：进程一启动就登记并结束本次调用。 */
  background: ToolDefinition["execute"];
}

/** 分派：`run_in_background === true` ⇒ 后台模式定义，否则原样走超时模式定义。 */
export function createRunInBackgroundDispatch(deps: RunInBackgroundDispatchDeps): ToolDefinition["execute"] {
  return (id, params, signal, onUpdate, ctx) =>
    (requestsRunInBackground(params) ? deps.background : deps.timeout)(id, stripRunInBackground(params), signal, onUpdate, ctx);
}
