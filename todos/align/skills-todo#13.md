# skills-todo#13 安装 TypeSafe 官方 agent skill（typesafe-ai）到全局

## 意图

本会话调研 Jev（TypeSafe System One 模型）接入点时，反复现查 `docs.typesafe.ai`：三个原语（Choice/Score/Noul）语义、提问设计约束、confidence 与 probabilities 的区别，每次都靠 web 抓取。上游已发布官方 agent skill（`github.com/typesafe-ai/skills`，MIT，v0.5.7），把这套指导固化成按需加载的 skill，让后续任何 Pi 会话（含子 agent）在涉及 Jev 接入时直接拿到设计约束，省掉重复调研。

关键事实（已核，2026-09-22 本会话实测）：

- 上游仓库仅含 `skills/typesafe-ai/SKILL.md`（149 行 / 10189 字节）+ `LICENSE`；官网文档声称的 "reference files" **并不存在**（文档与仓库不同步）。
- SKILL.md 是**指路型**：不嵌 API 契约，明确要求读 live docs（`docs.typesafe.ai/llms.txt` 索引 + 任意页加 `.md`）。
- frontmatter 只有 `name` / `license` / `description`，**无 Claude Code 专属内容**，无需裁剪即跨 harness 可用。
- 落点由用户改定为**全局 `~/.agents/skills/`**。Pi 文档 `docs/skills.md` 列明两条全局路径（`~/.pi/agent/skills/` 与 `~/.agents/skills/`）；目录含 `SKILL.md` 者在所有 skill 位置递归发现，且 `~/.agents/skills/` 的**根级 `.md` 被忽略**——必须是目录形态。
- frontmatter 合规实测（Pi 自带 yaml 库解析）：`name: typesafe-ai`（11 字符、小写连字符）、`description` 661 字符（上限 1024）、`license: MIT`，无未知字段。

### 本条目的来历（前身 skills#12）

前身 `skills-todo#12` 已在 `processing` 上完成安装，但撞上**既有 globalId 缺陷**：它取到 316，与 `timeout-bg-todo#1` 重复。核实为**预先存在**（316 与 317 均已在 HEAD 提交：`a3dc026` / `5f10d2f`，而本仓 gitignore 的 `todos/.todo-cli/next-id` 在本次 `add` 前停在 316）。

根因：计数器 gitignore、按检出各存一份，自愈只按**本地台账**算 `maxExistingId+1`；兄弟 worktree（`.worktrees/agent-team-70-real`）按旧快照自愈到 316 并取走 316/317，主仓计数器不知情，于是两边"下一个待发号"都是 316。

按用户选定的**路径 A（纯 CLI）**修复：删 `todos/.todo-cli/next-id` 走文档载明的自愈通道 → `reopen` #12 → `complete` #12 作废 → 本条 `add` 自愈取号 **globalId 318**（计数器推进到 319，实测确认）。#12 保留为 done 空壳（entries append-only，不可删）。

## 范围

**做什么**

1. 在 `~/.agents/skills/typesafe-ai/`（**仓库外**，红线 8 逐次批准已取得：用户「落到全局」「放到 ~/.agents/skills 里面」）落三份文件：
   - `SKILL.md` —— 上游原文**逐字节复制**（sha256 `0ab58b7533ebe4ba5342ad6260d69e492cd0955ca9d3ee20b3c91375eea0203d`）
   - `LICENSE` —— 上游 MIT 原文（保留署名，合规要求）
   - `SOURCE.md` —— 溯源卡：上游仓库 / 版本 v0.5.7 / commit `65a39f39` / 取用日期 / sha256 / 更新方式 / 回滚方式 / 边界
2. 溯源卡记 sha256 与更新方式，理由：skill 自身警告 *"A stale skill can cause the agent to invent request or response fields"*——没有哈希无法判断手上这份是否过期。
3. 仓库内以本条目 notes 登记「已安装到仓库外」的事实（路径 / 文件清单 / 回滚方式）。

**不做什么**

- **不改写上游 SKILL.md 一个字**（不加 Pi 专属说明、不删段落、不调格式）——保持逐字节可 diff。
- **不写 `~/.pi/agent/skills/`**（另一条全局路径，本次只落用户指定的 `~/.agents/skills/`）。
- **不在仓库内保留副本**（用户未选 B 方案）：故该 skill 不受版本控制、不可跨机复现，是已知代价，记入 notes。
- **不在仓库 README/INDEX 里把该 skill 声明为仓库资产**——它在仓库外，声明会造成「本仓已有」的错误预期（红线 8 不得把仓库外状态当契约）。
- **不实现 Jev 接入本身**（`goal` 评估器 / `human-notify` 降噪 / `todo` 打分 / `agent-team` 派单四条候选）——另行登记。
- **不修底层计数器缺陷**（自愈按本地台账、跨检出撞号）——另行登记到 `todo-cli-todo`。

## 验收标准

1. **文件就位且保真**：`~/.agents/skills/typesafe-ai/SKILL.md` 的 sha256 等于 `0ab58b7533ebe4ba5342ad6260d69e492cd0955ca9d3ee20b3c91375eea0203d`（已实测比对通过）；`LICENSE` 与上游逐字节一致（已实测）。
2. **frontmatter 可被 Pi 加载**：`name: typesafe-ai` 合规 + `description` 661 字符（≤1024）、无未知字段（已用 Pi 自带 `yaml` 库解析通过）。
3. **发现路径正确**：目录位于 `~/.agents/skills/typesafe-ai/`（全局路径、目录形态含 `SKILL.md`），符合 Pi 递归发现规则；**不可平铺成根级 `.md`**。
4. **溯源卡自洽**：`SOURCE.md` 记录的版本 / commit / 日期 / 哈希与 `SKILL.md` 实测一致；含更新方式与回滚命令。
5. **条目号唯一**：本条目 `globalId` 为 318，全台账无重复；计数器推进到 319（已实测）。
6. **仓库内零改动**：`git status` 除 `todos/` 外无新增/修改文件（skill 不进仓库）。
7. **残留已如实登记**：`skills-todo#12` 与 `timeout-bg-todo#1` 的 globalId 316 重复**无法用 CLI 清除**（globalId 永不回收、无 renumber 子命令、`migrate global-id` 遇重复即中止），本条 `complete --note` 如实记录该残留与所需的手工仲裁动作。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-22
- 方式：本轮 4 问——
  - Q1 落点：首答「落到全局！」（否决我提议的项目级 `.agents/skills/`），追加指定「放到 `~/.agents/skills` 里面」——**全局 `~/.agents/skills/`**，用户明确指定路径。
  - Q2 保真与溯源：「同意」——上游 `SKILL.md` 逐字节复制 + 独立 `SOURCE.md` 记哈希。
  - Q3 是否在仓库留副本（A/B 二选一）：用户未选，按 **A（只装全局，仓库不留副本）** 执行，代价已在「不做什么」显式登记。
  - Q4 撞号修复路径：用户选 **A（纯 CLI）**——删计数器走自愈 → `reopen` + `complete` 作废 #12 → 重登记取 318。**实测结论：A 能修计数器与后续取号，但清不掉已存在的 316 重复**（见验收标准 7），该残留需另行手工仲裁。
- 红线 8 四件套（仓库外写入）已按要求先报后动：文件 = `~/.agents/skills/typesafe-ai/{SKILL.md,LICENSE,SOURCE.md}`；风险 = 全局可见 / 无版本控制 / 新建目录不覆盖既有文件；回滚 = `rm -rf ~/.agents/skills/typesafe-ai`（`skills/` 目录本身为本机新建，可一并删）。
