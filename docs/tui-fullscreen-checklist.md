# fullscreen 默认下的 TUI 真机走查清单（general-todo#19）

> 状态：**待用户执行**。执行前，本文件与 `src/extensions/*/docs/tui-sync.md` 的 fullscreen 结论栏一律算「未取证」，不得宣称真机已验证（2026-09-15 教训：未 push / 未真机跑过的结论不算数）。
> 环境：pi 1.0.1，`tuiMode` 默认 `fullscreen`（旧默认 `regular`，回退 `--tui-mode regular` 或 `/settings` → TUI mode）。
> 对应条目：`todos/align/general-todo#19.md`。headless 侧（5 个 host 级测试 + `docs/assets/*.svg` 重生成）已由 agent 完成，本清单只覆盖真机面。
> 预计耗时：**约 45–60 分钟**（不含等 run 派单 / 模型响应）。分组估算：A 10 分 · B 15 分 · C 8 分 · D 10 分 · E 5 分 · F 6 分。
> 判据格式：**操作 → 期望观察 → 失败判据 → 需记录的证据**。任何异常只记现象与复现按键，**不在走查中改代码**（另立 `todos/` 条目）。

## 0. 前置（一次性，约 5 分钟）

1. **确认版本与模式**：终端外执行 `pi --version`（应 ≥ `1.0.1`）；会话内 `/settings` 看 `TUI mode` 当前值——以它为准（本机当前未设 `tuiMode`，即默认 **fullscreen**，本清单的默认档）。
2. **确认包缓存是最新**：pi 加载的是包缓存 clone（`~/.pi/agent/git/github.com/JHzzzzzZ/pi-agent-extensions`），不是工作仓库。执行 `pi update` 后**重开会话**（`/reload` 不够）。
3. **准备姿态**：终端 ≥ 100 列 × ≥ 30 行；打开一个记事本（F1 要粘贴验证）；截图存 `history/team-runs/<本次目录>/assets/real/`（`history/` 不入库，可自由建）。
4. **可选对照档**（有价值，不强制）：另起一个会话 `pi --tui-mode regular`，只重跑 A、B 两组，把两模式的差异写进回传——若完全一致，也请明说「两模式行为一致」。

## 1. 命令速查（可整段复制）

```
/team:run dev-team 只做一件事：立刻用 team_ask 向我提一个长提问——题面 ≥30 段（每段一行「第 N 段：细节…」）、含空行分段、给 8 个选项（方案 1…方案 8），超时用默认值；拿到我的选择后在报告里写「用户选择：方案 X」。不要改任何文件。
/team:run dev-team 只做只读侦察：列出当前目录顶层文件并逐个说明用途，不改任何文件。
/team:view            # agent-team 查看器（run 在跑时打开）
/workflow:run dev-team 只做只读侦察：逐个读取顶层文件并总结用途，不要修改任何文件
/workflow:view        # pwr 查看器
/workflow:stop <runId>
/loop 5m 走查 widget 排序带（可删）
/loop:list  /loop:delete <id>  /loop:clear
/solo:on    /solo:off
/goal 走查 footer 首段定格（可随时清除）     /goal:clear
```

## 2. A 组 · agent-team viewer（打开 / 切 run / 停止 / 返回）

先派两个 run（`[`/`]` 只在 ≥2 个 run 时生效；同一会话上限 3）：

```
/team:run dev-team 只做一件事：立刻用 team_ask 向我提一个长提问——题面 ≥30 段（每段一行「第 N 段：细节…」）、含空行分段、给 8 个选项（方案 1…方案 8），超时用默认值；拿到我的选择后在报告里写「用户选择：方案 X」。不要改任何文件。
/team:run dev-team 只做只读侦察：列出当前目录顶层文件并逐个说明用途，不改任何文件。
```

