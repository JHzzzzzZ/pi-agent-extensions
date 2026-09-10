# todo-cli TODO

- [ ] 制作一个 agentic 的 todo 管理 CLI（来源：用户需求 2026-09-12；默认形态：Pi 扩展 + CLI 式命令，读写本仓库 `todos/<插件名>-todo.md` 工作流文件）
  - 能力：list 盘点（未领取/processing/阻塞）、add 登记（查重 + 路由到唯一落点）、claim 领取（标 processing）、complete 完成（改 `- [x]` 并去标注）、triage 只读扫描（活跃 worktree、processing 遗留、合并遗留）
  - agentic 含义：agent 经工具直接调用上述操作，取代当前 skill（todo-add / todo-triage）里的人工 grep + edit 步骤
  - 约束：只改仓库内 `todos/`；不自动 commit；登记不标 processing（领取动作显式触发）
  - 验收要点：在真实 `todos/` 上跑通全部命令且既有条目格式零破坏；有测试覆盖；插件短名与目录名统一为 `todo-cli`
