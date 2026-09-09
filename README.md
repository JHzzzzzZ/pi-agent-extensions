# Pi Coding Agent 扩展集

本目录是 Pi 编码助手的扩展工作区：一个主项目 **PWR**（本地工作流编排）加十个独立卫星扩展（多 agent 团队、模型提供商、额度查询、流式计量、运行计时、定时任务、会话目标循环、本地代理桥、深度初始化、人工介入通知）。全部为**零构建 TypeScript ESM**，由 Node ≥ 22.18 原生 type-stripping 直接执行，运行时无 npm 依赖。

| 扩展 | 作用 | 测试 |
| --- | --- | --- |
| [`pwr/`](#pwr--pi-workflow-runtime-主项目) | 工作流编排：脚本引擎 + 子进程 runner + 批准/保存/UI | 405 个（node:test） |
| [`agent-team/`](#agent-team--多-agent-团队协作) | 可复用多 agent 团队：leader 调度成员协同完成任务（含全屏分栏会话记录查看器，支持查看器内停止 run） | 223 个 |
| [`stream-token-speed/`](#stream-token-speed) | 流式回复 TTFT / tokens/s 实时计量 | 43 个 |
| [`chatanywhere-provider/`](#chatanywhere-provider) | ChatAnywhere 双 provider（OpenAI 兼容 + Anthropic API），运行时自动发现模型 | 无 |
| [`provider-quota/`](#provider-quota) | provider 账户额度/余额查询 | 15 个（node:test） |
| [`run-timer/`](#run-timer) | 任务/回合/会话耗时计时 | 单文件测试（同目录） |
| [`loop/`](#loop) | /loop 定时任务：固定间隔 / 每天定时 / 每日窗口循环 + 一次性提醒 + --bg 后台 agent 模式 | 169 个（node:test） |
| [`goal/`](#goal) | 会话目标循环：`/goal` 设定条件，agent 跨回合自动推进直至评估器判定达成 | 44 个 |
| [`deep-init/`](#deep-init) | 深度初始化：`/deep-init` 扫描仓库并生成层级 AGENTS.md 项目知识库 | 32 个（node:test） |
| [`opencode-bridge/`](#opencode-bridge--本地代理桥http-connect--socks5) | 随 Pi 启动拉起本地 HTTP CONNECT → SOCKS5 代理桥（独立 helper 进程，多实例复用；`/opencode-bridge-sync` 确认式修改 httpProxy + 端口自定义自动迁移，`/opencode-bridge-restore` 从备份恢复，均可撤销） | 108 个 |
| [`human-notify/`](#human-notify) | 人工介入 Windows Toast 通知：审批/输入/等人工具等待与 agent 结束时把人叫回终端；用户取消回合后不弹完成通知（Linux / macOS no-op） | 37 个 |

## 安装

本仓库是一个标准 **pi 包**（根目录 `package.json` 带 `pi` manifest，keyword `pi-package`）。推荐通过 `pi install` 安装，由 pi 统一管理并支持升级；也可手动复制（开发调试用）。

要求：**Node.js ≥ 22.18**（原生 TS type-stripping，无构建步骤、无 bundler）。

### 方式一：pi install（推荐）

```bash
# 全局安装（写入 ~/.pi/agent/settings.json，跟随默认分支）
pi install git:github.com/JHzzzzzZ/pi-agent-extensions

# 或仅当前项目使用（写入项目 .pi/settings.json，项目信任后启动自动补装）
pi install -l git:github.com/JHzzzzzZ/pi-agent-extensions

# 免安装试用（仅本次运行，装到临时目录）
pi -e git:github.com/JHzzzzzZ/pi-agent-extensions
```

安装后由 pi 统一管理：

- **升级**：仓库 push 后执行 `pi update --extensions`（或 `pi update --all`）拉取最新即可
- `pi list` 查看已装包；`pi config` 可单独启停包内的某个扩展
- 如需锁定版本，可带 tag 安装（如 `pi install git:...@v1.0.0`）；此时 `pi update` 只把克隆对齐到该 ref，不会自动跳新版本，升级需重新 `pi install git:...@新tag`

### 方式二：手动复制（开发调试）

将扩展目录复制到 `~/.pi/agent/extensions/`（全局）或可信项目 `.pi/extensions/`（项目级），然后在 Pi 中执行 `/reload` 生效。卸载 = 删除目录。每个扩展目录均以 `index.ts` 为入口（pi 自动发现约定：`extensions/*/index.ts`），整目录复制即可被自动加载。

```text
~/.pi/agent/extensions/pwr/
~/.pi/agent/extensions/stream-token-speed/
...
```

> 两种方式不要混用同一扩展，否则会重复加载（命令/状态条重复注册）。从手动复制切换到 `pi install` 时，先删除 `extensions/` 下的旧拷贝。

## 5 分钟上手

从零到跑通第一个真实任务。每一步都有可验证的成功判据——看到判据再走下一步。

**Step 0 · 前置条件**（还没装 pi 的先做这步）

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # 安装 pi 本体
pi                                                                 # 首次启动按提示 /login 配置任意一个模型 provider
```

✅ 判据：`pi` 启动后能正常对话（发一句“你好”有回复）。

**Step 1 · 装本扩展包并验证**

```bash
pi install git:github.com/JHzzzzzZ/pi-agent-extensions
pi                                                                 # 重新启动 pi
```

✅ 判据：在输入框敲 `/loop list`，看到任务列表或“没有定时任务”提示——说明扩展已加载。若命令不存在，先在 pi 里执行 `/reload`，再用 `pi list` 确认包已登记。

**Step 2 · 第一个定时任务（loop）**

```text
/loop in 1m 说一句“安装成功，恭喜”
```

✅ 判据：约 1 分钟后 agent 主动向你道喜；输入 `/loop delete <id>`（或 `/loop clear`）清掉测试任务。

**Step 3 · 派第一个 agent 团队（agent-team）**

直接对 agent 说：“建一个两人团队 reviewer+writer，让 writer 写一首关于终端的短诗，reviewer 审完后汇报”。agent 会调 `team_create` 建团、`team_run` 派单；输入栏下方出现可选中亮块，`↓` 进入选中、`enter` 打开查看器看每个成员的完整会话记录。

✅ 判据：亮块显示 run 结束终态（`✓ · 耗时 · 费用`），报告自动送达会话。

**Step 4 · 跑第一个工作流（pwr）**

```text
/workflow 扫描当前仓库并生成一份架构概述
```

agent 生成脚本后弹出批准卡，选 `Run once`；`/workflows:view` 可实时观看每个子 agent 的执行轨迹。

✅ 判据：批准后运行完成，结果以 `pwr-workflow-result` 消息回传。

**排障 FAQ**

| 现象 | 处理 |
| --- | --- |
| `/loop` 等命令不存在 | pi 里执行 `/reload`；`pi list` 确认包已装；两种安装方式不要混用（重复加载会互相覆盖） |
| 模型不可用 / 无响应 | pi 里 `/login` 检查 provider 配置；`/model` 切换模型 |
| Windows Toast 不弹 | human-notify 仅 Windows 生效（Linux/macOS no-op）；`PI_HUMAN_NOTIFY=0` 会整体关闭 |
| 状态条没出现 stream-token-speed / provider-quota / run-timer | 这三个是状态 widget，需对应事件（流式回复 / 支持的 provider / 会话计时）才显示 |

---

## pwr — Pi Workflow Runtime（主项目）

本地工作流编排扩展（v2.4.0）。用户编写受约束的 ECMAScript 工作流脚本（白名单 API：`meta/args/agent/pipeline/parallel/sleep/JSON`），PWR 校验后弹出批准卡，再由子 `pi` 进程作为 subagent 执行。

### 效果示意

`/workflows` 运行列表（实测格式）：

```text
PWR runs (2)
run        script              status             elapsed    agents     tokens    cost     warnings
a1b2c3d4   code-review.js      completed          2m 14s     12/12      84.2k     $0.41    -
e5f6a7b8   doc-translate.js    running            0m 38s     3/9        21.7k     $0.09    [!] large run
```

`workflow_validate` 成功后自动弹出批准卡（关闭卡片仍是待批准，不是拒绝）：

```text
Approve workflow "code-review.js"?
run:   a1b2c3d4
digest 3f9a1c2e4b

（脚本执行计划：stage 划分 / 每个 stage 的 agent 数 / budget 估算）

Choices: Run once / Remember for this script / View raw script / Reject
  ❯ Run once
    Remember for this script
    View raw script
    Reject
```

`/workflows:view <runId>` 全屏运行查看器（脚本结构图 + 每 stage 一页 + 实时 trace）：

```text
┌─ PWR · code-review.js · running · 1m 05s · run a1b2c3d4 ─────────────────┐
│ [1 概览] [2 Stages] [3 Agents] [4 Result] [5 脚本]                        │
│ …每个 agent 行下方实时滚动该子 agent 的工具调用摘要与输出尾部、tokens 累计 │
└─ ctrl+alt+z 暂停 · ctrl+alt+x 停止 · ctrl+alt+r 重启 agent · ↑/↓ 滚动 ───┘
```

### 功能

- **脚本引擎**（`engine/`）— acorn 解析 + 白名单校验（拒绝 `eval`/`vm`/反射/原型访问/动态代码）+ AST 解释器；单次快照安全边界，防宿主泄漏；脚本 ≤ 256KB、单运行 ≤ 1000 次 agent 调用、并发 ≤ 128
- **运行编排**（`runtime/` + `runner/`）— FIFO 调度、运行缓存（digest 命中直接回放）、child `pi` 进程适配器（结果 50KB / 摘要 8KB 截断、abort 时 SIGTERM → 5s 后 SIGKILL）；agent 定义发现（用户 > 项目 > 内置 scout/planner/reviewer/worker 兜底）
- **实时运行 trace**（v2.4.0）— 子 agent 的每一步（工具调用 + 参数摘要、长输出尾部、助手流式文本尾部约 1s 节流）实时显示在查看器对应 agent 行下方，tokens 随回合实时累计（单行截断、绝不透传原始工具输出）
- **完整结果送达** — 最终 JSON ≤ 8KB 时全量内联进完成消息；**> 8KB 时完整 JSON 落盘 `~/.pi/agent/workflows/results/<runId>.json`**，消息携带 JSON 安全截断的预览（含 `"__pwr_truncated__": true` 标记）+ `完整结果: <路径>` 行，消息总预算 16KB；持久化会话条目同样 JSON 安全截断并带 `resultPath` 字段，可从会话文件恢复全量结果
- **结果回传** — 运行成功或失败后以 `pwr-workflow-result` 消息自动唤起主 agent 汇报；用户主动取消不打扰
- **批准记忆** — 批准键 = 项目 canonical path + 脚本 SHA-256 digest；脚本被编辑后必须重新批准
- **保存/复用**（`workflow_save` + `/workflow:<name> <参数>`）— 自动补齐 meta、落盘前强制重新校验、参数 JSON-schema 校验（`meta.argsSchema`）；args 支持 **`key=value` 语法**（按 schema 自动转类型，重复键/逗号成数组，`{` 开头仍按 JSON 解析，v2.4.0）；保存位置：用户范围 `~/.pi/agent/workflows/<name>.js`、项目范围 `.pi/workflows/<name>.js`（仅可信项目）
- **观察与控制**（`/workflows`）— 运行列表/详情/批准卡 UI，暂停/恢复/停止/重启，快捷键 `ctrl+alt+z/x/r`；`/workflows:saved` 列出已保存工作流（scope/描述/参数提示），`/workflow-delete` 不带名称时同样先列出（v2.4.0）

### 命令

| 命令 | 作用 |
| --- | --- |
| `/workflow <任务>` | 生成工作流（也支持 `workflow:` 前缀） |
| `/workflow:<name> <args>` | 调用已保存的工作流（args 为 `key=value` 对或 JSON，如 `files=src depth=2`） |
| `/workflow-delete [name]` | 删除已保存的工作流（项目范围优先；不带名称先列出全部） |
| `/workflows:saved` | 列出已保存工作流（scope、描述、args 用法提示） |
| `/workflows` | 运行列表/详情 UI |
| `/workflows:view [runId]` | 全屏运行查看器（v2.3.0）：脚本结构图 + 每 stage 一页 + 结果/脚本页 |
| `/workflows:approve <runId>` | 手动为 `awaiting_approval` 的运行弹批准卡 |
| `/pwr-model [auto\|<model-id>]` | 查看/设置工作流默认模型（优先级：agent 定义 model > 脚本逐调用 model > PWR 默认 > 子 pi 默认） |
| `workflow_save` / `workflow_validate` / `workflow_start` / `workflow_control` | agent 可调用的工具 |

### 测试与开发

```bash
cd pwr
npm install        # 仅 devDependencies（typescript、pi-* 类型、typebox）
npm test           # 405 个单测（test/ + tests/ + runtime/test/ + runner/test/）
npm run typecheck  # tsc --noEmit（strict + erasableSyntaxOnly，0 错误）
npm run demo       # 模拟 /workflows UI（无宿主）
```

测试全 mock（fake AgentRunner / fake child pi 进程），不产生真实子进程、无网络。架构与安全说明见 `pwr/DELIVERY.md`，DSL 语法与使用示例见 `pwr/README.md`。

### 安全边界

- 脚本无 FS/shell/network/process 直连；校验白名单执行，fail-closed
- 错误信息为静态模板，不泄露文件内容/密钥/脚本源码
- 会话 entry 只持久化运行元数据（不写脚本源码、args 原文、凭证）；`pwr-tmp://` 只在进程内展开
- 项目范围保存/加载受信任门控；runner 不可用返回 `AGENT_RUNNER_UNAVAILABLE`，绝不隐式回退主 agent

---

## agent-team — 多 Agent 团队协作

可复用、可对话创建的多 agent 团队（参考 Multica 的 squad/leader/dispatch 模式）。团队 = 1 个 leader + N 个成员，每个成员可指定独立后端模型（`provider/model`）与专属 system prompt。派单后由**独立 leader 子进程**自主拆解任务、通过 `team_dispatch` 工具并行调度成员子进程、审查结果并汇总报告交回主会话。

效果示意（运行期间 widget，实测格式）：

```text
agent-team dev-team ▶ running · 3m 12s
任务: 重构登录模块并补齐单测
leader: claude-opus-4 · 已派发 3 个子任务
  ↳ 正在审查 frontend 的改动
▶ frontend running — 编辑 auth.ts
▶ backend running — 单测 12/18 通过
✓ reviewer done — 整体通过，2 条非阻塞建议
```

- **对话式建团** — 主 agent 调 `team_create`/`team_list` 工具直接创建/查看团队；团队定义文件（`~/.pi/agent/teams/*.md` 或项目 `.pi/teams/*.md`）可随时手改，下一次派单即生效
- **派单与复用** — `/team:run <团队> <任务>`、`/team:<团队> <任务>` 或 `team_run` 工具（默认后台，报告完成自动送达，返回含 runId）；同一团队反复使用；`/team:stop` 或 `team_stop` 工具按 runId 中止（settle-aware：停止后拿到 aborted 终态记录，报告 followUp 不再送达，可立即重新派单）
- **隔离与统计** — 成员可选 `worktree: true` 独立 git worktree（分支 `team/<runId>/<member>`，不自动合并）；按成员统计 token/费用；运行记录持久化为会话 entry
- **进度可视（可选中亮块）** — 输入栏下方的紧凑亮块：暗色一行概要（团队/状态/耗时/并行成员数 + 任务），`↓`/`←`（编辑器为空时）或 `alt+↓` 进入选中（`↑`/`↓`/`j`/`k` 移动、`enter` 打开查看器看成员明细、`esc`/其它键退出并放行编辑器）；run 结束切终态行（`✓/✗ · 耗时 · 费用`），不再残留 running（SIGTERM → SIGKILL 逐级中止）；不需要终态行时 `/team:clear` 手动清除（`/reload` 后仅进行中 run 自动重挂）。TUI 行为对照 pi-subagents fleet 代码级同步（见 [agent-team/docs/tui-sync.md](agent-team/docs/tui-sync.md)）
- **防失控与崩溃恢复** — 派发预算可配（frontmatter `budget:` 块：dispatch/成员运行次数 + 可选费用/token 硬上限，超限自动中止 `BUDGET_EXCEEDED`）；派单前 model 预检（引用不存在的模型直接拒绝，不启动任何子进程）；每 run 元数据快照落盘，主会话中断后下次启动自动 reconcile 残留 run 并诊断孤儿 leader（只报告不杀）；`/team:doctor` 自检报告
- **会话记录查看器** — `/team:view` 全屏左右分栏（fleet inspector 同款：左栏成员 roster 带选中标记与状态，右栏 Run/State/成员 元信息头 + 选中成员的连续会话流——任务气泡 + 主 agent 同款 Markdown 回复 + 合并工具行；≈85% 终端高，窄于 36 列仅提示），run artifacts 落盘、run 结束后仍可查；`D` 停止整个 run（两步确认，确认后中止 leader 与全体成员、报告不再送达，与 `team_stop` 同语义）、`r`/`R` 手动刷新、`q`/`Esc`/`ctrl+c` 关闭；主 agent 可用 `team_transcript` 工具转述记录要点

```bash
cd agent-team
npm install && npm test        # 215 个测试（含真实 git worktree 用例）
npm run typecheck
```

详见 [`agent-team/README.md`](agent-team/README.md)（团队文件格式与示例见 `agent-team/examples/dev-team.example.md`）。

---

## stream-token-speed

流式回复速度计量：显示 **TTFT（首 token 延迟）** 与瞬时 **tokens/s**（1s 滑动窗口 + EMA 平滑，250ms 节流），结束后保留本轮 TTFT / 最后瞬时值 / 平均速度。计量范围覆盖 text / thinking / tool call 增量；tool result 与工具执行进度一律排除。不读取、不记录、不发送任何消息内容。

效果示意（终端状态行，实测格式）：

```text
生成中：TTFT 412 ms｜速度 86.4 tok/s          ← 流式回复期间实时刷新（热身期速度显示 —）
TTFT 412 ms｜最后 ~91.2 tok/s｜平均 78.6 tok/s ← 回合结束后保留（~ 表示末尾瞬时值为沿用值）
```

```bash
cd stream-token-speed
node --experimental-strip-types --test test/*.test.ts   # 43 个测试
node e2e/run-e2e.mjs                                    # 真实 pi 进程端到端自测
```

## chatanywhere-provider

通过 [ChatAnywhere](https://docs.chatanywhere.tech) 的 OpenAI 兼容 API 与 Anthropic Messages API 接入模型（`chatanywhere` + `chatanywhere-claude` 两个 provider）。**模型运行时自动发现**：加载时探测 `GET {base}/models`，按“家族线 + 档位”归并去重注册——同种（同线同档）取最新（thinking 变体优先）、每条线最多保留 3 个档位、标准渠道优先于 `-ca`；**非 chat 模型（embedding/tts/whisper/生图等）一律不注册**，**旧代系列（GPT-4.x/o3/gemini-2.x 等）整代删除、每家族只保留最新代**（v1.2.0）。命中内置定价目录（catalog.ts：GPT-5.6/5.x、DeepSeek、Qwen、Kimi、GLM、MiniMax、Gemini、Claude 等，CA币/1K 换算为 Pi 成本跟踪）取目录价，目录外新模型自动注册为“未定价”（默认规格 + 接口窗口值）。探测失败 fail-closed：两个 provider 均不注册模型，绝不回退静态目录。

```bash
# 设置 API Key（两种方式任选；探测自动按 环境变量 → ~/.pi/agent/auth.json 顺序读取）
export CHATANYWHERE_API_KEY=sk-xxx            # 方式一：环境变量
# ~/.pi/agent/auth.json 里加 {"chatanywhere": {"type": "api", "key": "sk-xxx"}}   # 方式二：auth.json
export CHATANYWHERE_BASE_URL=https://api.chatanywhere.tech/v1   # 可选，Claude 端点自动去 /v1
```

## provider-quota

查询当前 provider 的账户额度/余额并在终端状态行显示。内置 OpenRouter、DeepSeek、ChatAnywhere、智谱 GLM、OpenCode Go 适配器；智谱原始 token 仅允许发往 HTTPS 白名单主机。智谱状态行附带 5 小时窗口的下次刷新时间（`GLM tok X% mcp Y% → HH:mm (Xh Ym)`，跨日显示 `MM-dd HH:mm`，字段以实测 `nextResetTime` 为准）。OpenCode Go（订阅制，key 即 `auth.json` 里 `opencode-go` 条目）显示 5 小时/周/月三个窗口的用量百分比，后缀重置时间跟随命中的限额窗口（达到限额显示该窗口重置时间，都未限额默认显示 5h 窗口）。每 5 分钟自动刷新（10s 超时 + 3 次重试退避），切换模型时立即刷新；手动刷新 `/quota`。API Key 从环境变量或 `~/.pi/agent/auth.json` 读取。

效果示意（终端状态行，实测格式）：

```text
OR $4.58 (used $5.42)                ← OpenRouter：剩余额度（已用）
DS 102.50 CNY                        ← DeepSeek：余额
CA 186.40                            ← ChatAnywhere：余额
GLM tok 72% mcp 40% → 14:30 (2h 5m)  ← 智谱：token/MCP 窗口占用 + 下次刷新倒计时
GO 5h 15% 周 6% 月 3% → 03:41 (2h14m) ← OpenCode Go：5h/周/月窗口 + 命中限额窗口的重置时间
```

```bash
node --experimental-strip-types --test provider-quota/index.test.ts
```

## run-timer

终端底部状态行计时：当前任务耗时、本轮对话耗时、会话总耗时（每秒 tick）。含 CJK 视觉宽度处理，避免中文导致布局错位。

效果示意（widget，实测格式）：

```text
任务 05:32 · 本轮 00:41 · 本会话 18:07
上次任务 12:03（已结束） · 本轮 00:00 · 本会话 18:07   ← 任务结束后切换为「上次任务」
```

```bash
node --experimental-strip-types --test run-timer/run-timer.test.ts
```

## loop

定时任务扩展（精简版，参考 Claude Code `/loop`）：固定间隔循环 + 每天定时循环 + 每日时间窗口循环 + 一次性提醒 + 后台 agent 模式。到期任务经 `deliverAs: "followUp"` 在回合间送达——agent 空闲则开新 turn，正在响应则排队到当前 turn 结束；错过的时间点不补跑。任务以全量快照持久化为会话条目（`loop-tasks-v1`，不进 LLM 上下文），随会话恢复；重复任务 7 天过期、每会话上限 50 个、widget 显示下次倒计时。

| 命令 | 作用 |
| --- | --- |
| `/loop 5m <任务>` | 固定间隔循环（单位 `s/m/h/d`，最小 1m，秒向上取整；兼容 `every 2 hours` 分写） |
| `/loop in 30m <任务>` | 一次性提醒（相对时间） |
| `/loop at 15:00 <任务>` | 一次性提醒（本地时刻，已过则排到明天） |
| `/loop daily at 09:00 <任务>` | 每天固定时刻循环（`every day at` 等价；首触发已过则排明天）（v1.2.0） |
| `/loop every 1h from 00:00 to 09:00 <任务>` | 每日时间窗口 `[start, end]` **闭区间**内按间隔循环：网格锚定在窗口起点（如每小时 → 0:00, 1:00, …, 9:00），支持任意间隔（`every 90m`），要求 `start < end`，跨天用本地时区日 rollover（v1.2.0） |
| `/loop --bg <上述任意创建形态>` | **后台模式**（v1.3.0）：到期不注入当前会话，而是拉起独立子 pi 进程（`pi --mode json -p --name loop-<id>`，无 `--no-session`），每次触发开新会话落盘；会话 id 自动记入任务，用 `pi --session <id>` 可随时恢复后台对话记录。上一轮未跑完则本次跳过；会话关闭自动终止在途子进程并标记 interrupted |
| `/loop list` | 查看全部任务（后台任务附 `[后台]` 徽标与最近一次运行状态/会话 id） |
| `/loop pause <id>` / `resume <id>` | 暂停/恢复（id 支持前缀匹配） |
| `/loop delete <id>` / `clear` | 删除单个/全部任务 |

效果示意（widget + `/loop list`，实测格式）：

```text
widget：⏰ loop 2 个任务 · 下次 04:32 · 后台运行 1

/loop list：
a1b2c3d4  every 30m                          14:30:00  检查 CI 状态
e5f6g7h8  [后台] every 1h from 00:00 to 09:00  01:00:00  夜间巡检部署
```

daily/window 调度与固定间隔共用同一套语义：错过的时间点不补跑（跨天/跨窗口只触发一次），暂停后恢复、会话恢复（hydrate）时错过的触发点直接重算到下一个未来时刻；旧格式快照（无 schedule 字段）零迁移兼容。

**后台模式细节**（v1.3.0，`runner.ts`）：子进程 cwd 取宿主会话目录，会话落在该项目的 sessions 目录（`pi -r` 选择器可见，`--name loop-<id>` 可辨识）；JSON 输出首行会话头 `{"type":"session","id":…}` 被捕获记入 `lastRun`；单次运行超时 30 分钟（SIGTERM→SIGKILL）；完成后通知结果摘要与恢复提示。前台模式行为完全不变。

**agent 工具**（v1.1.0，v1.2.0 起支持新调度语法，v1.3.0 起支持 `mode: "foreground" | "background"`）：模型可直接调用 `loop_create`（`task` + `schedule` 调度描述，语法同命令）、`loop_list`、`loop_delete` 管理定时任务——"每 30 分钟检查一次 X"、"每天早上 9 点做 X"、"每天 0 点到 9 点每小时巡检"、"后台每小时帮我检查一次部署"这类自然语言请求由 agent 自行建任务。

```bash
cd loop
npm install        # 仅 devDependencies（typescript、pi-coding-agent 类型、typebox）
npm test           # 169 个测试（node:test）
npm run typecheck  # tsc --noEmit（strict，0 错误）
```

## goal

会话目标循环（参考 Claude Code `/goal`）：`/goal <条件>` 设置完成条件后，agent 跨回合自动推进——每个回合结束（`agent_settled`）由**独立 LLM 评估器**（当前会话模型的一次小调用，限 512 tokens）根据目标 + 最近回合 assistant 输出判定 `{met, reason}`；未达成则携带评估原因自动开启下一回合（`triggerTurn + followUp` 续跑通道），达成后自动清除目标并写入结果条目。**不设轮次上限**，可在条件文本中自限（如 "or stop after 20 turns"）。

- `/goal` 查看状态（目标/已评估轮数/时长/评估器最近判定）；`/goal clear|stop|off|reset|none|cancel` 停止；`/goal resume` 在手动中断或评估器连续失败暂停后恢复
- 每会话一个活跃目标，条件最长 4000 字符；恢复会话时目标保留但轮数/计时重置；不改变任何工具权限语义
- 手动中断（Esc）自动暂停；评估器连续 3 次失败暂停（瞬时失败不杀循环）

效果示意（终端状态行，实测格式）：

```text
◎ goal: 让 pwr 全部测试通过且 typecheck 零错误 · 第3轮 · 06:12   ← 推进中
⏸ goal: 让 pwr 全部测试通过且 typecheck 零错误 · 已暂停 · 06:12  ← 手动中断后自动暂停
```

```bash
node --experimental-strip-types --test goal/index.test.ts   # 44 个测试
```

---

## deep-init

深度初始化（参考 oh-my-openagent `init-deep`）：`/deep-init` 扫描仓库结构并生成层级 `AGENTS.md` 项目知识库——根文件（项目全貌）+ 按复杂度评分选出的子目录文件，agent 自动读取相关上下文，无需手工维护。提示词驱动薄封装：插件只做参数解析、已有文件预检与 `--create-new` 二次确认，四阶段中发现阶段按规模并行派 subagent 探索并汇总，其余由主 agent 用自身工具执行。

- `/deep-init` 增量更新（默认）；`/deep-init --create-new` 全量重建（已有文件时须加 `--yes` 确认）；`--max-depth=N` 限深（默认 3）；末尾可跟目标目录
- 评分选址：文件数 3x>20、引用中心度 3x>20；>15 建、8–15 有独立领域才建、<8 跳过，根必建
- 写铁律：已存在用 `edit`、不存在用 `write`；子不复父、电报体；完成照发 `=== init-deep Complete ===` 报告

```bash
cd deep-init && npm install && npm test   # 32 个测试；另有 npm run typecheck
```

---

## opencode-bridge — 本地代理桥（HTTP CONNECT → SOCKS5）

背景：opencode-go 的 Muse Spark 等模型按出口 IP 限区，而 Pi 只支持 HTTP 代理（不认 `socks5://`）。本扩展随 Pi 启动确保一个**独立 helper 进程**在跑：它监听 `127.0.0.1:<端口>`（默认 `10899`），把 HTTP CONNECT 转成你本地 v2rayN 的 SOCKS5（默认 `127.0.0.1:10808`）。需要让模型请求走本桥时，运行 `/opencode-bridge-sync`：**人工确认后**才修改 settings.json 的 `httpProxy` 字段（仅此字段，其余配置不动；修改前原文件自动备份到 `settings.json.bak-opencode-bridge-<时间戳>`）。扩展自身**绝不自动修改** settings.json。端口优先级：命令行参数 > `PI_BRIDGE_PORT` > 配置文件（settings.json 同目录 `opencode-bridge.json`，仅 `{"bridgePort": N}`）> 默认值。

- **进程隔离** — 桥运行在独立进程（`opencode-bridge-helper.mjs`，零依赖 .mjs）中，任何 socket 异常/未捕获异常都不会影响 Pi 主进程；Pi 侧 spawn 后 `unref()`，不持有子进程资源
- **多实例复用** — `session_start` 只做 TCP 探测：桥已在监听则直接复用（多个 Pi / subagent 共用一个桥），仅在必要时拉起 helper；端口被另一个桥占用时新 helper 以 0 退出（竞争安全）
- **协议健壮性** — CONNECT 完成 SOCKS5 无认证握手（域名方式，分片应答按缓冲累积解析）后双向转发（含请求头部剩余数据）；普通 HTTP 返回 405；上游拒绝/握手失败返回 502；客户端中途断开只清理自身，桥继续服务后续请求
- **受控退出** — SIGTERM/SIGINT 优雅退出；`GET /__bridge/shutdown`（仅本地可达）供测试/受控关闭
- **端口自定义** — `/opencode-bridge-sync [port]` 直接跟端口，或无参时交互式询问（回车保持当前）；改端口后一次确认覆盖写配置文件、停旧桥、起新桥、改 httpProxy 四件事；停旧桥时校验自家 helper 指纹（不符则不动并提示手动释放），等端口释放超时则 abort，全程 fail-closed

前置条件：本地 SOCKS5 代理（如 v2rayN）已在 `PI_BRIDGE_SOCKS_HOST:PI_BRIDGE_SOCKS_PORT` 运行。

| 命令/配置 | 作用 |
| --- | --- |
| `/opencode-bridge` | 查看状态（必要时尝试启动）：监听地址、上游 SOCKS5、端口来源、配置引导 |
| `/opencode-bridge-sync [port]` | 修改 settings.json 的 `httpProxy` 指向本桥（人工确认 + 自动备份；仅改 `httpProxy` 字段；桥不通且现值指向本桥时提议移除）；带参用参数端口，无参交互询问并持久化到 `opencode-bridge.json`，改端口自动迁移（指纹确认停旧桥 + 起新桥 + httpProxy 联动） |
| `/opencode-bridge-restore` | 从备份列表选择恢复 settings.json（人工确认；恢复前先把当前配置再备份一份，保证恢复操作本身可撤销） |
| `PI_BRIDGE_PORT` | 桥监听端口，默认 `10899`（仅绑定 127.0.0.1；需 1-65535 整数，非法启动时报静态错误） |
| `PI_BRIDGE_SOCKS_HOST` | 上游 SOCKS5 主机，默认 `127.0.0.1` |
| `PI_BRIDGE_SOCKS_PORT` | 上游 SOCKS5 端口，默认 `10808` |
| `PI_BRIDGE_LOG` | helper 日志文件路径（默认与 helper 同目录的 `opencode-bridge.log`；单行/文件大小均有上限，不记录 payload） |

```bash
cd opencode-bridge
npm install        # 仅 devDependencies（typescript、pi-coding-agent 类型）
npm test           # 108 个测试（node:test；helper 集成测试用真实子进程 + 手写 fake SOCKS5 server）
npm run typecheck  # tsc --noEmit（strict，0 错误）
```

---

## human-notify

人工介入通知：需要你回到终端时发送一条 Windows Toast——等审批/输入时（`ui_prompt_start`，标题“Pi 等待你确认”）、等人工具启动时（`tool_execution_start` 且工具名在 `WAITING_TOOL_NAMES` 名单，首批只有 `plan_mode_question`；宿主内置审批/提问不走 `ui_prompt_start`，只能按工具名特判）与 agent 完全结束时（`agent_settled`，标题“Pi 任务完成”）。正文按触发类型差异化：均带一句话摘要（审批/结束取最新 assistant 尾部文本，等人工具优先取 args 中的问题文本）；标题不变。用户按 Esc / Ctrl+C 中断回合后，其后的 `agent_settled` 不再发完成 Toast（人都走了不喊人回来看；照抄 goal 的取消标记模式，审批/等人工具 Toast 不受影响）。只在 Windows 生效，Linux / macOS 直接 no-op（后续支持）。

- **零依赖原生通道** — 内联 WinRT PowerShell（ToastNotificationManager + XmlDocument），`child_process.spawn` detached + unref 派生，不阻塞会话、不持有会话资源；发送失败静默吞掉，绝不破坏会话
- **文案安全** — 差异化文案：审批/输入→“收到确认请求，请回到终端处理：<assistant 尾部摘要>”；等人工具→args 中用户可读的问题文本（取不到回退 assistant 尾部，再取不到回退静态模板）；结束→“本轮结论：<assistant 尾部摘要>”。摘要先截到 80 码点、正文整体再截到 120 码点并压单行，不透传工具原始输出与密钥；全局 5s 防抖避免审批 + settle 连发刷屏
- **一键关闭** — `PI_HUMAN_NOTIFY=0` 关闭全部通知

```bash
node --experimental-strip-types --test human-notify/index.test.ts   # 37 个测试
```

---

## 开发约定

- **测试框架**：`node:test` + `node:assert/strict`，无 vitest/jest、无 mock 库（手写进程边界 fake）
- **代码风格**：`pwr/` 用 tab 缩进，`agent-team/`、`run-timer/`、`stream-token-speed/`、`loop/`、`goal/`、`opencode-bridge/` 用 2 空格；相对导入必须带 `.ts` 扩展名；类型导入用 `import type`（`verbatimModuleSyntax`）；错误用结果联合（`{ ok: true, value } | { ok: false, code, message }`），不用异常
- **注入约定**：时钟注入（`now` 参数）、依赖注入（deps 对象），保证测试确定性
- 无 linter、无 formatter、无构建步骤；`pwr/vendor/acorn.mjs` 为生成文件，勿修改
