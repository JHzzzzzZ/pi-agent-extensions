# shell 工具组合（remote-tools × timeout-bg）— 规格

> 需求：`todos/remote-tools-todo#9`（bash 的 remote 被 timeout-bg 覆盖）、`#10`（ls/find 结构化错误）、
> `#11`（卡片口径矛盾）、`timeout-bg-todo#3`（组合的 owner 侧）；对齐文档
> `todos/align/remote-tools-todo#9.md` / `#10.md` / `#11.md` / `todos/align/timeout-bg-todo#3.md`
> 跨扩展契约卡：`docs/cross/shell-tool-capability.md` · 上游根治诉求：`todos/general-todo#30`
> 模块知识卡：`docs/extensions/remote-tools.md` / `docs/extensions/timeout-bg.md`

## 问题陈述

1. **两个扩展抢一个工具名，必有一方静默消失**。timeout-bg 在 `session_start` 重注册 `bash`（它管默认超时与
   超时转后台），remote-tools 在加载期重注册 `bash`（远端 ssh 后端）。宿主 `registerTool` 对同名工具是
   **静默 last-write-wins / 按扩展加载顺序 first-wins**，没有「取回已注册定义再包裹」的 API
   （`getAllTools()` 只给 schema 与 `sourceInfo`，没有 execute）⇒ 用户实测：`bash(command="uname -s",
   remote="user@127.0.0.1")` 返回本机 `MINGW64_NT`，`remoteCwd` 也不生效。
2. **远端 ls/find 的错误不是本插件的结构化码，而且把内部实现细节回灌给模型**：`ls /nope-here` 报
   `Path not found: C:\…\<扩展目录>\index.ts\pi-remote\nope-here`——宿主 `ls.js`/`find.js` 用自己的模板
   渲染**我们传进去的宿主标记路径**（违反「错误消息全静态模板」不变量）。
3. **卡片自相矛盾**：`docs/extensions/remote-tools.md` 一处写「相对路径在发 ssh 之前 fail-closed」，
   另一处写「相对路径按远端 `$HOME` 解析」；实测以后者为准。

## 方案

**组合（方案 B′）：shell 工具的唯一 owner（timeout-bg）在注册前用宿主官方 `pi.events` 广播一个可变盒子
收集「shell 能力」，remote-tools 把远端 bash 能力同步放进去；owner 合并参数并按参数分派。**
两边都不牺牲、不跨扩展 import、不走 `globalThis` 私有槽；没有对端时行为与今天逐字一致。
频道名/载荷形状/双方义务见 `docs/cross/shell-tool-capability.md`；上游 API 缺口另立 `general-todo#30`。

远端 ls/find 在**进宿主校验之前**做一次 fail-closed 目录探针：不存在 → `REMOTE_NOT_FOUND`，
存在但不是目录 → 新增 `REMOTE_NOT_DIRECTORY`；探针答案缓存进同一个 ops 实例，宿主随后的
`exists`/`stat` 命中缓存 ⇒ ls 的往返数从 3 降到 2（find 2 次），错误消息全静态模板。

## 用户故事

- 作为同时装了 timeout-bg 与 remote-tools 的用户，`bash(command="uname -s", remote="user@127.0.0.1")`
  真在远端跑，而不带 `remote` 的 bash 仍享受「超时转后台 + 默认 300s」；我不需要知道哪个扩展赢了。
- 作为只装其中一个的用户，另一个的功能不该凭空出现或消失：只装 timeout-bg ⇒ 与今天逐字一致；
  只装 remote-tools ⇒ bash 远端能力照常。
- 作为 agent，`ls`/`find` 给了不存在的路径或文件路径时拿到 `REMOTE_NOT_FOUND` / `REMOTE_NOT_DIRECTORY`
  这样的结构化错误码，而不是一段指向本机 `C:\…\pi-remote\…` 的路径；相对路径与省略 `path` 照常按远端 `$HOME` 解析。
- 作为排障的人，两个扩展的归属冲突（未知扩展接管 bash、或加载顺序让本次注册被丢掉）会在会话里
  `notify` 一次并说明怎么修，而不是静默失效。
