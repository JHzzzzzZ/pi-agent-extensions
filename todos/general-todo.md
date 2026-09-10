# TODO（通用领域 · 跨插件）

> 非插件条目：不属于任何现有或规划插件的通用功能、工作流改进，以及涉及多个插件的需求统一登记在此；由 `todo-add` skill 路由写入。技能类需求见 `skills-todo.md`，文档知识库类见 `docs-todo.md`。

- [x] 全新安装加载冒烟工具（GOAL.md §2「别人这把」：外部用户从零装到跑通）：把根 `pi.extensions` 清单里的全部扩展复制到全新临时 `PI_CODING_AGENT_DIR`（不碰用户真实配置），拉起真实 `pi --mode rpc` 进程，核对每个扩展的命令注册与启动期 widget/status 写入；失败时保留临时目录并打印问题清单。（完成 2026-09-11 @ feat/install-smoke：`tools/install-smoke.mjs`（纯校验函数导出 + CLI）+ `test/install-smoke.test.ts` 8 个单测；端到端实测 12/12 扩展、50 条命令、9 个 TUI 键全部来自本次临时安装目录；README「安装自检」节 + AGENTS 开发命令 + 根 `smoke`/`test:smoke` npm 脚本）
