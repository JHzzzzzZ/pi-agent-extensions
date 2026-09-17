# todo-cli — todos/ 工作流 CLI（仓库内 skill 资产）

> last verified @ 5daf197

## 职责与边界

把 AGENTS.md 规则 1 的 `todos/` 工作流（登记 → 领取 → 对齐 → 依赖校验 → 完成 + 开工/收尾盘点 triage）从「agent 手写 grep + edit」变成可测试的原子命令。**CLI-only**：不注册任何 Pi 扩展 API（无 agent 工具、无冒号命令）、无 npm 依赖、无 Pi/宿主依赖。

**位置（todo-cli-todo:9）**：工具是仓库内**项目级 skill** 的资产，入口与实现同居：`<仓库>/.agents/skills/todo-cli/todo-cli/todo.mjs`（技能根另有 `SKILL.md` 命令参考卡 + `scripts/todo.sh` 包装器）。仓库根曾平铺的 `tools/todo.mjs` + `todo-cli/` 已删除，没保留转发壳。

**仓库根发现**：`deps.repoRoot`（测试注入）> `--root <dir>`（相对 cwd 解析、必须是已存在目录）> `git rev-parse --show-toplevel`（以 `process.cwd()` 为工作目录，仓库子目录亦可）> **fail-closed**（静态消息 + exit 1，绝不静默回退 cwd）。因此任意 git 仓库任意 cwd 都作用于**当前 cwd 所属仓库**的 `todos/`（在 `.worktrees/<名>` 里调用 → 该 worktree 的台账，不再是旧日的「脚本所在主仓」）。`--help` / 裸调用 / 未知命令不触发根发现。

**skill 加载核验（无头可复现）**：`printf '{"type":"get_commands"}\n' | pi --mode rpc --no-session --approve` 的响应里应出现 `"name":"skill:todo-cli"` 且 `scope: project`（路径 = `.agents/skills/todo-cli/SKILL.md`）。项目级 skill **只在项目被信任时加载**（交互式信任或 `--approve`），未信任时静默缺席。

**存储（方案 C，todos/todo-cli-todo.md:17）**：`todos/<名>.json` 是唯一持久真相——无 markdown、无 sqlite 索引层、无降级路径。决策取舍见 `docs/adr/0002-todos-json-storage.md`；术语见根 `CONTEXT.md`。

**对齐门（todo-cli-todo:11 / `docs/adr/0003-todo-align-gate.md`）**：状态机五态 `open → aligning → aligned → processing → done`。首次 `claim` 只进 aligning（此阶段写逐条对齐文档、与人工确认，禁止写代码），`align` 结构校验文档后进 aligned，再次 `claim` 才进 processing（此后到 merge 无人值守）。CLI 只保证迁移顺序与文档结构，人工门本身靠文档 `## 人工确认` 小节 + 红线 10 审批留痕。

**依赖门（schema v3 引入，todo-cli-todo:10 / `docs/adr/0005-todo-depends-on.md`）**：条目原生字段 `dependsOn`（规范引用 `文件基名#id`，可跨文件；输入接受与 `--file` 同口径的四种写法，存储统一归一）。唯一硬门是第二次 `claim`（`aligned → processing`）：存在未完成（或悬空）依赖时报 `DEP_BLOCKED` 并逐条列出等待对象与状态，条目留在 aligned、不写盘；首次 `claim`（open→aligning）与 `align` 不受门约束（被阻塞条目可以先对齐再排队）。写路径（`add --dep` / `dep add`）拒绝悬空目标、自引用与环（回显环路径），`lint` 另做全量图扫描兜住合并产物。`complete` 一律 `done` ⇒ 机械解锁（含取消/搁置），并输出一行直接依赖者提示。依赖是一维直接约束：不展开下游、不做自动等待；`priority` 字段**不参与门判定**（只影响展示/排序）。

**优先级（priority，todo-cli-todo:15 / `docs/adr/0009-todo-priority-soft-field.md`）**：条目可选软字段 `priority`（整数 1-10，**10 最高**，缺省 5）。`add --priority 1-10` 是唯一写入通道（缺省 5；非整数/越界/裸 `--priority` 报 `BAD_PRIORITY` + exit 1 不写盘；前导零 `05` 按数值 5 接受；成功日志不回显）；`list` 人读行在 `文件#id` 两空格后显示 `[pN]`（不零填充），`list --sort priority` 按 `priority 降序 → file 升序 → id 升序` 排（同值桶保持默认序），`list --json` 带 `priority`。**全版本可选软字段**：旧文件缺字段读时兜底 5（读命令不写盘），任一写操作重写时顺带补 5；字段出现但非法（`"高"`/`3.5`/`0`/`11`/`null`）报 `BAD_SCHEMA`（fail-closed 不静默兜底）。不占版本位（v3→v4 归姊妹单 globalId，对 v1-v4 都语义一致地可选）；不进状态机、依赖门、查重与 `summary`/`triage` 输出；无 `priority set`（改值走 `reopen` → 重登记）。

