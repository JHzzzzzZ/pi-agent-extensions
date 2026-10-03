# loop-todo#11 loop 工具面升级到 pi 1.0 契约

## 意图

codemode 打开后，loop 的 3 个工具**全部变成脚本可调**（`exposure` 默认 `direct`）：

- `loop_create` 会**建定时任务**，而任务的执行体是一条命令或一个后台子 pi 进程——脚本里建任务是典型的风险路径（脚本能自己给自己排期）。
- `loop_delete` 删任务。
- `loop_list` 是纯查询，本来就是脚本最该用的那个。

同时脚本调 `loop_list` **拿到的是文本**：任务的 id / 类型 / 下次触发时刻 / 后台轮次状态对脚本不可见，无法做「按预算重排定时任务」这类聚合。

## 范围

**做什么**

1. **exposure 分级**：
   - `loop_create` / `loop_delete` → `exposure: "model-only"`
   - `loop_list` → 保持 `direct`（脚本可调）
2. **`outputSchema` + `structuredContent`**（只给 `loop_list`，稳定契约，不镜像内部 `details`）：
   ```
   { tasks: [{ id, kind: "interval"|"daily"|"window"|"once", schedule, task,
               nextAt?, background: boolean, running?: [...], recentRuns?: [...] }] }
   ```
   字段取自现有 `LoopTask` 的内部结构与 widget 渲染口径；截断/上限沿用现有常量（不新造）。
3. **annotations**（`general-todo#21` 的 loop 部分）：`loop_list` = `readOnlyHint`；`loop_create` = `destructiveHint` + `openWorldHint`（任务会跑命令或起后台 agent）；`loop_delete` = `destructiveHint`。
4. **namespace**（`general-todo#20` 的 loop 部分）：3 个工具归入 `namespace: { name: "loop", description: "会话内定时任务" }`。

**不做什么**

- 不改调度语义（`parse.ts` 的 `nextDailyOccurrence` / `nextWindowOccurrence`）
- 不改任务状态机与上限常量（`tasks.ts`）
- 不改后台子 pi 契约（`runner.ts`）、不改 widget / 节拍器
- 不改命令面（`/loop:*` 不变）；`--bg` 模型透传语义不动

## 验收标准

1. `cd src/extensions/loop && npm test` 全绿（现有 213 个 + 本条新增），`npm run typecheck` 零错误。
2. `loop_create` / `loop_delete` 的 `exposure` 为 `model-only`，`loop_list` 保持 `direct`；测试断言 `pi.getAllTools()` 可读。
3. `loop_list` 的 `outputSchema` 存在且 `structuredContent` 匹配；**脚本路径实测**：codemode 里 `tools.loop_list({})` 返回结构化任务数组。
4. `annotations` 与 `namespace` 逐条可读。
5. 既有 `details` 消费方（widget 渲染、快照序列化 `loop-tasks-v1`）零回归——快照格式**不变**。
6. 仓库级：`npm run test:all` 本套件绿。
7. 文档同步：`docs/extensions/loop.md` 卡（如存在）+ 根 README 测试数。

## 人工确认

用户 2026-10-04 本会话确认：

- **Q1 `outputSchema` 契约形态** → 选项 **2**：只给查询型工具新设计**稳定契约**，`details` 保持内部结构。
- **Q2 exposure 清单** → 通过（`loop_create`/`loop_delete` → `model-only`，`loop_list` 保持 `direct`）。
- **Q5 并行与合并** → 并行开 worktree；`general-todo#21`（annotations）与 `general-todo#20`（namespace）**并入本条一起改**，这两条 general 条目在三个扩展 worktree 全部合并后统一收口。
