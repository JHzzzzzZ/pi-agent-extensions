# 插件目录收进 src/extensions/

Status: accepted（2026-09-12，general-todo:10；外层目录名 `src/extensions/` 由用户指定）

仓库根曾平铺 12 个 `pi.extensions` 注册的插件目录（pwr、agent-team、…、solo-mode），与仓库自身的开发设施（`tools/`、`test/`、`todo-cli/`、`agent-manager/`）混在同一层，分不清「pi 包的扩展」与「仓库开发工具」。决定：12 个插件目录整体收进 `src/extensions/<插件名>/`（manifest 路径同步为 `./src/extensions/<名>/index.ts`），`tools/`、`test/`、`todo-cli/`、`agent-manager/` 留仓库根。

## Considered Options

- 维持平铺——根目录条目持续增长，扩展与工具的边界靠记忆。
- 收进 `src/`（无 extensions 层）——`src/` 通常指单一包的源码；本仓库是多扩展合集，会误导。
- `src/extensions/`（选定）——manifest 解析、安装冒烟期望表、todo lint 全部按「父目录名 = 插件名」工作，两级目录的接线代价最小。

## Consequences

- `tools/install-smoke.mjs` 的 `extensionDirsFromManifest` 改为按父目录名解析（对注册路径深度不敏感）。
- 手动复制安装的**源**路径变为 `src/extensions/<名>/`（复制目标 `~/.pi/agent/extensions/<名>/` 不变）。
- pwr 内层 `src/` 目录保留原名（接受 `src/extensions/pwr/src/…` 嵌套）：纯移动保历史；改名需另动 pwr 内部 86 处 import，如有需要单立条目再做。
- 插件内文档回仓库根的相对引用加深两级；Windows 下 worktree 内路径加深，MAX_PATH 风险加码（见 `docs/incidents.md` 长路径条目的跟进）。