**回退通道（reopen，todo-cli-todo:14 / `docs/adr/0007-todo-reopen.md`）**：五态只前向，唯一受支持的回退是 `reopen --file <名> --match "子串" [--note "原因"]`——`aligning` / `aligned` / `processing` 一律退回 `open`（清 `branch`/`claimedAt`/`alignedAt`，`id`/`text`/`createdAt`/`tags`/`dependsOn`/历史 notes 原样），notes 追加 `撤销 <UTC 日期>：从 <源状态> 回到未领取`（`--note` 以 `；` 相接、逐字）。从 `aligning`/`aligned` 撤销必须带 `--note`（`NOTE_REQUIRED`）；`done` 拒绝（`ALREADY_DONE`，撤销已完成另条登记）；已是 `open` 幂等（文件字节不变）。存在对齐文档时先归档为 `todos/align/<名>#<id>.reopened-<UTC 紧凑>.md` 再写盘（`ALIGN_ARCHIVE_FAILED` ⇒ JSON 零改动），规范路径腾空后必须重写新文档才能再过 `align`。不碰依赖语义与 git/worktree，无批量形态。

**全局 id（schema v4，todo-cli-todo:16 / `docs/adr/0008-todo-global-id.md`）**：条目新增 `globalId`——全台账唯一、永不回收的统一主键，计数器 `todos/.todo-cli/next-id`（gitignore、缺失自愈 `max(全台账条目 id, globalId)+1`、损坏报 `ID_COUNTER_CORRUPT`）在 `locks/id.lock` 内发号（只前进）。**双轨**：`文件#id` 继续承担展示 / `dependsOn` / 对齐文档命名 / `--match`（人类契约字节不变），`globalId` 只进 `list --json` 与机器判定（lint 查重、合并冲突判同条目）。读 v1-v3 文件 `globalId` 归一 null：读命令照常，六个写命令（add/claim/align/complete/reopen/dep）fail-closed 报 `GLOBAL_ID_PENDING`（先 `migrate global-id`）；lint 增缺失/重复两类问题行。存量一次性迁移见下。

**不做**：不自动 commit；不碰 `todos/` 之外的仓库文件（triage 只读；reopen 只改 `todos/align/` 下的对齐文档名）；无 TUI/状态条；运行时产物（锁/tmp/计数器）只落 gitignore 的 `todos/.todo-cli/`。

## 文件地图

