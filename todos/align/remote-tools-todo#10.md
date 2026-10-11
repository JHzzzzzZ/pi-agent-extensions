# 对齐：remote-tools-todo#10 — ls/find 的远端错误要结构化且不泄露宿主标记路径

- 条目：`remote-tools-todo#10`（tags: `bugfix`）· 分支引用：`fix/shell-tool-composition`
- 日期：2026-10-10（UTC）· 参与：用户（实测报障）+ agent（根因定位）
- 状态：无分叉，登记后直接实现；与 #9/#11 同一 worktree

## 意图

用户实测：`ls(path="/nope-here", remote=...)` 报 `Path not found: C:\…\remote-tools\index.ts\pi-remote\nope-here`；`ls` 传文件报 `Not a directory: …`；`find` 同款。两个问题：① 错误不是本插件的结构化错误码（read/grep 分支都有 `REMOTE_NOT_FOUND` 等）；② 消息里把**宿主标记路径**回灌给模型（内部实现细节泄露，且违反「消息全静态模板、不插值路径」的不变量）。根因已核：宿主 `ls.js:44/50`、`find.js:71` 在 `ops.exists()` 为假 / `ops.stat()` 非目录时用自己的模板抛错，模板插值的正是我们传进去的宿主形态路径。

## 范围

**做什么**

1. 远端 ls/find 在进入宿主校验**之前**做一次 fail-closed 目录探针（`exists` → 不存在报 `REMOTE_NOT_FOUND`；存在但不是目录报新码 `REMOTE_NOT_DIRECTORY`），并把探针结果缓存进同一个 ops 实例 ⇒ 宿主随后调用的 `exists`/`stat` 变缓存命中，**不增加 ssh 往返**（ls 从 3 次降到 2 次）。
2. 新错误码 `REMOTE_NOT_DIRECTORY` 进 `errors.ts`（as const + 静态消息），并同步 `docs/cross/result-unions.md`（12 个）。
3. `exists`/`stat` 的公开语义**保持不变**（exists 仍返回布尔：`ls.exists` 是测试与调用方的探针），探针是新增的独立方法（如 `probeDirectory`），不偷偷改变已有接口语义。
4. 测试：ls/find 在「不存在」与「传文件」两种情形下的错误码断言（不许出现宿主标记路径 / 不许出现 `Path not found` 字样）；缓存生效的往返计数断言（探针 1 次 + readdir/glob 1 次）；真机用例补一条（读真目录/真文件）。

**明确不做什么**

- 不改宿主 dist（红线 8）；不重写 ls/find 的整份 execute（保真主线）。
- 不为其它工具（read/write/edit/bash/grep）添加同款探针——它们的错误路径已经是结构化的（评审已核）。
- 不新增用户可见参数。

## 验收标准

1. `ls`/`find` 传不存在的远端路径 ⇒ `REMOTE_NOT_FOUND`；传文件 ⇒ `REMOTE_NOT_DIRECTORY`；消息为静态模板，**不含任何路径**（断言消息里没有 `pi-remote` 与盘符）。
2. 往返数不增：ls = 2 次 ssh（探针 + readdir），find = 2 次（探针 + glob）。断言用假 exec 计数。
3. 真机用例保持绿（含新增的「传目录/传文件」断言）；`exists`/`stat` 语义回归测试不破。
4. 单测 + typecheck 全绿；文档（卡片文件地图/不变量、错误码横切契约、README）同步。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-10（UTC）· **方式**：用户实测报障并列为「问题 2（一致性）」，要求与 read/grep 一致的结构化错误码
- **逐条决策**：
  1. 目标 = 结构化错误码 + 不泄露宿主标记路径（用户原话：「这里把内部标记路径当错误文本回给模型了」）
  2. 归属 = remote-tools（`#10`），与 `#9`/`#11` 同一 worktree 交付
- **agent 决定、用户未反对的实现细节**：新增 `REMOTE_NOT_DIRECTORY`（而非复用 `REMOTE_NOT_READABLE`）；探针顺带缓存以**降低**往返数；`exists`/`stat` 的既有语义不动。
- **开工放行**：用户已给出实施指示，对齐文档落盘后进入 `processing`。
