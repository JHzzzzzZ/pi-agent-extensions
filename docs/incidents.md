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
- 教训：每次命令显式传 timeout（快速操作 30–60s，npm test 120–300s）；长工作拆有界小步骤。见 AGENTS.md 规则红线·命令超时。

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
- 教训：跨插件「同屏时间类状态」必须显式契约化（`docs/cross/status-bar.md`）——统一对齐秒边界节拍（`aligned-ticker.ts`）+ 文本指纹跳过 + footer 两位排序带键 + 根契约测试锁定 `pi.extensions` 相对顺序与键带序；宿主 widget 刷新重排属宿主行为，本仓库不打补丁（AGENTS.md 规则红线·仓库边界），走上游（`docs/pi-widget-order-issue.md`）。

## overlay 帧行带原始换行 → 行错位残行（agent-team viewer「重复行第四轮」）

- 症状：`/team:view` 打开时，左栏（roster 列）下方每派发一条出现 `  - front: 请数出数字 N（计数序列的一部分）…` 残行；run 摘要文本出现在错误行、与相邻行重叠（用户截图：`统计: 8 次 team_dispatch…`、`行。` 片段）；帧边框/页脚位置漂移；残行跨刷新持久（computer-use 抓屏 pane1/pane2 相隔 3s 像素级相同）。
- 根因：`cockpit.ts:499` 把每次派发写成多行 tool 条目（`team_dispatch 派发 →\n  - <member>: <task>`），`viewer.ts` 的 tools 渲染分支把它当单行输出——帧行字符串携带原始 `\n`（`fitLine` 按显示宽度算，换行符宽 0，照样通过宽度校验）。宿主按物理行写屏时，换行把尾巴挤到下一行同列（roster 列区域），且实际行数比声明多 1 → 帧几何错位；diff 渲染器不知道这些脏格，残行持久。最小复现：`bodyLines([{kind:'tool',text:'team_dispatch 派发 →\n  - front: …'}], true, 100, plainStyles())` 返回的行含原始 `\n`。
- 教训：① overlay/帧渲染的边界契约是「每个帧行必为单物理行」——任何来自子进程/持久化文本的 `\n` 都必须在块渲染层拆行，`fitLine` 再兜底折叠，绝不依赖宿主替我们处理；② 同族路径（widget）早已 `\s+` 压平（`widget.ts:66`）所以无此 bug——对照实现时「哪些字段压平了」必须逐路径对齐；③ 纯函数单测绿 ≠ 真机对：本 bug 只在真实合成/写屏路径显现，`viewer-host.test.ts` 的 FakeScreen 的 `\n` 语义（row+1 同列）与真机一致，可稳定复现；④ 真机取证优先用 computer-use + PowerShell 全分辨率抓屏（跨 3s 两帧像素级对比），比低分辨率截图更能定位「哪一列/哪一行」在错位。

## worktree 内的 Windows 目录联接（junction）会清空目标 node_modules（环境事故）

- 症状：worktree 收尾后主工作区依赖消失——首次 `agent-team/node_modules` 只剩空骨架，第二次 `pwr/node_modules` 被清空；下一次跑测试/截图工具直接 `ERR_MODULE_NOT_FOUND`（本轮两次撞上，各花 ~1 分钟 npm install 恢复）。
- 根因：为省一次 `npm install`，在 worktree 内用 `mklink /J` 把 `node_modules` 指向主工作区。NTFS 联接不是符号链接——递归删除（`git worktree remove --force`）会**穿透联接删除目标目录内容**，且联接本身一并消失，现场无痕迹；本次即使先 `cmd //c rmdir <junction>` 再删 worktree，`pwr` 侧仍被穿透。
- 教训：① **worktree 内不要建 junction**（AGENTS.md 规则红线·worktree 实现）——要么 worktree 内真实 `npm install`，要么主工作区跑测试、worktree 只写代码；② 万不得已用了联接：删除顺序「先解除链接 → `dir /AL` 确认链接消失 → 再 `git worktree remove`」，删完立刻 `ls` 校验目标目录（本轮逐一校验仍被穿透，说明该做法不可靠）；③ 恢复便宜（`npm install`）但会打断无人值守轮次——把它当红线，不靠事后补救。

