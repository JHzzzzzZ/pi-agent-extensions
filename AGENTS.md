# 仓库开发指南

> **愿景准绳：[GOAL.md](GOAL.md)**——把派 Agent 建成最好用的 Agent 框架（插件形态，给自己也给别人用；尺子/差异化/里程碑见 GOAL.md）。每个任务收尾时回答 GOAL.md §5 自检问题（这次离愿景更近了什么），并按红线 7 走交付收尾门。

## 项目概览

Pi 编码助手的扩展工作区（文档/注释为中文，代码为英文）。14 个插件目录收在 `src/extensions/` 下：`pwr/`（Pi Workflow Runtime，本地工作流编排）与 13 个独立扩展（多 agent 团队、模型提供商、TypeSafe 结构化判断接入、额度查询、流式计量、运行计时、定时任务、会话目标循环、本地代理桥、深度初始化、人工介入通知、免审批模式、shell 超时转后台）；仓库根另有独立运行的 **agent-manager**（带浏览器前端的 agent 管理工具，非 Pi 扩展，agent 不感知）。全部为**零构建 TypeScript ESM**，由 Node ≥ 22.18 原生 type-stripping 直接执行，运行时无 npm 依赖。

每个扩展的职责边界、文件地图、数据流、不变量与已知坑：见 [`docs/INDEX.md`](docs/INDEX.md) 路由到的卡片与各扩展 README。安装/加载：复制到 `~/.pi/agent/extensions/`（全局）或 `.pi/extensions/`（受信任项目），Pi 中执行 `/reload` 生效。

## 规则红线（强制）

以下规则无例外；与其他考量冲突时以本节为准。分两组：**需求生命周期**按序执行（1→7），**全程硬约束**在任何阶段都适用。

### 需求生命周期（按序执行）

1. **需求先登记 `todos/`**——动手实现前按路由登记到唯一落点：现有插件 → `todos/<插件名>-todo.json`；未实现的特定插件 → 新建同名文件；通用/跨插件需求 → `todos/general-todo.json`；仓库级工具 → 该工具专门文件（现 `todo-cli-todo.json`、`agent-manager-todo.json`）。`todos/` 唯一读写入口是 todo CLI（`node .agents/skills/todo-cli/todo-cli/todo.mjs`，手工编辑 JSON 视为破坏存储；命令面/锁/查重口径见 `docs/tools/todo-cli.md`）：已有条目 `claim` 领取（`--branch` 写入分支引用；两段式——首次领取进 `aligning`，对齐确认后再次 `claim` 才进 `processing`），没有则 `add` 追加；取消/搁置用 `complete --note "<原因>"` 收口（从 `aligning`/`aligned` 收口必带 `--note`）；误标为在途或推翻对齐结论用 `reopen --note "<原因>"` 退回未领取（从 `aligning`/`aligned` 撤销必带 `--note`，`done` 拒绝，陈旧对齐文档自动归档为 `.reopened-<UTC 紧凑>.md`）——`todos/` 始终反映真实状态。条目 id 文件内 max+1 永不复用、entries 数组 append-only，合并冲突按 globalId 判同条目取并集（`文件#id` 展示不变）手工解决。
2. **先对齐意图（grill-with-docs）**——登记后、动手前，先跑 `/skill:grill-with-docs`（mattpocock/skills 库：内部为 grilling 访谈 + domain-modeling 建模）与人类把意图、边界、术语问清，**对齐产物必须落盘**：逐条对齐文档落 `todos/align/<名>#<id>.md`（四小节 `意图/范围/验收标准/人工确认`，由 `align` 做结构校验；门形态见 `docs/adr/0003-todo-align-gate.md`）、术语与领域词汇进 `CONTEXT.md`、决策进 `docs/adr/`；只留在会话里的对齐视为没对齐。
3. **规格落盘（to-spec）**——对齐后用 `/skill:to-spec` 把结论综合成规格文档（问题陈述/方案/用户故事/实现决策/测试决策/范围外）落盘到 `docs/specs/`；规格与实现同变更同步，不许只活在会话或工单里。需求跟踪始终以 `todos/` 为准（第 1 步），不引入外部 issue tracker。
4. **一律 worktree 实现**——从主干（`dev-laptop`）开 `.worktrees/<短名>`：`git worktree add .worktrees/<短名> -b feat/<插件名>-<事项> dev-laptop`；主干工作区只做评审、只读命令与 `todos/` 登记（自测、合并与清理在第 7 步）。
5. **TDD 测试先行**——新能力、bug 修复与重构一律测试先行：先写能复现问题或锁定新行为的失败测试（红），再实现到绿；没有保护网不动被测代码。
6. **docs/ 卡同步**——动手前先读 `docs/INDEX.md` 路由到的对应卡片；改完代码须同一变更内同步该卡（含头部 `last verified @ <commit>` 行）；新增插件必须同变更内建卡并在 INDEX 登记；横切契约（错误码/端口/消息键）变更同步 `docs/cross/` 对应文件；新事故记入 `docs/incidents.md`。
7. **交付四处同步 + 收尾**——自测达标（全量测试绿 + `npm run typecheck` 零错误）才回主干 `git merge --no-ff`（冲突就地解决不绕行），合完确认主干正常即 `git worktree remove`，并确认对齐门已过（对齐文档 + 人工确认）后 `complete --note` 收口 `todos/` 条目。任务结束前逐项核对：根/扩展 README（新增/变更功能、用法与实测测试数——测试数唯一来源）、AGENTS.md（架构/布局/约定/命令变化时）、根/扩展 `package.json`（被触及的扩展 bump `version`，根版本与发布特性版本对齐）、`docs/` 相关内容（不再成立的直接删除，仍成立的更新 last verified）。`todos/` 的插件文件与插件目录、根 `package.json` 的 `pi.extensions` 注册保持一一对应（`todo-cli`、`agent-manager` 是既有非插件工具文件，不参与；`node .agents/skills/todo-cli/todo-cli/todo.mjs lint` 校验）。文档/清单更新在同一 push 中以独立 commit 提交（`docs:` / `chore(pi):` 前缀）。