- `.agents/skills/todo-cli/todo-cli/schema.ts` — JSON schema 纯函数：`parseTodoJson`（fail-closed：非法 JSON/合并冲突标记/字段缺失都明确报错）、`serializeTodo`（两空格缩进 + LF 尾换行）、`nextId`、`emptyTodoData`、`normalizeText`、`normalizeTodoName`（文件名四写法归一；core 路径解析与 depends 引用解析共用同一口径）。**schema v4**：`{version, title, entries[{id,globalId,text,status,branch,tags,priority,dependsOn,notes,createdAt,claimedAt,completedAt,alignedAt}]}`；读接受 `version: 1|2|3|4` 并归一成 v4（旧版缺 `alignedAt` → null、缺 `dependsOn` → []、缺 `globalId` → null；v1-v3 带合法 globalId 则保留），写出一律 v4，v4 条目缺 `globalId`（或非正整数）即 fail-closed。`priority` 是首个不走版本门控的**全版本可选软字段**（缺失兜底 5；出现但非 1-10 整数 → `BAD_SCHEMA`），不占版本位（ADR-0009）。schema 层只管字段形态，不管引用存在性与图（那是 depends.ts）。
- `.agents/skills/todo-cli/todo-cli/depends.ts` — 依赖引用与依赖图纯函数（零 IO，ADR-0005）：`parseDepRef`/`normalizeDepRef`/`formatDepRef`（四写法归一、非法拒绝）、`checkDepWrite`（写前校验悬空/自引用/环；无依赖时走空快路径——**不得给锁临界区加成本**）、`findDepProblems`（lint 全量：悬空/自引用 + 三色 DFS 找环）、`blockingDeps`/`blockedByMap`（未完成的直接依赖清单，非空即阻塞）、`dependentsOf`（complete 提示反查）。
- `.agents/skills/todo-cli/todo-cli/align.ts` — 对齐文档契约纯函数（零 IO）：`alignDocRelPath`/`alignDocPath`（固定派生 `todos/align/<文件基名>#<id>.md`）、`ALIGN_SECTIONS`（意图/范围/验收标准/人工确认）、`validateAlignDoc`（条目标记 `<名>#<id>` + 四小节各需非空正文；返回缺项清单）；`archiveStamp`（ISO → `YYYYMMDDTHHMMSSZ`）与 `reopenArchiveRelPath`/`reopenArchivePath`（reopen 归档路径，后缀仍 `.md`）。
- `.agents/skills/todo-cli/todo-cli/lock.ts` — 并发安全原语：`acquireTodoLock`/`withTodoLock`（每文件一把 O_EXCL 锁 `todos/.todo-cli/locks/<名>.lock`，内容 `{pid, startedAt}`；busy 静默重试 100ms/30s 上限；残留锁按「内容损坏 / pid 已死 / 超 stale 阈值 60s」抢占；同进程重入放行；`installProcessHooks` 在 exit/SIGINT/SIGTERM 清自持锁——SIGKILL 靠 stale 抢占兜底）；`atomicWriteFile`（temp+rename，tmp 在 `todos/.todo-cli/tmp/`，写前清理 10 分钟过期残留）；全局 id 计数器取号复用同一原语（锁名 `id`）。
- `.agents/skills/todo-cli/todo-cli/globalid.ts` — 全局 id 计数器与健康判定（todo-cli-todo:16）：`allocateGlobalId`（`locks/id.lock` 临界区内读改写 `todos/.todo-cli/next-id`，计数器缺失自愈 `max(全台账条目 id, globalId)+1`，损坏报 `ID_COUNTER_CORRUPT` 且不覆盖损坏文件）、`peekNextGlobalId`（dry-run 只读预看）、`findGlobalIdProblems`（缺失/重复；lint 与迁移预检共用）、`verifyGlobalIdMigration`（迁移前后逐字段等价自检，priority 等既有字段天然纳入）。不 import core/migrate（无环）。
- `.agents/skills/todo-cli/todo-cli/query.ts` — 纯函数查询引擎（`applyEntryFilter`/`sortQueryEntries`/`sortByPriority`/`serializeEntries`/`parseFilterOptions`/`statusMark`），零 IO；`QueryEntry` 带 `globalId` 与 `priority`（只进 `--json`，人读行不含 globalId）；五态标记 `[ ]`/`[?]`/`[>]`/`[~]`/`[x]`；人读行在 `file#id` 后带 `[pN]`（priority，不零填充）；`--sort priority` = priority desc → file asc → id asc（同值桶回落默认序）；阻塞条目行尾追加 `（阻塞：等待 <引用清单>）`——`blockedBy` 由 core 算好传进来，query 不查台账、不解析依赖图。
- `.agents/skills/todo-cli/todo-cli/migrate.ts` — markdown ↔ JSON 双向迁移：旧 md 解析（顶层条目 + 括号组剥 `aligning`/`aligned`/`processing`/`完成` 标注 + 缩进子行归并进 notes）、`buildTodoData`（标注 → status/branch/notes，产 v4、`dependsOn` 一律空、`priority` 一律 5——md 没有依赖/优先级语法；globalId 先置 null、由落盘编排逐条取号）、`renderMarkdown`（规范形态，五态标注还原；不渲染 priority）、`migrateFromMd`（逐文件「渲染→再解析→再构建」等价自检，全过后落盘 v4 + 删 md + 清遗留 index.db*）/`migrateToMd`（逃生回滚，只写 md 绝不删 JSON；globalId 不进 md；豁免写门禁）/`migrateGlobalId`（存量一次性取号，见下）。
- `.agents/skills/todo-cli/todo-cli/core.ts` — CLI 调度 `main(argv, deps)`（`repoRoot`/`cwd`/`log`/`now`/`execGit` 可注入）+ `resolveRepoRoot`（根发现纯函数）+ 查重/路径安全/lint（含依赖图全量扫描与 globalId 缺失/重复）/triage 纯函数 + 十子命令（含 `dep add|remove` 与 `reopen`；`add --priority` / `list --sort` 选项接线，非法值 `BAD_PRIORITY`）与 migrate 接线、六个写命令的 `GLOBAL_ID_PENDING` 门禁。
- `.agents/skills/todo-cli/todo-cli/todo.mjs` — 唯一 CLI 入口（与实现同目录）：`export * from "./core.ts"` + 直接运行时转发 `main`。
- `.agents/skills/todo-cli/SKILL.md` + `scripts/todo.sh` — 技能面：命令参考卡（frontmatter 合法即被 Pi 当项目级 skill 加载）与包装器（定位内层工具，不指向已删除的旧入口）。
- `test/`（同一 `todo-cli/` 目录内）— `todo-cli.test.ts`(45，命令闭环：两段式 claim / align 门 / complete 收口门 / reopen 回退与归档 / list / summary / lint / triage / globalId 落盘与写门禁 / priority（add --priority、`[pN]`、--sort priority）+ fail-closed + 进程边界 E2E)、`root-discovery.test.ts`(7，`--root`/git/失败路径纯测 + 真实 `git init` 子目录发现 E2E)、`skill.test.ts`(2，SKILL.md frontmatter 与命令面 + 包装器指向)、`schema.test.ts`(13)、`align.test.ts`(6)、`depends.test.ts`(7)、`lock.test.ts`(8)、`query.test.ts`(11)、`migrate.test.ts`(14)、`globalid.test.ts`(6，计数器取号/自愈/损坏/迁移等价纯函数)、`concurrency.test.ts`(5，真子进程并发 add/claim/align/dep + 跨文件并发取号；经 `withFailureScene` 接线失败现场)、`interrupt.test.ts`(1，SIGKILL 轮次 + stale 自愈 + tmp 清理 + 号不重号；同接线)、`failure-scene.ts`（失败现场诊断 helper，不匹配 `*.test.ts` glob 且不进 fixture 拷贝清单）、`failure-scene.test.ts`(9，现场渲染/同一 Error 重抛/碰撞序号/真子进程注入契约)。

