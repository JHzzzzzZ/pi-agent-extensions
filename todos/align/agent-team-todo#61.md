# agent-team-todo#61 多 run 并发下 `/team:stop` 的排队消息丢弃语义不一致

## 意图

同一个动作「停一个 run」，走命令与走工具清掉的排队消息不同：

- 命令路径 `/team:stop <runId>` → `src/extensions/agent-team/index.ts` 调 `chat.clear()`（`chat.ts:215`，**清空整个队列**，被丢弃条目统一记 `QUEUE_DROPPED_BY_CLEAR`）。
- 工具路径 `team_stop` → 同文件调 `chat.clearRun(runId)`（**只丢该 run 的**，记 `QUEUE_DROPPED_BY_STOP`），代码注释写明「其他并行 run 的排队消息保留」。

最多 3 个 run 并行时，用户对 run B 排了对话消息、此时停 run A，`/team:stop A` 会**静默丢掉 B 的排队消息**——丢的是用户自己的输入。同一操作两套语义，也违本仓库「同一操作只一种语义」的约定（reviewer 以 LOW 记录，run-1789133982726 交付）。

## 范围

做什么：

- 命令路径统一到 `chat.clearRun(runId)`：变卦语义只针对被停的 run。
- 被停 run 的排队消息转录结局记为 `QUEUE_DROPPED_BY_STOP`（而非 CLEAR）。
- 提示文案标明 run 与条数（已丢弃的排队消息属于哪个 run）。
- 补契约测试：命令侧与工具侧各一条对照用例，锁「停 A 不动 B 的排队」与丢弃条数文案。
- 文档同步：根 `README.md` 与 `docs/extensions/agent-team.md`。

明确不做什么：

- 不改 `/team:clear`：保持「清全部」，不加 `[runId]` 参数（用户显式动作，YAGNI）。
- 不改「≥2 活跃 + 省略 runId → 拒绝并列 runId」的既有行为（不猜、不误停）。
- 不新增转录条目类型、不改队列数据结构、不改 `/team:stop` 的其它三态语义。

## 验收标准

- 契约测试锁定：两个 run 并行时各自排队互不影响；停 A 后 B 的排队条数与内容不变、A 的被丢弃。
- 同一场景下命令路径与工具路径产出相同的丢弃结果（同一断言集跑两遍）。
- 修复前该场景可复现丢消息（作为红测），修复后绿。
- agent-team 全量测试 + `npm run typecheck` 零错误；README 与 docs 卡同步（含 `last verified`）。
- 事实核对：当前**没有任何测试**引用「已丢弃排队的」文案——测试覆盖从 0 补上。

## 人工确认

- 确认人：用户（本会话）
- 日期：2026-09-16
- 方式：会话内逐条问答对齐（25 问，用户回复「按你建议」）→ 5 份文档落盘后用户回复「确认」
- 结论：全部决策按本档执行（统一到 `clearRun(runId)`；转录记 STOP；`/team:clear` 保持全清；省略 runId 保持拒绝；命令侧 + 工具侧各一条契约测试并同步两处文档）。
