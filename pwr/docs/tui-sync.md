# pwr TUI ↔ 宿主 pi-tui/extension-UI 对照矩阵

> 本文件是 pwr 侧 TUI 触点（entry 渲染器 / widget / 状态行 / viewer overlay / 审批卡 / 快捷键 / 文本工具）
> 与宿主 **pi-tui 0.85.1 + pi-coding-agent 0.85.1** 扩展 UI 原语**代码级对照**的唯一事实来源。
> 对齐≠依赖：`@earendil-works/pi-tui` 仍只是 devDependencies（宿主运行时解析），
> 测试保持结构 fake（`as never`），永不实例化真实 pi-tui。
> 惯例：宿主每升版一次，复核本矩阵一次并在头部登记新版本（同 agent-team/docs/tui-sync.md §5）。

**基线版本：pi-tui 0.85.1 / pi-coding-agent 0.85.1**（`pwr/package.json` devDependencies `^0.85.1`，与本机安装一致；核查日 2026-09-10 @ 39d5af3）。

## 1. 文件映射表

| pwr 侧 | 宿主侧原语 | 关系 |
|---|---|---|
| `src/ui/renderer.ts` — entry 渲染器（`Box(1,1,theme.bg("customMessageBg"))` + `Text`）、widget 字符串行、`setStatus` 状态行 | `pi.registerEntryRenderer`（`EntryRenderer(entry, options, theme)` 契约）、`ui.setWidget(key, string[], options?)`、`ui.setStatus(key, text)` | 已对齐（宿主原语直用） |
| `src/ui/viewer.ts` — `RunViewer implements Component`（经 `ctx.ui.custom` 打开的 overlay） | `ui.custom<T>(factory(tui, theme, keybindings, done), { overlay, overlayOptions })` + pi-tui `Component`（`render/dispose`） | 部分对齐（几何/按键/节流三处差异，见 §2） |
| `src/ui/keybindings.ts` — 快捷键注册表（`ctrl+alt+z/x/r`，命令孪生） | `pi.registerShortcut(KeyId, { description, handler })` | 已对齐（注册契约一致）；自建注册表是特性：单点改键 + 测试锁定 + 帮助文本同源 |
| `src/tools.ts` / `src/ui/index.ts` — 审批卡与动作选择 | `ctx.ui.select(title, options)` 宿主原语 | 已对齐（不用自绘选择列表） |
| `src/ui/text.ts` — `charWidth/visibleWidth/wrapText/truncateVisible/padLine/stripAnsi`（自写 CJK 宽度工具） | pi-tui `truncateToWidth`、`wrapTextWithAnsi`（agent-team viewer 即用这两个） | **重复实现** → 候选替换（§3-A2） |
| `src/ui/viewer.ts:435` — `handleViewerKey` 裸 `switch (data)`（`"\x1b"`/`"\x1b[A"`/`"\x1b[B"` 字面量） | pi-tui `matchesKey(data, "escape"/"up"/"down"/…)` + `parseKey`/`Key`（agent-team viewer.ts:683-731 即用 matchesKey） | **裸字节比较** → 候选替换（§3-A1，有正确性风险） |

## 2. 对齐维度表

