# general-todo#19 fullscreen 默认下的 TUI 复核

## 意图

pi 1.0 把**默认 TUI 模式从 `regular` 切成 `fullscreen`**（`tuiMode` 默认值变了，回退用 `tuiMode: "regular"` 或 `--tui-mode regular`）。

本仓库有大量依赖宿主渲染管线的 TUI 资产，它们的期望值全部是在**旧默认环境**下建立并验证的：

| 资产 | 相关文件 |
|---|---|
| agent-team viewer（fleet 式分栏 overlay） | `viewer.ts` + `docs/tui-sync.md` 矩阵 |
| agent-team askview（长提问自绘 overlay） | `askview.ts` + `#70` 三档宽度走查记录 |
| agent-team widget（输入栏下方亮块 + 焦点门控） | `widget.ts` |
| pwr viewer（fleet 式分栏 overlay） | `pwr/src/ui/viewer.ts` + `docs/tui-sync.md` |
| widget 排序带（三段合并成宿主单键 `widget-band`） | 每插件一份 `widget-band.ts` |
| status-band（footer 首段定格 + `│ ` 分隔） | 每插件一份 `status-band.ts` |

fullscreen 与 regular 的**渲染路径不同**（alt-screen、diff 策略、鼠标选择、scrollbar）。历史上本仓库的 overlay 堆叠/重影类 bug（见 `docs/incidents.md`）**只在真实渲染管线下暴露**，纯函数测试测不出——这正是本条要做真机复核的理由。

## 范围

**做什么**

1. **headless 复核（我执行，用仓库现有管线）**：
   - `src/extensions/agent-team/tools/vt-screen.mjs` + `capture-screens.mjs` 重生成 `docs/assets/*.svg`，核对帧锚点自检
   - 跑 `viewer-host.test.ts` / `viewer-ask-host.test.ts` / `widget-focus-host.test.ts` / `ui-viewer-host.test.ts` / `ui-widget-band-host.test.ts`（真实 `TuiMainScreen` + 假终端），确认在 fullscreen 相关路径下无回归
2. **真机走查清单（产出一份清单给用户跑）**：覆盖
   - agent-team viewer：打开 / `[`/`]` 切 run / `D` 停止确认 / Esc 返回；无残行、无重影、无半字截断
   - agent-team askview：长提问三档宽度（80/60/40）+ Enter / Esc 两条路径
   - pwr viewer：分栏 + 滚动 + `D` 两步停止
   - widget 排序带：pwr / run-timer / loop 三段错位刷新时顺序恒定（1.0 的 fullscreen 下重新确认）
   - status-band：首段定格（无前导 `│ `）+ 段出现/消失时的重渲染
   - 背景交互：鼠标选择/复制（`fullscreenCopyOnSelect` 默认 `true`）、滚轮（`fullscreenWheelScrollLines: "auto"` 在 SSH/非 macOS 下加速到最多 6 行/事件）、scrollbar（`fullscreenScrollbar: "auto"`）
3. **发现问题的处置**：本次**只记录并另立条目**，不在本条目里修——本条的交付物是"复核结论 + 清单 + 新条目"，避免把验证与修复混在一次交付里（修复会各自触达插件代码，需要独立 worktree）。
4. **文档同步**：`docs/tui-sync.md`（两处：agent-team 与 pwr）补「复核环境」一行，写明期望值对应的 `tuiMode`；若结论是"两模式行为一致"，明确写出来（这是有价值的事实）。

**不做什么**

- 不修改任何插件代码（发现问题另立条目）
- 不改 `docs/cross/status-bar.md` 的契约本身（若契约在 fullscreen 下不成立，另立条目）
- 不替用户改 `~/.pi/agent/settings.json`（`tuiMode` 保持用户当前选择）

## 验收标准

1. 5 个 host 级测试文件全绿（真实 `TuiMainScreen` + 假终端）。
2. `capture-screens.mjs` 重生成成功、帧锚点自检通过（`docs/assets/*.svg` 无意外变化，或有变化且已确认原因）。
3. 产出一份**真机走查清单**（可复制的分步清单，含每步的期望观察与失败判据），交给用户执行。
4. 用户执行后回收结论：通过 → 本条收口；不通过 → 逐条另立 `todos/` 条目并写明现象与复现步骤。
5. `docs/tui-sync.md`（agent-team / pwr 两处）写明复核环境与结论。
6. 仓库级 `npm run test:all` 全绿（本条不改代码，作为基线确认）。

## 人工确认

用户 2026-10-04 本会话确认：

- 本条登记为 **p6**（默认环境变化影响所有用户，属验证缺口）。
- **分工**：headless 部分由我执行；**真机部分列清单由用户跑**（用户 2026-10-04 确认此分工，未提出异议）。
- **发现的处置**：本次只记录 + 另立条目，不在本条内修（我提出的边界，用户未提出异议）。
- **Q5**：并行开 worktree + subagent 实现，主会话仅追踪。