## 核心数据流

argv → `parseArgs` → `main(argv, deps)` → **仓库根发现**（`deps.repoRoot` > `--root` > `git rev-parse --show-toplevel`；失败即中止，不碰文件）→ 读 `todos/*.json`（任一损坏整体 fail-closed）→ 纯函数编排 → 写路径 = `withTodoLock(名)` 临界区内 read-parse-mutate-`serializeTodo` → `atomicWriteFile`（temp+rename）；`add` 与两个迁移命令在文件锁内再取 `locks/id.lock` 读改写计数器 `todos/.todo-cli/next-id`（锁序恒为 文件锁 → id 锁，全库唯一嵌套、无反向路径），六个写命令另有 `GLOBAL_ID_PENDING` 门禁（缺号台账零写盘 fail-closed，读命令容忍 null 瞬态）。所有输出走 `log`，**stderr 恒空**（锁忙重试静默；发现失败/超时是 stdout 静态消息 + exit 1；git 调用的 stderr 被吞）。`.gitattributes` 锁 `todos/*.json` 与 `todos/align/*.md` 的 `text eol=lf`（另：`*.sh` 锁 LF，避免 Windows 检出把 `scripts/todo.sh` 变 CRLF）；`.gitignore` 盖 `todos/.todo-cli/`。

## 状态机迁移表（对齐门）