### 全程硬约束（任何阶段都适用）

8. **仓库边界**——默认只改本仓库内文件。宿主 npm 全局安装（`@earendil-works/pi-coding-agent` / `pi-tui` 的 `dist/`、`bundle/chunks/` 等）、其它全局包、用户配置（`~/.pi/agent/`）、系统文件一律不动。宿主/依赖行为不满足需求只有两条路：① 插件侧用公开扩展 API 解决；② 向上游提 issue/PR（或请用户人工处理）。确需动仓库外文件：先说明「改哪个文件、为什么、风险、回滚方式」，取得用户对具体改动的逐次明确同意，改完在交付报告中登记（文件、备份、回滚）；仓库内文档/待办不得把「已应用宿主补丁」当作插件行为的前提或契约；违反本规则的历史改动一律还原并在 `todos/` 记录真实状态。
9. **命令必须显式超时**——每次执行命令都传 bash 工具的 `timeout` 参数：快速 shell 操作（ls/grep/git）30–60 秒，`npm test`/`npm run typecheck` 120–300 秒；不允许不带超时的命令，长工作拆成多个有界小步骤。
10. **团队方案先审批**——agent team 出具方案后、实施改动之前，必须用 `team_ask` 把方案交用户审批并取得明确同意；未获同意（含超时/取消/无法提问）不得开始写代码或改文件，只停下如实报告；只读排查与评审不受限，审批结论随 run 记录留存。

## 关键目录

