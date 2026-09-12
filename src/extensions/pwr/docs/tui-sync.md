# pwr TUI ↔ 宿主 pi-tui/extension-UI 对照矩阵

> 本文件是 pwr 侧 TUI 触点（entry 渲染器 / widget / 状态行 / viewer overlay / 审批卡 / 快捷键 / 文本工具）
> 与宿主 **pi-tui 0.85.1 + pi-coding-agent 0.85.1** 扩展 UI 原语**代码级对照**的唯一事实来源。
> 对齐≠依赖：`@earendil-works/pi-tui` 仍只是 devDependencies（宿主运行时解析），
> 测试保持结构 fake（`as never`），不实例化真实 pi-tui 组件；
> 唯一例外是 `pwr/tests/ui-viewer-host.test.ts`（真实 `TuiMainScreen` + 假终端 headless，
> 专测 overlay 合成/diff 路径——堆叠类 bug 只在真实路径存在，fake 断言不到）。
> 惯例：宿主每升版一次，复核本矩阵一次并在头部登记新版本（同 agent-team/docs/tui-sync.md §5）。

**基线版本：pi-tui 0.85.1 / pi-coding-agent 0.85.1**（`pwr/package.json` devDependencies `^0.85.1`，与本机安装一致；核查日 2026-09-11 @ 31446bc）。

## 1. 文件映射表

