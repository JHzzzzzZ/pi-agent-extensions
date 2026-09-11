# todo-cli — todos/ 工作流仓库 CLI

> last verified @ bcb6fbd

## 职责与边界

把 AGENTS.md 规则 2 的 `todos/` 工作流（登记 → 领取 → 完成 + 开工/收尾盘点 triage）从「agent 手写 grep + edit」变成可测试的原子命令。**CLI-only**：不注册任何 Pi 扩展 API（无 agent 工具、无冒号命令）、无 npm 依赖；`node tools/todo.mjs <子命令>` 是唯一入口，任意 cwd 可用。

**不做**：不自动 commit；不碰 `todos/` 之外的仓库文件（triage 只读；L14 索引只写 `todos/.todo-cli/`）；无 TUI/状态条（无 status 键、无 widget）。

## 文件地图

- `todo-cli/core.ts` — CLI 调度 `main(argv, deps)` + 解析/汇总/跨文件查重/写操作/路径安全/lint/triage 纯函数；L14/L15 接线点（store/query 接线、`db` 子命令、list 新 flags）。对 Pi 宿主零依赖。
- `todo-cli/store.ts` — `node:sqlite` 结构化索引（`todos/.todo-cli/index.db`）：连接/schema、`writeTxn` 临界区（`BEGIN IMMEDIATE` + busy_timeout=5000）、`reimportFile` 漂移重导入、`stampEntry` 时间戳、`atomicWriteFile` 原子写（temp+rename）。
- `todo-cli/migrate.ts` — 索引生命周期编排：`dbStatus` 只读探测（不建库、无副作用）、`rebuildStore` 全量重建（不写 md、幂等）、`dropStore` 回滚清场（幂等）。
- `todo-cli/query.ts` — 纯函数查询引擎（`statusMark`/`parseBranchRef`/`parseTags`/`deriveQueryEntries`/`applyEntryFilter`/`sortQueryEntries`/`serializeEntries`/`parseFilterOptions`），零 import（不碰 fs/db/store）。
- `tools/todo.mjs` — 唯一 CLI 入口（薄壳）：`export * from "../todo-cli/core.ts"` + 直接运行时转发 `main`；根测试 import 此路径。
- 根 `test/todo-cli.test.ts` — 23 个测试：13 个 in-process（临时 fixture 上跑 `main(deps)`）+ 3 个进程边界 E2E + 7 条 L14/L15 接线（组合查询/降级注入/db 子命令/对照测试，即 10-design §6 清单 24–30）。
- `todo-cli/test/` — 单元与真实边界：`store.test.ts`（7）、`migrate.test.ts`（5）、`query.test.ts`（6）、`concurrency.test.ts`（3 个真实子进程并发）、`interrupt.test.ts`（2，SIGKILL/漂移自愈）、`migrate-roundtrip.test.ts`（2，可逆/时间戳迁移）。

## 核心数据流

argv → `parseArgs` → `main(argv, deps)`（`repoRoot`/`log`/`writeFile`/`execGit`/`openStore`/`now` 可注入）→ 纯函数编排 → 读写 `todos/`。**markdown 权威 + DB 派生索引**：`todos/*.md` 是唯一持久真相；DB 只由 markdown 导入，写路径 = `writeTxn` 临界区内 read-modify-write（`atomicWriteFile` 落盘 → `reimportFile` 同步索引 → `stampEntry` 记时刻），stat 与 files 表不一致的漂移文件自动重导入（markdown 永远赢），DB 可随时 `db drop` 删除并从 markdown 重建。`REPO_ROOT` 由脚本位置解析，任意 cwd 调用都作用于本仓库；所有输出走 `log`，stderr 恒空（触库时压制 node:sqlite ExperimentalWarning）。索引是纯派生物：不入库，`.gitignore` 的 `todos/.todo-cli/` 由收口线补。

## 不变量

- **命令面冻结**：七子命令 `summary/list/add/claim/complete/lint/triage` + `--help` 的用法、退出码、stdout/stderr 约定不变；`USAGE` 旧行字节保持（只追加新行）。
- **DB 行集 = `parseTodoFile` 像**：`entries` 表行（file/line/status/text）恒等于 markdown 解析结果（时间戳除外）；缩进说明行/标题/空行不进 DB。
- **降级与自愈**：node:sqlite 不可用时按下方降级表执行；DB 损坏（打开/建表抛错）→ 挪 `index.db.corrupt` 留证 + 本次降级，下次运行自动重建。
- **退出码语义**：`--help` → 0；裸调用 → USAGE、1；未知命令 → `未知命令：<cmd>` + USAGE、1；成功 → 0；`db` 未知子命令 → `未知 db 子命令：<x>`、1。`main` 不抛异常（DB 忙 → 静态模板 + 1）。
- **路径安全**：`resolveTodoPath` 拒绝穿越；写操作只落 `todos/<name>.md`，索引只落 `todos/.todo-cli/`。
- **行尾保持**：写回按探测到的 EOL 还原（真实仓库 CRLF），防整文件 diff。
- **match 唯一定位**：`claim`/`complete` 的 `--match` 是子串；缺失/多条报错，绝不猜第一条。
- **查重口径**：归一化文本后 exact/similar 两级；`add` 默认拒绝重复，`--force` 才写入。
- **动作分离**：`add` 不标 processing，`claim` 才标并记 `claimedAt`；`complete` = 勾选 `[x]` + 去标注 + 记 `completedAt`。
- **lint 单向**：根 manifest 注册的扩展 → 必有同名 todo 文件；多余 todo 文件合法不报。

