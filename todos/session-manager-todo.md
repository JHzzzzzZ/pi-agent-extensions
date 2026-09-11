# session-manager TODO

- [ ] 制作一个 agent 会话管理器：管理 Pi 落盘会话（`~/.pi/agent/sessions/`，按工作目录组织）的浏览 / 检索 / 接续 / 整理能力（来源：用户 2026-09-12 提出）（processing @ feat/session-manager-list）
  - 能力（拟定）：list 列出会话（工作目录 / 时间 / 模型 / 大小）、search 全文检索历史会话、preview 查看摘要与元数据、resume / fork 接续或分支（对齐宿主 `pi --resume` / `--session <id>` / `--fork <id>`，见宿主 docs/usage.md）、rename / tag、清理与归档（删除前 dry-run + 确认）
  - 已知事实（宿主）：会话自动落盘 `~/.pi/agent/sessions/`，按工作目录组织；宿主已有 `/resume`、`/import`、`--session`、`--fork`、`--session-dir`；不做「第二个主界面」（单进程单 TuiMainScreen，见 `todos/agent-team-todo.md` 路径 2 结论）
  - 边界：默认只读扫描；写操作（重命名 / 删除 / 归档）仅限用户确认后作用于会话数据目录，不迁移不改写宿主会话格式；零 npm 依赖、零构建
  - 验收要点：真实会话目录上 list / search 结果可核对；接续 / 分支交接给宿主能力而非自实现；删除类操作默认 dry-run + 确认；有测试覆盖；目录名与 todo 文件名统一为 `session-manager`
  - 进展 2026-09-11（增量 1 · 只读浏览/检索）：`session-manager/` 扩展落地——`core.ts`（解析/列表/检索/预览/格式化，零依赖 + `SessionFsDeps` 注入缝）+ `index.ts`（`session` 工具 list/search/preview + `/session-manager` 与 `:list|:search|:preview` 冒号命令）+ 10 个测试；真实会话目录实测 173 个会话/100MB ≈ 0.6s，preview 输出 `pi --session/--fork <id>` 交接宿主。剩余验收面：重命名 / 标签 / 清理归档（写操作，默认 dry-run + 确认）。
- [ ] 形态纠正：从 Pi 扩展注销并重构为独立前端 agent 管理工具（用户 2026-09-11 实测反馈：「我要的不是 extension，而是带前端页面的窗口管理工具；当前仅支持 pi 会话管理；要独立于 agent 运行、agent 不感知」）——① 改名 `agent-manager/`：独立 Node 进程 + 浏览器前端页面（零依赖零构建，启动本地 HTTP 服务并自动开页），pi 未运行也能启动与浏览会话；② 能力 = 会话管理（list/search/preview + 重命名/可恢复删除）+ agent 进程管理（启动/接续/分支/运行状态/停止，经 `pi` CLI 子进程，工具不 import 宿主 SDK）；③ 根 `package.json` `pi.extensions` 注销（14→13）、删 `session-manager/package.json` 的 `pi` 清单与 `index.ts` 扩展接线、不注册任何 pi 扩展点（agent 完全不可见）；④ 随动面：`tools/install-smoke.mjs` 期望表 13/13、README/AGENTS/docs 卡（移出 `docs/extensions/`）/`docs/INDEX.md`、本文件改名 `todos/agent-manager-todo.md`。派单 any-dev（独立 worktree）。（processing @ any-dev（团队独立 worktree，开工时补实际分支 ）
