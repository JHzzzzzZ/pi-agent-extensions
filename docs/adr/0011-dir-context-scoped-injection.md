# ADR-0011：目录作用域上下文注入走 `tool_result` 追加 + 会话级去重

- 状态：已采纳（v1.0.0）
- 日期：2026-10-10（UTC）
- 相关：`todos/align/dir-context-todo#1.md`、`docs/extensions/dir-context.md`、`docs/cross/status-bar.md`

## 背景

pi 原生只把 **agent dir + cwd + cwd 的祖先链** 的上下文文件放进系统提示（`loadProjectContextFiles()` 一路向父目录走），**子树一概不读**。业界（agents.md 规范、Claude Code 的 on-demand nested `CLAUDE.md`）都把「离被编辑文件最近的那份指令」视为应当生效的约定，因此需要插件补齐。

补齐要在三个维度上做选择：**什么算「碰了目录」**、**内容从哪条通道进上下文**、**什么时候允许再注入**。

## 决策

1. **触发面 = Claude 对齐 + `ls`**：`read` / `write` / `edit` 的 `path` 所在目录、`ls` 的目标目录、bash 里**恰好一个** `cat` / `head` / `tail` 单文件目标所在目录。`grep` / `find` 不做——递归搜索一次触及子树里任意多个目录，按 `path` 注入一层是近似而非精确。
2. **注入通道 = `tool_result` 尾部追加 text block**，原 `content` 逐字保留为前缀。
3. **作用域 = 严格 cwd 之下**（含 realpath 包含校验）；cwd 自身的上下文文件不注入（pi 已加载）。
4. **去重 = 会话内每绝对路径一次，`session_compact` / `session_start` 清空**。
5. **预算是硬上限**：单文件 32 KiB、单次 128 KiB，码点安全截断。

## 备选与否决理由

- **`turn_end` 时以独立消息注入（`custom_message` / `context_edit`）**：模型看到的是独立一条消息、不混在工具输出里，语义更干净；但注入与「哪次工具触碰」解耦，去重、顺序与预算都要自己再实现一遍，且时序绕（`turn_end` 的 `continue: true` 会诱发下一轮模型请求，条件没守好会循环）。**v1 否决**，等有明确需求再评估。
- **`tool_call` 改写入参**（把 AGENTS.md 塞进 read 的 `path`/`offset` 之类）：改的是模型请求本身，风险高且没有诚实的落点。
- **`before_agent_start` 一次性把所有嵌套上下文塞进系统提示**：等于把「按需」变成「全量」，大仓库直接吃光窗口，正是本扩展要避免的。
- **沿 git root 兜底（cwd 之外的路径也注入）**：读宿主包目录、`../shared/` 时会突然拖进一堆不相关上下文，风险大于收益 ⇒ fail-closed。
- **不清理 compact**：省 token，但 compact 后那段上下文已经不在窗口里，「只注入一次」等于永久丢失 ⇒ 与 Claude 的按需重载语义冲突。

## 后果

- 模型第一次触碰某目录时能拿到该目录的局部约定，**不需要它主动去读 AGENTS.md**（它往往不会读）。
- 代价是 token：注入按目录累积，靠去重 + 双层预算兜住；`ls` 一个大目录可能一次带进多层链（上限已设）。
- 与同类第三方扩展（`pi-subdir-context` / `pi-nested-agents-md`）**同装会在 `read` 上重复注入**——README 已写明不要同装。
- 决定「顺序 = 由外向内」意味着后注入的局部规则在上下文里更靠后，与 Claude Code 的拼接顺序一致（更靠近被编辑文件的规则读得更晚）。
