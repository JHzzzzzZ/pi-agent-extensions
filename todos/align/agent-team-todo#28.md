# agent-team-todo#28 宿主 widget 刷新保序：仓库内 widget 排序带（+ 上游 issue 照提）

## 意图

宿主 `InteractiveMode.setExtensionWidget` 每次 `setWidget` 都先 `Map.delete(key)` 再 `Map.set(key)`；JS Map 按插入序迭代，于是被刷新的 widget 每次都沉到所在栈底部。编辑器上方的三个周期性刷新 widget（`pwr-runs`、`run-timer`、`loop`）因此逐秒换位——可见症状是输入栏上方灰色区域的「抽搐」（纯观感，无数据风险）。

本仓库不打宿主补丁（红线 8）。但 footer（底部状态条）**早已用仓库内机制解决同类问题**：`status-band.ts` 以 `globalThis` + `Symbol.for("pi.status-bar.bands.v1")` 建共享登记表，各写入者交逻辑文本与真实写 UI 回调，由模块统一决定段前缀（`isFrontmost` 用与宿主相同的 `localeCompare` 判定）。widget 侧照此平移即可自愈，不必等上游。

## 范围

做什么：

- 新增「widget 排序带」模块，每插件目录一份拷贝（保持单目录可复制安装，不做跨插件 import），沿用 `status-band.ts` 的 `globalThis` + `Symbol.for` 登记表模式。
- 三个 aboveEditor 写入者改为登记逻辑行：`pwr-runs`（`pwr/src/ui/renderer.ts:110`）、`run-timer`（`WIDGET_ID = "run-timer"`）、`loop`（`WIDGET_ID = "loop"`）。
- 单一写者：登记表中 band key **最小者**当 owner，由它一次 `setWidget("widget-band", 合并后的 string[], { placement: "aboveEditor" })`；owner 清空或退出时自动移交，全空时 `setWidget(undefined)` 卸载。
- 顺序 = band key 升序；三段之间**不加分隔符**（widget 是多行块，不是 footer 那种一行拼接）。写入前保持现有文本指纹比对。
- 重锁契约：`docs/cross/status-bar.md` 的 widget 一节改写为「顺序由 widget 排序带保证」，删除「首次挂载顺序 = 扩展注册顺序」旧契约；`test/status-bar-contract.test.ts` 同步。
- 上游 issue：提交 `docs/pi-widget-order-issue.md` 的稿（对本仓库外的生态有益），**不阻塞**本条。
- 8 条同族条目归并：保留本条为 canonical，其余 7 条（`goal#6`、`loop#7`、`provider-quota#5`、`pwr#12`、`run-timer#3`、`solo-mode#6`、`stream-token-speed#4`）以 `complete --note "归并到 agent-team-todo#28（同族跨插件条目）"` 收口。

明确不做什么：

- 不修改宿主安装目录、不打宿主补丁（红线 8）；上游修好后回归本契约即可，无需撤本地补丁。
- 不纳入 belowEditor 的 agent-team 亮块（单占无冲突，YAGNI）；登记表可预留 placement 字段供日后扩展。
- 不改各插件状态行的格式与内容（只改写入通道）。
- 不动 footer 侧的既有机制（`status-band.ts` 与其契约保持不变）。

## 验收标准

- 三段同屏连续刷新时相对顺序稳定（真实宿主渲染测试：连续 N 帧顺序不变）；修复前同场景可复现换位。
- owner 移交可用：owner 段清空/停止后其余段仍正常刷新；三段全空时 widget 卸载（无残行）。
- 三个插件各自仍能单独复制安装（无跨插件 import、无共享依赖）。
- `docs/cross/status-bar.md` 契约更新且重新锁定；`test/status-bar-contract.test.ts` 覆盖新顺序规则。
- 上游 issue 已提交，链接留档在 `docs/pi-widget-order-issue.md`。
- 全量测试 + `npm run typecheck` 零错误；根 README 的 widget 说明同步。
- 净变化：`summary` 的 open 数减 7（同族归并），生产代码只增一个跨插件契约模块与其接线。

## 人工确认

- 确认人：用户（本会话）
- 日期：2026-09-16
- 方式：会话内逐条问答对齐（25 问，用户回复「按你建议」）→ 5 份文档落盘后用户回复「确认」
- 结论：全部决策按本档执行（做排序带 + issue 照提；最小 band key 当 owner；只纳 aboveEditor 三段；单一宿主 key `widget-band`、不加分隔符；8 条归并到本条）。
- 路线决策的留痕方式：**不另立 ADR**（用户「确认」未提出另立），契约落在 `docs/cross/status-bar.md`。
