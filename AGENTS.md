# 仓库开发指南
<!-- PROJECT KNOWLEDGE BASE / Generated: 2026-09-09T03:50:04Z / Commit: 457adcf / Branch: dev-laptop / Mode: update / MaxDepth: 3 -->

> **愿景准绳：[GOAL.md](GOAL.md)**——把派 Agent 建成最好用的 Agent 框架（插件形态，给自己也给别人用；尺子/差异化/里程碑见 GOAL.md）。每个任务收尾时回答 GOAL.md §5 自检问题（这次离愿景更近了什么），并用 wrap-up skill 走收尾门。

## 项目概览

Pi 编码助手的扩展工作区（文档/注释为中文，代码为英文）。主项目 `pwr/`（Pi Workflow Runtime，本地工作流编排）加 13 个独立卫星扩展（多 agent 团队、模型提供商、额度查询、流式计量、运行计时、定时任务、会话目标循环、本地代理桥、深度初始化、人工介入通知、免审批模式、todos 工作流工具、会话管理器）。全部为**零构建 TypeScript ESM**，由 Node ≥ 22.18 原生 type-stripping 直接执行，运行时无 npm 依赖。

每个扩展的职责边界、文件地图、数据流、不变量与已知坑：见 [`docs/INDEX.md`](docs/INDEX.md) 路由到的卡片与各扩展 README。安装/加载：复制到 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（受信任项目），Pi 中执行 `/reload` 生效。

## 规则红线（强制）

以下规则无例外；与其他考量冲突时以本节为准。

1. **仓库边界**——默认只改本仓库内文件。宿主 npm 全局安装（`@earendil-works/pi-coding-agent` / `pi-tui` 的 `dist/`、`bundle/chunks/` 等）、其它全局包、用户配置（`~/.pi/agent/`）、系统文件一律不动。宿主/依赖行为不满足需求只有两条路：① 插件侧用公开扩展 API 解决；② 向上游提 issue/PR（或请用户人工处理）。确需动仓库外文件：先说明「改哪个文件、为什么、风险、回滚方式」，取得用户对具体改动的逐次明确同意，改完在交付报告中登记（文件、备份、回滚）；仓库内文档/待办不得把「已应用宿主补丁」当作插件行为的前提或契约；违反本规则的历史改动一律还原并在 `todos/` 记录真实状态。
2. **需求先登记 `todos/`**——动手实现前按路由登记到唯一落点（skill `todo-add`）：现有插件 → `todos/<插件名>-todo.md`；未实现的特定插件 → 新建 `todos/<插件名>-todo.md`；通用领域功能或涉及多个插件的需求 → `todos/general-todo.md`。已有匹配条目直接领取，没有则末尾追加 `- [ ] <需求描述>`；领取/新建后立即标注 `（processing）`，完成前保持该状态；完成（代码 + 文档同步）后改 `- [x]` 并去标注；取消/搁置的注明原因后还原或删除——`todos/` 始终反映真实状态。
3. **一律 worktree 实现**——从主干（`dev-laptop`）开 `.worktrees/<短名>`：`git worktree add .worktrees/<短名> -b feat/<插件名>-<事项> dev-laptop`；主干工作区只做评审、只读命令与 `todos/` 登记。自测达标（全量测试绿 + `npm run typecheck` 零错误）后才回主干 `git merge --no-ff`（冲突就地解决不绕行），合完确认主干正常即 `git worktree remove`。
4. **命令必须显式超时**——每次执行命令都传 bash 工具的 `timeout` 参数：快速 shell 操作（ls/grep/git）30–60 秒，`npm test`/`npm run typecheck` 120–300 秒；不允许不带超时的命令，长工作拆成多个有界小步骤。
5. **TDD 测试先行**——新能力、bug 修复与重构一律测试先行：先写能复现问题或锁定新行为的失败测试（红），再实现到绿；没有保护网不动被测代码。
6. **docs/ 卡同步**——动手前先读 `docs/INDEX.md` 路由到的对应卡片；改完代码须同一变更内同步该卡（含头部 `last verified @ <commit>` 行）；新增插件必须同变更内建卡并在 INDEX 登记；横切契约（错误码/端口/消息键）变更同步 `docs/cross/` 对应文件；新事故记入 `docs/incidents.md`。
7. **交付四处同步 + 收尾核对**——任务结束前逐项核对：根/扩展 README（新增/变更功能、用法与实测测试数）、AGENTS.md（架构/布局/约定/命令/测试数变化时）、根/扩展 `package.json`（被触及的扩展 bump `version`，根版本与发布特性版本对齐）、`docs/` 相关内容（不再成立的直接删除，仍成立的更新 last verified）。`todos/` 的插件文件必须与插件目录、根 `package.json` 的 `pi.extensions` 注册一一对应，新增插件同变更创建 todo 文件；通用/跨插件需求另置 `todos/general-todo.md`（非插件文件）。文档/清单更新在同一 push 中以独立 commit 提交（`docs:` / `chore(pi):` 前缀）。

