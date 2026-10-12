# remote-tools — 内置工具的 SSH 远程后端

> last verified @ 74e6222

一句话：给 `read`/`write`/`edit`/`bash`/`grep`/`find`/`ls` 加 `remote`（`"[user@]host"`）、`remotePort`、
`remoteCwd`（仅 bash）三个可选参数——**`remote` 非空即路由到远端主机，留空则与内置行为逐字一致**；另向 `dir-context` 提供「取远端目录上下文」跨扩展能力（`context.ts`）。
需求与验收见 `todos/align/remote-tools-todo#1.md`。

> **与 dir-context 的交叉面**：带 `remote` 的调用 `path` 在远端解析，所以 `dir-context` **默认不会**为它注入本机（甚至远端）的 `AGENTS.md`——它只看入参有没有 `remote` 字段，不 import 本插件任何模块。本插件另经 `pi.events` 向它提供一个「取远端目录上下文」能力（`context.ts`）：一条 ssh 取该目录祖先链上的 `AGENTS.md`/`CLAUDE.md`，**注入规则仍全在 dir-context**。契约见 [`docs/cross/remote-context-capability.md`](../cross/remote-context-capability.md)。

## 为什么这么做（决策原因）

> 架构决策全文（含「路径信道」的根因与硬化取舍）见 [`docs/adr/0010-remote-tools-host-operations-seam.md`](../adr/0010-remote-tools-host-operations-seam.md)；
> 需求规格（问题/方案/用户故事/实现与测试决策/范围外）见 [`docs/specs/remote-tools.md`](../specs/remote-tools.md)。

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
- **路径换算只有一个出口，且标记根结构上不可占用**：交给内置工具的远端路径一律经 `toHostPath`，前缀是 **标记根**
  `<扩展目录>/index.ts/pi-remote`（锚在一个**已存在的普通文件**下：只要锚文件还是普通文件，本地就**建不出**这个目录
  ——实测 Windows `mkdir -p` → `ENOTDIR`、`realpath` → `ENOENT`，所以宿主 read 的本地变体探测没有可命中的本地文件），
  ops 层经 `toRemotePath` 还原。没有标记的形态原样返回、由 `validateRemotePath` 拒绝——**fail-closed 的只有 Windows 盘符形态、`~` 开头、宿主标记首段**（`assertModelPathInput` + `validateRemotePath`，都在发 ssh 之前）；
  相对路径/省略 `path` 按**远端 `$HOME`** 解析（同目标只解析一次）——`#11` 修正过这里一处自相矛盾的旧表述（曾写成「相对路径也 fail-closed」，实测不是）。
  配套运行时守卫 `assertMarkerRootUsable`：锚文件不是普通文件时远端调用 fail-closed 报 `HOST_MARKER_CONFLICT`（本地分支零影响）。
- **校验先于 ssh**：目标形态（前导 `-` / 空格 / 多 `@` / 内嵌端口）、端口范围、路径形态三者在任何 ssh 进程之前完成。
  绝对路径不需要远端 `$HOME` ⇒ 不为此多发一次 ssh（只有省略/相对路径才解析，且同目标只解析一次）。
- **主机指纹 TOFU**（`#15`，用户 2026-10-12 选定）：`BatchMode=yes` + `StrictHostKeyChecking=accept-new`——未知主机
  首次连接由 **ssh 自己**把指纹写进 `known_hosts`（零人工前置，不再需要先手工 ssh / ssh-keyscan），
  **已收录主机的指纹变更仍 fail-closed**（`REMOTE HOST IDENTIFICATION HAS CHANGED` 与 `Host key verification failed`
  同归 `SSH_CONNECT_FAILED`，文案给 `ssh-keygen -R <host>` 的排查入口；客户端不支持该选项（OpenSSH < 7.6 报
  `Bad configuration option`）同样归 `SSH_CONNECT_FAILED`）；不自行跑 `ssh-keyscan`——自己抓公钥自证
  并不比 TOFU 强，还多一条外部命令。代价：首次连接不校验对端身份（TOFU 固有）；命令行 `-o` 优先于 `ssh_config`，
  所以想要回严格模式只能改代码（本条目 `reopen` 重议）。