## 子进程继承 cwd → 临时目录清理 EPERM（深冒烟工具）

- 症状：`tools/install-smoke.mjs --task` 成功跑完但收尾删不掉临时配置目录——`fs.rmSync` 抛 `EPERM`（`maxRetries: 8, retryDelay: 250` 的内部重试也没吸收，锁定 >9s），而目录里逐个文件都能删、几分钟后再删目录又能成功。
- 根因：深任务拉起真实 `pi` 子进程时 `cwd` 指向待删的临时配置目录；pi 进程内的扩展在会话期间派生后台进程（Toast 的 PowerShell、bridge helper 等）并继承 cwd，Windows 下「进程 cwd 在目录内」会把目录本身钉住——文件可删、目录不可删。
- 教训：① 待删目录绝不能作为子进程族群的 cwd——工具里改为 `cwd: os.tmpdir()`，配置位置仍由 `PI_CODING_AGENT_DIR` 决定（改后即干净删除）；② 跨进程句柄锁定要靠隔离躲开，不要指望 `rmSync` 重试吸收（重试窗口不可预知）；③ 所有会在临时目录里落凭据副本的工具，清理失败路径必须单独删凭据文件并告警（本工具已做：auth.json 随目录删，删不掉目录时也单独删）。

## Windows 长路径让 worktree 删除静默失败（agent-team-viewer-model 收尾）

- 症状：任务合并后 `git worktree remove .worktrees/agent-team-viewer-model --force` 报 `error: failed to delete ...: Filename too long`（注册项已摘除、目录留下）；Git Bash 递归删除、PowerShell `Remove-Item -Recurse -Force` 同样静默留下 `agent-team/node_modules/.../@aws-sdk/core/dist-types/ts3.4/...` 深层文件（路径超 260 字符，Win32 API 上限）。
- 根因：Windows 默认 260 字符 MAX_PATH 上限；node_modules 里嵌套依赖的 `dist-types/ts3.4` 路径超限，普通删除 API 无法遍历/删除这些条目，且失败不是总是报错（PowerShell 静默跳过）。
- 处置（可复用流程）：① 空目录镜像两遍 `MSYS_NO_PATHCONV=1 robocopy <empty> <target> /MIR`（Git Bash 会把 `/MIR` 当路径转换，必须加 `MSYS_NO_PATHCONV=1` 或写 `//MIR`），第一遍删大部分、第二遍清剩余长路径文件；② `find <target> -depth -type d -exec rmdir {} \;` 逐级删空目录。删前先确认没有 reparse point（`Get-ChildItem -Recurse -Force -Directory | Where-Object { $_.Attributes -band ReparsePoint }`）——junction 删除另有事故（见上）。
- 教训：worktree 删除失败不要反复重试或硬删；长路径是 Windows 结构性限制，每次使用上述 robocopy 流程（不试探），并先用 `find`/`du` 确认只剩空壳再删。

## 成员派发死锁：子进程 stdin 无人关闭（agent-team v1.15.0 回归）

- 症状：`count-duet` 两次真机派单（1→50、50→100）都卡在第一次 `team_dispatch`——成员子进程收到 prompt 后 4–8 分钟零输出、**零 TCP 连接**（连本地代理都没拨过）、CPU 冻结（46s 内 user 15.00s→15.00s），run 永远 running，只有 `team_stop` 能解除。
- 根因：v1.15.0（819553a，steer/RPC 改造）把 `runner.ts` `defaultSpawn` 的 stdio 从 `["ignore","pipe","pipe"]` 改成 `["pipe","pipe","pipe"]`（为 leader RPC 通道），但成员走的是**同一个共享 spawn**——成员 prompt 全在 argv（`dispatch.ts`），全仓没有任何地方 `end()` 成员 stdin；pi 0.85.1 在 `--mode json -p` 下**读 stdin 到 EOF 才推进** ⇒ leader 同步等子进程退出、子进程等 stdin EOF。
- 定位手段（可复用）：① 进程树取证（`Get-CimInstance Win32_Process` 拿父子关系 + UserModeTime/KernelModeTime 两次采样）——CPU 冻结 + 零连接说明**不是**"连着 provider 等响应"；② 同一 CLI / 模型 / prompt 的最小对照实验，唯一变量 = stdin（`</dev/null` 11s 完成 vs 打开管道 75s 零输出 vs 打开 20s 后关闭 23s 完成）。
- 教训：① **子进程 stdio 是契约不是细节**——谁需要 stdin 必须逐调用方声明（现为 `runChildPi`/`PiSpawn` 的 `stdin` 选项，默认 `ignore`，leader RPC 显式 `pipe`）；② 共享 spawn 工厂的默认值改动会波及所有调用方，改 stdio/信号/窗口这类共享面必须逐个调用点复验；③ **fake 子进程测不出进程边界语义**（`makeFakeSpawn`/`FakeChild` 的 stdin 是普通对象，不会等 EOF）——回归护栏落在真实子进程用例（`runner.test.ts`）；④ 排障先取证再下结论：本轮最初把"无进展"讲成"阻塞"（判断对了但证据不足），事后才用对照实验坐实。