- `docs/` — agent 知识库，入口是 [`docs/INDEX.md`](docs/INDEX.md) 路由表：`extensions/<插件名>.md` 每插件一卡、`cross/` 横切契约、`tools/<工具名>.md` 仓库工具卡、`adr/` 决策记录、`specs/` 规格（红线 3）、`incidents.md` 事故与教训。卡片只写代码读不出来的知识（决策原因/不变量/契约/坑），不抄 API；每卡 ≤100 行、头部带 `last verified @ <commit>`，改代码须同步对应卡片与该行。
- `test/` — 仓库根自检（状态条契约 / 安装冒烟纯逻辑）；todo CLI 的测试随工具住在 `.agents/skills/todo-cli/todo-cli/test/`，由根脚本 `npm run test:todo` 指向该 glob（命令见下节）。
- `tools/` — 仓库级工具：`install-smoke.mjs`（全新临时配置目录 + 真实 `pi --mode rpc`，验 14 扩展加载）。用法见脚本头与 `docs/tools/`。
- `.agents/skills/todo-cli/` — 仓库内项目级 skill：`SKILL.md`（命令参考卡）+ `scripts/todo.sh` 包装器 + `todo-cli/`（todo CLI 入口与实现同居，任意 git 仓库任意 cwd 可用；仓库根解析 = `--root` > `git rev-parse --show-toplevel`，见 `docs/tools/todo-cli.md`）。
- `src/extensions/<插件名>/` — 14 个自包含插件（`index.ts` 入口 + 就地测试）；模块地图、不变量与坑见 `docs/extensions/<名>.md` 与各自 README；pwr 的完整架构/安全不变量/版本历史在 `src/extensions/pwr/DELIVERY.md`。
- `agent-manager/` — 独立 Node 工具，**非扩展**：不 import 宿主 SDK、不注册 pi 扩展点、已从根 `pi.extensions` 注销，仅 listen `127.0.0.1`；边界与数据流见 `docs/tools/agent-manager.md`。
- `history/team-runs/<runId>/` — repo-dev 团队 run 的本地留档目录（`history/` 已 gitignore，不入库）：每 run 固定七份文档 `00-task` / `10-design` / `20-writer-N` / `30-integration` / `40-review` / `50-acceptance` / `90-run-report`，头部带元数据（runId / 日期 / 参与成员），单作者执笔、定稿后只追加不改写。

## 开发命令

测试数与各扩展完整用法见根 `README.md`（唯一来源）；无构建步骤、无 linter、无 formatter。

```bash
cd src/extensions/pwr && npm install   # 依赖全部是 devDependencies
npm test                       # node --test 覆盖 test/、tests/、runtime/test/、runner/test/
npm run typecheck              # tsc -p tsconfig.json --noEmit
# 子集示例：
node --test tests/ui-*.test.ts
node --test runtime/test/scheduler.test.ts
```

仓库根（无任何依赖）：

```bash
npm run test:all        # 全仓 19 套件一条命令（逐条计时/失败聚合；--jobs N 调并发；见 docs/tools/test-all.md）
npm run test:contract   # 状态条契约（doc → docs/cross/status-bar.md）
npm run test:smoke      # 安装冒烟工具的纯逻辑单测
npm run test:todo       # todo CLI 单测（随工具住在 .agents/skills/todo-cli/todo-cli/test/，含进程边界 E2E）
node .agents/skills/todo-cli/todo-cli/todo.mjs summary # todo 全量盘点
node tools/install-smoke.mjs                           # 端到端：临时配置目录 + 真实 pi，验 14 扩展加载（需已装 pi）
node tools/install-smoke.mjs --task                    # 追加真实模型任务（需鉴权 + 网络）
node tools/install-smoke.mjs --install <pi install 源> # 真跑 README 推荐安装路径（联网）
```

扩展 + 独立工具（不在 pwr 脚本覆盖范围内）：

```bash
cd src/extensions/stream-token-speed && node --experimental-strip-types --test test/*.test.ts
cd src/extensions/agent-team && npm install && npm test            # 另 node test/resume-host-smoke.mjs（真实 pi --session 续写）
node --experimental-strip-types --test src/extensions/run-timer/run-timer.test.ts src/extensions/run-timer/aligned-ticker.test.ts
node --experimental-strip-types --test src/extensions/goal/index.test.ts src/extensions/goal/aligned-ticker.test.ts
node --experimental-strip-types --test src/extensions/human-notify/index.test.ts
node --experimental-strip-types --test src/extensions/solo-mode/index.test.ts
cd src/extensions/timeout-bg && npm install && npm test && npm run typecheck
node --experimental-strip-types --test src/extensions/provider-quota/index.test.ts
node --experimental-strip-types --test src/extensions/chatanywhere-provider/test/*.test.ts
cd src/extensions/typesafe && npm install && npm test && npm run typecheck
cd src/extensions/loop && npm install && npm test && npm run typecheck
cd src/extensions/opencode-bridge && npm install && npm test && npm run typecheck
cd agent-manager && npm install && npm test && npm run typecheck   # 另 npm run test:e2e opt-in（需 AGENT_MANAGER_E2E_MODEL + 鉴权 + 网络）
cd src/extensions/deep-init && npm install && npm test && npm run typecheck
```