- **结果/报错文案不回灌宿主标记路径**（`#16`，用户 2026-10-12 实测）：宿主把自己的**入参 `path` 原样**插进成功
  文案（`Successfully wrote to ${path}`）、`details.patch` 头（`edit.js:129` 的 `generateUnifiedPatch(path, baseContent, newContent)`，
  其内部是 `Diff.createTwoFilesPatch(path, path, …)`）与一族报错
  （`Could not edit file: ${path}`、`Could not find the exact text in ${path}`、read 的大行提示），而远端分支按标记
  路径信道**必须**传宿主形态 ⇒ 模型会读到「写到了 `C:\…\pi-remote\…`」这种本地假路径。`tools.ts` 的
  `withRemotePaths` 在出口处把**我们传进去的那个字符串**换回远端绝对路径（精确替换，不是猜文案格式），
  同时作用于 content 文本、`details.patch`/`diff`、`structuredContent`（宿主 `read.js` 末尾从改写前的 content
  派生的第二个出口，codemode 消费方走它）与抛出的错误；本地分支不走这条路径（逐字不变）。
  残留风险（已知可接受）：read 分支的改写作用于整个 content，所以**文件内容**里恰好出现该文件自身的宿主标记
  路径时也会被换掉（概率可忽略，且标记形态本就是本扩展的私有信道）。
- **远端环境只给白名单**：转发 `PI_SESSION_ID`/`PI_SESSION_FILE`/`PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL`
  （与宿主 `resolveSpawnContext` 自己维护的那五个一致）。**不能用 `PI_` 前缀匹配**——实测环境里存在
  `PI_WEB_TOKEN` 这类宿主敏感变量，前缀匹配会把它们送进远端命令（`test/ops.test.ts` 锁住）。
- **错误消息全静态模板**：不插值远端路径内容或远端输出，避免把远端内容回灌进模型上下文；错误码在 `errors.ts`。
- **降级要在同一次往返里上报**：远端缺 rg 时不额外探测（多一轮 ssh），而是在同一条远端命令里分支、
  用 stderr 上的 `PI_REMOTE_TOOLS_DEGRADED` 标记回传，再在结果里附 `[远端缺少 ripgrep，已回退 …]`。
- **凡是要交回宿主的远端路径都必须带宿主标记**：不只输入（`toHostPath`），**输出也一样**（find 的 `glob` 结果）。
  宿主的 find 用本机 `path.relative(searchPath, entry)` 求相对路径，未标记的绝对路径会被算成 `../../../srv/…` 乱码
  （真机 + 评审都拓到）。
- **模型的路径输入先过 `assertModelPathInput`**（发 ssh 之前）：首段不得是宿主标记 `pi-remote`、不得 `~` 开头
  （拼成 `$HOME/~/x` 是错的）。两者都是 fail-closed，不静默指错目录。
- **参数判定容忍采样器噪声（remote-tools#5 回归）**：覆盖同名工具会继承宿主的
  `constrainedSampling: {strict: "prefer"}`，采样器会把可选字段一并填出（数字填 `0`、字符串填空串）。
  所以：`remote` 非字符串/空串/纯空白 ⇒ 本地模式；本地模式**完全忽略** `remotePort`/`remoteCwd`；
  `remotePort` 为 `null`/非数字/`NaN`/`<= 0` ⇒ 当未提供；只有**正数越界或非整数**才报 `INVALID_REMOTE_PORT`。
  另：`null`/`undefined`/`nil`/`none`/`n/a`（大小写无关、trim 后）这类**缺省值字面量**也当「没给」
  （agent 会把 JSON null 序列化成字符串 "null"，被当主机名去 ssh；`remote`→本机、`remoteCwd`/`path`→远端基准）。
  判据是「缺省值字面量 → 容忍；内容 → 不猜」：`local`/`false`/任意自由字符串仍当主机名（`local` 是常见的
  `~/.ssh/config` 别名，当本机 = 静默跑错机器）；连带限制——远端机器/目录不能恰好叫这些词。
  实测教训：没有远端意图的字段绝不能让本地调用失败（用户实测本地 read 被 `remotePort: 0` 打断）。
  同理 `path`/`remoteCwd` 拿到的**非字符串**也当未提供（否则 `null.trim()` 会抛无错误码的裸 TypeError）。
