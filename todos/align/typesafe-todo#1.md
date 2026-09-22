# typesafe-todo#1 新增 typesafe 扩展：`/login typesafe` 遮罩录入 key + 调用通道（agent 永不读到明文 key）

## 意图

TypeSafe（Jev，System One 模型）**不是聊天模型**：它不吃会话上下文、不生成文本，只接受 `state` + 一组类型化问题，返回带概率的结构化答案（`choice` / `score` / `noul`）。所以它无法替换 Pi 的会话模型，正确用法是「代码或 agent 调用它做一次判断」。官方指导已按 `skills-todo#13` 装到仓库外的 `~/.agents/skills/typesafe-ai/`（上游逐字节复制、sha256 锁定），但**本机没有任何地方保存 TypeSafe 的 API key**。

现状的痛点是具体的：要调 `https://api.typesafe.ai/v1/systemone` 只能把 key 贴进会话或写进环境变量——明文进上下文、每次重贴、无法被后续会话或子 agent 复用。

用户的原始要求（本会话原话）：「帮我添加一个 typesafe 的 login 界面，让我支持在里面新增 apikey，然后你之后调用的时候默认取已经保存的 apikey」，并追加硬约束：**「你不能主动读取 apikey，你需要用其他方法获取」**。

关键事实（2026-09-22 本会话实测）：

- Pi 原生 `/login` 是唯一提供**遮罩 secret 输入**的登录界面：provider 声明 `auth.apiKey.login(interaction)` 后，`interaction.prompt({ type: "secret" })` 负责遮罩采集；自建 `ctx.ui.input()` 只支持明文回显（`docs/extensions.md` 的 Dialogs 一节），不适合录 key。
- `auth.json` 现有 6 条凭据形状实测为 `{"type":"api_key","key":"…"}`（`zai-coding-cn` / `deepseek` / `chatanywhere` / `chatanywhere-claude` / `opencode-go` / `kimi-coding`）；pi-ai 的 `Credential = ApiKeyCredential | OAuthCredential`，`ApiKeyCredential` 即 `{type:"api_key", key?, env?}`，注释明写「one credential per provider — the shape of today's auth.json」——即 provider 登录落盘与现有条目**同格式同位置**。
- 自定义 provider 的两种注册形态：legacy 配置对象（`pi.registerProvider(id, {...})`，只支持 `oauth` 进登录菜单）与原生 `createProvider({ auth, models, api })`（支持 `auth.apiKey`）。本需求要的是 **api key** 通道，故走原生形态。
- 仓库已有「扩展内部读 auth.json、key 不进上下文」的先例：`src/extensions/provider-quota/index.ts`（`AUTH_FILE` 按 provider id 读）与 `src/extensions/chatanywhere-provider/auth.ts`（`resolveApiKey`：环境变量 → auth.json，失败返回 `undefined`）。本条沿用同一形状。
- 仓库既有扩展可 import `@earendil-works/pi-ai`（`src/extensions/agent-team/manage.ts` 已 import `StringEnum`），且各扩展用各自 `package.json` 声明 devDependencies（`agent-team` / `pwr` / `loop` / `deep-init` 等 7 个目录有 `package.json`；`run-timer` / `provider-quota` 无依赖故无）。
- 新增扩展的仓库触点已定位：根 `package.json` 的 `pi.extensions`、`tools/install-smoke.mjs` 的期望表、`tools/test-all.mjs` 的套件表、`docs/INDEX.md` + 新卡 `docs/extensions/typesafe.md`、根 `README.md`（扩展数 13→14、测试数）、`AGENTS.md`（13 个插件目录的四处表述）。

## 范围

**做什么**

