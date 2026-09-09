# 仓库开发指南
<!-- PROJECT KNOWLEDGE BASE / Generated: 2026-09-09T03:50:04Z / Commit: 457adcf / Branch: dev-laptop / Mode: update / MaxDepth: 3 -->

## 项目概览

Pi 编码助手的扩展工作区（文档/注释为中文，代码为英文）。扩展通过复制到 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（受信任项目）加载，然后在 Pi 中执行 `/reload` 生效。

- **`pwr/` — 主项目。** PWR（Pi Workflow Runtime）v2.4.1：用户编写受约束的 ECMAScript 工作流脚本；PWR 校验后弹出批准卡，再通过派生子 `pi` 进程作为 sub-agent 执行（`PiAgentRunner`）。v2.4.0 新增逐步实时运行 trace（runner `onEvent` → runtime `task_event` → 查看器 agent 行）、`/workflows:saved` 列表，以及 `/workflow:<name>` 的 schema 引导 `key=value` 参数输入（仍兼容 JSON）。零构建 TypeScript ESM，由 Node ≥ 22.18 原生 type-stripping 直接执行。
- **卫星扩展**（相互独立，扩展形态相同）：`agent-team/`（可复用多 agent 团队：独立 leader 子进程通过 `team_dispatch` 调度成员子进程；输入栏下方可选中亮块——紧凑两行概要，`alt+↓` 激活、`enter` 直达查看器、`esc`/其它键退出并放行编辑器；`team_run` 默认后台派单，报告经 followUp 自动送达）、`stream-token-speed/`（TTFT + 实时 tokens/s 状态）、`chatanywhere-provider/`（OpenAI 兼容 + Anthropic Messages provider 适配器）、`provider-quota/`（余额/额度状态 + `/quota`；适配器含 OpenRouter/DeepSeek/ChatAnywhere/智谱/OpenCode Go，Go 的限额窗口重置时间跟随命中的限额窗口）、`run-timer/`（会话/任务/回合计时 widget）、`loop/`（`/loop` 固定间隔循环 + 每天定时循环 + 每日窗口间隔循环（v1.2.0）+ 一次性提醒 + `--bg` 后台 agent 模式（v1.3.0：前台 followUp 送达，或拉起可恢复的子 `pi --mode json -p` 进程，其会话 id 会被捕获、可用 `pi --session <id>` 恢复；见 `runner.ts`），followUp 送达 + 会话条目快照持久化，agent 工具 `loop_create/list/delete`）、`goal/`（`/goal` 会话目标循环——agent 跨回合自动推进，直至独立 LLM 评估器判定条件达成）、`opencode-bridge/`（拉起/复用本地 HTTP CONNECT → SOCKS5 桥 helper（`opencode-bridge-helper.mjs`，零依赖独立进程），使 Pi 的 `httpProxy` 能经由本地 SOCKS5（v2rayN）转发；`session_start` 先探测 `127.0.0.1:<port>`，多 Pi/subagent 实例共享同一桥，detached + unref 派生（Pi 不持有子进程资源），扩展**绝不自动改** settings.json——`/opencode-bridge-sync [port]` 命令人工确认后仅增/删 `httpProxy` 字段（其余配置不动），写前备份原文到 `settings.json.bak-opencode-bridge-<时间戳>`，端口可跟参或交互询问并持久化到 settings.json 同目录 `opencode-bridge.json`（优先级 参数 > 环境变量 > 配置文件 > 默认值），改端口后指纹确认停旧桥、起新桥、httpProxy 联动（一次确认，fail-closed），settings/端口配置读写经 `ProxySyncDeps` 注入（plan/apply 两阶段，防竞态），`/opencode-bridge-restore` 从备份列表选择恢复 settings.json（人工确认；恢复前先把当前配置再备份一份，保证可撤销），`/opencode-bridge` 状态命令，环境变量 `PI_BRIDGE_PORT`/`PI_BRIDGE_SOCKS_HOST`/`PI_BRIDGE_SOCKS_PORT`；helper 可在 socket 错误/ECONNRESET 下存活，端口被占用时以 0 退出）、`deep-init/`（`/deep-init` 深度初始化——提示词驱动复刻 init-deep 四阶段：参数解析 + 已有 AGENTS.md 预检 + `--create-new` 二次确认门控，下发提示词由主 agent 用 read/bash/edit/write 执行发现/评分/生成/复核；v1.1.0 起 Discovery 按规模并行派 subagent 探索并汇总）、`human-notify/`（人工介入 Windows Toast——`ui_prompt_start` 审批/输入等待与 `agent_settled` 完全结束时通知，内联 WinRT PowerShell 零依赖，detached + unref 派生，Linux / macOS no-op，`PI_HUMAN_NOTIFY=0` 一键关闭）。

