# 宿主问题：extension widget 刷新重排（上游 issue 稿；本地不打补丁）

> 跨扩展状态条契约（对齐秒节拍 / footer 排序带 / widget 栈顺序）见 `docs/cross/status-bar.md`。
> **本仓库不修改宿主安装目录**（规则见 `AGENTS.md`「仓库边界」）；本文只保留问题描述与上游 issue 草稿，
> 历史本地补丁（已按规则撤销）的实现见 git 历史。

## 症状

agent-team 运行时，输入栏上方的灰色 widget 区域持续"抽搐"：run-timer 的计时行
（`任务 X · 本轮 X · 本会话 X`）每秒在 agent-team 状态块的上方/下方之间翻转；
loop 的 1s 倒计时 widget 与任何周期刷新 widget 同屏时同理。

## 根因（宿主行为，非扩展问题）

宿主 `InteractiveMode.setExtensionWidget`（pi-coding-agent）在每次 `setWidget` 时对
**两个** widget Map 都执行 `Map.delete(key)`，再 `Map.set(key, component)` 重新插入。
JS Map 按插入序迭代，因此**每刷新一次，该 widget 就被挪到 widget 区最底部**。

`session_start` 按扩展注册顺序逐个派发，因此**首次挂载**顺序 = 根 `package.json`
`pi.extensions` 顺序；但刷新阶段不保序：同栈每有一个 widget 更新，它就排到栈底。
编辑器上方栈有 `pwr-runs`（推送刷新）、`run-timer`（1s 节拍）、`loop`（1s 节拍），
因此可见相对顺序会随刷新漂移；编辑器下方栈只有 agent-team 单占，无可见影响。

## 现状与出路

- 按「仓库边界」规则，本仓库**不再打宿主补丁**；未打补丁的宿主上刷新期间的相对顺序不保证
  （纯观感问题，无功能/数据风险）。
- 出口只有上游修复（或用户人工批准临时补丁）：各插件 todo 的 route A 条目跟踪提交上游一事。

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
