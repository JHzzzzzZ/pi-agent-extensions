# Pi Coding Agent 扩展集

本目录是 Pi 编码助手的扩展工作区：一个主项目 **PWR**（本地工作流编排）加七个独立卫星扩展（多 agent 团队、模型提供商、额度查询、流式计量、运行计时、定时任务、会话目标循环）。全部为**零构建 TypeScript ESM**，由 Node ≥ 22.18 原生 type-stripping 直接执行，运行时无 npm 依赖。

| 扩展 | 作用 | 测试 |
| --- | --- | --- |
| [`pwr/`](#pwr--pi-workflow-runtime-主项目) | 工作流编排：脚本引擎 + 子进程 runner + 批准/保存/UI | 405 个（node:test） |
| [`agent-team/`](#agent-team--多-agent-团队协作) | 可复用多 agent 团队：leader 调度成员协同完成任务（含全屏会话记录查看器） | 85 个 |
| [`stream-token-speed/`](#stream-token-speed) | 流式回复 TTFT / tokens/s 实时计量 | 43 个 |
| [`chatanywhere-provider/`](#chatanywhere-provider) | ChatAnywhere 模型提供商（OpenAI 兼容 + Anthropic API） | 无 |
| [`provider-quota/`](#provider-quota) | provider 账户额度/余额查询 | 15 个（node:test） |
| [`run-timer/`](#run-timer) | 任务/回合/会话耗时计时 | 单文件测试（同目录） |
| [`loop/`](#loop) | /loop 定时任务：固定间隔 / 每天定时 / 每日窗口循环 + 一次性提醒 + --bg 后台 agent 模式 | 169 个（node:test） |
| [`goal/`](#goal) | 会话目标循环：`/goal` 设定条件，agent 跨回合自动推进直至评估器判定达成 | 39 个 |

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

---

## pwr — Pi Workflow Runtime（主项目）

本地工作流编排扩展（v2.4.0）。用户编写受约束的 ECMAScript 工作流脚本（白名单 API：`meta/args/agent/pipeline/parallel/sleep/JSON`），PWR 校验后弹出批准卡，再由子 `pi` 进程作为 subagent 执行。

### 功能

- **脚本引擎**（`engine/`）— acorn 解析 + 白名单校验（拒绝 `eval`/`vm`/反射/原型访问/动态代码）+ AST 解释器；单次快照安全边界，防宿主泄漏；脚本 ≤ 256KB、单运行 ≤ 1000 次 agent 调用、并发 ≤ 128
- **运行编排**（`runtime/` + `runner/`）— FIFO 调度、运行缓存（digest 命中直接回放）、child `pi` 进程适配器（结果 50KB / 摘要 8KB 截断、abort 时 SIGTERM → 5s 后 SIGKILL）；agent 定义发现（用户 > 项目 > 内置 scout/planner/reviewer/worker 兜底）
- **实时运行 trace**（v2.4.0）— 子 agent 的每一步（工具调用 + 参数摘要、长输出尾部、助手流式文本尾部约 1s 节流）实时显示在查看器对应 agent 行下方，tokens 随回合实时累计（单行截断、绝不透传原始工具输出）
- **完整结果送达** — 最终 JSON ≤ 8KB 时全量内联进完成消息；**> 8KB 时完整 JSON 落盘 `~/.pi/agent/workflows/results/<runId>.json`**，消息携带 JSON 安全截断的预览（含 `"__pwr_truncated__": true` 标记）+ `完整结果: <路径>` 行，消息总预算 16KB；持久化会话条目同样 JSON 安全截断并带 `resultPath` 字段，可从会话文件恢复全量结果
- **结果回传** — 运行成功或失败后以 `pwr-workflow-result` 消息自动唤起主 agent 汇报；用户主动取消不打扰
- **批准记忆** — 批准键 = 项目 canonical path + 脚本 SHA-256 digest；脚本被编辑后必须重新批准
- **保存/复用**（`workflow_save` + `/workflow:<name> <参数>`）— 自动补齐 meta、落盘前强制重新校验、参数 JSON-schema 校验（`meta.argsSchema`）；args 支持 **`key=value` 语法**（按 schema 自动转类型，重复键/逗号成数组，`{` 开头仍按 JSON 解析，v2.4.0）；保存位置：用户范围 `~/.pi/agent/workflows/<name>.js`、项目范围 `.pi/workflows/<name>.js`（仅可信项目）
- **观察与控制**（`/workflows`）— 运行列表/详情/批准卡 UI，暂停/恢复/停止/重启，快捷键 `ctrl+alt+p/x/r`；`/workflows:saved` 列出已保存工作流（scope/描述/参数提示），`/workflow-delete` 不带名称时同样先列出（v2.4.0）

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

- **对话式建团** — 主 agent 调 `team_create`/`team_list` 工具直接创建/查看团队；团队定义文件（`~/.pi/agent/teams/*.md` 或项目 `.pi/teams/*.md`）可随时手改，下一次派单即生效
- **派单与复用** — `/team:run <团队> <任务>`、`/team:<团队> <任务>` 或 `team_run` 工具；同一团队反复使用；`/team:stop` 中止
- **隔离与统计** — 成员可选 `worktree: true` 独立 git worktree（分支 `team/<runId>/<member>`，不自动合并）；按成员统计 token/费用；运行记录持久化为会话 entry
- **进度可视** — 运行期间 Widget 显示 leader/各成员实时状态（SIGTERM → SIGKILL 逐级中止）
- **会话记录查看器** — `/team:view` 全屏边框页（≈82% 终端高），每个 agent 一页连续会话流（任务气泡 + 主 agent 同款 Markdown 回复 + 合并工具行），run artifacts 落盘、run 结束后仍可查；主 agent 可用 `team_transcript` 工具转述记录要点

```bash
cd agent-team
npm install && npm test        # 85 个测试（含真实 git worktree 用例）
npm run typecheck
```

详见 [`agent-team/README.md`](agent-team/README.md)（团队文件格式与示例见 `agent-team/examples/dev-team.example.md`）。

---

## stream-token-speed

流式回复速度计量：显示 **TTFT（首 token 延迟）** 与瞬时 **tokens/s**（1s 滑动窗口 + EMA 平滑，250ms 节流），结束后保留本轮 TTFT / 最后瞬时值 / 平均速度。计量范围覆盖 text / thinking / tool call 增量；tool result 与工具执行进度一律排除。不读取、不记录、不发送任何消息内容。

```bash
cd stream-token-speed
node --experimental-strip-types --test test/*.test.ts   # 43 个测试
node e2e/run-e2e.mjs                                    # 真实 pi 进程端到端自测
```

## chatanywhere-provider

通过 [ChatAnywhere](https://docs.chatanywhere.tech) 的 OpenAI 兼容 API 与 Anthropic Messages API 接入模型：GPT-5.6/5.x/4.x 系列（含 CA 渠道）、DeepSeek、Qwen、Kimi、GLM、Claude、MiniMax、Gemini 等，内置模型 ID 去重与按 CA 币/1K 的定价（换算为 Pi 成本跟踪）。

```bash
# 设置 API Key（或 ~/.pi/agent/auth.json）
export CHATANYWHERE_API_KEY=sk-xxx
export CHATANYWHERE_BASE_URL=https://api.chatanywhere.tech/v1   # 可选
```

## provider-quota

查询当前 provider 的账户额度/余额并在终端状态行显示。内置 OpenRouter、DeepSeek、ChatAnywhere、智谱 GLM 适配器；智谱原始 token 仅允许发往 HTTPS 白名单主机。智谱状态行附带 5 小时窗口的下次刷新时间（`GLM tok X% mcp Y% → HH:mm (Xh Ym)`，跨日显示 `MM-dd HH:mm`，字段以实测 `nextResetTime` 为准）。每 5 分钟自动刷新（10s 超时 + 3 次重试退避），切换模型时立即刷新；手动刷新 `/quota`。API Key 从环境变量或 `~/.pi/agent/auth.json` 读取。

```bash
node --experimental-strip-types --test provider-quota/index.test.ts
```

## run-timer

终端底部状态行计时：当前任务耗时、本轮对话耗时、会话总耗时（每秒 tick）。含 CJK 视觉宽度处理，避免中文导致布局错位。

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
- 手动中断（Esc）自动暂停；评估器连续 3 次失败暂停（瞬时失败不杀循环）；状态行 `◎ goal: …`

```bash
node --experimental-strip-types --test goal/index.test.ts   # 39 个测试
```

---

## 开发约定

- **测试框架**：`node:test` + `node:assert/strict`，无 vitest/jest、无 mock 库（手写进程边界 fake）
- **代码风格**：`pwr/` 用 tab 缩进，`agent-team/`、`run-timer/`、`stream-token-speed/`、`loop/`、`goal/` 用 2 空格；相对导入必须带 `.ts` 扩展名；类型导入用 `import type`（`verbatimModuleSyntax`）；错误用结果联合（`{ ok: true, value } | { ok: false, code, message }`），不用异常
- **注入约定**：时钟注入（`now` 参数）、依赖注入（deps 对象），保证测试确定性
- 无 linter、无 formatter、无构建步骤；`pwr/vendor/acorn.mjs` 为生成文件，勿修改
