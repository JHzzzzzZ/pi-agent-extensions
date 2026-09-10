/**
 * 根契约测试：状态条排序与 widget 栈顺序（docs/cross/status-bar.md）
 *
 * - footer：五个 `setStatus` 键带两位排序前缀，`localeCompare` 后顺序 =
 *   语义带顺序（goal 10 < provider-quota 20 < pwr 30 < solo-mode 40 <
 *   stream-token-speed 50）。宿主 footer.js 按 key `localeCompare` 拼接
 *   状态行，键本身即排序契约。
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
  assert.ok(index("./pwr/index.ts") >= 0, "pwr 未注册");
  assert.ok(index("./run-timer/index.ts") >= 0, "run-timer 未注册");
  assert.ok(index("./loop/index.ts") >= 0, "loop 未注册");
  assert.ok(index("./pwr/index.ts") < index("./run-timer/index.ts"), "pwr 必须在 run-timer 前");
  assert.ok(index("./run-timer/index.ts") < index("./loop/index.ts"), "run-timer 必须在 loop 前");
});

test("footer 排序带：五个键 localeCompare 顺序固定且字面量来自各自插件源码", () => {
  const bands = [
    ["goal", "10:goal", "goal/index.ts"],
    ["provider-quota", "20:provider-quota", "provider-quota/index.ts"],
    ["pwr", "30:pwr", "pwr/src/ui/renderer.ts"],
    ["solo-mode", "40:solo-mode", "solo-mode/index.ts"],
    ["stream-token-speed", "50:stream-token-speed", "stream-token-speed/status-port.ts"],
  ] as const;
  const keys = bands.map(([, key]) => key);
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(sorted, keys, "localeCompare 顺序必须等于带顺序");
  for (const [name, key, file] of bands) {
    assert.ok(read(file).includes(`"${key}"`), `${name} 的源码缺少键字面量 ${key}`);
  }
});
