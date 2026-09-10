# pi 宿主补丁：extension widget 保序更新（修复输入栏上方 widget 抖动）

> 跨扩展状态条契约（对齐秒节拍 / footer 排序带 / widget 栈顺序）见 `docs/cross/status-bar.md`；本补丁是 widget 刷新保序的最后一道防线，扩展侧的节拍统一不依赖它。
>
> 上游根修材料（route A，含可直接 `git apply` 的源码级 diff）见文末「上游提交包」；上游修复发布后可整体撤本补丁。

## 症状

agent-team 运行时，输入栏上方的灰色 widget 区域持续"抽搐"：run-timer 的计时行
（`任务 X · 本轮 X · 本会话 X`）每秒在 agent-team 状态块的上方/下方之间翻转。

## 根因（宿主 bug，非扩展问题）

宿主 `InteractiveMode.setExtensionWidget`（pi-coding-agent）在每次 `setWidget` 时对
**两个** widget Map 都执行 `Map.delete(key)`，再 `Map.set(key, component)` 重新插入。
JS Map 按插入序迭代，因此**每刷新一次，该 widget 就被挪到 widget 区最底部**。

`agent-team`（运行期间 1s tick + 事件刷新，`cockpit.ts`）与 `run-timer`（常驻 1s tick，
`index.ts`）是两个相位无关的每秒刷新源，谁后刷新谁排下面，于是两块 widget 的相对顺序
每秒翻转一次。`loop`（1s tick 倒计时 widget）与任何周期刷新 widget 同屏时同理。

## 补丁内容

利用 `Map.set` 对已存在 key **原地替换、保持插入位置**的语义：key 已存在于目标 Map 时
不再 delete，只 dispose 旧组件后原地覆盖。 placement 切换与清除（`setWidget(key, undefined)`）
行为不变。

补丁前（`setExtensionWidget` 开头）：

```js
const removeExisting = (map) => {
    const existing = map.get(key);
    if (existing?.dispose)
        existing.dispose();
    map.delete(key);
};
removeExisting(this.extensionWidgetsAbove);
removeExisting(this.extensionWidgetsBelow);
```

补丁后：

```js
const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
const otherMap = placement === "belowEditor" ? this.extensionWidgetsAbove : this.extensionWidgetsBelow;
const removeExisting = (map, keepPosition) => {
    const existing = map.get(key);
    if (existing?.dispose)
        existing.dispose();
    if (!keepPosition)
        map.delete(key);
};
removeExisting(otherMap, false);
removeExisting(targetMap, content !== undefined);
```

同时删除函数后部重复的 `const targetMap = …` 声明（保留 `targetMap.set(key, component)`）。

## 已应用位置

- 全局安装（**运行时实际生效**）：v0.85.1
  `C:/Users/12967/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`
  （备份：同目录 `interactive-mode.js.bak`，回滚 = 还原备份）
- 应用后需**重启 pi** 才生效（运行中的进程仍持有旧代码）。

注：工作区内 `pwr/node_modules`、`agent-team/node_modules` 里的 0.83.0 副本含同样代码，
但仅用于 typecheck，运行时不加载，未打补丁。

## 升级 pi 后重打

`npm` 升级 `@earendil-works/pi-coding-agent` 会覆盖 dist 产物，补丁丢失需重打：

1. 在新版 `dist/modes/interactive/interactive-mode.js` 中搜索 `setExtensionWidget`。
2. 按上文"补丁内容"替换（行号随版本漂移，以 `removeExisting` / `extensionWidgetsAbove`
   为锚点）。
3. `node --check <该文件>` 校验，重启 pi。

若上游已修复则无需重打（见下）。


## 上游提交包（route A：根修保序）

> 状态：**材料就绪，待提交上游**。上游仓库 `https://github.com/earendil-works/pi`，
> 目标 `packages/coding-agent/src/modes/interactive/interactive-mode.ts` 的
> `setExtensionWidget`（对上游 HEAD `2e6fe2f` 源码核实：bug 仍在；本机 dist v0.85.1
> 行 1697 同源）。上游修复发布后：撤本仓库本地补丁（还原 `interactive-mode.js.bak`
> 或确认新版已含修复）并回归 `npm run test:contract` + 真机顺序。

### 1) 标题

Extension widgets reorder on every `setWidget` update — periodically-refreshing widgets swap positions every second

### 2) Issue 正文（可直接粘贴）

`InteractiveMode.setExtensionWidget` removes the existing entry from the widget maps
(`Map.delete`) before re-inserting via `Map.set`. JS Maps iterate in insertion order, so
every update moves the widget to the bottom of its stack (above-editor and below-editor
are separate Maps). With two extensions whose widgets refresh periodically (e.g. a 1s
timer widget and a 1s task-progress widget), whichever updated last sits at the bottom:
the two widgets swap vertical positions about once per second and the whole area visibly
jitters. It is enough for one of them to refresh more often than the other — every
refresh pushes it below the other one.

