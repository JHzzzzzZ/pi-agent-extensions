/**
 * timeout-bg — 默认超时解析（timeout-bg-todo#1）
 *
 * 宿主 shell 工具的 `timeout` 是可选参数、无默认值（不传就能无限挂住）。
 * 本模块把「未显式传 timeout 时施加多少默认超时」变成可判定的一小块：
 * 环境变量 `PI_TIMEOUT_BG_DEFAULT`（秒）覆盖，`0` 表示关闭默认超时，
 * 非法值回退内置默认值并给一次可见警告（不静默猜）。
 *
 * 纯函数：零 IO、零进程；显式 timeout 的校验文案与宿主 `resolveTimeoutMs`
 * 保持一致（同一句错误文本），避免同一参数两套说法。
 */

/** 默认超时覆盖环境变量（秒）。 */
export const DEFAULT_TIMEOUT_ENV = "PI_TIMEOUT_BG_DEFAULT";
/** 内置默认超时：300 秒（宿主无默认值，这是插件新增语义）。 */
export const DEFAULT_TIMEOUT_SECONDS = 300;
/** 宿主上限：MAX_TIMEOUT_MS = 2_147_483_647 → 秒。 */
export const MAX_TIMEOUT_SECONDS = 2_147_483.647;

export interface DefaultTimeout {
  /** 未显式传 timeout 时使用的秒数；undefined = 不施加默认超时。 */
  seconds: number | undefined;
  /** 环境变量非法时的可见警告（静态模板），合法/缺省为 null。 */
  warning: string | null;
}

/** 解析默认超时（缺省 300s；`0` 关闭；非法回退默认并警告）。 */
export function resolveDefaultTimeout(env: Record<string, string | undefined>): DefaultTimeout {
  const raw = env[DEFAULT_TIMEOUT_ENV];
  if (raw === undefined) return { seconds: DEFAULT_TIMEOUT_SECONDS, warning: null };
  const trimmed = raw.trim();
  if (trimmed === "0") return { seconds: undefined, warning: null };
  if (trimmed.length > 0) {
    const value = Number(trimmed);
    if (Number.isFinite(value) && value > 0) return { seconds: value, warning: null };
  }
  return {
    seconds: DEFAULT_TIMEOUT_SECONDS,
    warning: `${DEFAULT_TIMEOUT_ENV} 取值非法（需要 ≥0 的秒数，0 = 关闭默认超时），已回退默认 ${DEFAULT_TIMEOUT_SECONDS}s`,
  };
}

/**
 * 解析一次调用的超时毫秒数：显式 timeout 优先，其次默认值，都没有则不施加超时。
 * 显式值非法（≤0 / 非有限 / 超上限）直接抛错——与宿主同文案、fail-closed。
 */
export function resolveTimeoutMs(requested: number | undefined, fallbackSeconds: number | undefined): number | undefined {
  if (requested === undefined) return fallbackSeconds === undefined ? undefined : fallbackSeconds * 1000;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = requested * 1000;
  if (timeoutMs > MAX_TIMEOUT_SECONDS * 1000) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}
