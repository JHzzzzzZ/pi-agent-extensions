# skills-todo#12 安装 TypeSafe 官方 agent skill（typesafe-ai）

## 意图

本会话调研 Jev（TypeSafe System One 模型）接入点时，反复现查 `docs.typesafe.ai` 页面：三个原语（Choice/Score/Noul）的语义、提问设计约束、confidence 与 probabilities 的区别，每次都靠 web 抓取。上游已发布官方 agent skill（`github.com/typesafe-ai/skills`，MIT，v0.5.7），把这套指导固化成一个按需加载的 skill，能让后续任何 Pi 会话（含子 agent）在涉及 Jev 接入时直接拿到设计约束，省掉重复调研。

关键事实（已核，2026-09-22 本会话实测）：

- 上游仓库仅含 `skills/typesafe-ai/SKILL.md`（149 行 / 10189 字节）+ `LICENSE`；官网文档声称的 "reference files" **并不存在**（文档与仓库不同步）。
- SKILL.md 是**指路型**：不嵌 API 契约，明确要求读 live docs（`docs.typesafe.ai/llms.txt` 索引 + 任意页加 `.md`）。
- frontmatter 只有 `name` / `license` / `description`，**无 Claude Code 专属内容**，无需裁剪即跨 agent 可用（Pi 的 skills 规范只要求 `name` + `description` 非空，未知字段忽略）。
- 落点由用户本轮改定：**全局 `~/.agents/skills/`**（覆盖 ADR-0004「不做全局镜像」的默认，用户明确指定——该 ADR 的否决理由之一是「本机无该库」，本轮核实本机 `~/.agents/skills/` 同样不存在，需新建）。
- Pi 文档 `docs/skills.md` 列明的全局扫描路径有两条：`~/.pi/agent/skills/` 与 `~/.agents/skills/`；目录含 `SKILL.md` 者在所有 skill 位置递归发现（`~/.agents/skills/` 的**根级 `.md` 被忽略**，故必须是目录形态，不能平铺单个 md）。
- frontmatter 合规：`name: typesafe-ai`（11 字符、小写连字符、合规范）、`description` 661 字符（YAML 解析实测，上限 1024）、`license: MIT`（可选字段）——无需改写。

## 范围

**做什么**

1. 新建 `~/.agents/skills/typesafe-ai/`（**仓库外**，红线 8 逐次批准已取得：用户本轮「落到全局」「放到 ~/.agents/skills 里面」），落三份文件：
   - `SKILL.md` —— 上游原文**逐字节复制**（sha256 `0ab58b7533ebe4ba5342ad6260d69e492cd0955ca9d3ee20b3c91375eea0203d`）
   - `LICENSE` —— 上游 MIT 原文（保留署名，合规要求）
   - `SOURCE.md` —— 溯源卡：上游仓库 / 版本 v0.5.7 / commit `65a39f39` / 取用日期 / SKILL.md 的 sha256 / 更新方式
2. 溯源卡必须记录 sha256 与更新方式（重取上游 + 比对哈希），理由：skill 自身警告 "A stale skill can cause the agent to invent request or response fields"——没有哈希就无法判断手上这份是否过期。
3. 溯源可追溯：仓库内以 `todos/skills-todo.json` 条目的 notes 登记「安装到仓库外 `~/.agents/skills/typesafe-ai/`」的事实（文件清单 / 备份 / 回滚），**不在仓库 README/INDEX 里把该 skill 声明为仓库资产**（它在仓库外，声明会造成「本仓已有」的错误预期，违反红线 8 不得把仓库外状态当契约）。

**不做什么**

- **不改写上游 SKILL.md 一个字**（不加 Pi 专属说明、不删段落、不调格式）——保持逐字节可 diff，上游更新时直接覆盖 + 比哈希。
- **不写 `~/.pi/agent/skills/`**（另一条全局路径，本次只落用户指定的 `~/.agents/skills/`）。
- **不在仓库内保留副本**（用户未选 B 方案）：故该 skill 不受版本控制、不可跨机复现，这是本决定的已知代价，记入 notes。
- **不注册 `package.json` 的 `pi.skills`**（ADR-0004 否决项：不把仓库内资产提升成包级技能）。
- **不实现 Jev 接入本身**（`goal` 评估器 / `human-notify` 降噪 / `todo` 打分 / `agent-team` 派单四条候选）——那是本会话另外的待决策需求，另行登记。
- 不引入任何运行时依赖（skill 是纯 Markdown，无代码）。

## 验收标准

1. **文件就位且保真**：`~/.agents/skills/typesafe-ai/SKILL.md` 的 sha256 等于 `0ab58b7533ebe4ba5342ad6260d69e492cd0955ca9d3ee20b3c91375eea0203d`（`sha256sum` 实测比对）。
2. **frontmatter 可被 Pi 加载**：`name: typesafe-ai`（合规）+ `description` 661 字符（≤1024）——对照 `docs/skills.md` 的 frontmatter 契约核（已预核通过）。
3. **发现路径正确**：目录位于 `~/.agents/skills/typesafe-ai/`（全局路径、目录形态含 `SKILL.md`），符合 Pi 递归发现规则；**不可平铺成根级 `.md`**（该路径忽略根级 md）。
4. **溯源卡自洽**：`SOURCE.md` 记录的四项（版本 / commit / 日期 / sha256）与 `SKILL.md` 实测一致。
5. **零回归**：`node .agents/skills/todo-cli/todo-cli/todo.mjs lint` 通过（新 skill 在仓库外、不引入 `pi.extensions` 注册，不影响扩展↔todo 文件对应关系）。
6. **仓库内零改动**：`git status` 除 `todos/` 外无新增/修改文件（该 skill 不进仓库）；本条目 `complete --note` 收口，note 含安装路径与回滚方式。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-22
- 方式：本轮 3 问——
  - Q1 落点：首答「落到全局！」（否决我提议的项目级 `.agents/skills/`），追加指定「放到 `~/.agents/skills` 里面」——**全局 `~/.agents/skills/`**，用户明确指定路径。
  - Q2 保真与溯源：「同意」——上游 `SKILL.md` 逐字节复制 + 独立 `SOURCE.md` 记哈希。
  - Q3 是否在仓库留副本（A/B 二选一）：用户未选，按 **A（只装全局，仓库不留副本）** 执行，代价（不受版本控制 / 不可跨机复现）已在上文「不做什么」显式登记。
- 红线 8 四件套（仓库外写入）已按要求先报后动：文件 = `~/.agents/skills/typesafe-ai/{SKILL.md,LICENSE,SOURCE.md}`；风险 = 全局可见 / 无版本控制 / 新建目录不覆盖既有文件；回滚 = `rm -rf ~/.agents/skills/typesafe-ai`（`skills/` 目录本身为本机新建，可一并删）。
