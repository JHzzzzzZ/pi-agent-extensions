# todo-cli TODO

- [ ] 制作一个 agentic 的 todo 管理 CLI（来源：用户需求 2026-09-12；默认形态：Pi 扩展 + CLI 式命令，读写本仓库 `todos/<插件名>-todo.md` 工作流文件）（processing @ feat/todo-cli-triage）
  - 能力：list 盘点（未领取/processing/阻塞）、add 登记（查重 + 路由到唯一落点）、claim 领取（标 processing）、complete 完成（改 `- [x]` 并去标注）、triage 只读扫描（活跃 worktree、processing 遗留、合并遗留）
  - agentic 含义：agent 经工具直接调用上述操作，取代当前 skill（todo-add / todo-triage）里的人工 grep + edit 步骤
  - 约束：只改仓库内 `todos/`；不自动 commit；登记不标 processing（领取动作显式触发）
  - 验收要点：在真实 `todos/` 上跑通全部命令且既有条目格式零破坏；有测试覆盖；插件短名与目录名统一为 `todo-cli`
  - 进展（2026-09-11 @ feat/todo-cli-tool，根 2.27.0）：核心落地为 `tools/todo.mjs`（先 CLI 工具、后插件封装）——可导出纯函数（parseTodoFile/summarize/findDuplicates/appendEntry/setProcessing/completeEntry/resolveTodoPath/lintTodos）+ 六个子命令（summary/list/add/claim/complete/lint）；跨文件归一化查重（exact/similar）、领取标注幂等、完成勾选并去 processing、路径穿越拒绝、CRLF 行尾保持；9 个单测（含 CRLF 与真实仓库副本上的写操作闭环）；仍缺：Pi 扩展形态（工具/命令注册）与 triage 的 worktree 扫描。
  - 进展（2026-09-11 @ feat/todo-cli-triage，根 2.28.0）：新增 `triage [--json]` 只读子命令——解析 `git worktree list --porcelain` 与 `git branch --merged <主干>`，把每个 worktree 判为 active/cleanup/merged-dirty/orphan/missing（含未提交改动与目录缺失检测，靠条目文本包含分支名做 worktree↔条目互映射），processing 条目按 `@ feat/...` 引用分为 有工作台/引用已消失/无分支引用，并透出 `.worktrees/` 孤儿目录；不写任何文件（测试断言 todos/ 零改动）；真实仓库实测：正确把 8 条 route A processing 归为无分支引用（人工确认）；新增 4 个单测（9→13）；`claim` 新增 `--branch feat/x` 选项，把分支引用写进处理标记（`（processing @ feat/x）`），使 worktree↔条目互映射不依赖人工注记纪律；仍缺：Pi 扩展形态（工具/命令注册）。
