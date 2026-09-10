# solo-mode-todo

- [ ] 提供一个开关或快捷键激活 pi agent 的 solo 模式（processing）
  - 需求描述：一个独立的卫星扩展，让用户能一键切换/激活"solo 模式"，形态为命令开关（如 `/solo`）与快捷键（`pi.registerShortcut`）二者至少其一。
  - 待澄清：solo 模式的确切语义待定义——候选方向：a) 禁用委派（屏蔽 subagent/团队派单类工具，强制主 agent 自己干完）；b) 单 agent 精简运行（挂起非必要扩展/widget，降低干扰与开销）。确认后再细化验收标准。
  - 实现注意：与其它卫星扩展形态一致（目录 + `index.ts` 入口，复制进 `extensions/` 后 `/reload` 生效）；快捷键进 `keybindings` 注册表约定；TUI 写入前 `ctx.hasUI` 守卫；新增插件需在同一变更内同步 docs/ 卡片、README、根 package.json 与本 todo 文件。
