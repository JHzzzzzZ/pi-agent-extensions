# 宿主问题：extension widget 刷新重排（上游 issue 稿；本地不打补丁）

> 跨扩展状态条契约（对齐秒节拍 / footer 排序带 / widget 排序带）见 `docs/cross/status-bar.md`。
> **本仓库不修改宿主安装目录**（规则见 `AGENTS.md`「仓库边界」）；本文保留问题描述、可粘贴的
> 上游 issue 正文（含最小复现与源码级修复建议）与本地自愈方案的现状。
> 历史本地补丁（已按规则撤销）的实现见 git 历史。

## 症状

agent-team 运行时，输入栏上方的灰色 widget 区域持续"抽搐"：run-timer 的计时行
（`任务 X · 本轮 X · 本会话 X`）每秒在其它段的上方/下方之间翻转；loop 的 1s 倒计时
widget 与任何周期刷新 widget 同屏时同理。三段同屏（pwr-runs / run-timer / loop）时
最直观：每一秒都有某一段"跳"到栈底。

## 根因（宿主行为，非扩展问题）

宿主 `InteractiveMode.setExtensionWidget`（pi-coding-agent 0.85.1）在每次 `setWidget`
时对**两个** widget Map 都执行 `Map.delete(key)`，再 `Map.set(key, component)` 重新插入。
JS Map 按插入序迭代（`renderWidgetContainer` 就是 `for (const component of widgets.values())`），
因此**每刷新一次，该 widget 就被挪到该栈最底部**。

`session_start` 按扩展注册顺序逐个派发，因此**首次挂载**顺序 = 根 `package.json`
`pi.extensions` 顺序；但刷新阶段不保序：同栈每有一个 widget 更新，它就排到栈底。
编辑器上方栈有 `pwr-runs`（推送刷新）、`run-timer`（1s 节拍）、`loop`（1s 节拍），
因此可见相对顺序随刷新漂移；编辑器下方栈只有 agent-team 单占，无可见影响。

## 本地现状与出路（本仓库侧）

- **已自愈**：三个上方写入者改为经仓库内「widget 排序带」（每插件一份 `widget-band.ts`，
  `globalThis` + `Symbol.for` 共享登记表）登记逻辑行，由 band key 最小的可见段一次写宿主
  单键 `widget-band`。宿主只有一个键可挪，段间顺序改由 band key 升序保证；契约与验证见
  `docs/cross/status-bar.md` 的「widget 排序带」一节。**上游修复后本机制无需撤回**（单键写入
  仍然成立，且顺序不再依赖宿主内部实现）。
- 宿主行为本身仍未修：本条保留上游 issue 稿，供有 GitHub 账号的人提交（历史 route A 条目
  已归并到 `todos/` 的对应条目）。

---

## 上游 issue 正文（可直接粘贴给 @earendil-works/pi-coding-agent）

**Title**: Extension widgets reorder on every `setWidget` update — periodically refreshing widgets swap positions

**Body**:

### Summary

`InteractiveMode.setExtensionWidget` deletes the key from both widget maps before re-inserting
the component. Since the widget container is rendered by iterating the map, every update moves
that widget to the bottom of the stack. With two or more periodically refreshing widgets
(e.g. a 1s timer next to a 1s countdown), the visible order shuffles roughly once per second.

### Steps to reproduce (minimal, no TUI/session needed)

```js
// repro.mjs — 直接用真实原型方法 + 真实 pi-tui 容器复现
// 依赖：@earendil-works/pi-coding-agent、@earendil-works/pi-tui（宿主自带）
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

const above = new Container();
const methods = InteractiveMode.prototype;
const host = {
  extensionWidgetsAbove: new Map(),
  extensionWidgetsBelow: new Map(),
  renderWidgets() {
    methods.renderWidgetContainer.call(this, above, this.extensionWidgetsAbove, true, true);
  },
};
const setWidget = (key, lines) => methods.setExtensionWidget.call(host, key, lines);
const screen = () =>
  above
    .render(60)
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim())
    .filter(Boolean);

setWidget("a", ["A"]);
setWidget("b", ["B"]);
setWidget("c", ["C"]);
console.log(screen()); // [ 'A', 'B', 'C' ]

setWidget("b", ["B2"]); // 只刷新中间那个
console.log(screen()); // [ 'A', 'C', 'B2' ]  ← B 被挪到栈底（期望仍是 [ 'A', 'B2', 'C' ]）
```

Observed (pi-coding-agent 0.85.1, Node 22.23.1):

```
initial: [ 'A', 'B', 'C' ]
after B refresh: [ 'A', 'C', 'B2' ]
```

### Expected

Updating an existing widget keeps its position in the stack; only the first
`setWidget(key, …)` decides where the widget sits (that is what extension authors assume when
they rely on `package.json`/registration order).

### Suggested fix (source-level diff)

`dist/modes/interactive/interactive-mode.js` (compiled), source equivalent:

```js
 setExtensionWidget(key, content, options) {
     const placement = options?.placement ?? "aboveEditor";
     const removeExisting = (map) => {
         const existing = map.get(key);
         if (existing?.dispose)
             existing.dispose();
         map.delete(key);
     };
-    removeExisting(this.extensionWidgetsAbove);
-    removeExisting(this.extensionWidgetsBelow);
+    const target = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
+    const other = target === this.extensionWidgetsAbove ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
+    // 只从另一个栈里摘（处理 placement 变更）；目标栈里的旧组件就地 dispose，
+    // 但不 delete —— set 到已存在的 key 会原地替换，插入序得以保留。
+    const displaced = target.get(key);
+    if (displaced?.dispose)
+        displaced.dispose();
+    removeExisting(other);
     if (content === undefined) {
+        target.delete(key);
         this.renderWidgets();
         return;
     }
     let component;
     // …（string[] 包装 / 组件工厂分支不变）
-    const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
-    targetMap.set(key, component);
+    target.set(key, component);
     this.renderWidgets();
 }
```

`Map.set` on an existing key replaces the value in place without changing insertion order, so
this is enough: dispose the old component, keep the slot. (Nice-to-have, not required for the
report: an explicit ordering/priority option on `setWidget`.)

Happy to open a PR if you agree with the direction.