## 需求受理 → `todos/` 登记（强制）

所有需求入口（对话中提出的新需求、子代理/团队派单任务、bug/重构请求等）在动手实现前，必须先到 `todos/` 目录完成登记，规则如下：

1. **定位对应文件** — `todos/` 下每个插件一份 `<插件名>-todo.md`（如 `todos/pwr-todo.md`、`todos/agent-team-todo.md`）。先判断需求归属哪个插件，打开对应文件；跨插件需求在涉及的各文件中分别登记。
2. **领取或新建条目** — 文件内已有匹配的条目 → 直接领取该条；没有 → 在文件末尾追加一条 `- [ ] <需求描述>` 新建。
3. **标注 processing（进行中）** — 领取或新建后立即把该条目标注为处理中：`- [ ] <需求描述>（processing）`；需求完成前始终保持此状态。未开始的条目保持 `- [ ]`，已完成条目为 `- [x] <需求描述>`。
4. **完成后标注完成** — 需求全部完成（代码 + README/AGENTS/package.json 同步，见交付节）后，改为 `- [x] <需求描述>` 并去掉 processing 标注。
5. 取消/搁置的需求在条目上注明原因后还原为 `- [ ]` 或删除，`todos/` 始终反映真实状态。

## 分支与 Worktree（强制）

所有需求（todo 条目、bug 修复、重构）一律在独立 git worktree 里实现，自测通过后才合回主干。禁止直接在主干工作区改代码——主干工作区只做评审、只读命令与 `todos/` 登记。

1. **开 worktree** — 从主干（当前为 `dev-laptop`）开，位置固定 `.worktrees/<短名>`（已在 `.gitignore`，不污染状态）：`git worktree add .worktrees/<短名> -b feat/<插件名>-<事项> dev-laptop`。
2. **在里面做完** — 实现 + 自测：全量测试绿 + `npm run typecheck` 零错误（见“测试与 QA”质量门），达标前不合回。
3. **合回主干** — 回主干工作区 `git merge --no-ff feat/<插件名>-<事项>`，有冲突就地解决不绕行。
4. **删 worktree** — 合完确认没问题（主干状态正常）后 `git worktree remove .worktrees/<短名>`，保持工作区干净；如合完发现问题，可暂留 worktree 排查，解决后再删。分支可留可删（已推远端的按远端清理）。

## 架构与数据流

PWR（`pwr/`）分层组织，`src/types.ts` 是共享契约中枢（`RuntimeAdapter`、`ScriptEngine`、`WorkflowRun`、`PwrErrorResult`、entry/自定义消息常量、上限值）。并非严格分层——`runtime/` 引用 `src/plan.ts` 与 `src/ui/types.ts`（RunEvent）；`engine/interpreter.ts` 再导出 `runner/errors.ts` 的 `RunnerError`。

