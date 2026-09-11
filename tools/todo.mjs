/**
 * tools/todo.mjs — agentic todo CLI 入口（实现源：todo-cli/core.ts）
 *
 * 为什么是这样：同一套「读写 todos/ 的原子操作」既要给仓库内 CLI 用，也要给
 * Pi 扩展（todo-cli/index.ts）用。扩展必须自包含（整目录复制即可安装），所以
 * 实现住在 todo-cli/core.ts；本文件只做仓库根入口与再导出，保证既有命令
 * `node tools/todo.mjs <子命令>` 与 `test/todo-cli.test.ts` 的导入路径不变。
 *
 * 用法与设计边界见 todo-cli/core.ts 文件头（list/add/claim/complete/summary/
 * lint/triage 七个子命令；只读写仓库 todos/、不 commit）。
 */

export * from "../todo-cli/core.ts";

import { main } from "../todo-cli/core.ts";
import { pathToFileURL } from "node:url";

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
