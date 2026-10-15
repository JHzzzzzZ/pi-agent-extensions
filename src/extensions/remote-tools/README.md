# remote-tools — 内置工具的 SSH 远程后端

给 Pi 的七个内置工具加远程能力：**调用时带 `remote` 就在远端主机执行，不带就与今天完全一致**。

远端目标现在**具名**（登记表里的别名）：先登记一次，之后传别名就行（strict 白名单默认开着，未登记目标会被拒绝）。

```
/remote:add prod deploy@10.0.0.7 --port 2222     # 人工登记一次（也可由模型用 remote_targets 工具登记）
/remote:list                                     # 看已登记目标（/remote:rm 删、/remote:strict off 关白名单）

read  path="/srv/app/src/index.ts"        remote="prod"
grep  pattern="TODO" path="/srv/app"      remote="prod"
bash  command="git status --short"        remote="prod" remoteCwd="/srv/app"
write path="/srv/app/new.ts" content="…"  remote="prod"
edit  path="/srv/app/a.ts" edits=[…]      remote="prod"
find  pattern="**/*.ts" path="/srv/app"   remote="prod"
ls    path="/srv/app"                     remote="prod"
```

字面目标同样能用（只要它与某个已登记条目同源）：登记了 `prod → deploy@10.0.0.7:2222` 后，`remote="10.0.0.7"`、`remote="deploy@10.0.0.7"` 与 `remote="prod"` 命中同一条目。

## 参数

| 参数 | 适用工具 | 说明 |
| --- | --- | --- |
| `remote` | 全部 7 个 | 远端 SSH 目标 `"[user@]host"`（通常是登记表里的**别名**）；**省略或留空 = 在本机执行**（与内置行为一致）。缺省值字面量 `null`/`undefined`/`nil`/`none`/`n/a` 也当没给（agent 常把 JSON null 写成字符串），但 `local`/`false` 等自由字符串仍当主机名 |
| `remotePort` | 全部 7 个 | 远端 SSH 端口 1-65535；省略用 `~/.ssh/config` / ssh 默认。**噪声容错**：`null`/非数字/`0`/负数一律当作未指定，不会报错 |
| `remoteCwd` | 仅 `bash` | 远端工作目录；省略 = 远端 `$HOME` |

远端路径规则：绝对 POSIX 路径（`/srv/app/src/a.ts`）直接用；省略 `path`（`ls`/`find`/`grep`）或不给 `remoteCwd` 时用远端 `$HOME`，**相对路径同样按远端 `$HOME` 解析**。Windows 盘符路径（`C:/…`）与 `~` 开头会被拒绝。

## 远端目标登记表（别名 + strict 白名单）

登记表是**用户级文件** `~/.pi/agent/remote-targets.json`（路径可经 `PI_REMOTE_TARGETS_FILE` 覆盖），只存 `alias`/`host`/`user`/`port`/`source`/`createdAt`/`note`——**从不存凭据**（仍然只用系统密钥 / ssh-agent）。

| 谁 | 入口 | 能做什么 |
| --- | --- | --- |
| 人 | `/remote:add <别名> [user@host] [--port N] [--force]` / `/remote:list` / `/remote:rm <别名>` / `/remote:strict on\|off` | 增删改、开关白名单 |
| 模型 | `remote_targets` 工具（`action=list` / `action=register`） | 只能查与登记（`source: agent`），**不能删除、不能覆盖同名** |

判定口径：

- **strict 默认开**：`remote` 既不是已登记别名、也不匹配任何条目的展开目标 ⇒ 结构化拒绝（`UNKNOWN_REMOTE_TARGET`，文案会列出可用别名与两个登记入口）。关掉就回到今天的自由填写（逐字不变）。
- **别名只是入口**：命中按展开后的 `host`/`user`/`port` 三元组比——条目的 `user`/`port` 会**补齐**入参没给的部分，显式 `remotePort` 优先于条目默认端口。
- **`ssh_config` 别名也能登记**：`/remote:add lab`（不给 `user@host`）⇒ `remote="lab"` 交给 ssh 自己的 `~/.ssh/config` 解析 user/port。
- **本地调用完全不碰登记表**：`remote` 为空时的行为与内置逐字一致，登记表损坏也弄不坏本机工具（远端调用则 fail-closed 报 `REMOTE_TARGETS_UNREADABLE`，不静默当空表）。
- 模型面的提示行（“已登记目标：…”）是**加载期快照**，`/reload` 才刷新；实时清单走 `remote_targets`。