| # | 操作 | 期望观察 | 失败判据 | 证据 |
|---|---|---|---|---|
| A1 | `/team:view` | 分栏 overlay 完整：顶边框 + 标题行 `agent-team viewer` **恰好 1 行** + 左 roster + 右 5 行头（`Run:`/`State:`/`成员:`/`模型:`/`活动:`）+ 图例 + 底边框；多 run 时图例含 ` · [/] 切 run` | 标题行/顶边框出现 ≥2 次（堆叠）、左右边框断裂或错列、CJK 半字撕裂、overlay 外出现孤立竖线/残行 | 截图 1 张；把顶边框那行整行复制出来（选择见 F1） |
| A2 | 保持 viewer 打开，等长提问到达（第一个 run 的 `team_ask`） | viewer **自动收起** → 提问视图（长题=自绘 overlay；短题=宿主对话框）独占屏幕、按键有响应；作答/取消后 viewer **自动重开**且仍在原成员页 | 提问被 viewer 盖住 / 按键被抢（旧 bug #153）、作答后不重开、重开后帧残缺或双标题 | 截图 2 张（提问弹出时、重开后） |
| A3 | 依次按 `[` `]` | `Run:` 行随当前 run 变化，roster 与正文整体重建、帧高不变、无残行；回到原 run 内容一致 | 新旧 run 内容重叠（重影）、帧变高/变矮后残留半截边框、切 run 后 actor 页丢失（新 run 无该成员应回 leader 首位） | 截图（切换前后各 1 张） |
| A4 | 按 `D`，再按 `N`（取消）；再按 `D`，再按 `Enter`（确认） | 首次进确认态：右栏头下方横幅 `确认停止 run <完整 runId>？`，`N`/`Esc` 取消且**不关** viewer；确认后横幅转停止中 → `run 已停止（aborted · Xs）；该 run 的报告不再送达`；另一个 run 不受影响 | `D` 一次就停（无二次确认）、取消后 viewer 被关闭、确认后 overlay 卡住或横幅不消失、两个 run 一起被停 | 截图 3 张（确认态、停止中、结果态） |
| A5 | `Esc`（也可试 `q` / `ctrl+c`） | viewer 关闭；主屏回到正常对话且原 overlay 区域**干净**（无 `╭`/`│`/`╰` 残行、无半行、无重影）；光标回到编辑器可正常输入 | 任何边框残迹、主屏重复渲染上一次内容、输入框错位 | 关闭后截图 1 张 |

## 3. B 组 · agent-team askview 三档宽度（80 / 60 / 40）

每档都需要**重新触发**一次长提问，两条路径（Enter 提交 / Esc 取消）各走一次 ⇒ 每档 2 次触发，共 6 次。

- **调宽**：拖拽终端窗口右缘（Windows Terminal 会显示 `宽×高` 浮标）。无法确定列数时数顶边框 `─` 的个数：帧宽 = `─` 数 + 2，终端列数 = 帧宽 + 4（80 列 → 帧宽 76 → 74 个 `─`；60 → 58；40 → 38）。
- **触发模板**：见 §1 第一条（长题 + 8 选项，与 headless 走查同形）；也可用你手头任意 >200 字符 / 多段 / 多选项的澄清任务。

| # | 操作 | 期望观察 | 失败判据 | 证据 |
|---|---|---|---|---|
| B1 | 80 列：触发 → 观察初始帧 → `PgDn` 到底 → `↓` 六次 → `Enter`；再触发一次 → `Esc` | 帧宽 76；题面折行**无半个汉字**、题面首行后**保留空行**；选项头 `可选（共 8 项，显示 1-6，↑↓ 选择）：`；`› 方案 1` 高亮且随 ↓ 移动；`PgDn` 到底可见 `第 30 段` 且再按不跳变；↓ 六次后表头变 `显示 2-7`；右下**静态**文案 `超时：10 分钟后自动取消`；Enter 后 overlay 整体消失、答案进入 run 后续进展；Esc 取消且屏面同样干净 | overlay 消失后残行/重影、边框 CJK 撕裂、终端把帧行折成两行、选项窗口不跟随、超时文案变倒计时、Esc 不取消 | 截图：initial / bottom / follow / enter-clean / esc-clean 各 1 张 |
| B2 | 60 列：同上全套 | 帧宽 58，其余同 B1 | 同 B1 | 同上命名 |
| B3 | 40 列：同上全套，另核 3 条 | 帧宽 38（宿主把 `minWidth: 60` 钳到 `cols−2`）；**不得**出现单行提示 `agent-team 提问至少需要 36 列。Esc 取消。`；`╮`/`╰` 在屏幕内、右边框整齐；尾行静态超时文案可读 | 出现 minWidth 单行提示（<36 列才该出现）、右边框越出屏幕或撕裂、底边框缺失 | 同上命名 |

