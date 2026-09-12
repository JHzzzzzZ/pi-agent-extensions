# todo-cli — todos/ 工作流仓库 CLI

> last verified @ a0f23f3

## 职责与边界

把 AGENTS.md 规则 2 的 `todos/` 工作流（登记 → 领取 → 完成 + 开工/收尾盘点 triage）从「agent 手写 grep + edit」变成可测试的原子命令。**CLI-only**：不注册任何 Pi 扩展 API（无 agent 工具、无冒号命令）、无 npm 依赖、无 Pi/宿主依赖；`node tools/todo.mjs <子命令>` 是唯一入口，任意 cwd 可用。

**存储（方案 C，todos/todo-cli-todo.md:17）**：`todos/<名>.json` 是唯一持久真相——无 markdown、无 sqlite 索引层、无降级路径。决策取舍见 `docs/adr/0001-todos-json-storage.md`；术语见根 `CONTEXT.md`。

**不做**：不自动 commit；不碰 `todos/` 之外的仓库文件（triage 只读）；无 TUI/状态条；运行时产物（锁/tmp）只落 gitignore 的 `todos/.todo-cli/`。

## 文件地图

- `todo-cli/schema.ts` — JSON schema 纯函数：`parseTodoJson`（fail-closed 校验：非法 JSON/合并冲突标记/字段缺失都明确报错）、`serializeTodo`（两空格缩进 + LF 尾换行）、`nextId`、`emptyTodoData`、`normalizeText`（查重与时间戳回填共用的文本归一化）。schema v1：`{version, title, entries[{id,text,status,branch,tags,notes,createdAt,claimedAt,completedAt}]}`。
- `todo-cli/lock.ts` — 并发安全原语：`acquireTodoLock`/`withTodoLock`（每文件一把 O_EXCL 锁 `todos/.todo-cli/locks/<名>.lock`，内容 `{pid, startedAt}`；busy 静默重试 100ms/30s 上限；残留锁按「内容损坏 / pid 已死 / 超 stale 阈值 60s」抢占；同进程重入放行；`installProcessHooks` 在 exit/SIGINT/SIGTERM 清自持锁——SIGKILL 靠 stale 抢占兜底）；`atomicWriteFile`（temp+rename，tmp 在 `todos/.todo-cli/tmp/`，写前清理 10 分钟过期残留）。
- `todo-cli/query.ts` — 纯函数查询引擎（`applyEntryFilter`/`sortQueryEntries`/`serializeEntries`/`parseFilterOptions`/`statusMark`），零 IO；branch/tags/时间戳是原生字段，无派生双口径。
- `todo-cli/migrate.ts` — markdown ↔ JSON 双向迁移：旧 md 解析（顶层条目 + 括号组扫描剥 `processing`/`完成` 标注 + 缩进子行归并进 notes）、`buildTodoData`（标注 → status/branch/notes，遗留 index.db 尽力回填时间戳）、`renderMarkdown`（规范形态）、`migrateFromMd`（逐文件「渲染→再解析→再构建」等价自检，全过后落盘 JSON + 删 md + 清遗留 index.db*）/`migrateToMd`（逃生回滚，只写 md 绝不删 JSON）。
- `todo-cli/core.ts` — CLI 调度 `main(argv, deps)`（`repoRoot`/`log`/`now`/`execGit` 可注入）+ 查重/路径安全/lint/triage 纯函数 + 七子命令与 migrate 接线。
- `tools/todo.mjs` — 唯一 CLI 入口（薄壳）：`export * from "../todo-cli/core.ts"` + 直接运行时转发 `main`；根测试 import 此路径。
- 根 `test/todo-cli.test.ts` — 15 个测试：命令闭环（add/claim/complete/list/summary/lint/triage，临时 fixture 上跑 `main(deps)`）+ fail-closed + 3 个进程边界 E2E。
- `todo-cli/test/` — `schema.test.ts`(4)、`lock.test.ts`(8，含真子进程持锁/exit 释放)、`query.test.ts`(5)、`migrate.test.ts`(7，roundtrip 恒等/编排/时间戳回填)、`concurrency.test.ts`(2，真实子进程并发 add/claim)、`interrupt.test.ts`(1，SIGKILL 轮次 + stale 自愈 + tmp 清理)。

## 核心数据流

argv → `parseArgs` → `main(argv, deps)` → 读 `todos/*.json`（任一损坏整体 fail-closed）→ 纯函数编排 → 写路径 = `withTodoLock(名)` 临界区内 read-parse-mutate-`serializeTodo` → `atomicWriteFile`（temp+rename）。所有输出走 `log`，**stderr 恒空**（锁忙重试静默；超时是 stdout 静态消息 + exit 1）。`REPO_ROOT` 由脚本位置解析，任意 cwd 调用都作用于本仓库；`.gitattributes` 锁 `todos/*.json text eol=lf` 防 autocrlf 整文件 diff；`.gitignore` 盖 `todos/.todo-cli/`（锁 + tmp 运行时目录）。

## 不变量