## 代码约定与常见模式

tsconfig（`src/extensions/pwr/tsconfig.json`）强制承载性规则——违反将导致 `npm run typecheck` 失败：

- **ESM NodeNext，所有相对导入显式带 `.ts` 扩展名**：`import { ApprovalStore } from "./src/approval.ts";`
- **类型导入必须用 `import type`**（`verbatimModuleSyntax`）：`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`
- **禁用 enum/namespace/参数属性**（`erasableSyntaxOnly`）：错误码用 `as const` 对象——`export const ErrorCodes = { … } as const;` + `type ScriptErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];`（见 `src/extensions/pwr/engine/errors.ts`）。
- `strict: true`、`noEmit`、`allowImportingTsExtensions`、`isolatedModules`、`noImplicitOverride`。

其他模式：

- **结果联合优先于异常：** 全代码库统一 `{ ok: true, value } | { ok: false, code, message }`；调用方用判别联合收窄（`if (r.ok) … else assert.equal(r.code, …)`）。每层有自己的错误码集（pwr）：`src/errors.ts`（20 个）、`engine/errors.ts`（7 个）、`runtime/errors.ts`（7 个）、`runner/errors.ts`（5 个）。脚本失败携带源码位置（`ScriptError`）。
- **依赖注入经 deps 对象与注入端口：** `FlowDeps`、`ToolDeps`、`SaveAdapter`、`UiRuntimeAdapter`、`SaveFlowActions`、`RunPersister`；不用 mock 库、无全局注入。
- **注入时钟保证确定性：** 用 `now: () => string` / `nowMs` 参数而非 `Date.now()`；测试固定 `2026-08-05T12:00:00Z`。
- **状态管理：** runtime 用显式迁移表（`runtime/state.ts` 的 `TRANSITIONS` + `ALLOWED_OPERATIONS`，`assertTransition` → `ILLEGAL_STATE_TRANSITION`）；UI 用 `RunEvent` 供数据给 `MemoryRunStore` 同步快照。（本条与下述 pwr 内部路径均相对 `src/extensions/pwr/`）
- **异常隔离：** 每个 UI/观察者/持久化调用均 try/catch——"持久化失败绝不破坏会话"。
- **文件头注释** 引用 JHL 工单号 + PRD 章节（`* PWR - Pi Workflow Runtime extension entry (JHL-16 trigger/generation/approval + JHL-17 save/load & parameter commands)`）。保持同步更新。
- **安全不变量**（PWR）：无 `vm`/`eval`；执行前白名单校验；fail-closed 默认（缺 engine/runner ⇒ 类型化错误，无隐式回退）；脚本源码/args 永不持久化；`pwr-tmp://` 仅进程内；不存 API key；错误信息为静态模板。
- **Typebox** 用于工具参数 schema（`src/tools.ts` 的 `registerPwrTools`、`agent-team` 的 `manage.ts`/`index.ts`）。
- **TUI 约定（其余扩展）：** 写入前用 `ctx.hasUI` 守卫，样式经 `theme.fg("dim", …)`，每个 `setStatus`/`setWidget` 调用均异常隔离，每扩展一个状态键。`loop/` 传纯（无样式）字符串给 `setWidget`——`ExtensionUIContext` 无 `theme` 字段，对 `ctx.ui.theme` 的类型化访问无法编译。
- **状态条契约（跨插件）：** 唯一权威在 `docs/cross/status-bar.md`——秒对齐 `aligned-ticker.ts`、写入前文本指纹、footer 排序前缀、段分隔与首段定格、widget 排序带（编辑器上方三段合并成宿主单键 `widget-band`，顺序由 band key 保证；宿主每次 setWidget 都 delete+set 的沉底行为本仓库不打补丁，走上游 issue）。改任何状态条/widget 行为前先读该卡。
- 缩进：`src/extensions/pwr/` 用 tab，`src/extensions/` 下其余插件目录（`agent-team/`、`run-timer/`、`stream-token-speed/`、`loop/`、`goal/`、`opencode-bridge/`、`deep-init/`、`human-notify/`、`solo-mode/`、`timeout-bg/`、`typesafe/` 等）与 `.agents/skills/todo-cli/todo-cli/`、`agent-manager/` 用 2 空格。
## 编码规范（Clean Code）

