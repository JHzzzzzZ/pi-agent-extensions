/**
 * 根契约测试：状态条排序与 widget 排序带（docs/cross/status-bar.md）
 *
 * - footer：五个 `setStatus` 键带两位排序前缀，`localeCompare` 后顺序 =
 *   语义带顺序（goal 10 < provider-quota 20 < pwr 30 < solo-mode 40 <
 *   stream-token-speed 50）。宿主 footer.js 按 key `localeCompare` 拼接
 *   状态行，键本身即排序契约；段前缀则由每插件本地 `status-band.ts` 的进程
 *   共享登记表统一决定：**最前段不加 `│ `**（行首定格），其余段加，任一段
 *   出现/消失重算（同上卡「段分隔与首段定格」）。
 * - 编辑器上方 widget（pwr-runs / run-timer / loop）：宿主每次 `setWidget` 都
 *   `Map.delete` + `Map.set`，被刷新的 widget 沉到栈底——所以顺序**不再**由
 *   扩展注册顺序/首次挂载决定，改由每插件本地 `widget-band.ts` 的共享登记表
 *   按 band key 升序（10:pwr-runs < 20:run-timer < 30:loop）合并，owner 一次
 *   写宿主单键 `widget-band`；登记/移交/卸载规则见同上卡「widget 排序带」。
 *
 * 运行：node --test test/status-bar-contract.test.ts（或根 npm run test:contract）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

test("widget 排序带：三个写入者的 band key 升序 = 可见顺序，且不再写各自的宿主键", () => {
  const bands = [
    ["pwr", "10:pwr-runs", "src/extensions/pwr/src/ui/renderer.ts"],
    ["run-timer", "20:run-timer", "src/extensions/run-timer/index.ts"],
    ["loop", "30:loop", "src/extensions/loop/index.ts"],
  ] as const;
  const keys = bands.map(([, key]) => key);
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(sorted, keys, "localeCompare 顺序必须等于排序带顺序（pwr → run-timer → loop）");
  for (const [name, key, file] of bands) {
    const src = read(file);
    assert.ok(src.includes(`"${key}"`), `${name} 的源码缺少排序带键字面量 ${key}`);
    assert.ok(src.includes("writeWidgetBand("), `${name} 的写入边界未走排序带`);
    assert.ok(!src.includes("setWidget("), `${name} 绕过排序带直接写宿主 widget 键（会被宿主逐秒换位）`);
  }
});

test("widget 排序带：三个写入者各带一份同源 widget-band.ts（不跨插件 import）", () => {
  const copies = [
    ["pwr", "src/extensions/pwr/src/ui/widget-band.ts"],
    ["run-timer", "src/extensions/run-timer/widget-band.ts"],
    ["loop", "src/extensions/loop/widget-band.ts"],
  ] as const;
  for (const [name, file] of copies) {
    const src = read(file);
    assert.ok(src.includes('Symbol.for("pi.widget-band.v1")'), `${name} 未接入进程共享登记表`);
    assert.ok(src.includes('export const HOST_WIDGET_KEY = "widget-band";'), `${name} 宿主键不是单键 widget-band`);
    assert.ok(src.includes("export function writeWidgetBand("), `${name} 缺少 writeWidgetBand 写入边界`);
    assert.ok(src.includes("localeCompare("), `${name} 未按 band key localeCompare 判定顺序与 owner`);
    assert.ok(src.includes('"aboveEditor"'), `${name} 未锁定 placement: aboveEditor`);
  }
  // 三份拷贝必须同源（忽略注释与缩进）：契约是全仓库相仝的模块，不是各写法。
  const normalize = (rel: string): string =>
    read(rel)
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .trim();
  const canonical = normalize(copies[0][1]);
  for (const [name, file] of copies) {
    assert.equal(normalize(file), canonical, `${name} 的 widget-band.ts 拷贝与其它插件不同源（拷贝时漏改/漏同步）`);
  }
});

test("footer 排序带：五个键 localeCompare 顺序固定且字面量来自各自插件源码", () => {
  const bands = [
    ["goal", "10:goal", "src/extensions/goal/index.ts"],
    ["provider-quota", "20:provider-quota", "src/extensions/provider-quota/index.ts"],
    ["pwr", "30:pwr", "src/extensions/pwr/src/ui/renderer.ts"],
    ["solo-mode", "40:solo-mode", "src/extensions/solo-mode/index.ts"],
    ["stream-token-speed", "50:stream-token-speed", "src/extensions/stream-token-speed/status-port.ts"],
  ] as const;
  const keys = bands.map(([, key]) => key);
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(sorted, keys, "localeCompare 顺序必须等于带顺序");
  for (const [name, key, file] of bands) {
    assert.ok(read(file).includes(`"${key}"`), `${name} 的源码缺少键字面量 ${key}`);
  }
});

test("footer 段前缀：五个写入者各带一份 status-band.ts（最前段无前缀，其余段 `│ `）", () => {
  const writers = [
    ["goal", "src/extensions/goal/status-band.ts", "src/extensions/goal/index.ts"],
    ["provider-quota", "src/extensions/provider-quota/status-band.ts", "src/extensions/provider-quota/index.ts"],
    ["pwr", "src/extensions/pwr/src/ui/status-band.ts", "src/extensions/pwr/src/ui/renderer.ts"],
    ["solo-mode", "src/extensions/solo-mode/status-band.ts", "src/extensions/solo-mode/index.ts"],
    ["stream-token-speed", "src/extensions/stream-token-speed/status-band.ts", "src/extensions/stream-token-speed/status-port.ts"],
  ] as const;
  for (const [name, bandFile, boundaryFile] of writers) {
    const band = read(bandFile);
    assert.ok(band.includes('export const STATUS_SEPARATOR = "│ ";'), `${name} 缺少段前缀常量`);
    assert.ok(band.includes('Symbol.for("pi.status-bar.bands.v1")'), `${name} 未接入进程共享登记表`);
    assert.ok(band.includes("localeCompare("), `${name} 未按 key localeCompare 判定最前段`);
    assert.ok(band.includes("export function writeBand("), `${name} 缺少 writeBand 写入边界`);
    assert.ok(read(boundaryFile).includes("writeBand("), `${name} 写入边界未走 writeBand（前缀会被绕过）`);
  }
});
