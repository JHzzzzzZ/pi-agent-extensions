# deep-init TODO

- [x] deep-init 插件：复刻 oh-my-openagent init-deep，`/deep-init` 生成层级 AGENTS.md（28 测试全绿 + typecheck 零错误）
- [x] 根 README / AGENTS.md / package.json 同步 deep-init 注册与文档（根版本 2.6.0，插件 1.0.0）
- [x] todos/oh-my-opencode-init-todo.md 占位条目随 deep-init 落地关闭
- [x] Discovery 对齐原版：按规模并行派 subagent 探索并汇总（32 测试全绿 + typecheck 零错误）
- [x] 为目标仓库生成层级 AGENTS.md（update，最大深度 3）
- [x] 采纳 solo 审批门（跨插件，solo-mode 条目一部分）：`/solo` 开启时 `--create-new` 二次确认自动放行（`planDispatch` 透传 `soloActive`，notice 标注自动确认）。（完成 2026-09-11 @ 9e2c15d：`solo-gate.ts` + planDispatch/命令接线 + 测试，37 测试全绿）
