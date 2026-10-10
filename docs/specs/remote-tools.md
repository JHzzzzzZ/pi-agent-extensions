# remote-tools — 内置工具的 SSH 远程后端（规格）

> 需求：`todos/remote-tools-todo#1`（对齐文档 `todos/align/remote-tools-todo#1.md`）；后续修补 `#5`（参数噪声）`#6`（缺省值字面量）`#7`（信道硬化，在途）
> 架构决策：`docs/adr/0010-remote-tools-host-operations-seam.md` · 模块知识卡：`docs/extensions/remote-tools.md` · 用法：`src/extensions/remote-tools/README.md`

## 问题陈述

Pi 的内置工具（`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`）只操作本机。要在远端主机上读改代码，用户今天只有两条路：
整进程 ssh 进去再跑一个 pi（远端要装 pi、要迁凭据），或在本地手工同步文件（镜像会过期、有冲突风险、传的数据更多）。
需要的是：**同一会话里按调用选择本机或远端**，不引入常驻服务、不引入 npm 依赖、不把凭据交给工具。

## 方案

覆盖七个内置工具的**同名定义**（宿主 `pi.registerTool()` 同名即覆盖内置，见 ADR-0010 决策 1），
加三个可选参数：

- `remote`：`"[user@]host"`；**省略、空串、纯空白、缺省值字面量**（`null`/`undefined`/`nil`/`none`/`n/a`）= 本机执行
- `remotePort`：1-65535；非数字/`null`/`<= 0` 视作未提供（宿主 strict 采样器会给可选字段填噪声）
- `remoteCwd`：仅 `bash`，远端工作目录；省略 = 远端 `$HOME`

`remote` 非空时把宿主的 **Operations 接缝**换成远端实现（`read`/`write`/`edit`/`ls`/`find`/`bash` 复用同一份宿主定义，
`grep` 因接缝覆盖不到真正的 ripgrep 搜索而整份重写）；`remote` 为空时直接委托宿主本地实现（零漂移、零 ssh）。
传输只用系统 `ssh`：非交互（`BatchMode`）、拒绝未知主机指纹（`StrictHostKeyChecking=yes`）、零运行时 npm 依赖、不存凭据。

## 用户故事

- 作为在 Windows 上开发的用户，我用 `read path="/srv/app/x.ts" remote="deploy@host"` 直接读远端文件，不必先 ssh 进去。
- 作为 agent，我在同一次会话里既改本机又跑远端命令，靠 `remote` 区分目标；忘了带 `remote` 时行为与内置**逐字一致**。
- 作为谨慎的用户，我信任「远端写只落远端」：所有实际 I/O 都走注入的 ssh ops，本地只在文件锁里做一次 `realpath`（不当内容通道）。
- 作为用户，远端缺 `ripgrep` 时我在结果里看到**降级标注**（不遵守 `.gitignore`），而不是静默得到语义不符的结果。
- 作为 agent，我传了 `remotePort: 0` 或 `remote: "null"` 这类噪声时不该让调用失败，也不该静默连到别的机器。

## 实现决策

- **参数面**（对齐文档口径）：扁平 `remote`/`remotePort`（不用 `host:port` 混写以免解析歧义）；远端路径每次由模型**显式给出**（不做本地↔远端映射）；`ls`/`find`/`grep` 省略 `path` = 远端 `$HOME`。
- **保真策略**：复用宿主 `createXxxToolDefinition` + 只换 Operations ⇒ 截断/限流/文件变更队列/渲染器/提示词片段天然一致；`remote` 为空走宿主本地实现。代价：`grep` 渲染器丢失（宿主未导出）。
- **路径信道**：远端路径编码成宿主形态 `盘符:\pi-remote\…`（Windows）/ `//pi-remote/…`（POSIX）——三条实测理由：`path.resolve` 原样保留、本地 `realpath` 给 `ENOENT`（write/edit 的文件锁只容忍 ENOENT/ENOTDIR）、`path.relative` 与宿主 find 的相对化同命名空间；标记同时是「经过宿主解析」的凭证（模型给的 `C:/…`、相对路径无标记 ⇒ 发 ssh 之前拒绝）。**根因与硬化取舍**见 ADR-0010 决策 2/3。
- **参数健壮性**（`#5`/`#6` 两轮实测回归）：没有远端意图的字段不得让调用失败、也不得抛裸异常——非字符串 `path`/`remoteCwd`、`null`/非数字/`<=0` 的 `remotePort`、缺省值字面量一律当「未提供」；**自由字符串一律不猜**（仍当主机名，连不上就响亮报错，避免静默跑错机器）。
- **安全不变量**：只转发白名单会话变量（`PI_SESSION_ID`/`PI_SESSION_FILE`/`PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL`；**白名单而非前缀匹配**——环境里存在 `PI_WEB_TOKEN` 这类值）；错误消息全静态模板（不插值远端路径内容或远端输出）；不存凭据。
- **错误码**：单文件 `errors.ts`（`as const` 联合 + 静态消息模板），层内契约见 `docs/cross/result-unions.md`。

## 测试决策

- **进程边界用手写 fake**：`SshExec` 端口注入（`ssh.ts`），断言**实际发给 ssh 的命令字符串**——Windows 上宿主 `path` 解析会改写远端路径，只有命令字符串断言能守住那个 bug；真机行为由 opt-in 用例覆盖。
- **本地保真对照宿主真实实现**：同一组参数分别打我们的定义与宿主 `createXxxToolDefinition`，在临时目录里比输出与真实文件副作用；`find`/`grep` 依赖宿主外部工具（fd/rg）时，两边给出**同一个错误**也算保真。
- **真机 opt-in（默认跳过）**：`PI_REMOTE_TOOLS_TEST_TARGET=user@host` 开启后接真实 ssh，覆盖建连/`$HOME` 解析、bash 目录与退出码、ops 与**工具层**往返、降级、结构化错误码、不可达 fail-closed（本机 WSL 实测 6/6）。
- 计数与运行命令见插件 README（当前 62 个本地 + 6 个真机 opt-in）。

## 范围外

- 不做整树同步/镜像（read/ls/find/bash 直接远端执行，write/edit 单文件直连，唯一绕不过的 `grep` 用重写而非镜像）。
- 不做本地↔远端路径映射（后续条目 `#4`）、不做只读开关（`#3`）、不做主机白名单/别名（`#2`）。
- 不覆盖 `powershell` 工具；远端图片不做 MIME 探测（按文本读）。
- 不启用 `ControlMaster`（Windows OpenSSH 不支持连接复用；复用交给用户自己的 `~/.ssh/config`），列目录类型信息用一次往返预取规避 N+1。
- 远端 `bash` 的中断只 kill 本地 ssh，远端命令可能继续跑（v1 记录，未做远端进程组清理）。
