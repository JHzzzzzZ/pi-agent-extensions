# ADR-0004：todo-cli 工具落仓库内项目级 skill，仓库根改为发现

2026-09-14，来源 `todos/todo-cli-todo.json:9`（用户 2026-09-12 登记；2026-09-14 计划模式对齐后改定落点）。术语见根 `CONTEXT.md`。

## 背景

#9 的原方案是「工具整体搬进全局 skill 目录 `~/.pi/agent/skills/todo-cli/todo-cli/`，让 CLI 跟着 skill 在任意仓库可用」。落地前核实环境：本机**不存在** `~/.pi/agent/skills/` 与 `~/.agents/skills/`（skills-todo #5–#8 记录的全局技能库在另一台机器上），而仓库外写入还需用户逐次批准（红线 8）。同时工具原来的仓库根解析是 `REPO_ROOT = path.resolve(HERE, "..")`（脚本位置），与「搬出仓库」互斥。

同时触发另一个问题：工具一旦不在仓库根，`REPO_ROOT` 立刻解析错误；而「任意 git 仓库任意 cwd」的验收本来要求的就不是脚本位置，而是**当前仓库**。

## 决策

1. **工具不离开仓库**，整体落**仓库内项目级 skill**：`<repo>/.agents/skills/todo-cli/todo-cli/`（入口 `todo.mjs` 与实现、测试同居）；技能根放 `SKILL.md`（命令参考卡）与 `scripts/todo.sh`（定位内层工具的包装器）。选 `.agents/skills/`（复数）因为它是 Pi 文档列明的项目级扫描路径（`.pi/skills/` 与 `.agents/skills/`）；单数 `.agent/` 不会被加载。
2. **不保留 `tools/todo.mjs` 转发壳**：全仓引用改成单点入口，`tools/` 只留 `install-smoke.mjs`。
3. **仓库根改为发现**：`deps.repoRoot`（测试注入）> `--root <dir>`（相对 cwd 解析、须是已存在目录）> `git rev-parse --show-toplevel`（以 cwd 起）> **fail-closed** 静态消息 + exit 1。删除模块级 `REPO_ROOT`；`resolveTodoPath`/`lintTodos` 的 `repoRoot` 变为必填，新增导出 `resolveRepoRoot`（纯函数、可注入 cwd/execGit）。
4. **不做全局镜像**：不写 `~/.pi/agent/skills/`、不做 `.zcode/.pi` 双镜像、不注册 `package.json` 的 `pi.skills`（避免把仓库内工具提升成包级技能）；跨机全局化留待有该库的机器执行，`todos/skills-todo.json` 留有接力条目。

## 后果

- **行为变更**：cwd 在 `.worktrees/<名>` 内调用 → 作用于该 worktree 的 `todos/`（旧版恒指主仓）；在别的 git 仓库用绝对路径调用 → 作用于那个仓库。这正是 #9 要的「任意 git 仓库任意 cwd」。
- `--help` / 裸调用 / 未知命令**不要求** cwd 在 git 仓库内（保持任意目录可用）。
- 根 `npm run test:todo` 指向新 glob；并发/中断真子进程 fixture 随工具同居并改用 `--root`（根发现的真实 git 路径由 `root-discovery.test.ts` 的 `git init` 用例锁）。
- 项目级 skill 只在**本仓库**被 Pi 加载；其它仓库要用就复制 `.agents/skills/todo-cli/`（工具随目录走，无仓库依赖）。
- `.gitattributes` 增 `*.sh text eol=lf`：Windows 检出不得把 `scripts/todo.sh` 变成 CRLF（否则 POSIX 下 shebang 失效）。

## 否决项

- **全局 `~/.pi/agent/skills/`**：本机无该库、仓库外写入需逐次批准、跨机双份维护。
- **`.agent/`（单数）**：Pi 不扫描，等于普通目录，且与原记录的路径拼写不符。
- **保留旧入口壳**：双入口与 #9 验收「引用零残留 / 单点入口」冲突。
- **工具留仓库根、skill 目录只放 SKILL.md**：无法随 skill 复制到其它仓库，违反 #9 的可用性目标。
