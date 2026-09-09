# agent-team 知识库
<!-- PROJECT KNOWLEDGE BASE / Generated: 2026-09-09T03:50:04Z / Commit: 457adcf / Branch: dev-laptop / Parent: 根 AGENTS.md -->

## OVERVIEW
可复用多 agent 团队：独立 leader 子进程经 `team_dispatch` 调度成员子进程，自包含不引 pwr。

## WHERE TO LOOK
| 任务 | 位置 |
|---|---|
| 团队文件格式 | `~/.pi/agent/teams/*.md` 或受信项目 `.pi/teams/`（项目优先），frontmatter `leader` + `members[]` |
| 成员字段 | 每成员 `provider/model` + `tools` + `worktree` + 块标量 `prompt`，见 `examples/dev-team.example.md` |
| 双模式分叉 | `PI_AGENT_TEAM_FILE`：有则 leader 模式（仅 `team_dispatch`），无则 cockpit 模式（`team_create/list/run` + `/team*`） |
| 派发/并发上限 | `dispatch.ts`：每 dispatch ≤8 任务，4 并发成员 |
| 子进程复用 | `runner.ts`（子 pi JSON 模式，`team-tmp://` 物化，SIGTERM→SIGKILL） |
| 隔离分支 | `worktree.ts`（每次 run 独立分支，不碰当前目录） |
| 错误码 | `types.ts` `TeamErrorCodes` |

## CONVENTIONS
- 团队文件每次使用重扫，无缓存 —— 加缓存则项目覆盖用户优先级失效。
- leader prompt 经 `leader-prompt.ts` 组装，自包含任务上下文 —— 直传用户原话则成员看不到约束。
- 结果 ≤50KB、摘要 ≤8KB，与 pwr 同限不同码 —— 超限截断，违则 cockpit entry 溢出。
- cockpit/widget/entry 键 `agent-team-run-v1` —— 改键则旧会话渲染器失配。
- 缩进 2 空格（pwr 用 tab）—— 混用即 diff 噪音。

## ANTI-PATTERNS
- 从 pwr import 复用 —— 实证：自包含声明，`runner.ts` 另写一份子 pi 适配，不引 `pwr/runner`。
- dispatch 超 8 任务/4 并发 —— 实证：`dispatch.ts` 硬上限，超发直接拒绝不排队。
- 成员 prompt 一句空话 —— 实证：`examples/dev-team.example.md` 要求角色+约束+输出格式+验收。
- 前台 run 切视角换行重影 —— 实证：`todos/agent-team-todo.md` 未关闭条目，`view` 下 leader 派活后复现。

## COMMANDS
```bash
cd agent-team && npm install && npm test   # 102 测试（node --test test/*.test.ts）
npm run typecheck
```
