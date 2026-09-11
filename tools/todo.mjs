/**
 * tools/todo.mjs — 仓库级 todo CLI 唯一入口（实现源：../todo-cli/core.ts）
 *
 * 为什么是这样：本工具是 CLI-only、无 pi 依赖的仓库级命令；实现住在
 * todo-cli/core.ts，本文件只做仓库根入口与再导出，保证既有命令
 * `node tools/todo.mjs <子命令>` 与 `test/todo-cli.test.ts` 的导入路径不变。
 * REPO_ROOT 由脚本位置解析，任意 cwd 可用。
 *
 * 用法与设计边界见 todo-cli/core.ts 文件头（list/add/claim/complete/summary/
 * lint/triage 七个子命令；只读写仓库 todos/、不 commit）。
 */

export * from "../todo-cli/core.ts";

import { main } from "../todo-cli/core.ts";
import { pathToFileURL } from "node:url";

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
