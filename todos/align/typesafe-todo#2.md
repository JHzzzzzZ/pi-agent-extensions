# typesafe-todo#2 退休 typesafe 扩展

## 意图

Pi 1.0.0 内置了 TypeSafe/Jev 分类器（provider `typesafe`、模型 `typesafe/jev-latest`、api `typesafe-system-one`），本仓库的 `src/extensions/typesafe/` 因此从"补缺口"变成**净负担**：

1. **遮蔽内置目录（本次实测）**：扩展在进程启动时执行 `registerProvider(createProvider({ id: "typesafe", models: [] }))`，把内置 `typesafe` provider 的模型列表替换成空数组。只要它加载，该会话就永远看不到 `typesafe/jev-latest`；且 `/reload` 移除扩展后**不会恢复**内置注册，只有重启进程才回得来（实测：同一份 settings，全新进程 15 个 classifier 含 typesafe，reload 过的老进程 14 个不含）。
2. **能力已被内置覆盖**：内置 `ctx.modelRegistry.classify(model, context)`（扩展侧，1.0.0 typings 实测存在）与 codemode 的 `models.classify()`（模型侧）提供同一能力。关键在于 `noul` 与内置的 `bool` 是**同一个原语**——pi 源码注释明写 `TypeSafe System One classification with public bool values mapped to wire-level noul`（`pi-ai/dist/api/typesafe-system-one.js:17`），endpoint 也不变（pi 拼 `baseUrl + systemone` = 本扩展 `client.ts` 的 `/v1/systemone`）。
3. **凭证不需要它**：`auth.json` 的 `typesafe` 条目（当年由它的 `/login` 写入）由内置 provider 直接读取。实测：`TYPESAFE_API_KEY` 未设置时 `getAllAvailable("typesafe")` 仍返回该模型，重启后的会话里真实分类调用成功（`stopReason: "stop"`，531 tokens，成本 0）。

**唯一不可替代的能力是 `cli.ts`**（`node cli.ts --state ... --questions ...`，stdout 只出 answers JSON，错误走 stderr）——给 bash 脚本 / 子 agent / 团队 run 成员用的 shell 通道。内置没有对应物：`models.classify()` 只给会话里的模型，`ctx.modelRegistry.classify()` 只给扩展代码。**用户 2026-10-04 明确选择放弃该通道。**

## 范围

**做什么**

1. 删除目录 `src/extensions/typesafe/`（7 个源码/配置文件 + 5 个测试）：`index.ts`、`client.ts`、`credential.ts`、`cli.ts`、`README.md`、`package.json`、`package-lock.json`、`test/{client,credential,index,parity,sentinel}.test.ts`
2. 根 `package.json`：`pi.extensions` 移除 `./src/extensions/typesafe/index.ts`（14 → 13）
3. `tools/install-smoke.mjs`：移除 `typesafe` 期望项与其上方的说明注释，扩展计数 14 → 13
4. `tools/test-all.mjs`：移除 typesafe 套件条目，套件数 19 → 18
5. `docs/extensions/typesafe.md` 删除卡片；`docs/INDEX.md` 移除路由行
6. `docs/specs/typesafe-login.md` 删除（功能不再存在，按 AGENTS.md 红线 7「不再成立的直接删除」；决策史由 `typesafe#1` 对齐文档与 todo notes 承载）
7. `README.md`：扩展表格行、`## typesafe` 章节、扩展数（14 → 13，含 `dev-laptop` 描述与"全部加载"段）、测试数（扣除 typesafe 用例，实测后回填）
8. `AGENTS.md`：「14 个插件目录」的四处表述、typesafe 测试命令、缩进清单里的 `typesafe/`、install-smoke 的「验 14 扩展」
9. `docs/tools/test-all.md`：套件清单与「14 个扩展 / 19 套件 / 2102 用例」表述
10. 被触及卡片的头部 `last verified @ <commit>` 行同步

**交付后的独立步骤（仓库外，红线 8，需再次确认后执行）**

11. `~/.pi/agent/settings.json`：移除包过滤器 `-src/extensions/typesafe/index.ts`。**必须等 push 到 `dev-laptop` + `pi update` 刷新包缓存之后**——提前移除会让扩展复活，继续遮蔽内置 Jev。

**不做什么**

- **不动那 4 条依赖 Jev 的待办**（用户选择「全留」）：`goal#8`、`agent-team#71`、`agent-team#72`、`jev-safe-gate#1`。它们**都不依赖本扩展**，只需要一条 Jev 调用路径，内置 `ctx.modelRegistry.classify()` 提供；各自开工时的对齐文档把调用方式写作 `classify()`、原语 `noul` 写作 `bool` 即可，台账不需要改动。
- 不动 `~/.agents/skills/typesafe-ai/`（全局 skill，仓库外）。
- 不引入替代扩展，不改 `agent-manager`，不碰其余 13 个扩展的实现。

## 验收标准

1. `npm run test:all` 全绿，套件数 **18**；用例总数按实测回填 README（唯一来源）。
2. `node tools/install-smoke.mjs` 通过，输出 **13/13** 扩展加载成功（本机已知的全局 skills 未隔离红属既有问题，另条登记，不计入本次）。
3. `node .agents/skills/todo-cli/todo-cli/todo.mjs lint` 通过：13 个注册扩展 ↔ todos 文件一一对应，`typesafe-todo.json` 作为历史保留不报错。
4. `rg -il 'typesafe' --glob '!node_modules' --glob '!todos' --glob '!.worktrees'` 只命中 `todos/` 与 git 历史；代码、工具链、活文档零残留。
5. 根 `package.json` 的 `pi.extensions` 恰 13 项。
6. 各扩展 `npm run typecheck` 绿（删除不动其它扩展的类型面）。
7. 真机：push + `pi update` + 重启后，`models.getModelOfType("classifier","typesafe","jev-latest")` 可用（本次会话已实测通过），且 `ALL_TOOLS` 中无 `typesafe_ask`。
8. 交付最后一步移除 `~/.pi/agent/settings.json` 的包过滤器，并登记备份与回滚方式。

## 人工确认

用户 2026-10-04 本会话逐项确认：

- **Q1 扩展去留** → **选项 2：全删**（含 `cli.ts`）。明确接受代价：shell 脚本 / 子 agent / 团队 run 成员从此没有 Jev 通道，除非开 codemode 花 token。
- **Q2 4 条依赖 Jev 的待办** → **选项 2：4 条全留**，零台账改动（不挂 `--dep`、不 `complete`）；调用方式变更只写入本文档，由各自开工时的对齐文档落实。
- **Q3 `~/.pi/agent/settings.json` 包过滤器** → **清理**，但排在交付最后一步（先 push + `pi update`，避免扩展复活继续遮蔽内置 Jev）。
- 决策依据由本次会话实测提供：① 全新进程 vs reload 过的老进程的 classifier 数量对照（15 vs 14）与真实会话内分类调用成功；② `noul ≡ bool` 由 pi 源码注释证实；③ `ctx.modelRegistry.classify` 在 1.0.0 typings 中存在。