## 关键目录

- `docs/` — agent 知识库：`INDEX.md` 路由表（开发前先查）→ `extensions/<插件名>.md` 每插件一卡（职责边界/文件地图/数据流/不变量/已知坑/改动清单，≤100 行，头部带 `last verified @ <commit>`）→ `cross/` 横切契约（错误码全景/注入端口/消息与 entry 键/状态条/solo 审批门）→ `incidents.md` 事故与教训。卡片只写代码读不出来的知识（决策原因/不变量/契约/坑），不抄 API；改代码须同步对应卡片与 last verified 行。
- `test/` — 根契约测试（`status-bar-contract.test.ts`：footer 排序带 + 段分隔/首段定格 + widget 栈顺序，`npm run test:contract`）、安装冒烟工具的纯逻辑单测（`install-smoke.test.ts`，`npm run test:smoke`）与 todo CLI 单测（`todo-cli.test.ts`，`npm run test:todo`）。
- `tools/` — 仓库级开发工具：`install-smoke.mjs`（全新临时配置目录 + 真实 `pi --mode rpc` 进程，验证 14 个扩展在“手动复制”安装形态下全部加载，`node tools/install-smoke.mjs`；`--task` 追加真实模型工具调用任务；`--install <源>` 真跑 `pi install` 推荐安装路径并核对装到的包版本/扩展清单/命令面，联网）；`todo.mjs`（agentic todo CLI 薄入口，实现源 `todo-cli/core.ts`：解析/查重/追加/领取/完成/lint/triage 全部是可导出纯函数，`summary`/`list`/`add`/`claim`/`complete`/`lint`/`triage` 七个子命令，只读写仓库 `todos/`、保持 CRLF 行尾、不 commit；`triage` 只读扫描 worktree↔条目关联与遗留）。
- 卫星扩展（各目录自包含，`index.ts` 入口 + 就地测试；模块地图见各自 docs 卡与 README）：`stream-token-speed/`（多文件：index/adapter/controller/metrics/status-port/status-band + test/）、`chatanywhere-provider/`（catalog.ts 模型目录 + discover.ts 纯函数归并层 + auth.ts key 解析（环境变量 → auth.json）+ index.ts，带 `pi.extensions` 清单的 package.json + test/）、`provider-quota/`（余额/额度 widget + `/quota` + `status-band.ts`，适配器注入）、`run-timer/`（计时 widget + 对齐秒节拍 `aligned-ticker.ts`）、`loop/`（`/loop` 定时 + `--bg` 后台 agent，`runner.ts`）、`goal/`（`/goal` 会话目标循环 + 独立评估器 + `status-band.ts`）、`opencode-bridge/`（HTTP CONNECT → SOCKS5 桥 helper + settings 联动，`bridge.ts` 可测核心 + 注入 `ProxySyncDeps`）、`deep-init/`（提示词驱动四阶段 + `solo-gate`）、`human-notify/`（Windows Toast，内联 WinRT 零依赖）、`solo-mode/`（`/solo` 免审批模式：状态文件 pid 作用域 + 三份同构 `solo-gate.ts` 只读契约 + `status-band.ts` + `pi --solo` 启动 flag）、`todo-cli/`（`todos/` 工作流：agent 工具 `todos` + 裸 `/todo` 与六条冒号命令，核心 `core.ts` 与仓库 CLI `tools/todo.mjs` 共用、目录自包含；带 `pi.extensions` 清单的 package.json）、`session-manager/`（落盘会话只读浏览/检索：`core.ts` 纯解析 + 可注入 fs（`SessionFsDeps`）+ `index.ts` 注册 `session` 工具（list/search/preview）与 `/session-manager:*` 冒号命令；接续/分支只输出宿主 `pi --session/--fork` 命令不 spawn；带 `pi.extensions` 清单的 package.json）。

