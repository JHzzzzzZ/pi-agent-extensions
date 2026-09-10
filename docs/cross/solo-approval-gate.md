# solo 审批门 — 跨扩展契约（solo-mode ↔ 审批方）

> last verified @ 134a3d6

solo-mode 扩展（`docs/extensions/solo-mode.md`）提供"免审批模式"：`/solo` 开启后，**审批摩擦类**确认自动按批准路径通过。本卡是唯一语义事实来源——读者（pwr / opencode-bridge / deep-init 各一份 `solo-gate.ts`）与写者（solo-mode）都必须符合本卡。

## 状态文件（唯一事实来源）

| 项 | 约定 |
| --- | --- |
| 路径 | `${PI_SOLO_MODE_FILE:-~/.pi/agent/solo-mode.json}`（空值/纯空白回落默认路径） |
| 格式 | `{"pid": <number>, "activatedAt": "<ISO>"}`（单行 JSON，仅 solo-mode 写） |
| 激活判定 | 文件可读 + JSON 合法 + **`parsed.pid === process.pid`** 三者同时成立 |
| 失败口径 | 其余一切情况（缺失/不可读/JSON 损坏/pid 缺失或类型不符/异 pid）⇒ **未激活（fail-closed）**，确认框照常弹 |

**为什么用 pid 而不是存在性**：扩展运行在 Pi 主进程内，子 pi 进程（PWR sub-agent、agent-team 成员、loop `--bg`）pid 不同 ⇒ 天然不继承 solo；崩溃残留文件在下次启动因 pid 不匹配而失效；并发 Pi 实例互不干扰。solo-mode 的 `session_start` / `session_shutdown` 只清自己的 pid 文件，绝不删除异 pid 文件。

**写者生命周期**：状态只在"当前会话进程 + 当前扩展实例"内成立——`/reload`、`/new`、`/resume`、`/fork` 与进程退出都会复位为关闭（带 `pi --solo` 启动时，新会话按该 flag 重新启用）；开启需一次 `ctx.ui.confirm`，无 UI 环境拒绝激活——**例外**：`pi --solo` 经宿主原生 flag 通道显式声明意图，跳过确认且无 UI 也生效（无头 `-p` / `--mode json` 可用）。

## 读者实现约定（三份同构 `solo-gate.ts` 是刻意重复）

扩展部署时被复制为独立目录，无法跨目录 import，因此 pwr / opencode-bridge / deep-init 各自复制一份约 20 行的只读实现，且：

- **每次判定现读文件，不缓存**（`/solo` 随时可切换）；
- 默认读取 `process.env`（环境表用于测试注入）；
- 只读，绝不写/删状态文件；任何异常静默转 `false`。

## 采纳方与效果（v1 范围）

| 采纳方 | 自动批准的门 | 口径 |
| --- | --- | --- |
| pwr | 批准卡（`workflow_validate` 弹卡点）、`workflow_start` 门控、已保存命令 `/workflow:run <name>` | **只产生 once 批准，绝不写 remembered 记录**；solo 关闭后既有 remembered 批准不受影响 |
| opencode-bridge | sync 确认、端口切换确认、restore 的选择 + 确认 | restore 自动选最新备份（列表本就"最新在前"）；备份链与指纹门控不变 |
| deep-init | `--create-new` 的 confirm-required 门控 | 仅放行该门；update 模式与其它校验不变 |

**明确不采纳**：误触保护类确认（agent-team viewer `D` 两步停止、`/team:clear`、pwr `/workflow:delete` 选择）、pi 的 `project_trust` 提示——solo 只豁免"审批摩擦"，不豁免"防误触"。

## 新增采纳方的步骤

1. 复制任一 `solo-gate.ts` 到目标扩展（保持同构：路径解析 + pid 校验 + fail-closed）；
2. 在审批门处先判 `isSoloActive()`：命中则跳过 prompt/confirm、走批准路径，并 `notify` 一句"`solo：已自动…`"（用户要能看见自动批准发生了）；
3. 补两类测试：`solo-gate` 的 fail-closed 单测（缺失/损坏/异 pid）+ 门本身的 solo 路径集成测试（断言 prompt 未被调用、动作照常执行）；
4. 同步目标扩展的知识库卡与本卡采纳表。

## 测试锚点

- solo-mode：`solo-mode/index.test.ts`（22 个）——写读/生命周期/fail-closed/写失败/启动 flag。
- pwr：`pwr/tests/solo-gate.test.ts` + `pwr/test/entry.test.ts` 的 solo 集成（弹卡点、workflow_start、已保存命令）。
- opencode-bridge：`solo-gate.test.ts` + `index.test.ts` 的 sync/端口切换/restore 三条 solo 路径。
- deep-init：`solo-gate.test.ts` + `index.test.ts` 的 `planDispatch` 与命令接线。
