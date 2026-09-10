# 事故与教训（纯增量，防重复踩坑）

> last verified @ ef7791b
>
> 记录格式：症状 → 根因 → 教训。新事故追加在表后；修完必须留档。

## TUI 渲染堆叠（agent-team /team view，三轮修复）

- 症状：查看器顶部标题 + 成员页签逐帧重影堆叠；用户截图实锤。
- 根因：纯函数单测全绿但真机照样坏——堆叠只存在于 pi-tui 真实合成 / previousLines diff 路径，fake 结构断言不到。三轮渐进修：overlay maxHeight 对齐 + widget 暂停 → 照抄 fleet 壳 + 打开互斥。
- 教训：**宿主/进程边界风险必须接真实实现测**（`viewer-host.test.ts`：真实 TuiMainScreen headless 渲染 + VT 仿真还原屏幕字节流）；纯函数绿 ≠ 真机对。见 AGENTS.md「测试与 QA」。
- 后续（1.2.0）：重影反复出现的根源是 agent-team 抄 fleet 后两边各自漂移——已建立代码级同步矩阵 `agent-team/docs/tui-sync.md`（基线 pi-subagents v0.66.0），逐细节测试锁死；pi-subagents 每升版跟进一次，TUI 期望值只认矩阵。

## 亮块逐秒追加残影（agent-team widget）

- 症状：下方亮块每秒追加残影行，仅在某些 bundle 构建宿主上出现。
- 根因：组件工厂式逐帧重绘与宿主包装的 string 渲染不兼容。
- 教训：跨构建最稳路径是每秒 `setWidget(key, string[])` 纯字符串数组；并为渲染问题留环境开关（`PI_AGENT_TEAM_WIDGET=0`）便于 A/B 诊断。

## 超宽行触发宿主断言崩溃（agent-team）

- 症状：CJK 活动行超宽 → 宿主 TUI `doRender` 断言 "Rendered line exceeds terminal width" 崩溃。
- 根因：行宽未按终端宽度做 ANSI/CJK 感知截断。
- 教训：凡写入 TUI 的行必须 `fitLine` 式截断补齐到精确帧宽（charWidth 感知 CJK/ANSI）。

## 同步派单阻塞主会话（agent-team team_run）

- 症状：`team_run` 同步 await 期间无法对话，宿主 steering 队列到 run 结束才注入。
- 根因：同步契约阻塞主 agent 轮次。
- 教训：默认后台派单 + followUp 送达；同步契约保留为显式 `wait: true`。

## taskkill 全杀 node 进程

- 症状：清理挂起子进程时用 `taskkill /IM node.exe /F` 把宿主 pi 自身和无关 node 进程全杀。
- 教训：Windows 下清理子进程必须按 **PID 精确杀**（先 `wmic`/`Get-CimInstance` 查父 PID 链再杀），绝不满杀镜像名。

## /reload 后自定义工具消失

- 症状：`/reload` 后本应注册的工具没了。
- 根因/教训：工具注册只在扩展加载时执行；`/reload` 会重建扩展实例，注册逻辑必须幂等且不依赖上轮状态。调试时先确认扩展是否真的加载成功（目录形态 `extensions/<名>/index.ts`）。

## GBK 编码坑（Windows）

- 症状：PowerShell/cmd 管道里中文输出乱码、子进程输出解析失败。
- 根因：Windows 默认代码页 GBK，与 UTF-8 假设冲突。
- 教训：跨进程文本一律显式 UTF-8（子进程侧 `$OutputEncoding`/`chcp 65001` 或读 bytes 自行解码）；仓库源文件统一 UTF-8。

## 远程/深目录长命令挂起

- 症状：无界命令（无 timeout 的长测试、交互式命令）阻塞会话。
- 教训：每次命令显式传 timeout（快速操作 30–60s，npm test 120–300s）；长工作拆有界小步骤。见 AGENTS.md「命令超时（强制）」。

## worktree 内 junction node_modules 被 `git worktree remove` 沿链深删（主干 node_modules 两度受损）

- 症状：worktree 里为省安装用 `mklink /J node_modules` 指回主干 `agent-team/node_modules`；随后 `git worktree remove` 沿 junction **穿透删除**，把主干真实 node_modules 删掉一角（`@earendil-works/pi-ai`、`pi-coding-agent/dist`、`.bin/tsc` 先后消失），`npm test` 大面积文件级红（ERR_MODULE_NOT_FOUND / tsc 不存在）。
- 根因：递归删除会跟随目录 junction/符号链接到真实目标。view-stop（5fa873b 会话）与 agent-team-reliability（ef439a7 会话）两个 worktree 各犯一次，同一根因两起事故。
- 教训：① 绝不在 worktree 里 junction 主干 node_modules——需要依赖就在 worktree 内 `npm install`；② 删除目录报 "Filename too long" 时先怀疑沿链接深删，立即停手检查链接目标；③ 恢复手段：主干 `npm install` 重装后全量测试确认。