## list 查询 flags（AND 组合）与降级表

`--status open|processing|done` / `--file <name>`（旧）+ `--branch <子串>` / `--tag <词>` / `--text <关键词>` / `--claimed-since <YYYY-MM-DD>` / `--json`（新）。只带旧 flags 且无 `--json` 走 markdown 直读路径（不建库）；任一新 flag 或 `--json` 走 DB/派生查询路径。`--json` 输出 `{file,line,status,text,branch,tags,createdAt,claimedAt,completedAt}` 行对象数组（file→line 稳定排序）。

| 能力 | DB 可用 | 降级 |
| --- | --- | --- |
| 七子命令（旧 flags） | DB 索引 + 临界区写 | 与今日字节相同（markdown 直读直写） |
| list 文本维度（--branch/--tag/--text/--json） | 走 DB 行 | markdown 派生（时间戳 null），结果一致 |
| list `--claimed-since` | 走 DB 行 | 明确报错 exit 1（静态说明行） |
| `db status` / `db rebuild` | 正常 | 报错 exit 1 |
| `db drop` | 正常 | 正常（幂等删文件，恒 exit 0） |

## db 子命令

- `db status [--json]`：可用 exit 0（files/entries/schema v1，`--json` 输出 `DbStatusInfo`）；不可用 exit 1 + 静态原因行；只读探测，不建库。
- `db rebuild`：markdown 全量导入（不写 md、幂等、时间戳按归一化文本迁移保留），成功 exit 0 打印 files/entries 计数。
- `db drop`：删 `index.db`/`-wal`/`-shm`/`.corrupt`，恒 exit 0，幂等（回滚与降级是同一条代码路径）。

## 已知坑

- **`--match` 是子串不是全文**：多条包含该子串报歧义；改写条目文本后旧 match 失效。
- **triage 的 worktree↔条目映射靠「条目文本包含分支名」**：`claim --branch feat/x` 写出的标注正是 triage 读的；没写分支引用的 processing 一律归「无分支引用」（需人工确认），这是设计而非 bug。
- **行尾**：仓库 `todos/*.md` 实际是 CRLF；用会把行尾改成 LF 的外部工具保存后再写会产生整文件 diff——写函数保持探测到的 EOL。
- **实验警告压制**：默认 warning 监听器由 bootstrap 注册，`process.on` 只是追加（警告仍会打印）；必须 `process.removeAllListeners("warning")` 后自注册，只吞 message 含 sqlite 的 ExperimentalWarning，其余 `console.error` 转发。在触库前惰性执行，失效会让 stderr 污染（`concurrency.test.ts` 锁 stderr 恒空）。
- **降级环境写并发无锁**（既有风险，本设计不恶化）：无 DB 时 read-modify-write 会丢更新；用 `db status` 自检环境。
- **时间戳非 git 持久**：`createdAt/claimedAt/completedAt` 只在 DB 列；`db drop`/重建后 claim/complete 时刻丢失（markdown 里的日期注记不反向解析）。
- **stat 漂移启发式**：同 size + 同 mtimeMs 的内容改动漏判（概率极低）；`db rebuild` 强制全量兜底。
- **无 typecheck 门**：仓库无根级 typecheck；新文件全用可擦除 TS 语法，未来可加门。

## 改动清单

- 必跑（W5 前直跑；W5 把 glob 接进 `npm run test:todo`）：`node --test test/todo-cli.test.ts "todo-cli/test/*.test.ts"`（48 个，2026-09-11 实测全绿）+ `node tools/todo.mjs lint`（exit 0）。环境剥离前缀 `env -u PI_AGENT_TEAM_FILE -u PI_AGENT_TEAM_NAME -u PI_AGENT_TEAM_RUN_ID`。
- 改行为：同步根 `test/todo-cli.test.ts` + 本卡；改命令面：同步 `core.ts` 的 `USAGE` + 本卡。
- 改路径规则/查重口径：本卡「不变量」与 `todos/todo-cli-todo.md` 同步。
- 新增子命令/flags：先补根测试（in-process + 必要的进程边界用例）再实现，并确认退出码与 stdout 约定不变。
