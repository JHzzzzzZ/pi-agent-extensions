# 对齐：dir-context-todo#1 — 目录作用域上下文注入（嵌套 AGENTS.md on-demand）

- 条目：`dir-context-todo#1`（tags: `new-plugin`, `context-injection`）· 分支引用：`feat/dir-context-scoped-injection`
- 日期：2026-10-10（UTC）· 参与：用户（全部决策）+ agent（事实核查与方案）
- 状态：本轮会话逐条确认完毕，待用户放行进入 `processing`

## 意图

pi 原生只加载 **agent dir + cwd + cwd 的全部祖先链** 的上下文文件（`dist/core/resource-loader.js:167-191`，`loadProjectContextFiles` 一路 `dirname` 向上），**子树一概不读**。现实仓库是分层的：`src/AGENTS.md` 写应用代码约定、`src/components/AGENTS.md` 写组件约定，模型在不读文件的情况下永远拿不到它们。

本插件补上这一格：模型**碰到某个目录**（读/写/改该目录下的文件、ls 该目录、bash 单文件读）时，自动把**严格位于 cwd 之下**的祖先链上下文文件注入当次结果，语义对齐 Claude Code 的 on-demand nested CLAUDE.md —— 官方原文：*"Claude Code loads each one once Claude reads, writes, or edits another file in that subdirectory. Reading includes viewing the file with a Bash command that counts as a read, such as `cat` or `head` on a single file."*

已核实的事实（宿主 `@earendil-works/pi-coding-agent`，路径相对该包根）：

1. 原生加载范围：`loadProjectContextFiles()` 只走 agent dir + cwd + 逐级 `dirname` 向上，**无向下/子树分支** ⇒ 缺口真实存在。
2. 内置工具入参：`read` / `write` / `edit` / `ls` / `grep` / `find` 都用 `path`（`ls`/`grep`/`find` 的 `path` 可选）；`bash` 只有 `{command, timeout}`，**没有 cwd 参数**（`dist/core/tools/bash.js:29,135`）。
3. 扩展接缝：`pi.on("tool_result")` 可返回替换后的 `content`（多 handler 依次叠加，`dist/core/extensions/types.d.ts:1090`）；`pi.on("tool_call")` 可 mutate `event.input` 或 block。
4. pi 原生认的上下文文件名集合：`AGENTS.override.md` / `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD`（`docs/configuration.md`）；同目录 `AGENTS.override.md` 覆盖 `AGENTS.md`/`CLAUDE.md`。
5. 先行者：`pi-subdir-context`（npm v1.1.7）与 `pi-nested-agents-md`（GitHub）均已实现 read-only 版本，**都只钩 `read` 且 `event.toolName !== "read"` 直接 return**，均停在 cwd 边界内、按会话去重。本插件在其之上补 `write`/`edit`/`ls`/`bash 单文件读`。

## 范围

**做什么**

1. 新插件 `src/extensions/dir-context/`（`index.ts` 入口 + 就地测试 + `package.json`，零运行时依赖，不 import 宿主内部路径，只用公开 `ExtensionAPI`）。
2. 触发面（**Claude 对齐 + ls**）：
   - `read` / `write` / `edit`：入参 `path` 所在目录
   - `ls`：入参 `path`（缺省 = cwd）
   - `bash`：命令里**单个文件的读**（白名单：`cat` / `head` / `tail` / `less` / `sed -n` / `awk` 形式？见「测试决策」——v1 只认 `cat` / `head` / `tail` + 单个文件参数），提取出文件路径后取其所在目录
3. 发现规则：从锚点目录起**逐级向上直到 cwd**（含锚点目录，不含 cwd 本身——cwd 的上下文文件 pi 已加载），每级取**唯一一个**文件，优先级 `AGENTS.override.md` > `AGENTS.md` > `AGENTS.MD` > `CLAUDE.md` > `CLAUDE.MD`；结果按**由外向内**（祖先在前、最靠近锚点的最后）顺序注入。
4. 注入通道：`tool_result` handler 在 `content` **尾部追加一个 text block**，格式带明确来源标注（`<dir-context path="…">…</dir-context>` 包裹 + 一行 `Loaded <相对路径>` 抬头，供 transcript 肉眼核对）。
5. 去重与重注入：会话内每绝对路径只注入一次（`session_start` 新建、`session_compact` / `session_shutdown` 清空）——与 Claude 的「compact 后按需重载」语义一致。
6. 安全与预算护栏：realpath 包含校验（锚点必须在 cwd 之下；`repo` vs `repo-evil` 前缀误判必须不成立）；`isError` 的结果不注入；无 text content 的结果不注入；单文件 32 KiB / 单次注入 128 KiB 上限，UTF-8 码点安全截断；任何失败（读文件、realpath、handler 抛错）**只降级为不注入**，绝不破坏原工具结果。
7. TUI：一个状态键（本会话已注入文件数）+ `/dir-context:status` 列出已注入清单（走 `pi.registerCommand`，冒号子命令口径）；不写 widget（避开 `docs/cross/status-bar.md` 的 widget 排序带契约）。
8. 文档与登记：`docs/extensions/dir-context.md` 卡片 + `docs/INDEX.md` 登记 + 根 README（用法与实测测试数）+ 根 `package.json` 的 `pi.extensions` 注册 + `CONTEXT.md` 术语 + ADR（注入通道与会话去重决策）。