| pwr 侧 | 宿主侧原语 | 关系 |
|---|---|---|
| `src/ui/renderer.ts` — entry 渲染器（`Box(1,1,theme.bg("customMessageBg"))` + `Text`）、widget 字符串行、`setStatus` 状态行 | `pi.registerEntryRenderer`（`EntryRenderer(entry, options, theme)` 契约）、`ui.setWidget(key, string[], options?)`、`ui.setStatus(key, text)` | 已对齐（宿主原语直用） |
| `src/ui/viewer.ts` — `RunViewer implements Component`（经 `ctx.ui.custom` 打开的 fleet 式分栏 overlay：roster + detail） | `ui.custom<T>(factory(tui, theme, keybindings, done), { overlay, overlayOptions })` + pi-tui `Component`（`render/dispose`）；宿主 `truncateToWidth`/`wrapTextWithAnsi`/`visibleWidth` 文本工具 | 已对齐（分栏几何/overlay 选项/键位/刷新全部按 fleet，见 §2；host 测试 `tests/ui-viewer-host.test.ts` 锁定真实合成/diff 路径） |
| `src/ui/keybindings.ts` — 快捷键注册表（`ctrl+alt+z/x/r`，命令孪生） | `pi.registerShortcut(KeyId, { description, handler })` | 已对齐（注册契约一致）；自建注册表是特性：单点改键 + 测试锁定 + 帮助文本同源 |
| `src/tools.ts` / `src/ui/index.ts` — 审批卡与动作选择 | `ctx.ui.select(title, options)` 宿主原语 | 已对齐（不用自绘选择列表） |
| `src/ui/diagram.ts` / `src/ui/viewer.ts` — 结构图与查看器正文的宽度/换行/截断 | pi-tui `truncateToWidth`、`wrapTextWithAnsi`、`visibleWidth`（agent-team viewer 同款） | 已对齐（A2 完成 @ 31446bc：删除自写 `src/ui/text.ts`，宽 emoji/组合字符交给宿主 grapheme 级实现） |
| `src/ui/viewer.ts` — `handleViewerKey`：命名键（Esc/方向/home/end/pageUp/pageDown）与动作键（`D`/`K`/`J`/`X`）走 pi-tui `matchesKey`（兼容 legacy/kitty/modifyOtherKeys 三种编码），大写绑定经 `matchesViewerBinding` 转 `shift+小写`（fleet 同构），`[/]` 等 pwr 特有可打印键保留裸比较 | pi-tui `matchesKey`/`parseKey`/`Key`（agent-team viewer 即用 matchesKey） | 已对齐（A1 完成 @ feat/pwr-a1-matcheskey；tests/ui-viewer.test.ts 锁 kitty 序列 \x1b[27u 关闭、\x1b[1;1A 上滚） |

## 2. 对齐维度表

| 维度 | 宿主侧字面量 | pwr 现状 | 处置 |
|---|---|---|---|
| overlay 几何 | `OverlayOptions` 支持 `{ anchor, width, minWidth, maxHeight, margin }`；fleet/agent-team 参照 `{ anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 }`（agent-team/viewer.ts:1123-1129） | `VIEWER_OVERLAY_OPTIONS` verbatim fleet 选项；`computeFrameHeight` = `max(2, floor(rows*0.85)-6)`、`VIEWER_CHROME_ROWS = 6`、`computeViewerLayout` roster 22..46 | 已对齐（A4 完成 @ 31446bc：删 82% 自算与 96% 宽） |
| 按键匹配 | `matchesKey(data, "escape")` 等（pi-tui keys.ts，含 kitty 协议解码） | 已换 matchesKey（命名键）；可打印字符保留裸比较 | **A1 已完成**：运行时行为不变（legacy 序列全兼容），kitty/modifyOtherKeys 序列新增命中；KeyId 类型用驼峰 `pageUp`/`pageDown`（运行时 lowercase，但类型面是权威拼写） |
| 文本宽度/截断 | `truncateToWidth` / `wrapTextWithAnsi` / `visibleWidth`（pi-tui，agent-team 在用） | 宿主工具直用（viewer/diagram）；每帧每行 `fitLine` 精确列宽 | **A2 已完成**：自写 `src/ui/text.ts` 删除，组合字符/宽 emoji 交给宿主 grapheme 级实现 |
| 刷新节流 | fleet/agent-team viewer `REFRESH_MS = 750` | `VIEWER_TICK_MS = 750`（`src/ui/types.ts`）+ `unref`；指纹门控（忽略 elapsed 纯时钟变化）+ 帧高消抖 | 已对齐（A3 完成 @ 31446bc） |
| 富文本渲染 | pi-tui `Markdown` 组件（agent-team viewer 的回复气泡在用） | viewer 全纯文本行（含结果页） | A5 低优先级评估（缓办）：结果页换 Markdown；当前纯文本与"entry 只持久化元数据"的保守取向一致，无正确性问题 |
| widget 形态 | `setWidget` 支持 string[] 与组件工厂两种 | 仅 string[] 形式（`refreshUiStatus`） | **保持 string[]，明确不换**：agent-team 已验证宿主包装的 string 渲染是跨构建最稳路径，组件工厂逐帧重绘在某 bundle 宿主上产生残影（incidents 教训） |
| widget placement | `placement?: "aboveEditor" \| "belowEditor"`（缺省 aboveEditor） | 缺省 aboveEditor（`setWidget("pwr-runs", …)` 无 options） | 保留：运行进度属会话级信息，agent-team 亮块的 belowEditor 是其可选中交互的设计需要，两者语义不同 |
| 状态键约定 | `setStatus(key, text)` | 单键 `"pwr"` + widget 键 `"pwr-runs"` | 已对齐（每扩展一个状态键约定） |
| 主题取色 | `Theme.fg/bg(color, text)` | `theme.bg("customMessageBg")`（entry 卡）+ `themeStyles(theme)` 包 `theme.fg("dim"/"border"/"accent"/"success"/…)` 且 try/catch 兜底 | 已对齐（异常隔离符合仓库惯例） |
| 生命周期 | `Component` 可选 `dispose()`；宿主 teardown 时调用 | `RunViewer.dispose()` 清 `setInterval`；`invalidate()` 空实现（无状态缓存） | 已对齐 |
| 快捷键冲突 | pi 保留"最后注册者赢"，内建键只用 `ctrl+alt+]` | `pause` 曾用 `ctrl+alt+p` 与 plan-mode 扩展冲突后改 `ctrl+alt+z`（keybindings.ts 头注释） | 已对齐且有先例记录；新快捷键仍需查 `TUI_KEYBINDINGS` 避让 |

## 3. 行动项（对齐建议，按风险排序）

- ~~**A1 按键匹配换 `matchesKey`**~~（✅ 完成 @ feat/pwr-a1-matcheskey，2026-09-10）：`handleViewerKey` 命名键改 `matchesKey`，kitty 序列（Esc `\x1b[27u`、up `\x1b[1;1A`）有测试锁定；可打印字符保留裸比较；legacy `KEY_*` 常量删除。改法注：`KeyId` 类型为驼峰 `pageUp`/`pageDown`。
- ~~**A2 `text.ts` 换 pi-tui 文本工具**~~（✅ 完成 @ 31446bc，2026-09-11）：删除 `src/ui/text.ts`；`viewer.ts`/`diagram.ts` 改用宿主 `truncateToWidth`（`fitLine = truncateToWidth(line, width, "…", true)` 保证精确列宽）/`wrapTextWithAnsi`/`visibleWidth`；测试改锁行为（`ui-diagram.test.ts` 截断断言不再假设“必带省略号”——宿主能放下就原样）。
- ~~**A3 刷新 800 → 750**~~（✅ 完成 @ 31446bc）：`VIEWER_TICK_MS` 常量 + 默认使用。
- ~~**A4 overlay 高度**改 `maxHeight: "85%", margin: 1`~~（✅ 完成 @ 31446bc）：`VIEWER_OVERLAY_OPTIONS` verbatim fleet（width 95% / minWidth 60 / maxHeight 85% / margin 1），高度自算删除。
- **A5 结果页 Markdown**（低优先级，缓办）：需先确认结果 JSON 文本的 Markdown 化收益。

执行 A1–A4 时遵守：TDD 先行；测试仍不实例化真实 pi-tui（若需真机级验证，参照 agent-team `viewer-host.test.ts` 的"真实 TuiMainScreen + 假终端 headless"模式单独立项）。A2–A4 落地时同步新增了 `pwr/tests/ui-viewer-host.test.ts`（移植该模式，锁定 overlay 不堆叠/帧高恒定）。

## 4. 宿主升级复核流程

1. 升 `@earendil-works/pi-*` devDependencies → 跑 `npm test && npm run typecheck`；
2. 对照本矩阵逐行核对宿主 d.ts（`pwr/node_modules/@earendil-works/pi-tui/dist/*.d.ts` 与 `pi-coding-agent/dist/core/extensions/types.d.ts`）；
3. 契约变化（如 `setWidget`/`custom`/`registerShortcut` 签名、`OverlayOptions` 字段、主题 token 名）→ 更新本矩阵 + 代码 + last verified；
4. 更新头部基线版本与核查日期。
