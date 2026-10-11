# 对齐：dir-context-todo#6 — 远端目录的上下文自动注入（方案 B：能力协商）

- 条目：`dir-context-todo#6`（tags: `enhancement`, `remote-tools`，priority 6）· 分支引用：`feat/dir-context-remote-context`
- 日期：2026-10-11（UTC）· 参与：用户（提出需求 + 定档方案 B + 5 项决定）+ agent（宿主 API 事实核查与方案比对）
- 状态：**待人工确认**（5 项决定已由用户口头给出，落盘待复核）
- 前情：`todos/align/dir-context-todo#4.md` 明确把「远端侧随行注入」列为**范围外**（理由：当时只有 1 个案例，且会造出第二套去重/预算实现）。本条把它转正式需求。

## 意图

`#4` 之后的现状：带 `remote` 的调用**零注入 + 一行提示**，模型要自己 `read` 远端 `AGENTS.md`。用户要的是**自动注入**——远端目录的约定文件应当像本地一样自动进上下文，而不是靠模型自觉。

要自动注入，必须有「远端取文件」的通道，因为 dir-context **不会 ssh、也解不了远端路径**（这正是 `#4` 的根因）。通道只能在 remote-tools 或一个新协议里。

### 已排除的候选（附核查证据）

| 方案 | 结论 |
| --- | --- |
| **E：复用现成的 `read`/`bash` 工具**（用户提出：「注入一个 function-call 的结果，read 支持远程就远程、本地就本地」） | **宿主 API 上做不到**。`executeTool` / `tools` 只存在于 `ExtensionToolContext`（宿主 `types.d.ts:269`，由 `runner.createToolContext()` 提供，**只给工具定义的 execute**）；`tool_result` 处理器拿到的是 `ExtensionContext`（`runner.emitToolResult()` 走 `createContext()`，**没有** `executeTool`、没有 `tools`）。纯监听的扩展调不了别的工具。要变成能调，得让 dir-context 去注册/包裹工具——那是另一个架构，不在本条范围。 |
| **C：remote-tools 侧随行注入** | 传输与注入同一处、成本最低，但会把 `Loaded <路径>` 格式 + 去重 + 预算规则**复制**进第二个插件（`#4` 已因此排除）。 |
| **A：`details` 数据字段** | 避免协议，但要求 remote-tools 在**每次**远端调用都去取祖先链（哪怕这次调用不是「触碰目录」），且 dir-context 要认识一个新字段形状——比 B 更隐晦的耦合。 |

**定档：B —— 用宿主官方 `pi.events` 做一次能力协商**（与 `docs/cross/shell-tool-capability.md` 的 shell 先例同构）。

## 范围

**做什么**

1. **能力协商（同步握手机制照抄 shell 先例）**：dir-context 在 `session_start` 广播一个可变盒子 `{ remoteContext?: RemoteContextCapability }`；remote-tools 订阅后在**同步**回调里填 `box.remoteContext`（宿主 `emit` 同步派发、回调返回时盒子已就绪，这是契约成立的前提）。槽位先到先得、已有值不覆盖。
2. **能力载荷**（提供方 = remote-tools，消费者 = dir-context）：
   ```
   fetchRemoteContext(args: { remote: string; remotePort?: number; path: string | undefined })
     => Promise<{ dir: string; files: { path: string; content: string }[] } | { error: string }>
   ```
   - remote-tools 负责「解析远端路径」与「取文件」：复用它自己的 `resolveToolPath`（相对/省略路径按远端 `$HOME`，绝对 POSIX 路径直接用），**一趟 ssh** 取完整条祖先链。
   - dir-context 负责「注入」：复用自己那套发现顺序、会话去重、码点截断、双层预算与块格式。
   - 载荷里的东西一律当**不可信**：形状守卫各自实现（不共享代码、不 import 对方模块）；畸形载荷 ⇒ 当作「没有能力」，退回今天的行为，不抛异常。
3. **祖先链终点**（用户决定 1「到 HOME 或者最外层」）：相对/省略路径 ⇒ 从文件所在目录向上**走到远端 `$HOME` 为止**；绝对路径 ⇒ 向上**走到 `/` 为止**（含 `/`）。每目录取一个，优先级与本地一致（`AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`），顺序**由外向内**。
4. **一趟 ssh**（用户决定 2）：祖先链的所有候选文件合成**一条**远端命令取回（逐级 `cat` + 不存在就跳过），不做每级一次往返。
5. **失败降级**（用户决定 3 + 5）：取不到（ssh 失败/超时/能力缺席/载荷畸形）⇒ 退回**今天那行提示**；提示保持朴素形态（纯文本一行、不加重语气、不发 UI 通知、不写状态条）。**注入成功 ⇒ 不再追加那行提示**。
6. **标来源**（用户决定 4）：远端块必须自报来自哪台机，且与本地块可区分：
   ```
   Loaded <host>:<远端绝对路径>
   <dir-context remote="<host>" path="<远端绝对路径>">
   …内容…
   </dir-context>
   ```
   本地块的现有格式（`Loaded <相对路径>` / `<dir-context path="…">`）**逐字不变**。
7. **触发面与本地一致**：`read` / `write` / `edit` / `ls` / bash 单文件读；只在入参 `remote` 判为远端调用时走远端分支；`grep` / `find` 仍不在触发面上（本条不改它们的口径）。工具本身失败的调用照旧零注入、也不取远端上下文（沿用「失败结果不追加」）。codemode 脚本里的远端触碰走同一套（顶层结果代偿）。
8. **文档四同步**：新增横切契约 `docs/cross/remote-context-capability.md`（频道名/载荷/双方义务/缺席语义；仿 shell 那张卡）；`docs/extensions/dir-context.md` + `docs/specs/dir-context.md` + `docs/adr/0011` 补远端注入面；`docs/extensions/remote-tools.md` 写提供方义务；根 README 与插件 README；`CONTEXT.md` 术语。

