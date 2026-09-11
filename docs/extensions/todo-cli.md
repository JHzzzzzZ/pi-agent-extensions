# todo-cli — todos/ 工作流原子操作（agent 工具 + 冒号命令）

> last verified @ 4f4a604

## 职责与边界

把 AGENTS.md 规则 2 的 `todos/` 工作流（登记 → 领取 → 完成，以及开工/收尾盘点的 triage）从「agent 手写 grep + edit」变成可测试的原子命令。服务面两套：agent 工具 `todos`（`action` 参数选择操作；复数名原因见「不变量」）与人类冒号命令 `/todo`、`/todo:list|add|claim|complete|triage|lint`。

**不做**：不自动 commit；不碰 `todos/` 之外的仓库文件（triage 只读）；不做跨项目聚合（只作用于当前会话工作目录下的 `todos/`）；没有 TUI 状态条/widget（无 status 键）。

**边界契约**：`todos/` 下的文件名即插件短名（`<name>-todo.md`）；`add` 只登记不标 processing，`claim` 才标注（动作显式分离）；所有写操作保持原文件行尾（真实仓库为 CRLF，读写都以探测到的 EOL 还原）。

## 文件地图

- `core.ts` — 唯一实现源（从 `tools/todo.mjs` 迁入）：解析（`parseTodoFile`）、汇总（`summarize`）、跨文件查重（`findDuplicates`，exact/similar 两级）、写操作（`appendEntry` / `setProcessing` / `completeEntry`）、路径安全（`resolveTodoPath` 只允 todos/ 一层文件名）、lint（`lintTodos`）、triage（`parseWorktrees` / `parseMergedBranches` / `triageRepo`）与 CLI 调度 `main(argv, deps)`。
- `index.ts` — 扩展接线：工具参数 → argv 翻译（`buildArgv`）、命令解析（`parseFileRest`）、裸 `/todo` 与六条冒号命令注册；triage 的 git 事实经 `TodoCliOverrides.execGit` 注入（测试用）。
- `index.test.ts` — 5 个接线测试（fake pi 捕获注册面 + 临时仓库真实文件写入；triage 用 fake execGit，不依赖真实 worktree）。
- 仓库 CLI `tools/todo.mjs` 是薄入口：`export * from "../todo-cli/core.ts"` + 直接运行转发 `main`；`test/todo-cli.test.ts`（13 个测试）导入路径不变。
- 安装冒烟期望在根 `tools/install-smoke.mjs` 的 `EXTENSION_EXPECTATIONS["todo-cli"]`（7 条命令、无 uiKeys）——新增/改名命令必须同步，否则冒烟报 drift。

## 核心数据流

1. agent 工具 `todos` → `buildArgv(params)` → `core.main(argv, { repoRoot: ctx.sessionManager.getCwd() ?? process.cwd(), log: 收集, execGit })` → 收集输出作为工具文本；`main` 退出码非 0 ⇒ 工具 `isError`。
2. 人类命令 → `parseFileRest`（`<文件> <子串> [--branch|--note ...]`）→ 同一 `run()` 通道 → `ctx.ui.notify`（失败按 warning/error 级别提示）。
3. 写操作：`add` 先跨全部文件查重（重复拒绝、不写）；`claim`/`complete` 用 `--match` 子串唯一定位（缺失/歧义返回错误码，不猜）；完成 = 勾选 `[x]` + 去 `（processing…）` 标注 + 可选注记。
4. `triage`：`git worktree list --porcelain` + `git branch --merged <主干>` + 条目文本里的 `@ feat/x` 引用 → 每个 worktree 判 active/cleanup/merged-dirty/orphan/missing、processing 三分（有工作台/引用已消失/无分支引用）、`.worktrees/` 孤儿目录；不写任何文件。

## 不变量

- **单实现源**：CLI 与扩展共用 `core.ts`。改行为只改 `core.ts` + 两侧测试，不要在 `index.ts` 里复制业务逻辑。
- **目录自包含**：扩展目录内不写 `../` 引用（整目录复制到 extensions/ 即用）；`core.ts` 的 `REPO_ROOT` 仅作 CLI 默认值，扩展一律显式传 `repoRoot`。
- **路径安全**：`resolveTodoPath` 拒绝穿越；写操作只落 `todos/<name>.md`。
- **行尾保持**：写回探测原文件 EOL（CRLF/LF）后还原，否则整文件 diff（历史事故预防）。
- **查重口径**：`findDuplicates` 归一化文本（去空白/标点）后 exact/similar 两级；`add` 默认拒绝，`--force` 才写入——工具不暴露 force，要强制走 CLI。
- **工具执行不抛异常**：argv 构造失败与 `main` 异常都转成 `isError` 文本，绝不把异常抛回宿主。
- **工具名恒为 `todos`（复数）**：宿主工具注册表无命名空间，第三方扩展常占用单数 `todo`（如 `@juicesharp/rpiv-todo`，管会话任务列表）——同名会让后加载的一方整个扩展加载失败（用户实测）。命令面仍是 `/todo`（命令与工具是两张表，互不影响）。

## 已知坑

- **match 是子串不是全文**：`claim`/`complete` 靠 `--match` 定位，多个条目同时包含该子串会报歧义（返回错误而非改第一条）；改写条目文本后旧 match 失效。
- **triage 的 worktree↔条目映射靠「条目文本包含分支名」**：`claim --branch feat/x` 写出的标注正是 triage 读的；没写分支引用的 processing 一律归「无分支引用」（需人工确认），这是设计而非 bug。
- **CRLF**：仓库 `todos/*.md` 实际是 CRLF；用会把行尾改成 LF 的外部工具保存后再 claim/complete 会产生整文件 diff——写函数会保持探测到的 EOL，但外部改写工具自行负责。
- **本扩展无 typecheck 门**：`core.ts` 是从 `.mjs` 迁入的未标注 JS，本目录只有 `npm test`（5 个测试）；类型检查不在门内（与 goal / provider-quota 等无 tsconfig 扩展一致）。要加 typecheck 得先给 core.ts 补类型。
- **宿主差异**：`ctx.sessionManager.getCwd()` 缺失时回退 `process.cwd()`；工具在 headless（无 UI）模式同样可用，命令通知会被跳过（hasUI 守卫）。

## 改动清单

- 必跑：`cd todo-cli && npm test`（5 个）+ 仓库根 `npm run test:todo`（13 个，覆盖 core.ts 行为）+ `node tools/todo.mjs lint`。
- 改 core 行为：同步 `test/todo-cli.test.ts` 与 `todo-cli/index.test.ts`；改命令面：同步 `EXTENSION_EXPECTATIONS`（tools/install-smoke.mjs）+ 根 README + 本卡。
- 新增动作/参数：`buildArgv` 与 `Type.Object` 同步；命令面按仓库冒号约定（旧空格写法只提示改名）。
- 改路径规则/查重口径：本卡「不变量」与 `todos/todo-cli-todo.md` 同步。
- 改工具名/参数：`TODO_TOOL` 常量 + `index.test.ts` 的回归断言（不得注册 `todo`）+ 根 README/AGENTS/本卡同步（命令面与工具名是两回事，改工具名不动命令）。
