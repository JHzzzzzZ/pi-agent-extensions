# session-manager TODO

- [ ] 制作一个 agent 会话管理器：管理 Pi 落盘会话（`~/.pi/agent/sessions/`，按工作目录组织）的浏览 / 检索 / 接续 / 整理能力（来源：用户 2026-09-12 提出）（processing @ feat/session-manager-list）
  - 能力（拟定）：list 列出会话（工作目录 / 时间 / 模型 / 大小）、search 全文检索历史会话、preview 查看摘要与元数据、resume / fork 接续或分支（对齐宿主 `pi --resume` / `--session <id>` / `--fork <id>`，见宿主 docs/usage.md）、rename / tag、清理与归档（删除前 dry-run + 确认）
  - 已知事实（宿主）：会话自动落盘 `~/.pi/agent/sessions/`，按工作目录组织；宿主已有 `/resume`、`/import`、`--session`、`--fork`、`--session-dir`；不做「第二个主界面」（单进程单 TuiMainScreen，见 `todos/agent-team-todo.md` 路径 2 结论）
  - 边界：默认只读扫描；写操作（重命名 / 删除 / 归档）仅限用户确认后作用于会话数据目录，不迁移不改写宿主会话格式；零 npm 依赖、零构建
  - 验收要点：真实会话目录上 list / search 结果可核对；接续 / 分支交接给宿主能力而非自实现；删除类操作默认 dry-run + 确认；有测试覆盖；目录名与 todo 文件名统一为 `session-manager`
  - 进展 2026-09-11（增量 1 · 只读浏览/检索）：`session-manager/` 扩展落地——`core.ts`（解析/列表/检索/预览/格式化，零依赖 + `SessionFsDeps` 注入缝）+ `index.ts`（`session` 工具 list/search/preview + `/session-manager` 与 `:list|:search|:preview` 冒号命令）+ 10 个测试；真实会话目录实测 173 个会话/100MB ≈ 0.6s，preview 输出 `pi --session/--fork <id>` 交接宿主。剩余验收面：重命名 / 标签 / 清理归档（写操作，默认 dry-run + 确认）。
