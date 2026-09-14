# general-todo#11 优化全量测试速度（先量化，再落地头两项）

## 意图

仓库测试规模已到约 1900+ 用例（pwr 439、agent-team 520、loop 196、opencode-bridge 114、其余卫星插件与根三套脚本），但按目录**串行**跑：每次收尾核对、以及多 worktree 并行开发时每个 worktree 各跑一遍，固定成本偏高。目标先量化再优化，不预设结论；红线是覆盖只增不减（不得删测试、跳用例、放宽断言换速度）。

**第一轮实测（2026-09-14 23:54，node v22.23.1，32 逻辑核，冷启动、逐套件串行）**：

| 套件 | 墙钟 | 备注 |
| --- | --- | --- |
| agent-team | 11.7s | 有 node_modules |
| root `test:todo` | 5.4s | 含进程级 E2E |
| pwr | 3.2s（**不完整**） | 缺 node_modules ⇒ 11 个文件 `ERR_MODULE_NOT_FOUND` |
| opencode-bridge | 3.0s | |
| agent-manager | 2.6s | |
| loop | 1.1s（**不完整**） | 缺 node_modules ⇒ 1 个文件加载失败 |
| deep-init / 其余 7 个卫星插件 | 0.2–0.9s 各 | |
| 根 `test:contract` / `test:smoke` | 0.7 / 0.8s | |
| 合计 | **≈31s** | 不含失败重跑与 typecheck |

第一轮已暴露的**真问题**（非猜测）：`pwr/` 与 `loop/` 目录没装 `node_modules` 时，整份测试文件直接加载失败——「跑绿」的前提是每个 checkout（含每个 worktree）先 `npm install`。因此依赖安装成本是本次优化的第二大目标。

## 范围

**做什么**

1. **`tools/test-all.mjs`（仓库级唯一入口，纯 node、零依赖）**：登记套件清单（命令、cwd、是否 `serial`）、并发度参数（默认 `--jobs 2`，可调）、逐套件墙钟计时、失败即收集不中断、退出码聚合；`npm run test:all` 接上。成为收尾核对的唯一命令，也是对照表的复算工具（跨机可复现：输出含 node 版本与 CPU 数）。
2. **负载敏感套件标注 serial**：`pwr/perf.test.ts`（300ms 门）、`agent-manager` core 性能门、`root test:todo`（含真子进程并发用例）在清单里标 `serial`，**不放宽断言**。
3. **依赖安装加速**（junction 复用 node_modules 已被事故史明令禁止，只能走 npm 侧）：评估并落地 npm cache 复用或独立缓存目录方案，给出「新 worktree 从零到可跑测试」的耗时前后对照。
4. **按基线收益落地头 1–2 项**：候选 = 并发度调参（含并发 2 / 4 / 全串行对照）、合并碎小测试文件（减少进程启动次数）、饱和套件的重复 setup 提取；哪几项落地由对照表说话。
5. 前后对照表 + 每项改动的收益解释落盘（`docs/tools/test-all.md` 卡 + 本条目验收物）。

**不做什么**

- 不删测试、不跳用例、不 `skip/only`、不放宽断言、不把宿主边界测试降级成纯函数测试（除非该测试本就与边界无关且等价重构可说明）。
- **不重复覆盖**：`agent-manager-todo#3`（单个性能看门用例负载敏感）与 `todo-cli-todo#13`（`test:todo` 偶发失败）保持各自条目主责，本条只负责「清单里标 serial」这一层。
- 不动 worktree 内 node_modules 的 junction/符号链接复用（历史事故两次，`docs/incidents.md`）。
- 不改测试框架（仍 `node:test` + `node:assert/strict`）、不引第三方依赖、不加构建步骤。
- 不优化 typecheck 速度（只记录耗时，不作为目标）。

## 验收标准

1. `npm run test:all` 可用：单条命令跑完全部套件、逐套件计时输出、失败聚合退出码非 0、`--jobs N` 生效。
2. 同机同命令的前后对照表（至少：全串行 vs 并发 2 vs 落地后默认），含每项改动的收益解释；覆盖只增不减（测试用例总数前后一致或增加，附计数）。
3. 依赖安装方案给出可复算数字：「新 worktree 到可跑测试」耗时对照。
4. 各插件全量测试与 `npm run typecheck` 全绿、根三套自检（contract/smoke/todo）全绿。
5. 文档同步：新增 `docs/tools/test-all.md`（含 INDEX 登记）+ 根 README（命令与测试数）+ `docs/extensions/*` 中涉及测试命令的卡片（如有）。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-14
- 方式：本轮 5 问「按建议走」——Q1 交付节奏（基线表 + 候选清单 + 落地头两项）、Q2 首要场景（并行 worktree 优先，兼顾单次全量）、Q3 手段白名单（并发调参 / 合并文件 / npm 侧安装加速；断言红线不动）、Q4 建 `tools/test-all.mjs` 统一入口、Q5 负载敏感套件统一「标 serial + 不放宽断言」。
