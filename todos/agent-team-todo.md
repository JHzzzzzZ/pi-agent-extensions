# TODO

- [x] 修复 `view` 视角下，leader 派活给成员后切换视角时上方不断出现换行重影的问题。（首轮：指纹门控+按 id 选中+帧高消抖，未根除，见第二轮条）
- [x] view 顶部标题+页签堆叠依旧（第二轮：overlay 加 maxHeight 85% + margin 1 与参考对齐，viewer 打开期间暂停并隐藏下方 widget 亮块）。105 测试 + typecheck 全绿；但用户真机截图实锤依旧堆叠（53s/54s、1m26s/1m27s 标题并存），见第三轮条。
- [x] view 标题+页签堆叠第三轮（照抄 pi-subagents fleet 壳——options 一字不差 + 标题去 elapsed 静态化 + openViewer 互斥防双 overlay；elapsed 只留下方 widget，viewer 内零每秒文本）。测试补录：viewer-host（真实 TuiMainScreen + scrollback 仿真器，单实例恒 1 组 chrome）、viewer-mutex（接线层互斥回归，旧版双 overlay 快速失败）。109 测试 + typecheck 全绿；等用户真机确认。
- [ ] 支持与各个 agent 进行动态对话。（验证中：count-duet 团队 1-10 轮流计数已跑通，5 次串行派单；1-1000 逐个派单超预算待分批方案确认）
- [x] 补齐 `view` 视角下的功能，例如停止 agent。（v1.4.0：viewer 内 `D` 停止整个 run——两步确认横幅占正文窗口顶部、帧总高不变，busy 守卫防重复，`stopAndSettle()` 与 team_stop 同语义，settled/未落定/异常分别映射 success/warning/error notice；`r`/`R` 手动刷新绕过指纹门控。停止粒度 = 整个 run，按成员停不可行——成员子进程归 leader 进程管。19 个新测试，全量 166）
- [x] 根 README 为每个插件增加效果示意图
- [x] devDependencies 安全升级：@earendil-works/pi-coding-agent 等 ^0.83.0 → ^0.85.1，修复 undici/brace-expansion 高危漏洞
- [ ] 参照 pi-subagents（v0.66.0）对齐 agent-team 可靠性：async-first 统一 + run 落盘/reconcile + 预算可配可见 + doctor 自检 + model 预检。（processing：方案待审批，未动手）
- [x] 修复每次 `/reload` 后 team 相关工具消失的问题（globalThis 双加载守卫跨 reload 常驻，entry 直接 return）。（v1.3.1：守卫命中后注册 session_shutdown 处理器删标志——pi 保证重绑扩展（reload/new/resume/fork/switch）前必发该事件，下次加载重新注册全部工具/命令/widget；同进程真双加载（无 shutdown 间隔）仍被抑制。新增 3 测试：reload 重注册 / 双加载抑制 / shutdown 幂等；147 测试 + typecheck 全绿；并入 feat/agent-team-clear 后测试断言同步 /team:clear）
- [x] 新增停止工具并暴露给 agent（如 `team_stop`：按 runId 停止运行中的团队派单）

  现状只能从 view 手动停（且该条还没做）；leader / 主 agent 在派单变卦、超预算、跑偏时停不掉，只能等跑完。
  - [x] 与 view 手动停止共用同一停止语义：成员子进程 SIGTERM→SIGKILL、run 落盘终态、widget/行状态更新、后台 followUp 报告不再送达（或送达“已停止”终态）。
  - [x] 工具参数用 Typebox schema（对齐 `manage.ts` 现有风格）；停不存在/已结束的 runId 返回类型化错误，不抛异常。

  v1.2.0 落地：cockpit 新增 `stopAndSettle()`（有界等待落定后返回终态记录，默认 7s），start() 提前同步 claim（消 concurrent start 竞态）+ finally 清空 pending/currentProgress（终态后不再谎报 running）；aborted 记录补全全体 roster 成员；team_stop 工具（runId 必填，RUN_ID_REQUIRED/RUN_NOT_FOUND/RUN_ALREADY_FINISHED）；team_run 后台返回与 team_status 输出暴露 runId。11 个新测试。
- [x] agent-team 的 TUI 与 pi-subagents 同步，所有细节同步到代码层级

  agent-team 的 viewer/widget 是对照 pi-subagents（v0.66.0，`src/tui` + `src/extension` + fleet 壳）手抄的；两边一旦各改各，显示 bug（如重影堆叠）会反复出现。以后 pi-subagents 的 TUI 每变一次，agent-team 跟进一次，差异只留 agent-team 特有语义。
  - [x] 建对照矩阵：agent-team 侧（`viewer.ts` / `widget.ts` / cockpit 状态行）逐文件对应到 pi-subagents 侧源文件 + 版本号（基线 v0.66.0），矩阵落盘（`agent-team/docs/tui-sync.md`，README 已加链接）。
  - [x] 同步粒度到代码层：overlay options（verbatim 锁）、maxHeight/margin、刷新节流（viewer tick 800→750）、键盘交互（viewer close 补 ctrl+c；widget 激活门控对齐 fleet-status——空编辑器才允许 ↓/← 激活，alt+↓/↑ 为不受门控第二通道；选中导航补 j/k）、无变化跳过 setWidget（对齐 renderKey）、open/close 互斥、销毁与重入、widget 隐藏/恢复——全部 TDD 测试锁定（tui-sync / widget / viewer / viewer-host / viewer-mutex 共新增 17 测试）。
  - [x] 同步≠依赖：仍不 import pi-subagents 包（自包含要求保留），以“对照抄改 + 单测锁定”方式同步；新版本号 1.2.0 进对照矩阵与提交信息。
- [x] 终态亮块可消除：run 结束后终态行常驻且无法关闭（/reload 后还会重新挂载），需要退出路径
  - [x] 新增 `/team:clear` 命令手动清除下方亮块（run 进行中提示先 stop 或等结束；只清亮块不清 lastRecord）。v1.3.0：run 进行中拒绝（warning）；无亮块 no-op（info）；否则停 controller + setWidget(undefined)；`clear` 进保留名单防团队名遮蔽。7 个新测试。
  - [x] session_start 水合仅在存在 running run 时自动挂载亮块；终态记录不再自动挂（/team:view、/team:status 回看不受影响；派新单经 ensureRunWidget 复挂）。viewer-mutex slice-6 改经真实派单挂 widget，entry 双加载命令数 5→6。144 测试 + typecheck 全绿。
  - ~~[ ] 终态行超时自动淡出~~（已取消：用户决定不做自动淡出，仅手动 /team:clear 清除；避免注入时钟与 FADE 常量的额外复杂度）
