# todo-cli-todo#18 globalId 计数器跨检出撞号

## 意图

`globalId` 是全台账唯一的机器主键（lint 查重、跨分支合并仲裁的身份）。现在它会撞号，原因链：

- 计数器 `todos/.todo-cli/next-id` 被 gitignore，且路径挂在**检出目录**下 → 每个 git worktree 各有一份（fresh clone 同理）。
- 新 worktree 没有计数器文件 → 首次取号走自愈 `max(全台账条目 id, globalId) + 1` = **343**；而主仓库的计数器当时也停在 343（它不知道 worktree 已经发过号）→ 同一号发给第二个条目。

**实测复现（2026-10-04，可当测试用例）**：主仓库 `next-id` = N → 新建 worktree → 在 worktree 内 `add`（拿到 N）→ 回主仓库 `add`（又拿到 N）→ `lint` 报 `globalId 重复：343（virtual-model-router-todo#1 与 #2）`。当日那次是**手工改 JSON** 修掉的（`f5a6f2a`：给 #2 重发 348 + 删计数器走自愈）——破了「CLI 是唯一读写入口」的红线，属于被迫的例外。

为什么必须修：撞号会让「同号两次出现」从异常变成常态，lint 的可信度归零，而 CLI 又没有修复通道，人只能一次次手改 JSON。

## 范围

**做什么**

1. **计数器共享**：把计数器**与它自己的锁**一起挪到 git 公共目录（`git rev-parse --git-common-dir`），使主仓库与所有 worktree 共享同一份号源、同一把互斥锁。注意：锁必须跟着计数器走——现在 `locks/id.lock` 也在 `todos/.todo-cli/` 下、同样按检出各一份，只挪计数器会让并发取号失去互斥（锁序不变量「文件锁 → id 锁」保持不变）。
2. **发号前对齐台账**：`allocateGlobalId` 取号时用 `max(计数器值, 全台账(条目 id, globalId) 的最大值 + 1)`。这一半负责 worktree/克隆之外的另一半风险——与另一克隆或另一分支**合并进来**的号（共享目录也治不了跨 clone）。
3. **受支持的修复通道**：新增 `migrate global-id --repair`（与既有 `migrate global-id` 同族），把**已经发生**的撞号修掉，不再需要手改 JSON。形态：预检重复号 → 按确定规则仲裁（保留号最小的一条、其余重发新号；规则写进 SKILL/工具卡）→ 复用 `verifyGlobalIdMigration` 做逐字段等价自检 → 收尾全台账复检 → 输出「旧号 → 新号」清单；`--dry-run` 只列计划零写盘；无撞号时幂等零动作。
4. **随动面**：`docs/tools/todo-cli.md` 工具卡、`.agents/skills/todo-cli/SKILL.md` 命令参考卡、`docs/adr/0008-todo-global-id.md`（补「共享计数器 + 修复命令」两处决策）、根 README 的测试数（唯一来源）、`todos/.todo-cli/` 的 gitignore 说明（若路径变化需同步注释与文档）。

**不做什么**

- **不做跨 clone 的强一致**（用户明确未选）：跨 clone 仍靠「发号前对齐台账」+ lint 兜，不引入远端/版本库内的计数器。
- 不改双轨契约：`文件#id` 的展示、`dependsOn`、对齐文档命名、`--match` 全部字节不变。
- 不改 `globalId` 语义：全台账唯一、永不回收、complete/reopen 不归还、失败烧号留缺口。
- 不碰 `todos/.todo-cli/` 之外的文件锁布局（每文件锁仍按检出各自持有，这是对的——每个检出有自己的台账文件副本）。

## 验收标准

1. **复现用例先红后绿**：测试真的开一个 git worktree、在两个 cwd 交替 spawn CLI 取号（不是纸面替身），断言两号不同；实现前该用例必红。
2. **共享性**：主仓库与 worktree 取到的号互不重复；计数器与 `id.lock` 在同一目录（断言两者路径同源）。
3. **兼容旧布局**：升级前已存在的 `todos/.todo-cli/next-id` 被折叠进新位置（取 max 语义）而不是被忽略或报错；旧文件缺失仍走自愈。
4. **`migrate global-id --repair`**：构造撞号台账 → repair 后 `lint` exit 0、逐字段等价自检通过（只有 `globalId` 变）；`--dry-run` 零写盘；无撞号时输出「无需修复」零动作；仲裁规则与输出格式在 SKILL + 工具卡写明。
5. **并发与中断不回归**：既有 `concurrency.test.ts` / `interrupt.test.ts`（SIGKILL + stale 自愈 + 号不重号）全绿。
6. **全量门**：`npm run test:todo` 绿（测试数同步到根 README）、`todo.mjs lint` exit 0、`npm run test:all` 19/19 套件绿。
7. **文档同步**：工具卡 / SKILL 命令参考卡 / ADR-0008 补记 / 根 README 测试数四处齐全。

## 人工确认

用户 2026-10-04 本会话确认（两问两答）：

- **修法范围 → 共享计数器 + 发号前对齐台账**。用户明确否掉了另两档：「只修 worktree」（治不了跨 clone 与合并产物）与「跨 clone 强一致」（要动版本库内计数器，改动与冲突面最大）。
- **撞号发生后的通道 → 加受支持的修复命令**。用户明确否掉「维持现状：只报、人工手改」——即接受为 `migrate global-id` 家族新增 `--repair` 的改动面。
- 当日事实基线：那次真实撞号已按 ADR-0008 的手工仲裁口径修掉（`f5a6f2a`），现场与复现步骤见「意图」，可直接作测试素材。
- 同会话另一决定（与本条无关，仅记录）：用户指示取消 `solo-mode-todo#8`，其口径并入 `jev-safe-gate-todo#1`。