1. **`engine/`** — 独立 DSL：`vendor/acorn.mjs`（内置 acorn 8.18.0，仅解析）→ `parser.ts` → `validator.ts`（`validateScript`/`validateScriptStrict`、`extractPlan`）→ `interpreter.ts`（AST 树遍历解释器，全局 `meta/args/agent/pipeline/parallel/sleep/JSON`，信号量 ≤ 128，循环预算 100k，`plain.ts` 单次快照安全边界）→ `concurrency.ts`。公开 API 由 `engine/index.ts` 再导出；`engine/spec.ts` 是 DSL 唯一事实来源（白名单、上限、`SCRIPT_VERSION = '1.1.2'`）。
2. **`runner/`** — `PiAgentRunner`（`runner/index.ts`）：`discover.ts`（.md agent 发现，优先级 用户 > 项目 > 内置，trust 门控 `agentScope`）、`pi.ts`（子 `pi --mode json -p --no-session`，按行 JSON 事件，SIGTERM → 5s 后 SIGKILL（`KILL_GRACE_MS=5000`））。运行契约 `{ runId, agentId, prompt, label, tools, schema, signal }` → `{ result, summary, usage, events }`；result 上限 50KB（`RESULT_TOO_LARGE`），summary 8KB。工具交集：readonly = read/grep/find/ls/glob，write = +bash/write/edit。v2.4.0：`pi.ts` 还解析 `tool_execution_start/update/end`（toolName + 截断的参数/输出尾部）与节流的 assistant `message_update` 尾部，实时调用 `onEvent` 观察者（经 `AgentRunSpec.onEvent` 注入，仅 runtime 使用）；所有 trace 文本单行 + 尾部截断，绝不透传原始工具输出。
3. **`runtime/`** — `WorkflowRuntime` 实现 `RuntimeAdapter`：`state.ts` 迁移表、`scheduler.ts` FIFO 队列、`cache.ts` `RunCache`（digest + 规范化输入的 sha256；缓存命中直接回放，不派生进程、不占预算）、`persist.ts` 仅元数据条目。模块级单例 `export default runtime`。
4. **`src/`** — 编排：`flow.ts` 纯流程 + `RunRegistry`、`approval.ts` `ApprovalStore`（键 = 项目 canonical path|digest——脚本被编辑后必须重新批准，`APPROVAL_STALE`）、`notify.ts` `RunNotifier`、`save.ts` 保存/加载/调用、`args/plan/intent/constraints/digest/errors.ts`、`model-config.ts`（`/pwr-model`）、`engine.ts` 适配器（fail-closed `ENGINE_UNAVAILABLE`）。
5. **`src/ui/`** — 无宿主 TUI 层：`MemoryRunStore`（同步快照）、`views.ts` 纯文本格式化、`commands.ts`、`save-flow.ts`、`approval-card.ts`、`renderer.ts`（唯一引入 `pi-tui` `Box/Text` 的文件）。`ui/index.ts` `createWorkflowsUi` 注册 `/workflows`、快捷键 `ctrl+alt+z/x/r`（按键只在 `pwr/src/ui/keybindings.ts` 快捷键注册表中定义）、entry 渲染器、widget/status。

**运行数据流：** `/workflow <任务>` 或 `workflow:` 前缀 → `pwr-generation-request` 自定义消息（`before_agent_start`）→ 主 agent 调 `workflow_validate` → `tool_result` 上弹批准卡（once/remember/查看脚本/拒绝；关闭卡片仍是待批准）→ `workflow_start`（批准门控）→ `WorkflowRuntime.start` → 调度器 → 解释器 → 派发（缓存回放 | 预算 vs `AGENT_LIMIT=1000` | `PiAgentRunner.run` 子 `pi`）→ `RunCache` + `RunEvent` 流 → `MemoryRunStore` → widget/entry 渲染器。完成：`RunNotifier`（runId 作用域；被取消的运行不会唤醒它）→ `pi.sendMessage(pwr-workflow-result)`。已保存路径：`/workflow:<name>` → `invokeSavedWorkflow`（项目覆盖用户；重新校验；JSON args 按 schema 校验；digest 门控批准）。

**生命周期：** 无 init/onLoad 钩子。入口 `index.ts` 在加载时注册命令/钩子；`session_start` 动态 import `runtime/` + `runner/`，并从 `ctx.sessionManager` 水合持久化条目（`pwr-approval-v1`、`pi-workflow-run-v1`）。缺 runner ⇒ `AGENT_RUNNER_UNAVAILABLE`——绝不隐式回退。持久化仅元数据；脚本源码/args 永不写盘。

**已知怪癖：** pwr 无 `agent_settled` 处理器（settle 经 `onFinalResult` 按 runId 作用域处理）；`runtime.shutdown()` 从未接线（无 `session_shutdown` 钩子）；engine↔runner 相互引用；上限值在 `src/types.ts` / `engine/spec.ts` / `runtime/types.ts` 三处重复；`engine/validate-tool.ts` 的 `runWorkflowValidate` 仅被测试消费。

