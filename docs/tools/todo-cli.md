# todo-cli — todos/ 工作流仓库 CLI

> last verified @ fa630a3

## 职责与边界

把 AGENTS.md 规则 1 的 `todos/` 工作流（登记 → 领取 → 对齐 → 完成 + 开工/收尾盘点 triage）从「agent 手写 grep + edit」变成可测试的原子命令。**CLI-only**：不注册任何 Pi 扩展 API（无 agent 工具、无冒号命令）、无 npm 依赖、无 Pi/宿主依赖；`node tools/todo.mjs <子命令>` 是唯一入口，任意 cwd 可用。

**存储（方案 C，todos/todo-cli-todo.md:17）**：`todos/<名>.json` 是唯一持久真相——无 markdown、无 sqlite 索引层、无降级路径。决策取舍见 `docs/adr/0002-todos-json-storage.md`；术语见根 `CONTEXT.md`。

**对齐门（schema v2，todo-cli-todo:11 / `docs/adr/0003-todo-align-gate.md`）**：状态机五态 `open → aligning → aligned → processing → done`。首次 `claim` 只进 aligning（此阶段写逐条对齐文档、与人工确认，禁止写代码），`align` 结构校验文档后进 aligned，再次 `claim` 才进 processing（此后到 merge 无人值守）。CLI 只保证迁移顺序与文档结构，人工门本身靠文档 `## 人工确认` 小节 + 红线 10 审批留痕。

**不做**：不自动 commit；不碰 `todos/` 之外的仓库文件（triage 只读）；无 TUI/状态条；运行时产物（锁/tmp）只落 gitignore 的 `todos/.todo-cli/`。

## 文件地图

- `todo-cli/schema.ts` — JSON schema 纯函数：`parseTodoJson`（fail-closed：非法 JSON/合并冲突标记/字段缺失都明确报错）、`serializeTodo`（两空格缩进 + LF 尾换行）、`nextId`、`emptyTodoData`、`normalizeText`。**schema v2**：`{version, title, entries[{id,text,status,branch,tags,notes,createdAt,claimedAt,completedAt,alignedAt}]}`；读接受 `version: 1|2` 并归一成 v2（v1 的 alignedAt 视为 null），写出一律 v2，v2 条目缺 `alignedAt` 即 fail-closed。
- `todo-cli/align.ts` — 对齐文档契约纯函数（零 IO）：`alignDocRelPath`/`alignDocPath`（固定派生 `todos/align/<文件基名>#<id>.md`）、`ALIGN_SECTIONS`（意图/范围/验收标准/人工确认）、`validateAlignDoc`（条目标记 `<名>#<id>` + 四小节各需非空正文；返回缺项清单）。
- `todo-cli/lock.ts` — 并发安全原语：`acquireTodoLock`/`withTodoLock`（每文件一把 O_EXCL 锁 `todos/.todo-cli/locks/<名>.lock`，内容 `{pid, startedAt}`；busy 静默重试 100ms/30s 上限；残留锁按「内容损坏 / pid 已死 / 超 stale 阈值 60s」抢占；同进程重入放行；`installProcessHooks` 在 exit/SIGINT/SIGTERM 清自持锁——SIGKILL 靠 stale 抢占兜底）；`atomicWriteFile`（temp+rename，tmp 在 `todos/.todo-cli/tmp/`，写前清理 10 分钟过期残留）。
- `todo-cli/query.ts` — 纯函数查询引擎（`applyEntryFilter`/`sortQueryEntries`/`serializeEntries`/`parseFilterOptions`/`statusMark`），零 IO；五态标记 `[ ]`/`[?]`/`[>]`/`[~]`/`[x]`。
- `todo-cli/migrate.ts` — markdown ↔ JSON 双向迁移：旧 md 解析（顶层条目 + 括号组剥 `aligning`/`aligned`/`processing`/`完成` 标注 + 缩进子行归并进 notes）、`buildTodoData`（标注 → status/branch/notes，产 v2）、`renderMarkdown`（规范形态，五态标注还原）、`migrateFromMd`（逐文件「渲染→再解析→再构建」等价自检，全过后落盘 + 删 md + 清遗留 index.db*）/`migrateToMd`（逃生回滚，只写 md 绝不删 JSON）。
- `todo-cli/core.ts` — CLI 调度 `main(argv, deps)`（`repoRoot`/`log`/`now`/`execGit` 可注入）+ 查重/路径安全/lint/triage 纯函数 + 八子命令与 migrate 接线。
- `tools/todo.mjs` — 唯一 CLI 入口（薄壳）：`export * from "../todo-cli/core.ts"` + 直接运行时转发 `main`；根测试 import 此路径。
- 根 `test/todo-cli.test.ts` — 21 个测试：命令闭环（两段式 claim / align 门 / complete 收口门 / list / summary / lint / triage，临时 fixture 上跑 `main(deps)`）+ fail-closed + 进程边界 E2E。
- `todo-cli/test/` — `schema.test.ts`(7)、`align.test.ts`(6)、`lock.test.ts`(8，含真子进程持锁/exit 释放)、`query.test.ts`(5)、`migrate.test.ts`(9，roundtrip 恒等/编排/时间戳回填)、`concurrency.test.ts`(3，真实子进程并发 add/claim/align)、`interrupt.test.ts`(1，SIGKILL 轮次 + stale 自愈 + tmp 清理)。

