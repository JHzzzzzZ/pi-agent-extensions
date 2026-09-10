# pi 宿主补丁：extension widget 保序更新（修复输入栏上方 widget 抖动）

> 跨扩展状态条契约（对齐秒节拍 / footer 排序带 / widget 栈顺序）见 `docs/cross/status-bar.md`；本补丁是 widget 刷新保序的最后一道防线，扩展侧的节拍统一不依赖它。

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

## 上游 issue 草稿（建议提交给 @earendil-works/pi-coding-agent）

**Title**: Extension widgets reorder on every `setWidget` update — periodically-refreshing widgets swap positions every second

**Body**:

`InteractiveMode.setExtensionWidget` removes the existing entry from both widget maps
(`Map.delete`) before re-inserting via `Map.set`. Since JS Maps iterate in insertion
order, every update moves the widget to the bottom of the widget stack.

With two extensions whose widgets refresh periodically (e.g. a 1s timer widget and a
1s task-progress widget), whichever updated last sits at the bottom, so the two widgets
swap vertical positions about once per second — the whole area visibly jitters.

Suggested fix: keep the entry's position when the key already exists in the target map
— `Map.set` on an existing key replaces the value in place, so only dispose the old
component and skip the `delete` (still delete from the *other* map to handle placement
changes, and delete from both when `content === undefined`).

Happy to open a PR if you agree with the direction.
