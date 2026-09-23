# skills-todo#14 在本机安装 TypeSafe 官方 agent skill（typesafe-ai）

## 意图

Jev 接入选点（goal#8 / agent-team#71·#72 / jev-safe-gate#1）的设计需要 TypeSafe 官方文档，
靠会话内现查网页摩擦大。上游提供官方 agent skill（`github.com/typesafe-ai/skills`，MIT，
1831 stars），装到全局 skills 目录后 Pi 会话可按需加载。skills#12/#13 已在另一检出完成安装，
但本机 `~/.agents/skills/` **不存在**（2026-09-23 实测），本机会话读不到，故补装。

## 范围

**做什么**

1. 装到全局 `~/.agents/skills/typesafe-ai/`（#13 已人工确认的落点；Pi 文档明确
   `~/.agents/skills/` 下分组目录里的 `.md` 会作为 skill 被发现）。
2. 三文件：上游 `SKILL.md` 与 `LICENSE` **逐字节保真**（LF，不转 CRLF）+ 本仓写的
   `SOURCE.md` 溯源卡（仓库/版本/commit/取用日期/校验值/回滚命令）。
3. 装完校验收校验值确实等于上游 v0.5.7。

**明确不做什么**

- 不在仓库内留副本（#13 Q3 定稿口径）。
- 不改上游文件内容（要改就改本仓的 SOURCE.md 或另开条目）。
- 不动宿主/其它全局目录（符合 AGENTS 红线 8 的仓库边界；本次是用户明确要求的一次性
  仓库外写入，路径与回滚随交付报告登记）。

## 验收标准

1. `~/.agents/skills/typesafe-ai/SKILL.md` 存在，`sha256` = `71ea90d7…`、10040 字节，
   与上游 `main` / tag `v0.5.7`（commit `65a39f39`）逐字节一致。
2. `LICENSE` 1068 字节、`sha256` = `835f233f…`，与上游一致；`SOURCE.md` 写明来源与回滚。
3. SKILL.md frontmatter 有 `name` + 非空 `description`（Pi 发现条件）。
4. 回滚一条命令可完整撤销：`rm -rf ~/.agents/skills/typesafe-ai`。

## 人工确认

- 确认人：用户（仓库所有者）
- 日期：2026-09-23
- 方式：会话内用户指示「typesafe 有一个 skill，你上网找一下看能不能安装一下」+ 落点/版本/保真口径
  沿用 #13 已确认的三条对齐结论（全局路径、原样保真 + SOURCE.md、不留仓库副本）。
