# 对齐：dir-context-todo#4 — 远端调用的锚点错判（不注入远端、也绝不注入本地）

- 条目：`dir-context-todo#4`（tags: `enhancement`, `remote-tools`，priority 7）· 分支引用：`feat/dir-context-remote-calls`（待第二次 claim 写入）
- 日期：2026-10-11（UTC）· 参与：用户（提出处理要求 + 两条硬约束）+ agent（实机现象核对与真实函数复现）
- 状态：**已对齐**（用户 2026-10-11 指示「登记；同时需要确保不依赖 remote 插件，如果函数不支持参数 remote 也需要静默到本地」，默认值见「人工确认」）

## 意图

`remote-tools` 给七个内置工具加了 `remote="[user@]host"` 参数：`remote` 非空时该次调用在远端主机执行，`path` 在**远端**解析（省略或相对路径按远端 `$HOME`，绝对 POSIX 路径直接用）。

`dir-context` 只看 `event.input.path`，按**本地 cwd** 解析锚点。两者组合出一个未处理的交叉面（本会话实测核对）：

| 调用 | dir-context 现在的行为 |
| --- | --- |
| `read path="docs/x.md" remote="prod"`（远端相对路径） | **注入本地 `docs/AGENTS.md`** —— 错注入（把本机约定当成远端目录的约定喂给模型），比不注入更危险 |
| `read path="/srv/app/docs/x.md" remote="prod"`（远端绝对路径） | 零注入（静默，用户 2026-10-11 实测报告的情形） |
| `read path="docs/x.md"`（本地调用） | 注入本地 `docs/AGENTS.md` ✅ 正确 |

复现证据（本会话，复用仓库真实函数 `detectTouch` + `resolveAnchor` + `discoverContextFiles`，临时目录树里放 `docs/AGENTS.md`）：

```
远端相对路径：input={"path":"docs/x.md","remote":"prod"}        → 会注入：docs/AGENTS.md   ❌
远端绝对路径：input={"path":"/srv/app/docs/x.md","remote":"prod"} → 会注入：（无 ⇒ 零注入）
本地调用（对照）：input={"path":"docs/x.md"}                     → 会注入：docs/AGENTS.md   ✅
```

根因：远端路径与本地路径在**字符串层面不可区分**（远端相对路径尤其），而本扩展无法（也不应）跨机解析远端路径。

## 范围

**做什么（第 0 层止血 + 一行提示）**

1. **远端判据（纯字段，零耦合）**：工具入参里 `remote` 字段存在、是非空字符串、且**不是缺省值字面量**（`null` / `undefined` / `nil` / `none` / `n/a` / `na`，trim + 大小写无关——与 remote-tools 的「缺省值字面量」口径一致，本插件自己实现一份小集合，**不 import 该插件任何东西**）⇒ 判为**远端调用**。
2. **远端调用一律零注入**：命中远端判据后在 handler 入口就返回 `undefined`（透传原结果），**不看 `path`、不做锚点解析、不碰本地文件系统**。理由：远端与本地路径不可区分，宁可不注入，也绝不把本机约定喂给远端结果。
3. **本地路径行为逐字不变**：`remote` 字段缺失 / 空串 / 纯空白 / 缺省值字面量 ⇒ 完全走现有本地路径解析与注入（静默、无告警、无额外日志）。**remote-tools 未安装时本来就没有该字段** ⇒ 行为与今天逐字一致。
4. **一次提示（会话内一次）**：首次远端触碰时，在该次工具结果末尾追加**一行**提示（不含远端内容、不发起任何远端读取），告知模型远端目录约定不会自动注入、需要时可自行 `read remote=<host> path=<远端目录>/AGENTS.md`。文案为静态模板（不插值模型输入），长度有上限；同一会话只加一次；`session_start` / `session_compact` 重置该标志。
5. **文档四同步**：`docs/extensions/dir-context.md`（不变量 + 坑 + `last verified`）、`docs/specs/dir-context.md`（实现决策 + 测试决策 + 范围外）、`docs/adr/0011`（补一条边界说明）、根 README 的 dir-context 小节、插件 README；另在 `docs/extensions/remote-tools.md` 交叉引用一句（远端路径不注入本地上下文）；`CONTEXT.md` 补术语（远端调用）；`docs/INDEX.md` 路由行同步。

**明确不做什么**

