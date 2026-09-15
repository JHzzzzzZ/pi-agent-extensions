# 规格：全量测试提速（仓库级）

> 来源：`todos/general-todo.json` #11（用户 2026-09-11 提出）
> 对齐：`todos/align/general-todo#11.md`（2026-09-14 用户 5 问全部「按建议走」）
> 状态：已实现（`tools/test-all.mjs` @ 3be25cc；对照表见 `docs/tools/test-all.md`）

## 问题陈述

测试规模约 1900 用例、17 个套件，此前按目录**手工串行**跑：单次收尾核对固定成本 ≈32s；多 worktree 并行开发时每个 worktree 各跑一遍。两个被第一轮实测证实的真问题：

1. 没有单一入口——命令散在各插件 README / `package.json`，套件清单只在人脑里，漏跑不可见；
2. `pwr` / `loop` 目录缺 `node_modules` 时整份测试文件 `ERR_MODULE_NOT_FOUND`（假绿/假红都出现过），而「新 worktree 从零到可跑」要先在 6 个目录各 `npm install`（串行 ≈52s）。

## 方案

1. `tools/test-all.mjs`（零依赖、纯 node）：内置 17 套件清单 `DEFAULT_SUITES`（cwd + `node --test` 命令 + `serial` / `install` 标记），逐套件墙钟计时、失败即收集不中断、退出码聚合（0/1/2），输出含 node 版本与 CPU 数（跨机可复算）；`npm run test:all` 接上。
2. 负载敏感套件标 `serial`（独占运行、绝不放宽断言）：`pwr`（含 300ms 性能门）、`agent-manager`（core 性能门）、`root:todo`（真子进程并发/中断用例）。
3. `--install`：对标记 `install` 的 6 个目录并行 `npm install --prefer-offline`；依赖安装加速只走 npm 侧（junction 复用 node_modules 被事故史明令禁止）。
4. 并发度参数 `--jobs N`（默认 2）——收益由对照表说话，不预设结论。

## 用户故事

- 作为收尾核对的人，我跑 `npm run test:all` 一条命令拿到全部 17 套件结果与逐条耗时，失败时看到聚合退出码与失败套件输出尾部 40 行。
- 作为新 worktree 里的 agent，我跑 `node tools/test-all.mjs --install` 一次完成依赖预装并直接跑测试，不再逐个目录 `cd && npm install`。
- 作为后续维护者，`test/test-all.test.ts` 锁死「`pi.extensions` 全部扩展 + 根三套自检都有登记」「serial 恰好三条」，新增扩展漏登记即红。

## 实现决策

- 套件命令逐条镜像各插件 README / `package.json`：`node --test` 直启（不走 npm script——Windows 上 `npm.cmd` 必须过 shell 且多一层进程开销），保证命令面单一可审计。
- serial 语义实现为「启动前等其它套件排空 + 运行中不启动新套件」，保序调度；用真实子进程标记文件在 `test/test-all.test.ts` 锁死顺序。
- 并发收益有限（29.0s vs 串行 32.4s，`--jobs 4` 仅再省 0.4s）：`agent-team` 单套件 14–15s 是长尾，三条 serial 又必须独占 ≈10s。默认 `--jobs 2` 保留（对齐文档定值），更高并发留给按机器自选。
- 依赖安装：复用 npm **用户级**缓存 + `--prefer-offline`（实测独立缓存目录无收益：温 9.7s vs 默认 9.8s，冷还 +2.5s）；`--install` 并行（jobs 2）把安装阶段从 ≈52s 降到 ≈34s。
- 不做 typecheck 编排、不做增量/缓存、不引入任何第三方依赖。

## 测试决策

- `test/test-all.test.ts`（19 个）：纯函数（参数解析 / 过滤 / 计数解析 / 时长格式 / 汇总 / 注册表校验）+ 进程边界 E2E（临时 fixture 注册表拉起真实 CLI：退出码聚合、失败不中断、serial 独占的标记文件顺序、`--jobs 2` 真并发区间重叠、`--list`/`--only`/`--install`/错误退出码 2）。
- 覆盖只增不减：用例数前后一致（1902），无删测试 / 无 `skip`/`only` / 无放宽断言。
- 必跑：`npm run test:all`（内含本文件自身）+ 6 个有 `package.json` 的目录 `npm run typecheck` + 根三套自检。

## 范围外

- typecheck 速度（只记录，不优化）；jest/vitest 等框架替换；构建步骤；分片/增量缓存。
- `agent-manager-todo#3`（单个性能看门用例）与 `todo-cli-todo#13`（`test:todo` 偶发失败）各自条目主责，本条只标 serial。
- `agent-team-todo#69`（`failure-delivery` 第 3 例依赖「tmpdir 不在 git 仓库内」的本机既有失败）：本工具照实报 fail，不掩盖、不代修。
- worktree 内 node_modules 的 junction/符号链接复用（历史事故，永久禁止）。
