/**
 * stream-token-speed — footer 段前缀协调（跨插件契约 docs/cross/status-bar.md）
 *
 * 宿主 footer 按 key `localeCompare` 排序后把各扩展的 `setStatus` 文本 join 成一行，
 * 没有「谁在最前」的查询 API。本模块统一决定段前缀：**排序最靠前的可见段不加
 * `│ `**（行首定格），其余段加；任一段出现/消失时，所有已登记段重新计算前缀。
 *
 * 协调走 `globalThis` 上的共享登记表（`Symbol.for`）：不跨插件 import，每个插件
 * 目录一份拷贝，保持单目录可复制安装。局限：只认识同样使用本模块的写入者——
 * 宿主内置段落与第三方扩展的 status 文本不参与排序判定（本仓库五个写入者已覆盖）。
 *
 * 用法：把「逻辑文本（不含前缀）」与「实际写 UI 的回调」交给 `writeBand`，
 * 不要自己拼 `│ `；`text === undefined` 表示本段不显示。
 */

const REGISTRY_SYMBOL = Symbol.for("pi.status-bar.bands.v1");

/** 段分隔前缀：仅非最前段使用（最前段行首定格，避免悬空前导竖线）。 */
export const STATUS_SEPARATOR = "│ ";

interface BandEntry {
  /** 本段当前逻辑文本（不含前缀）；undefined = 本段当前不显示。 */
  text: string | undefined;
  /** 实际写 UI 的回调；入参已含前缀决策（undefined = 清除）。 */
  writer: (text: string | undefined) => void;
}

type BandRegistry = Map<string, BandEntry>;

function bands(): BandRegistry {
  const store = globalThis as unknown as Record<symbol, unknown>;
  let map = store[REGISTRY_SYMBOL] as BandRegistry | undefined;
  if (!map) {
    map = new Map<string, BandEntry>();
    store[REGISTRY_SYMBOL] = map;
  }
  return map;
}

/** 是否当前最前：与宿主相同的 key `localeCompare` 判定，仅统计已登记且可见的段。 */
function isFrontmost(map: BandRegistry, key: string): boolean {
  for (const [other, entry] of map) {
    if (other !== key && entry.text !== undefined && other.localeCompare(key) < 0) return false;
  }
  return true;
}

function render(map: BandRegistry, key: string): void {
  const entry = map.get(key);
  if (!entry) return;
  const text = entry.text;
  const prefixed = text === undefined || isFrontmost(map, key) ? text : STATUS_SEPARATOR + text;
  try {
    entry.writer(prefixed);
  } catch {
    /* 单个写入者异常不影响其它段（UI 崩溃隔离） */
  }
}

/**
 * 登记本段逻辑文本并写入；前缀由本模块统一决定。
 * 本段出现/消失会使其它段的最前判定变化，通知它们重新渲染（最多 4 次）。
 */
export function writeBand(key: string, text: string | undefined, writer: (text: string | undefined) => void): void {
  const map = bands();
  const visibleBefore = map.get(key)?.text !== undefined;
  map.set(key, { text, writer });
  render(map, key);
  if (visibleBefore !== (text !== undefined)) {
    for (const other of [...map.keys()]) {
      if (other !== key) render(map, other);
    }
  }
}
