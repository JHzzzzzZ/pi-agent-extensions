# 对齐：loop-todo#12 — 前台到期任务送达从 followUp 改 steer

- 条目：`loop-todo#12`（tags: `delivery`, `steer`, `host-semantics`，priority 5）· 分支引用：`feat/loop-steer-delivery`
- 档位：**T2**（行为代码只动 `src/extensions/loop/` 一个单元 + 其配套测试；`docs/cross/` 零改动，customType `loop-task-due`、工具名 `loop_create/list/delete`、命令面 `/loop:*`、状态键 `loop` 全部不变——只改一个 `deliverAs` 取值）
- 日期：2026-10-15（UTC）· 参与：用户（发起并拍板三轮）+ agent（宿主投递语义读码核实、先例检索）
- 状态：**已人工确认**（用户 2026-10-15 回复「都同意」）

## 意图

`loop` 前台任务到期用 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 注入会话。宿主 agent loop 只在**外层循环「agent 本来要停」的检查点**消费 followUp 队列；agent 连着干活（一直出 tool call）时，到期任务会一直压在队列里、转录里毫无痕迹，直到它收工才弹出——定时任务的实际送达时刻由「agent 什么时候闲」决定，而不是「任务什么时候到期」。用户要的是：到期即在**当前工具批结束的回合边界**进上下文。

宿主 `AgentSession.sendCustomMessage` 的两分支（读码核实，非猜测）：

- **流式中**（`isStreaming && triggerTurn !== false`）：`deliverAs: "followUp"` ⇒ `agent.followUp()`（外层消费点）；其余值（含 `steer`）⇒ `agent.steer()`（内层消费点，`pi-agent-core/dist/types.d.ts:239` 注释：steer 在「当前 assistant 消息的工具调用执行完」后注入，**工具调用不被跳过**）。
- **空闲**：两值**等价**——`triggerTurn: true` 直接起一轮（与 `deliverAs` 无关）。

即：改的是「忙时」的送达时机，空时行为一字不变。先例是 `timeout-bg-todo#6`（后台命令完成通知同款改动 + 同款理由），其卡 `docs/extensions/timeout-bg.md` 明写「别改回 followUp」。

loop 里**唯一的会话注入点**是 `src/extensions/loop/index.ts:243`（后台完成、并发提示等一律走 `ctx.ui.notify` 瞬态 toast，不进 LLM 上下文）⇒ 改动面就这一处。

## 范围

**做什么**

1. **`src/extensions/loop/index.ts`**：`deliver()` 里唯一一处 `deliverAs: "followUp"` 改 `"steer"`；顶部文件头注释同步（现写「经 pi.sendMessage(deliverAs: followUp) 在回合间送达」已不成立）。
2. **消息文本加一句边界提示（Q2 决议）**：内容从 `[loop ${t.id}] 定时任务触发，请执行：` 改为带「独立任务，先收尾手上工作再处理本条」意味的提示句——steer 会把消息插进当前工作流，agent 有概率把它读成当前任务的追加要求，用一句文案把边界说清。customType / details 不变。
3. **测试**：
   - 既有字面量断言同步（`test/index.test.ts:390` 现 `assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" })`）。
   - **新增真实宿主投递语义测试**（照 `timeout-bg/test/delivery-semantics.test.ts` 的接法）：驱动宿主真实 `Agent`（真队列 + 真 loop）+ 宿主 `convertToLlm`（真转换）+ pi-ai faux provider（只假模型流），断言两层——① 事件时序：通知发生在第 1 轮工具批之后、第 2 轮助手响应之前；② 请求载荷：第 2 次 LLM 请求就已带上任务文本，对比 followUp 时「要等收工」。**动机**：本改动的全部价值就是宿主消费时机，只断言 `deliverAs` 字面量是纸面正确——宿主哪天挪走消费点，字面量断言照样绿。
4. **文档同步**：`docs/extensions/loop.md`（数据流第 3 条 + 头部一句话 + `last verified`）、`README.md` 第 407 行段落、`src/extensions/loop/README.md`、`src/extensions/loop/AGENTS.md` 里「前台 followUp 送达」的表述，`package.json` bump（特性改动 ⇒ minor 还是 patch 按仓库既有口径），`docs/cross/messages-entries.md` 若含 `loop-task-due` 行则补交付语义。

**明确不做什么**

- **不改后台路径**：`--bg` 子进程、后台轮次重叠、单轮 3 小时上限、后台完成 toast（`ctx.ui.notify`，瞬态、本就无送达语义）一律不动。
- **不加 per-task 开关、不做分类**：全部前台任务（间隔 / daily / window / 一次性提醒）统一 steer。到达时刻 agent 闲不闲是运气，与任务类型无关；真要不打扰就走 `--bg`。
- **不动其它插件的 followUp 通道**（`goal` 续回合、`deep-init`、`agent-team` 报告、`pwr` 结果、timeout-bg 已是 steer）。
- **不抽共享投递 helper**：与 timeout-bg 各持一份测试与一行调用（rule of three 未到，抽象只会把两个插件的宿主耦合绑在一起）。
- **不改宿主**（红线 8）：宿主消费点行为若不符合预期，写进文档作为已知边界，不补丁宿主。
- **不改 `nextTurn` 语义**（宿主第三个投递值，本需求不需要）。

## 验收标准

1. **忙时送达时机**：agent 正在流式执行、第 1 轮工具批结束后，到期任务文本在**下一次 LLM 请求**就已进上下文（真实宿主测试断言请求载荷，非字面量）。
2. **空时等价**：agent 空闲时到期 ⇒ 起一轮、行为与改动前一致（`triggerTurn: true` 分支）。
3. **后台零变化**：`--bg` 任务的触发、并发、超时、完成 toast 全部与改动前逐字节一致（既有测试全绿即证）。
4. **文案含边界提示**：到期消息文本含「独立任务 / 先收尾手上工作」语义的提示句；customType 仍为 `loop-task-due`、`details.loopId` 与 `details.recurring` 不变（会话恢复与既有条目兼容）。
5. **`loop` 套件全绿 + typecheck 零错误**；`npm run test:all` 全量绿（留 merge 前）。
6. **交付前手动真机验一次**（Q3 决议：不写 opt-in 脚本）：改后在 pi 里建一个 `1m` 任务、同时让 agent 跑长任务，观察任务是否在工具批边界插进来而非等收工。
7. **跨厂商独立评审（红线 11，T2 口径）**：单轮评审，reviewer 显式回答「有无首轮未覆盖的行为面疑虑」；P1/P2 逐条处理，P3 转 `todos/` 新条目。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-15（UTC）· **方式**：对话内三轮问答，回答「都同意」
- **Q1 改动范围** —— 推荐「全部前台任务统一，不加开关」⇒ **用户同意**。
- **Q2 插话语义补偿** —— 推荐「消息文本加一句边界提示」⇒ **用户同意**。
- **Q3 验收口径** —— 推荐「真实宿主投递语义测试必做（agent 直接定，属仓库『纸面正确不算数』硬口径）+ 不写真机 opt-in 脚本、交付前手动验一次」⇒ **用户同意**。
- **档位 T2 与范围外清单**（后台路径 / 后台 toast / 其它插件 followUp 通道 / 不抽共享 helper / 不改宿主）agent 判定并已明示，用户未推翻 ⇒ 视为确认。
