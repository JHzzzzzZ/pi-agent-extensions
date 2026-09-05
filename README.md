# Pi Coding Agent 扩展集

本目录是 Pi 编码助手的扩展工作区：一个主项目 **PWR**（本地工作流编排）加五个独立卫星扩展（多 agent 团队、模型提供商、额度查询、流式计量、运行计时）。全部为**零构建 TypeScript ESM**，由 Node ≥ 22.18 原生 type-stripping 直接执行，运行时无 npm 依赖。

| 扩展 | 作用 | 测试 |
| --- | --- | --- |
| [`pwr/`](#pwr--pi-workflow-runtime-主项目) | 工作流编排：脚本引擎 + 子进程 runner + 批准/保存/UI | 355 个（node:test） |
| [`agent-team/`](#agent-team--多-agent-团队协作) | 可复用多 agent 团队：leader 调度成员协同完成任务 | 45 个 |
| [`stream-token-speed/`](#stream-token-speed) | 流式回复 TTFT / tokens/s 实时计量 | 43 个 |
| [`chatanywhere-provider/`](#chatanywhere-provider) | ChatAnywhere 模型提供商（OpenAI 兼容 + Anthropic API） | 无 |
| [`provider-quota/`](#provider-quota) | provider 账户额度/余额查询 | 无 |
| [`run-timer/`](#run-timer) | 任务/回合/会话耗时计时 | 单文件测试（同目录） |

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

本地工作流编排扩展（v2.2.0）。用户编写受约束的 ECMAScript 工作流脚本（白名单 API：`meta/args/agent/pipeline/parallel/sleep/JSON`），PWR 校验后弹出批准卡，再由子 `pi` 进程作为 subagent 执行。

### 功能

- **脚本引擎**（`engine/`）— acorn 解析 + 白名单校验（拒绝 `eval`/`vm`/反射/原型访问/动态代码）+ AST 解释器；单次快照安全边界，防宿主泄漏；脚本 ≤ 256KB、单运行 ≤ 1000 次 agent 调用、并发 ≤ 128
- **运行编排**（`runtime/` + `runner/`）— FIFO 调度、运行缓存（digest 命中直接回放）、child `pi` 进程适配器（结果 50KB / 摘要 8KB 截断、abort 时 SIGTERM → 5s 后 SIGKILL）；agent 定义发现（用户 > 项目 > 内置 scout/planner/reviewer/worker 兜底）
- **完整结果送达** — 最终 JSON ≤ 8KB 时全量内联进完成消息；**> 8KB 时完整 JSON 落盘 `~/.pi/agent/workflows/results/<runId>.json`**，消息携带 JSON 安全截断的预览（含 `"__pwr_truncated__": true` 标记）+ `完整结果: <路径>` 行，消息总预算 16KB；持久化会话条目同样 JSON 安全截断并带 `resultPath` 字段，可从会话文件恢复全量结果
- **结果回传** — 运行成功或失败后以 `pwr-workflow-result` 消息自动唤起主 agent 汇报；用户主动取消不打扰
- **批准记忆** — 批准键 = 项目 canonical path + 脚本 SHA-256 digest；脚本被编辑后必须重新批准
- **保存/复用**（`workflow_save` + `/workflow:<name> <JSON参数>`）— 自动补齐 meta、落盘前强制重新校验、参数 JSON-schema 校验（`meta.argsSchema`）；保存位置：用户范围 `~/.pi/agent/workflows/<name>.js`、项目范围 `.pi/workflows/<name>.js`（仅可信项目）
- **观察与控制**（`/workflows`）— 运行列表/详情/批准卡 UI，暂停/恢复/停止/重启，快捷键 `ctrl+alt+p/x/r`

### 命令

| 命令 | 作用 |
| --- | --- |
| `/workflow <任务>` | 生成工作流（也支持 `workflow:` 前缀） |
| `/workflow:<name> <args>` | 调用已保存的工作流（args 为合法 JSON） |
| `/workflow-delete <name>` | 删除已保存的工作流（项目范围优先） |
| `/workflows` | 运行列表/详情 UI |
| `/workflows:approve <runId>` | 手动为 `awaiting_approval` 的运行弹批准卡 |
| `/pwr-model [auto\|<model-id>]` | 查看/设置工作流默认模型（优先级：agent 定义 model > 脚本逐调用 model > PWR 默认 > 子 pi 默认） |
| `workflow_save` / `workflow_validate` / `workflow_start` / `workflow_control` | agent 可调用的工具 |

### 测试与开发

```bash
cd pwr
npm install        # 仅 devDependencies（typescript、pi-* 类型、typebox）
npm test           # 355 个单测（test/ + tests/ + runtime/test/ + runner/test/）
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

```bash
cd agent-team
npm install && npm test        # 45 个测试（含真实 git worktree 用例）
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

查询当前 provider 的账户额度/余额并在终端状态行显示。内置 OpenRouter、DeepSeek、ChatAnywhere、智谱 GLM 适配器；智谱原始 token 仅允许发往 HTTPS 白名单主机。每 5 分钟自动刷新（10s 超时 + 3 次重试退避），切换模型时立即刷新；手动刷新 `/quota`。API Key 从环境变量或 `~/.pi/agent/auth.json` 读取。

## run-timer

终端底部状态行计时：当前任务耗时、本轮对话耗时、会话总耗时（每秒 tick）。含 CJK 视觉宽度处理，避免中文导致布局错位。

```bash
node --experimental-strip-types --test run-timer/run-timer.test.ts
```

---

## 开发约定

- **测试框架**：`node:test` + `node:assert/strict`，无 vitest/jest、无 mock 库（手写进程边界 fake）
- **代码风格**：`pwr/` 用 tab 缩进，`run-timer/`、`stream-token-speed/` 用 2 空格；相对导入必须带 `.ts` 扩展名；类型导入用 `import type`（`verbatimModuleSyntax`）；错误用结果联合（`{ ok: true, value } | { ok: false, code, message }`），不用异常
- **注入约定**：时钟注入（`now` 参数）、依赖注入（deps 对象），保证测试确定性
- 无 linter、无 formatter、无构建步骤；`pwr/vendor/acorn.mjs` 为生成文件，勿修改
