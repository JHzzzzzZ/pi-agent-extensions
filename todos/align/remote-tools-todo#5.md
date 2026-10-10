# 对齐：remote-tools-todo#5 — 参数校验容忍采样器残留字段（本地调用零打断）

- 条目：`remote-tools-todo#5`（tags: `bug`, `regression`，priority 8）· 分支引用：`fix/remote-tools-port-robustness`
- 日期：2026-10-10（UTC）· 参与：用户（实测报告）+ agent（复现与定位）
- 关系：#1 交付后的回归修补（#1 已 done，按红线 1「已完成的条目另条登记」）

## 意图

用户在新会话实测报错：本地 `read`（不带任何远端意图）被 `INVALID_REMOTE_PORT` 打断。根因已复现：

- 覆盖 7 个内置工具时 spread 了宿主的 `constrainedSampling: {type:"json_schema", strict:"prefer"}`（保真需要）
  ⇒ **采样器会把可选字段一并填出**（数字填 `0`、字符串填空串），`remotePort: 0` 跟着每次调用进来；
- 当前 `parseTarget` 把「`remote` 为空 + 给了 `remotePort`」与「`remote` 非空 + `remotePort` 为 `0`/`null`」都判为
  `INVALID_REMOTE_PORT` ⇒ 本地调用与远端调用都可能直接失败（实测：`remotePort: 0` 报「必须是 1-65535 的整数」）。

意图：**没有远端意图的字段不得影响调用**——校验只拦真正说了话的错，不拦采样器噪声；同时不把用户真实的端口笔误吞掉。

## 范围

**做什么（只改参数判定，不动传输与路径语义）**

1. `remote` 非字符串（`null`/数字/对象）、空串、纯空白 ⇒ 一律本地模式（已如此，补测）。
2. `remotePort` 为 `undefined` / `null` / 非数字 / `NaN` / `<= 0` ⇒ **视为未提供**（远端用 ssh 默认端口或 `~/.ssh/config`）。
3. `remotePort` 为**正数但越界**（`>65535`、非整数）⇒ 仍报 `INVALID_REMOTE_PORT`，消息补一句「不指定端口请省略该参数」。
4. 本地模式（`remote` 为空）**完全忽略** `remotePort` / `remoteCwd`，绝不因它们报错。

**不做什么**

- 不改编码/路径换算（`paths.ts`）、不改 ops/传输语义、不动 `constrainedSampling`（那是保真面，改了会让本地分支与内置漂移）；
- 不新增参数、不做端口探测。

## 验收标准

1. `parseTarget({remote: undefined, remotePort: 0|null|22|"22"|NaN})` ⇒ 本地模式（`target: null`）。
2. `parseTarget({remote: "u@h", remotePort: 0|null|undefined})` ⇒ 远端 + 端口未指定。
3. `parseTarget({remote: "u@h", remotePort: 70000 | 22.5})` ⇒ `INVALID_REMOTE_PORT`（真错仍拦）。
4. 工具层回归：本地 `read`（带 `remotePort: 0` 垃圾字段）与不带时**输出逐字一致**，且零 ssh。
5. 真机回归：`remotePort: 0` 的远端调用照常工作（用 ssh 默认端口）。
6. 单元全绿 + `typecheck` 零错误；跨厂商评审一轮无新意见（红线 11）。

## 人工确认

- **确认来源**：用户在本会话实测报告（贴出 `INVALID_REMOTE_PORT: remotePort 必须是 1-65535 的整数。`），
  并要求「本地/远端调用不该因此失败」——本条目即该报告的落盘。
- **范围确认**：修复范围由 agent 依据报告直接确定（最小改动：判定表 + 回归测试），**未经用户逐条确认**
  （为尽快解封：用户当前会话的自定义工具已被该回归打断）。若用户认为范围不对，回一句即可 `reopen` 本条重来。
- **确认人/日期**：用户（待补一句确认）· 2026-10-10（UTC）
