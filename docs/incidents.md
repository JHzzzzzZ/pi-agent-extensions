# 事故与教训（纯增量，防重复踩坑）

> last verified @ 0142e14
>
> 记录格式：症状 → 根因 → 教训。新事故追加在表后；修完必须留档。

## TUI 渲染堆叠（agent-team /team:view，三轮修复）

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
