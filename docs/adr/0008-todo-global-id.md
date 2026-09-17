# todo 统一全局 id：`globalId` 机器主键 + `文件#id` 人类双轨

Status: accepted（2026-09-16，todo-cli-todo:16；用户批准方案全文，含迁移触发/旧版兼容两处定夺与 AGENTS.md 红线 1 合并仲裁措辞同步）

`todos/*.json` 的条目 id 是**文件内** max+1（`schema.ts` 的 `nextId`）：跨文件重号（`todo-cli-todo#15` 与 `general-todo#15` 是两个条目），查重提示、`dependsOn` 引用、对齐文档命名、合并冲突「按 id 取并集」全靠 `文件#id` 复合键人肉消歧。决定：条目新增 `globalId`——**全台账唯一、永不回收**的统一机器主键；文件内 id 继续承担人类契约（**双轨**：展示 / 引用 / 文档命名 / `--match` 全部字节不变）。存储 schema v3 → v4（v4 条目 `globalId` 必填正整数；读 v1/v2/v3 归一 null，写出一律 v4）；取号计数器 `todos/.todo-cli/next-id` 在 `locks/id.lock` 内读改写（锁名 `id` 复用既有锁原语，零新锁代码）；六个写命令（`add`/`claim`/`align`/`complete`/`reopen`/`dep`）在未迁移台账上 fail-closed（`GLOBAL_ID_PENDING`），存量 18 文件 / 195 条（2026-09-16 实测）用独立子命令 `migrate global-id [--dry-run]` 一次性迁移；`list --json` 是 `globalId` 的唯一输出面，`lint` 增缺失/重复两类问题行兜住合并漏仲裁。

## Considered Options

**难逆点与惊异点**

- **难逆**：v4 落盘 + 195 条存量迁移一起上车。旧版 CLI 读 v4 明确报错（`version 必须是 1、2 或 3`），彻底回退 = git revert（含 `todos/*.json`）+ 旧 CLI（与 v2→v3 同款 fail-closed 回滚故事）；迁移中止/写盘失败烧掉的号留缺口（永不回收，作废无害）。
- **惊异**：① 六个写命令在新旧混布期会被门禁挡下——「先迁移再写」是机器可测的硬门而非靠人记得；混布窗口的读命令（`list`/`summary`/`triage`/`lint`）不受影响；② 计数器被 `.gitignore` 盖住（`todos/.todo-cli/`），fresh clone 必然缺文件，自愈初始化必须取 `max(全台账条目 id, globalId) + 1`——只按文件内 id 初始化会从 71 重发号、与存量 globalId 71..265 撞车。

**真权衡**

- **自增整数 + 计数器 vs 时间戳型（ULID/UUID）**：时间戳型天生无锁、无计数器丢失面，但不可读、不可排序、不可控；自增整数保持可读可 diff、存储面最小，代价是计数器丢失要自愈、并发取号要全局锁——选前者（YAGNI，失败模式有明确自愈路径）。
- **独立子命令 vs 写前自动迁移**：自动迁移要求 `add` 在持单文件锁的临界区内再逐个夺取**全部** 18 个文件锁（与并发写者构成锁序竞争窗口），且一次普通 `claim` 意外重写 18 个文件是惊异成本（#14 教训正是批量重写的风险面）。独立子命令逐文件取锁、不持他锁（锁序只有 文件锁 → id 锁 一层），有独立输出与中止边界，fail-closed 门把「必须先迁移」变成机器可测——选定。
- **读归一 null + 只压写路径 vs 解析层拒绝**：解析层拒绝（读 v3 即报错）会让 `list`/`summary`/`triage`/`lint` 在迁移期间不可读，可观测性倒退且违背「读命令永不写」边界；改为读时归一 null（本库既定兼容模式的第四档：v1 `alignedAt` → null、v1/v2 `dependsOn` → [] 同款），门禁只压写路径，v4 条目缺 `globalId` 仍结构 fail-closed——杜绝「v4+null 永久漂着」的第三态（门禁 + v4 校验双保险）。

## Consequences

- schema v4：读 1|2|3|4 归一 v4，写出一律 v4；v4 条目缺 `globalId`/非正整数即 `BAD_SCHEMA`；v1-v3 缺字段归一 null（瞬态）、带合法值保留（合并产物/手写混入保全）。`nextId`（文件内 id）不动。
- 命令面：`migrate` 增 `global-id [--dry-run]`（无新顶层子命令）；六个写命令新增 `GLOBAL_ID_PENDING` 门；`lint` 增 `globalId 缺失：<名>#<id>（未迁移）` / `globalId 重复：<号>（<名甲>#<id甲> 与 <名乙>#<id乙>）`；`list --json` 增 `globalId`，人读行与 `summary` 字节不变。
- 计数器 `todos/.todo-cli/next-id`：不入库（gitignore）→ fresh clone 自愈；只经 `locks/id.lock` + `atomicWriteFile` 写；只前进、永不回收（complete/reopen 不归还，失败/中止留缺口）。
- 锁序不变量：文件锁 → id 锁（全库唯二嵌套点：`runAdd` 与两个迁移命令），无反向路径、无死锁窗口。
- 合并冲突仲裁身份归 `globalId`：手工按并集解决后由 `lint` 兜「同号两次出现」；`migrate global-id` 预检重复号直接中止零写盘。`文件#id` 展示 / `dependsOn` / 对齐文档命名不变。
- `migrate from-md` 一步到位产 v4 完备台账（逐条取号）；`migrate to-md` 豁免门禁、照常忽略 `globalId`（md 无此语法）。
- 主仓库根 `todos/` 的实际迁移由主会话在验收后与 merge 同一 push 收口（避免主干长期 v3/v4 混布）。
