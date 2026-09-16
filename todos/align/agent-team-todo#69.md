# agent-team-todo#69 failure-delivery 第 3 例恒失败：去掉「临时目录不在 git 仓库内」的环境假设

## 意图

让 agent-team 的测试门重新可信。`src/extensions/agent-team/test/failure-delivery.test.ts` 第 3 例（worktree pre-flight failure）在本机**每次必挂**（实测 8 例挂 1 例）：用例用 `fs.mkdtempSync(path.join(os.tmpdir(), …))` 建项目目录，而本机 `C:\Users\蒋晗` 自带 dotfiles 的 `.git`，临时目录因此落在某个 git 仓库内 → 真实 git 语义下 worktree 建得出来 → leader 照常 spawn → 断言 `no leader spawned` 挂。

红线 7 要求「全量测试绿」才准 merge；一条恒红用例让这道门事实上失效，也让 README 的 agent-team 测试数站不住。

## 范围

做什么：

- 在用例内斩断上层仓库发现（`GIT_CEILING_DIRECTORIES`），使被测路径在**真实 git 语义**下确定性地「不是 git 仓库」。
- 用例标题与既有三条断言保持不变；补一条失败文案断言（`/不是 git 仓库/`）。
- 文件头注明本次环境假设及成因，并指向 `docs/tools/todo-cli.md` 已知坑里同类记载（本机 `~` 自带 `.git`）。

明确不做什么：

- 不改共享 helper、不动其余 52 处 `os.tmpdir()` 用例——它们只需要一块临时目录，与仓库归属无关。
- 不改成注入式失败（会退化成纸面测试，违「测试要接真实实现」）。
- 本轮不动 `todo-cli#13` / `agent-manager#3` 的代码：只查根因，结论写回各自条目。
- 不新增 `docs/incidents.md` 条目（同类事实已有记载，避免重复）。

## 验收标准

- 本机 `cd src/extensions/agent-team && npm test`：该文件 8/8 全绿，连跑 3 次稳定。
- 修复前后对照留档：修复前可复现必挂（已实测），修复后全绿。
- diff 只动目录构造与文件头注释：用例标题与三条断言逐字不变。
- agent-team 全量测试 + `npm run typecheck` 零错误；README / docs 卡测试数无需加「已知 1 例环境相关失败」的附注。
- 同族根因排查结论写回 `todo-cli#13`、`agent-manager#3`（写结论，不在本轮改代码）。

## 人工确认

- 确认人：用户（本会话）
- 日期：2026-09-16
- 方式：会话内逐条问答对齐（25 问，用户回复「按你建议」）→ 5 份文档落盘后用户回复「确认」
- 结论：全部决策按本档执行（修法 = `GIT_CEILING_DIRECTORIES`；只改这一例；断言保持；注释指向既有坑记载；同族只查根因）。
