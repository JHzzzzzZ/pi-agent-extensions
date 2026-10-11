# 对齐：timeout-bg-todo#3 — 组合 remote-tools 的远端 bash 能力（shell 工具单一 owner）

- 条目：`timeout-bg-todo#3`（tags: `bugfix`）· 分支引用：`fix/shell-tool-composition`
- 日期：2026-10-10（UTC）· 参与：用户（选型「先做 3」）+ agent（设计）
- 状态：与 `remote-tools-todo#9` 同一变更交付（两半同时开工，故不设 `dep`——dep 门会挡住同批实现）

## 意图

timeout-bg 是 shell 工具（bash/powershell）的唯一生命周期 owner：它在 `session_start` 用 `createBashTool` 重新注册同名 bash（`index.ts:146/157`），因此必然压掉 remote-tools 在加载期注册的 bash —— 用户实测「带 `remote` 的 bash 跑在本机」。宿主 `registerTool` 是静默 last-write-wins，也没有「取回已注册定义再包裹」的 API，所以两个扩展不能靠覆盖共存。

本条目负责组合的另一半：**owner 在注册前用宿主官方跨扩展通道 `pi.events` 收集「shell 能力」**，把 remote-tools 提供的远端能力并进自己的 bash（schema 合并 + execute 分派），从而两个功能都保留；没有能力提供方时行为与今天完全一致。

## 范围

**做什么**

1. 注册前：`const box: { bash?: BashCapability } = {}; pi.events.emit(<契约频道名>, box)`（同步派发，订阅方在 `emit` 返回前填充）。
2. 盒子里有 `bash` 能力 ⇒ 注册**合并后**的 bash：
   - schema = 自身 bash 参数 ∪ 能力的参数片段（`remote`/`remotePort`/`remoteCwd`），`timeout` 参数的说明照旧；
   - `execute`：`capability.isRemoteCall(params) ? capability.executeRemote(...) : 自己的 timeout→后台执行`；
   - promptGuidelines = 自身指南 + 能力指南（若有）；description 保持 timeout-bg 的文案（远端指南由能力附加）。
3. 盒子里没有能力 ⇒ 与今天逐字一致（未装 remote-tools 的用户不受影响）。
4. **冲突可见 + 异常隔离**：注册前后若发现 bash 已被未知扩展接管（`getAllTools()` 的 `sourceInfo.path` 既不是 `builtin:bash`、也不是自己或已知伙伴）⇒ notify 一次；收集/合并路径的任何抛错都被 try/catch 挡住并回退到今天的行为（绝不破坏会话）。
5. 载荷形状校验：盒子里的对象来自别的扩展 ⇒ 只接受形如 `{ parameters, isRemoteCall, executeRemote }` 的载荷，畸形一律忽略。
6. 契约落 `docs/cross/`（频道名 + 载荷形状 + 语义），timeout-bg 卡片/README 同步；测试：有/无能力两条路径 + 畸形载荷 + 能力抛错回退 + 未知接管者 notify。

**明确不做什么**

- 不做跨扩展 import（两个插件仍可各自单独安装）；不用 `globalThis` 私有槽。
- 不改模型面契约（不新增参数；远端三件套由能力带来）。
- 不为远端命令实现「超时转后台」（远端进程树管理是另一回事）。
- 不接管 remote-tools 的其它六个工具（只有 bash 是共享名）。

## 验收标准

1. 装了 remote-tools 时：`bash` 的参数并集齐全（`command`/`timeout`/`remote`/`remotePort`/`remoteCwd`），带 `remote` 的调用转交能力执行、不带的走 timeout-bg 自己的执行（单测用注入的假能力断言分派；真机在 remote-tools 侧验收）。
2. 未装 remote-tools 时：注册的工具与今天逐字一致（既有 33 个测试全绿）。
3. 能力载荷畸形 / 能力 `isRemoteCall` 抛错 / `executeRemote` 抛错：各自回退到 timeout-bg 原行为且 notify，不产生未捕获异常。
4. 未知扩展接管 bash ⇒ notify 一次（`getAllTools()` 的 `sourceInfo` 判定），不静默。
5. `npm test` + `npm run typecheck` 全绿；跨厂商评审到无新意见；文档（卡片/README/横切契约）同步。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-10（UTC）· **方式**：对话内选择「先做 3 吧」（组合方案 B′：用 `pi.events` 协商，两个功能都保留）
- **逐条决策**：
  1. owner = timeout-bg（shell 生命周期本来就在它手里），remote-tools 只提供能力
  2. 通道 = 官方 `pi.events`（同步 `emit` + 可变盒子）
  3. 未装对端时行为不变、失败时回退并 notify（宁可见不静默）
  4. 与 `remote-tools#9` 同分支同批评审与合并；上游根因诉求走 `general-todo#30`
- **已知取舍（显式接受）**：能力载荷是运行时契约（跨插件），需要 `docs/cross/` 卡片 + 两侧形状校验来防漂移；契约演进（v1 只有 bash）以新频道或载荷版本号处理，不做过度设计。
- **开工放行**：用户已给出实施指示，对齐文档落盘后进入 `processing`。
