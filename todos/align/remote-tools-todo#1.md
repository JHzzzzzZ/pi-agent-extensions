# 对齐：remote-tools-todo#1 — 内置工具的 SSH 远程执行后端

- 条目：`remote-tools-todo#1`（tags: `new-plugin`, `tool-routing`）· 分支引用：`feat/remote-tools-ssh-ops`
- 日期：2026-10-10（UTC）· 参与：用户（全部决策）+ agent（事实核查与方案）
- 状态：本轮会话逐条确认完毕，待用户放行进入 `processing`

## 意图

让 Pi 的 7 个内置工具（read / write / edit / bash / grep / find / ls）能对**远端主机**操作：调用时带上可选参数 `remote` 就路由到远端，`remote` 为空时行为与今天完全一致。目标场景是「本地 Windows 上的 Pi，改远端 Linux 上的代码」，不引入任何运行时常驻服务或 npm 依赖。

已核实的事实（宿主 `@earendil-works/pi-coding-agent` 1.0.1，仓库 devDependency 内已确认同版本；路径相对该包根）：

1. 内置工具的执行后端是**公开可替换的 Operations 接口**（`dist/core/tools/*.d.ts`），注释原文：*"Override these to delegate command execution to remote systems (for example SSH)"*。
2. 扩展 `pi.registerTool()` 注册同名工具**覆盖内置定义**：`dist/core/agent-session.js:2795-2800`（built-ins 先入 Map，custom tools 后入覆盖）。官方 Gondolin 扩展正是此做法（`docs/containerization.md`、`examples/extensions/gondolin/index.ts:443-520`）。
3. `grep` 是唯一例外：`GrepOperations` 只含 `isDirectory` / `readFile`，ripgrep 由**本地** `spawn` 执行（`dist/core/tools/grep.js:101`）⇒ 远程 grep 必须整份重写。
4. `find` 可插拔：提供了 `glob()` 就不再使用本地 `fd`（`dist/core/tools/find.js:68-78`）。
5. `bash` 的参数只有 `{command, timeout}`，**没有 cwd**；cwd 是创建工具时烤进去的，所以远端目录必须另外给。
6. 本机已具备系统 ssh（OpenSSH_9.7p1），`~/.ssh/` 有密钥与 3 条 known_hosts 记录 ⇒ 真机验证路径可行，目标主机在使用时由用户指定。

## 范围

**做什么**

1. 新插件 `src/extensions/remote-tools/`（`index.ts` 入口 + 就地测试 + `package.json`，零运行时依赖，只调用系统 `ssh`）。
2. 同名覆盖 7 个内置工具，参数增补：`remote`（`"user@host"`）、`remotePort`；`bash` 另加 `remoteCwd`。
3. `remote` 为空 ⇒ 委托宿主 `createXxxTool(cwd)` 的本地实现（零行为漂移，不自己复刻截断/图片/文件变更队列 semantics）。
4. 路径语义：模型**每次显式传远端绝对路径**（`path` 即远端绝对路径，不做本地→远端映射）；`bash` 的 cwd = `remoteCwd ?? 远端 $HOME`；`ls`/`find`/`grep` 省略 `path` = 远端 `$HOME`。
5. `grep`/`find` 优先在远端跑 `rg`；远端缺 rg ⇒ 回退远端 `grep -r` / `find`，并在结果里**明示降级**（`.gitignore` 不生效、输出格式与内置不一致）。
6. 传输与错误：一条 ssh 命令一次调用（**不启用 `ControlMaster`**——Windows OpenSSH 不支持连接复用，复用交给用户自己的 `~/.ssh/config`；列目录的 entry 类型在一次往返里预取，避免 N+1）；未知主机（known_hosts 无记录）fail-closed 报错并要求人工先 `ssh` 一次；连接超时/命令超时/非零退出映射到本插件 `errors.ts` 的错误码（result union，不抛未捕获异常）。
7. 文档与登记：`docs/extensions/remote-tools.md` 卡片 + `docs/INDEX.md` 登记 + 根 README 用法与测试数 + 根 `package.json` 的 `pi.extensions` 注册。