pwr 与 agent-team 的目录地图、架构与数据流：见 `docs/extensions/pwr.md` + `pwr/DELIVERY.md`（权威架构/安全文档 + 版本历史）与 `docs/extensions/agent-team.md`。文档截图（无头真实渲染 → SVG，三个场景：agent-team 查看器 / pwr 查看器 / agent-team 亮块）由 `agent-team/tools/capture-screens.mjs` 生成到 `docs/assets/`，用法见 agent-team README。

## 开发命令

```bash
cd pwr && npm install          # 全部依赖均为 devDependencies（pi-ai/pi-coding-agent/pi-tui、typebox、typescript）
npm test                       # node --test 覆盖 test/、tests/、runtime/test/、runner/test/
npm run typecheck              # tsc -p tsconfig.json --noEmit
# 子集示例：
node --test tests/ui-*.test.ts
node --test runtime/test/scheduler.test.ts
```

根契约（仓库根，无任何依赖）：

```bash
npm run test:contract   # 状态条排序带 + 段前缀 + widget 栈顺序（3 个测试，doc 见 docs/cross/status-bar.md）
npm run test:smoke      # 安装冒烟工具纯逻辑单测（19 个测试，不 spawn pi）
npm run test:todo       # todo CLI 纯逻辑 + 临时目录闭环单测（13 个测试）
node tools/todo.mjs summary    # agentic todo CLI：全量盘点（list/add/claim/complete/lint/triage 见文件头）
node tools/install-smoke.mjs   # 端到端：干净临时配置目录 + 真实 pi 进程，验证 14 扩展加载（需已装 pi）
node tools/install-smoke.mjs --task   # 追加真实模型任务（需鉴权 + 网络；模型取配置默认值，可 --model 覆盖）
node tools/install-smoke.mjs --install <pi install 源>   # 真跑 README 推荐安装路径（联网）：定位装到的包、核对版本/扩展清单/命令面；可与 --task 叠加
```

卫星扩展（不在 pwr 脚本覆盖范围内）：

```bash
cd stream-token-speed && node --experimental-strip-types --test test/*.test.ts   # 45 个测试
cd agent-team && npm install && npm test                                        # 354 个测试（node --test test/*.test.ts）
node --experimental-strip-types --test run-timer/run-timer.test.ts run-timer/aligned-ticker.test.ts   # 59 个测试，此目录无 package.json
node --experimental-strip-types --test goal/index.test.ts goal/aligned-ticker.test.ts                # 63 个测试，此目录无 package.json
node --experimental-strip-types --test human-notify/index.test.ts                # 37 个测试，此目录无 package.json
node --experimental-strip-types --test solo-mode/index.test.ts                    # 22 个测试，此目录无 package.json
node --experimental-strip-types --test provider-quota/index.test.ts              # 26 个测试，此目录无 package.json
node --experimental-strip-types --test chatanywhere-provider/test/*.test.ts        # 32 个测试，此目录无 package.json
cd loop && npm install && npm test                                               # 196 个测试；另有 npm run typecheck
cd opencode-bridge && npm install && npm test                                    # 114 个测试（helper 集成测试派生真实 helper + 手写 fake SOCKS5）；另有 npm run typecheck
cd todo-cli && npm install && npm test                                           # 5 个测试（命令面 + 工具链路；核心 core.ts 与仓库 CLI 共用）
cd session-manager && npm install && npm test                                    # 10 个测试（真实临时 JSONL 目录 + fake fs / fake ExtensionAPI 接线）
cd deep-init && npm install && npm test                                               # 37 个测试（纯函数 + fake scanner）；另有 npm run typecheck
```

无构建步骤、无 linter、无 formatter。

## 代码约定与常见模式

