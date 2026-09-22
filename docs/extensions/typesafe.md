# typesafe — TypeSafe/Jev 接入（登录 + 调用通道）

> last verified @ 48d4392

## 职责与边界

把 TypeSafe 的 **Jev（System One）** 接进 Pi，只做两件事：① 提供一个**遮罩输入**的登录入口，把 API key 落到 `~/.pi/agent/auth.json`；② 提供一个调用通道（`typesafe_ask` 工具 + `cli.ts`），让 agent 与脚本能拿 key 做判断而**看不到 key**。

Jev 不是聊天模型（不吃会话上下文、不生成文本，只返回带概率的类型化答案），所以本扩展**不注册任何聊天模型**、不进 `/model` 选择面。**不做**：具体业务接入（goal 评估器 / human-notify 降噪 / todo 打分 / agent-team 派单）、key 轮换、多账户、额度查询、questions 的 schema 校验。上游指导 skill 在仓库外（`~/.agents/skills/typesafe-ai/`，逐字节复制、sha256 锁定），本扩展不依赖也不修改它。

## 文件地图

- `index.ts` — 扩展入口：`registerProvider(createProvider({...}))` + `registerTool("typesafe_ask")` + `formatAnswers`。
- `client.ts` — **唯一调用 core**：`buildRequestBody` / `parseAskResponse` / `askTypesafe` / `ErrorCodes` / `resolveBaseUrl`。零运行时依赖（只用全局 fetch），保持 `node --test` 直跑。
- `credential.ts` — **唯一取 key 口**：`authFilePath` / `readAuthJson` / `resolveTypeSafeKey` / `resolveKeyFromDisk`。零运行时依赖。
- `cli.ts` — bash / 子 agent 通道，与工具共用 `client.ts`；`runCli(deps)` 可注入 argv/env/readFile/stdout 以便测试，直接执行时走 main 检测。
- `test/` — `credential` / `client` / `parity` / `sentinel` / `index` 五个文件，33 个用例。

## 核心数据流

1. **登录**：`/login typesafe` → Pi 的 `getLoginProviderOptions()` 扫到本 provider 的 `auth.apiKey` → 走 `auth.apiKey.login(interaction)` → `interaction.prompt({type:"secret"})` 遮罩采集 → Pi 自己把 `{type:"api_key", key}` 写进 `auth.json` 的 `typesafe` 条目（`dist/core/auth-storage.js`，路径 `join(getAgentDir(), "auth.json")`）。
2. **调用**：工具或 CLI → `askTypesafe({state, questions, model, baseUrl, resolveKey})` → `resolveKeyFromDisk()`（`TYPESAFE_API_KEY` → `auth.json`）→ 无 key 立即 `NO_KEY` **且不发请求** → `POST {baseUrl}/v1/systemone` → `parseAskResponse` → 工具渲染紧凑文本（`formatAnswers`）、CLI 输出 answers JSON。

## 不变量

- **登录菜单的可见性依赖 `auth.apiKey` 存在，与模型数量无关**：`getLoginProviderOptions()` 只判 `provider.auth.apiKey` / `provider.auth.oauth`（`pi-coding-agent` 的 `dist/modes/interactive/interactive-mode.js`，函数体内无 `models` 判断），所以 `models: []` 也能出现在 `/login` 里。这是「不注册假模型也能有登录界面」的全部依据——**升级 Pi 后若菜单里看不到 typesafe，先回查这个函数**。
- **明文 key 零暴露**（对齐文档范围 4）：key 只在 `credential.ts` → `client.ts` 拼 `Authorization` 头之间短暂存在；错误消息一律静态模板 + HTTP 状态码，**不插值响应体/请求头/底层异常文本**；没有 `--key` / `--show-key` / `--verbose-headers` 之类的开关。`test/sentinel.test.ts` 用哨兵 key 扫成功路径 + 三种失败路径的全部可见产物，并反向断言「请求确实带了哨兵」（否则测试空转）。
- **两条路径同源**：工具与 CLI 都只调 `askTypesafe()`，`test/parity.test.ts` 用真实 `node:http` server + 真实 `cli.ts` 子进程断言**请求体字节级一致**、答案结构一致。改任一条路径都必须让这条测试继续绿。
- **key 解析优先级**：`TYPESAFE_API_KEY` → `auth.json` 的 `typesafe` 条目；读文件/坏 JSON/空串一律 `undefined`（fail-closed，不抛异常）。`authFilePath()` 跟随 `PI_CODING_AGENT_DIR`（与 Pi `getAgentDir()` 同口径），且**在调用时求值**（不缓存），所以测试与 install-smoke 的临时配置目录能生效。
- **provider 的 `resolve` 与工具的取 key 是两条独立实现**（前者用宿主给的 `credential` + `ctx.env`，后者读文件），优先级规则必须一致：改一处要改另一处。
- `models: []` + 抛错的 `api` stub：谁把 typesafe 当聊天模型用就得到明确错误，不会静默发往兼容端点。

## 已知坑

- `index.ts` 的 `execute` 里 `details` 必须**先声明为 `TypeSafeResult<TypeSafeAskResult>` 再在两个分支复用**：直接写 `details: result` 会让 TS 按首个 return 分支推断泛型，成功分支被判不兼容（typecheck 实测踩过）。
- 本扩展有 `node_modules`（`@earendil-works/pi-ai` 的 `createProvider`、`typebox` 的 `Type` 都是**运行时** import，与 agent-team 同形态），所以 `test-all.mjs` 的套件要 `install: true`；`credential.ts` / `client.ts` 刻意不引任何外部包，保持纯 node 直跑（改它们时别顺手加 import）。
- `parity.test.ts` / `sentinel.test.ts` 通过改 `process.env` 再调 handler 来指向 fake server；`TYPESAFE_BASE_URL` 因此是**读调用时环境变量**的（`resolveBaseUrl(env)`），不要在模块顶层缓存成常量。
- 「无 key」用例必须同时把 `PI_CODING_AGENT_DIR` 指向空目录：否则开发机上真实 `auth.json` 里的 typesafe 条目会让前提失效。
- 真机验收（`/login typesafe` 出现在菜单、遮罩输入、落盘格式）不可脚本化，是人工项；自动化只覆盖到 provider 形状与 `login`/`resolve` 的行为。

## 改动清单

- 必跑：`cd src/extensions/typesafe && npm install && npm test && npm run typecheck`（33 个用例）；仓库级 `npm run test:all`（本套件已登记）。
- 改鉴权/登录：`index.ts` 的 provider 段 + `test/index.test.ts`；改取 key 规则：`credential.ts` + `test/credential.test.ts`（注意与 provider `resolve` 的优先级一致）。
- 改请求/解析/错误码：`client.ts` + `test/client.test.ts` + `docs/cross/result-unions.md`（若新增错误码层）。
- 新增扩展触点：根 `package.json` 的 `pi.extensions`、`tools/install-smoke.mjs` 期望表、`tools/test-all.mjs` 套件表、`docs/INDEX.md`、根 `README.md`（扩展数与测试数）、`AGENTS.md`。
