# TODO
- [x] 命令风格统一（跨插件）：连字符长命令 `/opencode-bridge-sync`、`/opencode-bridge-restore` 与统一基准（子命令式）不一致。跨插件需求，已在 agent-team-todo.md 同步登记。（完成 2026-09-10 @ merge a03e525：opencode-bridge v1.6.0 合并为单 `/opencode-bridge` + 子命令 `sync [port]`、`restore`，无参仍为状态；旧 `-sync`/`-restore` 不再注册；solo 审批门确认路径共存。114 测试 + typecheck 绿）
- [x] 采纳 solo 审批门（跨插件，solo-mode 条目一部分）：`/solo` 开启时 sync / 端口切换 / restore 确认自动批准，restore 自动选最新备份；文档不变量"绝不自动改 settings.json"补注 solo 例外。（完成 2026-09-11 @ 9e2c15d：`solo-gate.ts` + index.ts 三处接线 + 三条 solo 集成测试，113 测试全绿）
- [ ] 根 README 效果示意图：效果在网络链路上（代理转发），无可见 UI，暂搁置（如需可补 /opencode-bridge 状态输出示意）
- [x] 端口自定义待支持：目前桥监听端口靠 `PI_BRIDGE_PORT` 环境变量，希望支持不依赖环境变量的自定义方式（如 /opencode-bridge-sync 交互式询问端口并持久化，或扩展自身配置文件），修改后 httpProxy 写入值与探测端口需联动（v1.4.0：`/opencode-bridge-sync [port]` 跟参/交互询问 + `opencode-bridge.json` 持久化 + 指纹确认自动迁移，108 测试）
- [x] devDependencies 安全升级：@earendil-works/pi-coding-agent 等 ^0.83.0 → ^0.85.1，修复 undici/brace-expansion 高危漏洞
- [ ] 命令面改冒号形式（跨插件，全量任务一部分）：`/opencode-bridge sync [port]|restore` → `/opencode-bridge:sync|:restore`（无参状态面去留待定）。全量清单与待定项见 `todos/commands-colon-todo.md`。（processing）
