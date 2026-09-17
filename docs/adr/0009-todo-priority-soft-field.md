# 优先级不占 schema 版本位：priority 全版本可选软字段，v3→v4 独家归 globalId

Status: accepted（2026-09-17，todo-cli-todo:15；用户批复「针对 15，批准」——现在实施不等 #16、标记候选 A、add 不回显 + 前导零容忍三项照准）

条目需要轻重缓急（`list` / `summary` 全靠人工读全文排期，登记时无法表达「这条比那条急」）。落法上有一个跨单协调问题：姊妹单 #16（统一 globalId）的方案已定稿——把 **schema v4 定义为「globalId 必填正整数」**——但停在审批门未落地。#15 若也去声明版本位，两单会正面撞车。

决定：**priority 不占版本位，做成全版本可选软字段**。`entries[].priority` 为整数 1-10（10 最高），对 schema 1 / 2 / 3（及未来 4）语义一致地可选：JSON 缺失读时兜底 5；出现但非 1-10 整数是结构损坏（`BAD_SCHEMA`，fail-closed 不静默兜底）。**v3→v4 独家归 #16 的 globalId**，priority 在 v4 里继续保持可选——两单语义正交：globalId = 身份（必填），priority = 排期（可选）。命令面：`add --priority 1-10`（缺省 5，非法值 `BAD_PRIORITY` 不写盘，前导零按数值），`list` 行内 `[pN]` 标记与 `--sort priority`（priority desc → file asc → id asc），`list --json` 带字段。写入落在既有文件锁临界区内（无新并发面）；任一写操作重写文件时既有条目顺带补 `priority: 5`（parse 归一 → serialize 自然落盘），读命令永不写。

## Considered Options

- **#15 自 bump v4、priority 为 v4 必填**：与 #16 定稿方案正面撞车——同一版本号两种语义（globalId 必填 vs priority 必填），读兼容矩阵直接矛盾；且「必填」违背「缺失兜底 5、不强制重写」的对齐口径——存量 195 条全无 priority，升 v4 即全量 `BAD_SCHEMA`，必须配批量迁移（#14 教训的复刻）。**否决**。
- **阻塞等 #16 落地后再实施**：语义最保守，但 #16 无时间表（审批超时中），#15 空转；且软字段方案对三种时序皆安全，技术上无硬依赖。**用户拍板不等**（2026-09-17）。
- **priority 保持可选但 #15 也声明 v4**：版本号被两单分头声明即语义分裂，且逼 #16 改 v5、其定稿设计与测试清单作废重写。**否决**。
- **软字段（选定）**：版本号不冲突；对 #16 已定稿设计零侵入；任意时序（先后/并行）成立；回滚 = git revert（无版本位变化、无迁移）。代价是 v3 文件开始携带 v3 规范之外的字段——但「未知字段忽略」的向前兼容口径本来就让旧 CLI 读得进，旧版 CLI **重写**丢 priority 的混布窗口记入卡片已知坑。

## Consequences

- **present-but-invalid 收紧**：旧 v3 文件若恰带非法 priority（`"高"` / `3.5` / `0` / `11` / `null`），从「能读」（未知字段忽略）变「不能读」（`BAD_SCHEMA`）——方向是收紧、修复路径明确（改合法值或删字段）；上线时现网台账无此数据。
- **接口约定（写给 #16 实施者）**：`verifyGlobalIdMigration` 的「既有字段 deepEqual 零变化」清单必须从 `id/text/status/branch/tags/dependsOn/notes/四时间戳` 扩为**再加 priority**；`migrate global-id` 的读写本身无需专门处理（经 `parseTodoJson` 读、`writeTodoData` 写，数据面保全是机械的，风险只在自检清单漏字段）。
- **消费面收窄**：priority 只进 `list`（标记 / 排序 / `--json`）；**不进**状态机、依赖门（`DEP_BLOCKED` 条件）、查重、`summary`/`triage` 输出、`--match`。无 `priority set`（改值走 `reopen` → 重登记）。
- **`--sort` 接缝**：`serializeEntries` 的 sort 分支单点 + `sortByPriority` 独立函数；未来加排序值 = 扩 `"priority"` 字面量联合 + comparator，不改调用方。
- **迁移降级可接受**：md 无优先级语法 ⇒ `from-md` 条目一律 5、`to-md` 不渲染（往返抹平非 5），记入卡片已知坑。
- 命令面契约变化（`add --priority` / `list --sort priority` / 行格式加 `[pN]`）：`USAGE`、`SKILL.md`、`docs/tools/todo-cli.md`、根 README 同变更同步；错误码 `BAD_PRIORITY` 随 core 层 result union 走。