## 前提

- 系统 PATH 里有 `ssh`（Windows 10+ 自带 OpenSSH 即可；`accept-new` 需 **OpenSSH ≥ 7.6**），**零 npm 运行时依赖**。
- **远端目标已登记**（strict 默认开）：首次用某个目标前 `/remote:add` 一次；或者 `/remote:strict off` 关掉白名单恢复自由填写。
- 目标主机已配好密钥 / ssh-agent。本扩展非交互执行（`BatchMode=yes`）且指纹策略是 **TOFU**（`StrictHostKeyChecking=accept-new`，`#15`）：新主机首次连接由 ssh 自己把指纹写进 `known_hosts`，**不需要**先手工 `ssh user@host` 一次；已收录主机的**指纹变更仍然拒绝**（报 `SSH_CONNECT_FAILED`，清理旧条目用 `ssh-keygen -R <host>`）。
- 远端有 `ripgrep` 时 `grep`/`find` 语义与本地一致（遵守 `.gitignore`）；没有则回退远端 `grep -r` / `find`，并在结果里标注降级（`.gitignore` 不生效）。

## 向 dir-context 提供远端上下文能力

带 `remote` 的调用 `path` 在远端解析，所以 `dir-context` 默认不会为它注入 `AGENTS.md`。本扩展经宿主 `pi.events` 提供 `fetchRemoteContext`：**一条 ssh** 取回该目录祖先链上的 `AGENTS.md`/`CLAUDE.md`（相对/省略路径走到远端 `$HOME`、绝对路径走到 `/`，由外向内、每目录按优先级取一个，深度有上限）。**注入规则全在 dir-context**（本扩展只负责取文件），没装 dir-context 时这项能力没人用、不影响本扩展任何行为。契约见 [`docs/cross/remote-context-capability.md`](../../../docs/cross/remote-context-capability.md)。

## 实现要点（改代码前先读）

