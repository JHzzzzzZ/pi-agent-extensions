# 跨扩展横切契约：远端目录上下文能力协商

> last verified @ 8ee5f5c
>
> 背景：`dir-context` 补的是「模型触碰某目录时自动注入该目录的 `AGENTS.md`」，但它**不会 ssh、
> 也解不了远端路径**（`dir-context-todo#4` 的根因就是远端路径在字符串层面与本机路径不可区分）。
> 带 `remote` 的调用在远端执行、`path` 按远端规则解析（见 [`shell-tool-capability.md`](shell-tool-capability.md)
> 与 `remote-tools` 卡片），所以要**自动注入远端目录的约定文件**，必须由能 ssh 的那一侧把文件取回来。
>
> 方案：宿主官方 `pi.events`（`dist/core/event-bus.js`，`emit` 同步派发、无返回值）做一次能力协商。
> 分工是契约的核心——**提供方只负责「取」，消费方只负责「注入」**：去重键、码点截断、双层预算、
> 块格式与发现顺序全部留在 `dir-context`（规则只有一份），远端路径解析与 ssh 全部留在 `remote-tools`。
> 双方不互相 import、不走 `globalThis` 私有槽，任一扩展单独安装都照常工作。

## 频道与盒子

| 项 | 值 |
| --- | --- |
| 频道名 | `pi-extensions:dir-context-remote-context:v1`（形状升级开新频道 `…:v2`，不做版本字段——与 shell 频道同口径） |
| 方向 | 消费方 `dir-context` 在 `session_start` **广播空盒子**，提供方 `remote-tools` 在**同步**回调里填 `box.remoteContext` |
| 盒子 | `{ remoteContext?: RemoteContextCapability }` |
| 填充规则 | 槽位已有值不覆盖（先到先得）；盒子不是对象 ⇒ 忽略 |
| 缺席语义 | 没有提供方 / 宿主没有 `pi.events` / `emit` 抛错 / 载荷畸形 ⇒ 消费方按「零注入 + 一行提示」处理（即 `dir-context-todo#4` 之后的行为，逐字不变），并在载荷畸形时 `notify` 一次 |
| 时序前提 | 宿主 `emit` 同步派发订阅回调，且 `EventBus.on` 的包装只把回调推进一步（同步回调体在 `emit` 返回前跑完）⇒ **订阅方必须在消费方广播之前订阅**（两边都在加载期/`session_start` 订阅，成立；这也是契约要求「填槽必须同步」的原因） |

## 载荷（`box.remoteContext`）

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `fetchRemoteContext(request)` | `(RemoteContextRequest) => Promise<RemoteContextOutcome>` | 取该远端目录祖先链上的约定文件。**永不 reject**（失败一律收敛成 `ok: false`） |

`RemoteContextRequest`：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `remote` | `string` | 模型给的 ssh 目标原文（可能含 `user@`） |
| `remotePort` | `number?` | 远端端口，省略 = ssh 默认 |
| `path` | `string?` | 模型给的**原始**路径（可能省略 / 相对 / 绝对 POSIX）——**由提供方解析**，消费方不猜 |
| `kind` | `"file" \| "directory"` | 触碰类型：目录类把该路径自身当锚点，文件类退到父目录（与本地 `resolveAnchor` 同语义） |

`RemoteContextOutcome`：

| 形状 | 语义 |
| --- | --- |
| `{ ok: true, dir: string, files: { path, content }[] }` | 取到了（`files` 可为空 = 该链上确实没有约定文件）。`path` 是**远端绝对路径**，`files` 已按**由外向内**排好 |
| `{ ok: false, code: string, message: string }` | 取不到（解析失败 / ssh 失败 / 远端非零退出） |

## 双方义务

- **形状守卫各自实现**（不共享代码、不跨扩展 import）：盒子里外都是别人的对象，一律当不可信。
  - 提供方守**请求**：`remote` 非空字符串、`kind` 是 `"file"|"directory"`、`remotePort`/`path` 类型对；
    非法请求**根本不进实现**，直接回 `ok: false`。
  - 消费方守**结果**：`ok`/`dir`/`files` 逐字段校验，`files` 里的垃圾条目逐条过滤；
    载荷不是对象 / `fetchRemoteContext` 不是函数 ⇒ 当作「没有能力」。
- **失败不改坏任何东西**：提供方永不抛（`runSsh` 的异常也收敛）；消费方调用一律包 `try/catch`。
  取不到只导致「这次不注入」，绝不打断工具结果、不写状态条、不弹 UI 告警（只在**载荷畸形**时 notify 一次）。
- **一趟 ssh**：一条祖先链合成**一条**远端命令取完（不逐级往返）。远端没有 cwd 概念，链的终点是
  远端解析基准：相对/省略路径走到远端 `$HOME`、绝对路径走到 `/`（两端都含，由外向内，深度有上限）。
- **锚点逃出基准即空链**（fail-closed）：`..` 越过 `$HOME` 的路径不取，零注入。
- **消费方的三态**：`injected`（真的注入了 ⇒ **不再**追加提示）/ `nothing`（已注入过、或远端确实没有
  约定文件 ⇒ 不是失败，也不提示）/ `unavailable`（没装对端或取失败 ⇒ 退回那行静态提示）。
- **块头自报来源**：远端块的 `Loaded` 行与 `<dir-context remote="…">` 属性都带 host
  （`Loaded <host>:<远端绝对路径>`），避免把远端约定误当本机约定；本地块格式逐字不变。
- **不在触发面上的工具不取**：`grep`/`find` 这类工具带 `remote` 时不申请远端上下文（只按入参字段给提示）。

## 相关

- 消费方：`src/extensions/dir-context/remote-context.ts`（握手 + 守卫）、`index.ts`（三态与注入接线）
- 提供方：`src/extensions/remote-tools/context.ts`（祖先链 + 命令拼装 + NUL 分帧）、`tools.ts`（订阅填槽）
- 卡片：[`extensions/dir-context.md`](../extensions/dir-context.md)、[`extensions/remote-tools.md`](../extensions/remote-tools.md)
- 规格：[`specs/dir-context.md`](../specs/dir-context.md)
- 需求与对齐：`todos/align/dir-context-todo#6.md`
- 同类先例：[`shell-tool-capability.md`](shell-tool-capability.md)（那片是 owner 广播、提供方填槽）