- **可选端口必须补齐：`ReadOperations.detectImageMimeType` 不实现，宿主就把图片当文本读**（宿主 `read.js` 是
  `ops.detectImageMimeType ? … : undefined`，用户实测远端 PNG 读出 `�PNG…`）。实现方式：嗅探样本搭 `access`
  那一次往返的顺风车（`head -c 8192 … | base64`，零额外往返），判定交给**宿主同一份**
  `detectSupportedImageMimeTypeFromFile`（包根唯一导出；纯 buffer 版未导出、深路径被 `exports` 封死 ⇒ 样本落
  本地临时文件再喂进去，用完即删），魔数/动图/BMP 规则零复制。接新工具/跟新宿主时先枚举 `XxxOperations` 的**全部端口（含可选）**。
- **ls/find 的远端错误必须自己拦（`#10`）**：宿主 `ls.js:44/50` 与 `find.js:71` 在 `ops.exists()` 为假 / `stat()`
  非目录时用自己的模板抛错，模板插值的正是我们传进去的**宿主标记形态路径**（模型可见的 `Path not found: C:\…\pi-remote\…`）。
  所以远端 ls/find 在进宿主校验**之前**先 `probeDirectory`：不存在 ⇒ `REMOTE_NOT_FOUND`、存在但不是目录 ⇒
  新码 `REMOTE_NOT_DIRECTORY`，消息全静态模板。探针答案缓存进同一个 ops 实例 ⇒ 宿主随后的 `exists`/`stat`
  不触网（ls 往返 3 → 2，find 2；`probeDirectory` 是新方法，`exists`/`stat` 的既有语义不变）。
- **bash 的远端能力经 `pi.events` 交给 shell owner（`#9`）**：宿主对同名工具按扩展加载顺序 first-wins、
  无法包裹下层实现，所以本扩展在加载期把远端 bash 能力放进 timeout-bg 的收集盒子（`capability.ts`），
  由它合并 schema 并按参数分派；远端分支只有 `executeRemoteBash` 一份实现（本扩展自己的 bash 与能力载荷共用）。
  频道/载荷/分派安全口径/加载顺序见 `docs/cross/shell-tool-capability.md`，本侧锁在 `test/capability.test.ts`
  与跨扩展组合测试里（含反向加载顺序）。
- **远端 $HOME 缓存失败不毒化**：session 按目标永久缓存，所以 `home()` 失败时清缓存、下次重试（瞬时网络抖动
  不能让该目标所有相对路径调用挂到 `/reload`）。
- **远端 bash 超时转后台（`#12`，与 timeout-bg 组合时）**：托管端口从 `pi.events` 的
  `pi-extensions:shell-job-host:v1` 频道**懒索取一次并缓存**（拿不到 = 没装 timeout-bg ⇒ 行为与今天逐字一致：
  传输层 timeout + `timeout:<秒>`）。拿到端口后：
  - 自己计时，**不把 `timeout` 交给传输层**（那会杀 ssh）；命令前缀把登录 shell 的 `$$` 写进
    `/tmp/pi-remote-job-<uuid>.pid` 供 `/bg:kill` 定位进程组（随机名，无法被预置符号链接命中；`EXIT`/`TERM`/`HUP`
    trap 自清理——**TERM/HUP 必须显式 `exit`**，否则 shell 吞掉信号继续跑下一条命令）；
  - 输出全程落 `<logRoot>/<pi pid>/<id>.log`（`allocate()` 给的路径，与本地 job 同布局），超时后只进日志；
  - 命中超时时 `register`（命令/目标/秒数/尾部输出/`terminate`），本次 tool call 以 owner 返回的文本结束；
  - `terminate` = 发一条 ssh 按 pid 文件尽力杀远端进程组（TERM → KILL），**再**断开本地 ssh；
  - 命令自然结束时 `settle(id, 退出码)`（传输层中断记 `null`，不把 ssh 的 255 当命令退出码）。
  频道的形状/义务/失败口径见 `docs/cross/shell-tool-capability.md`。“不断连”的真机取证（标记文件在超时后
  仍写出）在 `test/remote-live.test.ts`。