- 作为运维，远端执行失败（ssh 连不上、远端命令报错）时调用以错误结束，**绝不会**悄悄在本机重跑一遍。

## 实现决策

- **owner 归属**：shell 生命周期本来就在 timeout-bg（active 列表 + 超时语义），所以由它持有 `bash` 并合并能力；
  remote-tools 只提供能力载荷。载荷形状与频道是运行时契约（跨插件），两侧各自实现形状守卫防漂移。
- **同步盒子**：`pi.events.emit` 同步派发订阅回调，所以契约是「可变盒子 + 同步填充」而不是请求-响应；
  owner 在 `emit` 返回后读 `box.bash`。
- **分派安全口径**（有意偏离对齐文档「回退到原行为」的字面措辞）：`isRemoteCall` 抛错 ⇒ fail-closed 报错；
  `executeRemote` 抛错 ⇒ 原样抛 + notify。**理由**：远端意图的命令在本机跑是安全事故（`local` 常是 ssh 别名），
  「回退到本机」比报错更贵。两条都留痕（notify），不静默。
- **合并只增不改**：能力片段的键与 owner 自身参数重名 ⇒ 整份载荷判畸形（防 `command` 被覆盖）；
  owner 的 `timeout` 参数说明（改写自宿主那句 "no default timeout"）保持自己的版本。
- **归属可见性**：注册前查 `getAllTools()`（不是内置实现且确定没有提供方 ⇒ notify）；注册后比对生效版本的
  `description`（宿主 first-wins 把本次注册丢掉 ⇒ notify）。两条共用一次会话一个提示标志。
- **加载顺序**：合并生效要求 timeout-bg 先于 remote-tools 加载（仓库根 `package.json` 的 `pi.extensions`
  顺序即如此）；顺序相反时由注册后自检提示，属有意接受的上游限制（`general-todo#30`）。
- **探针与缓存**：`probeDirectory` 是新增的独立方法（不偷偷改 `exists`/`stat` 的公开语义——`exists` 仍是
  「存在即真」的布尔探针）；探针只缓存「是目录」这一种答案，ops 实例内生效。
- **卡片口径**（`#11`）：fail-closed 的只有 Windows 盘符形态、`~` 开头、宿主标记首段；相对路径/省略按远端
  `$HOME` 解析且同目标只解析一次——卡片与实现处注释都改成这一口径。

## 测试决策

- **跨扩展组合用真实宿主路径**：`test/shell-composition.test.ts` 用真实 `discoverAndLoadExtensions`
  （jiti 走两个扩展的真实 `index.ts`）+ 真实 `createEventBus` + 真实 `ExtensionRunner`，断言合并后的 schema
  与两条分派路径；**含反向加载顺序**（first-wins 覆盖时 notify）。
- **进程边界只 fake 进程**：远端分支用「非法 remote 形态」（校验先于 ssh ⇒ 零 ssh 进程）证明走了远端分支；
  本地分支用「非法 timeout」（解析先于 spawn ⇒ 零 spawn）证明走了 timeout-bg 的 ops。
- **能力载荷/守卫是纯逻辑**：真 event bus + 手写载荷，穷举畸形形状、撞名、`isRemoteCall` 非布尔等。
- **探针用假 ssh 断言命令与往返数**：ls 2 条、find 2 条；错误码与「消息里没有 `pi-remote`/盘符/宿主模板」逐条断言。
- **真机 opt-in**：新增一条真机用例（远端 bash 真在远端跑 `uname -s` = Linux + ls/find 的不存在/传文件错误码），
  与本机 WSL 实测 8/8；另有一次真实 pi 会话端到端（`-e` 两个扩展 → 合并后的 bash 带 remote 返回 `Linux`）。

## 范围外

- 不打宿主补丁（红线 8）；上游 API 缺口只记 `general-todo#30`。
- 不做跨扩展 import、不走 `globalThis` 私有槽；不给远端命令实现「超时转后台」（远端进程树管理是另一回事）。
- 不接管 remote-tools 的另外六个工具（只有 `bash` 是共享名）；`powershell` 不参与协商。
- 不为 read/write/edit/grep 添加同款目录探针（它们的错误路径已经是结构化的）。
- 不做能力载荷版本字段（形状演进用新频道 `…:v2`）。
