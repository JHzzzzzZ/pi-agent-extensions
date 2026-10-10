# 对齐：remote-tools-todo#6 — 缺省值字面量当「未提供」（不猜内容）

- 条目：`remote-tools-todo#6`（tags: `bug`, `param-robustness`，priority 7）· 分支引用：`fix/remote-tools-absence-literals`
- 日期：2026-10-10（UTC）· 参与：用户（实测报告 + 口径选择）+ agent（实现与验证）

## 意图

用户实测：某个 agent 给 `remote` 传了**字符串 `"null"`**（把 JSON 的 `null` 序列化成了字符串），
工具把它当成主机名去 `ssh null` ⇒ `SSH_CONNECT_FAILED`（又慢又难查）。用户提问「要不要 fallback」，
并在三个口径中选定 **① 只容忍缺省值字面量**（会话内回答「1」）。

判据一句话：**「这是缺省值字面量」→ 容忍；「这是内容」→ 不猜。** 容忍的词恰好都是不可能当主机名的
（真把机器命名成 `nil`/`none` 属病态命名，文档写明不支持）；自由字符串（`"local"`、`"false"`、任意拼写）
保持当主机名/路径，连不上就响亮报错——**绝不静默把远端写落到本机**。

## 范围

**做什么**

1. 新增判定 `isAbsenceLiteral(value)`：`null` / `undefined` / `nil` / `none` / `n/a` / `na`，
   大小写无关、`trim()` 后比较（词表是唯一单源，`ABSENCE_LITERALS`）。
2. `parseTarget`：`remote` 为空串或命中缺省值字面量 ⇒ **本地模式**（`target: null`），不尝试 ssh。
3. 路径参数（`path` / `remoteCwd`）命中缺省值字面量 ⇒ **视为未提供**（`remoteCwd` 落远端 `$HOME`、
   `path` 落远端基准目录）——避免现在会发生的 `$HOME/null` 这种静默走错目录。
4. 文档：卡片不变量 + README 参数表写明该口径与「机器名不能叫这些」的限制。
5. 回归测试：`remote: "null"` 必须走本机且**零 ssh**（用户现场）；自由字符串仍当主机名；
   `"./null"` 这种「真的叫 null 的文件」写法仍当路径。

**不做什么**

- 不做更宽的 fallback（任意非法值当本机）——那会静默跑错机器；
- 不把 `"local"` / `"false"` / `"true"` / `"-"` 纳入词表（`local` 是常见 `~/.ssh/config` 别名，
  `-` 已被参数注入防护拦下）；
- 不动传输、ops、路径空间换算（`toHostPath`/`toRemotePath`）与 `remotePort` 的既有口径。

## 验收标准

1. `parseTarget({remote: "null"|"NULL"|" None "|"undefined"|"nil"|"n/a"})` ⇒ `target: null`（本地）。
2. `parseTarget({remote: "local"|"false"|"myhost"})` ⇒ 照旧解析成主机（非空 target）。
3. `resolveRemoteSearchPath("null", "/home/deploy")` ⇒ `/home/deploy`；`"./null"` ⇒ `/home/deploy/null`。
4. 工具层回归：`read` 带 `remote: "null"` 与不带 `remote` **输出逐字一致且零 ssh**；`bash` 带
   `remoteCwd: "null"` 的 ssh 命令里 cwd = 远端 `$HOME`。
5. 单元全绿 + `typecheck` 零错误；真机用例 6/6 不回归。
6. 跨厂商评审一轮无新意见（红线 11）。

## 人工确认

- **确认人**：用户（本会话）·**日期**：2026-10-10（UTC）·**方式**：选择题回答「1」
  （三个口径：① 只容忍缺省值字面量 ② 不 fallback 只报错 ③ 更宽的 fallback；用户选 ①，即本文件范围）。
- **意图来源**：用户实测报告原文——「我给 remote 传的是字符串 "null"，工具当成主机名去 ssh 连 null 了。
  传空/省略才是"本机"…… 我发现有些 agent 会传入字符串？这个需要 fallback 吗？」
- **开工放行**：以该选择为准（红线 2 的两段式 claim 已按此推进）。