## 核心数据流

argv → `parseArgs` → `main(argv, deps)` → 读 `todos/*.json`（任一损坏整体 fail-closed）→ 纯函数编排 → 写路径 = `withTodoLock(名)` 临界区内 read-parse-mutate-`serializeTodo` → `atomicWriteFile`（temp+rename）。所有输出走 `log`，**stderr 恒空**（锁忙重试静默；超时是 stdout 静态消息 + exit 1）。`REPO_ROOT` 由脚本位置解析，任意 cwd 调用都作用于本仓库；`.gitattributes` 锁 `todos/*.json` 与 `todos/align/*.md` 的 `text eol=lf`；`.gitignore` 盖 `todos/.todo-cli/`。

## 状态机迁移表（对齐门）

| 命令 | 当前状态 | 结果 |
| --- | --- | --- |
| `claim [--branch X]` | open | → `aligning`；`branch` = 提供值或 null；`claimedAt` 首次领取写入后不再覆盖 |
| `claim` | aligning | 幂等（不写盘）；仍输出对齐文档路径 + 必填小节 |
| `claim [--branch X]` | aligned | → `processing`；提供了 `--branch` 才覆盖，未提供保留原引用 |
| `claim` | processing | 幂等（不写盘） |
| `claim` | done | `ALREADY_DONE` + exit 1 |
| `align [--note T]` | aligning | 文档校验通过 → `aligned`；写 `alignedAt`，`--note` 逐字进 notes |
| `align` | aligned | 幂等（不写盘） |
| `align` | open/processing/done | `NOT_ALIGNING` + exit 1 |
| `complete [--note T]` | open / processing | → `done`；`--note` 可选 |
| `complete [--note T]` | aligning / aligned | → `done`；**必须带 `--note`**，否则 `NOTE_REQUIRED` |
| `complete` | done | 幂等（不写盘） |

对齐文档单源模板（`claim` 只打印路径与必填小节，不代建文件；缺失报 `ALIGN_DOC_MISSING`，结构不完整报 `ALIGN_DOC_INCOMPLETE：对齐文档缺少小节：<清单>`）：

```markdown
# <文件基名>#<id> <一句话标题>

## 意图
## 范围
（做什么 / 明确不做什么）
## 验收标准
## 人工确认
（确认人、日期、方式）
```

`lint` 不变（仍只做注册扩展 ↔ todo 文件的单向核对）；「aligned 条目缺文档」不在 lint 报（由 `align` 在门上报）。

## 不变量

- **命令面冻结**：八子命令 `summary/list/add/claim/align/complete/lint/triage` + `migrate` + `--help` 的用法、退出码、stdout/stderr 约定不变；`db` 子命令已删除。
- **JSON 是唯一真相**：不手工编辑 `todos/*.json`；损坏（非法 JSON/合并冲突标记）→ 明确报错 exit 1，绝不静默修复或猜。写出一律 v2；v1 文件被写一次即整体升级（不做批量回填）。
- **退出码语义**：`--help` → 0；裸调用 → USAGE、1；未知命令/子命令 → 提示 + USAGE、1；成功 → 0；门不过/缺文档/锁超时/文件损坏 → 静态消息 + 1。`main` 不抛异常（除依赖注入的原生异常）。
- **路径安全**：`resolveTodoPath` 拒绝穿越；输入 `x`/`x-todo`/`x-todo.md`/`x-todo.json` 都归一到 `todos/x-todo.json`；`list --file` 按同一归一（core 用 docs 里的真实归属名回填 filter），查不到 → 明确报错 exit 1，绝不倒向空结果。对齐文档路径固定派生（无 `--doc` 自由路径 ⇒ 无穿越面）。
- **match 唯一定位**：`claim`/`align`/`complete` 的 `--match` 是纯描述 text 的子串（notes 不参与）；缺失/多条报错，绝不猜第一条。
- **查重口径**：归一化文本后 exact/similar（包含方向短边 ≥8）两级；`add` 默认拒绝重复，`--force` 才写入。
- **动作分离**：`add` 只追加 open 条目（`--tag` 写原生标签）；`claim` 两段式（open→aligning / aligned→processing，aligning/processing 幂等不写盘）；`align` 只做 aligning→aligned（文档结构校验 fail-closed）；`complete` 转 done + `--note` 逐字进 notes，从 aligning/aligned 收口必须带 `--note`。
- **人工门可审计性上限**：CLI 只保证顺序与文档结构，不能证明「是人敲的」；确认留痕 = 文档 `## 人工确认` + 审批记录（ADR-0003）。
- **依赖门插位（未实现，#10）**：`dependsOn`/环检测将插在 `aligned → processing` 之前（对齐已完成、尚未开工）。
- **条目 id 稳定**：文件内 max+1 分配、永不复用/重排；entries append-only；跨分支合并冲突按 id 取并集手工解决（约定写在 AGENTS 红线 1）。
- **triage 映射精确相等**：worktree 分支 ↔ 条目 `branch` 字段全等；`aligning`/`aligned`/`processing` 三段同构（`{total,active,stale,noRef}`），无 branch 引用的在途条目归「无分支引用」（人工确认），这是设计而非 bug。
- **迁移可逆**：`migrate from-md` 自检不过关一个字节不写；`migrate to-md` 只增 md 不删 JSON；回滚到旧 CLI = git 历史 + `migrate to-md`（旧 CLI 读 v2 文件明确报错 `version 必须是 1`）。
- **lint 单向**：根 manifest 注册的扩展 → 必有同名 `todos/<名>-todo.json`；多余 todo 文件合法不报。

