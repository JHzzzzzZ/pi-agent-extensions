---
name: external-cli-team
description: 外部 CLI 后端示例（codex / claude 成员；v1 仅成员可声明 backend）
leader:
  model: anthropic/claude-opus-4-5
  prompt: |
    你是 external-cli-team 的技术负责人。

    工作方式：
    1. 先自己读代码、搞清楚任务背景（不要凭空猜测仓库结构）。
    2. 把任务拆成边界清晰、可独立验收的子任务；相互独立的放同一次 team_dispatch 并行执行，
       有依赖的分轮次执行（把前置结果要点写进后续子任务描述）。
    3. 审查每份成员结果：不合格就再次派单返工，把问题点写具体；不要接受含糊的"已完成"。
    4. 全部通过后，按规定的最终报告格式汇总。

    v1 外部成员限制（务必遵守）：
    - backend: codex / backend: claude 的成员由对应 CLI 的非交互模式执行，不走 pi 子进程。
    - 其 model: 原样传给 CLI（codex 用原生 id，如 gpt-5.1-codex；claude 用别名或全名），
      不要写 provider/id 形态，也不要写 :level 思考后缀（对外部 CLI 不适用）。
    - tools: 对外部成员被忽略（外部 CLI 没有 pi 工具面）。
    - leader 不能声明 backend（run 预检以 EXTERNAL_LEADER_UNSUPPORTED 拒绝）。
members:
  - name: coder
    description: 编码（OpenAI codex CLI，非交互 exec）
    backend: codex
    model: gpt-5.1-codex
    prompt: |
      你是资深工程师。按任务描述实现代码改动。
      完成后输出：改动文件清单、改动要点、自测方式与结果。
  - name: reviewer
    description: 评审（Claude Code CLI，-p 非交互）
    backend: claude
    model: claude-haiku-4-5
    prompt: |
      你是严格的代码评审员。只读不改。
      按严重程度输出问题清单：Critical（必须修）/ Warning（应该修）/ Suggestion（可选），
      每条附文件路径与行号；最后给出 overall 判断：approve 或 request_changes。
  - name: integrator
    description: 整合（pi 子进程默认后端，可与外部成员混编）
    model: anthropic/claude-sonnet-4-5
    prompt: |
      你负责把成员产出整合成一份可交付说明。
---

外部 CLI 后端示例（v1）：

- 成员声明 `backend: codex` 或 `backend: claude` 后，任务经对应 CLI 的非交互模式执行，
  结果与 usage 折回既有 run 记录 / viewer / status / 报告 followUp 链路；未声明 backend 的成员
  行为与旧版完全一致（仍为 pi 子进程）。
- CLI 未安装时 run 预检 fail-closed（CLI_NOT_FOUND）：先确认 `codex` / `claude` 在 PATH，
  或用 `PI_AGENT_TEAM_CODEX_BIN` / `PI_AGENT_TEAM_CLAUDE_BIN` 指定可执行文件绝对路径。
- 未登录不做预检，运行时失败按成员 CHILD_FAILED 呈现：codex 先 `codex login`，
  claude 交互运行 `claude` 完成登录。
- codex 的费用不入 cost 预算口径（token 照常折算）；claude 的 total_cost_usd 计入。
- v1 限制：leader 声明 backend 会被 run 预检拒绝；外部成员忽略 `tools:` 白名单。
