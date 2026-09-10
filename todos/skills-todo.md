# TODO（用户级 · skills/ 全局技能）

> 非插件条目：`~/.pi/agent/skills/` 下的全局技能，不对应任何 `pi.extensions` 插件，单独建档。

- [x] 新建 `todo-triage` 开工盘点 skill：开工时扫描 `todos/*-todo.md` 与 git worktree，把待办判为进行中/未领取/待决策/被阻塞/搁置，核对 worktree↔todo 映射（合并遗留、孤儿目录、无工作台的 processing），输出推荐领取优先级与下一步动作。（完成 2026-09-11 @ `~/.pi/agent/skills/todo-triage/`：`SKILL.md` + `scripts/survey.sh` 只读事实收集器——5 步门（收集→归类→worktree 健康度→排序报告→领取动作）+ 完成标准；实测覆盖 16 个 todo 文件/25 条 pending/全部 worktree 状态与孤儿目录，含从 worktree 内调用自动切回主工作区、非仓库根报错路径）
- [x] 新建 `wrap-up` 开发任务收尾 skill：任务结束时触发（用户调用或 agent 自主触发），核对测试完备（单测/集成/typecheck 全绿）+ 文档同步（README/AGENTS/package.json/todos/docs），有缺口就地补齐，最后产出简短收尾报告（改动摘要 + 验收方式 + 功能用法）。