## 文件地图
- `context.ts` — 跨扩展能力「取远端目录上下文」的提供方：祖先链计算（到 `$HOME` 或 `/` 为止、深度有上限、逃逸即空链）、一条 ssh 的 NUL 分帧命令、请求形状守卫、失败一律收敛成 `ok:false`；由 `tools.ts` 在 `registerRemoteTools` 里订阅收集频道填槽（复用同一个 `planSession` 与 session 缓存）
  读不出 ≠ 不存在：`[ -f ]`（存在）与 `[ -r ]`（读得出）分开判，读不出时发 SOH 前缀标记帧 ⇒ 只要链上出现任一个读不出的候选就整条回 `ok: false`——静默少注入比不注入更危险（`dir-context-todo#7`）。

- `index.ts` — 扩展入口：`registerRemoteTools(pi, { exec: createSpawnExec(), cwd: process.cwd() })`
- `capability.ts` — 跨扩展能力载荷：频道名、`RemoteBashCapability` 形状、`isRemoteBashCall`（远端意图判定，噪声容错、形态非法也算远端）、
  `offerBashCapability`（订阅收集频道、同步填盒子、形状守卫与异常隔离）、
  `claimRemoteJobHost`（job 托管端口的索取与形状守卫）
- `tools.ts` — 7 个同名覆盖的接线：schema 拼接（内置参数 + remote 三件套）、本地/远端分派、
  `resolveToolPath`（校验 + $HOME 懒解析）、`remoteContext`（把内置定义的 `ctx.cwd` 换成远端基准）、
  `withRemotePaths` / `rewriteHostPathInStructured`（远端分支唯一后处理：结果/报错里的宿主标记路径回写，`#16`）、
  session 缓存（同目标共享、`$HOME` 只解析一次）、`executeRemoteBash`（远端分支单一实现，供自身注册与能力载荷共用）
- `ops.ts` — 远端 Operations 后端：read/write/edit/ls/find/bash 的远端原语（**目录分支在前**的 `if/elif` 一次往返区分
  「不存在/是目录/正常」——`-e` 对目录同样成立，顺序写反会把「是目录」误报成「不可读」；read 的 `access` 顺带取回图片嗅探样本，`detectImageMimeType` 消费）、
  `createRemoteSession`、ls/find 的 `probeDirectory` 探针（fail-closed 目录校验 + 答案缓存）、find 的 rg/find 双分支命令、`formatEnvPrefix` 白名单、
  `createRemoteBashOps(session, jobDeps?)` 的两条路径（旧路径：传输层超时；托管路径：自计时/落盘/登记/杀远端进程组）、
  `buildRemotePidFilePrologue` / `buildRemoteKillCommand`
- `grep.ts` — 整份重写的远程 grep：`rg --json` 解析 + 与内置同形的输出/限流/截断，rg 缺失时 GNU grep 回退
- `paths.ts` — 宿主路径空间 ↔ 远端 POSIX 路径空间的换算（`HOST_PATH_ROOT`/`toHostPath`/`toRemotePath`/`stripHostMarker`）
  + 标记根守卫（`assertMarkerRootUsable`：锚文件必须是普通文件）
  + 输入护栏（`assertModelPathInput`：拒宿主标记首段与 `~`）与缺省值字面量词表（`ABSENCE_LITERALS`/`isAbsenceLiteral`）
  + 文案改写 `rewriteHostPathInText`（宿主标记路径 → 远端路径，`#16`）
- `ssh.ts` — 传输层与策略：`parseTarget`/`buildSshArgs`/`shellQuote`/`validateRemotePath`/`runSsh`/
  `classifySshFailure`/`createSpawnExec`（进程边界端口，测试注入手写 fake）