| 命令 | 当前状态 | 结果 |
| --- | --- | --- |
| `claim [--branch X]` | open | → `aligning`；`branch` = 提供值或 null；`claimedAt` 首次领取写入后不再覆盖 |
| `claim` | aligning | 幂等（不写盘）；仍输出对齐文档路径 + 必填小节 |
| `claim [--branch X]` | aligned | → `processing`；提供了 `--branch` 才覆盖，未提供保留原引用 |
| `claim` | processing | 幂等（不写盘） |
| `claim` | done | `ALREADY_DONE` + exit 1 |
| `claim` | aligned（有未完成/悬空依赖） | `DEP_BLOCKED` + exit 1；逐条列出 `<引用>（<状态>）`（悬空标 `不存在`）；**不写盘**，条目留在 `aligned` |
| `dep add --on a#1,b#2` | 任意（不动状态机） | 去重保序追加到 `dependsOn`；已声明则幂等「状态未变」；悬空/自引用/环 → `DEP_NOT_FOUND`/`DEP_SELF`/`DEP_CYCLE` + exit 1，引用格式非法 → `DEP_REF_INVALID` |
| `dep remove --on a#1` | 任意（不动状态机） | 移除已声明引用；未声明 → `DEP_ABSENT` + exit 1；不动任何时间戳 |
| `align [--note T]` | aligning | 文档校验通过 → `aligned`；写 `alignedAt`，`--note` 逐字进 notes |
| `align` | aligned | 幂等（不写盘） |
| `align` | open/processing/done | `NOT_ALIGNING` + exit 1 |
| `complete [--note T]` | open / processing | → `done`；`--note` 可选 |
| `complete [--note T]` | aligning / aligned | → `done`；**必须带 `--note`**，否则 `NOTE_REQUIRED` |
| `complete` | done | 幂等（不写盘） |
| `reopen [--note T]` | aligning / aligned | → `open`；清 `branch`/`claimedAt`/`alignedAt`，其余字段与历史 notes 原样；**必须带 `--note`**，否则 `NOTE_REQUIRED`；对齐文档先归档 |
| `reopen [--note T]` | processing | → `open`；同上但 `--note` 可选 |
| `reopen` | open | 幂等（不写盘、文件字节不变） |
| `reopen` | done | `ALREADY_DONE` + exit 1（撤销已完成条目另条登记） |

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

`lint` = 注册扩展 ↔ todo 文件的单向核对 + 依赖图全量扫描（悬空/自引用/环）+ globalId 健康扫描（缺失 `globalId 缺失：<名>#<id>（未迁移）`、重复 `globalId 重复：<号>（<名甲>#<id甲> 与 <名乙>#<id乙>）`，有问题 exit 1）；「aligned 条目缺文档」不在 lint 报（由 `align` 在门上报）。

## 不变量

- **命令面契约（十子命令）**：`summary/list/add/claim/align/complete/reopen/dep/lint/triage` + `migrate from-md|to-md|global-id` + `--help`；子命令增减与参数变化都是契约变更，必须同变更同步 `USAGE`、`SKILL.md` 与本卡（`REPO_COMMANDS` 漏加会被当未知命令；`db` 子命令已删除，不重加）。
- **JSON 是唯一真相**：不手工编辑 `todos/*.json`；损坏（非法 JSON/合并冲突标记）→ 明确报错 exit 1，绝不静默修复或猜。写出一律 v4（v1/v2/v3 读入归一、缺 `globalId` 归一为 null）；旧版文件被写一次即整体升版（不做批量回填）。
- **退出码语义**：`--help` → 0；裸调用 → USAGE、1；未知命令/子命令 → 提示 + USAGE、1；成功 → 0；门不过/缺文档/锁超时/文件损坏 → 静态消息 + 1。`main` 不抛异常（除依赖注入的原生异常）。
- **路径安全**：`resolveTodoPath` 拒绝穿越；输入 `x`/`x-todo`/`x-todo.md`/`x-todo.json` 都归一到 `todos/x-todo.json`（归一规则单源在 `schema.ts` 的 `normalizeTodoName`，依赖引用 `x#3` 走同一函数）；`list --file` 按同一归一（core 用 docs 里的真实归属名回填 filter），查不到 → 明确报错 exit 1，绝不倒向空结果。对齐文档路径固定派生（无 `--doc` 自由路径 ⇒ 无穿越面）。
- **根发现唯一规则**：`--root` 显式 > git 自动发现；`--root` 只接受已存在目录（相对 cwd 解析）。删除了模块级 `REPO_ROOT` 常量与「脚本位置即仓库根」的隐式契约——工具位置与仓库根已解耦。
- **match 唯一定位**：`claim`/`align`/`complete` 的 `--match` 是纯描述 text 的子串（notes 不参与）；缺失/多条报错，绝不猜第一条。
- **查重口径**：归一化文本后 exact/similar（包含方向短边 ≥8）两级；`add` 默认拒绝重复，`--force` 才写入。
- **动作分离**：`add` 只追加 open 条目（`--tag` 写原生标签、`--dep` 写归一化依赖引用、`--priority` 写优先级且缺省 5）；`claim` 两段式（open→aligning / aligned→processing，aligning/processing 幂等不写盘）；`align` 只做 aligning→aligned（文档结构校验 fail-closed）；`dep` 只改 `dependsOn`；`complete` 转 done + `--note` 逐字进 notes，从 aligning/aligned 收口必须带 `--note`；`reopen` 只做在途→open 的回退 + 对齐文档归档（ADR-0007）。
- **人工门可审计性上限**：CLI 只保证顺序与文档结构，不能证明「是人敲的」；确认留痕 = 文档 `## 人工确认` + 审批记录（ADR-0003）。
- **依赖门（#10，实现落点）**：唯一硬门在第二次 `claim` 前；引用归一/环检测/阻塞判定全在 depends.ts（零 IO 纯函数）；`add`/`claim`/`dep`/`complete` 共用同一条锁与原子写；依赖校验在无依赖时走快路径——**不得拖长锁临界区**（Windows 上并发写会放大 rename 争用，见已知坑）。悬空引用按阻塞处理（不放行）。
- **全局 id（#16）**：`globalId` 全台账唯一、永不回收（complete/reopen 不归还，失败/中止烧号留缺口）；计数器只经 `locks/id.lock` + 原子写、不入库（fresh clone 缺失时自愈 `max(全台账 id, globalId)+1`）；v4 落盘恒为正整数（null 只在读 v1-v3 的瞬态出现），六个写命令在缺号台账上 `GLOBAL_ID_PENDING` fail-closed、读命令与 lint 容忍；双轨契约（`文件#id` 展示/dependsOn/对齐文档/`--match` 字节不变，globalId 只进 `list --json` 与 lint/合并仲裁）。
- **priority 软字段（#15）**：1-10 整数（10 最高、缺省 5）；`add --priority` 是唯一写入通道（非法 `BAD_PRIORITY` fail-closed 不写盘，消息静态模板）；schema 层「缺失兜底 5、出现必查（`BAD_SCHEMA`）」且不占版本位（ADR-0009）；不进状态机/依赖门/查重，`summary`/`triage` 不泄漏；无 `priority set`。
- **条目 id 稳定**：文件内 max+1 分配、永不复用/重排；entries append-only；跨分支合并冲突按 globalId 判同条目取并集（`文件#id` 展示不变）手工解决（约定写在 AGENTS 红线 1）。
- **triage 映射精确相等**：worktree 分支 ↔ 条目 `branch` 字段全等；`aligning`/`aligned`/`processing` 三段同构（`{total,active,stale,noRef}`），无 branch 引用的在途条目归「无分支引用」（人工确认），这是设计而非 bug。
- **迁移可逆**：`migrate from-md` 自检不过关一个字节不写；`migrate to-md` 只增 md 不删 JSON；回滚到旧 CLI = git 历史 + `migrate to-md`（旧 CLI 读 v4 文件明确报错 `version 必须是 1、2 或 3`）。
- **lint 单向**：根 manifest 注册的扩展 → 必有同名 `todos/<名>-todo.json`；多余 todo 文件合法不报。另做依赖图全量扫描（悬空引用/自引用/环）+ globalId 缺失/重复扫描——跨分支合并能造出写路径没见过的图与重复号。

