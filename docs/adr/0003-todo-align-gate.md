# todo 状态机加对齐门：open → aligning → aligned → processing → done

Status: accepted（2026-09-14，todo-cli-todo:11；用户选定门形态 / 文档落点 / 依赖门插位 / 展示口径 / 收口门）

`claim` 一步 open→processing 把「领取」与「开工」压成同一动作，返工成本在开工前最低时反而没有门。决定：状态机扩为五态，`claim` 变两段式——首次 `claim` 进 `aligning`（写逐条对齐文档、与人工确认，此阶段禁止写代码），新子命令 `align` 在文档结构校验通过后推 `aligned`，再次 `claim` 才进 `processing`；`processing` 起至 merge 全程无人值守。CLI 只做可机器验证的结构约束（状态迁移合法 + 对齐文档存在且完整），「是人敲的」这一人工门靠流程留痕（文档 `## 人工确认` 小节 + AGENTS 红线 10 审批）。存储 schema 升 v2（读 v1 兼容、写出一律 v2）。

## Considered Options

- **对齐产物存 notes**：不新增文档面，但长文挤进 JSON 单行注记，diff/评审不可读，也不便与人工逐条对谈——否决。
- **`claim --stage aligning|processing` 分模式**：命令数少，但把状态机藏进 flag 取值，迁移表不可见、幂等语义按 mode 分叉易错——否决。
- **`align start` / `align confirm` 两子命令**：把「开始对齐」也做成状态，等于给 aligning 加一个空转态，领取语义更绕——否决。
- **`claim`（open→aligning）+ `align`（aligning→aligned）+ `claim`（aligned→processing）**：每个状态迁移各有一个显式命令动词，幂等分支可按状态唯一判定（选定）。
- **对齐文档路径自由 `--doc`**：灵活但引入路径穿越面与「文档在哪」的不确定——否决，固定 `todos/align/<文件基名>#<id>.md`。
- **一次性补齐（triage 三态统一重构 + 一并实现依赖门 #10）**：改动面翻倍、无法单变更自验——拆出本条，依赖门契约只写进本 ADR。

## Consequences

- `todos/<名>.json` schema v2：条目新增 `alignedAt`；任一写操作重写整文件 ⇒ 被写过一次的文件即一次性升级（`version: 2` + 每条 `alignedAt: null`），不做批量回填。
- 历史 `open`/`processing`/`done` 原义不变；历史 `processing` 视为「已开工」，不要求补对齐文档、不回退状态。
- `complete` 从 `aligning`/`aligned` 收口必须带 `--note`（取消/搁置要留原因）；从 `open`/`processing` 收口不变。
- 人工门可审计性有上限：CLI 只保证顺序与文档结构，不能证明确认者身份；确认留痕 = 文档小节 + 审批记录。
- 回滚边界：旧版 CLI 读 v2 文件明确报错（`version 必须是 1`）；回滚路径 = git 历史 + `migrate to-md`。
- `dependsOn`/环检测（#10）将来插在 `aligned → processing` 之前——对齐已完成、尚未开工，正是依赖检查唯一不误伤的插位；本变更只固化该插位，不实现。
