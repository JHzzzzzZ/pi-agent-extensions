# general-todo#21 给 16 个工具标 ToolAnnotations

## 意图

pi 1.0 给工具定义加了 `annotations`（语义与 MCP tool annotations 一致）：

```ts
interface ToolAnnotations {
  readOnlyHint?;      // 工具不修改环境
  destructiveHint?;   // 可能删除/覆盖数据（只在非 readOnly 时有意义）
  idempotentHint?;    // 同参数重复调用无进一步效果
  openWorldHint?;     // 触达开放世界（web 等），而非封闭域
}
```

缺省按 MCP 默认解释：**非只读、可能有破坏性、可能触达开放世界**——即「不标 = 最保守」。

这条本身**没有用户可见收益**：annotations 是给**权限门**（包括 pi 文档里的参考实现，以及本仓库规划中的 `jev-safe-gate`）消费的元数据。所以本条是 `jev-safe-gate-todo#1` 的**前置**，单独登记是为了解耦——标注属于现有 16 个工具，门是一个新扩展。

## 范围

**做什么**

1. **定标注映射**（下表即权威清单）并在三个扩展的 worktree 里落地：

   | 扩展 | 工具 | readOnly | destructive | openWorld |
   |---|---|---|---|---|
   | pwr | `workflow_validate` | ✅ | — | — |
   | pwr | `workflow_start` | — | ✅ | ✅ |
   | pwr | `workflow_control` | — | ✅ | — |
   | pwr | `workflow_save` | — | ✅ | — |
   | agent-team | `team_status` / `team_list` / `team_transcript` / `team_models` | ✅ | — | — |
   | agent-team | `team_stop` / `team_create` | — | ✅ | — |
   | agent-team | `team_run` / `team_resume` / `team_dispatch` | — | ✅ | ✅ |
   | agent-team | `team_ask` | — | — | — |
   | loop | `loop_list` | ✅ | — | — |
   | loop | `loop_create` | — | ✅ | ✅ |
   | loop | `loop_delete` | — | ✅ | — |

2. **记录已知缺口**：`ToolAnnotations` **没有「阻塞」语义**，`team_ask` 这类等人工具无法用标注表达。它的护栏只能靠 `exposure: "model-only"`（见 `agent-team-todo#73`）。这个缺口写进本条目的 notes 与相关卡，避免后来者以为标全了就安全了。
3. **实施落在三个扩展 worktree 里**（与 exposure/outputSchema/namespace 同一批 `registerTool` 调用）；本条负责收口验证。

**不做什么**

- **不做权限门本身**（那是 `jev-safe-gate-todo#1`）——本条只产出元数据
- 不改 `solo-mode`（门的组合规则属于门的设计）
- 不改工具行为、exposure、outputSchema、namespace

## 验收标准

1. **三个前置 worktree 合并后**，`pi.getAllTools()` 里 16 个工具的 `annotations` 与本表逐条一致（测试断言，不是人工眼看）。
2. `team_ask` 的缺口在条目 notes 与对应文档里写明。
3. **参考规则可跑**（pi 文档给的判定式）：
   ```ts
   const needsApproval = hints?.destructiveHint === true
     || (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
   ```
   在真实会话里对上述工具求值，结果与本表语义一致（只读的四个判为不需批准，其余判为需要）。
4. 仓库级 `npm run test:all` 全绿。
5. 三个前置条目全部 `done` 后本条才 `complete`。

## 人工确认

用户 2026-10-04 本会话确认：

- **Q4：annotations 独立做，不并进 `jev-safe-gate`** —— 选项 **1**。理由：标注是现有 16 个工具的事、门是新扩展，混在一起会让 worktree 跨 4 个扩展。
- **Q2 清单**：标注映射与 exposure 清单同源（同一批工具的语义判断），用户对 exposure 清单「没问题」即包含本表。
- 本条登记为 **p5**。
- **Q5**：并行开 worktree + subagent 实现，主会话仅追踪。