**已知预期行为（不是 bug）**：40 列时键位图例左段被截（`↑↓ 选项 · J…`）——`rightAligned` 右截左，headless 同样如此。

## 4. C 组 · pwr viewer（分栏 / 滚动 / 两步停止）

| # | 操作 | 期望观察 | 失败判据 | 证据 |
|---|---|---|---|---|
| C1 | 先 `/workflow:run dev-team <只读任务>`，再 `/workflow:view` | 分栏 overlay：左 roster = 结构 / 每个 stage / 结果 / 脚本（选中 `›` + 状态图标 + 右对齐状态），右 = 三行头 `Run:`/`State:`/`条目 i/n` + 可滚动正文；不传 runId 默认最近活跃 run | 分栏串位（roster 行落进右栏）、帧重复、边框断裂 | 截图 1 张 |
| C2 | `↑↓`/`k j` 选条目 → `Shift+K/J` 滚正文 → `PgUp/PgDn` → `Home/End` → `x`/`X`/`ctrl+o` trace 开关 → `r`/`R` 强刷 | 选中行移动、正文随之切换；滚动无错行，滚到底自动恢复跟随；翻页 = 视口高度；trace 开关立即生效且帧高不变；`r` 绕过 750ms 门控立即重载 | 滚动后帧顶重复标题、正文错行/串行、trace 开关把帧撑高、`r` 无反应 | 截图 2 张（滚动中、trace 关闭） |
| C3 | 按 `D` → `Esc`（取消）；再 `D` → `Enter`（确认） | 与 A4 同口径，但**横幅里的 runId 只显示前 8 位**（`确认停止 run <runId 前 8 位>？`，pwr 侧实现如此截断，不是异常）；`Enter`/`Y` 确认（`Esc`/`ctrl+c`/`N`/`backspace` 取消）；确认后 run 终止，`/workflow:list` 状态变 aborted/stopped | 无二次确认、取消后 viewer 被关、停止后状态未变 | 截图 2 张 |
| C4 | `q` / `Esc` 关闭 | 主屏干净（同 A5） | 残行 / 重影 | 截图 1 张 |

## 5. D 组 · widget 排序带（pwr / run-timer / loop）

三段来源（编辑器**上方**，宿主单键 `widget-band`）：

| band | 段 | 内容 | 怎么让它出现 |
|---|---|---|---|
| 10 | pwr | `PWR runs:` + 每个 run 一行（无 run 时占位 `  (no runs)`，**实现如此、不是 bug**） | 跑一个 workflow run（C 组的即可） |
| 20 | run-timer | dim 单行 `任务 … · 本轮 … · 本会话 …` | 每次 agent 回合自动刷新 |
| 30 | loop | `⏰ loop N 个任务 · 下次 <倒计时>` | `/loop 5m 走查 widget 排序带（可删）` |

| # | 操作 | 期望观察 | 失败判据 | 证据 |
|---|---|---|---|---|
| D1 | 让 pwr run 在跑 + 发一条对话驱动 run-timer + `/loop 5m …`，**盯 30 秒** | 自上而下恒为 **pwr 块 → run-timer 行 → loop 行**；三段都在秒级刷新期间顺序**不变**、不抽搐、段间无空行 | 任意两段交换位置 / 逐秒跳位、段间插入空行、某段文字被另一段截断 | 三张相隔 ~10s 的截图（同一区域裁切） |
| D2 | `/loop:delete <id>`（或 `/loop:clear`）→ 再停掉 workflow run（`/workflow:stop <runId>` 或 viewer `D`） | loop 段消失后剩 pwr 块 + run-timer 行，顺序不变；pwr run 落定后该段显示终态 run 行（不死、不变成占位行），run-timer 仍在最后；无残行/空行 | 段消失后留空行、剩余段顺序变化、pwr 行与 run-timer 行互相叠行 | 每步 1 张截图 |
| D3 | `/reload`（或退出会话）后重开 | widget 区域整块重建、无「上一会话残留段」；重开后 PID/时间不再叠加 | 残留上一轮文本、出现两组相同段 | 1 张截图 |

## 6. E 组 · status-band（footer 首段定格 + 段出现/消失）