## CRLF 仓库自写替换脚本静默 MISS + `git checkout` 销毁未提交实现，把一字符错拖成多轮排查（loop v1.4.0 会话）

- 症状：给 loop 加 `--model` 解析时，`parseLoopCommand("5m x")` 在 `rest[0]` 处抛 `Cannot read properties of undefined`，而插桩显示 `mdl` 值完全正确；中间还被 TDZ 错误（`Cannot access 'mdl' before initialization`）与大面积测试回归轮番误导。
- 根因（三层叠加）：① 真正的 bug 是一字符错——返回形状从扁平 `bg.rest` 换成 result-union 嵌套后，`let rest = mdl.rest;` 忘改成 `mdl.value.rest`（静默 undefined，症状离根因十万八千里）；② 用自写 node 脚本做跨行字符串替换，LF 串匹配 CRLF 文件 8 处改 5 处 MISS，造成"部分改完"的假象；③ 排查中两次 `git checkout -- parse.ts` 把未提交的实现整个回退掉（其中一次还误删了当时唯一的实现副本）。
- 教训：① 改动返回形状（扁平 → `{ ok, value }`）时，逐个过一遍所有字段访问路径，嵌套层级变了路径必须跟着变；② CRLF 仓库的跨行编辑用 edit 工具（透明处理行尾），绝不用自写 LF 匹配脚本——MISS 是静默的；③ 永远不要对未提交工作跑 `git checkout -- <file>`，回退前先 `cp` 备份；④ 插桩打印值时先核对打印点与崩溃点的相对位置，否则"值正确"的结论本身就是错觉。

## 代码级同步只抄了"可见条件"，漏掉对照实现的核心判定半条（agent-team widget 抢 /login 方向键）

- 症状：`/login`（及 `/model`、`/settings` 等选择器）打开时，team 亮块的 widget 抢走 ↑/↓——选择器收不到键，无法选择提供方。
- 根因：v1.8.0「widget 激活门控对齐 fleet-status」只抄了「编辑器为空」半条，漏掉前半条 `editorHasFocus()` 短路（`fleet-status.ts:701/965`）。宿主 `/login` 是 `showSelector()` 把主编辑器替换为选择器并 `setFocus(selector)`（不是 overlay），而 pi-tui 输入分发是扩展 `onTerminalInput` 监听器**先于**聚焦组件（`TuiBase.handleTerminalInput`）——widget consume 则选择器永远收不到键。
- 教训：① 对照实现要**逐行比对，不能只抄可见条件/字面量**——"对齐完成"的判据是核心判定链一致；② 抢占式输入通道（`onTerminalInput`）必须自证"何时不该抢"：焦点归属是宿主的存在性事实（`getFocusedComponent()`/`focusedComponent` 结构判定），widget 只在焦点 = 主编辑器时介入；③ 这类宿主边界 bug 的回归测试必须走真实分发路径（`widget-focus-host.test.ts`：真 `TuiMainScreen` + 假终端 + 真 `CustomEditor`/`OAuthSelectorComponent`），纯函数单测锁不住监听器顺序。

## 状态条各跑各的节拍 + 排序靠碰巧，导致逐秒换位与挤占（状态条统一会话）

- 症状：run-timer 计时行与 loop 倒计时各自 `setInterval`，相位互不相关；同屏时 widget 相对顺序逐秒翻转（宿主 `setExtensionWidget` 每次 delete+set 移到底部）；footer 排序靠 key 字母序的巧合，随时加插件就变；倒计时粗粒度（>1h 只到分钟）时还每秒无意义重绘。
- 根因：刷新节拍没有跨插件契约；widget 栈顺序依赖宿主按注册序派发但从未被锁定/断言；footer 顺序依赖字母序巧合；UI 写入无内容指纹去重。
- 教训：跨插件「同屏时间类状态」必须显式契约化（`docs/cross/status-bar.md`）——统一对齐秒边界节拍（`aligned-ticker.ts`）+ 文本指纹跳过 + footer 两位排序带键 + 根契约测试锁定 `pi.extensions` 相对顺序与键带序；宿主 widget 刷新重排属宿主行为，本仓库不打补丁（AGENTS.md「仓库边界」），走上游（`docs/pi-widget-order-issue.md`）。