- **不自己复刻内置行为**：`read` / `write` / `edit` / `ls` / `find` / `bash` 都用宿主同一份 `createXxxToolDefinition` 配上远端 Operations 实现，因此截断、限流、渲染器、提示词片段与内置完全一致；`remote` 为空时直接调宿主本地实现（零漂移、绝不 spawn ssh）。
- **只有 grep 整份重写**：宿主的 `GrepOperations` 覆盖不到真正的 ripgrep 搜索（`dist/core/tools/grep.js` 里是本地 `spawn`），远程搜索必须自己实现（远端 `rg --json` 优先，回退 GNU grep）。代价是 grep 的自定义 TUI 渲染器回落到宿主默认渲染。
- **路径空间换算**（`paths.ts`）：Windows 上宿主 `path.resolve` 会给远端路径注入盘符（`/srv` → `C:\srv`）、`normalizeWindowsShellPath` 还会把单字母首段当 Git-Bash 盘符（`/s/x` → `S:\x`）。所以交给内置工具的路径一律带**标记根**前缀 `<扩展目录>/index.ts/pi-remote`（锚在一个已存在的普通文件下——本地**建不出**这个目录，宿主给的都是 ENOENT/ENOTDIR，它的变体探测没有可命中的文件），ops 层再剥离还原；锚文件不是普通文件时远端调用 fail-closed 报 `HOST_MARKER_CONFLICT`。
- **结果文案里的路径也是远端路径**（`#16`）：宿主把自己的入参 `path` 原样插进成功文案、`details.patch` 头与一族报错，而远端分支必须传宿主标记形态（见上一条）——`tools.ts` 的 `withRemotePaths` 在出口处把它换回远端绝对路径，否则模型会以为写到了本机（形如 `C:\…\index.ts\pi-remote\srv\a.ts`）。
- **可选端口要补齐**：宿主的 Operations 接缝里有可选端口（如 `ReadOperations.detectImageMimeType`），不实现它宿主就静默走另一条分支（远端 PNG 会被当文本读）——远端 read 的图片嗅探样本搭 `access` 的顺风车（`head -c 8192 | base64`，零额外往返），判定交回宿主同一份检测实现。
- **ls / find 的错误自己拦**：远端 ls/find 在进宿主校验前先做一次 fail-closed 目录探针（不存在 ⇒ `REMOTE_NOT_FOUND`、存在但不是目录 ⇒ `REMOTE_NOT_DIRECTORY`），否则宿主会用它自己的模板把内部标记路径（`C:\…\pi-remote\…`）写进错误消息回灌给模型；探针答案顺带缓存，ls 的往返数从 3 降到 2。
- **与 timeout-bg 共存**：两个扩展都覆盖 `bash` 这个名字，而宿主对同名工具按扩展加载顺序 first-wins、无法包裹下层。本扩展在加载期把远端 bash 能力放进 timeout-bg 的 `pi.events` 收集盒子（`capability.ts`），由它合并参数并按参数分派——两个功能都保留；分派口径与加载顺序要求见 [`docs/cross/shell-tool-capability.md`](../../../docs/cross/shell-tool-capability.md)。
- **远端超时转后台**：装上 timeout-bg 后，本扩展经 `pi.events` 的 **job 托管频道**（`pi-extensions:shell-job-host:v1`，与上方能力频道方向相反：由本侧索取、owner 填盒子）懒索取一次并缓存端口（`claimRemoteJobHost`，拿不到 = 没装 ⇒ 行为与今天逐字一致）。托管路径下远端 `bash` **不再把超时交给传输层**：自己计时、输出全程落本地 job 日志（`/bg` 里能看到）、命中超时交给 timeout-bg 登记；`/bg:kill` 先按命令前缀写在远端 `/tmp/pi-remote-job-<uuid>.pid` 的 pid 尽力杀远端进程组（TERM → KILL），再断开本地 ssh。
- **远端主动后台（`run_in_background: true`）**：装上 timeout-bg 后，`bash` 带这个参数时**不等超时**——ssh 一启动就交给 timeout-bg 登记（同日志、同 `/bg` 面、同结束通知），本次调用立刻以「⏸ 已直接转入后台」文本结束。参数由 timeout-bg 声明（本扩展单装时不声明它，不让模型以为支持）；拿不到托管端口 / 端口是旧版（没有 `registerBackground`）/ 后台日志建不出来 ⇒ `REMOTE_BACKGROUND_UNSUPPORTED` **fail-closed**（不 spawn、不前台等待、不在本机跑）。
- **安全不变量**：只转发白名单会话变量（`PI_SESSION_ID` / `PI_SESSION_FILE` / `PI_PROVIDER` / `PI_MODEL` / `PI_REASONING_LEVEL`），其它 `PI_*`（例如宿主自己的 `PI_WEB_TOKEN`）绝不送远端；不存任何凭据；错误消息为静态模板，不把**远端**输出回灌进上下文（唯一插值本地内容的是目标登记表：strict 拒绝文案与清单里的别名，它经形态校验且来自本机文件，见 ADR-0014）。
- 同目标（host:port）共享一个 session：远端 `$HOME` 只解析一次；绝对路径的调用完全不为此多发一次 ssh。

## 已知限制（v1 明确不做）

- 不做整树同步 / 镜像，不做本地↔远端路径映射（远端路径由模型每次显式给出）。
- 不做只读开关（远端写权限由远端账号决定）。“主机白名单”已由目标登记表的 strict 模式提供：未登记目标默认拒绝（`/remote:strict off` 可关）。
- 不覆盖 `powershell` 工具。
- 远端 `bash` 的 Esc/Ctrl-C 中断只 kill 本地 ssh 进程，远端命令可能继续跑；远端进程组清理只对「超时转后台的 job」（`/bg:kill`）尽力做，且需要装 timeout-bg。