tsconfig（`pwr/tsconfig.json`）强制承载性规则——违反将导致 `npm run typecheck` 失败：

- **ESM NodeNext，所有相对导入显式带 `.ts` 扩展名**：`import { ApprovalStore } from "./src/approval.ts";`
- **类型导入必须用 `import type`**（`verbatimModuleSyntax`）：`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`
- **禁用 enum/namespace/参数属性**（`erasableSyntaxOnly`）：错误码用 `as const` 对象——`export const ErrorCodes = { … } as const;` + `type ScriptErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];`（见 `engine/errors.ts`）。
- `strict: true`、`noEmit`、`allowImportingTsExtensions`、`isolatedModules`、`noImplicitOverride`。

其他模式：

- **结果联合优先于异常：** 全代码库统一 `{ ok: true, value } | { ok: false, code, message }`；调用方用判别联合收窄（`if (r.ok) … else assert.equal(r.code, …)`）。每层有自己的错误码集：`src/errors.ts`（20 个）、`engine/errors.ts`（7 个）、`runtime/errors.ts`（7 个）、`runner/errors.ts`（5 个）。脚本失败携带源码位置（`ScriptError`）。
- **依赖注入经 deps 对象与注入端口：** `FlowDeps`、`ToolDeps`、`SaveAdapter`、`UiRuntimeAdapter`、`SaveFlowActions`、`RunPersister`；不用 mock 库、无全局注入。
- **注入时钟保证确定性：** 用 `now: () => string` / `nowMs` 参数而非 `Date.now()`；测试固定 `2026-08-05T12:00:00Z`。
- **状态管理：** runtime 用显式迁移表（`runtime/state.ts` 的 `TRANSITIONS` + `ALLOWED_OPERATIONS`，`assertTransition` → `ILLEGAL_STATE_TRANSITION`）；UI 用 `RunEvent` 供数据给 `MemoryRunStore` 同步快照。
- **异常隔离：** 每个 UI/观察者/持久化调用均 try/catch——"持久化失败绝不破坏会话"。
- **文件头注释** 引用 JHL 工单号 + PRD 章节（`* PWR - Pi Workflow Runtime extension entry (JHL-16 trigger/generation/approval + JHL-17 save/load & parameter commands)`）。保持同步更新。
- **安全不变量**（PWR）：无 `vm`/`eval`；执行前白名单校验；fail-closed 默认（缺 engine/runner ⇒ 类型化错误，无隐式回退）；脚本源码/args 永不持久化；`pwr-tmp://` 仅进程内；不存 API key；错误信息为静态模板。
- **Typebox** 用于工具参数 schema（`src/tools.ts` 的 `registerPwrTools`、`agent-team` 的 `manage.ts`/`index.ts`）。
- **TUI 约定（卫星扩展）：** 写入前用 `ctx.hasUI` 守卫，样式经 `theme.fg("dim", …)`，每个 `setStatus`/`setWidget` 调用均异常隔离，每扩展一个状态键。`loop/` 传纯（无样式）字符串给 `setWidget`——`ExtensionUIContext` 无 `theme` 字段，对 `ctx.ui.theme` 的类型化访问无法编译。
- **状态条契约（跨插件，`docs/cross/status-bar.md`）：** ① 时间类状态一律对齐同一墙钟秒边界刷新——各插件带一份 `aligned-ticker.ts`（首跳对齐、自校正、异常吞掉），生产禁用裸 `setInterval` 计时器；非时间类刷新（流式节流/低频轮询/推送）不受约束；② 写入前做文本指纹比对，内容不变跳过 `setStatus`/`setWidget`；③ footer 状态键带两位排序前缀：`10:goal` / `20:provider-quota` / `30:pwr` / `40:solo-mode` / `50:stream-token-speed`（宿主按 key `localeCompare` 拼接，不得改回无前缀键）；④ 编辑器上方 widget 栈顺序 = 根 `package.json` `pi.extensions` 注册顺序（`pwr-runs` → `run-timer` → `loop`）——该顺序只在**首次挂载**时成立；宿主 `setExtensionWidget` 每次刷新都会把 key 移到栈底（周期性刷新 widget 因此逐秒换位），这是宿主行为，本仓库不打补丁（`AGENTS.md` 规则红线·仓库边界），问题走上游（issue 草稿 `docs/pi-widget-order-issue.md`）；改注册顺序须同步根契约测试；⑤ **段分隔与首段定格**：按 key 排序后**最靠前的可见段不加 `│ `**（行首定格），其余段以 `│ `（U+2502+空格）连接；任一段出现/消失时所有已登记段立即重算前缀并重渲染。协调走每插件一份 `status-band.ts`（`Symbol.for("pi.status-bar.bands.v1")` 进程共享登记表 + `writeBand(key, text, writer)`）——不跨插件 import、单目录仍可复制安装；只认识同样使用该模块的写入者（本仓库五个 footer 写入者）。写入边界不得自己拼前缀，且 `session_shutdown` 必须清登记（防 /reload 残留），前缀决策在插件 dim 样式之前且计入指纹；段文本格式（goal 目标 ≤20 显示列、provider-quota 去 provider 前缀与倒计时、pwr 计数式 `pwr N▶ M✓`、stream-token-speed 汇总 `~` 标注平均/无数据清状态）锁定在 `docs/cross/status-bar.md`「段分隔、首段定格与瘦身契约」；根契约测试校验五份 `status-band.ts` 与写入边界接线。
- 缩进：`pwr/` 用 tab，`agent-team/`、`run-timer/`、`stream-token-speed/`、`loop/`、`goal/`、`opencode-bridge/`、`deep-init/`、`human-notify/`、`solo-mode/`、`todo-cli/`、`session-manager/` 用 2 空格。


