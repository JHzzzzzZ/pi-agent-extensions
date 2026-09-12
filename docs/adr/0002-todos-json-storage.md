# todos 存储改为 JSON 唯一权威（方案 C），去掉 markdown 与 sqlite 索引

2026-09-12，todos/todo-cli-todo.md:17（用户 2026-09-11 指定登记）。todos 的持久层经历了三代：markdown 手工编辑（格式破坏/漏查重频发）→ markdown 权威 + node:sqlite 派生索引（L14，引入实验依赖、降级路径、stat 漂移、时间戳不入 git 四个新问题）→ 本决策：`todos/<名>.json` 是唯一持久真相，CLI（`node tools/todo.mjs`）是唯一读写入口，状态/文本/注记/分支引用/标签/三时间戳都是原生字段，并发互斥用自研每文件 O_EXCL 锁 + temp+rename 原子写替代 sqlite 事务。markdown 彻底退出（`migrate from-md` 一次性迁入，`migrate to-md` 常驻逃生回滚但不是视图）。

## Considered Options

- **单文件 `todos/todos.json`**：一个文件一把锁实现最简，但 200+ 条全量重写、任何并行分支的 todos 改动必然合并冲突——否决。每主题一文件把冲突面隔离到单个插件域。
- **保留 rawText 原始行字段**：迁移可字节回放，但同一内容存两份，claim/complete 只改字段后 rawText 必然漂移成垃圾——否决，回滚由 `migrate to-md` 从 schema 反向生成（规范形态，非字节还原）。
- **继续 sqlite（方案 A/B 路线）**：事务/查询免费，但 node:sqlite 是实验 API（Node <22.13 直接不可用需降级）、索引不入 git 与 markdown 漂移需 stat 启发式自愈、时间戳非持久——JSON 化后这三个问题整类消失，查询维度全部变成原生字段。

## Consequences

- 条目 id 文件内 max+1 永不复用、entries append-only：跨分支合并冲突按 id 取并集手工解决（写进 AGENTS 红线 2），没有合并辅助命令。
- 缩进子行不再是独立条目（迁移时并入上一条顶层条目的 notes）：条目数口径从「行级」变为「顶层」，等价口径 = 全部文本零丢失。
- 迁移前历史条目三时间戳为 null（旧索引不入 git、覆盖面不全，不伪造数据）。
- `todos/*.json` 经 `.gitattributes` 锁 `text eol=lf`，防 Windows autocrlf 整文件 diff。