## list 查询 flags（AND 组合）

`--status open|aligning|aligned|processing|done` / `--file <name>`（短名/全名等价）/ `--branch <子串>` / `--tag <词>` / `--text <关键词>` / `--claimed-since <YYYY-MM-DD>`（真实日期校验）/ `--json`。`--json` 输出 `{file,id,status,text,branch,tags,createdAt,claimedAt,completedAt,alignedAt}` 行对象数组（file→id 稳定排序）。人读行：`<mark> <file>#<id>  <text>`（`[ ]` open / `[?]` aligning / `[>]` aligned / `[~]` processing / `[x]` done）。非法 `--status` 值给空结果（沿旧语义，不报错）。`summary` 列 = `open • aligning • aligned • processing • done • total`（`--json` 行同名）。

## migrate 子命令

- `from-md [--dry-run] [--force]`：md → JSON 一次性权威切换（json 已存在即拒绝，`--force` 覆盖）；逐文件「渲染→再解析→再构建」等价自检，任一不过关整体零写入；全过后写 v2 JSON、删 md、清遗留 `index.db*`，输出五态/注记计数。`to-md`：JSON → 规范 md（五态标注还原为 `（aligning|aligned|processing @ 分支）` + notes 作缩进子行），**保留 JSON**，配合 git 历史旧版 CLI 回滚。

## 已知坑

- **`--match` 是子串不是全文**：多条包含该子串报歧义；改写条目文本后旧 match 失效；notes 内容匹配不到（设计如此，防误伤）。
- **对齐文档只校验结构**：小节标题 + 任意非空正文即通过（模板里的提示行也算正文）；`claim` 不代建文件，未写文档就跑 `align` 必报 `ALIGN_DOC_MISSING`。
- **v2 升版一次性生效**：任一写操作重写整文件 ⇒ 该文件整体变 v2（`version: 2` + 每条 `alignedAt: null`，diff 一次性）；旧版 CLI 读到 v2 直接报错，回滚走 git 历史。
- **锁残留与 stale 抢占**：进程挂起超 60s 后其锁可被抢占（恢复后写失败，重跑即可）；Windows SIGKILL 不跑 exit 钩子、锁文件残留，pid 已死即被下一次写抢占，无需人工清理。
- **时间戳 null 的含义**：迁移前历史条目三时间戳为 null（`--claimed-since` 对 null 不命中）；历史 `processing` 视为「已开工」，不要求补对齐文档、不回退状态。
- **合并冲突**：两个 worktree 各自 add/claim 后合并，JSON 冲突需手工按 id 取并集（文本 diff 可读）；解决前所有命令 fail-closed 报「合并冲突」。

## 改动清单

- 必跑：`npm run test:todo`（glob = `test/todo-cli.test.ts` + `todo-cli/test/*.test.ts`；60 个，2026-09-14 实测全绿）+ `node tools/todo.mjs lint`（exit 0）；仓库无根级 typecheck 门，新文件全用可擦除 TS 语法。
- 改行为：同步根 `test/todo-cli.test.ts` + 本卡；改命令面：同步 `core.ts` 的 `USAGE` + 本卡。
- 改 schema：`schema.ts` 版本位 + `parseTodoJson` 校验 + 本卡 + `docs/adr/0002`/`0003` 同步。
- 新增子命令/flags：先补根测试（in-process + 必要的进程边界用例）再实现，并确认退出码与 stdout 约定不变。