## list 查询 flags（AND 组合）

`--status open|aligning|aligned|processing|done` / `--file <name>`（短名/全名等价）/ `--branch <子串>` / `--tag <词>` / `--text <关键词>` / `--claimed-since <YYYY-MM-DD>`（真实日期校验）/ `--sort priority`（唯一排序值，其它值与空串报 `BAD_FILTER`）/ `--json`。`--json` 输出 `{file,id,globalId,status,text,branch,tags,priority,dependsOn,blockedBy,createdAt,claimedAt,completedAt,alignedAt}` 行对象数组（缺省 file→id 稳定排序；`--sort priority` 时 priority desc → file asc → id asc；`blockedBy` 是派生字段：未完成的直接依赖引用，非空即阻塞，不另设布尔位）。人读行：`<mark> <file>#<id>  [p<priority>] <text>`（`[ ]` open / `[?]` aligning / `[>]` aligned / `[~]` processing / `[x]` done；`[pN]` 不零填充、由 todo-cli-todo:15 引入），阻塞条目再追加 ` （阻塞：等待 a#1, b#2）`。非法 `--status` 值给空结果（沿旧语义，不报错）。`summary` 列 = `open • aligning • aligned • processing • done • total`（`--json` 行同名，不含阻塞与优先级信息）。

## migrate 子命令

