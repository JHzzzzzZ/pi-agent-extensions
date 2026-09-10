# commands-colon-todo

- [ ] 命令面全量改为冒号命名空间式（未领取）
  - 需求（2026-09-11，用户提出）：把全仓所有"子命令式"命令（空格分词，如 `/team run`、`/loop list`）全部改成冒号形式，如 `/team:run`。
  - 与既有决策的关系：2026-09-10 的「命令风格统一」定的是**反方向**——冒号 → 子命令式，且"直接替换不留别名"（agent-team v1.9.0 / pwr v2.6.0 / opencode-bridge v1.6.0；loop 本就子命令式只同步文档口径）。本条目是方向反转，实现前需与用户确认：旧子命令写法是否留别名/过渡期、README/AGENTS/docs 各卡片"命令面统一为子命令式"的口径如何改写（那些表述将不再成立）。
  - 全量清单（现状 → 目标，括号内为待定项）：
    - **agent-team**：`/team run|status|stop|view|clear|doctor` → `/team:run`、`/team:status`、`/team:stop`、`/team:view`、`/team:clear`、`/team:doctor`；`/team <团队名> <任务>` 参数路由是否改为 `/team:run <name> <task>`（待定）。
    - **pwr**：`/workflow run|delete|model` → `/workflow:run|:delete|:model`；`/workflows list|view|open|pause|resume|stop|restart|save|saved|script|approve|help` → `/workflows:list` 等；生成入口 `/workflow <任务>`（无子命令）保持不变（待定）。
    - **opencode-bridge**：`/opencode-bridge sync [port]|restore`（无参=状态）→ `/opencode-bridge:sync`、`/opencode-bridge:restore`；状态面是无参保持还是 `/opencode-bridge:status`（待定）。
    - **loop**：`/loop list|pause <id>|resume <id>|delete <id>|clear` → `/loop:list`、`/loop:pause`、`/loop:resume`、`/loop:delete`、`/loop:clear`；无参 `/loop`（用法/当前任务）与循环创建参数（`/loop 5m <任务>`、`daily at 09:00 ...` 等）保持不变。
    - **goal**：`/goal clear` → `/goal:clear`；`/goal <完成条件>`（无子命令）保持不变。
    - **solo-mode**：`/solo on|off|status` → `/solo:on|:off|:status`；bare `/solo`（切换）去留（待定——冒号形式下 bare 切换语义与"一键切换"习惯冲突）。
    - **不涉及**：provider-quota（`/quota` 无子命令）、deep-init（flags 非子命令）、run-timer / stream-token-speed / human-notify / chatanywhere-provider（无命令）。
  - 已知坑：旧 agent-team 曾用动态 `team:<name>` 注册（v1.9.0 退役为 `/team <name> <task>`）；若本次恢复冒号面且保留参数路由，需定义**保留字与优先级**——团队名为 `run`/`view` 等时会与固定子命令 `/team:run` 撞名（动态注册按名冲突曾是退役动因之一）。
  - 待定：命令补全（`getArgumentCompletions`）在冒号形式下的形态；`/reload` 后动态命令注册的兼容；是否需要一次性全量交付还是按插件分步（用户要求"全量"，倾向于一次性，但各插件版本/文档/测试需同步）。
  - 完成要求（全量）：涉及插件代码 + 各插件测试（命令路由断言）+ 根 README / AGENTS.md 命令清单 + `docs/extensions/<插件>.md` + `docs/INDEX.md`（若摘要提及命令面）+ 本文件与各插件 todo 条目同步；实现前按仓库约定开独立 worktree，自测全绿后合回主干。
