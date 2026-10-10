# remote-tools — 内置工具的 SSH 远程后端

> last verified @ b7094f0

一句话：给 `read`/`write`/`edit`/`bash`/`grep`/`find`/`ls` 加 `remote`（`"[user@]host"`）、`remotePort`、
`remoteCwd`（仅 bash）三个可选参数——**`remote` 非空即路由到远端主机，留空则与内置行为逐字一致**。
需求与验收见 `todos/align/remote-tools-todo#1.md`。

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
  ops 层经 `toRemotePath` 还原。没有标记的形态原样返回、由 `validateRemotePath` 拒绝——**模型给的 `C:/…` 与相对路径在发 ssh 之前就 fail-closed**。
  配套运行时守卫 `assertMarkerRootUsable`：锚文件不是普通文件时远端调用 fail-closed 报 `HOST_MARKER_CONFLICT`（本地分支零影响）。
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
- **远端 $HOME 缓存失败不毒化**：session 按目标永久缓存，所以 `home()` 失败时清缓存、下次重试（瞬时网络抖动
  不能让该目标所有相对路径调用挂到 `/reload`）。

## 文件地图

- `index.ts` — 扩展入口：`registerRemoteTools(pi, { exec: createSpawnExec(), cwd: process.cwd() })`
- `tools.ts` — 7 个同名覆盖的接线：schema 拼接（内置参数 + remote 三件套）、本地/远端分派、
  `resolveToolPath`（校验 + $HOME 懒解析）、`remoteContext`（把内置定义的 `ctx.cwd` 换成远端基准）、
  session 缓存（同目标共享、`$HOME` 只解析一次）
- `ops.ts` — 远端 Operations 后端：read/write/edit/ls/find/bash 的远端原语（**目录分支在前**的 `if/elif` 一次往返区分
  「不存在/是目录/正常」——`-e` 对目录同样成立，顺序写反会把「是目录」误报成「不可读」；read 的 `access` 顺带取回图片嗅探样本，`detectImageMimeType` 消费）、
  `createRemoteSession`、find 的 rg/find 双分支命令、`formatEnvPrefix` 白名单
- `grep.ts` — 整份重写的远程 grep：`rg --json` 解析 + 与内置同形的输出/限流/截断，rg 缺失时 GNU grep 回退
- `paths.ts` — 宿主路径空间 ↔ 远端 POSIX 路径空间的换算（`HOST_PATH_ROOT`/`toHostPath`/`toRemotePath`/`stripHostMarker`）
  + 标记根守卫（`assertMarkerRootUsable`：锚文件必须是普通文件）
  + 输入护栏（`assertModelPathInput`：拒宿主标记首段与 `~`）与缺省值字面量词表（`ABSENCE_LITERALS`/`isAbsenceLiteral`）
- `ssh.ts` — 传输层与策略：`parseTarget`/`buildSshArgs`/`shellQuote`/`validateRemotePath`/`runSsh`/
  `classifySshFailure`/`createSpawnExec`（进程边界端口，测试注入手写 fake）
- `errors.ts` — 错误码单源（`INVALID_REMOTE_TARGET` / `INVALID_REMOTE_PORT` / `REMOTE_PATH_NOT_ABSOLUTE` / `SSH_CONNECT_FAILED` / `SSH_TIMEOUT` / `REMOTE_NOT_FOUND` / `REMOTE_NOT_READABLE` / `REMOTE_NOT_WRITABLE` / `REMOTE_WRITE_FAILED` / `REMOTE_COMMAND_FAILED` / `HOST_MARKER_CONFLICT`）
- `test/` — 77 个：70 个纯本地（`ssh.test.ts`(11) / `paths.test.ts`(10) / `ops.test.ts`(18) / `grep.test.ts`(13) / `tools.test.ts`(18)）+ 7 个**真机 opt-in**（`remote-live.test.ts`，未设 `PI_REMOTE_TOOLS_TEST_TARGET` 时跳过）；`test/fixtures.ts` 是真 PNG 等样本（不是测试文件本身，不被 glob 收集）

## 真机验收（2026-10-10 已执行）

目标：本机 WSL Ubuntu（`user@127.0.0.1:22`，Linux 内核 + 已装 ripgrep），Windows 侧跑测试。7 个用例**全绿**：

```bash
PI_REMOTE_TOOLS_TEST_TARGET=user@127.0.0.1 PI_REMOTE_TOOLS_TEST_DIR=/home/user \
  node --test test/remote-live.test.ts
```

覆盖：建连 + 远端 `$HOME` 解析、bash 目录/退出码/缺目录结构化错误、ops 层 write→read→edit→ls 往返、
远端**图片**走宿主图片管线（真 PNG → image 块；`#8`）、**工具层端到端**（注册覆盖 → 标记根 → 宿主 path 解析 → ops 还原 →
远端 write/read/ls/grep（真 rg）/find/bash）、远端不存在/无权限的结构化错误码、不可达主机 fail-closed。
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
- **远端 `bash` 的中断只 kill 本地 ssh**：远端命令可能继续跑（v1 已记录，未做远端进程组清理）。
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
- **坑（评审备注记录的边缘场景）**：若扩展目录路径**本身**含 U+00A0 之类的 unicode 空格，宿主的 `normalizePath` 会把它改写成普通空格 ⇒ 标记根前缀失配 ⇒ 远端调用 fail-closed 报 `REMOTE_PATH_NOT_ABSOLUTE`（是误报，不是静默放行；概率极低，记录不改）。
