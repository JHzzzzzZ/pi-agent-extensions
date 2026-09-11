/**
 * agent-team — 展示层模型口径归一（viewer「模型:」行 + /team:status）
 *
 * 同一条模型信息有两个事实源：团队文件声明值（`provider/id`）与子进程
 * `message_end` 实际上报值（pi 上报裸 id，如 `deepseek-flash`；自带 `/`
 * 时视为完整口径）。本模块只做展示/装配层的组合，不改 runner.ts 的原始
 * 上报数据（那是事实源）。
 *
 * 规则：
 * - 声明含 provider 前缀 + 实际上报裸 id ⇒ `声明前缀/实际 id`（覆盖运行时
 *   实际选中模型与声明不一致的情形）；
 * - 实际值自带 `/` ⇒ 原样使用（已是完整口径，不重复组合）；
 * - 无声明 ⇒ 实际值原样（裸 id 就裸 id，不造假前缀）；
 * - 无实际 ⇒ 声明值原样；
 * - 两者皆无 ⇒ undefined（由渲染层兜底 `（默认）`）。
 */

export function resolveModelCaliber(declared?: string, actual?: string): string | undefined {
  const declaredValue = declared?.trim();
  const actualValue = actual?.trim();
  if (!declaredValue) return actualValue || undefined;
  if (!actualValue) return declaredValue;
  if (actualValue.includes("/")) return actualValue;
  const slash = declaredValue.indexOf("/");
  // 声明值本身没有 provider 前缀：无法组合，事实（实际值）优先。
  if (slash <= 0) return actualValue;
  return `${declaredValue.slice(0, slash)}/${actualValue}`;
}
