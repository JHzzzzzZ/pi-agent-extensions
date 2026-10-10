# remote-tools — 内置工具的 SSH 远程后端

> last verified @ 0558752（真机验收修复见后续 fix 提交）

一句话：给 `read`/`write`/`edit`/`bash`/`grep`/`find`/`ls` 加 `remote`（`"[user@]host"`）、`remotePort`、
`remoteCwd`（仅 bash）三个可选参数——**`remote` 非空即路由到远端主机，留空则与内置行为逐字一致**。
需求与验收见 `todos/align/remote-tools-todo#1.md`。

## 为什么这么做（决策原因）

- **不动内置工具的参数面，也不存在「加参数到宿主 dist」这条路**：宿主把 8 个内置工具的执行后端做成了
  **公开可替换的 Operations 接缝**（`dist/core/tools/*.d.ts` 的注释原文就是 *"Override these to delegate
  command execution to remote systems (for example SSH)"*），扩展 `pi.registerTool()` 注册同名工具会覆盖
  内置定义（`dist/core/agent-session.js`：built-ins 先入注册表、custom tools 后入）。官方 Gondolin 扩展是同一做法。
- **保真优先于自研**：六个工具直接复用宿主的 `createXxxToolDefinition` + 远端 Operations，所以截断、限流、
  渲染器、提示词片段全部天然一致；`remote` 为空时调宿主本地实现 ⇒ 「退化为原始」是委托而不是复刻。
- **只有 grep 必须重写**：`GrepOperations` 只有 `isDirectory`/`readFile`，真正的搜索是本地 `spawn` ripgrep，
  接缝覆盖不到（Gondolin 也是整份重写）。代价是 grep 的自定义渲染器回落到宿主默认渲染。
- **不做「同步下来改完传回去」**：read/ls/find/bash 远端直接执行即可，write/edit 只需单文件 pull→改→push
  （Operations 只要 `readFile`/`writeFile`/`access`），整树镜像会带来过期与冲突风险且传得更多。
- **零运行时依赖**：只用系统 `ssh`（Windows 自带 OpenSSH 够用），不引入 `ssh2` 之类的包；也意味着
  不做密码登录（不存凭据），只用密钥 / ssh-agent。

## 不变量（改代码前必须知道）

- **本地分支绝不触网**：`remote` 为空时直接调宿主本地定义，不 spawn ssh（`test/tools.test.ts` 用「假 exec 一旦被调用就抛错」锁住）。
- **路径换算只有一个出口**：交给内置工具的远端路径一律经 `toHostPath`（`//pi-remote` 前缀，命中宿主
  `normalizeWindowsShellPath` 的 UNC 早退分支，既不注入盘符也不动大小写），ops 层经 `toRemotePath` 还原。
  没有标记的形态原样返回、由 `validateRemotePath` 拒绝——**模型给的 `C:/…` 与相对路径在发 ssh 之前就 fail-closed**。
- **校验先于 ssh**：目标形态（前导 `-` / 空格 / 多 `@` / 内嵌端口）、端口范围、路径形态三者在任何 ssh 进程之前完成。
  绝对路径不需要远端 `$HOME` ⇒ 不为此多发一次 ssh（只有省略/相对路径才解析，且同目标只解析一次）。
- **已知主机指纹 fail-closed**：`BatchMode=yes` + `StrictHostKeyChecking=yes`；未收录指纹/认证失败报
  `SSH_CONNECT_FAILED` 并提示先在终端手工 ssh 一次，绝不 accept-new。
- **远端环境只给白名单**：转发 `PI_SESSION_ID`/`PI_SESSION_FILE`/`PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL`
  （与宿主 `resolveSpawnContext` 自己维护的那五个一致）。**不能用 `PI_` 前缀匹配**——实测环境里存在
  `PI_WEB_TOKEN` 这类宿主敏感变量，前缀匹配会把它们送进远端命令（`test/ops.test.ts` 锁住）。
- **错误消息全静态模板**：不插值远端路径内容或远端输出，避免把远端内容回灌进模型上下文；错误码在 `errors.ts`。
- **降级要在同一次往返里上报**：远端缺 rg 时不额外探测（多一轮 ssh），而是在同一条远端命令里分支、
  用 stderr 上的 `PI_REMOTE_TOOLS_DEGRADED` 标记回传，再在结果里附 `[远端缺少 ripgrep，已回退 …]`。

## 文件地图

- `index.ts` — 扩展入口：`registerRemoteTools(pi, { exec: createSpawnExec(), cwd: process.cwd() })`
- `tools.ts` — 7 个同名覆盖的接线：schema 拼接（内置参数 + remote 三件套）、本地/远端分派、
  `resolveToolPath`（校验 + $HOME 懒解析）、`remoteContext`（把内置定义的 `ctx.cwd` 换成远端基准）、
  session 缓存（同目标共享、`$HOME` 只解析一次）
- `ops.ts` — 远端 Operations 后端：read/write/edit/ls/find/bash 的远端原语（`if [ -e ]` 一次往返区分
  「不存在/是目录/正常」）、`createRemoteSession`、find 的 rg/find 双分支命令、`formatEnvPrefix` 白名单