- `from-md [--dry-run] [--force]`：md → JSON 一次性权威切换（json 已存在即拒绝，`--force` 覆盖）；逐文件「渲染→再解析→再构建」等价自检，任一不过关整体零写入；全过后逐条取全局 id 写 v4 JSON、删 md、清遗留 `index.db*`，输出五态/注记计数。`to-md`：JSON → 规范 md（五态标注还原为 `（aligning|aligned|processing @ 分支）` + notes 作缩进子行），**保留 JSON**，配合 git 历史旧版 CLI 回滚；md 无 globalId 语法（不进 md，豁免写门禁）。
- `global-id [--dry-run]`（#16）：存量未迁移条目一次性取号。预检**重复** globalId → 逐条报 `globalId 重复：…` 中止零写盘（先手工按 globalId 判同仲裁）；无缺口 → `没有需要迁移的条目` exit 0（零动作幂等）；`--dry-run` 只报将迁移文件数/条目数与起始号（零写盘零取号）；正式迁移按文件名 sort + 文件内数组序逐条取号，**逐文件锁内新鲜重读** → 迁移前后逐字段等价自检（`verifyGlobalIdMigration`）不过则该文件零写、整体中止（已写文件保留——重跑接续；号已烧不回收）→ 收尾全台账复检，输出 `已迁移全局 id：<文件数> 个文件 · <条目数> 条条目取号 <起>..<止>（等价自检通过）`。

## 已知坑

- **依赖是直接约束，不传递**：A 依赖 B、B 依赖 C 时，A 只等 B 的 `status`（B 从 aligned 进 processing 后 A 仍在等）；B 一旦 done（含取消/搁置收口），A 立即解锁——不检验 B 的前提当时是否真成立，那一步靠 `complete` 的依赖者提示 + 人工重判。
- **悬空引用会阻塞（不是放行）**：合并后引用的 id 不存在时按阻塞处理（提示标「不存在」），要么补条目、要么 `dep remove` 清掉；`lint` 会报。
- **Windows rename 争用（EPERM）**：并发写时 `atomicWriteFile` 的 temp→rename 偶发 `EPERM: operation not permitted, rename`（真子进程并发用例在负载下可见，跟踪项 `todo-cli-todo.json` #13）；写路径（尤其 `add` 的锁临界区）变慢会明显放大该概率——依赖校验因此带无依赖快路径。复跑即可：原子写不会留半态，与数据正确性无关。
  - **失败现场（#13 第一步，2026-09-17）**：concurrency/interrupt 用例经 `test/failure-scene.ts` 包装，失败即落 `${TMPDIR}/todo-cli-failure-scenes/<UTC紧凑戳>-<净化用例名>[-N].md`——完整 stack、子进程时间线（含逐 close 剩余锁快照）、各子进程 stdout/stderr 全文；失败消息尾行 `[失败现场] <路径>`。通过路径零写盘（无激活场景时 `activeSceneSink()` 返回 null 全短路）；目录不自动清理，证据留到人工判读。
  - **负载实验结论**：8 写者真实子进程持续 add(+list)（临时仓 `--root`，绝不指向主仓 `todos/`）+ 10 轮 `npm run test:todo` → 10×101 全绿、零现场文件（test:todo 的短促并发形状未复现）；但同负载写者侧复现 EPERM：约 2–3 千条台账 8 写者并发写失败率 2%–23%（持续写压 + 大台账），纯写负载（无并发读）亦复现，≤800 条台账 60s/787 写零失败。判读要点：现场「子进程输出」节的 `errno -4048 / syscall rename / 目标路径` = rename 争用而非锁失效（「备注」节剩余锁快照显示锁被正常持有/等待）；失败 fail-closed（原子写不留半态、条目未落盘、复跑即可），与数据正确性无关。维持观察：test:todo 再遇并发失败先读失败消息尾行的现场路径。