## worktree 重派失败：错误文案只剩 git 进度行（agent-team v1.15.1 真机事故）

- 症状：真机 run-1789100633429/1789100834291 同 run 对同一 worktree 成员二次派发，成员直接失败 `WORKTREE_UNAVAILABLE`；报告里的错误文本只有 `Preparing worktree (new branch 'team/<runId>/<member>')`，看不到为什么失败（真因是 `fatal: a branch named '…' already exists`——第一次派发留下的分支/工作树还在）。
- 根因：① `worktree.ts` `createWorktree` 无条件 `git worktree add <path> -b <branch>`，同 run 重派时分支与路径都已存在 ⇒ git 非零退出；② `worktreeError()` 取 stderr 首行，而 git 在 fatal 前先打印进度行 `Preparing worktree (…)`，真因在第二行被丢弃。
- 处置（v1.15.2）：`createWorktree` 先读 `git worktree list --porcelain`——已注册且分支匹配的 worktree 直接复用、分支存在但空闲时 attach 复用、路径被普通目录占用/注册不匹配则给出可操作提示；`worktreeError` 跳过 git 进度行只取 fatal/error 行（无非进度行才回退首行），并导出供单测。
- 教训：① **错误信息必须穿透进度噪声取真因**——"首行 stderr"这类廉价启发式在 git 这种混排进度的输出上就是把真因丢掉；② **创建已存在资源这类幂等场景应设计重入语义**，而不是靠提示词/报告禁止重试（leader 视角"再派一次"是合理动作，扩展应让它成功）；③ 真机 stderr 原文要当测试输入（新单测直接锁定 `Preparing worktree…` + `fatal: …` 两行样本）。

## widget 行按终端宽补齐被宿主 Text margin 折行（agent-team v1.15.4 外观改造）

- 症状：亮块背景改造时发现——`renderWidgetView` 一直以终端宽为截断预算，而宿主 `setExtensionWidget` 对 `string[]` 每行包 `Text(line, 1, 0)`（左右各 1 列 margin，内容可用宽 = 终端宽 − 2）：CJK 满宽行（截图场景的 leader 行）在真实渲染里折成两个物理行，背景块随之断续；若行宽继续按终端宽补齐，每一行都会折行。此前无背景、文本多短于终端宽，所以问题潜伏。
- 根因：字符串数组的「行宽预算」不等于终端宽——宿主在内容两侧各留 1 列 margin；`Text` 用 `contentWidth = width − 2 × paddingX` 做换行判断，超出即 wrap（不是截断）。
- 教训：① 写入 `string[]` widget 的每一行必须按**宿主内容宽（终端宽 − 2）**做 CJK 感知截断+补齐，绝不能按终端宽补齐（超宽会折成额外物理行，甚至触发 `doRender` 超宽断言）；② 宿主包装常量与 `MAX_WIDGET_LINES` 一样直读宿主 dist 源码由测试锁定（漂移即红）；③ 背景块的连续性只有在真实渲染路径（`capture-screens` 的 `Container + Text(line,1,0)` + VT 仿真屏）上才能验证——纯函数断言看不到折行。

## worktree 分支 ref 文件/目录互斥：团队分支挡住成员分支（agent-team v1.15.4，真机 run-1789108491578）

