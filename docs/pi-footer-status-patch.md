# pi 宿主补丁：footer 扩展状态逐行渲染（修复多源状态挤占与尾部截断）

> 跨扩展状态条契约（对齐秒节拍 / footer 排序带 / widget 栈顺序）见 `docs/cross/status-bar.md`；
> 本补丁是 footer 多源状态可读性的最后一道防线。扩展侧零改动，全部文案保留。

## 症状

多个扩展同屏写 footer 时，只有排序带最前的段完整可见，其余段被硬切或整段消失。
真机截图（2026-09-11，goal + provider-quota + pwr 同屏）：

```
◎ goal: …  GO 5h 72% …  workflows: 2 activ...
```

`stream-token-speed`（排序带 50，段最长）在场时会被**整段截没**。

## 根因（宿主行为，非扩展问题）

宿主 `FooterComponent.render` 把全部扩展状态按 key `localeCompare` 排序后，用单空格
`join(" ")` 拼成**一行**，再对该行做 `truncateToWidth` 尾部截断。终端宽度是共享预算：
先写的段吃满宽度，后面的段只能分到残渣。段间又没有分隔符，截断点落在任意字符上，
观感就是「状态条被谁挤掉了」。

## 补丁内容

每个扩展状态**各占一行**（仍按 key 排序，即排序带 10→50 顺序）；单段自身超过终端宽度时
用 `pi-tui` 的 `wrapTextWithAnsi` 续行（保留 ANSI 样式、按可见宽度断行），信息零损失。

补丁前（`render(width)` 末尾）：

```js
const extensionStatuses = this.footerData.getExtensionStatuses();
if (extensionStatuses.size > 0) {
    const sortedStatuses = Array.from(extensionStatuses.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatusText(text));
    const statusLine = sortedStatuses.join(" ");
    lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
}
```

补丁后：

```js
const extensionStatuses = this.footerData.getExtensionStatuses();
if (extensionStatuses.size > 0) {
    const sortedStatuses = Array.from(extensionStatuses.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatusText(text))
        .filter((text) => text.length > 0);
    for (const status of sortedStatuses) {
        if (visibleWidth(status) <= width) {
            lines.push(status);
        } else {
            lines.push(...wrapTextWithAnsi(status, Math.max(1, width)));
        }
    }
}
```

同时把 import 行追加 `wrapTextWithAnsi`：

```js
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
```

行为要点：

- 段顺序不变（key `localeCompare`），排序带契约不动；
- 空串状态过滤，不产生空行；无扩展状态时 footer 仍是 2 行（pwd + stats/model）；
- 单段超宽续行而非截断——不引入分隔符、不做段内截断、行数不限；
- pwd / stats / model 固定两行不受影响。

## 已应用位置（两个文件都改，缺一不生效）

- **运行时实际生效**：v0.85.1 打包产物
  `.../pi-coding-agent/dist/bundle/chunks/chunk-JVUZSMYM.js`
  （备份：同目录 `chunk-JVUZSMYM.js.bak-footer-status`，回滚 = 还原备份）。
  `pi` CLI 入口是 660B 的 `dist/bundle/cli.js`，真正加载的是 esbuild 打包后的
  `dist/bundle/chunks/*.js`（本版该 chunk 约 4MB）；压缩产物里的变量名与源码版不同
  （排序回调参数是 `b2`），锚点是 `getExtensionStatuses()` 后同一行的
  `.join(" ")` + `truncateToWidth(...)` 状态块，用精确字符串替换补丁最稳。
- **源码组件（非运行路径，保持同步）**：
  `.../pi-coding-agent/dist/modes/interactive/components/footer.js`
  （备份：同目录 `footer.js.bak-footer-status`）。
- 应用后需**重启 pi** 才生效（运行中的进程仍持有旧代码）。

> 坑（2026-09-11 首轮踩过）：只改 `dist/modes/interactive/components/footer.js` **不会生效**，
> 真机仍显示拼接截断行。CLI 走 bundle，必须改 `dist/bundle/chunks/` 里的同一段代码；
> 改完从 chunk 导入真实 `FooterComponent` 复验（见下方验证方式）。

注：工作区内 `pwr/node_modules`、`agent-team/node_modules` 等 0.83.0/0.85.1 副本仅用于
typecheck，运行时不加载，未打补丁。

## 验证方式（打补丁后本机实测）

用真实 `FooterComponent` + fake session/footerData 直跑 `render(width)`（**从 bundle
chunk 导入**，即运行时实际执行的代码；未打包组件同跑一遍）：

1. 五段同屏（宽终端）：2 基础行 + 5 状态行，顺序 10→50，逐行完整；
2. 40 列窄终端：长段经 `wrapTextWithAnsi` 续行，所有行 `visibleWidth ≤ 40`，
   拼接去空白后与原文逐字符相等（零信息损失）；
3. ANSI 彩色段跨行续行，每行都保留起色序列；
4. 空串状态被过滤、无状态时行数仍为 2。

## 升级 pi 后重打

`npm` 升级 `@earendil-works/pi-coding-agent` 会覆盖 dist 产物，补丁丢失需重打：

1. **先定位 bundle chunk**：`grep -l getExtensionStatuses dist/bundle/chunks/*.js`
   （chunk 文件名哈希随版本变化，勿照抄 `chunk-JVUZSMYM.js`）。
2. 按上文“补丁内容”在同一行内替换状态块：删掉 `join(" ")` 与整行
   `truncateToWidth`，改为逐段 `visibleWidth` 判定 + 超宽 `wrapTextWithAnsi`；
   过滤空串。`wrapTextWithAnsi` 与 `visibleWidth` 同在该 chunk 作用域内，直接调用。
3. 同步替换未打包组件 `dist/modes/interactive/components/footer.js`（import 行加
   `wrapTextWithAnsi`）——若该版本仍分发组件文件。
4. 两处 `node --check` 校验，重启 pi。

若上游已修复则无需重打（见下）。

## 上游 issue 草稿（建议提交给 @earendil-works/pi-coding-agent）

**Title**: Built-in footer joins all extension statuses into one line and tail-truncates it — render one status per line / wrap long ones

**Body**:

`FooterComponent.render` collects all extension statuses into a single string
(`sortedStatuses.join(" ")`) and then tail-truncates it with `truncateToWidth`.
With several extensions writing status (a timer, a quota indicator, a workflow
counter, a goal progress line, …) the terminal width becomes a shared budget:
whichever segment comes first consumes it, later segments get cut mid-text or
dropped entirely. On an 80-column terminal the last band (`50:stream-token-speed`,
the longest segment) is effectively invisible, and there is no separator to tell
where one extension's status ends and the next begins.

Suggested fix: render each extension status on its own line (still sorted by key),
and when a single segment exceeds the terminal width, wrap it with
`wrapTextWithAnsi(text, width)` instead of truncating it. This keeps the existing
sort contract, loses no information, and keeps the pwd/stats/model rows unchanged.

Happy to open a PR if you agree with the direction.
