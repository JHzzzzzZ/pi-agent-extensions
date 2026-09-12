/**
 * 根契约测试：状态条排序与 widget 栈顺序（docs/cross/status-bar.md）
 *
 * - footer：五个 `setStatus` 键带两位排序前缀，`localeCompare` 后顺序 =
 *   语义带顺序（goal 10 < provider-quota 20 < pwr 30 < solo-mode 40 <
 *   stream-token-speed 50）。宿主 footer.js 按 key `localeCompare` 拼接
 *   状态行，键本身即排序契约；段前缀则由每插件本地 `status-band.ts` 的进程
 *   共享登记表统一决定：**最前段不加 `│ `**（行首定格），其余段加，任一段
 *   出现/消失重算（同上卡「段分隔与首段定格契约」）。
 * - 编辑器上方 widget：宿主按首次 `setWidget` 顺序堆叠，而 `session_start`
 *   按根 `package.json` `pi.extensions` 注册顺序逐个派发 ⇒ 扩展数组顺序
 *   即 widget 栈顺序契约（pwr-runs → run-timer → loop）。
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

test("pi.extensions 注册顺序保证上方 widget 栈顺序：pwr < run-timer < loop", () => {
  const pkg = JSON.parse(read("package.json")) as { pi: { extensions: string[] } };
  const index = (entry: string): number => pkg.pi.extensions.indexOf(entry);
  assert.ok(index("./src/extensions/pwr/index.ts") >= 0, "pwr 未注册");
  assert.ok(index("./src/extensions/run-timer/index.ts") >= 0, "run-timer 未注册");
  assert.ok(index("./src/extensions/loop/index.ts") >= 0, "loop 未注册");
  assert.ok(index("./src/extensions/pwr/index.ts") < index("./src/extensions/run-timer/index.ts"), "pwr 必须在 run-timer 前");
  assert.ok(index("./src/extensions/run-timer/index.ts") < index("./src/extensions/loop/index.ts"), "run-timer 必须在 loop 前");
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
