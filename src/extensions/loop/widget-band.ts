/**
 * loop — widget 排序带（跨插件契约 docs/cross/status-bar.md）
 *
 * 宿主 `InteractiveMode.setExtensionWidget` 每次 `setWidget` 都先对两个 widget Map
 * `Map.delete(key)` 再 `Map.set(key, component)`；JS Map 按插入序迭代 ⇒ 被刷新的
 * widget 沉到该栈底部：编辑器上方多段周期性刷新 widget（pwr-runs / run-timer /
 * loop）因此逐秒换位。本仓库不打宿主补丁（AGENTS.md 红线 8），改由本模块把
 * 「每插件一个宿主键」并成「各段登记逻辑行、由 owner 合并后只写宿主单键
 * `widget-band`」：宿主只有一个键可挪，段间顺序改由 band key 升序保证。
 *
 * 协调走 `globalThis` 上的共享登记表（`Symbol.for`）：不跨插件 import，每个插件
 * 目录一份拷贝，保持单目录可复制安装。局限：只认识同样使用本模块的写入者；本模块
 * 读不到宿主是否另外清过 widget（宿主重绑会清 widget 但换新的 ui 上下文，见下）。
 *
 * 用法：把本段的行与**本插件的 ui 上下文**交给 `writeWidgetBand`，不要自己
 * `setWidget`；`lines === undefined` 或空数组表示本段不显示。生命周期：各写入者
 * 在 `session_shutdown` / 会话关停处必须清登记（`writeWidgetBand(键, undefined, ui)`），
 * 否则 owner 位会留在登记表里（与 footer 排序带同一条纪律）。
 *
 * 契约细节：
 * - band key = 两位数字带 + `:`（10:pwr-runs / 20:run-timer / 30:loop），顺序 =
 *   key 升序（`localeCompare`，与宿主 footer 排序同一判定）。
 * - owner = band key 最小的**可见**段，由它一次写宿主键；owner 清空即自动移交。
 * - 段之间不加分隔符：widget 是多行块，不是 footer 那种一行拼接。
 * - 全部段不显示 → 写 `setWidget(HOST_WIDGET_KEY, undefined)` 卸载（不留残行）。
 * - 文本指纹：owner + 行内容 + **ui 身份**都未变才跳过宿主写入；ui 身份计入指纹
 *   是为了让会话重绑 / reload（宿主清 widget 并换新 ui 上下文）后必然重写一次。
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** 宿主 widget 键：三段合并后唯一的键（宿主对该键的 delete+set 不影响段间顺序）。 */
export const HOST_WIDGET_KEY = "widget-band";

const REGISTRY_SYMBOL = Symbol.for("pi.widget-band.v1");

interface BandEntry {
  /** 本段当前逻辑行；undefined = 本段当前不显示。 */
  lines: string[] | undefined;
  /** 本插件 ui 上下文：owner 用它写宿主键；卸载用最后登记过的那个。 */
  ui: ExtensionUIContext;
}

interface BandState {
  entries: Map<string, BandEntry>;
  /** 上次真正写进宿主的（owner, ui, 行）指纹；undefined = 当前未挂载。 */
  written: { owner: string; ui: ExtensionUIContext; lines: string[] } | undefined;
  /** 最后一个登记者的 ui：全段不显示时用它清宿主键。 */
  ui: ExtensionUIContext | undefined;
}

function band(): BandState {
  const store = globalThis as unknown as Record<symbol, unknown>;
  let state = store[REGISTRY_SYMBOL] as BandState | undefined;
  if (!state) {
    state = { entries: new Map(), written: undefined, ui: undefined };
    store[REGISTRY_SYMBOL] = state;
  }
  return state;
}

function visible(entry: BandEntry): boolean {
  return entry.lines !== undefined && entry.lines.length > 0;
}

/** owner 判定与宿主 footer 同源：band key `localeCompare` 最小的可见段。 */
function ownerOf(state: BandState): string | undefined {
  let owner: string | undefined;
  for (const [key, entry] of state.entries) {
    if (!visible(entry)) continue;
    if (owner === undefined || key.localeCompare(owner) < 0) owner = key;
  }
  return owner;
}

/** 合并可见段的行：band key 升序，段间不加分隔符。 */
function merge(state: BandState): string[] {
  const keys = [...state.entries.keys()]
    .filter((key) => visible(state.entries.get(key)!))
    .sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];
  for (const key of keys) lines.push(...state.entries.get(key)!.lines!);
  return lines;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** 写宿主单键；单次 UI 异常不影响登记表与其它段（UI 崩溃隔离）。 */
function write(ui: ExtensionUIContext | undefined, lines: string[] | undefined): void {
  if (!ui) return;
  try {
    ui.setWidget(HOST_WIDGET_KEY, lines, { placement: "aboveEditor" });
  } catch {
    // 忽略：登记表状态仍以本次调用为准，不影响其它段
  }
}

function render(state: BandState): void {
  const owner = ownerOf(state);
  if (owner === undefined) {
    if (state.written === undefined) return; // 已卸载：不重复清键
    write(state.ui, undefined);
    state.written = undefined;
    return;
  }
  const entry = state.entries.get(owner)!;
  const lines = merge(state);
  const last = state.written;
  if (last && last.owner === owner && last.ui === entry.ui && sameLines(last.lines, lines)) return;
  write(entry.ui, lines);
  state.written = { owner, ui: entry.ui, lines };
}

/**
 * 登记本段逻辑行并刷新宿主 widget：owner（band key 最小的可见段）写合并结果。
 * `lines` 为空（undefined / 空数组）表示本段不显示；全段不显示时卸载宿主键。
 */
export function writeWidgetBand(key: string, lines: string[] | undefined, ui: ExtensionUIContext): void {
  const state = band();
  state.entries.set(key, { lines: lines !== undefined && lines.length > 0 ? lines : undefined, ui });
  state.ui = ui;
  render(state);
}
