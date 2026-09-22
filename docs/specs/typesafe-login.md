# typesafe 扩展：`/login typesafe` 遮罩录入 key + 调用通道 — 规格

> 来源：todos/typesafe-todo#1（对齐文档 `todos/align/typesafe-todo#1.md`，2026-09-22 人工确认）。

## 问题陈述

TypeSafe（Jev，System One 模型）提供结构化判断能力（`choice` / `score` / `noul`），但它**不是聊天模型**，无法替换 Pi 的会话模型；正确用法是「一次调用换一个带概率的类型化答案」。本机已按 `skills-todo#13` 装好官方指导 skill（`~/.agents/skills/typesafe-ai/`，仓库外），但**没有任何地方保存 TypeSafe 的 API key**：要调 `POST https://api.typesafe.ai/v1/systemone` 只能把 key 贴进会话或写进环境变量——明文进上下文、每次重贴、后续会话与子 agent 无法复用。

用户要求（原话）：「添加一个 typesafe 的 login 界面，让我支持在里面新增 apikey，然后你之后调用的时候默认取已经保存的 apikey」，并追加硬约束：**「你不能主动读取 apikey，你需要用其他方法获取」**。

## 方案

### 登录界面：注册 provider，走 Pi 原生 `/login`

Pi 的 `/login` 菜单由 `getLoginProviderOptions()` 构建，**只按 `provider.auth.apiKey` / `provider.auth.oauth` 是否存在过滤，不与模型数量挂钩**（源码证据：`pi-coding-agent` 的 `dist/modes/interactive/interactive-mode.js` 第 4692-4726 行——`if ((!authType || authType === "api_key") && provider.auth.apiKey) options.push(...)`，函数体内无 `models` 相关判断）。因此**零模型 provider 也会出现在菜单里**，这是本方案成立的关键前提（对齐文档里标为「待实测风险」的一项，已由源码定位解除，真机探针仍作为验收项保留）。

登录落盘位置与形状由 Pi 自身负责：`dist/core/auth-storage.js` 是「CredentialStore implementation backed by auth.json」，路径 `join(getAgentDir(), "auth.json")`，条目形状即 `ApiKeyCredential = { type: "api_key", key?, env? }`——与本机现有 6 条凭据（`zai-coding-cn` / `deepseek` / `chatanywhere` / `chatanywhere-claude` / `opencode-go` / `kimi-coding`）完全同格式。

采集用 `interaction.prompt({ type: "secret", ... })`：这是 Pi 提供的**遮罩**输入通道（`AuthPrompt` 联合里的 `secret` 分支），自建 `ctx.ui.input()` 只有明文回显，故不采用自建命令方案。

### 调用通道：工具 + CLI 共用同一 core

```
                  ┌─── src/extensions/typesafe/index.ts ──→ pi.registerTool("typesafe_ask")
调用方 ───────────┤                                          │
                  └─── src/extensions/typesafe/cli.ts ──────→ node cli.ts …（bash / 子 agent）
                                                             │
                                            src/extensions/typesafe/client.ts（唯一 core）
                                                             │
                                            src/extensions/typesafe/credential.ts（唯一取 key 口）
```

两条路径调用同一个 `askTypesafe()`，因此请求体、错误码、答案结构天然一致（有测试断言字节级一致）。

### key 的获取与「零暴露面」不变量

解析优先级：`TYPESAFE_API_KEY`（环境变量）→ `~/.pi/agent/auth.json` 的 `typesafe` 条目（形状参照既有 `chatanywhere-provider/auth.ts`，读取失败一律 `undefined`，fail-closed）。

不变量（写进代码注释 + docs 卡）：

1. 明文 key 只在 `credential.ts` 内部短暂存在，用于拼 `Authorization` 头；**不进入任何返回值、工具结果、CLI 输出、日志、错误消息**。
2. 错误消息一律静态模板（仓库既有约定），不插值响应体、不插值请求头、不插值 key。
3. **不提供** `--key` / `--show-key` / `--verbose-headers` 或任何打印凭据的参数与开关。
4. Agent 侧的调用方式固定为「工具或 CLI」，不需要（也不应该）执行 `cat auth.json` 一类动作。

## 用户故事

- 用户在 pi 里执行 `/login typesafe`，从菜单选中 TypeSafe，在弹出的遮罩输入里粘贴 key；此后该 key 常驻 `~/.pi/agent/auth.json`，重启会话仍在。
- 用户在会话里让 agent 做一次判断，agent 调用 `typesafe_ask` 工具，拿回 `answers.<id>` 的 `choice` / `score` / `noul` 与 `probabilities` / `confidence`；用户在会话记录里**看不到 key**。
- 用户在 bash 或子 agent 里用 `node src/extensions/typesafe/cli.ts --state-file ticket.txt --questions questions.json` 得到同一结构，key 同样不出现在 stdout。
- 没登录 / key 失效时得到明确且不含密钥的错误码（`TYPESAFE_NO_KEY` / `TYPESAFE_HTTP` …）。

## 实现决策

