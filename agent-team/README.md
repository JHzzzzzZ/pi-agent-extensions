# agent-team — 多 Agent 团队协作扩展

为 Pi coding agent 提供可复用、可对话创建的 **agent team**：一个团队 = 1 个 leader + N 个成员，每个成员可指定独立的后端模型（`provider/model`，支持任意已配置供应商，如 `chatanywhere/gpt-5.6`、`anthropic/claude-opus-4-5`）与专属 system prompt。把任务（issue）派给团队后，由**独立的 leader 子进程**自主拆解、通过 `team_dispatch` 工具把子任务并行派给成员（各自为 `pi --mode json -p` 子进程）、审查结果、迭代返工，最终把报告交回主会话。整体参考 Multica 的 squad/leader/dispatch 模式。

```text
主 pi 会话（驾驶舱）
  ├─ 对话建团：主 agent 调 team_create / team_list 工具 → 写团队定义文件
  └─ 派单：/team:run <team> <task> 或 team_run 工具
        │ spawn（leader 专属 prompt + PI_AGENT_TEAM_FILE 环境变量）
        ▼
Leader 子进程 pi --mode json -p --no-session --model <leader.model> -e <本扩展>
        │ team_dispatch { tasks: [{agent, task}] }（≤8 个/次，≤4 并发）
        ▼
Member 子进程 ×N：pi --mode json -p --no-session --model <member.model> [--tools ...]
                   [--append-system-prompt <member.prompt>]  "Task: <子任务>"
                   （worktree 成员 cd 到独立 git worktree）
```

## 安装

把本目录复制到 `~/.pi/agent/extensions/`（全局）或受信任项目的 `.pi/extensions/`，然后在 Pi 中 `/reload`。也可 `pi -e ./agent-team` 临时加载。无构建步骤（Node ≥ 22.18 原生 type-stripping），无运行时 npm 依赖。

## 用法

### 1. 对话式建团（推荐）

直接对主 agent 说："帮我建一个团队，leader 用 opus 负责拆解审查，两个成员分别用 chatanywhere/gpt-5.6 写前端、claude-sonnet 写后端"。主 agent 会调用 `team_create` 工具落盘创建团队文件；`team_list` 可查看已有团队。创建成功后立即可派单（发现逻辑不缓存）。

### 2. 团队定义文件（可手写、可手改）

`~/.pi/agent/teams/*.md`（全局）或 `<项目>/.pi/teams/*.md`（项目，需信任；同名项目覆盖全局）。示例见 [examples/dev-team.example.md](examples/dev-team.example.md)：

```markdown
---
name: dev-team
description: 全栈开发小队
leader:
  model: anthropic/claude-opus-4-5
  prompt: |
    你是技术负责人。收到任务后：拆解 → 派发 → 审查 → 汇总。
members:
  - name: frontend
    description: 前端开发
    model: chatanywhere/gpt-5.6
    tools: [read, edit, bash]
    prompt: |
      你是资深前端工程师，使用 TypeScript……
  - name: backend
    description: 后端开发
    model: anthropic/claude-sonnet-4-5
    worktree: true          # 在独立 git worktree 中工作
    prompt: |
      你是资深后端工程师……
---

团队级补充说明正文（会追加到 leader 的 system prompt）。
```

要点：
- **leader.prompt 是整个功能的核心入口**——你在这里教 leader 如何完成任务（拆解策略、派发规则、验收标准）。扩展会自动追加团队花名册、`team_dispatch` 用法与最终报告格式。
- **leader 默认拥有全部内置工具**（读写文件、bash 等）。若要限制 leader 亲自动手（例如只让它拆解派发），在团队文件里设置 `leader.tools`（如 `tools: [read, grep, find, ls]`）。实测中 leader 可能会用编辑工具自行"降级代写"或修订团队配置——不希望如此就收紧它的工具。
- `worktree: true` 的成员在 `~/.pi/agent/teams/worktrees/<runId>/<member>`（分支 `team/<runId>/<member>`）中工作，改动留在该分支**不自动合并**，结果中附路径与分支名，由 leader/用户决定整合；要求当前目录是 git 仓库。
- 文件是唯一事实来源：手改后下一次派单即生效（leader 运行中使用启动时的花名册快照，运行中改文件不影响当次 run）；删除文件即删除团队（`/reload` 后动态命令消失）。

### 3. 派单与复用

| 方式 | 说明 |
|---|---|
| `/team:run <团队名> <任务>` | 后台运行，Widget 实时显示进度，完成后报告自动送入会话 |
| `/team:<团队名> <任务>` | 等价快捷方式（`/reload` 后对新团队生效） |
| `team_run` 工具 | 让主 agent 自主派单（同步等待，流式进度） |

同一团队可反复派单复用。运行记录以 `agent-team-run-v1` entry 持久化（含各成员结果摘要、token/费用统计）。

其它命令：`/team` 列出全部团队（含无效文件警告）；`/team:stop` 中止当前 run（SIGTERM → SIGKILL 逐级终止 leader 与成员）。

## 命令与工具一览

- 主会话工具：`team_create`（建团）、`team_list`（查团队）、`team_run`（派单）
- leader 进程内工具：`team_dispatch`（派发子任务给成员）
- 命令：`/team`、`/team:run`、`/team:stop`、动态 `/team:<name>`
- Widget：运行期间显示 leader/各成员实时状态（仅 TUI 模式）

## 开发与测试

```bash
cd agent-team
npm install
npm test          # node --test test/*.test.ts（45 个测试，含真实 git worktree 测试）
npm run typecheck # tsc -p tsconfig.json --noEmit
```

测试约定与仓库一致：`node:test` + `node:assert/strict`、手写 FakeChild 进程 fake、注入时钟、真实 git 只用于 worktree 用例（临时目录，自动清理）。

## 设计说明

- 零构建 TS ESM；entry `index.ts` 默认导出工厂；通过环境变量 `PI_AGENT_TEAM_FILE` 区分 leader 模式（只注册 `team_dispatch`）与驾驶舱模式（注册命令/工具/Widget）——同一份代码两种形态。
- 成员子进程与 pwr 的 `PiAgentRunner`、官方 subagent 扩展同模式：`--mode json -p --no-session`、行 JSON 事件流解析（usage/stopReason/finalText）、`team-tmp://` prompt 物化为 0600 临时文件、SIGTERM→SIGKILL 中止。本扩展自包含，不 import pwr。
- 结果截断：单成员结果 50KB、摘要 8KB；错误按成员隔离（单个成员失败不拖垮整次 dispatch）。
- 已知限制（v1）：任务为纯文本（GitHub issue 输入、成员后端适配外部 CLI 如 codex/claude-code 预留后续）；worktree 不自动合并；无超时（手动 `/team:stop`）。