以上章节描述现状；本节规定新代码怎么写。倾向简单——清晰的代码不是炫技的代码，没有代码胜过投机性的代码。

- **命名表意：** 可读、可搜索、不用编码后缀（`strName`、`iCount`）或噪音词（`Data`、`Info`、`Manager`）。复用仓库领域词汇（`run`、`dispatch`、`approval`、`digest`、`entry`）；同一模块内同一操作只用一个动词——不要 `fetch`/`get`/`load` 混用。
- **函数只做一件事：** 小（目标 < 40 行）、每函数单一抽象层级、早返回代替深嵌套（`if` 嵌套 ≥ 3 层 ⇒ 重构）。有副作用就写进名字（`saveApproval` 而非 `checkApproval`）。
- **参数要少：** 位置参数 ≤ 3 个，超出则用 deps/options 对象（对齐 `FlowDeps`/`ToolDeps`）。禁用选择行为的布尔标志参数——拆分函数或改传字符串字面量联合。
- **类型优于真值判断：** 用带显式标签（`ok`/`kind`）的判别联合，不用可选字段堆砌；`unknown` + 收窄，禁止 `any`；最小导出面——出现第二个调用方之前保持不导出。
- **错误遵循所在层的 result union：** 新失败模式必须在所属层的 `errors.ts` 中登记错误码（不用临时字符串码），消息用静态模板——不插值用户输入或密钥。
- **注释解释 why 而非 what：** 删掉代码已表达的内容；文件头保留 JHL 工单号（见上方约定）；注释/文档用中文，标识符用英文。
- **不过度设计（YAGNI）：** 不做只有单一调用方的配置项、只有一个实现的策略/插件层、只有一个具体类型的接口——除非它是测试需要 fake 的进程边界（此时沿用现有 deps/port 模式作接口）。重复好过错误的抽象；第三次出现才提取（rule of three）。
- **通过现有接缝扩展：** 新增能力的方式是加一个模块并在 `index.ts` 接线，或扩展 deps/port 对象——而不是把标志参数穿透深层。新上限/常量进所属层的规范文件（pwr 的 `engine/spec.ts`、`src/types.ts`），调用点不写魔法数。这就是全部扩展方式：今天的接缝足够应对明天的需求；有具体需求到来时再回来改。
- **让代码更好而不是更大：** 每次改动保持全量测试 + `npm run typecheck` 绿；死代码与"以防万一"分支直接删除，不注释保留。

## 运行时/工具链偏好