1. 新建扩展目录 `src/extensions/typesafe/`：
   - `index.ts` —— 注册 provider `typesafe` 与工具 `typesafe_ask`（TypeBox schema，仓库既有形态）
   - `client.ts` —— 纯核心：构造 `/v1/systemone` 请求体、发起 fetch、解析答案、错误码常量（`as const` 对象 + 判别联合结果，对齐仓库约定）
   - `credential.ts` —— key 解析（`TYPESAFE_API_KEY` 环境变量 → `~/.pi/agent/auth.json` 的 `typesafe` 条目），形状参照 `chatanywhere-provider/auth.ts`；**只有 resolve，没有任何打印/返回给上层的出口**
   - `cli.ts` —— 命令行入口，复用同一 core
   - `package.json`（声明 `@earendil-works/pi-ai` 等 devDependencies）、`README.md`
   - 就地测试
2. **provider 注册（登录界面）**：`createProvider({ id: "typesafe", name: "TypeSafe", baseUrl: "https://api.typesafe.ai", auth: { apiKey: { name: "TypeSafe API key", login(interaction) { return { type: "api_key", key: await interaction.prompt({ type: "secret", message: "TypeSafe API key" }) } }, resolve({ credential }) { … } } }, models: [], api: … })`。
   - 目标：`/login typesafe` 出现在登录菜单，遮罩输入，落盘 `auth.json` 的 `typesafe` 条目。
   - **风险与处置**：零模型 provider 是否出现在 `/login` 菜单**未经验证**。实现第一步先做一次性真实探针（临时 `PI_CODING_AGENT_DIR` + 真实 pi，沿用 `tools/install-smoke.mjs` 的临时配置目录套路）。若菜单里没有它，**停止实现、带实测证据回来让用户选退路**（候选：注册一个占位模型会污染 `/model`；自建 `/typesafe:login` 命令需要自绘遮罩输入组件——两个都比原方案差，不擅自选）。
3. **调用通道（C 方案 = 工具 + CLI 共用 core）**：
   - 工具 `typesafe_ask`：入参 `{ state, questions, model? }`，出参 Jev 答案（`answers.<id>` 的 `type` / `choice` / `score` / `noul` / `probabilities` / `confidence`）。
   - CLI：`node src/extensions/typesafe/cli.ts --state-file <path> --questions <json|path>`，stdout 输出 answers JSON，供 bash / 子 agent / 团队使用。
   - 两条路径**必须共用 `client.ts`**：测试断言同一输入下两条路径生成的请求体字节级一致。
4. **硬不变量：明文 key 零暴露面**。具体做法（写进代码注释与 docs 卡）：
   - key 只在 `credential.ts` 内部短暂存在，用于拼 `Authorization` 头，不进入任何返回值、日志、错误消息；
   - 错误消息为静态模板（仓库既有约定），不插值响应体、不插值请求头；
   - 不提供 `--key` / `--show-key` / `--verbose-headers` / 任何打印凭据的参数或开关；
   - 工具与 CLI 的 stdout/stderr 只有 answers 与静态错误码。
5. **仓库接线（红线 7）**：根 `package.json`（`pi.extensions` 增行 + `version` bump）、`tools/install-smoke.mjs` 期望表、`tools/test-all.mjs` 套件表、`docs/extensions/typesafe.md` 新卡 + `docs/INDEX.md` 路由、根 `README.md`（扩展数 13→14 与测试数）、`AGENTS.md`（插件目录数与其清单表述）。
6. **测试**：
   - 纯逻辑单测：questions 构造、响应解析（三原语）、key 解析（env → auth.json、结构损坏 fail-closed）、错误码分支；
   - **跨真实 HTTP 边界**：本地 `node:http` fake server 走真实 socket（不是 mock fetch），断言请求路径 / 方法 / `Authorization` 头 / 请求体；工具与 CLI 两条路径都打这个 server；
   - 哨兵扫描测试：用 `sk-typesafe-SENTINEL-…` 当 key，断言工具结果、CLI 输出、日志、错误消息、测试快照中都不出现该串。

**不做什么**

