# agent-team-todo#70 长提问视图真机观感走查

> 领取：2026-09-15（本会话）· 对齐访谈：2026-09-15 grill-with-docs

## 意图

#58 收尾时 leader 报告：自绘 overlay 在极窄终端（<60 列，`VIEWER_OVERLAY_OPTIONS` minWidth=60）的截断/重影、长选项列表键盘导航选中态，目前只有宿主级 headless 渲染测试（`test/viewer-ask-host.test.ts` 用例 7）+ 一次真机链路跑通作证据，缺人工逐场景走查——纯函数 / headless 测不出的真机渲染差异（docs/incidents.md 有先例）需要真机证据。

## 范围

口径来自访谈 Q6 / Q7。

1. **headless 先筛（Q6）**：用既有管线 `agent-team/tools/capture-screens.mjs`（真实 `TuiMainScreen` + 真实 viewer 组件 + 假终端）出 80 / 60 / 40 列三档宽度的长提问渲染图；agent 按走查表逐项初筛——题面折行与段落空行、PgDn 到底可达、选项窗口跟随、选中态、Esc/Enter 后清理。
2. **真机复核（Q6）**：用户在真实 Windows Terminal 按三档宽度实测（agent 出操作清单，用户执行、截图回传）；重点核 headless 观感与真机差异（字体/换行/滚动行为）。
3. **发现即记**：发现问题按 `docs/incidents.md` 记事故并修（修复另走工单）；未发现问题则把「已走查」结论写入 `docs/extensions/agent-team.md`。
4. **时间（Q7）**：排在本批最后——先完成可独立完成的 todo-cli-todo#16 / #13 / general-todo#8，再约真机走查（依赖用户在线配合）。

明确不做什么：

- 不改 viewer 组件代码（除非走查出问题，且修复另立工单）；不新增截图场景进 README。

## 验收标准

1. 三档宽度 headless 渲染图产出并完成走查表逐项判定记录。
2. 真机走查完成：三宽度下无残行 / 无重影、题面尾部 PgDn 可达。
3. 结论（含负结论）落盘 `docs/extensions/agent-team.md` 或 `docs/incidents.md`。

## 人工确认

确认人：用户 · 日期：2026-09-15 · 方式：本会话 grill-with-docs——Q6=headless 管线先筛 + 用户真机复核（否决「纯真机截图」）、Q7=排本批最后；用户答复「当前没问题」终确认。
