# 跨扩展横切契约：自定义消息、entry 常量与 session 持久化键

> last verified @ 0142e14
>
> 各扩展通过 `pi.appendEntry`（持久化快照）与 `pi.sendMessage`（触发回合 / 送达结果）通信，键值常量集中在各自 types/index 文件。**改键名 = 破坏旧会话恢复**，必须同时写迁移或放弃兼容并注明。

## pwr（`pwr/src/types.ts`）

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `PWR_RUN_ENTRY` | `pi-workflow-run-v1` | 运行条目持久化（session_start 水合） |
| `PWR_APPROVAL_ENTRY` | `pwr-approval-v1` | 批准卡持久化（键 = 项目路径\|digest） |
| `PWR_GENERATION_CUSTOM_TYPE` | `pwr-generation-request` | `/workflow` → 主 agent 生成请求（before_agent_start） |
| `PWR_RESULT_CUSTOM_TYPE` | `pwr-workflow-result` | 运行完成 → followUp 结果送达 |

## agent-team（`agent-team/types.ts`）

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `RUN_ENTRY_TYPE` | `agent-team-run-v1` | 派单运行条目（entry 渲染器） |
| `RUN_RESULT_MESSAGE_TYPE` | `agent-team-result` | 报告 followUp 送达 |
| `WIDGET_ID` | `agent-team` | 状态键（每扩展一个，异常隔离） |

## 其它扩展

| 扩展 | 键 | 说明 |
| --- | --- | --- |
| goal | `goal-state-v1`（`GOAL_STATE_ENTRY`）/ `goal-result-v1` | 状态以 custom entry 持久化，`agent_settled` 时读取快照续回合 |
| loop | `loop-tasks-v1`（`LOOP_TASKS_ENTRY`）/ `loop-task-due`（`LOOP_DUE_CUSTOM_TYPE`） | 定时任务快照持久化；到期经 due 消息注入 |
| opencode-bridge | 无 entry 键；`opencode-bridge.json` 配置文件 + `PI_BRIDGE_PORT` / `PI_BRIDGE_SOCKS_HOST` / `PI_BRIDGE_SOCKS_PORT` 环境变量 | 端口持久化到 settings.json 同目录 |

## 约定与坑

- pwr 持久化**仅元数据**：脚本源码 / args / 工具输出永不写盘；`pwr-tmp://`、`team-tmp://` 仅进程内物化，不落业务盘。
- entry 读取一律 `ctx.sessionManager.getEntries()` 后按 `customType` 过滤（loop/goal 都这么做），并 try/catch 包裹——持久化失败绝不破坏会话。
- 环境变量开关模式：`PI_AGENT_TEAM_WIDGET=0`、`PI_HUMAN_NOTIFY=0`、`PI_AGENT_TEAM_FILE`（模式切换）——新开关沿用 `PI_<扩展>_<开关>` 命名。
- 子进程契约统一：`pi --mode json -p --no-session`（pwr 固定追加 `--no-session`，见 pwr/runner/index.ts），按行 JSON 事件，SIGTERM → 5s（pwr）/ 等价 grace（agent-team）后 SIGKILL。loop 的 --bg 后台模式例外：不带 --no-session 以便 `pi --session <id>` 恢复。