## 编码规范（Clean Code）

以上章节描述现状；本节规定新代码怎么写。倾向简单——清晰的代码不是炫技的代码，没有代码胜过投机性的代码。

- **命名表意：** 可读、可搜索、不用编码后缀（`strName`、`iCount`）或噪音词（`Data`、`Info`、`Manager`）。复用仓库领域词汇（`run`、`dispatch`、`approval`、`digest`、`entry`）；同一模块内同一操作只用一个动词——不要 `fetch`/`get`/`load` 混用。
- **函数只做一件事：** 小（目标 < 40 行）、每函数单一抽象层级、早返回代替深嵌套（`if` 嵌套 ≥ 3 层 ⇒ 重构）。有副作用就写进名字（`saveApproval` 而非 `checkApproval`）。
- **参数要少：** 位置参数 ≤ 3 个，超出则用 deps/options 对象（对齐 `FlowDeps`/`ToolDeps`）。禁用选择行为的布尔标志参数——拆分函数或改传字符串字面量联合。
- **类型优于真值判断：** 用带显式标签（`ok`/`kind`）的判别联合，不用可选字段堆砌；`unknown` + 收窄，禁止 `any`；最小导出面——出现第二个调用方之前保持不导出。
- **错误遵循所在层的 result union：** 新失败模式必须在所属层的 `errors.ts` 中登记错误码（不用临时字符串码），消息用静态模板——不插值用户输入或密钥。
- **注释解释 why 而非 what：** 删掉代码已表达的内容；文件头保留 JHL 工单号（见上方约定）；注释/文档用中文，标识符用英文。
- **不过度设计（YAGNI）：** 不做只有单一调用方的配置项、只有一个实现的策略/插件层、只有一个具体类型的接口——除非它是测试需要 fake 的进程边界（此时沿用现有 deps/port 模式作接口）。重复好过错误的抽象；第三次出现才提取（rule of three）。
- **通过现有接缝扩展：** 新增能力的方式是加一个模块并在 `index.ts` 接线，或扩展 deps/port 对象——而不是把标志参数穿透深层。新上限/常量进所属层的规范文件（`engine/spec.ts`、`src/types.ts`），调用点不写魔法数。这就是全部扩展方式：今天的接缝足够应对明天的需求；有具体需求到来时再回来改。
- **让代码更好而不是更大：** 每次改动保持全量测试 + `npm run typecheck` 绿；死代码与"以防万一"分支直接删除，不注释保留。

## 运行时/工具链偏好