- **不改 `~/.agents/skills/typesafe-ai/`**（上游逐字节复制、sha256 `0ab58b…0203d` 锁定，见 `skills-todo#13`）；也不把该 skill 复制进仓库。CLI 与 skill 是并列的两件事，本变更不建立二者的耦合。
- **不把 TypeSafe 当会话模型**：不注册可聊天模型、不让它进 `/model` 的选择面。若 `/login` 可见性必须靠占位模型才能达成，先回来问用户。
- **不做具体 Jev 接入**：`goal` 评估器 / `human-notify` 降噪 / `todo` 打分 / `agent-team` 派单四条候选全部另开条目。
- **不新增运行时依赖**：只用 node 内置模块 + `@earendil-works/pi-ai` 的类型与 `createProvider`。
- **不写 `~/.pi/agent/auth.json` 以外任何配置**：不建 env 文件、不写 `settings.json`、不碰 TUI 主题与状态条。
- **不实现 key 轮换 / 多账户 / 额度查询**：`typesafe` 一条凭据、一个账号。

## 验收标准

1. **登录界面可用**：`/login typesafe` 出现在登录菜单且输入为遮罩；确认后 `~/.pi/agent/auth.json` 出现 `typesafe: {"type":"api_key","key":"…"}`（与现有 6 条同格式）。零模型 provider 若不出现在菜单，**以实测证据停止并回报**，不退化为明文输入。
2. **工具可用**：`typesafe_ask` 在 pi 会话中注册并可调用；对给定 state+questions 返回 `answers.<id>` 的结构化答案（三原语各自的字段齐全）。
3. **两通道同源**：CLI 与工具共用 `client.ts`，同一输入下请求体字节级一致（测试断言）。
4. **明文 key 零暴露**：哨兵 key 不出现在工具结果、CLI stdout/stderr、错误消息、日志与测试快照中（自动化哨兵测试）。
5. **测试与类型**：`node --test src/extensions/typesafe/*.test.ts` 全绿；扩展 `npm run typecheck` 零错误；`npm run test:all` 纳入 `typesafe` 套件并通过；`node tools/install-smoke.mjs` 认到 **14** 个扩展。
6. **台账一致**：`node .agents/skills/todo-cli/todo-cli/todo.mjs lint` 通过（插件目录 ↔ `todos/typesafe-todo.json` ↔ 根 `pi.extensions` 一一对应）。
7. **文档同步**：`docs/extensions/typesafe.md` 建卡（含头部 `last verified @ <commit>`）并在 `docs/INDEX.md` 登记；根 `README.md` 的扩展数与测试数更新为实测值；`AGENTS.md` 的插件目录清单更新。
8. **真机端到端（需用户配合）**：用户本人执行 `/login typesafe` 录入真实 key 后，agent 触发一次真实调用并返回 Jev 答案；全程 agent 未读取明文 key。此条由用户人工判定。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-22
- 方式：本会话逐条问答，共 3 个决策点——
  - **Q1 界面落点**：用户选 **A（Pi 原生 `/login` + 新扩展注册 provider）**，否决 agent-manager 浏览器面板（key 会落在 agent-manager 自己的 `config.json`，pi 侧需额外接线）与自建命令（明文输入）。
  - **Q2 调用通道**：用户答 **`1C`** = 工具 + CLI **共用同一个 core**。
  - **Q3 范围**：用户答 **`2是`** = 这一轮只做「key 录入 + 调用通道」，不碰具体 Jev 接入。
  - **Q4 用户主动追加的硬约束**（原话）：「**你不能主动读取 apikey，你需要用其他方法获取，自己 export 或者搞一个 skill 脚本之类的**」→ 落为本条的范围 4 + 验收标准 4（key 只在 `credential.ts` 内部解析，无任何打印出口；agent 不执行 `cat auth.json` 之类动作）。
- 已知待议项（不阻塞开工，但触发即回报）：零模型 provider 的 `/login` 可见性未实测（范围 2 的风险与处置）；真机验收依赖用户本人录入 key（验收标准 8）。
