/**
 * .agents/skills/todo-cli/todo-cli/todo.mjs — todo CLI 唯一入口（入口与实现同居）
 *
 * 为什么在这里：工具是仓库内的项目级 skill 资产（`.agents/skills/todo-cli/`），
 * 入口与实现同目录，仓库根不再挂 `tools/todo.mjs` 薄壳。仓库根本身由 core.ts 的
 * resolveRepoRoot 解析（`--root <dir>` > `git rev-parse --show-toplevel`），
 * 所以任意 git 仓库、任意 cwd 都可作用于**当前仓库**的 `todos/`。
 *
 * 用法与设计边界见 core.ts 文件头（summary / list / add / claim / complete / lint /
 * triage 七子命令 + migrate；只读写目标仓库 `todos/`，不自动 commit）。
 */

export * from "./core.ts";

import { main } from "./core.ts";
import { pathToFileURL } from "node:url";

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));