- **命令面冻结**：七子命令 `summary/list/add/claim/complete/lint/triage` + `migrate` + `--help` 的用法、退出码、stdout/stderr 约定不变；`db` 子命令已删除。
- **JSON 是唯一真相**：不手工编辑 `todos/*.json`（视为破坏存储）；损坏（非法 JSON/合并冲突标记）→ 明确报错 exit 1，绝不静默修复或猜。
- **退出码语义**：`--help` → 0；裸调用 → USAGE、1；未知命令/子命令 → 提示 + USAGE、1；成功 → 0；锁超时/文件损坏 → 静态消息 + 1。`main` 不抛异常（除依赖注入的原生异常）。
- **路径安全**：`resolveTodoPath` 拒绝穿越；输入 `x`/`x-todo`/`x-todo.md`/`x-todo.json` 四种写法都归一到 `todos/x-todo.json`。
- **match 唯一定位**：`claim`/`complete` 的 `--match` 是纯描述 text 的子串（notes 不参与匹配）；缺失/多条报错，绝不猜第一条。
- **查重口径**：归一化文本后 exact/similar（包含方向短边 ≥8）两级；`add` 默认拒绝重复，`--force` 才写入。
- **动作分离**：`add` 只追加 open 条目（`--tag` 写原生标签）；`claim` 转 processing + `--branch` 写原生 `branch` 字段（已 done 报 `ALREADY_DONE`，已 processing 幂等）；`complete` 转 done + `--note` 逐字进 notes（不解析括号/换行——L16 bug 的根治形态）。
- **条目 id 稳定**：文件内 max+1 分配、永不复用/重排；entries append-only；跨分支合并冲突按 id 取并集手工解决（约定写在 AGENTS 红线 2）。
- **triage 映射精确相等**：worktree 分支 ↔ 条目 `branch` 字段全等（不再做文本包含匹配）；无 branch 的 processing 归「无分支引用」（人工确认），这是设计而非 bug。
- **迁移可逆**：`migrate from-md` 自检不过关一个字节不写；`migrate to-md` 只增 md 不删 JSON；回滚到旧 CLI = `migrate to-md` + git 历史切旧版。
- **lint 单向**：根 manifest 注册的扩展 → 必有同名 `todos/<名>-todo.json`；多余 todo 文件合法不报。

## list 查询 flags（AND 组合）

`--status open|processing|done` / `--file <name>` / `--branch <子串>` / `--tag <词>` / `--text <关键词>` / `--claimed-since <YYYY-MM-DD>`（真实日期校验）/ `--json`。`--json` 输出 `{file,id,status,text,branch,tags,createdAt,claimedAt,completedAt}` 行对象数组（file→id 稳定排序）。人读行格式：`<mark> <file>#<id>  <text>`（mark：done `[x]` / processing `[~]` / open `[ ]`）。无降级分支：时间维度恒可用（历史迁移条目时间戳为 null）。

## migrate 子命令

- `migrate from-md [--dry-run] [--force]`：md → JSON 一次性权威切换。json 已存在即拒绝（`--force` 覆盖）；逐文件「渲染→再解析→再构建」与首次构建 deepEqual（等价自检），任一不过关整体中止零写入；自检全过后写 JSON、删 md、清遗留 `index.db*`。输出顶层条目/三态/注记计数。
- `migrate to-md`：JSON → 规范 md（条目 + `（processing…）`标记还原 + notes 作缩进子行），**保留 JSON**；配合 git 历史旧版 CLI 即可彻底回滚。规范形态 ≠ 迁移前原文件（rawText 按方案 C 放弃，手写标注由 notes 承载）。

## 已知坑

- **`--match` 是子串不是全文**：多条包含该子串报歧义；改写条目文本后旧 match 失效；notes 内容匹配不到（设计如此，防误伤已完成条目）。
- **stale 抢占的窗口**：进程被挂起超 60s 后其锁可被抢占，恢复后会写失败（锁已易主）——重新执行即可；两写者同刻 stale 抢占由 O_EXCL 保证只有一个成功。
- **时间戳 null 的含义**：迁移前历史条目三时间戳为 null（旧索引只覆盖 2026-09-11 后、且不入 git）；`--claimed-since` 对 null 不命中。
- **合并冲突**：两个 worktree 各自 add/claim 后合并，JSON 冲突需手工按 id 取并集（文本 diff 可读）；解决前所有命令 fail-closed 报「合并冲突」。
- **Windows 锁残留**：SIGKILL（TerminateProcess）不跑 exit 钩子，锁文件残留——pid 已死即被下一次写抢占，无需人工清理。
- **无 typecheck 门**：仓库无根级 typecheck；新文件全用可擦除 TS 语法，未来可加门。

## 改动清单

- 必跑：`npm run test:todo`（glob = `test/todo-cli.test.ts` + `todo-cli/test/*.test.ts`；44 个，2026-09-12 实测全绿）+ `node tools/todo.mjs lint`（exit 0）。
- 改行为：同步根 `test/todo-cli.test.ts` + 本卡；改命令面：同步 `core.ts` 的 `USAGE` + 本卡。
- 改 schema：`schema.ts` 版本位 + `parseTodoJson` 校验 + 本卡 + `docs/adr/0001-todos-json-storage.md` 同步。
- 新增子命令/flags：先补根测试（in-process + 必要的进程边界用例）再实现，并确认退出码与 stdout 约定不变。
