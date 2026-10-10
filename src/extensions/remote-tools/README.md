# remote-tools — 内置工具的 SSH 远程后端

给 Pi 的七个内置工具加远程能力：**调用时带 `remote` 就在远端主机执行，不带就与今天完全一致**。

```
read  path="/srv/app/src/index.ts"        remote="deploy@10.0.0.7"
grep  pattern="TODO" path="/srv/app"      remote="deploy@10.0.0.7" remotePort=2222
bash  command="git status --short"        remote="deploy@10.0.0.7" remoteCwd="/srv/app"
write path="/srv/app/new.ts" content="…"  remote="deploy@10.0.0.7"
edit  path="/srv/app/a.ts" edits=[…]      remote="deploy@10.0.0.7"
find  pattern="**/*.ts" path="/srv/app"   remote="deploy@10.0.0.7"
ls    path="/srv/app"                     remote="deploy@10.0.0.7"
```

## 参数

| 参数 | 适用工具 | 说明 |
| --- | --- | --- |
| `remote` | 全部 7 个 | 远端 SSH 目标 `"[user@]host"`；**省略或留空 = 在本机执行**（与内置行为一致）。缺省值字面量 `null`/`undefined`/`nil`/`none`/`n/a` 也当没给（agent 常把 JSON null 写成字符串），但 `local`/`false` 等自由字符串仍当主机名 |
| `remotePort` | 全部 7 个 | 远端 SSH 端口 1-65535；省略用 `~/.ssh/config` / ssh 默认。**噪声容错**：`null`/非数字/`0`/负数一律当作未指定，不会报错 |
| `remoteCwd` | 仅 `bash` | 远端工作目录；省略 = 远端 `$HOME` |

远端路径规则：`path` 必须是**远端绝对 POSIX 路径**（`/srv/app/src/a.ts`）。省略 `path`（`ls`/`find`/`grep`）或不给 `remoteCwd` 时用远端 `$HOME`；相对路径按远端 `$HOME` 解析。Windows 盘符路径（`C:/…`）会被拒绝。

## 前提

- 系统 PATH 里有 `ssh`（Windows 10+ 自带 OpenSSH 即可），**零 npm 运行时依赖**。
- 目标主机已配好密钥 / ssh-agent，且指纹已在 `known_hosts` 里。本扩展非交互执行（`BatchMode=yes`）且拒绝未知指纹（`StrictHostKeyChecking=yes`）——首次连一台机器请先在终端手工 `ssh user@host` 一次。
- 远端有 `ripgrep` 时 `grep`/`find` 语义与本地一致（遵守 `.gitignore`）；没有则回退远端 `grep -r` / `find`，并在结果里标注降级（`.gitignore` 不生效）。

## 实现要点（改代码前先读）

- **不自己复刻内置行为**：`read` / `write` / `edit` / `ls` / `find` / `bash` 都用宿主同一份 `createXxxToolDefinition` 配上远端 Operations 实现，因此截断、限流、渲染器、提示词片段与内置完全一致；`remote` 为空时直接调宿主本地实现（零漂移、绝不 spawn ssh）。
- **只有 grep 整份重写**：宿主的 `GrepOperations` 覆盖不到真正的 ripgrep 搜索（`dist/core/tools/grep.js` 里是本地 `spawn`），远程搜索必须自己实现（远端 `rg --json` 优先，回退 GNU grep）。代价是 grep 的自定义 TUI 渲染器回落到宿主默认渲染。
- **路径空间换算**（`paths.ts`）：Windows 上宿主 `path.resolve` 会给远端路径注入盘符（`/srv` → `C:\srv`）、`normalizeWindowsShellPath` 还会把单字母首段当 Git-Bash 盘符（`/s/x` → `S:\x`）。所以交给内置工具的路径一律带 `//pi-remote` 标记（UNC 早退分支，原样保留），ops 层再剥离还原。
- **安全不变量**：只转发白名单会话变量（`PI_SESSION_ID` / `PI_SESSION_FILE` / `PI_PROVIDER` / `PI_MODEL` / `PI_REASONING_LEVEL`），其它 `PI_*`（例如宿主自己的 `PI_WEB_TOKEN`）绝不送远端；不存任何凭据；错误消息全是静态模板，不把远端输出回灌进上下文。
- 同目标（host:port）共享一个 session：远端 `$HOME` 只解析一次；绝对路径的调用完全不为此多发一次 ssh。

## 已知限制（v1 明确不做）

- 不做整树同步 / 镜像，不做本地↔远端路径映射（远端路径由模型每次显式给出）。
- 不做只读开关（远端写权限由远端账号决定），不做主机白名单（`remote` 自由填写）。
- 不覆盖 `powershell` 工具；远端图片不做 MIME 探测（按文本读）。
- 远端 `bash` 的中断只 kill 本地 ssh 进程，远端命令可能继续跑。

## 测试

```bash
cd src/extensions/remote-tools && npm install && npm test && npm run typecheck
```

62 个（node:test，全本地）：`test/ssh.test.ts`（传输/目标解析/失败分类）、`test/paths.test.ts`（宿主路径往返与输入护栏）、
`test/ops.test.ts`（发给 ssh 的命令构造与错误映射）、`test/grep.test.ts`（rg 事件解析/降级/限流）、
`test/tools.test.ts`（注册覆盖、本地保真对照、远端分派、session 缓存）。

另有一个**真机 opt-in** 文件 `test/remote-live.test.ts`（6 个，默认跳过，接真实 ssh 进程）：

```bash
# Git Bash 下必须加 MSYS2_ENV_CONV_EXCL='*'，否则 /home/… 会被改写成 C:/Program Files/Git/home/…
MSYS2_ENV_CONV_EXCL='*' PI_REMOTE_TOOLS_TEST_TARGET=user@127.0.0.1 \
  PI_REMOTE_TOOLS_TEST_DIR=/home/user \
  node --test test/remote-live.test.ts      # PI_REMOTE_TOOLS_TEST_PORT 可选；目录需可写，用例自建临时子目录并清理
```

2026-10-10 在本机 WSL Ubuntu（`user@127.0.0.1`）跑通 6/6，并拓出两个只有真机才能发现的问题
（UNC 宿主形态让 write/edit 的本地 realpath 报 UNKNOWN；`test -r -w <path>` 非法表达式）——均已修 + 加回归测试。