- 症状：团队 `worktree: true` + 成员 `worktree: true` 的组合下，首个成员派发必失败 `WORKTREE_UNAVAILABLE`，错误为 `fatal: cannot lock ref 'refs/heads/team/run-X/<member>': 'refs/heads/team/run-X' exists`。真机 run-1789108491578 上 leader 手工把团队分支从 `team/<runId>` 改名为 `team-run-<runId>` 后派发恢复（历史成功 run 的团队分支均为连字符形式）。
- 根因：`cockpit.ts` 团队共享 worktree 用分支 `team/<runId>`，`dispatch.ts` 成员用 `team/<runId>/<member>`——git ref 不允许同时是文件与目录：`refs/heads/team/run-X` 一旦存在，`refs/heads/team/run-X/...` 的创建被 lock 拒绝。两条模板分属独立代码路径、各自单测全绿，只有组合才炸。
- 为何既有单测没抓到：`worktree.test.ts` 只创建单分支 worktree、`worktree-reuse.test.ts` 只覆盖「同一成员分支」的重派复用，没有「团队级 + 成员级同 run」的组合用例；且这是 git ref 树语义（真实仓库的文件/目录互斥），纯函数/fake git 都测不出来——必须真实临时仓库按 cockpit→dispatch 顺序组合建树。
- 处置（v1.15.4）：团队共享分支改连字符 `team-run-<runId>`（成员分支 `team/<runId>/<member>` 不变）；两处模板收敛为 `worktree.ts` 单一来源 `teamWorktreeBranch()` / `memberWorktreeBranch()`；新增真实临时 git 仓库组合测试（团队+成员共存、dispatch 级首次派发成功、模板纯断言）与旧命名兼容测试（存量 `team/<runId>` worktree 重派走「已注册但分支不匹配 ⇒ `git worktree remove --force` 提示」，不崩溃、不静默删除）。
- 教训：① 命名空间类缺陷要在**真实资源树**上做组合测试（谁占用前缀、谁挂在下面），不能只测单点创建；② 同一实体的命名模板应收敛到单一来源，避免两条路径各自演进再次撞车；③ 改命名默认考虑存量——旧资源重派必须走已有的可操作提示路径，绝不清删。

## 跨会话 reconcile 误杀在跑 run + 终态 elapsed 恒 0（agent-team v1.15.6，真机 run-1789104483761）

- 症状：① 主会话 A 的 run 刚启动 2 秒，另一 pi 会话 B `session_start` 就把 A 的 `status.json` 翻成 failed + 孤儿 leader 诊断，而 run 实际跑到 completed；② 同一 run 终态快照 `startedAt=updatedAt`（都是结束时刻）⇒ 按 status.json 算 elapsed 恒 0。
- 根因：① `reconcileStaleRuns` 只排除**本进程** in-memory run——对另一活会话的 running 文件毫无判据，session_start 一律翻 failed；② `cockpit.ts` 终态 persist 与终态 `TeamRunRecord` 都重写 `startedAt: now()`，claim 时的开始时刻被丢掉。
- 处置（v1.15.6）：① `status.json` 加可选 `ownerPid`（写快照的主 pi 进程，cockpit 默认 `process.pid`，可注入），`reconcileStaleRuns` 签名加必填 `currentPid` + 注入探活 `isProcessAlive`（默认 `process.kill(pid, 0)`：ESRCH 死 / EPERM 活），判定序：非 running → in-memory → ownerPid===currentPid → 属主活着跳过 → 属主已死/无 ownerPid 照旧翻 failed（旧格式防永久滞留）；② claim 时生成一次 `RunPlan.startedAt`，running 快照/spawn 刷新/终态快照/终态 record 四处同值。
- 教训：① **进程级共享落盘资源必须带属主身份**——「重启后清理残留」这类 reconcile 若无属主判据，在多进程/多会话场景就是误杀；② 同一 run 的稳定时间戳要像 runId 一样在 claim 时定一次，任何「再取 now()」的写法都会让派生量（elapsed）失真；③ 两会话场景是独立测试类别（活属主不翻 / 本进程兜底不探活 / 已死翻 failed / 旧格式照旧），只测单会话路径跑不出这类缺陷。
