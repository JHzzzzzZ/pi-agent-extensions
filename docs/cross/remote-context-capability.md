# 跨扩展横切契约：远端目录上下文能力协商

> last verified @ 1c7c6d7
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
| 频道名 | `pi-extensions:dir-context-remote-context:v2`（**线格式不兼容变更就升频道号**，不做版本字段——与 shell 频道同口径；`#6` 的 v1 → `#13` 的 v2 就是因为分帧换了编码） |
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
| `{ ok: true, dir: string, files: { path, content }[] }` | 取到了（`files` 可为空 = 该链上确实没有约定文件）。**空的真文件也会作为空内容列出**——提供方照实上报，注不注入由消费方判（消费方对空内容走 `nothing`）。链上任一候选存在却读不出 ⇒ 不走这条，直接 `ok: false` |
| `{ ok: false, code: string, message: string }` | 取不到。码有两个：`REMOTE_CONTEXT_UNREADABLE`（链上候选存在但读不出——消费方据此给**专属**提示）、`REMOTE_CONTEXT_FAILED`（解析失败 / ssh 失败 / 远端非零退出 / 远端缺 `base64`）。消费方**按码判定，不摘要 message**；未知码回落通用提示 |

## 双方义务

- **形状守卫各自实现**（不共享代码、不跨扩展 import）：盒子里外都是别人的对象，一律当不可信。
  - 提供方守**请求**：`remote` 非空字符串、`kind` 是 `"file"|"directory"`、`remotePort`/`path` 类型对；
    非法请求**根本不进实现**，直接回 `ok: false`。
  - 消费方守**结果**：`ok`/`dir`/`files` 逐字段校验，`files` 里的垃圾条目逐条过滤；
    载荷不是对象 / `fetchRemoteContext` 不是函数 ⇒ 当作「没有能力」。
- **失败不改坏任何东西**：提供方永不抛（`runSsh` 的异常也收敛）；消费方调用一律包 `try/catch`。
  取不到只导致「这次不注入」，绝不打断工具结果、不写状态条、不弹 UI 告警（只在**载荷畸形**时 notify 一次）。
- **提供方必须有时限**：消费方自己兜一层 60 秒超时（`REMOTE_CONTEXT_TIMEOUT_MS`，本层错误码 `DIR_CONTEXT_REMOTE_CONTEXT_UNUSABLE`），因为宿主把 `tool_result` 的合并写成 `await handler(...)`——对端 Promise 永不 settle 会卡住每个远端工具结果。提供方自己的 ssh 有 30 秒兜底，但契约不只靠自觉。
- **一趟 ssh**：一条祖先链合成**一条**远端命令取完（不逐级往返）。远端没有 cwd 概念，链的终点是
  远端解析基准：相对/省略路径走到远端 `$HOME`、绝对路径走到 `/`（两端都含，由外向内，深度有上限）。
- **锚点逃出基准即空链**（fail-closed）：`..` 越过 `$HOME` 的路径不取，零注入。
- **消费方的三态**：`injected`（真的注入了 ⇒ **不再**追加提示）/ `nothing`（已注入过、远端确实没有约定文件、
  或取回的**内容为空** ⇒ 不是失败，也不提示）/ `unavailable`（没装对端或取失败 ⇒ 退回那行静态提示，
  `REMOTE_CONTEXT_UNREADABLE` 时退回的是**权限专属**那条，见下）。
- **块头自报来源**：远端块的 `Loaded` 行与 `<dir-context remote="…">` 属性都带 host
  （`Loaded <host>:<远端绝对路径>`），避免把远端约定误当本机约定；本地块格式逐字不变。