## 测试

```bash
cd src/extensions/remote-tools && npm install && npm test && npm run typecheck
```

174 个（node:test：163 个全本地 + 11 个真机 opt-in）：`test/ssh.test.ts`（11，传输/目标解析/失败分类）、`test/paths.test.ts`（11，宿主路径往返、标记根的结构性断言与守卫、文案改写）、
`test/ops.test.ts`（20，发给 ssh 的命令构造、错误映射、图片嗅探、ls/find 目录探针与缓存）、`test/grep.test.ts`（13，rg 事件解析/降级/限流）、
`test/tools.test.ts`（23，注册覆盖、本地保真对照（含 write/edit 文案与 details 逐字对拍）、远端分派、ls/find 结构化错误与往返数、图片端到端、远端 write/edit/read 文案回写远端路径、session 缓存）、
`test/capability.test.ts`（5，跨扩展能力载荷与订阅、job 托管端口索取与形状守卫）、
`test/context-v2.test.ts`（6，协议 v2：**真 shell 往返**（真起 `bash -c` 跑命令再按协议解回；含 NUL 的内容仍只产出一个帧、字节级还原）、`\x02`/`\x03` 帧、路径归一）、
`test/context.test.ts`（26，远端上下文能力：祖先链终点与深度上限、一趟 ssh 的命令拼装与分帧、
锚点/基准归一、请求与结果双向形状守卫、失败收敛与握手先到先得、读不出 ≠ 不存在的标记帧）、
`test/bash-timeout.test.ts`（15，托管路径的进程边界：不断连 + 日志 + settle、terminate 杀远端并断 ssh、无端口时的旧行为、主动后台立即登记与三种 fail-closed）、
`test/shell-composition.test.ts`（3，真实加载 remote-tools + timeout-bg：能力合并、job 托管频道、反向顺序冲突可见）、
`test/targets.test.ts`（22，目标登记表：解析与命中口径（含主机优先于别名、多命中歧义）、形态校验 fail-closed、登记/删改、文件端口真实临时目录）、
`test/targets-tool.test.ts`（8，`remote_targets` 工具与 `/remote:*` 命令、模型面提示行与 guideline 文案、本地调用不读表）；`test/fixtures.ts` 提供真 PNG 等样本与登记表 fake。

另有一个**真机 opt-in** 文件 `test/remote-live.test.ts`（11 个，默认跳过，接真实 ssh 进程）：

```bash
# Git Bash 下必须加 MSYS2_ENV_CONV_EXCL='*'，否则 /home/… 会被改写成 C:/Program Files/Git/home/…
MSYS2_ENV_CONV_EXCL='*' PI_REMOTE_TOOLS_TEST_TARGET=user@127.0.0.1 \
  PI_REMOTE_TOOLS_TEST_DIR=/home/user \
  node --test test/remote-live.test.ts      # PI_REMOTE_TOOLS_TEST_PORT 可选；目录需可写，用例自建临时子目录并清理
```

2026-10-10 在本机 WSL Ubuntu（`user@127.0.0.1`）跑通 8/8（含远端 PNG 走图片管线、远端 bash 真在远端跑 + ls/find 结构化错误），并拓出两个只有真机才能发现的问题
（UNC 宿主形态让 write/edit 的本地 realpath 报 UNKNOWN；`test -r -w <path>` 非法表达式）——均已修 + 加回归测试。

2026-10-11 同一目标跑通 9/9：新增「远端超时不断连 + `/bg:kill` 杀远端进程组」——`sleep 3; printf DONE > marker` 配
`timeout: 1` ⇒ 本地 ssh 活着、3 秒后 `marker` 真的出现；长任务 terminate 后远端 `pgrep` 归零且标记文件不再生成。
这条用例拓出一个假 ssh 测不出的问题：pid 文件的 `TERM` trap 不显式 `exit` 时，远端 shell 会**吞掉信号继续跑下一条命令**
（`sleep N; printf ALIVE > marker` 在 kill 之后仍写出了标记）——已改为 `trap '…; exit 143' TERM` 并补单测断言。
