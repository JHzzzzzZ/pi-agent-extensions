# 规格：todo-cli 目录重构 + skill 化（入口内迁 `.agents/skills/todo-cli/todo-cli/`）

> 来源：`todos/todo-cli-todo.json` #9 + `todos/skills-todo.json` #9（用户 2026-09-12 登记；2026-09-14 计划模式对齐后改定落点）
> 对齐：2026-09-14 用户决策——落点在**仓库内** `.agents/skills/todo-cli`（免仓库外审批）、工具不搬出仓库、不保留旧入口壳、等 #11（对齐门）落主干后开工
> 状态：已实现

## 问题陈述

CLI 的入口在仓库根 `tools/todo.mjs`、实现在仓库根 `todo-cli/`：入口与实现分离、仓库根多两层噪音；而「仓库根 = 脚本位置的上一级」（`REPO_ROOT = path.resolve(HERE, "..")`）把**工具位置**和**仓库根**绑死——工具一旦不在仓库根就解析错误，也无法在别的仓库里复用。

同时 #9 要把工具变成 skill 资产（跟着 skill 走、在哪都能用），这与「脚本位置即仓库根」的隐式契约直接冲突。

## 方案

1. 工具整体内迁到仓库内项目级 skill 目录，入口与实现同居：

```
<repo>/.agents/skills/todo-cli/
├── SKILL.md                     # name: todo-cli 的命令参考卡
├── scripts/todo.sh              # 包装器：定位内层工具
└── todo-cli/
    ├── todo.mjs                 # 唯一入口
    ├── core.ts align.ts lock.ts query.ts migrate.ts schema.ts
    └── test/*.test.ts           # 测试与实现同居
```

2. 仓库根改为**发现**（顺序即优先级）：

| 来源 | 语义 |
| --- | --- |
| `deps.repoRoot` | 测试注入（普通使用不会出现） |
| `--root <dir>` | 显式指定；相对当前 cwd 解析、必须是已存在目录；放在任意子命令前 |
| `git rev-parse --show-toplevel` | 以 `process.cwd()` 为工作目录，仓库任意子目录可用 |
| 都拿不到 | fail-closed：静态消息 + exit 1（绝不静默回退 cwd） |

3. 命令面、存储（schema v2 五态）、锁与原子写、退出码与 stderr 约定**全部不变**；新增的只有 `--root` 与根发现。
4. `--help`、裸调用（USAGE + exit 1）、未知命令（提示 + USAGE + exit 1）**不触发**根发现。

## 用户故事

- 作为 agent，我在仓库任意子目录（含 `.worktrees/<名>`）敲 `node .agents/skills/todo-cli/todo-cli/todo.mjs summary`，得到**当前 checkout** 的台账，不必关心工具在哪。
- 作为 agent，我在另一个 git 仓库里用绝对路径调用同一个入口，读写的是**那个仓库**的 `todos/`（而不是工具所在仓库）。
- 作为 agent，我在非 git 目录误敲只读命令时，得到一句静态报错而不是一堆猜测的路径；需要指定目标仓库时用 `--root <dir>`。
- 作为用户，我在本仓库用 Pi 时 `/skill:todo-cli` 能加载到命令参考卡；把 `.agents/skills/todo-cli/` 整目录复制到别的仓库也能直接用。

## 实现决策

- 删除 `REPO_ROOT` 常量；新增导出 `resolveRepoRoot({ rootFlag, cwd, execGit })`（纯函数，返回 `{ok:true,root} | {ok:false,message}`），`main` 懒解析（不需要仓库根的命令先返回）。
- git 调用的 stderr 一律吞掉（非 git 目录不该往终端喷 `fatal:`）；`triage` 在 git 失败时静态报错退出 1，不再抛栈。
- `parseArgs` 的值标志在缺值时记空串（`--root` 缺值 → 「缺少 --root 的目录」）。
- 测试全部随工具同居：原根 `test/todo-cli.test.ts` → `…/todo-cli/test/todo-cli.test.ts`；重 fixture（并发/中断）改 `--root` 指定仓库根并把工具拷到 fixture 的 `.agents/skills/todo-cli/todo-cli/`；模板文件清单按目录枚举（新增模块自动带上）。
- 文档单点：入口路径、根发现、`align` 命令面同步到 `AGENTS.md` / `README.md` / `docs/INDEX.md` / `docs/tools/todo-cli.md`；决策落 `docs/adr/0004-todo-cli-skill-placement.md`。

## 测试决策

- 新增 `test/root-discovery.test.ts`（6）：`resolveRepoRoot` 的 `--root` 胜出 / 非法 `--root` / git 成功 / git 失败 / 空输出的纯测，`main` 级「--help/裸调用/未知命令不要求仓库根」，失败路径「不写任何文件」，以及**真实 `git init` 仓库子目录调用**的进程边界 E2E + `--root` 覆盖 cwd 仓库 + `--root` 不存在/缺值的退出码与 stderr。
- 新增 `test/skill.test.ts`（2）：`SKILL.md` frontmatter 合法性（Pi 对非法 skill 只 warning 且静默不加载，靠测试兜住）与命令面/入口路径/`--root` 齐备、包装器指向内层工具。
- 既有 60 个测试一条不删（含 #11 的 align 用例），迁移只改路径与 fixture 形态。
- 门：`npm run test:todo`（68）+ `npm run test:contract` + `npm run test:smoke` + `node .agents/skills/todo-cli/todo-cli/todo.mjs lint`。

## 范围外

- 全局 skill 库（`~/.pi/agent/skills/`）与 `.zcode/.pi` 双镜像：本机没有该库，改动在仓库外且需逐次批准；已登记 `todos/skills-todo.json` 接力条目。
- `package.json` 的 `pi.skills` 包级注册（会让所有安装者拿到这个仓库内工具，属产品决策，需求出现再说）。
- Windows `.cmd` 包装器（YAGNI；`node <路径>` 在 cmd/PowerShell 直接可用）。
- 命令面语义、存储格式、schema 版本、锁与原子写机制（沿用 #11 后的现状）。