**明确不做什么**

- 不覆盖 `powershell` 工具（远端场景是 Linux；本地 Windows 行为保持不变）。
- 不做整树同步 / 镜像上下传（read/write/edit 单文件直连远端，grep/find/ls/bash 直接远端执行）。
- v1 不做只读开关（远端写权限由远端账号决定）；不做本地↔远端路径映射；不做主机白名单（`remote` 自由填写，见「已知风险」）。
- 不改宿主 `dist/`、不引入 npm 依赖、不存储任何凭据（复用密钥/ssh-agent）。

## 验收标准

1. **本地保真**：`remote` 为空时 7 个工具行为与宿主内置逐字一致（read 的 offset/limit 与截断、edit 的多段替换与 `withFileMutationQueue`、bash 退出码与流式输出、grep 的 `context`/`limit`/`literal`、find 的 `ignore`/`limit`）。用同一组参数对「覆盖后的工具」与「`createXxxTool` 原始工具」做对照断言。
2. **真机远端可用**：对一个真实 ssh 目标 —— read/write/edit 能读改远端文件；bash 在 `remoteCwd`（缺省 `$HOME`）下执行；grep/find/ls 能作用在远端目录；`remote` 为空时该工具绝不触网。
3. **失败路径结构化**：远端路径不存在、无权限、端口错误、连接超时、ssh 认证失败 ⇒ 明确的错误码与静态模板消息，不落本地文件、不静默成功。
4. **降级可观测**：远端缺 rg 时走回退实现，结果里带「未使用 ripgrep（.gitignore 不生效）」标注。
5. **测试**：`node:test` + `node:assert/strict`；ssh 命令构造、参数与路径校验、降级分支、错误映射用**进程边界手写 fake**（沿用 pwr `makeFakeSpawn` 模式），真机 E2E 走 opt-in 环境变量门（无目标时 skip 但不静默绿）。
6. `npm test` + `npm run typecheck` 全绿；红线 7 的四处文档同步完成。
7. **跨厂商独立评审**（红线 11）：reviewer 与开发者不同模型家族，逐条处理意见，直到某轮无新意见。

## 人工确认

- **确认人**：用户（本会话）·**日期**：2026-10-10（UTC）·**方式**：对话内结构化选项逐条选择（每轮问题卡随选项附推荐答案与取舍）
- **逐条决策**：
  1. 参数形态 = **每次调用带 `remote` 参数**（per-call；空 = 本地）
  2. 覆盖范围 = **全套 7 个工具**一次做完
  3. 鉴权 = **已配 ssh 密钥 / agent**（插件不碰凭据）
  4. 主机语法 = **`remote: "user@host"` + 独立 `remotePort`**
  5. 路径 = **每次调用传远端绝对路径**（不做映射）
  6. 只读 = **v1 不做**，靠远端账号权限
  7. `remote` 为空 = **委托宿主本地实现**
  8. 远程 bash 目录 = **新增可选 `remoteCwd`**，缺省远端 `$HOME`
  9. 省略 `path` = **远端 `$HOME`**
  10. 远端缺 rg = **回退远端 `grep -r`**（接受 `.gitignore` 不生效的语义差）
- **agent 提出、用户未反对的默认值**（若不同意，在任何一轮回复中推翻即可）：未知主机指纹 fail-closed（不自动 accept-new）；不做主机白名单；ssh 连接复用；不写状态条/widget（避免触碰 `docs/cross/status-bar.md` 契约）。
- **已知风险（显式接受）**：① 自由填写 `remote` ⇒ 模型可被诱导连任意主机（v1 无白名单）；② 无路径映射 ⇒ 远端路径由模型给出，写错即报错（fail-closed，不误写本地）；③ rg 回退路径语义弱于内置。
- **开工放行**：进入 `processing`（第二次 `claim`）前，需用户在本轮回复中明确同意。