| 维度 | 宿主侧字面量 | pwr 现状 | 处置 |
|---|---|---|---|
| overlay 几何 | `OverlayOptions` 支持 `{ anchor, width, minWidth, maxHeight, margin }`；fleet/agent-team 参照 `{ anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 }`（agent-team/viewer.ts:1123-1129） | `{ anchor: "center", width: "96%" }`，高度组件内自算 `computeFrameHeight(rows) - VIEWER_CHROME_ROWS`（≈82% 终端高） | 行为近似；可评估改用 `maxHeight + margin` 让宿主约束高度（删自算逻辑） |
| 按键匹配 | `matchesKey(data, "escape")` 等（pi-tui keys.ts，含 kitty 协议解码） | 裸 `data === "\x1b"`、`"\x1b[A"`、`"\x1b[B"` 与单字符比较 | **A1 建议替换**：kitty 协议启用时 Esc/方向键序列不同，裸比较会失效；matchesKey 是宿主唯一权威路径 |
| 文本宽度/截断 | `truncateToWidth` / `wrapTextWithAnsi`（pi-tui，agent-team 在用） | `src/ui/text.ts` 自写全套（含 CJK 宽度） | **A2 建议替换**：删自有实现、测试改锁行为；两套宽度算法在组合字符/宽 emoji 上可能结果不一致 |
| 刷新节流 | fleet/agent-team viewer `REFRESH_MS = 750` | `RunViewer` 默认 800ms（viewer.ts:537）+ `unref` | A3 微差，可对齐 750；`timer.unref()` 已对齐（不阻塞退出） |
| 富文本渲染 | pi-tui `Markdown` 组件（agent-team viewer 的回复气泡在用） | viewer 全纯文本行（含结果页） | A4 低优先级评估：结果页换 Markdown；当前纯文本与"entry 只持久化元数据"的保守取向一致，无正确性问题 |
| widget 形态 | `setWidget` 支持 string[] 与组件工厂两种 | 仅 string[] 形式（`refreshUiStatus`） | **保持 string[]，明确不换**：agent-team 已验证宿主包装的 string 渲染是跨构建最稳路径，组件工厂逐帧重绘在某 bundle 宿主上产生残影（incidents 教训） |
| widget placement | `placement?: "aboveEditor" \| "belowEditor"`（缺省 aboveEditor） | 缺省 aboveEditor（`setWidget("pwr-runs", …)` 无 options） | 保留：运行进度属会话级信息，agent-team 亮块的 belowEditor 是其可选中交互的设计需要，两者语义不同 |
| 状态键约定 | `setStatus(key, text)` | 单键 `"pwr"` + widget 键 `"pwr-runs"` | 已对齐（每扩展一个状态键约定） |
| 主题取色 | `Theme.fg/bg(color, text)` | `theme.bg("customMessageBg")`（entry 卡）+ `themeStyles(theme)` 包 `theme.fg("dim"/"border"/"accent"/"success"/…)` 且 try/catch 兜底 | 已对齐（异常隔离符合仓库惯例） |
| 生命周期 | `Component` 可选 `dispose()`；宿主 teardown 时调用 | `RunViewer.dispose()` 清 `setInterval`；`invalidate()` 空实现（无状态缓存） | 已对齐 |
| 快捷键冲突 | pi 保留"最后注册者赢"，内建键只用 `ctrl+alt+]` | `pause` 曾用 `ctrl+alt+p` 与 plan-mode 扩展冲突后改 `ctrl+alt+z`（keybindings.ts 头注释） | 已对齐且有先例记录；新快捷键仍需查 `TUI_KEYBINDINGS` 避让 |

## 3. 行动项（对齐建议，按风险排序）

- **A1 按键匹配换 `matchesKey`**（正确性）：`handleViewerKey` 的裸字节字面量在 kitty 键盘协议下会漏键。改法：`switch` 分支改 `matchesKey(data, "escape"/"up"/"down"/"enter")` + 保留 `q/j/k` 单字符快速路径；纯函数测试（`tests/ui-viewer.test.ts`）期望值同步。
- **A2 `text.ts` 换 pi-tui 文本工具**（删码）：`truncateVisible` → `truncateToWidth`、`wrapText` → `wrapTextWithAnsi`；`charWidth/visibleWidth/padLine/stripAnsi` 若宿主无对应物则保留。测试改锁行为（输入→输出），不锁实现。
- **A3 刷新 800 → 750**（体验对齐 fleet）。
- **A4 overlay 高度**改 `maxHeight: "85%", margin: 1` 评估（与 fleet/agent-team 几何一致，删自算）。
- **A5 结果页 Markdown**（低优先级，需先确认结果 JSON 文本的 Markdown 化收益）。

执行 A1–A4 时遵守：TDD 先行；测试仍不实例化真实 pi-tui（若需真机级验证，参照 agent-team `viewer-host.test.ts` 的"真实 TuiMainScreen + 假终端 headless"模式单独立项）。

## 4. 宿主升级复核流程

1. 升 `@earendil-works/pi-*` devDependencies → 跑 `npm test && npm run typecheck`；
2. 对照本矩阵逐行核对宿主 d.ts（`pwr/node_modules/@earendil-works/pi-tui/dist/*.d.ts` 与 `pi-coding-agent/dist/core/extensions/types.d.ts`）；
3. 契约变化（如 `setWidget`/`custom`/`registerShortcut` 签名、`OverlayOptions` 字段、主题 token 名）→ 更新本矩阵 + 代码 + last verified；
4. 更新头部基线版本与核查日期。