- `grep.ts` — 整份重写的远程 grep：`rg --json` 解析 + 与内置同形的输出/限流/截断，rg 缺失时 GNU grep 回退
- `paths.ts` — 宿主路径空间 ↔ 远端 POSIX 路径空间的换算（`toHostPath`/`toRemotePath`/`stripHostMarker`）
- `ssh.ts` — 传输层与策略：`parseTarget`/`buildSshArgs`/`shellQuote`/`validateRemotePath`/`runSsh`/
  `classifySshFailure`/`createSpawnExec`（进程边界端口，测试注入手写 fake）
- `errors.ts` — 错误码单源（`INVALID_REMOTE_*`/`SSH_*`/`REMOTE_*`/`RIPGREP_MISSING`）
- `test/` — 51 个：`ssh.test.ts`(10) / `paths.test.ts`(7) / `ops.test.ts`(14) / `grep.test.ts`(11) / `tools.test.ts`(9)；另有 6 个**真机 opt-in**（`remote-live.test.ts`，未设 `PI_REMOTE_TOOLS_TEST_TARGET` 时跳过）

## 真机验收（2026-10-10 已执行）

目标：本机 WSL Ubuntu（`user@127.0.0.1:22`，Linux 内核 + 已装 ripgrep），Windows 侧跑测试。6 个用例**全绿**：

```bash
PI_REMOTE_TOOLS_TEST_TARGET=user@127.0.0.1 PI_REMOTE_TOOLS_TEST_DIR=/home/user \
  node --test test/remote-live.test.ts
```

覆盖：建连 + 远端 `$HOME` 解析、bash 目录/退出码/缺目录结构化错误、ops 层 write→read→edit→ls 往返、
**工具层端到端**（注册覆盖 → `//pi-remote` 标记 → 宿主 path 解析 → ops 还原 → 远端 write/read/ls/grep（真 rg）/find/bash）、
远端不存在/无权限的结构化错误码、不可达主机 fail-closed。

两个只有真机才能发现的问题（已修 + 已加回归测试）：

1. **宿主形态不能是 UNC**：`withFileMutationQueue`（write/edit 内部）在本地做 `fs.realpath`，Windows 上
   `\\pi-remote\…` 报 `UNKNOWN: unknown error`（只容忍 ENOENT/ENOTDIR）⇒ 远端 write/edit 直接失败。
   改成平台相关宿主形态（Windows 用 `C:\pi-remote\…`；POSIX 用 `//pi-remote/…`），两者都让本地 `realpath` 以 ENOENT 失败。
2. **`test -r -w <path>` 是非法表达式**：POSIX `test` 三参数形态会以非零退出码失败，把可写文件误报成
   `REMOTE_NOT_WRITABLE`（edit 的 access 检查）。改成 `test -r <p> && test -w <p>`。

从 Git Bash 跑时注意：`PI_REMOTE_TOOLS_TEST_DIR=/home/user` 会被 MSYS 改写成 `C:/Program Files/Git/home/user`
（插件会正确拒绝它），加 `MSYS2_ENV_CONV_EXCL='*'` 即可。

## 测试口径（为什么这么测）

- **本地保真对照真实实现**：同一组参数分别打我们的定义与宿主 `createXxxToolDefinition`，在临时目录里比
  content —— 不是断言自己的分支（`find`/`grep` 依赖宿主外部工具 fd/rg，两边给出**同一个错误**也算保真）。
- **远端分派断言发给 ssh 的命令**：Windows 上宿主 path 解析会改写远端路径，这条断言就是那个 bug 的守门人
  （`test/tools.test.ts` 的「盘符污染守门人」用例）。真实 ssh 进程不在单测范围，用注入的假 `SshExec`。
- **纯函数穷举**：目标解析/端口/路径往返/事件解析/降级输出都是纯函数，逐条枚举。

## 坑

- **宿主 grep 的自定义渲染器拿不回来**：`grepRenderers` 未从包根导出，`pi.registerToolRenderer` 的
  `next()` 只到「本扩展注册的工具」为止；覆盖 `grep` 必然放弃那套渲染。
- **`createWriteToolDefinition` 的 details 类型是 `undefined`**（没有 `WriteToolDetails` 导出）；照抄别的工具签名会编译不过。
- **内置 bash 用 `ctx?.cwd || cwd` 当工作目录**：远端分支必须把 ctx 的 `cwd` 换成远端基准（`remoteContext`
  用 `Object.create` 覆盖，保留原型链上的 getter），否则远端命令会在本机项目目录上 `cd`。
- **清单三处同步**：根 `package.json` 的 `pi.extensions`、`tools/install-smoke.mjs` 的 `EXTENSION_EXPECTATIONS`
  （本扩展无命令无 uiKeys）、`tools/test-all.mjs` 的套件表（`install: true`）；漏一处 `test:smoke` / `test-all` 的漂移测试就红。
- **宿主对工具路径有本地副作用**：write/edit 的 `withFileMutationQueue` 会 `fs.realpath`、read 会 `accessSync`
  探本地变体（NFD / 弯引号）——所以宿主形态必须让本地 fs 以 ENOENT 失败（`C:\pi-remote\…`），不能用 UNC。
- **远端 `bash` 的中断只 kill 本地 ssh**：远端命令可能继续跑（v1 已记录，未做远端进程组清理）。