Suggested fix: keep the entry's position when the key already exists in the target map.
`Map.set` on an existing key replaces the value in place, so dispose the old component
and skip the `delete` for the target map; still delete from the *other* map (placement
change) and from both maps when `content === undefined`.

Source-level diff and test plan below — happy to open a PR.

### 3) 最小复现

两个各约 10 行的临时扩展即可（也可用本仓库现成组合：`run-timer` + `loop` 有任务时同屏）：

```ts
// ext-a.ts（每秒写一次）
pi.on("session_start", (_e, ctx) => setInterval(() => ctx.ui.setWidget("a", ["A"]), 1000));
// ext-b.ts（每秒写一次）
pi.on("session_start", (_e, ctx) => setInterval(() => ctx.ui.setWidget("b", ["B"]), 1000));
```

- 修复前：两行每 ~1s 上下互换（谁后写谁在下）。
- 修复后：顺序恒为首次 `setWidget` 顺序（`a` 在 `b` 上），与刷新相位无关。

### 4) 源码级 diff（PR 内容，可直接 `git apply`）

```diff
diff --git a/packages/coding-agent/src/modes/interactive/interactive-mode.ts b/packages/coding-agent/src/modes/interactive/interactive-mode.ts
index e4f0fe0..e43a5dc 100644
--- a/packages/coding-agent/src/modes/interactive/interactive-mode.ts
+++ b/packages/coding-agent/src/modes/interactive/interactive-mode.ts
@@ -2191,14 +2191,22 @@ export class InteractiveMode {
 		options?: ExtensionWidgetOptions,
 	): void {
 		const placement = options?.placement ?? "aboveEditor";
-		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
+		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
+		const otherMap = placement === "belowEditor" ? this.extensionWidgetsAbove : this.extensionWidgetsBelow;
+		// Keep the entry's position when updating in place: Map.set replaces an existing
+		// key without changing iteration order, and widget order is insertion order.
+		// Deleting first moved every refreshed widget to the bottom of its stack.
+		const removeExisting = (
+			map: Map<string, Component & { dispose?(): void }>,
+			keepPosition: boolean,
+		) => {
 			const existing = map.get(key);
 			if (existing?.dispose) existing.dispose();
-			map.delete(key);
+			if (!keepPosition) map.delete(key);
 		};
 
-		removeExisting(this.extensionWidgetsAbove);
-		removeExisting(this.extensionWidgetsBelow);
+		removeExisting(otherMap, false);
+		removeExisting(targetMap, content !== undefined);
 
 		if (content === undefined) {
 			this.renderWidgets();
@@ -2222,7 +2230,6 @@ export class InteractiveMode {
 			component = content(this.ui, theme);
 		}
 
-		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
 		targetMap.set(key, component);
 		this.renderWidgets();
 	}
```

### 5) 测试计划（PR 附带）

- 新增回归测试（建议 `packages/coding-agent/test/interactive-mode-widget-order.test.ts`，仿现有 `interactive-mode-*.test.ts` 装配）：
  1. `a`、`b` 先后注册后单独更新 `a`：断言 above 栈 keys 仍为 `["a", "b"]`（位置不变）；
  2. placement 切换：`a` 由 aboveEditor 改 belowEditor 后，above 不再含 `a`、below 含 `a`；
  3. `content === undefined` 从两个栈移除；
  4. 重复更新同 key：旧组件 `dispose()` 被调用且 Map size 不变（不泄漏）。
- 手动：两个 1s 刷新扩展同屏 10s，位置不换；`/reload`、placement 切换、清空行为不变。

### 6) 可选后续（可另开 issue，不阻塞本 PR）

- `setWidget(key, content, { placement, order })` 显式排序字段（或宿主按 key 排序，与 footer 的 `localeCompare` 一致），把 widget 顺序从"插入序"变成契约；
- footer 段级优先级：超宽时按优先级折叠/省略，而不是整行硬截断（与本仓库 footer 挤占待办同源）。

### 7) 提交检查单（执行人）

- [ ] fork `earendil-works/pi` → 应用 §4 两个 hunk → 按上游 README 跑测试 + §3 手动复现；
- [ ] 开 PR：标题用 §1，正文用 §2 + §3 + §5，附 before/after 现象描述；
- [ ] 合并发布后：本仓库撤本地补丁，回归 `npm run test:contract` + 真机顺序，更新本节状态与 `docs/cross/status-bar.md`。
