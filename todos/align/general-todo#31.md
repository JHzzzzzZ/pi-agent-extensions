# 对齐：general-todo#31 — 清理仓库活文档/注释里的 TDD 残余字样

- 条目：`general-todo#31` · 分支引用：`docs/tdd-leftover-cleanup`
- 日期：2026-10-11（UTC）· 参与：用户（提出「把 AGENTS.md 中的 TDD 删掉，改成正常实现 + 实现测试」→ 复查后确认「清理」）+ agent（全仓定位残余）
- 状态：用户已确认，待 `align` 过后进入 `processing`
- 前情：根 `AGENTS.md` 红线 5 已在提交 `2b2379f`（2026-10-11）改为「实现 + 测试」；本条目收口与之配套的残余字样

## 意图

用户 2026-10-11 要求把 `AGENTS.md` 里的 TDD 口径改成「正常实现 + 实现测试」。复查发现根 `AGENTS.md`（以及 `src/extensions/*/AGENTS.md`）**已经没有 TDD 字样**——红线 5 当天已由 `2b2379f` 改成「实现 + 测试——新能力、bug 修复与重构按正常顺序实现，同一变更内带上锁定该行为的测试并跑绿」。

但同一口径在仓库的**活文档与注释**里还有 4 处残留，继续按 TDD 表述，与新红线打架：

1. `src/extensions/pwr/docs/tui-sync.md:53` — 「执行 A1–A4 时遵守：TDD 先行；测试仍不实例化真实 pi-tui……」
2. `src/extensions/agent-team/docs/tui-sync.md:76` — 「后续所有 TDD 测试的期望值从此表抄录，禁止从被测实现复制。」
3. `agent-manager/agent-runner.test.ts:2` — 文件头「（TDD：先红后绿）」
4. `agent-manager/server.test.ts:2` — 文件头「（TDD：先红后绿）」

用户对上述 4 处逐条看过并回「清理」（2026-10-11 会话内）。

## 范围

**做什么**

1. 4 处全部改为「实现 + 测试」口径：保留每条原意（pwr 那条仍要求宿主边界测试不实例化真实 pi-tui；agent-team 那条仍要求期望值人工抄录、禁止从实现复制；两个 test 头仍声明该文件是同一变更内落地的锁定测试），只去掉「TDD / 先红后绿 / 测试先行」的措辞与顺序主张。
2. 提交说明登记理由（承接 `2b2379f`）。
3. **评审第 1 轮补充的同类残留（同口径延伸，2026-10-11）**：`src/extensions/remote-tools/test/ssh.test.ts:2` 与 `ops.test.ts:2` 的「（先写测试，实现见 …）」、`docs/extensions/agent-team.md:114` 的「期望值从矩阵来（红→绿）」——同为测试先行的次序主张，按同一口径改写（用户原始意图即「把 TDD 口径清掉」）。`docs/extensions/jev-safe-gate.md:44` 的「红→绿证据」为既往变异测试的事实记录，明确不改。

**明确不做什么**

- 不改写 `todos/`（含 `todos/align/`）与 `history/` 里的历史提及——append-only 台账，记录当时的真实过程。
- 不改 `docs/specs/*.md` 里的「先红后绿」（`todo-cli-global-id.md:44`、`virtual-model-router.md:45`）——那是既有变更的测试决策记录，属历史规格。
- 不改任何行为、测试断言、工具输出与宿主交互面；纯文档 + 注释改写。
- 不 bump pwr / agent-team / agent-manager 版本号（无行为变化，bump 会制造无意义发布）；根 `README.md` 测试数不变。
- 不新增/删除文件，不触碰 `.pi/` 与 `.worktrees/`。

## 验收标准

1. 上述 4 处改动后，活文件内 `grep -rn "TDD" --include="*.md" --include="*.ts" src/ agent-manager/ test/ tools/ .agents/`（排除 `node_modules`）**零命中**；`先红后绿` / `测试先行` 在 `AGENTS.md`、`docs/`、扩展 README 与卡内零命中。
2. `npm run test:all` 全绿、`npm run typecheck` 零错误（纯文档/注释改动，理应无回归——作为"没碰坏"的证据）。
3. 跨厂商评审（非 DeepSeek 家族）一轮无新意见。
4. `git status` 干净；改动以 `docs:` 前缀独立 commit 回 `dev-laptop`（`--no-ff`），worktree 移除。

## 人工确认

用户 2026-10-11 在会话中确认：先提出 AGENTS.md 的 TDD 口径要改成「正常实现 + 实现测试」，在看到「AGENTS.md 已无 TDD、残余 4 处在 pwr/agent-team 文档与 agent-manager 测试头」的说明后回复「清理」——即确认按上述范围执行，含"不动历史台账与历史规格"的边界。