- `errors.ts` — 错误码单源（`INVALID_REMOTE_TARGET` / `INVALID_REMOTE_PORT` / `REMOTE_PATH_NOT_ABSOLUTE` / `SSH_CONNECT_FAILED` / `SSH_TIMEOUT` / `REMOTE_NOT_FOUND` / `REMOTE_NOT_DIRECTORY` / `REMOTE_NOT_READABLE` / `REMOTE_NOT_WRITABLE` / `REMOTE_WRITE_FAILED` / `REMOTE_COMMAND_FAILED` / `HOST_MARKER_CONFLICT` / `REMOTE_CONTEXT_FAILED` / `REMOTE_CONTEXT_UNREADABLE`（后两个是远端上下文能力的：通用失败 / 链上候选存在但读不出））
- `test/` — 137 个：127 个纯本地（`context-v2.test.ts`(6，协议 v2：真 shell 往返含 NUL 内容 / `\x02` `\x03` 帧 / 路径归一) / `ssh.test.ts`(11) / `paths.test.ts`(11) / `ops.test.ts`(20) / `grep.test.ts`(13) / `tools.test.ts`(23) / `capability.test.ts`(5) / `context.test.ts`(26，远端上下文能力：祖先链/分帧/锚点与基准归一/双向形状守卫/读不出≠不存在/握手) / `bash-timeout.test.ts`(9) / `shell-composition.test.ts`(3)）+ 10 个**真机 opt-in**（`remote-live.test.ts`，未设 `PI_REMOTE_TOOLS_TEST_TARGET` 时跳过）

## 真机验收（2026-10-10，`#9`/`#10` 后复跑）

目标：本机 WSL Ubuntu（`user@127.0.0.1:22`，Linux 内核 + 已装 ripgrep），Windows 侧跑测试。9 个用例**全绿**：

```bash
MSYS2_ENV_CONV_EXCL='*' PI_REMOTE_TOOLS_TEST_TARGET=user@127.0.0.1 PI_REMOTE_TOOLS_TEST_DIR=/home/user \
  node --test test/remote-live.test.ts
```

覆盖：建连 + 远端 `$HOME` 解析、bash 目录/退出码/缺目录结构化错误、ops 层 write→read→edit→ls 往返、
远端**图片**走宿主图片管线（真 PNG → image 块；`#8`）、**工具层端到端**（注册覆盖 → 标记根 → 宿主 path 解析 → ops 还原 →
远端 write/read/ls/grep（真 rg）/find/bash）、远端不存在/无权限的结构化错误码、不可达主机 fail-closed、
以及 `#9`/`#10` 新增的一条：带 `remote` 的 bash 真在远端跑（`uname -s` = `Linux`）与 ls/find 的不存在/传文件结构化错误
（消息里既没有 `pi-remote` 也没有宿主模板字样）。

`#12` 又加一条（2026-10-11）：**远端超时不断连 + `/bg:kill` 真杀远端进程组**——`sleep 3; printf DONE > marker`
配 `timeout: 1` ⇒ 工具调用以 job 文本结束、本地 ssh 活着、`marker` 3 秒后真的出现；长任务配 `timeout: 1` ⇒
`terminate()` 后远端 `pgrep` 归零且标记文件不再生成。这条真机用例拓到一个假 ssh 测不出的 bug：
pid 文件的 `TERM` trap 若不显式 `exit`，命令 shell 会**吞掉信号继续跑下一条命令**
（`sleep N; printf ALIVE > marker` 在 kill 之后仍写出了标记）——已改为 `trap '…; exit 143' TERM` 并补单测断言。

组合的端到端另有一次真实 pi 会话验收（不推包，直接 `-e` 两个扩展的最小链路）：

```bash
pi --print --no-session --no-extensions -e <本目录>/index.ts -e <timeout-bg 目录>/index.ts \
  --tools bash --model <任意模型> -- "用 bash 调 uname -s，remote=user@127.0.0.1"
# ⇒ 工具面的参数是五元并集（command/timeout/remote/remotePort/remoteCwd），带 remote 的调用返回 Linux
```

本地侧另有结构性断言（不靠真机也能守）：`paths.test.ts` 断言 `mkdir -p 标记根` 必失败、`realpath` 必是 missing-path 错误。

两个只有真机才能发现的问题（已修 + 已加回归测试）：

