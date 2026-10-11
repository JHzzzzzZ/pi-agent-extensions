# 对齐：remote-tools-todo#9 — bash 的 remote 参数被 timeout-bg 覆盖（跨扩展组合契约）

- 条目：`remote-tools-todo#9`（tags: `bugfix`）· 分支引用：`fix/shell-tool-composition`
- 日期：2026-10-10（UTC）· 参与：用户（报障 + 选型「先做 3」= 组合方案 B′）+ agent（根因定位、业界做法调研）
- 状态：用户已选定组合方案，待 `align` 过后进入 `processing`；timeout-bg 侧的配套条目 = `timeout-bg-todo#3`

## 意图

用户实测：`bash(command="uname -s", remote="user@127.0.0.1")` 返回本机 `MINGW64_NT`，带 `remoteCwd` 也仍用本机 cwd，reload 后依旧。根因已核：timeout-bg 在 `pi.on("session_start")`（index.ts:146/157）重新注册同名 `bash`，时点晚于所有扩展的加载期注册 ⇒ 必然压掉 remote-tools 的 bash。宿主 `registerTool` 是静默 last-write-wins，且没有取回已注册定义再包裹的 API（`getAllTools()` 只给 schema + `sourceInfo`，无 `execute`）⇒ 两个扩展抢一个名字，冲突不可见，必有一方功能消失。

调研（业界四类做法）：① 命名空间/前缀（MCP 客户端，如 openai-agents-python #2442）——不适用（模型面必须叫 `bash`）；② 冲突 fail-loud（VS Code `registerCommand` 重复注册报错；Hermes Agent 覆盖内置需 operator 显式 opt-in；Rust `ToolRegistry` 默认 evict+warn/`try_register`）——最低底线；③ 显式优先级（pluggy `tryfirst/trylast`、webpack `enforce`）——宿主无字段；④ **组合/包裹链**（pluggy hook wrapper；**pi 自己的 `registerToolRenderer((name, next) => …)`**）——最理想，pi 只在 renderer 上有。

用户选择：**不牺牲任何一方，做组合（B′）**——用宿主官方跨扩展通道 `pi.events`（`dist/core/event-bus.js`：`emit` 同步派发、无返回值）做一次能力协商：shell 工具的唯一 owner（timeout-bg）在注册前广播一个盒子，remote-tools 把「远端 bash 能力」放进去，owner 合并 schema 并按参数分派。上游根治诉求另立条目 `general-todo#30`（请 registerTool 对齐自家 registerMcpServer/renderer 的口径）。

## 范围

**做什么**

1. remote-tools 在 `pi.events` 上订阅收集频道，把 **远端 bash 能力**放进盒子里：`{ parameters（remote/remotePort/remoteCwd 三个可选参数的 TypeBox 片段）, isRemoteCall(params)（复用 `parseTarget` 的噪声/缺省值字面量容错）, executeRemote(id, params, signal, onUpdate, ctx), guideline }`。载荷形状与频道名是本仓新的**横切契约**（进 `docs/cross/`）。
2. remote-tools 把自己 bash 工具的**远端分支**抽成单一实现的 `executeRemote`（守卫 `assertMarkerRootUsable`、路径校验、session、remote ops、远端 ctx 全在里面），自己的 bash 工具与能力载荷共用它（不许两份）。
3. remote-tools 保留自身的 bash 注册（未装 timeout-bg 时它是唯一 owner），行为与今天一致。
4. 载荷收发两侧都做形状守卫 + try/catch：盒子里的东西不可信（可能来自任何扩展），畸形载荷当作「没有能力」并走各自的原路径。
5. 测试：remote-tools 侧的能力载荷（isRemoteCall 的噪声容错、executeRemote 走远端 ops）；跨扩展组合测试（真实 `discoverAndLoadExtensions` + 真实 event bus 载入两个扩展，断言组合后的 bash 同时具备远端三参数与本地 timeout 语义；若宿主加载器在本仓不可用，则退化为「真 event bus 语义 + 两侧真实现」的组合测试并在文件头写明边界）。
6. 文档：`docs/cross/` 新契约卡 + `docs/extensions/remote-tools.md`/`timeout-bg` 卡片与 README 的对应段落 + 根 README/AGENTS 测试数同步。

**明确不做什么**

- 不改模型面契约：`bash` 的参数仍是 today 的并集（`command`/`timeout` + `remote`/`remotePort`/`remoteCwd`），不加新参数。
- 不做跨扩展 import（两个插件保持自包含、可单独安装）；不走 `globalThis` 私有槽。
- 不打宿主补丁；上游诉求走 `general-todo#30`。
- 不给远端命令做「超时转后台」（远端进程树管理是另一回事，v1 已记录）。

## 验收标准

1. **两个功能同时可用**：装了两个扩展时，`bash(command="uname -s", remote="user@127.0.0.1")` 在远端执行；不带 `remote` 的 bash 仍走 timeout-bg 的「超时转后台」语义（`timeout` 参数说明、超时转后台行为都在）。
2. **未装组合方时行为不变**：只装 timeout-bg ⇒ 与今天逐字一致；只装 remote-tools ⇒ bash 远端能力照常（自身注册仍在）。
3. **冲突可见**：owner 注册前若发现 bash 已被**未知扩展**接管（`getAllTools()` 的 `sourceInfo.path` 既非 `builtin:bash`，也不是自己或已知伙伴），notify 一次而不是静默；组合路径内部抛错时回退原路径并 notify（异常隔离，绝不破坏会话）。
4. **真机验收**：WSL 目标上 `bash remote=...` 真在远端跑（`uname -s` 返回 `Linux`）、`remoteCwd` 生效；remote-tools 既有 7 个真机用例保持绿。
5. 两扩展单测全绿 + `npm run typecheck` 零错误 + 全量门绿；跨厂商评审到无新意见（红线 11）。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-10（UTC）· **方式**：对话内选择「先做 3 吧」（= 调研给出的第三个建议：用官方 `pi.events` 做能力协商的组合方案 B′，两个功能都保留）
- **逐条决策**：
  1. 归属：**shell 工具 owner = timeout-bg**（它已在管 bash/powershell 生命周期），remote-tools 通过 `pi.events` 提供远端能力
  2. 通道：**官方 `pi.events`**（不是 `globalThis` 私有槽、不是跨扩展 import）
  3. 兜底：**冲突可见 + 异常隔离**（未知接管者要 notify；组合路径失败回退原路径）
  4. 上游根治诉求**另立条目**（`general-todo#30`），本条目只做仓库内组合
- **已知取舍（显式接受）**：组合后 `bash` 的 `description`/`promptGuidelines` 由 owner 合成（远端指南以能力载荷附加）；`pi.events` 是同步派发、无返回值，因此契约是「盒子（可变对象）+ 同步填充」而不是请求-响应。
- **开工放行**：用户已给出实施指示，对齐文档落盘后进入 `processing`。