**明确不做什么**

- 不做 `.claude/rules/` 风格的 glob 路径作用域规则（Claude 的另一套机制，与本插件不同轴）。
- 不做 `@path/to/import` 语法展开（Claude 的导入特性；pi 原生也不支持）。
- 不做 cwd 之外的注入（不沿 git root 兜底，见 Q4）。
- 不做 `grep` / `find` 触发（递归搜索的 `path` 只能注入一层，是近似而非精确，见 Q2 选 C 被否）。
- 不读 `settings.json` 配置项（v1 无开关；要禁用一个不装即可）。
- 不复用 `pi-subdir-context` / `pi-nested-agents-md` 的代码（覆盖面不同，按本仓 TDD 模式自写；两者作为行为对照参考）。
- 不改宿主 `dist/`、不引入 npm 运行时依赖、不写 widget。

## 验收标准

1. **触发面全覆盖**：`read`/`write`/`edit`/`ls`/`bash`（`cat`、`head`、`tail` 单文件）五种触碰各有用例，均注入锚点目录祖先链上的上下文文件；`write` 到**尚不存在**的新文件路径同样触发（这是两个现成扩展没有的能力）。
2. **顺序与优先级**：由外向内排列；同目录 `AGENTS.override.md` 压掉 `AGENTS.md`；`AGENTS.MD` / `CLAUDE.MD` 大小写变体可被发现；cwd 自身的上下文文件**不重复注入**（pi 已加载）。
3. **边界 fail-closed**：cwd 之外的路径（`../x`、`~/.pi/agent/AGENTS.md`）、符号链接指向 cwd 外的目录、`repo-evil` 这类前缀冒充 —— 一律零注入。
4. **不破坏原结果**：`isError` 结果、无 text content 的结果、非触发工具（`grep`/`find`/`powershell` 等）逐字不变（用同一 handler 前后 `content` 深比较断言）。
5. **去重与重注入**：同会话重复触碰同目录只注入一次；模拟 `session_compact` 后同一文件可再次注入。
6. **预算**：超 32 KiB 单文件被截断到码点边界且带截断标记；单次注入合计超 128 KiB 时按上限截断并标注。
7. **测试**：`node:test` + `node:assert/strict`；纯逻辑（路径链、发现、优先级、格式化、截断、去重）单测全覆盖；宿主交互用**真实 pi `ExtensionRunner` + 模拟工具结果事件**接线跑，不靠纯函数纸面正确（`dir-context` 的风险点正是宿主事件契约）。
8. `npm test`（根 `npm run test:all` 收录新套件）+ `npm run typecheck` 全绿；红线 7 四处文档同步完成。
9. **跨厂商独立评审**（红线 11）：reviewer 与开发者不同模型家族，逐条处理意见直到某轮无新意见。
10. **真机验收**：在本仓真实会话里读取一个深层文件（如 `src/extensions/pwr/engine/spec.ts`），transcript 里出现 `Loaded` 标记且内容正确。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-10（UTC）· **方式**：对话内结构化问卷（5 问 + 默认值清单），用户回复「没问题」
- **逐条决策**：
  1. 名字 = **`dir-context`**（目录 / todo 文件 / 命令面前缀）
  2. 触发面 = **B 档：Claude 对齐（read/write/edit + bash 单文件读）再加 `ls`**；不做 grep/find
  3. 注入通道 = **A：`tool_result` 尾部追加 text block**（不用 `turn_end` 独立消息）
  4. 作用域边界 = **A：严格 cwd 之下，cwd 之外一律不注入**（不沿 git root 兜底）
  5. 去重与重注入 = **A：会话内每文件一次，`session_compact` / `session_shutdown` 后清空可重注入**（= Claude 语义）
  6. 默认值清单（文件名集合与优先级、realpath 包含校验、32 KiB/128 KiB 截断、`/dir-context:status` 状态键、不复用现成扩展代码）**全部照 agent 提议执行**
- **已知风险（显式接受）**：① bash 白名单是启发式，漏判只是少注入（不注入不等于错误）；误判最多多注入一个目录的上下文；② 每次注入都消耗 token，上限已设但 `ls` 大目录仍可能一次带进多层链；③ 与 `pi-subdir-context` 同时安装会在 `read` 路径上重复注入（README 里写明二者不要同装）。
- **开工放行**：进入 `processing`（第二次 `claim`）前，需用户在本轮回复中明确同意。