## 关键目录

- `pwr/engine/` — DSL 解析/校验/解释；`spec.ts` 是 DSL 唯一事实来源（白名单，上限 128/1000/100k/256KB，`SCRIPT_VERSION`）。
- `pwr/runtime/` — 运行状态机、FIFO 调度器、运行缓存、仅元数据持久化。
- `pwr/runner/` — 子 `pi` 进程适配器、agent 发现。
- `pwr/src/` + `pwr/src/ui/` — 编排契约与 TUI 层。
- `pwr/test/`、`pwr/tests/`、`pwr/runtime/test/`、`pwr/runner/test/` — node:test 套件（见"测试与 QA"）。
- `pwr/vendor/` — 内置 acorn 8.18.0（`acorn.mjs` + 手写 `acorn.d.mts` + license）；生成文件，勿修改。仅被 `engine/parser.ts` 引入，使 PWR 运行时零 npm 依赖。
- `docs/` — agent 知识库：`INDEX.md` 路由表（开发前先查）→ `extensions/<插件名>.md` 每插件一卡（职责边界/文件地图/数据流/不变量/已知坑/改动清单，≤100 行，头部带 `last verified @ <commit>`）→ `cross/` 横切契约（错误码全景/注入端口/消息与 entry 键）→ `incidents.md` 事故与教训。卡片只写代码读不出来的知识（决策原因/不变量/契约/坑），不抄 API；改代码须同步对应卡片与 last verified 行。
- 卫星扩展：`agent-team/`（扁平模块：types/config/runner/worktree/leader-prompt/dispatch/manage/cockpit/widget/session/index + test/ + examples/）、`stream-token-speed/`（多文件：index/adapter/controller/metrics/status-port + test/）、`chatanywhere-provider/`（index.ts + 带 `pi.extensions` 清单的 package.json）、`provider-quota/`（index.ts，无 package.json）、`run-timer/`（index.ts + test，无 package.json）、`loop/`（parse.ts + tasks.ts + tools.ts + runner.ts + index.ts + 带 `pi.extensions` 清单的 package.json + tsconfig）、`goal/`（单文件 + test，无 package.json：经 `agent_settled` + `pi.sendMessage({triggerTurn, deliverAs:"followUp"})` 链式续回合，状态持久化为 `goal-state-v1` 条目，评估器 = 一次小型 `ctx.modelRegistry` + pi-ai `provider.stream` 调用）、`opencode-bridge/`（index.ts + bridge.ts + opencode-bridge-helper.mjs + 带 `pi.extensions` 清单的 package.json + tsconfig + lockfile；探测/派生/fs/sleep/shutdown 边界经 `BridgeDeps` 注入、settings + 端口配置文件读写经 `ProxySyncDeps` 注入以便确定性测试）、`deep-init/`（单文件 + test + 带 `pi.extensions` 清单的 package.json + tsconfig：提示词驱动 thin 封装，`DirScanner`/`gitInfo`/`nowIso` 经 `DeepInitDeps` 注入）、`human-notify/`（单文件 + test，无 package.json：监听 `ui_prompt_start`/`agent_settled` 发 Windows Toast，派生/平台/时钟/环境经 `HumanNotifyDeps` 注入）。每个扩展目录都以 `index.ts` 为入口，纯目录复制后 pi 自动发现（`extensions/*/index.ts`）即可加载；根 `package.json` 的 `pi.extensions` 清单为 `pi install` 注册全部扩展。

## 开发命令

```bash
cd pwr && npm install          # 全部依赖均为 devDependencies（pi-ai/pi-coding-agent/pi-tui、typebox、typescript）
npm test                       # node --test 覆盖 test/、tests/、runtime/test/、runner/test/
npm run typecheck              # tsc -p tsconfig.json --noEmit
# 子集示例：
node --test tests/ui-*.test.ts
node --test runtime/test/scheduler.test.ts
```

卫星扩展（不在 pwr 脚本覆盖范围内）：

