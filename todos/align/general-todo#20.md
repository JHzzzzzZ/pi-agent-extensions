# general-todo#20 namespace 分组 + instructions

## 意图

本仓库 16 个工具（pwr 4 + agent-team 9 + loop 3）在 codemode 里**共享同一份声明预算**：`codemode.inlineBudget` 默认 3000 estimated tokens（设置项，`characters / 4`）。

问题：**超预算的工具会被静默丢弃**——不报错、代码里不提示，模型只能靠 `searchTools()` / `ALL_TOOLS` 自己找。16 个工具的 TypeScript 声明加上描述，接近或超过这个量级时，行为会悄悄降级。

`namespace` 提供的是分层的可发现性：

- `namespace: { name, description }` → codemode 把一个 namespace 的工具列在同一标题下（MCP 服务器天然是一组，本仓库扩展同理）
- `namespace.instructions` → **更长**的使用说明；不进声明、不占 inlineBudget，脚本用 `describeNamespace(name)` 按需读

这条本质上是**跨插件的预算协调**，所以登记在 general 而不是任一插件下。

## 范围

**做什么**

1. **定命名与说明口径**（唯一定义处，写在 `docs/cross/` 新卡或现有卡里）：
   - namespace 名：`pwr` / `agent-team` / `loop`（对齐 pi 自己的 `mcp__<server>` 风格，不加仓库前缀）
   - `description`：一句话，短（进 inlineBudget）
   - `instructions`：本扩展的长说明（不进 inlineBudget，按需 `describeNamespace()` 读）；来源是各扩展 README/card 里已写好的用法段落，**不新写内容**
2. **实施落在三个扩展的 worktree 里**：`pwr-todo#14` / `agent-team-todo#73` / `loop-todo#11` 各自给自己的工具加 namespace（同一个 `registerTool` 调用，合并做避免碰同一文件两轮）。
3. **本条负责收口**：三个 worktree 全部合并后，验证 16 个工具全部带 namespace，并把命名口径落进文档。

**不做什么**

- 不改任何工具的 exposure / outputSchema / annotations（那三条各自负责）
- 不新增工具、不改工具语义
- 不改 `codemode` 自身设置（用户侧的 `defaultTools: ["+codemode"]` 不动）

## 验收标准

1. **三个前置 worktree 合并后**，`pi.getAllTools()` 里 16 个工具的 `namespace` 全部可读，且 namespace 名符合口径（`pwr` / `agent-team` / `loop`）。
2. **可发现性实测**：在真实会话的 codemode 里
   - `describeNamespace("pwr")` 返回 `{ name, description?, instructions?, tools }`，`tools` 含该扩展全部工具
   - `searchTools("...", { namespace: "agent-team" })` 能命中
   - codemode 描述里的工具声明落在 inlineBudget 内（对比加 namespace 前的声明体量）
3. 命名口径落盘到 `docs/`（跨插件卡或对应扩展卡），并写进 `docs/INDEX.md` 路由。
4. 仓库级 `npm run test:all` 全绿。
5. 三个前置条目（`pwr#14`/`agent-team#73`/`loop#11`）全部进入 `done` 后，本条才 `complete`。

## 人工确认

用户 2026-10-04 本会话确认：

- **本条登记为 p4**（三条工具面升级之后再收口）。
- **命名口径**（`pwr` / `agent-team` / `loop`，不加仓库前缀）由提出方给出，用户未提出异议（对应「我自己定的」一节）。
- **实施分工**：本条不在独立 worktree 里做实现，而是**并入三个扩展 worktree**；本条自身只做验证与文档收口——理由是 namespace 与 exposure/outputSchema/annotations 改的是同一批 `registerTool` 调用，并行分做必然冲突（用户 Q5 已确认并行 worktree，故此项为并行的必要前提）。
- **Q5**：并行开 worktree + subagent 实现，主会话仅追踪。
