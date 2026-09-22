# todo-cli-todo#17 参数校验早于仓库根发现

## 意图

写命令（`add` / `claim` / `align` / `complete` / `reopen` / `dep`）的必填参数校验发生在
`resolveRepoRoot` **之后**：在非仓库 cwd 下缺 `--file` / `--match` 时，用户拿到的是
「找不到仓库根：当前目录不在 git 仓库内」，而不是真正的问题（参数没给全）。
`test/todo-cli.test.ts` 的三条 E2E 早就按「先报参数错」写，主干 `730fadc` 实测全红——
说明这是实现漂移，不是测试过期。参数校验不依赖仓库根，没有任何理由后置。

## 范围

**做什么**

1. 把六个写命令的参数校验（`缺少 --file <name>`、`--file 只能是 todos/ 下的文件名`、
   `缺少 --match "子串"`）前移到仓库根发现之前；`--file` 形态判定改用纯函数
   `normalizeTodoName`（不依赖 root 的路径拼接），语义与 `resolveTodoPath` 内的判定一致。
2. 删除分派处重复的校验块（校验单一入口，避免两处漂移）。
3. 补单测：以 `execGit` = 「一调用就抛」的探针断言「缺参数时绝不触发仓库根发现」
   （沿用 `test/root-discovery.test.ts` 既有的 boomGit 模式）。
4. 文档同步：`docs/tools/todo-cli.md` 的不变量里写明校验顺序；必要时同步 SKILL.md。

**明确不做什么**

- 不改错误信息文案、退出码（仍是 exit 1、stderr 恒空）与 USAGE。
- 不动读命令（`summary` / `list` / `lint` / `triage` / `migrate`）的顺序：它们真的需要 root，
  非仓库 cwd 下仍报「找不到仓库根」。
- 不预做 `dep` 的 `--on` 校验前移（它需要依赖图与文档读取，属数据处理路径，维持现状在 run 内校验）。

## 验收标准

1. `npm run test:todo` 全绿（134 用例，含此前失败的 3 条 E2E）。
2. 新增单测：六个写命令缺 `--file` /（非 add 时）缺 `--match` / `--file` 形态非法时，
   在非仓库 cwd 下返回 1、输出对应参数错误，且 `execGit` 探针**零调用**。
3. 读命令在非仓库 cwd 下仍报「找不到仓库根」（既有测试保持绿）。
4. 全仓根自检（contract / smoke / test-all / install-smoke）不受影响。

## 人工确认

- 确认人：用户（仓库所有者）
- 日期：2026-09-22
- 方式：会话内用户指示「修掉」（承接我报告的 3 条 root:todo 既存失败 + 建议「登记 todo 或顺手修掉」），
  修复口径（参数校验前移、文案与退出码不变、读命令顺序不动）在交付报告中确认。