```bash
cd stream-token-speed && node --experimental-strip-types --test test/*.test.ts   # 43 个测试
cd agent-team && npm install && npm test                                        # 109 个测试（node --test test/*.test.ts）
node --experimental-strip-types --test run-timer/run-timer.test.ts               # 此目录无 package.json
node --experimental-strip-types --test goal/index.test.ts                        # 39 个测试，此目录无 package.json
node --experimental-strip-types --test human-notify/index.test.ts                # 18 个测试，此目录无 package.json
node --experimental-strip-types --test provider-quota/index.test.ts              # 15 个测试，此目录无 package.json
cd loop && npm install && npm test                                               # 169 个测试；另有 npm run typecheck
cd opencode-bridge && npm install && npm test                                    # 108 个测试（helper 集成测试派生真实 helper + 手写 fake SOCKS5）；另有 npm run typecheck
cd deep-init && npm install && npm test                                               # 32 个测试（纯函数 + fake scanner）；另有 npm run typecheck
```

无构建步骤、无 linter、无 formatter。

**命令超时（强制）：** 每次执行命令都必须显式传入超时（bash 工具的 `timeout` 参数），防止挂起或意外死循环阻塞会话——快速 shell 操作（ls/grep/git）约 30–60 秒，`npm test`/`npm run typecheck` 约 120–300 秒。不允许不带超时的命令；长时间工作应拆成多个有界小步骤，而非一次无上限调用。

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
- **TUI 约定（卫星扩展）：** 写入前用 `ctx.hasUI` 守卫，样式经 `theme.fg("dim", …)`，每个 `setStatus`/`setWidget` 调用均异常隔离，每扩展一个状态键（`stream-token-speed`、`provider-quota`、`run-timer`、`agent-team`、`loop`、`goal`）。`loop/` 传纯（无样式）字符串给 `setWidget`——`ExtensionUIContext` 无 `theme` 字段，对 `ctx.ui.theme` 的类型化访问无法编译。
- 缩进：`pwr/` 用 tab，`agent-team/`、`run-timer/`、`stream-token-speed/`、`loop/`、`goal/`、`opencode-bridge/`、`deep-init/`、`human-notify/` 用 2 空格。
- `agent-team/` 细节：团队 = 持久化 Markdown 文件（frontmatter `leader` + `members[]`，含每成员 `provider/model`、`tools`、`worktree`、块标量 `prompt`），位于 `~/.pi/agent/teams/` 或受信任项目 `.pi/teams/`（同名时项目优先）；每次使用时重新扫描（无缓存）。一套代码、两种模式，以环境变量 `PI_AGENT_TEAM_FILE` 区分：leader 模式只注册 `team_dispatch` 工具；cockpit 模式注册 `team_create`/`team_list`/`team_run` 工具、`/team*` 命令、下方可选中亮块（`widget.ts`：`setWidget(key, string[], { placement: "belowEditor" })` 每秒刷新——宿主包装的 string 渲染是跨构建最稳的路径，组件工厂式逐帧重绘在某 bundle 构建宿主上会产生逐秒追加残影行；选中经 `ctx.ui.onTerminalInput` 特性检测拦截，`PI_AGENT_TEAM_WIDGET=0` 可整体关闭）、entry 渲染器（`agent-team-run-v1`）。`team_run` 默认后台派单（立即返回，报告经 `deliverRunResult` 以 followUp 送达），`wait: true` 保留同步契约；查看器（`viewer.ts`）定时刷新经数据指纹门控（`elapsed` 空转不重绘）、选中按 actor id 保持、帧高 ±1 行消抖、`buildViewerData` 页签排序固定、overlay 盒模型与参考对齐（`VIEWER_OVERLAY_OPTIONS`：宽 96% + `maxHeight` 85% + `margin` 1）、viewer 打开期间暂停下方 widget（`RunWidgetController.setPaused` 停 tick 并隐藏亮块，关闭恢复）（防标题+页签重影堆叠）；扩展入口接受 `{ spawn }` 供工具级测试（`test/run-tool.test.ts`）。成员/leader 子进程沿用与 pwr runner 相同的子 `pi` JSON 模式（`team-tmp://` prompt 物化，SIGTERM→SIGKILL），自包含（不引 pwr）。结果联合用 `TeamErrorCodes`；上限：每 dispatch 8 任务、4 并发成员、50KB 结果、8KB 摘要。

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

