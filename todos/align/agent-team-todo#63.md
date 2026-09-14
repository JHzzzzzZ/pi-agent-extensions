# agent-team-todo#63 团队文件 description 含「: 」时解析失败（容忍裸冒号值 + 失败可见）

## 意图

团队 Markdown 的 frontmatter 里写 `description: 全栈开发: 小队`（裸标量含 `": "`），YAML 规范判定非法，宿主 `parseFrontmatter` 直接抛错——团队文件加载失败。用户视角是「我的团队不见了」。

**实测校正（本轮，2026-09-14）**：条目原文「静默从 /team:list 消失」在 HEAD 上**不成立**——用真实坏文件 + 临时 globalDir 直接调 `discoverTeams` 验证：`invalid[]` 非空，`/team:list`（`index.ts:1727`）、`team_list`（`manage.ts:220`）、`doctor`（`doctor.ts:140`）三处都已打 `⚠ <file> — <原因>`。真正**静默**的是 run 路径：`config.ts:352` 的 `findTeam` 只回 `team "x" not found (available: …)`，既不提「有文件坏了」，也不给修法。

其它已核实事实：引号值（`description: "全栈开发: 小队"`）、`|` 块标量、值内含引号**都能正常解析**；宿主的报错文本是原始 YAML 错误（`Nested mappings are not allowed in compact mappings at line 2, column 14` + 光标行），对用户不可操作。

## 范围

**做什么**

1. **容忍裸 `": "` 值**：解析失败时，只对「值里含 `": "`」的裸标量行做**加引号后重试一次**（`yamlScalar` 已有的转义口径复用）；重试仍失败则回落原错误。不做通用宽松解析器。
2. **失败文案可操作**：解析失败时在原因前追加修法提示（单行模板）：「第 N 行的值含 ": "，请加引号（`"…"`）或改用 `|` 块标量」。保留原始 YAML 错误作为细节。
3. **run 路径可见**：`findTeam` 的 `TEAM_NOT_FOUND` 文案追加「另有 N 个定义不可用：<file>（<原因首行>）」——覆盖 `team_run` 与 `team_resume` 两条入口。
4. **测试**（先红）：裸 `": "` 值（description 与成员级 description 各一）、引号值、`|` 块标量、CRLF 换行、值内含引号；解析失败文案的修法提示与行号；`TEAM_NOT_FOUND` 追加行。
5. **文档同步**：扩展 README + `docs/extensions/agent-team.md`（含 `last verified` 行）；若新增/调整错误码文案，同步错误码说明。

**不做什么**

- 不重写 frontmatter 解析器、不引入 YAML 依赖（`parseFrontmatter` 仍是唯一解析入口）。
- 不改 list/doctor 的既有展示（已可见，不重复造第二份事实）。
- 不自动改写用户的团队文件（容忍是「读时兼容」，不是「静默修复磁盘文件」）。
- 不做「多行块标量以外的宽松容错」（如 tab 缩进、重复键）——按需另立条目。

## 验收标准

1. 单测：含裸 `": "` 的 description / 成员 description 能正常加载为团队；引号、`|` 块标量、CRLF、值内含引号照旧可用（回归）。
2. 真失败场景（无法容忍的 YAML 错误）：错误信息含行号 + 修法提示；`/team:list`、`team_list`、`doctor` 展示不变（仍列文件 + 原因）。
3. `team_run` / `team_resume` 在目标团队文件坏掉时，`TEAM_NOT_FOUND` 文案含不可用文件与原因首行。
4. `npm test` 全绿 + `npm run typecheck` 零错误；根 README 测试数更新；文档同步完成。
5. 零回归：正常团队文件的加载/校验/错误码不变。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-14
- 方式：本轮 5 问「按建议走」——Q1 前提校正（把「静默消失」改为「run 路径不可见」，list/doctor 不重复做）、Q2 容忍 + 可操作报错二者都要、Q3 容忍边界只做裸 `": "` 一种、Q4 run/resume 的 `TEAM_NOT_FOUND` 追加不可用文件与原因、Q5 测试覆盖五类 + 文档同步。