1. **宿主形态不能是 UNC**：`withFileMutationQueue`（write/edit 内部）在本地做 `fs.realpath`，Windows 上
   `\\pi-remote\…` 报 `UNKNOWN: unknown error`（只容忍 ENOENT/ENOTDIR）⇒ 远端 write/edit 直接失败。
   当时的修法是平台相关宿主形态（Windows `C:\pi-remote\…`、POSIX `//pi-remote/…`，本地 `realpath` 给 ENOENT）；
   `#7` 之后统一成标记根 `<扩展目录>/index.ts/pi-remote`（更强的结构性保证，见 ADR-0010 决策 3）。
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
  探本地变体（NFD / 弯引号）——所以宿主形态必须让本地 path/fs 给 missing-path 错误。旧形态 `C:\pi-remote\…`
  靠「本机恰好不存在」维持这条前提（本地真有该目录时变体探测会静默读错文件，用户 2026-10-10 复现）；现在
  标记根锚在自带普通文件下 ⇒ 本地**建不出**该目录，前提成了结构事实（详见 ADR-0010 决策 3）。
- **远端 `bash` 的 Ctrl-C/Esc 中断仍只 kill 本地 ssh**：远端命令可能继续跑；远端进程组清理只对「超时转后台的 job」
  尽力做（`/bg:kill` → pid 文件 → TERM/KILL），且需要装 timeout-bg。
- **不启用 `ControlMaster`**：Windows OpenSSH 不支持连接复用，复用交给用户自己的 `~/.ssh/config`；
  因此把「N 次往返」压到关键路径上——`ls` 的 readdir 用 `ls -A1p` 一次拿回 entry 类型并缓存，随后的逐条 `stat` 零 ssh。
- **`ls -A1p` 的尾斜杠语义与它的一处分叉**：目录项带尾斜杠（节省 N 次 ssh，见下）；但 GNU `ls -p` **不跟随符号链接**，
  `link→目录` 不带尾斜杠 ⇒ 会被缓存为「文件」、宿主 ls 显示时不加 `/`（本地 `fs.stat`/远端 `test -d` 都跟随 symlink）。
  实测（真机）：`ls -A1p` 给 `real_dir/`、`link_to_dir`（无斜杠），而 `test -d link_to_dir` = 真。
  影响仅限显示（宿主 ls 拿 stat 只为拼 `/`，不靠它决策）；若要完全对齐，用
  `find <dir> -mindepth 1 -maxdepth 1 -printf '%Y\t%f\n'`（`%Y` 跟随 symlink，实测 `d/d/N` 与 `test -d` 一致）——
  代价是多一套两格式解析与非 GNU find 的回退分支，故 v1 不做。
- **评审记录**：第 1 轮 kimi-coding/k3-256k = OK with notes（0 阻断/3 建议/5 备注），逐条处理见提交 `fb4e6a4`；  第 2 轮同款 reviewer = 可合并（0 阻断/1 建议/2 备注）：建议 S1（`ls -p` 不跟随 symlink 的文档失实）已按本卡修正；
  备注 B1（readdir 对「权限不足」的 `ls` 退出码 2 会报 `REMOTE_NOT_FOUND`；实际路径在宿主 ls 的 exists/stat 阶段已拦，
  当前不可达）、B2（文件名含 `\r` 或反斜杠时行式解析失真）均记录不改。被驳回的建议：无。
- **评审记录（`#5` 备注轮）**：同款 reviewer = 可合并（0 阻断/0 建议/2 记录级）：B1（非字符串 `path` 分支无测试覆盖）已补 read 用例；
  B2（`resolveToolPath` 与 `assertModelPathInput` 重复判空）记录不改。
- **评审记录（`#6`）**：同款 reviewer = OK（0 阻断/1 建议/5 备注）：建议①（文件地图 `paths.ts` 补新职责）采纳；
  建议②（`last verified` 改指文档提交）**驳回**，理由=仓库惯例是**指向被验证的代码提交**（见 `docs/extensions/jev-safe-gate.md`
  头部 = feat 提交，其后的文档同步提交信息就是「同步 … last verified 标记（@ 20acc24）」）。