## 交付与文档同步（强制）

每次代码变更只有在其文档与清单在同一变更中同步更新后才算完成——绝不留到后续处理：

- **README**：更新根 `README.md` 中受影响扩展的章节（PWR 另有 `pwr/README.md` / `pwr/DELIVERY.md`）——新增/变更的功能、用法与实测测试数。
- **docs/ 知识库卡（强制）**：动手前先读 `docs/INDEX.md` 路由到的对应卡片；改完代码须同一变更内同步该卡（含头部 `last verified @ <commit>` 行）；新增插件必须同变更内建卡并在 INDEX 登记；横切契约（错误码/端口/消息键）变更同步 `docs/cross/` 对应文件；新事故记入 `docs/incidents.md`。
- **AGENTS.md**：架构、文件布局、约定、命令或实测测试数变化时同步更新（项目概览/关键目录中的卫星描述，开发命令与测试 QA 中的测试数）。
- **`todos/`**：每个插件必须对应一份 `todos/<插件名>-todo.md`，与插件目录、根 `package.json` 的 `pi.extensions` 注册一一对应；**新增插件时必须在同一变更里同步创建该 todo 文件**，缺失视为交付不完整。
- **package.json**：每个被触及的扩展 `package.json` bump `version`（若 description 提及特性则一并更新）；根 `package.json` 的 `version` 同步 bump（与发布特性版本对齐，如 loop v1.3.0 → 根 1.3.0）。
- 文档/清单更新在同一 push 中以独立 commit 提交（约定：`docs:` / `chore(pi):` 前缀）。

## 重要文件

- `pwr/index.ts` — 扩展入口；`export default pwrExtension(pi: ExtensionAPI)`；命令（`/workflow`、`/pwr-model`、`/workflow-delete`、动态 `/workflow:<name>`）、钩子（`input`、`before_agent_start`、`session_start`、`model_select`、`tool_call`、`tool_result`）、工具经 `registerPwrTools`（`workflow_validate`、`workflow_start`、`workflow_control`、`workflow_save`）、批准卡、entry 渲染器、runner 注入。
- `pwr/src/types.ts` — 共享契约中枢：跨层接口 + 消息/条目常量（`pi-workflow-run-v1`、`pwr-approval-v1`、`pwr-generation-request`、`pwr-workflow-result`）、上限（`AGENT_LIMIT=1000`、`CONCURRENCY_MAX=128`、`CONCURRENCY_DEFAULT=4`、`MAX_SCRIPT_SIZE=256*1024`、`MAX_FINAL_SUMMARY_SIZE=8*1024`）。
- `pwr/engine/spec.ts` — DSL 唯一事实来源（白名单、限制、钳制、脚本版本 1.1.2）。
- `pwr/DELIVERY.md` — 权威架构/安全文档 + 版本历史（v2.0.0 → v2.4.0，JHL 工单映射 JHL-10..18）。注：含损坏痕迹（行首字符丢失、重复标题）。
- `pwr/README.md`、根 `README.md` — 中文功能/安装文档。
- `pwr/test/helpers.ts`、`pwr/runner/test/helpers.ts` — fake 构建器，新测试请复用；`pwr/package.json`、`pwr/tsconfig.json` — 脚本与强制约定。

## 运行时/工具链偏好