- **路径帧要校验**：远端登录 rc/banner 可能往 stdout 吐东西 ⇒ 提供方解析时丢弃「不以 `/` 开头或含换行」的路径帧（内容不可信，不往上下文里编）；根目录拼命令时不产出 `//` 前缀（POSIX 对 `//` 是实现自定义）。
- **线格式 v2（伪造-proof）**：一趟 ssh 的 stdout 由重复的 `MARK <path>\0<payload>\0` 组成，
  `MARK` 是 `\x01`（读得出，payload = 内容的 base64）/ `\x02`（存在但读不出，payload 空）/
  `\x03`（远端没有 `base64`，单帧）。**为什么 payload 必须 base64**（`remote-tools-todo#13`）：
  v1 直接发原文，等于把「NUL 不会出现在文本内容里」当契约——而内容不可信，含 NUL 的文件
  （`FIRST\0/evil\0SECOND`）会让 NUL 变成帧边界，从而**伪造出任意路径的块**并把真内容劈成两半。
  base64 的字母表不含 NUL / SOH / STX ⇒ 每个 NUL 分隔段都是完整帧，内容再也无法参与边界判定；
  代价是线上体积 +33%（一趟 ssh，可忽略）。`\x03` 的存在理由：远端缺 `base64` 时它只往 stderr 报错、
  stdout 什么都不出 ⇒ 否则会得到「空载荷 ⇒ 看起来像空文件 ⇒ 静默跳过」。
- **读不出 ≠ 不存在**：命令用 `[ -f ]` 判存在、`[ -r ]` 判读得出，读不出时发 `\x02` 帧。只要链上出现
  任一个读不出的候选 ⇒ 整条请求 `ok: false` 且码是 `REMOTE_CONTEXT_UNREADABLE`（fail-closed）——
  **绝不静默少注入**：那个读不出的正是最该生效的那份约定。消费方据此走 `unavailable`：出提示行、
  **不标记已注入**（权限修好后同一会话再触碰就能拿到），且提示是**权限专属**那条（`dir-context-todo#8`：
  使用者的下一步动作是「去 chmod」，与「没装 remote-tools」的「自己去 read」不同）。
  已知边界：`-r` 为真但 `base64` 仍读失败（竞态 / IO 错误 / NFS root-squash）会退回「空载荷 = 空文件」——
  概率极低，记录不改。
- **路径必须归一化后再用**（`remote-tools-todo#14`）：解析出远端绝对路径后立刻 `posix.normalize`，
  再用于祖先链与帧里的 `<path>`。消费方的去重键与块标题都取自帧里的路径 ⇒ 提供方一处归一同时修好两边；
  否则 `.`/`..` 一变就是一个新键（同一份 `AGENTS.md` 被重复注入，标题也不是真实路径）。
  不做符号链接同文件识别（那要 `realpath`；判据是「路径字符串归一」而非「文件身份」）。
- **空内容归消费方判**（`dir-context-todo#9`）：0 字节的约定文件由提供方照实上报（`ok: true` + 空内容），
  消费方判定「空 ⇒ 无可注入的新内容」⇒ 走 `nothing`（不注入空块、不标记、不提示）。
  不这么做的代价：空块是噪声，且被标成已注入 ⇒ 文件后来有内容时**同一会话**也拿不到。
- **不在触发面上的工具不取**：`grep`/`find` 这类工具带 `remote` 时不申请远端上下文（只按入参字段给提示）。

## 相关

- 消费方：`src/extensions/dir-context/remote-context.ts`（握手 + 守卫）、`index.ts`（三态与注入接线）
- 提供方：`src/extensions/remote-tools/context.ts`（祖先链 + 命令拼装 + NUL 分帧）、`tools.ts`（订阅填槽）
- 卡片：[`extensions/dir-context.md`](../extensions/dir-context.md)、[`extensions/remote-tools.md`](../extensions/remote-tools.md)
- 规格：[`specs/dir-context.md`](../specs/dir-context.md)、[`specs/remote-context-v2.md`](../specs/remote-context-v2.md)
- 需求与对齐：`todos/align/dir-context-todo#6.md`（握手与三态）、`todos/align/remote-context-v2-design.md` + 四份 `todos/align/*#13|#14|#8|#9*.md`（协议 v2）
- 同类先例：[`shell-tool-capability.md`](shell-tool-capability.md)（那片是 owner 广播、提供方填槽）