- **不依赖 remote-tools**：不 import 它的任何模块（含 `HOST_PATH_MARKER` / `resolveToolPath` / `createSessionCache` 等内部面），不读它的配置文件，不发 `remote-tools` 命名空间的任何东西；判据只有「工具入参里有没有这个字段」这一条。两个插件可各自独立安装/升级。
- **不自己 ssh、不做远端读取**：本扩展不发起任何网络或进程调用；远端上下文的内容一字节都不取。
- **不做「remote-tools 侧随行注入」**（会话里评估过的选项 1：在远端分支顺带 `cat` 祖先链 AGENTS.md）——留待真机案例驱动（现在只有 1 个案例，且那会造出第二套去重/预算实现）。
- 不改 `grep` / `find` 的既有口径（本就不在触发面）；不改去重键、预算、排序、状态条契约；不改顶层与 codemode 两条既有路径的任何语义。

## 验收标准

1. **错注入消失（核心）**：`read` / `write` / `edit` / `ls` / `bash` 任一工具带**非空** `remote` 且 `path` 为**相对路径**（如 `docs/x.md`，本地恰好存在 `docs/AGENTS.md`）⇒ 结果里**没有** `Loaded docs/AGENTS.md`（修复前必红，本会话已用真实函数复现该注入）。
2. **远端绝对路径同样零注入**：`path="/srv/app/docs/x.md"` + `remote` ⇒ 零注入（与今天一致，锁住不回归）。
3. **本地调用逐字不变**：无 `remote` 字段 / `remote: ""` / `remote: "   "` / `remote: "null"` / `remote: "None"`（大小写与 trim 变体）⇒ 本地路径照常注入，一条 `Loaded` 都不少。
4. **零耦合可证**：把 remote-tools 目录从扩展集里移开（极端情况：完全没装）时，本插件行为不变（用例用不带 `remote` 字段的事件即可表达；另有人工核验：源码中不出现远程插件模块名/路径）。
5. **提示一次**：同一会话内多次远端触碰 ⇒ 只有第一次的结果里出现那行提示；`session_compact` / `session_start` 之后可再提示一次；提示文本不含任何模型输入插值（静态模板）。
6. **不碰原结果**：命中远端判据时返回 `undefined`（宿主透传），原文与 `structuredContent` / `details` 一律不动；提示加入时也只追加一个 text block，原有内容逐字保留。
7. **测试**：纯逻辑单测（远端判据各变体、缺省值字面量口径）+ 真实 `ExtensionRunner` 宿主事件路径用例（远端相对路径零注入 / 远端绝对路径零注入 / 本地逐字不变 / 提示一次 / compact 后可再提示）。
8. `npm test` + `npm run typecheck` 全绿；全仓 `test:all` 套件全绿（已知并发负载抖动除外）。
9. **跨厂商独立评审**（红线 11）：reviewer 与开发者不同模型家族，逐条处理直到某轮无新意见。
10. **真机验收**：临时 agent 目录 + 真实 `pi`——（a）本地调用注入照旧；（b）带 `remote` 的相对路径调用**不**出现本地 `Loaded` 且出现那行提示（无需真实远端主机也能验：扩展只读入参字段、不发远端调用；若手边有可连主机，再补一次真实远端 read 的对照）。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-11（UTC）· **方式**：对话内指示「登记；同时需要确保不依赖 remote 插件，如果函数不支持参数 remote 也需要静默到本地」
- **用户明确的两条硬约束（已落进范围 1/3 与「不做什么」）**：
  1. **不依赖 remote-tools 插件** —— 判据只用「工具入参里有没有 `remote` 字段」，不 import 该插件任何模块，不共享代码；两插件各自独立安装/升级。
  2. **工具不支持 `remote` 参数时静默走本地** —— 字段缺失（含未装 remote-tools 的情形）、空串、纯空白一律视为本地调用，按现有路径解析与注入，**静默、无告警、无额外输出**。
- **其余默认值（agent 按仓库既有口径拟定，待用户确认）**：
  1. **缺省值字面量视作「未提供」**：`remote` 为 `"null"` / `"undefined"` / `"nil"` / `"none"` / `"n/a"` / `"na"`（trim、大小写无关）时按本地处理——与 remote-tools 同口径；本插件自带一份小集合，不跨插件引用。
  2. **提示形态 = 追加一行到工具结果（会话内一次）**，不额外发 UI 通知、不落状态条；文案静态模板、不插值模型输入。
  3. **远端判据覆盖全部触发工具**（`read` / `write` / `edit` / `ls` / `bash`），任何带非空 `remote` 的调用一视同仁。
- **已知风险（显式接受）**：① 远端同一目录的 `AGENTS.md` 不会被自动注入——模型需按提示自行 `read`（多一次往返，但决定权在模型）；② 判据是字段级启发式：第三方扩展若恰好也用 `remote` 表示别的意思，会被判为远端而**少注入**（安全方向）；③ 缺省值字面量集合与 remote-tools 若未来漂移，方向仍是「少注入」（不误注入）。
