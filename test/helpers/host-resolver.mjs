/**
 * test/helpers/host-resolver.mjs — 让根目录的组合测试能解析宿主包（`@earendil-works/*`）与
 * 扩展的其它裸依赖（`typebox` 等）
 *
 * 为什么需要它：仓库根**没有 node_modules**（根 package.json 零依赖），而组合测试要在根
 * 目录跑、加载的扩展会 `import` 宿主的**运行期值**（`@earendil-works/pi-tui` 的 `Key`、
 * `pi-coding-agent` 的 `createBashToolDefinition`）。ESM 按"导入文件所在目录"解析，根测试
 * 文件天然解析不到。
 *
 * 做法：把裸说明符的 `parentURL` 改写到一个已安装依赖的扩展目录里，再交给 Node 自己的
 * ESM 解析器（保留 exports 条件、子路径、版本语义）——比手工读 package.json 拼路径稳。
 * 只重写裸说明符（`./x`、`/x`、`node:`、`file:` 一律走原路），找不到任何已安装副本时
 * fail-closed 报错（提示先 `npm install`），绝不静默降级。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

let hostRoots = [];

/** 候选目录：任一装过依赖的扩展都可充当解析基点（顺序稳定）。 */
const candidateDirs = (repoRoot) =>
  [
    "src/extensions/pwr",
    "src/extensions/agent-team",
    "src/extensions/remote-tools",
    "src/extensions/dir-context",
    "src/extensions/timeout-bg",
    "src/extensions/loop",
    "src/extensions/jev-safe-gate",
  ].map((dir) => path.join(repoRoot, dir));

export function findHostRoots(repoRoot) {
  const found = candidateDirs(repoRoot).filter((dir) => fs.existsSync(path.join(dir, "node_modules")));
  if (found.length === 0) {
    throw new Error(
      "组合测试需要至少一个扩展目录装好依赖：先跑 `npm run test:all -- --install`，或 `cd src/extensions/pwr && npm install`",
    );
  }
  return found;
}

export async function initialize(data) {
  const { repoRoot } = data ?? {};
  if (!repoRoot) throw new Error("host-resolver 需要 repoRoot");
  hostRoots = findHostRoots(repoRoot);
}

const isBare = (specifier) =>
  !specifier.startsWith(".") &&
  !specifier.startsWith("/") &&
  !specifier.startsWith("#") && // 子路径导入（`#ansi-styles`）必须相对导入者自己的 package.json 解析
  !specifier.startsWith("node:") &&
  !specifier.startsWith("file:") &&
  !specifier.startsWith("data:") &&
  !specifier.startsWith("http:");

export async function resolve(specifier, context, nextResolve) {
  if (hostRoots.length === 0 || !isBare(specifier)) return nextResolve(specifier, context);
  // 每个扩展装的是自己的依赖副本（pwr 有 typebox、agent-team 有 proper-lockfile…）：
  // 依次拿候选目录当解析基点试，第一个成功的即答案；全失败则回落到默认解析（错误照常暴露）。
  for (const root of hostRoots) {
    try {
      return await nextResolve(specifier, {
        ...context,
        parentURL: pathToFileURL(path.join(root, "composition-host-root.mjs")).href,
      });
    } catch {
      // 换下一个候选基点
    }
  }
  return nextResolve(specifier, context);
}