- **评审记录（`#7`/`#8`）**：第 1 轮（kimi-coding/k3-256k）= OK with notes（0 阻断 / 0 建议 / 4 备注）：① `readFile` 的目录分支位次错误（`-e` 对目录同样成立 ⇒ 先 `cat` 把「是目录」误报成「权限不足」，`exit 4` 真机不可达）——已改为目录分支在前，并补命令形态断言与真机目录断言；② 真机用例里过时的旧标记注释——已改；③ 本卡“见下方评审记录”的悬空引用——已补（即本条）；④ 规格里绕口的范围外措辞——第 1 轮称已改但实际未落地，第 2 轮回补（现为「不做远端文件缓存」）。第 2 轮（复评本轮修复）= 可合并（0 阻断 / 0 建议 / 2 文档备注）：⑤ 规格范围外措辞回补——已改；⑥ 本卡 `ops.ts` 文件地图还写着「`if [ -e ]` 一次往返区分不存在/是目录/正常」——已改为「目录分支在前的 `if/elif`」。第 3 轮（复核两条文档备注）= 可合并（0 阻断 / 0 建议 / 0 备注）：四条核对全部通过，无新意见。
- **评审记录（`#9`/`#10`，2026-10-11）**：第 1 轮（kimi-coding/k3-256k）= OK with notes（0 阻断 / 0 建议 / 5 备注）：① `negotiateBash` 的 `base` 死参数——已删（`846213e`）；② timeout-bg 卡 `last verified` 与共享文档不同——**驳回**（惯例是「指向被验证的**代码**提交」，见上面 `#6` 那条；本轮已按最后一次动代码的提交统一为 `846213e`）；③ 两份 align 文档的「抛错回退原路径」与实现的安全口径冲突——**驳回**（对齐文档是开工前的人工确认记录，事后回写会让对齐门失去意义；偏离与理由已按红线 3 记在 `docs/specs/shell-tool-composition.md`，并在 `complete` 备注重申）；④ 模型面文案仍写「path 必须是远端绝对 POSIX 路径」——已改为「相对路径/省略按远端 $HOME」（`846213e`：`REMOTE_GUIDELINE` + 7 处参数/工具说明 + README）；⑤ `remote-live.test.ts` 一处排版——已修（`846213e`）。第 2 轮（复核 ①④⑤）= 见下条。
- **评审记录（第 2 轮）**：kimi-coding/k3-256k = OK with notes（0 阻断 / 3 条文案 P2）：①②③⑤ 全部确认已解决（② 驳回成立：仓库惯例=指向被验证的代码提交；③ 驳回成立：规格已承接偏离、对齐文档是开工前的人工确认记录）；新发现 3 处「绝对 POSIX」漏网措辞（根 README 的自相矛盾句、`index.ts` 文件头、ADR-0010）——已修（`52c10d9`）。
- **评审记录（第 3 轮，终轮）**：同款 reviewer = OK with notes（0 阻断）：①② 确认修复且与 `resolveToolPath` 逐点一致；③ 指出注记把原文改写了、自指失效——已按推荐修法恢复原文 `path（远端绝对 POSIX）`、注记改为「决策当日口径 + 当前口径」两句，并覆盖决策 2 正文里同源的旧表述（ADR 只加注记、不改写正文）。三轮上限到：全轮无 P0/P1，终轮唯一一条纯文档 P2 已收口（不再派第 4 轮，红线 11 的最大轮数护栏）。
- **评审记录（`#12`/`#4`，2026-10-11）**：第 1 轮（kimi-coding/k3-256k）= OK with notes（0 阻断 / 5 建议 / 6 备注）：
- **评审记录（`#12`/`#4`，2026-10-11）**：第 2 轮（复核第 1 轮 5 条修复）= OK with notes（0 阻断 / 2 新建议 P2 / 3 备注）：5 条全部核实为已修（恢复的不变量、命令/目标清洗、README 频道措辞、`jobPlace` 文案、错误码与两条进程边界测试）；建议 ①（三张卡的 `last verified` 指向动过代码的修复提交）与 ②（契约卡补「订阅生命周期」与 `settle` 幂等口径）都已处理；备注中 `register` 失败路径不再对未登记 id settle、端口错误码保留已实现（并加断言），`formatJobLine`/`jobPlace` 的重复记录不改。
- **评审记录（`#12`/`#4`，2026-10-11）**：第 3 轮（终轮，复核第 2 轮处理 + merge `dev-laptop` 的自洽性）= **无新意见**（0 阻断 / 0 建议 / 1 非阻断备注）：第 2 轮的 2 建议 + 3 备注全部复核通过；唯一备注是「`REMOTE_JOB_PORT_INVALID` 原样透传分支没有测试锁定」——已补用例（`bash-timeout.test.ts` 的「register 抛端口契约错误」）。按红线 11 的 3 轮上限，本轮即终轮（补测试后不再开第 4 轮；该改动仅测试与文档，无行为变更）。
  涉及本卡的建议 ①（不变量节误删「远端 `$HOME` 缓存失败不毒化」）已恢复；③（README 写「同一条 `pi.events` 通道」失实——托管端口是另一条频道、方向相反）已改；
  ⑤（`allocate`/`register` 的守卫错误与转后台失败是裸 `Error`）已登记错误码 `REMOTE_JOB_PORT_INVALID` / `REMOTE_BACKGROUND_FAILED`，
  并补两条进程边界测试（端口抛错 ⇒ 断 ssh + 带码报错 + notify；日志建不出来 ⇒ 当场回退旧路径）。
  备注（记录不改）：`/reload` 后旧实例的订阅残留可能让**先到先得**的槽位被死端口占住——已用「会话启动登记 / 关闭退订」（`offerRemoteJobPort` 返回退订函数）缓解，
  宿主是否清监听器本仓无法核实；`terminate` 缺失时 `/bg:kill` 只报「已停止」（契约明确当没有钩子）；未超时的远端调用也烧号 + 落盘（见「坑」节的有意取舍）；
  日志异步建不出来时不会「当场回退旧路径」（契约字面只覆盖同步失败，有 `error` 兜底不炸会话）；`session_shutdown` 的 terminate 是 fire-and-forget（Q3 已接受「尽力而为」）。