- **Node ≥ 22.18**（原生 type-stripping——`.ts` 直接运行；已在 Node 22.23.1 / Windows 验证）。不用 Bun、无构建步骤、无 bundler。
- **npm**（package-lock v3）。包管理器不是 Bun/pnpm。
- TypeScript ^5.8（解析为 5.9.3）；`@earendil-works/pi-*` ^0.85.1 仅作 devDependencies——宿主 Pi 环境在运行时解析它们。
- 工作区使用的 Pi 扩展 API 面：`pi.on`（`session_start`、`agent_start`、`agent_settled`、`turn_start/end`、`model_select`、`message_start/update/end`、`input`、`before_agent_start`、`tool_call`、`tool_result`）、`pi.registerCommand`、`pi.registerTool`、`pi.registerProvider`、`pi.registerShortcut`、`pi.registerEntryRenderer`、`pi.appendEntry`、`pi.sendMessage`、`ctx.ui.setStatus/setWidget/notify`、`ctx.sessionManager.getEntries`。
- 配置经环境变量（`CHATANYWHERE_API_KEY`、`CHATANYWHERE_BASE_URL`）或 `~/.pi/agent/auth.json` 按 provider id 键（provider-quota——明确不用环境变量）。
- 安装形态：所有扩展都是带 `index.ts` 入口的目录（chatanywhere-provider 另在 package.json 声明 `pi.extensions: ["./index.ts"]`）；目录复制进 `extensions/` 后 pi 自动加载。
  - **package 形态（本项目实际用法）**：`~/.pi/agent/settings.json` 的 `packages` 里是本仓库 git 源（`git:github.com/JHzzzzzZ/pi-agent-extensions@dev-laptop`），pi 加载的是**包缓存 clone**（`~/.pi/agent/git/github.com/<owner>/<repo>`），**不是**当前工作仓库。因此「本地 commit 了但 pi 里还是旧行为」是常态：改动要生效必须 ① push 到该源分支，再 ② 让 pi 刷新缓存（`pi update` / 重启会话）。2026-09-15 真机教训：按此口径，未 push 的本地 commit 做出的「修复后」验收会跑到修复前的代码上（反向也是礼物——它天然给出修复前的对照组）。

## 测试与 QA

- **测试要抓住真正的问题，不止"纸面正确"：** 纯函数单测绿 ≠ 真机行为对——此前 /team:view 修堆叠三轮正栽在"纸面正确"上：纯函数单测全绿，真机照样重影。凡风险在宿主/进程边界（真实渲染管线、子进程契约、时钟/IO），测试必须接到真实实现上跑：agent-team `viewer-host.test.ts`（真实 `TuiMainScreen` + 假终端 headless 渲染）与 `viewer-mutex.test.ts`（打开互斥）各自抓住了纯函数测不出的 bug。纯函数测试只用于真正隔离的逻辑，并在文件头写明边界与动机。
- **框架：`node:test` + `node:assert/strict`**——无 vitest/jest、无 mock 库。pwr、stream-token-speed、goal 用扁平 `test("名称", fn)` 命名（叙述式断言，部分中文名）；`run-timer.test.ts`（50 个 `it`，经 before/after 钩子 mock `setTimeout`）与 `loop/test/` 用 `describe`/`it`。统一 `*.test.ts` 后缀。
- **Mock = 进程边界手写 fake：** fake `AgentRunner`（`makeFakeRunner`，`src/extensions/pwr/test/helpers.ts`）、fake pi 子进程（`FakeChild` + `makeFakeSpawn` + `waitForChild`，`src/extensions/pwr/runner/test/helpers.ts`）、`RecordingStatusPort`（`src/extensions/stream-token-speed/test/fixtures.ts`）；fake 只作进程/IO 边界替身，不做被测行为的"纸面替身"。测试目标本身是被测逻辑依赖的宿主组件（如 agent-team viewer 渲染）时，实例化真实组件、只 fake 终端（见 `viewer-host.test.ts`）；结构 fake（`as never`）仅用于宿主交互确实不在测试范围的情形。
- **集成模式：** 接线真实模块（`PiAgentRunner` + `WorkflowRuntime` + `MemoryPersister`），mock spawn、脚本化子进程事件、轮询 `waitSettled`（10ms × 100）——见 `src/extensions/pwr/runner/test/integration.test.ts`（happy path + `restart_agent` 语义；`handle.records.length` 证明缓存回放不派生进程）。
- **性能门：** `src/extensions/pwr/test/perf.test.ts`——约 1500-agent / ~64KB 脚本的 `validateScript` 必须在 300ms（墙钟）内完成。
- **测试数：** 唯一来源是根 `README.md`（AGENTS.md 不再复制数字，防过期）。

- **覆盖缺口：** 全库无 TODO/skip/only 标记。
