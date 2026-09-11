# todo-cli — todos/ 工作流仓库 CLI

> last verified @ 56b7b49

## 职责与边界

把 AGENTS.md 规则 2 的 `todos/` 工作流（登记 → 领取 → 完成 + 开工/收尾盘点 triage）从「agent 手写 grep + edit」变成可测试的原子命令。**CLI-only**：不注册任何 Pi 扩展 API（无 agent 工具、无冒号命令）、无 npm 依赖；`node tools/todo.mjs <子命令>` 是唯一入口，任意 cwd 可用。

**不做**：不自动 commit；不碰 `todos/` 之外的仓库文件（triage 只读）；无 TUI/状态条（无 status 键、无 widget）。

## 文件地图

- `todo-cli/core.ts` — 唯一实现源：解析/汇总/跨文件查重/写操作/路径安全/lint/triage 均为导出纯函数，外加 CLI 调度 `main(argv, deps)`；对 Pi 宿主零依赖。
- `tools/todo.mjs` — 唯一 CLI 入口（薄壳）：`export * from "../todo-cli/core.ts"` + 直接运行时转发 `main`；根测试 import 此路径。
- 根 `test/todo-cli.test.ts` — 16 个测试：13 个 in-process（临时 fixture 上跑 `main(deps)` 覆盖写操作闭环）+ 3 个进程边界 E2E（真实子进程 + 陌生 cwd，锁命令面/退出码/`REPO_ROOT` 解析）。
- `todos/todo-cli-todo.md` — 本工具自身的状态追踪；todo-cli 不是插件，不参与 manifest↔todo 文件一一对应（lint 只查单向，见不变量）。

## 核心数据流

argv → `parseArgs` → `main(argv, deps)`（`repoRoot`/`log`/`writeFile`/`execGit` 可注入，测试据此在临时仓库闭环）→ 纯函数编排 → 读写 `todos/`。`REPO_ROOT` 由 `core.ts` 的脚本位置解析（HERE 上一级），因此任意 cwd 调用都作用于本仓库 `todos/`。所有输出走 `log`（默认 stdout），stderr 恒空。

## 不变量

- **命令面冻结（七子命令 + --help）**：`summary [--json]` / `list [--status open|processing|done] [--file <name>]` / `add --file <name> "描述"` / `claim --file <name> --match "子串" [--branch feat/x]` / `complete --file <name> --match "子串" [--note "说明"]` / `lint` / `triage [--json]`；`core.ts` 导出面同步冻结（测试导入路径不变）。
- **退出码语义**：`--help` → 0；裸调用 → 打印 USAGE、退出 1；未知命令 → stdout 打印 `未知命令：<cmd>` + USAGE、退出 1；成功 → 0。`main` 绝不抛异常，错误一律以退出码 + 静态模板消息表达。
- **路径安全**：`resolveTodoPath` 拒绝穿越；写操作只落 `todos/<name>.md`。
- **行尾保持**：写回按探测到的 EOL 还原（真实仓库 CRLF），防整文件 diff。
- **查重口径**：归一化文本（去空白/标点）后 exact/similar 两级；`add` 默认拒绝重复，`--force` 才写入。
- **动作分离**：`add` 不标 processing，`claim` 才标；`complete` = 勾选 `[x]` + 去标注 + 可选注记。
- **match 唯一定位**：`claim`/`complete` 的 `--match` 是子串；缺失或命中多条时报错，绝不猜第一条。
- **lint 单向**：根 manifest 注册的扩展 → 必有同名 todo 文件；多余 todo 文件（如 todo-cli 自身）合法不报。

## 已知坑

- **`--match` 是子串不是全文**：多个条目同时包含该子串会报歧义；改写条目文本后旧 match 失效。
- **triage 的 worktree↔条目映射靠「条目文本包含分支名」**：`claim --branch feat/x` 写出的标注正是 triage 读的；没写分支引用的 processing 一律归「无分支引用」（需人工确认），这是设计而非 bug。
- **行尾**：仓库 `todos/*.md` 实际是 CRLF；用会把行尾改成 LF 的外部工具保存后再写会产生整文件 diff——写函数保持探测到的 EOL，外部工具自行负责。
- **无 typecheck 门**：`core.ts` 是从 `.mjs` 迁入的未标注 JS，仓库也无根级 typecheck；要加门得先补类型。

## 改动清单

- 必跑：根 `npm run test:todo`（16 个）+ `node tools/todo.mjs lint`（应 exit 0）。
- 改行为：同步根 `test/todo-cli.test.ts` + 本卡；改命令面：同步 `core.ts` 的 `USAGE` + 本卡（不再有 install-smoke `EXTENSION_EXPECTATIONS` 联动——插件接线已删）。
- 改路径规则/查重口径：本卡「不变量」与 `todos/todo-cli-todo.md` 同步。
- 新增子命令：先补根测试（in-process + 必要的进程边界用例）再实现，并确认退出码与 stdout 约定不变。