- **坑（评审备注记录的边缘场景）**：若扩展目录路径**本身**含 U+00A0 之类的 unicode 空格，宿主的 `normalizePath` 会把它改写成普通空格 ⇒ 标记根前缀失配 ⇒ 远端调用 fail-closed 报 `REMOTE_PATH_NOT_ABSOLUTE`（是误报，不是静默放行；概率极低，记录不改）。
- **评审记录（`#15`/`#16`，2026-10-12）**：三轮跨厂商评审（reviewer = `kimi-coding/k3-256k`；本轮开发模型属 DeepSeek 家族，跨厂商成立）。第 1 轮 = OK with notes（0 阻断 / 5 建议 / 5 备注）：① `structuredContent` 未改写（宿主 `read.js` 末尾从**改写前**的 content 派生它，codemode 消费方走这条渠道）——已补 `rewriteHostPathInStructured` 并锁测试；② `String.replace` 的替换串未防 `$&`/`$'`（POSIX 远端路径允许 `$`）——已改函数形态替换；③ `remote-live.test.ts` 残留「拒绝未知指纹」旧口径——已改 TOFU 口径；④ `accept-new` 需 OpenSSH ≥7.6 未文档化、老客户端 `Bad configuration option` 落不到分类——已补正则/文案/README；⑤ 真机 `written.includes(host)` 在 `HashKnownHosts yes` 下假失败——已改「文件非空」；另卡片 `generateUnifiedPatch` 签名失实、`index.ts` 错别字「逐字不劫」等已修（`5e76c02`/`529d26c`）。第 2 轮（复核第 1 轮 7 项：6 已修 / 1 部分）= OK with notes（0 阻断 / 2 建议 / 5 备注）：⑥ 真机新增阴性断言**一跑必假失败**——临时目录名 `.pi-remote-tools-tool-*` 自身含 `pi-remote`，合法远端路径被误判——已把四处临时目录改名 `.rt-*` 并把三条断言从裸子串换成 `HOST_PATH_ROOT`（标记根形态）；⑦ 图片形态 `structuredContent` 无测试锁定——已补 type/mimeType/data/note 断言（`74e6222`/`1e4aa62`）。第 3 轮（终轮，复核第 2 轮 7 项全落实）= **无新意见**（0 阻断 / 0 建议 / 2 非阻断备注）：① `HOST_PATH_ROOT` 阴性断言的残余盲区仅「改写本身失效 **且** 宿主翻转分隔符/大小写」这一种双重失效；② 图片 `structuredContent` 断言锁「形状保住」而非「note 真被改写」，而宿主 `toReadOutput` 的 note 永不含路径 ⇒ 该子情形生产不可达。两条均为残余盲区、非回归，按记录收口；按红线 11 的 3 轮上限，本轮即终轮（不再开第 4 轮）。