- **`--match` 是子串不是全文**：多条包含该子串报歧义；改写条目文本后旧 match 失效；notes 内容匹配不到（设计如此，防误伤）。
- **对齐文档只校验结构**：小节标题 + 任意非空正文即通过（模板里的提示行也算正文）；`claim` 不代建文件，未写文档就跑 `align` 必报 `ALIGN_DOC_MISSING`。
- **v4 升版一次性生效**：迁移后任一写操作重写整文件 ⇒ 该文件整体变 v4（`version: 4` + 每条 `globalId` 正整数，diff 一次性）；未迁移的 v1-v3 文件（`globalId: null`）仍可读、写被 `GLOBAL_ID_PENDING` 挡下；旧版 CLI 读到 v4 直接报错，回滚走 git 历史。
- **锁残留与 stale 抢占**：进程挂起超 60s 后其锁可被抢占（恢复后写失败，重跑即可）；Windows SIGKILL 不跑 exit 钩子、锁文件残留，pid 已死即被下一次写抢占，无需人工清理。
- **时间戳 null 的含义**：迁移前历史条目三时间戳为 null（`--claimed-since` 对 null 不命中）；历史 `processing` 视为「已开工」，不要求补对齐文档。误标为在途或推翻对齐结论时用 `reopen` 退回 open（ADR-0007）——不要手工编辑 JSON，也不要用 migrate 重建台账（会重排 id）。
- **reopen 归档先于写盘**：归档冲突/失败（`ALIGN_ARCHIVE_FAILED`）整体中止、JSON 零改动；反向窗口（归档成功而写盘失败）会留下归档文件而条目未变，重跑即可，但归档已存在时得先人工处理（它不会自动覆盖）。撤销后必须重写对齐文档才能再过 `align`——旧文档已在规范路径之外。
- **撤销 ≠ 取消**：取消/搁置走 `complete --note`（→ done、不可再领取）；`reopen` 回 open 池、可再领取。批量撤销不在命令面上（无 `--all`），虚空 processing 只能逐条清。
- **合并冲突**：两个 worktree 各自 add/claim 后合并，JSON 冲突需手工按 globalId 判同条目取并集（`文件#id` 展示不变；文本 diff 可读）；解决前所有命令 fail-closed 报「合并冲突」。
- **cwd 决定仓库（行为变更，#9）**：在 `.worktrees/<名>` 内调用作用于该 worktree 的 `todos/`（旧版恒指向工具所在的主仓）；在另一个仓库里用绝对路径调用则作用于**那个**仓库。要跨目录指定目标仓库就显式 `--root`。
- **非 git 目录不是错误场景**：无 `--root` 且 cwd 不在仓库内 → 静态报错退出 1（仅 `--help`/裸调用/未知命令例外）；`--root` 指到 git 不可用的目录时，只读命令可跑，`triage` 报「不是 git 仓库」而不抛栈。
- **「非 git 目录」很稀缺**：本机 `~`（`C:\Users\<用户>`）本身就是 git 仓库，`os.tmpdir()` 下建的目录往往仍在某个仓库内——所以「cwd 不在仓库」的进程级 E2E 不可移植（改用注入 execGit 的单测锁定），要确定作用于哪个仓库就显式 `--root`。
- **present-but-invalid 收紧（#15）**：旧 v3 文件若恰带非法 `priority`（`"高"`/`3.5`/`0`/`11`/`null`），#15 上线后从「能读」（未知字段忽略）变「不能读」（`BAD_SCHEMA`）——方向是收紧、修复路径明确（改合法值或删字段）；现网台账无此数据（全量条目无 priority 字段）。
- **to-md → from-md 抹平非 5**：md 无优先级语法，`migrate to-md` 不渲染 priority，再 `from-md` 回来一律 5——逃生回滚会丢优先级（可接受的降级，与丢 globalId 同款论证）。
- **旧版 CLI 重写丢 priority（混布窗口）**：旧版 CLI 读新文件正常（v3 + 未知字段忽略），但它重写文件时 `entries.push` 白名单不含 priority → 该文件全部条目优先级被抹成「无字段」（再被新版读成 5）。窗口内丢的只是展示/排序字段，无结构损坏；混布期间优先用新版 CLI 写。

## 改动清单

- 必跑：`npm run test:todo`（glob = `.agents/skills/todo-cli/todo-cli/test/*.test.ts`；134 个，2026-09-17 集成后实测全绿（#13/#15/#16 三单合并），含 6 个全局 id 计数器用例、7 个依赖图纯函数用例、reopen 回退/归档用例、9 个失败现场 helper 契约用例、priority（schema/query/命令闭环/migrate）用例与迁移、并发/中断真子进程用例）+ `node .agents/skills/todo-cli/todo-cli/todo.mjs lint`（exit 0）；仓库无根级 typecheck 门，新文件全用可擦除 TS 语法。
- 改行为：同步 `test/todo-cli.test.ts`（命令面）/ `test/root-discovery.test.ts`（根发现）+ 本卡；改命令面：同步 `core.ts` 的 `USAGE` + `SKILL.md` + 本卡。
- 改 schema：`schema.ts` 版本位 + `parseTodoJson` 校验 + 本卡 + `docs/adr/0002`/`0003`/`0005`/`0008` 同步。
- 新增子命令/flags：先补测试（in-process + 必要的进程边界用例）再实现，并确认退出码与 stdout 约定不变（`REPO_COMMANDS` 同步，否则新命令会被当未知命令）。
