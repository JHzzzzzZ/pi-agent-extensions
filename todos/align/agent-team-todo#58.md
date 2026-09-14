# agent-team-todo#58 team_ask 长提问完整呈现（不再压平 + 300 字符截断）

## 意图

leader 用 `team_ask` 提问时，人的决策输入必须完整可读；当前 `buildAskTitle`（`ask.ts`）把 `question` 压平成单行并硬截 300 字符，长方案/多段内容在提问当下读不全，人只能盲答或取消。

根因分两层，本条目两层都修：

1. **我方**：`buildAskTitle` 的 `\s+` 压平 + 300 字符硬截，且同一截断串同时喂给对话框 `title`、wire `extension_ui_request.title`（长文唯一通道）与转录条目 `questionEntryText`（`/team:view`、`team_transcript` 复查的也是残文）。
2. **宿主渲染面**（不能打补丁，只能绕）：题面走 pi-tui `Text` 会自动折行，但宿主对话框挂在 `editorContainer`（`VStack(basis:auto, shrink:1)`），超出屏幕高度的行被 `slice` **静默裁掉、无滚动**；`select` 的选项列表不窗口化，题面一长选项被顶出屏幕（可选项看不见，只能盲选）。

因此「完整呈现」的判据是：**提问当下就能滚动读全文**，而不是只靠转录兜底。

## 范围

**做什么**

- 短题保持现有宿主对话框路径（`ctx.ui.select` / `ctx.ui.input`）：压平后 ≤ 200 字符、无多段（`\s+` 压平不丢结构，即原题不含空行分段）、选项 ≤ 5 且每项 ≤ 60 字符。
- 长题（超出上述任一条件）改走主会话侧自绘 **overlay** 全文视图（`ctx.ui.custom` + 复用 viewer 的 pi-tui 渲染栈与 `ScrollView`），题面完整、可滚动，选项窗口化（↑↓ 移动、可见窗口滚动、隐藏侧给「还有 N 项」提示）。
- 超时语义：自绘层显示剩余秒数、Esc 取消、到时自动关闭；兜底仍由 `AskChannel` 的 backstop 保证有界，全部落回 `{cancelled:true}`（fail-closed 语义不变）。
- 上限与省略标注：题面完全取消 300 字符截断；改设新常量上限 **4KB（UTF-8）**，与 `MAX_ASK_ANSWER_BYTES` 同族；超限时界面与转录都**显式标注**「已省略 N 字节」，绝不静默截断。
- 转录与 viewer：`question` 条目存**全文**（超限则全文上限 + 省略标注），viewer/`team_transcript` 可复查完整题面。
- 降级回退：`ctx.hasUI` 为假、RPC 主会话、`custom` 返回 undefined 时回退宿主对话框，并**先把全文落转录**，题面用「摘要 + 全文见上方」的短标题（不回退成选项被顶出屏幕的盲选）。

**不做什么**

- 不改长**回答**输入（仍 `input` 单行 + `MAX_ASK_ANSWER_BYTES` 4096）——另立条目。
- 不改 leader 侧超时 clamp（30s~30min）、`AskChannel` FIFO/backstop/dispose 契约、wire 协议字段（长文仍走 `title`）。
- 不 patch 宿主（编辑区高度裁剪、`ExtensionSelectorComponent` 不窗口化属宿主行为，只绕不改）。
- 不引第三方依赖、不加构建步骤、不动 `question`/`answer`/`system` 之外的 transcript 条目形状。

## 验收标准

1. 单测（纯函数）：阈值分流（`≤200` 字符短题走宿主路径、任一条超限走自绘）；4KB 上限与「已省略 N 字节」标注；全文进 `questionEntryText`；`>300` 字符与含换行多段方案均**不再被压平/截断**。
2. 宿主级真实渲染测试（沿 `test/viewer-ask-host.test.ts`：真实 `TuiMainScreen` + 假终端）：长题面（多段、超屏高度）渲染后题面**尾部**与**全部选项**均可上屏/滚动可见；选项窗口化提示正确；Esc 取消、超时自动关两条路径各回 `cancelled`。
3. 降级路径有测试：无 `hasUI` / `custom` 不可用时回退宿主对话框，且全文已进转录。
4. 既有语义零回归：短题路径、超时 clamp、fail-closed、viewer ↔ 对话框互斥（收起/重开）行为不变。
5. `cd src/extensions/agent-team && npm test` 全绿 + `npm run typecheck` 零错误；`docs/extensions/agent-team.md` 卡与扩展 README 同步（含 `last verified` 行），根 README 测试数更新。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-14
- 方式：两轮对齐访谈逐条确认——第 1 轮 4 问（呈现目标 / 长度上限 / 选项与回答范围 / 转录全文）用户答「没问题」；第 2 轮 5 问（自绘形态 overlay / 短题保留宿主路径 / 超时呈现 / 降级回退 / 测试形态）用户答「按照建议走」。范围外项（长回答输入）已在 `agent-team-todo` 另行登记。

### 实现期偏差记录（用户已知口径，收尾报告同步）

1. **上限 8KB → 4KB**：实现时发现 `FileTranscriptSink` 对每条转录条目的上限是 `MAX_TRANSCRIPT_ENTRY_BYTES = 4KB` 且是**静默截断**。若题面允许 8KB，转录里就只能存一半且无标记——与「转录可复查全文」直接矛盾。故题面预算取 4KB（与转录条目同预算），两条路径同一份文本；`questionEntryText` 另对整条条目（前缀 + 选项）再用同一显式收口，抠掉最后一处静默截断。
2. **超时呈现：剩余秒数 → 静态文案**：自绘 overlay 内**不放每秒跳动文本**——仓库已有真机事故结论（viewer `titleRow` 注释：每秒变化的 overlay 行就是纵向堆叠物本身，53s/54s 标题并存）。超时改以静态文案 `超时：<N> 分钟后自动取消` 呈现；到时自动关闭仍由 `AskChannel` 的 timeout + abort signal 驱动（语义不变，仅显示方式变）。
