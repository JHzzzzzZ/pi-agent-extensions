# solo-mode — 免审批模式（审批门自动批准）

> last verified @ 20dbb78

## 职责与边界

`/solo` 一键切换"免审批模式"：开启后本仓库**审批摩擦类**门自动走批准路径——PWR 批准卡（按 once）、opencode-bridge 的 sync / 端口切换 / restore 确认（restore 自动选最新备份）、deep-init 的 `--create-new` 二次确认。**不做**：不禁用委派（不屏蔽 subagent/团队/workflow 工具）、不自动批准误触保护类确认（agent-team viewer `D` 停止、`/team:clear`、`/workflow:delete` 选择）、不处理 pi `project_trust` 提示、不做快捷键、不跨会话持久化。

**仅当前会话**：`/reload`、`/new`、`/resume`、`/fork` 与进程退出即复位；子 pi 进程（PWR sub-agent / agent-team 成员 / loop `--bg`）天然不继承。

## 文件地图

- `index.ts` — 单文件全部逻辑（无 package.json，2 空格缩进）：常量区（状态键/文本/用法/确认正文/`SOLO_FLAG_NAME`）→ 纯函数（`parseSoloCommand` / `soloFlagEnabled` / `resolveSoloStatePath` / `readSoloState` / `isSoloActive` / `writeSoloState` / `clearSoloState`）→ 扩展工厂 `createSoloModeExtension(pi, deps)`。**改文案/路径/命令面必看顶部常量区。**
- `index.test.ts` — 22 个测试，手写 fake（pi 宿主 / UI / flag / 时钟）+ 临时目录状态文件（`PI_SOLO_MODE_FILE`），不碰真实 `~/.pi/agent`。
- 跨扩展语义在 `docs/cross/solo-approval-gate.md`（读者实现契约，唯一事实来源）；本卡只管写者。
- 无独立 README；行为说明在 `index.ts` 文件头注释与根 `README.md` 小节。

## 核心数据流

1. `/solo`（空参切换）/ `/solo:on|:off|:status`（独立静态命令）/ 未知参数 → usage 提示（`parseSoloCommand` 只识别空参 toggle，其余返回 usage，未知不抛错）；旧空格写法（`/solo on` 等）经裸入口只提示改名、绝不执行。
2. 开启：无 UI（`hasUI` 假或 `ui.confirm` 缺失）→ 拒绝并 warning；否则 `ctx.ui.confirm`（静态清单文案）→ 取消则不写文件；确认后写状态文件 → `writeBand(SOLO_STATUS_KEY, "⚡ solo", writer)`（前缀由 status-band 决定：最前段无前缀、其余段 `│ `）→ notify。
3. 关闭：删状态文件 → 清状态条；**删除失败必须 error notify**（否则用户以为关了但读者仍会看到激活）。
4. 读者（pwr / opencode-bridge / deep-init）各自在审批门处 `isSoloActive()` 现读，命中则跳过 prompt、走批准路径并 notify "solo：已自动…"。
5. `session_start`（任意 reason）清 own-pid 状态文件 + 状态条，随后读 `pi.getFlag("solo")`（宿主原生 CLI flag，boolean，注册名 `solo`）：为真则直接启用（显式意图、**不弹确认**、无 UI 也生效——无头 `-p`/`json` 可用；写失败同样 fail-closed 保持关闭）；`reason === "reload"` 且确有残留时额外 notify"已随扩展重载复位"。因此 `/solo:off` 在会话内生效，`/reload`/`/new` 等新会话按启动 flag 重新启用。`session_shutdown` 同样清理。

## 不变量

- **状态文件契约**（`docs/cross/solo-approval-gate.md`）：路径 `${PI_SOLO_MODE_FILE:-~/.pi/agent/solo-mode.json}`，`{pid, activatedAt}`，激活判定必须同时满足可读 + JSON 合法 + `pid === process.pid`；其余一律 fail-closed。读者三份 `solo-gate.ts` 与写者同构，改一处必须四处同步。
- **只清自己的 pid**：`session_start` / `session_shutdown` / 关闭只处理 own-pid 文件，绝不删除异 pid 文件（并发 Pi 实例互不干扰）；崩溃残留靠 pid 不匹配自然失效。
- **启动 flag 走宿主原生通道**：`pi.registerFlag("solo", {type:"boolean", default:false})` + `pi.getFlag("solo")`——不直读 `process.argv`（宿主会拒绝未注册的 `--solo`：`Unknown option: --solo`），也不自行定义 flag 名字以外的解析；值归一由 `soloFlagEnabled`（true/"true"/"1"）负责。
- **对 PWR 只产生 once**：solo 绝不写 remembered 批准记录（`pwr/index.ts` 三处接线都强制降级 once），solo 关闭后既有 remembered 批准不受影响。
- **异常隔离**：fs / UI 调用全部 try/catch；notify/setStatus 失败不影响状态机。
- 状态条文本是纯字符串（宿主 `ExtensionUIContext` 无 `theme` 字段，不能调 `theme.fg`）；写入经本地 `status-band.ts`（最前段无前缀、其余段 `│ `，低带出现/消失会重渲染本段）；写入前 `ctx.hasUI` 守卫。键 `40:solo-mode` 为排序带（`docs/cross/status-bar.md`），不可改回 `solo-mode`；状态是静态的，不跑 ticker。

## 已知坑

- **`/reload` 后是否复位取决于 session_shutdown 是否已跑**：宿主正常路径是 shutdown 先清文件再 reload；`session_start` 里的 reload 提示只是二次保险（文件已不在时不提示）。测试断言的是"reload 后有残留则清 + 提示"，别把提示当成必然输出。
- **子进程不继承是特性不是缺口**：PWR sub-agent / agent-team 成员在子 pi 里读不到主进程 pid 的状态文件，因此 solo 不影响委派出去的子 agent——这是有意的安全边界（免审批只限当前会话）。
- **opencode-bridge 的 `env` 注入**：bridge 用扩展注入的 `env`（`BridgeExtensionDeps.env`）读状态路径；生产默认为 `process.env`，测试可注入隔离环境表，不必改全局环境变量。
- **删除失败别静默**：`clearSoloState` 返回 boolean；`rmSync` 对目录等异常路径返回 false——"关闭"路径必须据此 error notify（`index.test.ts` 有回归）。
- 无 package.json：测试必须从仓库根跑 `node --experimental-strip-types --test solo-mode/index.test.ts`，不能 `cd solo-mode` 后 npm test。

## 改动清单

- 必跑：`node --experimental-strip-types --test solo-mode/index.test.ts`（22 个，仓库根执行）。
- 改命令面/文案：只动 `index.ts` 常量区与 `parseSoloCommand`，同步 `index.test.ts` 的解析与文案断言 + 根 README 小节。
- 改状态文件契约（路径/字段/判定）：同步 `docs/cross/solo-approval-gate.md` + pwr/opencode-bridge/deep-init 的 `solo-gate.ts` 与其测试——**契约卡与三份实现必须一致**。
- 新增采纳方：按 `docs/cross/solo-approval-gate.md` 的"新增采纳方步骤"（复制 `solo-gate.ts` + 门处判定 + notify + 两类测试 + 文档）。