**明确不做什么**

- **不做 C**（remote-tools 自己注入）：注入规则只有一份，`Loaded`/预算/去重属于 dir-context。
- **不复制对方代码**：两个插件不 import 彼此任何模块；能力载荷是唯一接口。
- **不做「远端 grep/find 触发」**，不改现有本地路径的任何语义，不改去重键/预算/状态条契约。
- **不做远端 cwd 概念**：没有「远端项目根」，链的终点只能是 `$HOME` 或 `/`（用户决定 1）。
- **不给远端注入加独立预算档**：与本地共用 32 KiB/文件、128 KiB/次。

## 验收标准

1. **能力缺席 = 行为逐字不变**：不装 remote-tools（或它不填盒子、载荷畸形）⇒ 带 `remote` 的调用仍是「零注入 + 一行提示」，与今天逐字一致。
2. **相对路径自动注入**：`read path="docs/x.md" remote="prod"`（远端 `<home>/docs/x.md` 存在，`<home>/docs/AGENTS.md` 与 `<home>/AGENTS.md` 存在）⇒ 结果里出现 `Loaded prod:<home>/AGENTS.md` 与 `Loaded prod:<home>/docs/AGENTS.md`，**由外向内**；且**没有**那行提示。
3. **绝对路径自动注入**：`/srv/app/docs/x.md` ⇒ 取其祖先链直到 `/`（只注入真实存在的候选）。
4. **不误注入本机**：本机同名路径（如本地 `docs/AGENTS.md`）**绝不出现**在结果里（`#4` 的核心不变量不回归）。
5. **标来源**：远端块的 `Loaded` 行与 `<dir-context>` 属性都带 host；本地块格式逐字不变。
6. **一趟 ssh**：取一条祖先链只发一条远端命令（用注入 ssh 的 fake 计数，或用 remote-tools 的 `SshExec` 端口断言调用次数）。
7. **去重与预算与本地共用**：同一远端文件会话内只注入一次；`session_compact` / `session_start` 后可按需重载；超 32 KiB 码点截断、超 128 KiB 走既有的「丢弃不标记」语义。
8. **失败降级**：ssh 失败/超时 ⇒ 不注入、退回那行提示，且**不**把错误抛给工具结果、**不**写状态条；一次会话内不刷屏。
9. **测试**：能力握手（有/无提供方、槽位先到先得、畸形载荷）+ 祖先链终点（`$HOME` / `/`）+ 一趟 ssh 计数 + 标来源格式 + 降级路径，纯逻辑与真实 `ExtensionRunner` 宿主路径都要有。
10. `npm test` + `npm run typecheck` 全绿，全仓 `test:all` 全绿（已知并发抖动除外）。
11. **跨厂商独立评审**（红线 11）：reviewer 与开发者不同模型家族，逐条处理直到某轮无新意见。
12. **真机验收**：真实 `pi` + 真实 remote-tools + 可连远端主机——（a）远端相对路径自动注入远端 `AGENTS.md`；（b）本机同名 `AGENTS.md` 不出现；（c）块头带 host；（d）拔掉 remote-tools（或不填盒子）时退回一行提示。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-11（UTC）
- **用户明确的方案选择**：**B**（`pi.events` 能力协商）。用户同时提出过 E（复用现成工具的 function-call 结果）；agent 核查宿主 `types.d.ts` / `runner.js` 后确认 `executeTool` 只在 `ExtensionToolContext` 上、`tool_result` 处理器够不到，E 在当前 API 面不可行——已记入本文件的「已排除的候选」。
- **用户明确给出的 5 项决定**（已落进范围 3/4/5/6）：
  1. 祖先链终点：**到远端 `$HOME` 或最外层 `/`**（相对路径走 `$HOME`、绝对路径走 `/`）。
  2. 往返：**一趟 ssh**（合成一条远端命令）。
  3. 失败降级：**退回那行提示**，且提示**不显眼**（朴素一行、不加 UI 告警）。
  4. **必须标来源**（远端块带 host）。
  5. **注入成功就删掉那行提示；注入失败才变成提示行**。
- **待用户复核的默认值（agent 按仓库既有口径拟定）**：
  1. **频道名** `pi-extensions:dir-context-remote-context:v1`（形状升级开新频道 `…:v2`，不做版本字段——与 shell 先例同口径）。
  2. **握手时机**：dir-context 在 `session_start` 广播盒子，每次会话一次；remote-tools 在加载期订阅。
  3. **块格式**：`Loaded <host>:<远端绝对路径>` + `<dir-context remote="<host>" path="<远端绝对路径>">`；host 用模型给的 `remote` 原文（可能含 `user@`）。
  4. **去重键**：`remote` 主机 + 远端绝对路径（与本地去重集合分开，互不干扰）。
  5. **只对「触碰目录」的工具取远端上下文**：与本地触发面同一批工具名；`grep`/`find` 不取。
  6. **提示行的位置不变**：仍是追加到工具结果末尾的一行文本；只是「注入成功时不再追加」。
- **已知风险（显式接受）**：① 每个新远端目录多一趟 ssh（延迟 +RTT，用户已确认接受「一趟」）；② 「远端祖先链到 `$HOME`/`/`」可能比本地 cwd 链长得多（`/srv/app/docs` 会一路走到 `/`），靠「只注入真实存在的候选」+ 预算兜住；③ 能力载荷来自别的扩展，形状漂移时按「没有能力」降级（少注入、不误注入）。