| # | 操作 | 期望观察 | 失败判据 | 证据 |
|---|---|---|---|---|
| E1 | `/solo:on` | footer 最左为 `⚡ solo`，**无前导 `│ `**（首段定格） | 行首出现悬空 `│ ` | 复制 footer 整行文本 |
| E2 | `/goal 走查 footer 首段定格`（band 10 < 40，插到 solo 前） | **立即**（事件驱动、不等下一拍）变为 `◎ … · 0轮 · 00:00 │ ⚡ solo`——goal 段无前缀、solo 段带 `│ ` | `│ │` 双分隔、solo 仍无前缀、要等 1 秒才重排 | 复制 footer 整行文本 |
| E3 | `/goal:clear` → 再 `/solo:off` | 清 goal 后 `⚡ solo` 回到最前且前缀消失；`/solo:off` 后段消失，行内不留双空格或孤立 `│` | 前缀残留、段间两个空格、段消失后仍占位 | 复制 footer 整行文本 |
| E4 | （可选）跑 workflow run 看 `pwr N▶` 段（band 30）、对话流式时看 stream 段（band 50） | 出现/消失时同样满足首段定格与即时重排 | 同 E2/E3 | 复制 footer 整行文本 |

## 7. F 组 · 背景交互（鼠标选择 / 滚轮 / scrollbar）

| # | 操作 | 期望观察 | 失败判据 | 证据 |
|---|---|---|---|---|
| F1 | 拖选会话正文一段文本 → 释放 → 粘贴到记事本；再拖选 viewer 里的标题行/边框区域 | 释放即复制（`fullscreenCopyOnSelect` 默认 `true`）；内容与选中一致（含 CJK，不乱码、不带转义序列）；选择高亮可见且不被 widget/overlay 打乱；overlay 内文本也可选可复制 | 剪贴板为空或缺字、粘贴出 `\x1b[` 转义、选择高亮错位 | 粘贴结果截图 / 文本 |
| F2 | （可选对照）`/settings` → `Fullscreen copy on select` → `false` → 拖选后按 `Ctrl+X` → 再恢复 `true` | 关闭后不再自动复制，按提示 `Ctrl+X` 复制成功；恢复后重新自动复制 | 关闭后仍自动复制 / `Ctrl+X` 无效 | 1 张截图 |
| F3 | 滚轮：慢滚一格、快速连滚、`alt+滚轮` | `auto` 档：慢滚 = 1 行/事件，快滚明显加速（每事件最多 6 行），`alt+滚轮` = 5 倍；滚动会话正文不产生重复行/重影；viewer 打开时滚轮只滚会话 scrollback（viewer 正文只认 `J/K`/`PgDn`），viewer 帧不被顶破 | 滚轮让 overlay 帧重复/错行、滚动后页面残留重复历史行、scrollback 卡死 | 滚动前后截图各 1 张 |
| F4 | 滚离底部 → 回到底部；`/settings` 里试 `Fullscreen scrollbar` = `always` / `hidden` | `auto`：滚离底部时右缘出现 scrollbar、回到底部消失；`always` 常显、`hidden` 不显示；scrollbar 与 overlay 边框不相撞 | scrollbar 压破 overlay 边框、位置与实际滚动量不符、底部仍显示 | 截图 2 张（离底、到底） |

## 8. 回传与判据

- **截图命名**：`<组>-<步骤>.png`（如 `B1-80col-initial.png`），存 `history/team-runs/<本次目录>/assets/real/`。
- **文字**：每组每步给 `PASS` / 异常描述。异常只需：终端 `列×行`（浮标或数 `─`）、复现按键序列、看到什么。
- **判定**：全 PASS → `general-todo#19` 收口；任一异常 → 逐条另立 `todos/` 条目（现象 + 复现步骤），修复走独立 worktree。
- **模式对照**：若跑了 `--tui-mode regular` 对照档，请单独写明「fullscreen 与 regular 行为一致 / 差异为 X」。

## 9. 边界（本清单范围外）

- 不要求改 `~/.pi/agent/settings.json` 的 `tuiMode`（保持你自己的选择）；F2/F4 里临时改的项请改回默认（`true` / `auto`）。
- 不覆盖：< 36 列 minWidth 单行提示分支、>8 个选项、`fullscreenExitOutput`（退出全屏的 transcript 行为）、终端字体/宽字符字形差异、触控。
- 走查期间**不改任何插件代码**；发现问题只记录（对齐 `todos/align/general-todo#19.md` 的处置约定）。
