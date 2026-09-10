# TODO（通用领域 · 跨插件）

> 非插件条目：不属于任何现有或规划插件的通用功能、工作流改进，以及涉及多个插件的需求统一登记在此；由 `todo-add` skill 路由写入。技能类需求见 `skills-todo.md`，文档知识库类见 `docs-todo.md`。

- [x] 全新安装加载冒烟工具（GOAL.md §2「别人这把」：外部用户从零装到跑通）：把根 `pi.extensions` 清单里的全部扩展复制到全新临时 `PI_CODING_AGENT_DIR`（不碰用户真实配置），拉起真实 `pi --mode rpc` 进程，核对每个扩展的命令注册与启动期 widget/status 写入；失败时保留临时目录并打印问题清单。（完成 2026-09-11 @ feat/install-smoke：`tools/install-smoke.mjs`（纯校验函数导出 + CLI）+ `test/install-smoke.test.ts` 8 个单测；端到端实测 12/12 扩展、50 条命令、9 个 TUI 键全部来自本次临时安装目录；README「安装自检」节 + AGENTS 开发命令 + 根 `smoke`/`test:smoke` npm 脚本）
- [x] 全新安装深度冒烟（GOAL.md §2「别人这把」：从零装到跑通**核心流程**）：加载冒烟只证明扩展被注册，不证明工具真能被模型用起来。加 `--task` opt-in：同一临时安装目录内复制用户 `auth.json`（仅临时目录使用、结束即删、不打印内容），拉起 `pi --mode json -p --tools <工具>` 跑一次真实模型调用，以事件流 `tool_execution_start/end` 为判据（模型自由文本不算），默认被测工具 `loop_list`（只读、结果确定），模型默认取配置 `defaultProvider/defaultModel`、可 `--model` 覆盖；失败保留临时目录排查、成功自动清理。（完成 2026-09-11 @ feat/install-deep-smoke：`buildDeepArgs`/`parseJsonEvents`/`checkDeepRun`/`deepModelFromSettings` 纯函数 + 6 个新单测（共 14）；端到端实测 12/12 扩展 + 模型 `opencode-go/deepseek-flash` 调用全新安装的 `loop_list` 成功，全程 ~10s；README/AGENTS/incidents 同步）