1. **新扩展目录** `src/extensions/typesafe/`（无构建、Node ≥22.18 直跑）：
   - `credential.ts` —— `AUTH_FILE`、`apiKeyFromAuth(authJson, ids)`、`readAuthJson(file, readFn)`、`resolveTypeSafeKey(envKey, authJson)`；读文件/解析失败返回 `undefined`（注入 `file`/`readFn` 以便测试跨进程边界用临时文件）。
   - `client.ts` —— **纯 core**：`buildRequestBody({state, questions, model})`、`parseAnswers(body)`、错误码常量 `ErrorCodes`（`as const` + 判别联合 `{ok:true,value}|{ok:false,code,message}`，对齐仓库约定）、`askTypesafe({state, questions, model, baseUrl, resolveKey, fetchFn, timeoutMs})`。`DEFAULT_BASE_URL = "https://api.typesafe.ai"`、`ASK_PATH = "/v1/systemone"`、`DEFAULT_MODEL = "jev-latest"`、`DEFAULT_TIMEOUT_MS = 30_000`。
   - `index.ts` —— `createProvider({ id:"typesafe", name:"TypeSafe", baseUrl, auth:{ apiKey:{ name:"TypeSafe API key", login, resolve } }, models: [], api: <fail-closed stub> })` + `pi.registerProvider(...)`；`pi.registerTool("typesafe_ask", …)`（TypeBox schema：`state` string、`questions` object、`model` optional string）。
   - `cli.ts` —— `util.parseArgs`；`--state|--state-file`、`--questions|--questions-file`、`--model`；stdout 只输出 answers JSON。
   - `package.json`（devDependencies：`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` / `typebox` / `typescript` / `@types/node`）、`README.md`。
   - 就地测试。
2. **provider 的 `auth.apiKey`**：
   - `login` → `interaction.prompt({ type:"secret", message:"TypeSafe API key" })` → `{ type:"api_key", key: trimmed }`（空串即拒绝，不落盘空凭据）。
   - `resolve` → `credential?.key ?? await ctx.env("TYPESAFE_API_KEY")`；都缺返回 `undefined`（`Models.getAuth()` 据此判定未配置，`/logout` 与状态显示才成立）。
   - `models: []` + 抛错型 `api` stub：TypeSafe 没有聊天模型，若有人误把 typesafe 当模型用，得到明确的类型化错误而不是静默发往 OpenAI 兼容端点。
3. **工具与 CLI 都只经 `askTypesafe()`**，key 经 `resolveTypeSafeKey(process.env.TYPESAFE_API_KEY, readAuthJson())` 取得；请求头 `Authorization: Bearer <key>` 在 `client.ts` 拼装后立即交给 `fetch`，不进入结果对象。
4. **错误码**（`client.ts` 的 `ErrorCodes`）：`NO_KEY` / `HTTP` / `TIMEOUT` / `NETWORK` / `BAD_RESPONSE` / `BAD_ARGS`；消息为静态模板 + HTTP 状态码数字（不含响应体、不含请求头）。
5. **仓库接线（红线 7）**：根 `package.json`（`pi.extensions` 增 `./src/extensions/typesafe/index.ts` + `version` bump）、`tools/install-smoke.mjs` 的 `EXTENSION_EXPECTATIONS`、`tools/test-all.mjs` 套件表（`install: true`，因为它有 `node_modules`）、`docs/extensions/typesafe.md` 新卡 + `docs/INDEX.md` 路由与一览、根 `README.md`（扩展数 13→14、测试数）、`AGENTS.md`（插件目录数与其表述）。
6. 不新增运行时依赖给**其它**扩展；本扩展的依赖只落在自己的 `package.json` 里（与 `agent-team` 同形态）。

## 测试决策

沿用仓库口径（`docs/cross/deps-ports.md`：纯逻辑不 fake，进程/IO 边界用真实现 + 手写替身）：

1. `credential.test.ts` —— 纯逻辑 + 临时文件跨进程边界：env 优先、auth.json 命中、结构损坏 / 缺 key / 空串一律 `undefined`、其它 provider 条目不受影响（用临时 `HOME` 或注入 `file`/`readFn`）。
2. `client.test.ts` —— `parseAnswers` 三原语（choice/score/noul，含 `probabilities`/`confidence`/`legend`）、缺字段与错形状落 `BAD_RESPONSE`、HTTP 4xx/5xx 落 `HTTP` 且消息不含响应体、超时落 `TIMEOUT`（假 `fetchFn` 抛 `AbortError`）、无 key 落 `NO_KEY`（此时**不发出请求**，断言 fetch 未被调用）。
3. `parity.test.ts` —— **真实 HTTP 边界**：起一个 `node:http` fake server 记录每个请求的原始 body 与头。
   - 路径 1：进程内调用工具处理函数（`askTypesafe` + 注入 deps）。
   - 路径 2：`spawn` 真实 `node cli.ts …` 子进程，`TYPESAFE_BASE_URL` 指向同一 fake server。
   - 断言：两次请求体**字节级一致**、`Authorization` 头都用哨兵 key、两条路径的 stdout 答案结构一致。
4. `sentinel.test.ts` —— 用哨兵 key `sk-typesafe-SENTINEL-0000-DO-NOT-LEAK` 跑完整链路（含强制失败分支：HTTP 500 / 超时 / BAD_RESPONSE），断言工具结果、CLI stdout+stderr、错误消息、假 server 记录之外的中间产物中**都不出现该串**。
5. `index.test.ts` —— provider 注册与工具注册的形状（`auth.apiKey.name` 存在、`models` 为空、工具 schema 必填项），用 `import type` + 手工 fake `ExtensionAPI` 记录调用；不启动真实 pi。
6. 真机探针（人工/半自动）：临时 `PI_CODING_AGENT_DIR` + 真实 pi，确认 `/login typesafe` 出现在菜单。作为验收项，不作为自动化测试（交互 TUI 不可脚本化）。

## 范围外

- 不改 `~/.agents/skills/typesafe-ai/`（上游逐字节复制、sha256 锁定），不在仓库留其副本。
- 不注册可聊天模型、不让 TypeSafe 进 `/model` 选择面。
- 不做具体 Jev 接入（`goal` 评估器 / `human-notify` 降噪 / `todo` 打分 / `agent-team` 派单）。
- 不做 key 轮换、多账户、额度查询、`/logout` 之外的凭据管理。
- 不做 `questions` 的 schema 校验与自动补全（把结构化提问设计的责任留给调用方与 skill 指导）。