- **Node ≥ 22.18**（原生 type-stripping——`.ts` 直接运行；已在 Node 22.23.1 / Windows 验证）。不用 Bun、无构建步骤、无 bundler。
- **npm**（package-lock v3）。包管理器不是 Bun/pnpm。
- TypeScript ^5.8（解析为 5.9.3）；`@earendil-works/pi-*` ^0.85.1 仅作 devDependencies——宿主 Pi 环境在运行时解析它们。
- 工作区使用的 Pi 扩展 API 面：`pi.on`（`session_start`、`agent_start`、`agent_settled`、`turn_start/end`、`model_select`、`message_start/update/end`、`input`、`before_agent_start`、`tool_call`、`tool_result`）、`pi.registerCommand`、`pi.registerTool`、`pi.registerProvider`、`pi.registerShortcut`、`pi.registerEntryRenderer`、`pi.appendEntry`、`pi.sendMessage`、`ctx.ui.setStatus/setWidget/notify`、`ctx.sessionManager.getEntries`。
- 配置经环境变量（`CHATANYWHERE_API_KEY`、`CHATANYWHERE_BASE_URL`）或 `~/.pi/agent/auth.json` 按 provider id 键（provider-quota——明确不用环境变量）。
- 安装形态：所有扩展都是带 `index.ts` 入口的目录（chatanywhere-provider 另在 package.json 声明 `pi.extensions: ["./index.ts"]`）；目录复制进 `extensions/` 后 pi 自动加载。

## 测试与 QA

- **TDD 实现（强制）：** 新能力、bug 修复与重构一律测试先行——先写能复现问题或锁定新行为的失败测试（红），再实现到绿；没有保护网不动被测代码。测试是回归资产，随变更一起入库。
- **测试要抓住真正的问题，不止"纸面正确"：** 纯函数单测绿 ≠ 真机行为对——此前 /team:view 修堆叠三轮正栽在"纸面正确"上：纯函数单测全绿，真机照样重影。凡风险在宿主/进程边界（真实渲染管线、子进程契约、时钟/IO），测试必须接到真实实现上跑：agent-team `viewer-host.test.ts`（真实 `TuiMainScreen` + 假终端 headless 渲染）与 `viewer-mutex.test.ts`（打开互斥）各自抓住了纯函数测不出的 bug。纯函数测试只用于真正隔离的逻辑，并在文件头写明边界与动机。
- **框架：`node:test` + `node:assert/strict`**——无 vitest/jest、无 mock 库。pwr、stream-token-speed、goal 用扁平 `test("名称", fn)` 命名（叙述式断言，部分中文名）；`run-timer.test.ts`（47 个 `it`，经 before/after 钩子 mock `setInterval`）与 `loop/test/` 用 `describe`/`it`。统一 `*.test.ts` 后缀。
- **Mock = 进程边界手写 fake：** fake `AgentRunner`（`makeFakeRunner`，`pwr/test/helpers.ts`）、fake pi 子进程（`FakeChild` + `makeFakeSpawn` + `waitForChild`，`pwr/runner/test/helpers.ts`）、`RecordingStatusPort`（`stream-token-speed/test/fixtures.ts`）；fake 只作进程/IO 边界替身，不做被测行为的"纸面替身"。测试目标本身是被测逻辑依赖的宿主组件（如 agent-team viewer 渲染）时，实例化真实组件、只 fake 终端（见 `viewer-host.test.ts`）；结构 fake（`as never`）仅用于宿主交互确实不在测试范围的情形。
- **集成模式：** 接线真实模块（`PiAgentRunner` + `WorkflowRuntime` + `MemoryPersister`），mock spawn、脚本化子进程事件、轮询 `waitSettled`（10ms × 100）——见 `pwr/runner/test/integration.test.ts`（happy path + `restart_agent` 语义；`handle.records.length` 证明缓存回放不派生进程）。
- **性能门：** `pwr/test/perf.test.ts`——约 1500-agent / ~64KB 脚本的 `validateScript` 必须在 300ms（墙钟）内完成。
- **数量（grep 实测）：** pwr 405 个测试，分布在 33 个 `*.test.ts`（test/ 100、tests/ 204、runtime/test/ 56、runner/test/ 45）；stream-token-speed 43；agent-team 109；run-timer 47；loop 169；goal 39；provider-quota 15；opencode-bridge 108；deep-init 32；human-notify 18。
- **覆盖缺口：** `chatanywhere-provider` 零测试。全库无 TODO/skip/only 标记。
- **确定性与封闭性：** 注入固定时钟（`2026-08-05T12:00:00Z`）、临时目录经 `os.tmpdir()` 并清理、无网络。
- 质量标准见 `pwr/DELIVERY.md`：交付前全套测试绿 + `npm run typecheck` 零错误。