- **Node ≥ 22.18**（原生 type-stripping——`.ts` 直接运行；已在 Node 22.23.1 / Windows 验证）。不用 Bun、无构建步骤、无 bundler。
- **npm**（package-lock v3）。包管理器不是 Bun/pnpm。
- TypeScript ^5.8（解析为 5.9.3）；`@earendil-works/pi-*` ^0.85.1 仅作 devDependencies——宿主 Pi 环境在运行时解析它们。
- 工作区使用的 Pi 扩展 API 面：`pi.on`（`session_start`、`agent_start`、`agent_settled`、`turn_start/end`、`model_select`、`message_start/update/end`、`input`、`before_agent_start`、`tool_call`、`tool_result`）、`pi.registerCommand`、`pi.registerTool`、`pi.registerProvider`、`pi.registerShortcut`、`pi.registerEntryRenderer`、`pi.appendEntry`、`pi.sendMessage`、`ctx.ui.setStatus/setWidget/notify`、`ctx.sessionManager.getEntries`。
- 配置经环境变量（`CHATANYWHERE_API_KEY`、`CHATANYWHERE_BASE_URL`）或 `~/.pi/agent/auth.json` 按 provider id 键（provider-quota——明确不用环境变量）。
- 安装形态：所有扩展都是带 `index.ts` 入口的目录（chatanywhere-provider 另在 package.json 声明 `pi.extensions: ["./index.ts"]`）；目录复制进 `extensions/` 后 pi 自动加载。

## 测试与 QA

- **测试要抓住真正的问题，不止"纸面正确"：** 纯函数单测绿 ≠ 真机行为对——此前 /team:view 修堆叠三轮正栽在"纸面正确"上：纯函数单测全绿，真机照样重影。凡风险在宿主/进程边界（真实渲染管线、子进程契约、时钟/IO），测试必须接到真实实现上跑：agent-team `viewer-host.test.ts`（真实 `TuiMainScreen` + 假终端 headless 渲染）与 `viewer-mutex.test.ts`（打开互斥）各自抓住了纯函数测不出的 bug。纯函数测试只用于真正隔离的逻辑，并在文件头写明边界与动机。
- **框架：`node:test` + `node:assert/strict`**——无 vitest/jest、无 mock 库。pwr、stream-token-speed、goal 用扁平 `test("名称", fn)` 命名（叙述式断言，部分中文名）；`run-timer.test.ts`（50 个 `it`，经 before/after 钩子 mock `setTimeout`）与 `loop/test/` 用 `describe`/`it`。统一 `*.test.ts` 后缀。
- **Mock = 进程边界手写 fake：** fake `AgentRunner`（`makeFakeRunner`，`pwr/test/helpers.ts`）、fake pi 子进程（`FakeChild` + `makeFakeSpawn` + `waitForChild`，`pwr/runner/test/helpers.ts`）、`RecordingStatusPort`（`stream-token-speed/test/fixtures.ts`）；fake 只作进程/IO 边界替身，不做被测行为的"纸面替身"。测试目标本身是被测逻辑依赖的宿主组件（如 agent-team viewer 渲染）时，实例化真实组件、只 fake 终端（见 `viewer-host.test.ts`）；结构 fake（`as never`）仅用于宿主交互确实不在测试范围的情形。
- **集成模式：** 接线真实模块（`PiAgentRunner` + `WorkflowRuntime` + `MemoryPersister`），mock spawn、脚本化子进程事件、轮询 `waitSettled`（10ms × 100）——见 `pwr/runner/test/integration.test.ts`（happy path + `restart_agent` 语义；`handle.records.length` 证明缓存回放不派生进程）。
- **性能门：** `pwr/test/perf.test.ts`——约 1500-agent / ~64KB 脚本的 `validateScript` 必须在 300ms（墙钟）内完成。
- **数量（grep 实测）：** pwr 439 个测试，分布在 35 个 `*.test.ts`（test/ 105、tests/ 233、runtime/test/ 56、runner/test/ 45）；stream-token-speed 45；agent-team 354；run-timer 59；loop 196；goal 63；provider-quota 26；opencode-bridge 114；chatanywhere-provider 32；deep-init 37；human-notify 37；solo-mode 22；todo-cli 5；session-manager 10；根契约 3 + 安装冒烟单测 19 + todo CLI 13。

- **覆盖缺口：** 全库无 TODO/skip/only 标记。
